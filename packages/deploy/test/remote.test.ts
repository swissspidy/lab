import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StageError, hashPatch, validateConfig } from '@lab/core';
import type { LabConfig } from '@lab/core';
import { CommandPublisher, MetricStore, OriginDeployer, RemoteMeter, RemoteState, readState, startCollector } from '../src/index.ts';

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

	it('is refused without deploy.publish', () => {
		assert.throws(() => new CommandPublisher({ config: configWith() }), (e: unknown) => e instanceof StageError && e.code === 'deploy-no-command');
	});
});
