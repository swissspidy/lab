import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FileLedger, StageError, hashPatch, runIteration, validateConfig } from '../src/index.ts';
import type { ExperimentSpec, IterationDeps, RunningSite, VerifyReport } from '../src/index.ts';

const config = validateConfig({
	site: { repo: '.', build: 'b', outDir: 'dist' },
	metric: { id: 'next_step_click', kind: 'conversion' },
	allow: ['src/**'],
	deny: [],
	budgets: { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 },
	traffic: { share: 0.1, minSamplesPerBucket: 1000, maxDays: 14 },
}).config!;

const spec = (id = 'exp-0001'): ExperimentSpec => ({
	id,
	hypothesis: 'h',
	intent: 'Change the heading.',
	acceptance: ['The heading changed.'],
	expectedEffect: 'next_step_click up',
	touches: ['src/a.html'],
	source: 'agent',
	checks: [{ criterion: 0, page: 'index.html', expect: [{ expect: 'visible', target: { css: 'h1' } }] }],
});
const PATCH = 'diff --git a/src/a.html b/src/a.html\nindex 1..2 100644\n--- a/src/a.html\n+++ b/src/a.html\n@@ -1 +1 @@\n-a\n+b\n';
const report = (over: Partial<VerifyReport> = {}): VerifyReport => ({ passed: true, baselinePassed: true, results: [{ gate: 'invariants', check: 'invariants.x', passed: true, message: 'ok' }], baselineResults: [], ...over });

describe('runIteration', () => {
	let dir: string;
	let started: string[];
	let stopped: number;
	let verified: number;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'lab-orch-'));
		started = [];
		stopped = 0;
		verified = 0;
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const deps = (over: Partial<IterationDeps> & { patch?: string; verdict?: VerifyReport; failStart?: 'baseline' | 'variant' } = {}): IterationDeps => ({
		config,
		site: { dir, commit: 'c0ffee' },
		ledger: new FileLedger(join(dir, 'ledger.jsonl')),
		proposer: { propose: async () => spec() },
		builder: { build: async (s, repo) => ({ experiment: s.id, base: repo, patch: over.patch ?? PATCH, patchHash: hashPatch(over.patch ?? PATCH) }) },
		sandbox: {
			start: async (ref) => {
				const which = 'patch' in ref ? 'variant' : 'baseline';
				if (over.failStart === which) throw new StageError('sandbox-build-failed', `${which} build failed`, 'log');
				started.push(which);
				return { url: `http://${which}/`, stop: async () => void stopped++ } satisfies RunningSite;
			},
		},
		verifier: { verify: async () => (verified++, over.verdict ?? report()) },
		evidenceDir: join(dir, 'ev'),
		...over,
	});

	it('records a passing iteration and stops both sites', async () => {
		const d = deps();
		const result = await runIteration(d);
		assert.equal(result.outcome, 'verify_passed');
		assert.deepEqual((await d.ledger.history()).map((e) => e.type), ['proposed', 'built', 'verify_passed']);
		assert.deepEqual(started, ['baseline', 'variant']);
		assert.equal(stopped, 2);
	});

	it('rejects an out-of-scope patch before anything is built or verified', async () => {
		const d = deps({ patch: PATCH.replaceAll('src/a.html', 'package.json') });
		const result = await runIteration(d);
		assert.equal(result.outcome, 'verify_failed');
		assert.deepEqual(result.failures.map((f) => f.check), ['static.scope']);
		assert.deepEqual(started, []);
		assert.equal(verified, 0);
	});

	it('names static.build when the variant does not build', async () => {
		const result = await runIteration(deps({ failStart: 'variant' }));
		assert.equal(result.outcome, 'verify_failed');
		assert.deepEqual(result.failures.map((f) => [f.check, f.evidence?.detail]), [['static.build', 'log']]);
		assert.equal(stopped, 1);
	});

	it('aborts, without blaming the variant, when the baseline does not build', async () => {
		const d = deps({ failStart: 'baseline' });
		const result = await runIteration(d);
		assert.equal(result.outcome, 'aborted');
		assert.deepEqual((await d.ledger.history()).map((e) => e.type), ['proposed', 'built', 'aborted']);
	});

	it('aborts when the suite fails on the baseline', async () => {
		const failing = { gate: 'baseline' as const, check: 'baseline.invariants.x', passed: false, message: 'broken' };
		const result = await runIteration(deps({ verdict: report({ passed: false, baselinePassed: false, baselineResults: [failing] }) }));
		assert.equal(result.outcome, 'aborted');
		assert.deepEqual(result.failures.map((f) => f.check), ['baseline.invariants.x']);
	});

	it('fails when any variant check fails, even if the verifier says it passed', async () => {
		const result = await runIteration(deps({ verdict: report({ passed: true, results: [{ gate: 'budgets', check: 'budgets.axe', passed: false, message: 'new violation' }] }) }));
		assert.equal(result.outcome, 'verify_failed');
		assert.deepEqual(result.failures.map((f) => f.check), ['budgets.axe']);
	});

	it('records an invalid spec as proposed, then aborted', async () => {
		const d = deps({ proposer: { propose: async () => ({ ...spec(), checks: [] }) } });
		const result = await runIteration(d);
		assert.equal(result.outcome, 'aborted');
		assert.match(result.reason, /spec-criterion-unchecked/);
		assert.deepEqual((await d.ledger.history()).map((e) => e.type), ['proposed', 'aborted']);
		assert.deepEqual(started, []);
	});

	it('aborts without a ledger entry when the proposer fails', async () => {
		const d = deps({ proposer: { propose: async () => Promise.reject(new StageError('model-unavailable', 'no key')) } });
		const result = await runIteration(d);
		assert.equal(result.outcome, 'aborted');
		assert.equal((await d.ledger.history()).length, 0);
	});
});
