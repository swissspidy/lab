import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StageError, checkTweakCss, newTweakId, parseTweakRecord, validateConfig, validateTweakSpec, verifyTweak } from '../src/index.ts';
import type { CheckResult, RunningSite, Tweak, TweakDeps, VerifyReport } from '../src/index.ts';

const config = validateConfig({
	site: { repo: '.', build: 'b', outDir: 'dist' },
	metric: { id: 'next_step_click', kind: 'conversion' },
	allow: ['src/**'],
	deny: [],
	budgets: { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 },
	traffic: { share: 0.1, minSamplesPerBucket: 1000, maxDays: 14 },
	tweaks: {},
}).config!;

const tweak = (over: Partial<Tweak['spec']> = {}, css = 'body { font-size: 120%; }'): Tweak => ({
	spec: {
		id: 'tw-0123456789ab',
		intent: 'Make the text larger.',
		acceptance: ['The page still shows its heading.'],
		mount: 'site',
		permissions: ['style:write'],
		checks: [{ criterion: 0, page: 'index.html', expect: [{ expect: 'visible', target: { css: 'h1' } }] }],
		...over,
	},
	css,
});
const codes = (raw: unknown) => validateTweakSpec(raw).diagnostics.map((d) => d.code);
const failing = (css: string, maxBytes?: number) => checkTweakCss(css, { tweaks: maxBytes === undefined ? {} : { maxBytes } }).filter((r) => !r.passed).map((r) => r.check);

describe('validateTweakSpec', () => {
	it('accepts a style-only spec with a check for every criterion', () => {
		assert.deepEqual(codes(tweak().spec), []);
		assert.match(newTweakId(), /^tw-[0-9a-f]{12}$/);
	});

	it('allows only style:write: a tweak restyles, it never edits the site', () => {
		assert.deepEqual(codes(tweak({ permissions: ['markup:write'] }).spec), ['tweak-permissions']);
		assert.deepEqual(codes(tweak({ permissions: ['style:write', 'script:write'] }).spec), ['tweak-permissions']);
		assert.deepEqual(codes(tweak({ permissions: [] }).spec), ['tweak-permissions']);
	});

	it('checks the id, mount, criteria and checks', () => {
		assert.deepEqual(codes(tweak({ id: 'exp-0001' }).spec), ['tweak-id']);
		assert.deepEqual(codes(tweak({ mount: 'index.html' }).spec), ['tweak-mount']);
		assert.deepEqual(codes(tweak({ checks: [] }).spec), ['spec-criterion-unchecked']);
		assert.deepEqual(codes({ ...tweak().spec, extra: 1 }), ['tweak-unknown-key']);
		assert.deepEqual(codes(null), ['tweak-not-object']);
	});
});

describe('checkTweakCss', () => {
	it('passes plain styles, comments included', () => {
		assert.deepEqual(failing('/* bigger */ main p { font-size: 1.2rem; line-height: 1.6 }'), []);
	});

	it('refuses anything that makes a request', () => {
		for (const css of ['@import "x.css";', 'a { background: url(https://t.example/p.png) }', 'a { background: URL ( x ) }', 'a { background-image: image-set("a.png" 1x) }', '@font-face { font-family: x; src: local(y) }']) {
			assert.deepEqual(failing(css), ['static.tweak-css'], css);
		}
	});

	it('refuses script, text, markup and escapes that could hide them', () => {
		for (const css of ['a { width: expression(alert(1)) }', 'a { behavior: x }', 'a { -moz-binding: x }', 'a::after { content: "FREE" }', 'a{content:"x"}', '</style><script>alert(1)</script>', 'a { background: u\\72l(x) }', 'a { color: red } /* never closed']) {
			assert.deepEqual(failing(css), ['static.tweak-css'], css);
		}
	});

	it('refuses an empty stylesheet and one over the size limit', () => {
		assert.deepEqual(failing('/* nothing */'), ['static.tweak-css']);
		assert.deepEqual(failing(`a { color: red; ${'b { color: blue } '.repeat(10)} }`, 50), ['static.tweak-size']);
	});

	it('treats a stored record that fails the gate as malformed', () => {
		const record = { ...tweak(), verifiedAt: new Date().toISOString(), siteCommit: 'c', checks: ['acceptance.0'] };
		assert.ok(parseTweakRecord(record, config));
		assert.equal(parseTweakRecord({ ...record, css: 'a { background: url(x) }' }, config), null);
		assert.equal(parseTweakRecord({ ...record, spec: { ...record.spec, permissions: ['markup:write'] } }, config), null);
	});
});

