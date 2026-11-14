// M4's acceptance on a local Next.js site: three experiments complete the
// full loop with operator approval at Ship, kept variants are merged in
// git, and a breakage never ships.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkLedger } from '@lab/core';
import { runNextLoop } from '../run-nextjs.ts';

describe('Next.js example: full loop (M4), then an unattended week (M5)', () => {
	it('verifies, ships after approval, measures, keeps the winners, reverts the loser, rejects the breakage; then runs a week by itself', { timeout: 1_800_000 }, async () => {
		const out = mkdtempSync(join(tmpdir(), 'lab-nextjs-report-'));
		const result = await runNextLoop({ out, log: () => {}, week: true });
		try {
			assert.deepEqual(checkLedger(result.events), []);
			assert.deepEqual(result.outcomes, { 'exp-0001': 'kept', 'exp-0002': 'kept', 'exp-0003': 'reverted', 'exp-0004': 'verify_failed' });

			// Three experiments went through the whole loop, each approved before it shipped.
			for (const id of ['exp-0001', 'exp-0002', 'exp-0003']) {
				const types = result.events.filter((e) => e.experiment === id).map((e) => e.type);
				assert.deepEqual(types.slice(0, 5), ['proposed', 'built', 'verify_passed', 'approved', 'shipped'], id);
				assert.ok(types.includes('measured'), id);
				assert.equal(result.events.find((e) => e.experiment === id && e.type === 'approved')?.payload.by, 'operator');
			}
			// The breakage never reached Ship.
			assert.deepEqual(result.events.filter((e) => e.experiment === 'exp-0004').map((e) => e.type), ['proposed', 'built', 'verify_failed']);

			// Both kept variants are commits in the site's history, revertable with git revert.
			const log = execFileSync('git', ['log', '--format=%s'], { cwd: result.repo }).toString();
			assert.match(log, /lab: keep exp-0001/);
			assert.match(log, /lab: keep exp-0002/);
			assert.doesNotMatch(log, /exp-0003/);
			assert.match(readFileSync(join(result.repo, 'components', 'Header.jsx'), 'utf8'), /href="\/docs" data-lab-event="next_step_click">Docs</);
			assert.match(readFileSync(join(result.repo, 'app', 'globals.css'), 'utf8'), /height: 120px;/);

			// The injected beacon works on the hydrated Next.js page.
			assert.ok(result.browserConversions >= 3, `${result.browserConversions} conversions from 4 browser visits`);

			assert.ok(existsSync(join(out, 'index.html')));
			assert.ok(existsSync(join(out, 'ledger.jsonl')));

			// M5: the kill switch was tested on the site, the entry criteria held, and
			// a week ran with no approval but the lab's own.
			const week = result.week!;
			assert.equal(week.variantAfterKill, 0);
			assert.equal(result.events.find((e) => e.experiment === 'exp-0005' && e.type === 'reverted')?.payload.reason, 'kill');
			assert.equal(week.entryMet, true);
			assert.equal(week.manualApprovals, 0);
			assert.equal(week.outcomes['exp-0006'], 'kept');
			assert.equal(week.outcomes['exp-0007'], 'verify_failed');
			assert.notEqual(week.outcomes['exp-0008'], 'kept', 'a variant with no effect must not be kept within a week');
			assert.match(execFileSync('git', ['log', '--format=%s'], { cwd: result.repo }).toString(), /lab: keep exp-0006/);
			assert.match(week.markdown, /Approvals by anyone but the lab: 0\./);
			assert.ok(existsSync(join(out, 'WEEK-ONE.md')));
		} finally {
			result.cleanup();
			rmSync(out, { recursive: true, force: true });
		}
	});
});
