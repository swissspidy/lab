import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FileLedger, StageError, hashPatch, runIteration, validateConfig } from '../src/index.ts';
import type { ExperimentSpec, IterationDeps, RunningSite, SpecCheck, VerifyReport, WebsiteHost } from '../src/index.ts';

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
	mount: 'page.index',
	permissions: ['markup:write'],
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
		// Outside allow, and a kind of file (content:write) the spec did not ask for.
		assert.deepEqual(result.failures.map((f) => f.check), ['static.scope', 'static.permissions']);
		assert.deepEqual(started, []);
		assert.equal(verified, 0);
	});

	it('rejects a patch that changes a kind of file the spec has no permission for', async () => {
		const d = deps({ proposer: { propose: async () => ({ ...spec(), permissions: ['style:write'] }) } });
		const result = await runIteration(d);
		assert.equal(result.outcome, 'verify_failed');
		assert.deepEqual(result.failures.map((f) => f.check), ['static.permissions']);
		assert.deepEqual(started, []);
	});

	it('checks the spec against the site once the baseline is built, and aborts before the variant starts', async () => {
		mkdirSync(join(dir, 'src'));
		writeFileSync(join(dir, 'src', 'a.html'), '<h1>a</h1>');
		let seen: WebsiteHost | null = null;
		const specCheck: SpecCheck = {
			check: (s, host) => {
				seen = host;
				return host.slots[s.mount] ? [] : [{ code: 'mount-unknown', severity: 'error', message: `No slot ${s.mount}.` }];
			},
		};
		const ok = await runIteration(deps({ specCheck }));
		assert.equal(ok.outcome, 'verify_passed');
		assert.deepEqual(seen!.slots, { site: { title: 'The whole site', page: null }, 'page.index': { title: 'The page index.html', page: 'index.html' } });
		assert.deepEqual(seen!.scopes, { 'markup:write': { files: 1 } });

		started = [];
		const d = deps({ specCheck, proposer: { propose: async () => ({ ...spec('exp-0002'), mount: 'page.blog' }) } });
		const result = await runIteration(d);
		assert.equal(result.outcome, 'aborted');
		assert.match(result.reason, /mount-unknown/);
		assert.deepEqual(started, ['baseline']);
		assert.equal((await d.ledger.history()).at(-1)!.payload.stage, 'spec');
	});

	it('awaits an asynchronous spec check', async () => {
		const specCheck: SpecCheck = { check: async () => [{ code: 'async-refusal', severity: 'error', message: 'Refused after an await.' }] };
		const result = await runIteration(deps({ specCheck }));
		assert.equal(result.outcome, 'aborted');
		assert.match(result.reason, /async-refusal/);
	});

	it('records an aborted iteration when the spec check itself throws', async () => {
		const specCheck: SpecCheck = {
			check: () => {
				throw new StageError('surface-broken', 'The surface could not be built.');
			},
		};
		const d = deps({ specCheck });
		const result = await runIteration(d);
		assert.equal(result.outcome, 'aborted');
		assert.match(result.reason, /surface-broken/);
		const last = (await d.ledger.history()).at(-1)!;
		assert.equal(last.type, 'aborted');
		assert.equal(last.payload.stage, 'spec');
		assert.deepEqual(started, ['baseline']);
		assert.equal(stopped, 1);
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

	it('records evidence inside the site relative to it, and leaves other paths as they are', async () => {
		const failing = [
			{ gate: 'invariants' as const, check: 'invariants.x', passed: false, message: 'x', evidence: { screenshot: join(dir, 'lab', 'evidence', 'shot.png') } },
			{ gate: 'invariants' as const, check: 'invariants.y', passed: false, message: 'y', evidence: { screenshot: '/elsewhere/shot.png' } },
		];
		const d = deps({ verdict: report({ passed: false, results: failing }) });
		const result = await runIteration(d);
		const event = (await d.ledger.history()).at(-1)!;
		const shots = (event.payload as { failures: Array<{ evidence?: { screenshot?: string } }> }).failures.map((f) => f.evidence?.screenshot);
		assert.deepEqual(shots, [join('lab', 'evidence', 'shot.png'), '/elsewhere/shot.png']);
		assert.equal(result.failures[0]!.evidence?.screenshot, join(dir, 'lab', 'evidence', 'shot.png'), 'the result keeps the path to open now');
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
