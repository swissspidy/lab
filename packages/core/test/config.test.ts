import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALWAYS_DENIED, effectiveDeny, loadConfig, validateConfig } from '../src/index.ts';

const fixture = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'site');

const valid = () => ({
	site: { repo: '.', build: 'npm run build', outDir: 'dist' },
	metric: { id: 'next_step_click', kind: 'conversion' },
	allow: ['src/pages/**'],
	deny: ['**/legal/**'],
	budgets: { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 },
	traffic: { share: 0.1, minSamplesPerBucket: 1000, maxDays: 14 },
});

const codes = (raw: unknown) => validateConfig(raw).diagnostics.map((d) => d.code);

describe('validateConfig', () => {
	it('accepts a minimal config and fills in defaults', () => {
		const { config, diagnostics } = validateConfig(valid());
		assert.deepEqual(diagnostics, []);
		assert.equal(config?.autonomy, 'gated');
		assert.deepEqual(config?.limits, { maxChangedLines: 200, maxFiles: 5 });
		assert.equal(config?.invariants, 'lab/invariants/');
		assert.equal(config?.viewports.length, 2);
	});

	it('rejects a non-object', () => {
		assert.deepEqual(codes(null), ['config-not-object']);
		assert.deepEqual(codes([]), ['config-not-object']);
	});

	it('rejects unknown keys at both levels, so typos in safety settings never fall back silently', () => {
		assert.deepEqual(codes({ ...valid(), denny: [] }), ['config-unknown-key']);
		assert.deepEqual(codes({ ...valid(), traffic: { ...valid().traffic, shares: 0.5 } }), ['config-unknown-key']);
	});

	it('requires the keys with no safe default', () => {
		for (const key of ['site', 'metric', 'allow', 'deny', 'budgets', 'traffic'] as const) {
			const raw: Record<string, unknown> = valid();
			delete raw[key];
			assert.deepEqual(codes(raw), ['config-missing-key'], key);
		}
		assert.deepEqual(codes({ ...valid(), budgets: { lcpMs: 1, cls: 1, axeViolations: 0 } }), ['config-missing-key']);
	});

	it('checks types', () => {
		assert.deepEqual(codes({ ...valid(), allow: 'src/**' }), ['config-invalid-type']);
		assert.deepEqual(codes({ ...valid(), budgets: { ...valid().budgets, cls: '0.1' } }), ['config-invalid-type']);
		assert.deepEqual(codes({ ...valid(), viewports: [{ width: 0, height: 800 }] }), ['config-invalid-type']);
		assert.deepEqual(codes({ ...valid(), viewports: [] }), ['config-invalid-type']);
	});

	it('keeps the variant a minority of traffic', () => {
		for (const share of [0, -0.1, 0.51, 1]) {
			assert.deepEqual(codes({ ...valid(), traffic: { ...valid().traffic, share } }), ['config-traffic-share'], String(share));
		}
		assert.deepEqual(codes({ ...valid(), traffic: { ...valid().traffic, share: 0.5 } }), []);
	});

	it('checks sample and duration bounds', () => {
		assert.deepEqual(codes({ ...valid(), traffic: { ...valid().traffic, minSamplesPerBucket: 10 } }), ['config-traffic-samples']);
		assert.deepEqual(codes({ ...valid(), traffic: { ...valid().traffic, maxDays: 0 } }), ['config-traffic-days']);
		assert.deepEqual(codes({ ...valid(), traffic: { ...valid().traffic, maxDays: 1.5 } }), ['config-traffic-days']);
	});

	it('accepts auto autonomy with a warning: the entry criteria decide when it takes effect', () => {
		const result = validateConfig({ ...valid(), autonomy: 'auto' });
		assert.ok(result.config);
		assert.deepEqual(result.diagnostics.map((d) => [d.code, d.severity]), [['config-autonomy-auto', 'warning']]);
		assert.deepEqual(codes({ ...valid(), autonomy: 'yolo' }), ['config-autonomy']);
		assert.deepEqual(codes({ ...valid(), autonomy: 'propose-only' }), []);
	});

	it('supports only conversion metrics', () => {
		assert.deepEqual(codes({ ...valid(), metric: { id: 'revenue', kind: 'continuous' } }), ['config-metric-kind']);
	});

	it('refuses allow lists that are empty, everything, or outside the repo', () => {
		assert.deepEqual(codes({ ...valid(), allow: [] }), ['config-allow-empty']);
		assert.deepEqual(codes({ ...valid(), allow: ['**'] }), ['config-allow-everything']);
		assert.deepEqual(codes({ ...valid(), allow: ['../other/**'] }), ['config-allow-outside']);
		assert.deepEqual(codes({ ...valid(), allow: ['/etc/**'] }), ['config-allow-outside']);
	});

	it('refuses negative budgets and warns about allowing aXe violations', () => {
		assert.deepEqual(codes({ ...valid(), budgets: { ...valid().budgets, lcpMs: -1 } }), ['config-budget-negative']);
		const result = validateConfig({ ...valid(), budgets: { ...valid().budgets, axeViolations: 2 } });
		assert.ok(result.config);
		assert.deepEqual(result.diagnostics.map((d) => [d.code, d.severity]), [['config-budget-axe', 'warning']]);
	});

	it('always denies the lab directory, the config, dependencies and CI', () => {
		const { config } = validateConfig({ ...valid(), deny: [] });
		assert.ok(config);
		const deny = effectiveDeny(config);
		for (const pattern of ALWAYS_DENIED) assert.ok(deny.includes(pattern), pattern);
		assert.ok(deny.includes('lab/**'));
	});
});

describe('loadConfig', () => {
	it('loads the fixture site config', async () => {
		const { config, diagnostics, siteDir } = await loadConfig(fixture);
		assert.deepEqual(diagnostics, []);
		assert.equal(config?.metric.id, 'next_step_click');
		assert.equal(siteDir, fixture);
	});

	it('reports a missing config', async () => {
		const { config, diagnostics } = await loadConfig(join(fixture, 'src'));
		assert.equal(config, null);
		assert.deepEqual(diagnostics.map((d) => d.code), ['config-missing']);
	});
});
