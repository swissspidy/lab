import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FileLedger, sha256 } from '@lab/core';
import type { LedgerEventInput } from '@lab/core';
import { experimentViews, renderReport, writeReport } from '../src/index.ts';

const PATCH = 'diff --git a/src/a.html b/src/a.html\nindex 1..2 100644\n--- a/src/a.html\n+++ b/src/a.html\n@@ -1 +1 @@\n-<h1>Old</h1>\n+<h1>New</h1>\n';

async function ledgerWith(dir: string, screenshot: string) {
	let t = Date.UTC(2026, 0, 1);
	const ledger = new FileLedger(join(dir, 'ledger.jsonl'), { now: () => new Date((t += 3_600_000)) });
	const a = { experiment: 'exp-0001', siteCommit: 'c', patchHash: sha256(PATCH) };
	await ledger.append({ ...a, type: 'proposed', patchHash: null, payload: { source: 'agent', spec: { hypothesis: 'People miss <script>alert(1)</script> the button.', intent: 'Move the button up.', acceptance: ['The button is above the fold.'], expectedEffect: 'next_step_click up' } } });
	await ledger.append({ ...a, type: 'built', payload: { patch: PATCH } });
	await ledger.append({ ...a, type: 'verify_passed', payload: { results: [{ gate: 'acceptance', check: 'acceptance.0', passed: true, message: '“The button is above the fold.” 1 assertion(s) hold.' }, { gate: 'budgets', check: 'budgets.axe', passed: true, message: 'No new aXe violations.' }] } });
	await ledger.append({ ...a, type: 'approved', payload: { by: 'pascal' } });
	await ledger.append({ ...a, type: 'shipped', payload: { share: 0.1 } });
	const stats = { baseline: { visits: 4000, conversions: 400 }, variant: { visits: 4000, conversions: 520 } };
	await ledger.append({ ...a, type: 'measured', payload: { day: 1, stats, probability: 0.999, decision: { action: 'keep', reason: 'P = 0.999 ≥ 0.95.' } } } as LedgerEventInput);
	await ledger.append({ ...a, type: 'kept', payload: { reason: 'P = 0.999 ≥ 0.95.' } });
	const b = { experiment: 'exp-0002', siteCommit: 'c', patchHash: sha256('x') };
	await ledger.append({ ...b, type: 'proposed', patchHash: null, payload: { source: 'agent', spec: { hypothesis: 'h', intent: 'Change the price.', acceptance: ['x'], expectedEffect: 'next_step_click up' } } });
	await ledger.append({ ...b, type: 'built', payload: { patch: 'x' } });
	await ledger.append({ ...b, type: 'verify_failed', payload: { failures: [{ gate: 'static', check: 'static.claims-numbers', passed: false, message: 'Numbers and prices changed: added "CHF 29".', evidence: { screenshot } }] } });
	return ledger.history();
}

