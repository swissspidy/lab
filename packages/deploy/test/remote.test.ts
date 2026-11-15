import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StageError, hashPatch, validateConfig } from '@lab/core';
import type { LabConfig } from '@lab/core';
import { CommandPublisher, FileTweakStore, MetricStore, OriginDeployer, RemoteMeter, RemoteState, RemoteTweakStore, readState, startCollector } from '../src/index.ts';

const configWith = (deploy?: object): LabConfig =>
	validateConfig({
		site: { repo: '.', build: "mkdir -p out && echo built > out/index.html", outDir: 'out' },
		metric: { id: 'm', kind: 'conversion' },
		allow: ['src/**'],
		deny: [],
		budgets: { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 },
		traffic: { share: 0.1, minSamplesPerBucket: 1000, maxDays: 14, intervalHours: 6 },
		...(deploy ? { deploy } : {}),
	}).config!;

const BUDGETS = { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 };

describe('remote collector', () => {
	let dir: string;
	let collector: Awaited<ReturnType<typeof startCollector>>;
	let store: MetricStore;
	before(async () => {
		dir = mkdtempSync(join(tmpdir(), 'lab-collector-'));
		store = new MetricStore({ intervalHours: 6 });
		collector = await startCollector({ root: dir, store, token: 'secret-token' });
	});
	after(async () => {
		await collector.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it('takes state writes only with the token, and only well-formed state', async () => {
		const put = (body: unknown, token?: string) =>
			fetch(`${collector.url}/state`, { method: 'PUT', body: JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });
		assert.equal((await put({ live: null })).status, 401);
		assert.equal((await put({ live: null }, 'wrong')).status, 401);
		assert.equal((await put({ live: { experiment: 'exp-0001', share: 0.9 } }, 'secret-token')).status, 400, 'a share above 0.5 is refused');
		assert.equal((await put({ live: { experiment: 'exp-0001', share: 0.1, origin: 'file:///etc' } }, 'secret-token')).status, 400);
		assert.equal((await put({ live: { experiment: 'exp-0001', share: 0.1, origin: 'https://v.example' } }, 'secret-token')).status, 204);
		assert.deepEqual(await (await fetch(`${collector.url}/state`)).json(), { live: { experiment: 'exp-0001', share: 0.1, origin: 'https://v.example' } });
		// A conditional write against a stale version is refused.
		const stale = await fetch(`${collector.url}/state`, { method: 'PUT', body: JSON.stringify({ live: null }), headers: { authorization: 'Bearer secret-token', 'if-match': '"0000"' } });
		assert.equal(stale.status, 412);
		const etag = (await fetch(`${collector.url}/state`)).headers.get('etag')!;
		const fresh = await fetch(`${collector.url}/state`, { method: 'PUT', body: JSON.stringify({ live: { experiment: 'exp-0001', share: 0.1, origin: 'https://v.example' } }), headers: { authorization: 'Bearer secret-token', 'if-match': etag } });
		assert.equal(fresh.status, 204);
	});

	it('keeps metrics behind the token, and a remote meter reads them', async () => {
		assert.equal((await fetch(`${collector.url}/metrics`)).status, 401);
		for (const k of ['visit', 'visit', 'conversion']) {
			await fetch(`${collector.url}/beacon`, { method: 'POST', body: JSON.stringify({ e: 'exp-0001', b: 'variant', k }) });
		}
		const meter = new RemoteMeter({ url: collector.url, token: 'secret-token', config: configWith() });
		const stats = await meter.read('exp-0001');
		assert.equal(stats.variant.visits, 2);
		assert.equal(stats.variant.conversions, 1);
		await assert.rejects(new RemoteMeter({ url: collector.url, token: 'nope', config: configWith() }).read('exp-0001'), (e: unknown) => e instanceof StageError && e.code === 'remote-metrics-unreadable');
	});

	it('lets an origin deployer and its kill switch work through the collector', async () => {
		const state = new RemoteState({ url: collector.url, token: 'secret-token' });
		const retired: string[] = [];
		const deployer = new OriginDeployer({ state, publisher: { publish: async () => 'https://exp-0002.preview.example', retire: async (id) => void retired.push(id) } });
		await state.write({ live: null });
		await deployer.ship({ experiment: 'exp-0002', base: { dir, commit: 'c' }, patch: '', patchHash: hashPatch('') }, 0.2);
		assert.deepEqual(readState(dir).live, { experiment: 'exp-0002', share: 0.2, origin: 'https://exp-0002.preview.example' });
		await deployer.kill();
		assert.equal(readState(dir).live, null);
		assert.ok(readState(dir).killedAt);
		assert.deepEqual(retired, ['exp-0002']);
	});
});

const NEW_FILE = 'diff --git a/src/a.txt b/src/a.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/a.txt\n@@ -0,0 +1 @@\n+variant\n';
const variant = (experiment: string, dir: string) => ({ experiment, base: { dir, commit: 'c' }, patch: NEW_FILE, patchHash: hashPatch(NEW_FILE) });

describe('OriginDeployer races and failures', () => {
	it('a kill while a variant is publishing wins, and the variant is taken down', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-race-'));
		try {
			const retired: string[] = [];
			let release!: () => void;
			const gate = new Promise<void>((r) => (release = r));
			const deployer = new OriginDeployer({
				root: dir,
				publisher: {
					publish: async () => {
						await gate;
						return 'https://exp-0005.preview.example';
					},
					retire: async (id) => void retired.push(id),
				},
			});
			const shipping = deployer.ship({ experiment: 'exp-0005', base: { dir, commit: 'c' }, patch: '', patchHash: hashPatch('') }, 0.1);
			await new Promise((r) => setTimeout(r, 10));
			await deployer.kill();
			release();
			await assert.rejects(shipping, (e: unknown) => e instanceof StageError && e.code === 'deploy-state-changed');
			assert.equal(readState(dir).live, null);
			assert.ok(readState(dir).killedAt, 'the kill is not erased');
			assert.deepEqual(retired, ['exp-0005']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('takes the variant down when the state cannot be written', async () => {
		const retired: string[] = [];
		const deployer = new OriginDeployer({
			state: { read: async () => ({ state: { live: null }, version: 'v1' }), write: async () => Promise.reject(new StageError('remote-state-unwritable', 'no')) },
			publisher: { publish: async () => 'https://v.example', retire: async (id) => void retired.push(id) },
		});
		await assert.rejects(deployer.ship({ experiment: 'exp-0006', base: { dir: '.', commit: 'c' }, patch: '', patchHash: hashPatch('') }, 0.1), (e: unknown) => e instanceof StageError && e.code === 'remote-state-unwritable');
		assert.deepEqual(retired, ['exp-0006']);
	});

	it('refuses malformed state from the collector instead of treating it as idle', async () => {
		for (const body of ['[]', '{}', '{"live":{"experiment":"exp-0001","share":0.9}}', 'not json']) {
			const state = new RemoteState({ url: 'http://lab.test', token: 't', fetch: (async () => new Response(body)) as typeof fetch });
			await assert.rejects(state.read(), (e: unknown) => e instanceof StageError && e.code === 'remote-state-malformed', body);
		}
	});

	it('refuses malformed metrics, including empty or falsy data', () => {
		for (const data of [null, 0, '', false, { intervalMs: 3_600_000, series: { 'exp-0001': { '1': {} } } }]) {
			assert.throws(() => new MetricStore({ intervalHours: 1, data }), /malformed/, JSON.stringify(data));
		}
	});
});

describe('CommandPublisher', () => {
	it('publishes from a built copy, passes only the allowed variables, and reads the URL from the last line', async () => {
		const site = mkdtempSync(join(tmpdir(), 'lab-cmd-site-'));
		const log = join(site, '..', `lab-cmd-log-${Date.now()}`);
		try {
			const config = configWith({
				publish: `cat out/index.html src/a.txt; echo "token=$DEPLOY_TOKEN other=$OTHER_SECRET exp=$LAB_EXPERIMENT" > ${log}; echo uploading; echo https://exp-0003-abc.preview.example/`,
				retire: `echo "retired $LAB_EXPERIMENT" >> ${log}`,
				env: ['DEPLOY_TOKEN'],
			});
			const publisher = new CommandPublisher({ config, env: { DEPLOY_TOKEN: 't0k', OTHER_SECRET: 'nope' } });
			const origin = await publisher.publish(variant('exp-0003', site));
			assert.equal(origin, 'https://exp-0003-abc.preview.example');
			assert.equal(readFileSync(log, 'utf8').trim(), 'token=t0k other= exp=exp-0003');
			await publisher.retire('exp-0003');
			assert.match(readFileSync(log, 'utf8'), /retired exp-0003/);

			const silent = new CommandPublisher({ config: configWith({ publish: 'echo done' }) });
			await assert.rejects(silent.publish(variant('exp-0004', site)), (e: unknown) => e instanceof StageError && e.code === 'deploy-publish-no-url');
		} finally {
			rmSync(site, { recursive: true, force: true });
			rmSync(log, { force: true });
		}
	});

	it('reports a failing retire command', async () => {
		const publisher = new CommandPublisher({ config: configWith({ publish: 'echo https://x.example', retire: 'echo gone wrong >&2; exit 4' }) });
		await assert.rejects(publisher.retire('exp-0007'), (e: unknown) => e instanceof StageError && e.code === 'deploy-retire-failed' && (e.detail ?? '').includes('gone wrong'));
	});

	it('is refused without deploy.publish', () => {
		assert.throws(() => new CommandPublisher({ config: configWith() }), (e: unknown) => e instanceof StageError && e.code === 'deploy-no-command');
	});
});

describe('readState', () => {
	it('serves no variant from a malformed state.json, as the edge and the proxy do', () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-state-'));
		try {
			const write = (value: unknown) => writeFileSync(join(dir, 'state.json'), typeof value === 'string' ? value : JSON.stringify(value));
			write({ live: { experiment: 'exp-0001', share: 0.2 } });
			assert.deepEqual(readState(dir).live, { experiment: 'exp-0001', share: 0.2 });
			for (const bad of ['{not json', { live: { experiment: 'exp-0001', share: 0.9 } }, { live: { experiment: 'exp-0001', share: 0.2, origin: 'javascript:alert(1)' } }, { live: { experiment: 'exp-0001', share: 0.2, origin: ['https://preview.example'] } }, { nothing: true }]) {
				write(bad);
				assert.equal(readState(dir).live, null, JSON.stringify(bad));
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('personal tweaks in the collector', () => {
	const record = (over: Record<string, unknown> = {}, css = 'h1 { font-size: 3rem }') => ({
		spec: { id: 'tw-0123456789ab', intent: 'Bigger headings.', acceptance: ['The heading shows.'], mount: 'site', permissions: ['style:write'], checks: [{ criterion: 0, page: 'index.html', expect: [{ expect: 'visible', target: { css: 'h1' } }] }], ...over },
		css,
		verifiedAt: '2026-11-15T10:00:00.000Z',
		siteCommit: 'c0ffee',
		checks: ['acceptance.0'],
	});

	it('stores a verified tweak with the token, serves its CSS to anyone, and the record only with the token', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-tweaks-'));
		const collector = await startCollector({ root: dir, store: new MetricStore({ intervalHours: 6 }), token: 'secret-token', tweaks: {}, budgets: BUDGETS });
		try {
			const put = (body: unknown, token = 'secret-token', id = 'tw-0123456789ab') =>
				fetch(`${collector.url}/tweaks/${id}`, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
			assert.equal((await put(record(), 'wrong')).status, 401);
			assert.equal((await put(record({ permissions: ['markup:write'] }))).status, 400, 'not style-only');
			assert.equal((await put(record({}, 'a { background: url(https://t.example/x.png) }'))).status, 400, 'CSS that makes a request');
			assert.equal((await put(record(), 'secret-token', 'tw-ffffffffffff')).status, 400, 'the path names another tweak');
			assert.equal((await fetch(`${collector.url}/tweaks/tw-0123456789ab.css`)).status, 404);
			const huge = await fetch(`${collector.url}/tweaks/tw-0123456789ab`, { method: 'PUT', headers: { authorization: 'Bearer secret-token' }, body: '€'.repeat(80_000) });
			assert.equal(huge.status, 413, 'the limit counts bytes, and answers once');
			assert.equal((await put(record())).status, 204);
			const css = await fetch(`${collector.url}/tweaks/tw-0123456789ab.css`);
			assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
			assert.equal(css.headers.get('x-content-type-options'), 'nosniff');
			assert.equal(await css.text(), 'h1 { font-size: 3rem }');
			assert.equal((await fetch(`${collector.url}/tweaks/tw-0123456789ab.css`, { method: 'HEAD' })).status, 200, 'the proxy asks with HEAD before opting a visitor in');
			assert.equal((await fetch(`${collector.url}/tweaks/tw-ffffffffffff.css`, { method: 'HEAD' })).status, 404);
			assert.equal((await fetch(`${collector.url}/tweaks/tw-0123456789ab.json`)).status, 401);
			const store = new RemoteTweakStore({ url: collector.url, token: 'secret-token', config: { tweaks: {} } });
			assert.equal((await store.get('tw-0123456789ab'))?.siteCommit, 'c0ffee');
			assert.equal(await store.get('tw-000000000000'), null);
		} finally {
			await collector.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('needs the site’s budgets to store tweaks', async () => {
		await assert.rejects(startCollector({ root: tmpdir(), store: new MetricStore({ intervalHours: 6 }), tweaks: {} }), { code: 'collector-budgets-required' });
	});

	it('refuses to store a tweak over the site’s bundle budget', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-tweaks-'));
		const budgets = { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 1 };
		const collector = await startCollector({ root: dir, store: new MetricStore({ intervalHours: 6 }), token: 'secret-token', tweaks: { maxBytes: 65_536 }, budgets });
		try {
			const body = JSON.stringify(record({}, `h1 { color: red } /* ${'x'.repeat(2_000)} */`));
			const res = await fetch(`${collector.url}/tweaks/tw-0123456789ab`, { method: 'PUT', headers: { authorization: 'Bearer secret-token' }, body });
			assert.equal(res.status, 400, 'within maxBytes but over a 1 KB bundle budget');
		} finally {
			await collector.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('has no tweak routes when the site offers none', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-tweaks-'));
		const collector = await startCollector({ root: dir, store: new MetricStore({ intervalHours: 6 }), token: 'secret-token' });
		try {
			const store = new RemoteTweakStore({ url: collector.url, token: 'secret-token', config: { tweaks: {} } });
			await assert.rejects(store.put(record() as never), (e: unknown) => e instanceof StageError && e.code === 'tweaks-disabled');
		} finally {
			await collector.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('answers 500, not 400, when storing fails for its own reasons', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-tweaks-'));
		writeFileSync(join(dir, 'tweaks'), 'a file where the directory should be');
		const collector = await startCollector({ root: dir, store: new MetricStore({ intervalHours: 6 }), token: 'secret-token', tweaks: {}, budgets: BUDGETS });
		try {
			const res = await fetch(`${collector.url}/tweaks/tw-0123456789ab`, { method: 'PUT', headers: { authorization: 'Bearer secret-token' }, body: JSON.stringify(record()) });
			assert.equal(res.status, 500);
		} finally {
			await collector.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a file store refuses a record that does not pass the gate, whoever writes it', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-tweaks-'));
		try {
			const store = new FileTweakStore(dir, { tweaks: {} });
			await assert.rejects(store.put(record({}, 'a::after { content: "FREE" }') as never), (e: unknown) => e instanceof StageError && e.code === 'tweak-record-invalid');
			await store.put(record() as never);
			assert.equal((await store.get('tw-0123456789ab'))?.css, 'h1 { font-size: 3rem }');
			assert.equal(await store.get('../state'), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
