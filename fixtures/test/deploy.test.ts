// The reference host end to end: publish, ship a variant, real browser
// visits through the edge function, beacon counts, the kill switch, promote.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { hashPatch, loadConfig } from '@lab/core';
import type { LabConfig } from '@lab/core';
import { MetricStore, ReferenceDeployer, StoreMeter, assignBucket, readState, startEdgeServer } from '@lab/deploy';

const fixtures = join(import.meta.dirname, '..');
const site = join(fixtures, 'site');
const NAV_DOCS = readFileSync(join(fixtures, 'good', 'nav-docs', 'patch.diff'), 'utf8');

describe('reference host', () => {
	let browser: Browser;
	let config: LabConfig;
	let root: string;
	let deployer: ReferenceDeployer;
	let store: MetricStore;
	let edge: Awaited<ReturnType<typeof startEdgeServer>>;

	before(async () => {
		config = (await loadConfig(site)).config!;
		root = mkdtempSync(join(tmpdir(), 'lab-host-'));
		deployer = new ReferenceDeployer({ root, config });
		store = new MetricStore({ intervalHours: config.traffic.intervalHours, file: join(root, 'metrics.json') });
		browser = await chromium.launch();
		await deployer.publish({ dir: site, commit: 'fixture' });
		edge = await startEdgeServer({ root, store, config });
	});
	after(async () => {
		await edge?.close();
		await browser?.close();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	async function visit(cookie?: string) {
		const context = await browser.newContext();
		if (cookie) await context.addCookies([{ name: 'lab_vid', value: cookie, url: edge.url }]);
		const page = await context.newPage();
		await page.goto(edge.url + 'index.html');
		const hasDocsNav = (await page.locator('nav[aria-label="Main"] a[href="docs.html"]').count()) > 0;
		const vid = (await context.cookies()).find((c) => c.name === 'lab_vid')?.value;
		return { context, page, hasDocsNav, vid };
	}

	it('serves the published baseline and sets a random first-party id', async () => {
		const { context, hasDocsNav, vid } = await visit();
		assert.equal(hasDocsNav, false);
		assert.match(vid ?? '', /^[0-9a-f]{32}$/);
		await context.close();
	});

	it('serves the variant to its bucket, stickily, and counts visits and conversions', async () => {
		await deployer.ship({ experiment: 'exp-0042', base: { dir: site, commit: 'fixture' }, patch: NAV_DOCS, patchHash: hashPatch(NAV_DOCS) }, 0.5);
		assert.deepEqual(readState(root).live, { experiment: 'exp-0042', share: 0.5 });
		// Find one visitor id per bucket.
		const ids: Record<string, string> = {};
		for (let i = 0; !(ids.variant && ids.baseline); i++) {
			const id = i.toString(16).padStart(32, '0');
			ids[assignBucket(id, 'exp-0042', 0.5)] ??= id;
		}
		for (const [bucket, id] of Object.entries(ids)) {
			for (let n = 0; n < 2; n++) {
				const { context, page, hasDocsNav } = await visit(id);
				assert.equal(hasDocsNav, bucket === 'variant', `${bucket} visit ${n}`);
				await page.getByRole('link', { name: 'Get started' }).click();
				await page.waitForURL(/docs\.html$/);
				await context.close();
			}
		}
		await new Promise((r) => setTimeout(r, 300));
		const stats = await new StoreMeter({ store, config }).read('exp-0042');
		// Two home visits and two docs visits per bucket; one conversion per home visit.
		assert.equal(stats.variant.visits, 4);
		assert.equal(stats.baseline.visits, 4);
		assert.equal(stats.variant.conversions, 2);
		assert.equal(stats.baseline.conversions, 2);
	});

	it('does not expose variant builds or host files directly', async () => {
		for (const path of ['variants/exp-0042/index.html', '_lab/variants/exp-0042/index.html', 'state.json', '../state.json', '%2e%2e/state.json']) {
			const res = await fetch(edge.url + path);
			assert.ok(res.status === 404 || res.status === 403, `${path} answered ${res.status}`);
		}
		assert.equal((await fetch(edge.url + '_lab/beacon', { method: 'POST', body: '{"e":"exp-0042","b":"variant","k":"purchase"}' })).status, 400);
	});

	it('the kill switch sends every visitor to the baseline at once, without a deploy', async () => {
		await deployer.kill();
		for (let i = 0; i < 6; i++) {
			const { context, hasDocsNav } = await visit();
			assert.equal(hasDocsNav, false);
			await context.close();
		}
		assert.equal(readState(root).live, null);
		assert.ok(readState(root).killedAt);
	});

	it('promotes a variant to everyone', async () => {
		await deployer.ship({ experiment: 'exp-0043', base: { dir: site, commit: 'fixture' }, patch: NAV_DOCS, patchHash: hashPatch(NAV_DOCS) }, 0.1);
		await deployer.promote('exp-0043');
		for (let i = 0; i < 4; i++) {
			const { context, hasDocsNav } = await visit();
			assert.equal(hasDocsNav, true);
			await context.close();
		}
	});
});
