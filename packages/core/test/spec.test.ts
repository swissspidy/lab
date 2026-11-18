import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, validateSpec } from '../src/index.ts';
import type { LedgerEvent } from '../src/index.ts';

const config = validateConfig({
	site: { repo: '.', build: 'b', outDir: 'dist' },
	metric: { id: 'next_step_click', kind: 'conversion' },
	allow: ['src/**'],
	deny: [],
	budgets: { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 },
	traffic: { share: 0.1, minSamplesPerBucket: 1000, maxDays: 14 },
}).config!;

const spec = () => ({
	id: 'exp-0007',
	hypothesis: 'Visitors miss the install command.',
	intent: 'Move the install command into the hero section.',
	acceptance: ['The install command is visible without scrolling.', 'Copy copies the command.'],
	expectedEffect: 'next_step_click up',
	touches: ['src/pages/index.astro'],
	mount: 'page.index',
	permissions: ['markup:write'] as unknown[],
	source: 'agent',
	checks: [
		{ criterion: 0, page: 'index.html', expect: [{ expect: 'in-viewport', target: { css: '[data-install-command]' } }] },
		{ criterion: 1, page: 'index.html', steps: [{ do: 'click', target: { role: 'button', name: 'Copy' } }], expect: [{ expect: 'clipboard', equals: 'npm i x' }] },
	],
});
const codes = (raw: unknown, history: LedgerEvent[] = []) => validateSpec(raw, config, history).diagnostics.map((d) => d.code);

const event = (type: LedgerEvent['type'], experiment: string, payload: Record<string, unknown> = {}) => ({ type, experiment, payload }) as unknown as LedgerEvent;