describe('verifyTweak', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lab-tweak-'));
	mkdirSync(join(dir, 'dist'));
	writeFileSync(join(dir, 'dist', 'index.html'), '<h1>Hi</h1>');
	after(() => rmSync(dir, { recursive: true, force: true }));
	const site = (name: string, stopped: string[]): RunningSite => ({ url: `http://${name}/`, root: join(dir, 'dist'), stop: async () => void stopped.push(name) });
	const passed: CheckResult = { gate: 'acceptance', check: 'acceptance.0', passed: true, message: 'ok' };
	const deps = (over: Partial<TweakDeps> & { verdict?: VerifyReport; stopped?: string[]; injected?: string[] } = {}): TweakDeps => {
		const stopped = over.stopped ?? [];
		return {
			config,
			site: { dir, commit: 'c0ffee' },
			sandbox: { start: async () => site('baseline', stopped) },
			injector: { inject: async (_s, css) => (over.injected?.push(css), site('tweaked', stopped)) },
			verifier: { verify: async () => over.verdict ?? { passed: true, baselinePassed: true, results: [passed], baselineResults: [] } },
			evidenceDir: '/tmp/ev',
			now: () => new Date('2026-11-15T10:00:00Z'),
			...over,
		};
	};

	it('verifies a tweak with its CSS injected, and stops both sites', async () => {
		const stopped: string[] = [];
		const injected: string[] = [];
		const outcome = await verifyTweak(deps({ stopped, injected }), tweak());
		assert.equal(outcome.outcome, 'verified');
		assert.deepEqual(injected, ['body { font-size: 120%; }']);
		assert.deepEqual(stopped, ['tweaked', 'baseline']);
		if (outcome.outcome === 'verified') {
			assert.equal(outcome.record.verifiedAt, '2026-11-15T10:00:00.000Z');
			assert.deepEqual(outcome.record.checks, ['static.tweak-size', 'static.tweak-css', 'acceptance.0']);
		}
	});

	it('refuses when the site offers no tweaks', async () => {
		const outcome = await verifyTweak({ ...deps(), config: { ...config, tweaks: undefined } }, tweak());
		assert.equal(outcome.outcome, 'aborted');
		assert.match(outcome.outcome === 'aborted' ? outcome.reason : '', /tweaks-disabled/);
	});

	it('rejects before building when the CSS fails the static gate', async () => {
		let started = false;
		const outcome = await verifyTweak({ ...deps(), sandbox: { start: async () => ((started = true), site('b', [])) } }, tweak({}, 'a { background: url(x) }'));
		assert.equal(outcome.outcome, 'rejected');
		assert.equal(started, false);
	});

	it('rejects a tweak whose checks or the site invariants fail with it', async () => {
		const failed: CheckResult = { gate: 'invariants', check: 'invariants.signup-submits', passed: false, message: 'The form is hidden.' };
		const outcome = await verifyTweak(deps({ verdict: { passed: false, baselinePassed: true, results: [failed], baselineResults: [] } }), tweak());
		assert.equal(outcome.outcome, 'rejected');
		assert.deepEqual(outcome.outcome === 'rejected' ? outcome.failures.map((f) => f.check) : [], ['invariants.signup-submits']);
	});

	it('aborts, without blaming the tweak, when the suite fails without it', async () => {
		const broken: CheckResult = { gate: 'baseline', check: 'baseline.invariants.x', passed: false, message: 'broken' };
		const outcome = await verifyTweak(deps({ verdict: { passed: false, baselinePassed: false, results: [], baselineResults: [broken] } }), tweak());
		assert.equal(outcome.outcome, 'aborted');
	});

	it('asks Graft whether the mount fits the site, offering style:write for any site', async () => {
		let scopes: unknown = null;
		const outcome = await verifyTweak(
			deps({ specCheck: { check: (_spec, host) => ((scopes = host.scopes), [{ code: 'graft-mount-unknown-slot', severity: 'error', message: 'No such page.' }]) } }),
			tweak({ mount: 'page.blog' }),
		);
		assert.equal(outcome.outcome, 'rejected');
		assert.deepEqual(scopes, { 'style:write': { files: 0 } });
	});

	it('reports a spec check that throws as an abort, and stops the baseline', async () => {
		const stopped: string[] = [];
		const outcome = await verifyTweak(deps({ stopped, specCheck: { check: () => { throw new Error('no surface'); } } }), tweak());
		assert.equal(outcome.outcome, 'aborted');
		assert.deepEqual(stopped, ['baseline']);
	});

	it('reports a verifier crash as an abort', async () => {
		const outcome = await verifyTweak({ ...deps(), verifier: { verify: async () => Promise.reject(new StageError('verify-crashed', 'Chromium died.')) } }, tweak());
		assert.equal(outcome.outcome, 'aborted');
		assert.match(outcome.outcome === 'aborted' ? outcome.reason : '', /verify-crashed/);
	});
});
