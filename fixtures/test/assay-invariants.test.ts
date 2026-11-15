// Assay invariants on the fixture site: the committed check set is what
// `lab invariants compile` produces from the baseline, it passes there, and
// it fails a site whose confirmation no longer says what the task says.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { loadConfig, siteCommit } from '@lab/core';
import type { LabConfig, RunningSite } from '@lab/core';
import { assayInvariant, checkInvariantLock, compileInvariant, isAssayInvariant } from '@lab/adapters';
import type { AssayInvariant } from '@lab/adapters';
import { LocalSandbox, serveDir } from '@lab/sandbox';
import { loadInvariants } from '@lab/verify';

const site = join(import.meta.dirname, '..', 'site');

describe('Assay invariants', () => {
	let browser: Browser;
	let config: LabConfig;
	let baseline: RunningSite;
	let invariant: AssayInvariant;
	let scratch: string;

	before(async () => {
		const loaded = await loadConfig(site);
		assert.ok(loaded.config, JSON.stringify(loaded.diagnostics));
		config = loaded.config;
		browser = await chromium.launch();
		baseline = await new LocalSandbox({ config }).start({ dir: site, commit: siteCommit(site) });
		const found = (await loadInvariants(join(site, config.invariants), [assayInvariant])).filter(isAssayInvariant);
		assert.deepEqual(found.map((i) => i.id), ['signup-submits']);
		invariant = found[0]!;
		scratch = mkdtempSync(join(tmpdir(), 'lab-assay-'));
	});
	after(async () => {
		await baseline?.stop();
		await browser?.close();
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	const run = async (url: string) => {
		const context = await browser.newContext({ viewport: config.viewports[0]! });
		context.setDefaultTimeout(5000);
		try {
			const page = await context.newPage();
			await invariant.run({ page, url, viewport: config.viewports[0]!, ok: (c, m) => assert.ok(c, m) });
		} finally {
			await context.close();
		}
	};

	it('the committed check set is locked, and is what compiling the baseline gives', async () => {
		assert.equal(checkInvariantLock(invariant), null);
		const compiled = await compileInvariant(invariant, { browser, url: baseline.url, viewport: config.viewports[0]!, by: 'test' });
		const committed = JSON.parse(readFileSync(invariant.assay.checksFile, 'utf8'));
		assert.deepEqual(compiled.checkSet.checks, committed.checks);
		assert.deepEqual(compiled.checkSet.requirements, committed.requirements);
		assert.equal(compiled.stress.rates.variantsAccepted, compiled.stress.rates.variantsTotal);
	});

	it('passes on the baseline', async () => {
		await run(baseline.url);
	});

	it('fails a site that confirms the wrong address', async () => {
		const copy = join(scratch, 'wrong-address');
		assert.ok(baseline.root, 'a static site has an output directory');
		cpSync(baseline.root, copy, { recursive: true });
		const scripts = (readdirSync(copy, { recursive: true, encoding: 'utf8' }) as string[]).filter((f) => f.endsWith('.js'));
		let changed = false;
		for (const f of scripts) {
			const text = readFileSync(join(copy, f), 'utf8');
			if (text.includes('${email.value}')) {
				writeFileSync(join(copy, f), text.replace('${email.value}', 'you'));
				changed = true;
			}
		}
		assert.ok(changed, 'the fixture script should build the confirmation from the address');
		const server = await serveDir(copy);
		try {
			await assert.rejects(run(server.url), /Assay|verdict|expected|R1/i);
		} finally {
			await server.close();
		}
	});

	it('refuses to compile outcomes no run shows', async () => {
		const wrong: AssayInvariant = { ...invariant, assay: { ...invariant.assay, task: { ...invariant.assay.task, outcomes: '- The page shows "Welcome aboard, reader@example.com."' } } };
		await assert.rejects(compileInvariant(wrong, { browser, url: baseline.url, viewport: config.viewports[0]!, by: 'test' }), { code: 'invariant-compile-failed' });
	});
});
