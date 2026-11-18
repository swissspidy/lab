// M6's acceptance test: the baseline's own findings reach the proposer, and
// a fix is verified against them and merged without traffic. Each flaw is a
// breakage the dry loop rejects (fixtures/breakages), committed to a copy of
// the fixture site; each fix in fixtures/fixes removes it, or fails to.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { BetaBinomialDecider, FileLedger, approve, checkLedger, gitPromote, loadConfig, runIteration, siteCommit, tick } from '@lab/core';
import type { IterationDeps, LabConfig, LiveDeps } from '@lab/core';
import { GraftSpecCheck, assayInvariant } from '@lab/adapters';
import { ReplayBuilder, ReplayProposer } from '@lab/agent';
import { LocalSandbox } from '@lab/sandbox';
import { BrowserObserver, BrowserVerifier } from '@lab/verify';

const fixtures = join(import.meta.dirname, '..');
const fixes = readdirSync(join(fixtures, 'fixes')).toSorted();

interface Expect {
	flaw: string | null;
	outcome: 'verify_passed' | 'verify_failed' | 'aborted';
	check?: string;
	reason?: string;
}

const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.invalid', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

describe('fixes (M6)', { concurrency: 3 }, () => {
	let browser: Browser;
	let scratch: string;

	before(async () => {
		browser = await chromium.launch();
		scratch = mkdtempSync(join(tmpdir(), 'lab-fixes-'));
	});
	after(async () => {
		await browser?.close();
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	/** A git repository holding the fixture site with one breakage committed as its flaw. */
	async function flawedSite(name: string, flaw: string | null): Promise<{ dir: string; config: LabConfig }> {
		const dir = join(scratch, name);
		const source = join(fixtures, 'site');
		cpSync(source, dir, { recursive: true, filter: (src) => !['dist', '.lab', 'ledger.jsonl'].includes(relative(source, src).split('/').at(-1)!) });
		git(dir, ['init', '-q']);
		// The lab commits a merged fix as the repository's own user, as on a real site.
		git(dir, ['config', 'user.name', 'site owner']);
		git(dir, ['config', 'user.email', 'owner@example.invalid']);
		if (flaw) git(dir, ['apply', join(fixtures, 'breakages', flaw, 'patch.diff')]);
		git(dir, ['add', '-A']);
		git(dir, ['commit', '-q', '-m', flaw ? `flaw: ${flaw}` : 'baseline']);
		const loaded = await loadConfig(dir);
		assert.ok(loaded.config, JSON.stringify(loaded.diagnostics));
		return { dir, config: loaded.config };
	}

	const iteration = (dir: string, config: LabConfig, experiment: string): IterationDeps => ({
		config,
		site: { dir, commit: siteCommit(dir) },
		ledger: new FileLedger(join(dir, 'lab', 'ledger.jsonl')),
		proposer: new ReplayProposer(experiment),
		builder: new ReplayBuilder(experiment),
		sandbox: new LocalSandbox({ config, scratch }),
		verifier: new BrowserVerifier({ config, siteDir: dir, browser, invariantKinds: [assayInvariant] }),
		observer: new BrowserObserver({ config, browser }),
		specCheck: new GraftSpecCheck(),
		evidenceDir: join(scratch, 'evidence', relative(scratch, dir)),
	});

	it('has a fix that passes and a fix for each way one can fail', () => {
		const outcomes = new Set(fixes.map((name) => (JSON.parse(readFileSync(join(fixtures, 'fixes', name, 'expect.json'), 'utf8')) as Expect).outcome));
		assert.deepEqual([...outcomes].toSorted(), ['aborted', 'verify_failed', 'verify_passed']);
	});

	for (const name of fixes) {
		it(`runs the fix ${name} to its expected outcome`, async () => {
			const experiment = join(fixtures, 'fixes', name);
			const expected = JSON.parse(readFileSync(join(experiment, 'expect.json'), 'utf8')) as Expect;
			const { dir, config } = await flawedSite(`fix-${name}`, expected.flaw);
			const deps = iteration(dir, config, experiment);
			const result = await runIteration(deps);
			const detail = `${result.reason}\n${result.failures.map((f) => `${f.check}: ${f.message}`).join('\n')}`;
			assert.equal(result.outcome, expected.outcome, detail);
			if (expected.check) assert.ok(result.failures.some((f) => f.check === expected.check && f.message.length > 0), detail);
			if (expected.reason) assert.ok(detail.includes(expected.reason), detail);
			const events = await deps.ledger.history();
			assert.deepEqual(checkLedger(events), []);
			if (expected.outcome === 'verify_passed') {
				const spec = JSON.parse(readFileSync(join(experiment, 'spec.json'), 'utf8')) as { evidence: string[] };
				// The ledger keeps what was observed for each cited finding.
				assert.deepEqual((events[0]!.payload.evidence as Array<{ id: string }>).map((f) => f.id), spec.evidence);
				const resolved = result.report!.results.find((r) => r.check === 'fix.resolved');
				assert.equal(resolved?.passed, true, resolved?.message);
				assert.deepEqual(result.report!.findings!.variant, []);
			}
		});
	}

	it('merges an approved fix into the site repository, without shipping it', async () => {
		const experiment = join(fixtures, 'fixes', 'contrast');
		const { dir, config } = await flawedSite('merge-contrast', 'contrast-failure');
		const shipped: string[] = [];
		const live: LiveDeps = {
			config,
			site: { dir, commit: siteCommit(dir) },
			ledger: new FileLedger(join(dir, 'lab', 'ledger.jsonl')),
			deployer: { ship: async (v) => void shipped.push(v.experiment), rollback: async () => {}, promote: async () => {}, kill: async () => {} },
			meter: { read: async () => assert.fail('a fix is never measured'), traffic: async () => assert.fail('a fix needs no traffic') },
			decider: new BetaBinomialDecider(config),
			promote: async (variant) => void gitPromote(dir, variant, `lab: fix ${variant.experiment}`),
		};
		const first = await tick({ ...iteration(dir, config, experiment), ...live });
		assert.equal(first.step, 'iterate');
		assert.equal((first as { result: { outcome: string } }).result.outcome, 'verify_passed');
		await approve(live, 'fix-contrast', 'reviewer');
		const second = await tick({ ...iteration(dir, config, experiment), ...live });
		assert.equal(second.step, 'merge');
		const merged = (second as { result: { outcome: string; reason: string } }).result;
		assert.equal(merged.outcome, 'merged', merged.reason);
		assert.deepEqual(shipped, []);
		assert.equal(git(dir, ['log', '-1', '--format=%s']), 'lab: fix fix-contrast');
		assert.equal((await live.ledger.history()).at(-1)!.type, 'merged');

		// The merged site no longer has what the fix cited.
		const site = await new LocalSandbox({ config, scratch }).start({ dir, commit: siteCommit(dir) });
		try {
			const findings = await new BrowserObserver({ config, browser }).observe(site);
			assert.deepEqual(findings.filter((f) => f.id.startsWith('a11y.color-contrast')), []);
		} finally {
			await site.stop();
		}
	});
});