describe('report', () => {
	it('tells each experiment from hypothesis to decision, newest first', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-report-'));
		try {
			const events = await ledgerWith(dir, join(dir, 'shot.png'));
			const views = experimentViews(events);
			assert.deepEqual(views.map((v) => [v.id, v.state]), [['exp-0002', 'verify_failed'], ['exp-0001', 'kept']]);
			const html = renderReport(events, { generatedAt: new Date(Date.UTC(2026, 0, 2)) });
			for (const text of ['Move the button up.', 'The button is above the fold.', '<span class="pass">met</span>', '&lt;h1&gt;New&lt;/h1&gt;', 'static.claims-numbers', '10.00%', '13.00%', 'keep: P = 0.999', 'approved by pascal', '1 kept', '1 rejected by verification']) {
				assert.ok(html.includes(text), text);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('shows why an invalid proposal was aborted, and survives a malformed spec', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-report-'));
		try {
			const ledger = new FileLedger(join(dir, 'ledger.jsonl'));
			const base = { experiment: 'exp-0003', siteCommit: 'c', patchHash: null };
			await ledger.append({ ...base, type: 'proposed', payload: { source: 'agent', spec: { intent: 'x', acceptance: 'not a list' } } });
			await ledger.append({ ...base, type: 'aborted', payload: { stage: 'propose', diagnostics: [{ code: 'spec-criterion-unchecked', message: 'Criterion 0 has no check.' }] } });
			const html = renderReport(await ledger.history());
			assert.ok(html.includes('spec-criterion-unchecked: Criterion 0 has no check.'));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('shows a fix, the findings it cites as observed, and its merge', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-report-fix-'));
		try {
			const ledger = new FileLedger(join(dir, 'ledger.jsonl'), { now: () => new Date(Date.UTC(2026, 0, 1)) });
			const a = { experiment: 'exp-0003', siteCommit: 'c', patchHash: sha256(PATCH) };
			const evidence = [{ id: 'layout.overflow@pricing.html', kind: 'layout', page: 'pricing.html', viewports: ['390x844'], summary: 'The page scrolls sideways at 390x844.' }];
			await ledger.append({ ...a, type: 'proposed', patchHash: null, payload: { source: 'agent', evidence, spec: { kind: 'fix', evidence: ['layout.overflow@pricing.html'], hypothesis: 'h', intent: 'Let the plans wrap.', acceptance: ['x'], expectedEffect: 'none' } } } as LedgerEventInput);
			await ledger.append({ ...a, type: 'built', payload: { patch: PATCH } });
			await ledger.append({ ...a, type: 'verify_passed', payload: { results: [{ gate: 'fix', check: 'fix.resolved', passed: true, message: 'Gone from the variant: layout.overflow@pricing.html.' }] } });
			await ledger.append({ ...a, type: 'approved', payload: { by: 'pascal' } });
			const pending = renderReport(await ledger.history());
			assert.ok(pending.includes('Approved, waiting to merge'));
			await ledger.append({ ...a, type: 'merged', payload: { reason: 'Verified fix for layout.overflow@pricing.html; merged without an experiment.' } });
			const html = renderReport(await ledger.history());
			for (const text of ['Fix: verified in the sandbox and merged after approval', '<code>layout.overflow@pricing.html</code>: The page scrolls sideways at 390x844.', 'fix.resolved', 'Merged: Verified fix', '1 fix(es) merged', 'state-merged']) {
				assert.ok(html.includes(text), text);
			}
			assert.ok(!html.includes('<dt>Expected effect</dt>'), 'a fix is not measured');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('escapes everything the ledger holds', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-report-'));
		try {
			const html = renderReport(await ledgerWith(dir, '/nope.png'));
			assert.ok(!html.includes('<script>alert(1)</script>'));
			assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
			assert.ok(!/<script/i.test(html), 'the page has no scripts at all');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('declares its color schemes and names its tables and scrolling regions', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-report-'));
		try {
			const html = renderReport(await ledgerWith(dir, '/nope.png'));
			assert.ok(html.includes('<meta name="color-scheme" content="light dark">'));
			assert.equal((html.match(/<table>/g) ?? []).length, 3);
			assert.equal((html.match(/<caption /g) ?? []).length, 3, 'every table has a caption');
			assert.ok(!/<th>/.test(html), 'every header cell has a scope');
			for (const id of ['exp-0001-checks', 'exp-0001-measurements', 'exp-0002-checks']) {
				assert.ok(html.includes(`<div class="table-wrap" tabindex="0" role="region" aria-labelledby="${id}"><table><caption id="${id}"`), id);
			}
			assert.ok(html.includes('<pre class="diff" tabindex="0" role="region" aria-label="Diff of exp-0001">'));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('finds evidence recorded relative to the site directory', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-report-'));
		try {
			writeFileSync(join(dir, 'shot.png'), 'png');
			const file = writeReport(await ledgerWith(dir, 'shot.png'), join(dir, 'out'), { siteDir: dir });
			assert.match(readFileSync(file, 'utf8'), /<a href="evidence\/0-shot\.png">screenshot<\/a>/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('copies evidence screenshots next to the page', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-report-'));
		try {
			writeFileSync(join(dir, 'shot.png'), 'png');
			const file = writeReport(await ledgerWith(dir, join(dir, 'shot.png')), join(dir, 'out'));
			const html = readFileSync(file, 'utf8');
			assert.match(html, /<a href="evidence\/0-shot\.png">screenshot<\/a>/);
			assert.ok(existsSync(join(dir, 'out', 'evidence', '0-shot.png')));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
