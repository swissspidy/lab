// Personal tweaks on the fixture site, with the real verifier: a tweak that
// only restyles passes; one that hides the signup form, or makes text
// unreadable, is rejected by the site's own invariants and budgets.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { loadConfig, verifyTweak } from '@lab/core';
import type { LabConfig, Tweak, TweakOutcome } from '@lab/core';
import { GraftSpecCheck, assayInvariant } from '@lab/adapters';
import { CssInjectingProxy, LocalSandbox } from '@lab/sandbox';
import { BrowserVerifier } from '@lab/verify';

const site = join(import.meta.dirname, '..', 'site');

const tweak = (id: string, css: string, mount = 'site'): Tweak => ({
	spec: {
		id,
		intent: 'Make the main heading larger.',
		acceptance: ['The main heading is still visible at 1280x800.'],
		mount,
		permissions: ['style:write'],
		checks: [{ criterion: 0, page: 'index.html', viewport: { width: 1280, height: 800 }, expect: [{ expect: 'visible', target: { role: 'heading', name: 'Find broken links before your visitors do' } }] }],
	},
	css,
});

describe('personal tweaks on the fixture site', { concurrency: 3 }, () => {
	let browser: Browser;
	let config: LabConfig;
	let scratch: string;

	before(async () => {
		config = (await loadConfig(site)).config!;
		assert.ok(config.tweaks, 'the fixture site offers tweaks');
		browser = await chromium.launch();
		scratch = mkdtempSync(join(tmpdir(), 'lab-tweaks-'));
	});
	after(async () => {
		await browser?.close();
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	const verify = (t: Tweak): Promise<TweakOutcome> =>
		verifyTweak(
			{
				config,
				site: { dir: site, commit: 'fixture' },
				sandbox: new LocalSandbox({ config, scratch }),
				injector: new CssInjectingProxy(),
				verifier: new BrowserVerifier({ config, siteDir: site, browser, invariantKinds: [assayInvariant] }),
				evidenceDir: join(scratch, 'evidence'),
				specCheck: new GraftSpecCheck(),
			},
			t,
		);
	const failed = (outcome: TweakOutcome) => (outcome.outcome === 'rejected' ? [...outcome.diagnostics.map((d) => d.code), ...outcome.failures.map((f) => f.check)] : [outcome.outcome === 'aborted' ? outcome.reason : 'verified']);

	it('verifies a tweak that only restyles', async () => {
		const outcome = await verify(tweak('tw-000000000001', '.hero h1 { font-size: 3.2rem; letter-spacing: -0.02em; }'));
		assert.equal(outcome.outcome, 'verified', failed(outcome).join('\n'));
		if (outcome.outcome === 'verified') assert.ok(outcome.record.checks.includes('acceptance.0'));
	});

	it('rejects a tweak that hides the signup form: the site’s invariant fails with it', async () => {
		const outcome = await verify(tweak('tw-000000000002', '.signup { display: none; }'));
		assert.equal(outcome.outcome, 'rejected');
		assert.ok(failed(outcome).includes('invariants.signup-submits'), failed(outcome).join(', '));
	});

	it('rejects a tweak that makes text unreadable: the aXe budget fails with it', async () => {
		const outcome = await verify(tweak('tw-000000000003', 'body, body * { color: #eeeeee !important; }'));
		assert.equal(outcome.outcome, 'rejected');
		assert.ok(failed(outcome).some((c) => c.startsWith('budgets.axe')), failed(outcome).join(', '));
	});

	it('rejects a tweak mounted on a page the site does not have, through Graft', async () => {
		const outcome = await verify(tweak('tw-000000000004', '.hero h1 { font-size: 3rem; }', 'page.blog'));
		assert.deepEqual(failed(outcome), ['graft-mount-unknown-slot']);
	});
});
