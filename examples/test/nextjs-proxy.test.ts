// A Next.js server app with @lab/next in proxy.ts, end to end: the lab
// verifies in server mode, the operator approves, the origin deployer starts
// the variant on its own server, and the site's production server routes
// visitors through its proxy. Real Chromium visitors, real beacons, the kill
// switch.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { BetaBinomialDecider, FileLedger, approve, buildInScratch, loadConfig, runIteration, ship, startService, verifyTweak } from '@lab/core';
import type { LabConfig, ScratchBuild, Service } from '@lab/core';
import { GraftSpecCheck } from '@lab/adapters';
import { ReplayBuilder, ReplayProposer } from '@lab/agent';
import { FileTweakStore, LocalServePublisher, MetricStore, OriginDeployer, StoreMeter, readState, startCollector } from '@lab/deploy';
import { assignBucket } from '@lab/next';
import { CssInjectingProxy, LocalSandbox } from '@lab/sandbox';
import { BrowserVerifier } from '@lab/verify';

const example = join(import.meta.dirname, '..', 'nextjs-proxy');
const nextPackage = join(import.meta.dirname, '..', '..', 'packages', 'next');

describe('Next.js proxy (server mode), end to end', { timeout: 900_000 }, () => {
	let repo: string;
	let host: string;
	let config: LabConfig;
	let browser: Browser;
	let collector: Awaited<ReturnType<typeof startCollector>>;
	let store: MetricStore;
	let baselineBuild: ScratchBuild;
	let baseline: Service;
	let publisher: LocalServePublisher;
	let deployer: OriginDeployer;
	let ledger: FileLedger;

	before(async () => {
		assert.ok(existsSync(join(example, 'node_modules', 'next')), 'Run `npm install --prefix examples/nextjs-proxy` first.');
		repo = mkdtempSync(join(tmpdir(), 'lab-proxy-site-'));
		host = mkdtempSync(join(tmpdir(), 'lab-proxy-host-'));
		cpSync(example, repo, { recursive: true, verbatimSymlinks: true, filter: (src) => !/\/(node_modules|\.next|\.lab)(\/|$)/.test(src.slice(example.length)) });
		execFileSync('cp', ['-a', join(example, 'node_modules'), join(repo, 'node_modules')]);
		// Always test the current @lab/next, not whatever was installed earlier.
		rmSync(join(repo, 'node_modules', '@lab', 'next'), { recursive: true, force: true });
		cpSync(nextPackage, join(repo, 'node_modules', '@lab', 'next'), { recursive: true, filter: (src) => !src.includes('/test') });
		execFileSync('git', ['init', '-q'], { cwd: repo });
		execFileSync('git', ['add', '-A'], { cwd: repo });
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--no-gpg-sign', '-m', 'site'], { cwd: repo });

		config = (await loadConfig(repo)).config!;
		browser = await chromium.launch();
		store = new MetricStore({ intervalHours: config.traffic.intervalHours, file: join(host, 'metrics.json') });
		collector = await startCollector({ root: host, store, ...(config.tweaks ? { tweaks: config.tweaks, budgets: config.budgets } : {}) });
		// The site's production deployment: its own server, its proxy pointed at the lab.
		baselineBuild = await buildInScratch({ dir: repo, commit: 'site' }, config);
		baseline = await startService(config.site.serve!, { cwd: baselineBuild.work, timeoutMs: 120_000, env: { LAB_URL: collector.url, LAB_CACHE_MS: '200' } });
		publisher = new LocalServePublisher({ config });
		deployer = new OriginDeployer({ root: host, publisher });
		ledger = new FileLedger(join(repo, 'lab', 'ledger.jsonl'));
	});

	after(async () => {
		await publisher?.retireAll();
		await baseline?.stop();
		baselineBuild?.cleanup();
		await collector?.close();
		await browser?.close();
		for (const dir of [repo, host]) if (dir) rmSync(dir, { recursive: true, force: true });
	});

	const visitorIn = (experiment: string, share: number, bucket: 'baseline' | 'variant') => {
		for (let i = 0; ; i++) {
			const id = i.toString(16).padStart(32, '0');
			if (assignBucket(id, experiment, share) === bucket) return id;
		}
	};

	async function visit(vid: string) {
		const context = await browser.newContext();
		await context.addCookies([{ name: 'lab_vid', value: vid, url: baseline.url }]);
		const page = await context.newPage();
		const failed: string[] = [];
		page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));
		page.on('pageerror', (e) => failed.push(e.message));
		await page.goto(baseline.url);
		const docsInNav = (await page.locator('nav[aria-label="Main"] a[href="/docs"]').count()) > 0;
		return { context, page, docsInNav, failed };
	}

	it('verifies in server mode, ships after approval, and serves each bucket its own build through the proxy', async () => {
		const dir = join(example, 'experiments', 'nav-docs');
		const site = { dir: repo, commit: 'site' };
		const iteration = await runIteration({
			config,
			site,
			ledger,
			proposer: new ReplayProposer(dir),
			builder: new ReplayBuilder(dir),
			sandbox: new LocalSandbox({ config }),
			verifier: new BrowserVerifier({ config, siteDir: repo, browser }),
			specCheck: new GraftSpecCheck(),
			evidenceDir: join(host, 'evidence'),
		});
		assert.equal(iteration.outcome, 'verify_passed', iteration.failures.map((f) => `${f.check}: ${f.message}`).join('\n'));
		const id = iteration.experiment!;

		// A day of site traffic so the ship plan has an estimate.
		for (let h = 6; h <= 24; h += 6) {
			const at = new Date(Date.now() - h * 3_600_000);
			store.record('_site', 'baseline', 'visit', at, 5_000);
			store.record('_site', 'baseline', 'conversion', at, 500);
		}
		await approve({ ledger, site }, id, 'operator');
		const meter = new StoreMeter({ store, config });
		const shipped = await ship({ config, site, ledger, deployer, meter, decider: new BetaBinomialDecider(config), promote: async () => {} }, id);
		assert.equal(shipped.outcome, 'shipped', shipped.reason);
		const live = readState(host).live!;
		assert.equal(live.experiment, id);
		assert.match(live.origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
		await new Promise((r) => setTimeout(r, 300));

		const inVariant = await visit(visitorIn(id, live.share, 'variant'));
		assert.equal(inVariant.docsInNav, true, 'the variant bucket gets the variant build');
		// The variant's JavaScript arrived through the proxy: the page is interactive.
		await inVariant.page.getByLabel('Search the docs').fill('ci');
		await inVariant.page.getByRole('button', { name: 'Search' }).click();
		await inVariant.page.getByRole('link', { name: 'Running in CI' }).waitFor({ timeout: 5000 });
		await inVariant.page.getByRole('link', { name: 'Get started' }).click();
		await inVariant.page.waitForURL(/\/docs$/);
		assert.deepEqual(inVariant.failed, []);
		await inVariant.context.close();

		const inBaseline = await visit(visitorIn(id, live.share, 'baseline'));
		assert.equal(inBaseline.docsInNav, false, 'the baseline bucket gets the production build');
		await inBaseline.page.getByRole('link', { name: 'Get started' }).click();
		await inBaseline.page.waitForURL(/\/docs$/);
		assert.deepEqual(inBaseline.failed, []);
		await inBaseline.context.close();

		// The beacons went through the proxy to the collector, per bucket.
		await new Promise((r) => setTimeout(r, 1500));
		const stats = await meter.read(id);
		assert.ok(stats.variant.visits >= 1 && stats.baseline.visits >= 1, JSON.stringify(stats));
		assert.equal(stats.variant.conversions, 1);
		assert.equal(stats.baseline.conversions, 1);
	});

	it('verifies a personal tweak on the server app, and a visitor who opts in gets it and leaves the experiment', async () => {
		// A dark blue heading. (A 3.5rem heading was rejected here: the docs page scrolled sideways at 390px.)
		const css = 'h1 { color: rgb(11, 61, 145); }';
		const outcome = await verifyTweak(
			{
				config,
				site: { dir: repo, commit: 'site' },
				sandbox: new LocalSandbox({ config }),
				injector: new CssInjectingProxy(),
				verifier: new BrowserVerifier({ config, siteDir: repo, browser }),
				evidenceDir: join(host, 'evidence'),
				specCheck: new GraftSpecCheck(),
			},
			{
				spec: {
					id: 'tw-00000000000a',
					intent: 'A dark blue main heading.',
					acceptance: ['The main heading is visible.'],
					mount: 'site',
					permissions: ['style:write'],
					checks: [{ criterion: 0, page: '.', expect: [{ expect: 'visible', target: { role: 'heading', name: 'A preview environment for every pull request' } }] }],
				},
				css,
			},
		);
		assert.equal(outcome.outcome, 'verified', JSON.stringify(outcome.outcome === 'rejected' ? [outcome.diagnostics, outcome.failures] : outcome));
		if (outcome.outcome !== 'verified') return;
		await new FileTweakStore(host, config).put(outcome.record);

		const live = readState(host).live!;
		const visitor = await visit(visitorIn(live.experiment, live.share, 'variant'));
		assert.equal(visitor.docsInNav, true, 'before opting in, the variant bucket sees the variant');
		await visitor.page.goto(new URL('/_lab/tweak/tw-00000000000a', baseline.url).href);
		assert.equal(new URL(visitor.page.url()).pathname, '/');
		await visitor.page.waitForFunction(() => getComputedStyle(document.querySelector('h1')!).color === 'rgb(11, 61, 145)', null, { timeout: 5000 });
		const cookies = Object.fromEntries((await visitor.context.cookies()).map((c) => [c.name, c.value]));
		assert.equal(cookies.lab_tweaks, 'tw-00000000000a');
		const html = await (await visitor.context.request.get(new URL('/', baseline.url).href)).text();
		assert.match(html, /<link rel="stylesheet" href="\/_lab\/tweaks\/tw-00000000000a\.css" data-lab-tweak="tw-00000000000a"\/>/, 'the server renders the tweak in <head>, before the first paint');
		assert.equal(await visitor.page.locator('link[data-lab-tweak]').count(), 1, 'the beacon does not add it twice');
		assert.equal(cookies.lab_exp, '', 'a tweaked visitor is in no experiment');
		assert.equal((await visitor.page.locator('nav[aria-label="Main"] a[href="/docs"]').count()) > 0, false, 'and is served the baseline');
		await visitor.page.goto(new URL('/_lab/tweak/tw-00000000000a?off', baseline.url).href);
		assert.equal((await visitor.context.cookies()).find((c) => c.name === 'lab_tweaks'), undefined, 'opting out drops the cookie');
		assert.deepEqual(visitor.failed, []);
		await visitor.context.close();
	});

	it('the kill switch sends every visitor to the production build within the proxy cache time', async () => {
		const live = readState(host).live!;
		await deployer.kill();
		await new Promise((r) => setTimeout(r, 400));
		const visitor = await visit(visitorIn(live.experiment, live.share, 'variant'));
		assert.equal(visitor.docsInNav, false);
		await visitor.context.close();
		assert.equal(readState(host).live, null);
	});
});