describe('validateSpec', () => {
	it('accepts a complete spec', () => {
		assert.deepEqual(codes(spec()), []);
	});

	it('requires a check for every criterion', () => {
		const s = spec();
		s.checks = s.checks.slice(0, 1);
		assert.deepEqual(codes(s), ['spec-criterion-unchecked']);
	});

	it('rejects malformed checks', () => {
		const bad = (check: unknown) => codes({ ...spec(), checks: [...spec().checks, check] });
		assert.deepEqual(bad({ criterion: 5, page: 'index.html', expect: [{ expect: 'visible', target: { css: 'h1' } }] }), ['spec-check-invalid']);
		assert.deepEqual(bad({ criterion: 0, page: 'https://evil.example/', expect: [{ expect: 'visible', target: { css: 'h1' } }] }), ['spec-check-invalid']);
		assert.deepEqual(bad({ criterion: 0, page: '../secret.html', expect: [{ expect: 'visible', target: { css: 'h1' } }] }), ['spec-check-invalid']);
		assert.deepEqual(bad({ criterion: 0, page: 'index.html', expect: [] }), ['spec-check-invalid']);
		assert.deepEqual(bad({ criterion: 0, page: 'index.html', expect: [{ expect: 'eval', code: 'alert(1)' }] }), ['spec-check-invalid']);
		assert.deepEqual(bad({ criterion: 0, page: 'index.html', steps: [{ do: 'evaluate', script: 'x' }], expect: [{ expect: 'visible', target: { css: 'h1' } }] }), ['spec-check-invalid']);
		assert.deepEqual(bad({ criterion: 0, page: 'index.html', expect: [{ expect: 'text', target: { css: 'h1' } }] }), ['spec-check-invalid']);
		assert.deepEqual(bad({ criterion: 0, page: 'index.html', expect: [{ expect: 'visible', target: { xpath: '//h1' } }] }), ['spec-check-invalid']);
	});

	it('checks the fields and the expected effect', () => {
		assert.deepEqual(codes({ ...spec(), id: 'Exp 7' }), ['spec-id']);
		assert.deepEqual(codes({ ...spec(), intent: ' ' }), ['spec-missing-text']);
		assert.deepEqual(codes({ ...spec(), expectedEffect: 'revenue up' }), ['spec-effect']);
		assert.deepEqual(codes({ ...spec(), source: 'model' }), ['spec-source']);
		assert.deepEqual(codes({ ...spec(), extra: 1 }), ['spec-unknown-key']);
		assert.deepEqual(codes({ ...spec(), acceptance: [] }).includes('spec-acceptance'), true);
	});

	it('checks a fix: it cites what it removes, by known ids, and is not measured', () => {
		const findings = [{ id: 'layout.overflow@index.html', kind: 'layout' as const, page: 'index.html', viewports: ['390x844'], summary: 'The page scrolls sideways at 390x844.', check: 'budgets.overflow' }];
		const fix = { ...spec(), kind: 'fix', evidence: ['layout.overflow@index.html'], expectedEffect: 'none' };
		const fixCodes = (raw: unknown) => validateSpec(raw, config, [], findings).diagnostics.map((d) => d.code);
		assert.deepEqual(fixCodes(fix), []);
		assert.deepEqual(fixCodes({ ...fix, kind: 'patch' }), ['spec-kind', 'spec-effect']);
		assert.deepEqual(fixCodes({ ...fix, evidence: [] }), ['spec-fix-evidence']);
		assert.deepEqual(fixCodes({ ...fix, evidence: undefined }), ['spec-fix-evidence']);
		assert.deepEqual(fixCodes({ ...fix, evidence: ['x', 'x'] }), ['spec-evidence']);
		assert.deepEqual(fixCodes({ ...fix, evidence: ['a11y.color-contrast@index.html'] }), ['spec-evidence-unknown']);
		assert.deepEqual(fixCodes({ ...fix, expectedEffect: 'next_step_click up' }), ['spec-effect']);
		// An experiment may cite findings, and must still name its effect on the metric.
		assert.deepEqual(fixCodes({ ...spec(), evidence: ['layout.overflow@index.html'] }), []);
		assert.deepEqual(fixCodes({ ...spec(), expectedEffect: 'none' }), ['spec-effect']);
		// Without an observation, ids cannot be checked here; Verify checks them on the baseline.
		assert.deepEqual(codes({ ...fix, evidence: ['a11y.color-contrast@index.html'] }), []);
	});

	it('requires a mount slot and known permissions', () => {
		assert.deepEqual(codes({ ...spec(), mount: 'site' }), []);
		assert.deepEqual(codes({ ...spec(), mount: 'page.docs.intro' }), []);
		assert.deepEqual(codes({ ...spec(), mount: 'index.html' }), ['spec-mount']);
		assert.deepEqual(codes({ ...spec(), mount: undefined }), ['spec-mount']);
		assert.deepEqual(codes({ ...spec(), permissions: [] }), ['spec-permissions']);
		assert.deepEqual(codes({ ...spec(), permissions: undefined }), ['spec-permissions']);
		assert.deepEqual(codes({ ...spec(), permissions: ['markup:write', 'markup:write'] }), ['spec-permissions']);
		assert.deepEqual(codes({ ...spec(), permissions: ['config:write'] }), ['spec-permission-unknown']);
		// A value with a hostile toString is reported, not coerced (which would throw).
		const hostile = { toString: null };
		assert.deepEqual(codes({ ...spec(), permissions: [hostile] }), ['spec-permission-unknown']);
		assert.deepEqual(codes({ ...spec(), checks: [{ criterion: 0, page: 'index.html', steps: [{ do: hostile }], expect: [{ expect: hostile }] }, spec().checks[1]] }), ['spec-check-invalid', 'spec-check-invalid']);
	});

	it('refuses an id the ledger already has', () => {
		assert.deepEqual(codes(spec(), [event('proposed', 'exp-0007', { source: 'agent', spec: { intent: 'other' } })]), ['spec-id-taken']);
	});

	it('refuses to repeat a reverted experiment', () => {
		const history = [
			event('proposed', 'exp-0001', { source: 'agent', spec: { intent: 'Move the install command into the hero section!' } }),
			event('reverted', 'exp-0001'),
		];
		assert.deepEqual(codes(spec(), history), ['spec-repeats-reverted']);
		// The same intent that was only rejected by Verify may be tried again under a new id.
		assert.deepEqual(codes(spec(), [history[0]!, event('verify_failed', 'exp-0001')]), []);
	});
});
