// M1's acceptance test: the dry loop takes every known-good patch to
// verify_passed, and every breakage to verify_failed with the right check named.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { FileLedger, checkLedger, loadConfig, runIteration } from '@lab/core';
import type { IterationResult, LabConfig } from '@lab/core';
import { ReplayBuilder, ReplayProposer } from '@lab/agent';
import { LocalSandbox } from '@lab/sandbox';
import { BrowserVerifier } from '@lab/verify';

const fixtures = join(import.meta.dirname, '..');
const site = join(fixtures, 'site');
const good = readdirSync(join(fixtures, 'good')).toSorted();
const breakages = readdirSync(join(fixtures, 'breakages')).toSorted();

describe('dry loop (M1)', { concurrency: 3 }, () => {
	let browser: Browser;
	let config: LabConfig;
	let scratch: string;

	before(async () => {
		const loaded = await loadConfig(site);
		assert.ok(loaded.config, JSON.stringify(loaded.diagnostics));
		config = loaded.config;
		browser = await chromium.launch();
		scratch = mkdtempSync(join(tmpdir(), 'lab-loop-'));
	});
	after(async () => {
		await browser?.close();
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	async function iterate(dir: string, name: string): Promise<{ result: IterationResult; ledger: FileLedger }> {
		const ledger = new FileLedger(join(scratch, `${name}.jsonl`));
		const result = await runIteration({
			config,
			site: { dir: site, commit: 'fixture' },
			ledger,
			proposer: new ReplayProposer(dir),
			builder: new ReplayBuilder(dir),
			sandbox: new LocalSandbox({ config, scratch }),
			verifier: new BrowserVerifier({ config, siteDir: site, browser }),
			evidenceDir: join(scratch, 'evidence'),
			dry: true,
		});
		return { result, ledger };
	}

	it('has at least 12 breakages and 5 known-good patches', () => {
		assert.ok(breakages.length >= 12, `${breakages.length} breakages`);
		assert.ok(good.length >= 5, `${good.length} good patches`);
	});

	for (const name of good) {
		it(`passes the known-good patch ${name}`, async () => {
			const { result, ledger } = await iterate(join(fixtures, 'good', name), `good-${name}`);
			assert.equal(result.outcome, 'verify_passed', result.failures.map((f) => `${f.check}: ${f.message}`).join('\n'));
			const events = await ledger.history();
			assert.deepEqual(events.map((e) => e.type), ['proposed', 'built', 'verify_passed']);
			assert.deepEqual(checkLedger(events), []);
		});
	}

	for (const name of breakages) {
		it(`rejects the breakage ${name}`, async () => {
			const dir = join(fixtures, 'breakages', name);
			const { check } = JSON.parse(readFileSync(join(dir, 'expect.json'), 'utf8')) as { check: string };
			const { result, ledger } = await iterate(dir, `brk-${name}`);
			assert.equal(result.outcome, 'verify_failed', result.reason);
			const named = result.failures.map((f) => f.check);
			assert.ok(named.includes(check), `expected ${check}, got ${named.join(', ')}`);
			const events = await ledger.history();
			assert.deepEqual(events.map((e) => e.type), ['proposed', 'built', 'verify_failed']);
			const failures = events.at(-1)!.payload.failures as Array<{ check: string; message: string }>;
			assert.ok(failures.some((f) => f.check === check && f.message.length > 0));
		});
	}
});

describe('lab run --dry', () => {
	it('takes a good patch from spec to verify_passed through the CLI', async () => {
		const scratch = mkdtempSync(join(tmpdir(), 'lab-cli-'));
		try {
			const cli = join(fixtures, '..', 'packages', 'cli', 'src', 'index.ts');
			const ledger = join(scratch, 'ledger.jsonl');
			const { stdout } = await promisify(execFile)(process.execPath, [cli, 'run', '--dry', site, '--experiment', join(fixtures, 'good', 'nav-docs'), '--ledger', ledger, '--evidence', join(scratch, 'ev')]);
			assert.match(stdout, /^good-nav-docs: verify_passed$/m);
			const events = await new FileLedger(ledger).history();
			assert.deepEqual(events.map((e) => e.type), ['proposed', 'built', 'verify_passed']);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
