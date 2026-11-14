import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BetaBinomialDecider, FileLedger, StageError, approve, gitPromote, kill, measure, planShip, requiredSamples, sha256, ship, tick, validateConfig } from '../src/index.ts';
import type { BucketStats, Deployer, LiveDeps, TrafficEstimate } from '../src/index.ts';

const config = validateConfig({
	site: { repo: '.', build: 'b', outDir: 'dist' },
	metric: { id: 'next_step_click', kind: 'conversion' },
	guardrailMetrics: ['js_error_rate'],
	allow: ['src/**'],
	deny: [],
	budgets: { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 },
	traffic: { share: 0.1, minSamplesPerBucket: 1000, maxDays: 14 },
}).config!;

const PATCH = 'diff --git a/src/a.html b/src/a.html\nindex 1..2 100644\n--- a/src/a.html\n+++ b/src/a.html\n@@ -1 +1 @@\n-a\n+b\n';
const counts = (visits: number, conversions: number) => ({ visits, conversions, jsErrors: 0, engaged: 0 });

describe('lifecycle', () => {
	let dir: string;
	let ledger: FileLedger;
	let log: string[];
	let clock: number;
	let stats: BucketStats;
	let traffic: TrafficEstimate;
	let promoted: string[];

	const deployer: Deployer = {
		ship: async (v) => void log.push(`ship ${v.experiment}`),
		rollback: async (id) => void log.push(`rollback ${id}`),
		promote: async (id) => void log.push(`promote ${id}`),
		kill: async () => void log.push('kill'),
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'lab-life-'));
		clock = Date.UTC(2026, 0, 1);
		ledger = new FileLedger(join(dir, 'ledger.jsonl'), { now: () => new Date(clock) });
		log = [];
		promoted = [];
		stats = { experiment: 'exp-0001', baseline: counts(0, 0), variant: counts(0, 0), latest: null, guardrails: { js_error_rate: { degraded: false } }, days: 0 };
		traffic = { dailyVisits: 50_000, conversionRate: 0.1, days: 7 };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const deps = (over: Partial<LiveDeps> = {}): LiveDeps => ({
		config,
		site: { dir, commit: 'c' },
		ledger,
		deployer,
		meter: { read: async () => structuredClone(stats), traffic: async () => traffic },
		decider: new BetaBinomialDecider(config),
		now: () => new Date(clock),
		promote: async (v) => void promoted.push(v.experiment),
		...over,
	});

	async function verified(id = 'exp-0001', patch = PATCH) {
		const base = { experiment: id, siteCommit: 'c', patchHash: sha256(patch) };
		await ledger.append({ ...base, type: 'proposed', patchHash: null, payload: { source: 'agent', spec: { id, intent: 'x', expectedEffect: 'next_step_click up' } } });
		await ledger.append({ ...base, type: 'built', payload: { patch } });
		await ledger.append({ ...base, type: 'verify_passed', payload: {} });
	}

	it('approves only a verified experiment', async () => {
		await verified();
		await assert.rejects(approve(deps(), 'exp-0009', 'me'), (e: unknown) => e instanceof StageError && e.code === 'approve-invalid-state');
		await approve(deps(), 'exp-0001', 'me');
		await assert.rejects(approve(deps(), 'exp-0001', 'me'), (e: unknown) => e instanceof StageError && e.code === 'approve-invalid-state');
	});

	it('ships only an approved experiment, one at a time', async () => {
		await verified();
		await assert.rejects(ship(deps(), 'exp-0001'), (e: unknown) => e instanceof StageError && e.code === 'ship-invalid-state');
		await approve(deps(), 'exp-0001', 'me');
		assert.equal((await ship(deps(), 'exp-0001')).outcome, 'shipped');
		await verified('exp-0002', PATCH.replace('+b', '+c'));
		await approve(deps(), 'exp-0002', 'me');
		await assert.rejects(ship(deps(), 'exp-0002'), (e: unknown) => e instanceof StageError && e.code === 'ship-experiment-live');
		assert.deepEqual(log, ['ship exp-0001']);
	});

	it('refuses to ship a patch that does not match its recorded hash', async () => {
		const base = { experiment: 'exp-0001', siteCommit: 'c', patchHash: sha256('other') };
		await ledger.append({ ...base, type: 'proposed', patchHash: null, payload: { source: 'agent', spec: {} } });
		await ledger.append({ ...base, type: 'built', payload: { patch: PATCH } });
		await ledger.append({ ...base, type: 'verify_passed', payload: {} });
		await approve(deps(), 'exp-0001', 'me');
		await assert.rejects(ship(deps(), 'exp-0001'), (e: unknown) => e instanceof StageError && e.code === 'ledger-patch-mismatch');
		assert.deepEqual(log, []);
	});

	it('refuses to ship what the traffic cannot decide in maxDays', async () => {
		await verified();
		await approve(deps(), 'exp-0001', 'me');
		traffic = { dailyVisits: 100, conversionRate: 0.1, days: 7 };
		const result = await ship(deps(), 'exp-0001');
		assert.equal(result.outcome, 'aborted');
		assert.match(result.reason, /more than the 14 allowed/);
		assert.deepEqual(log, []);
		assert.equal((await ledger.history()).at(-1)!.payload.reason, 'underpowered');
	});

	it('refuses to ship without traffic data', () => {
		assert.equal(planShip({ dailyVisits: 0, conversionRate: 0, days: 0 }, config).ok, false);
	});

	it('rolls back at once when a guardrail degrades', async () => {
		await verified();
		await approve(deps(), 'exp-0001', 'me');
		await ship(deps(), 'exp-0001');
		clock += 6 * 3_600_000;
		stats.guardrails.js_error_rate = { degraded: true, detail: 'variant 30%' };
		const result = await measure(deps());
		assert.equal(result.outcome, 'reverted');
		assert.deepEqual(log, ['ship exp-0001', 'rollback exp-0001']);
		assert.equal((await ledger.history()).at(-1)!.payload.reason, 'guardrail');
	});

	it('decides once a day, keeps a clear winner at the planned sample and promotes it', async () => {
		await verified();
		await approve(deps(), 'exp-0001', 'me');
		await ship(deps(), 'exp-0001');
		const required = requiredSamples(0.1, 0.2);
		clock += 12 * 3_600_000;
		assert.equal((await measure(deps())).outcome, 'continue');
		assert.equal((await ledger.history()).at(-1)!.type, 'shipped', 'no decision before day 1');
		clock += 12 * 3_600_000;
		// A clear win on less than the planned sample is not kept yet.
		stats.baseline = counts(2000, 200);
		stats.variant = counts(2000, 280);
		assert.equal((await measure(deps())).outcome, 'continue');
		clock += 6 * 3_600_000;
		assert.equal((await measure(deps())).outcome, 'continue');
		assert.equal((await ledger.history()).filter((e) => e.type === 'measured').length, 1, 'one decision per day');
		clock += 18 * 3_600_000;
		stats.baseline = counts(required, Math.round(required * 0.1));
		stats.variant = counts(required, Math.round(required * 0.13));
		assert.equal((await measure(deps())).outcome, 'kept');
		assert.deepEqual(promoted, ['exp-0001']);
		assert.deepEqual(log, ['ship exp-0001', 'promote exp-0001']);
	});

	it('does not keep a variant it cannot merge', async () => {
		await verified();
		await approve(deps(), 'exp-0001', 'me');
		await ship(deps(), 'exp-0001');
		clock += 86_400_000;
		stats.baseline = counts(10_000, 1000);
		stats.variant = counts(10_000, 1400);
		const result = await measure(deps({ promote: async () => Promise.reject(new StageError('promote-dirty', 'dirty')) }));
		assert.equal(result.outcome, 'aborted');
		assert.deepEqual(log, ['ship exp-0001', 'rollback exp-0001']);
	});

	it('reverts at maxDays when inconclusive', async () => {
		await verified();
		await approve(deps(), 'exp-0001', 'me');
		await ship(deps(), 'exp-0001');
		clock += 14 * 86_400_000;
		stats.baseline = counts(10_000, 1000);
		stats.variant = counts(10_000, 1010);
		const result = await measure(deps());
		assert.equal(result.outcome, 'reverted');
		assert.match(result.reason, /Inconclusive after 14 days/);
	});

	it('kills first, then records, even with a broken ledger', async () => {
		await verified();
		await approve(deps(), 'exp-0001', 'me');
		await ship(deps(), 'exp-0001');
		assert.deepEqual(await kill(deps()), { experiment: 'exp-0001' });
		assert.equal((await ledger.history()).at(-1)!.payload.reason, 'kill');
		writeFileSync(ledger.file, `${readFileSync(ledger.file, 'utf8')}not json\n`);
		const result = await kill(deps());
		assert.equal(result.experiment, null);
		assert.ok(result.ledgerError);
		assert.deepEqual(log.filter((l) => l === 'kill'), ['kill', 'kill']);
	});

	describe('auto mode', () => {
		const autoConfig = () => ({ ...config, autonomy: 'auto' as const });
		const noIterate = {
			proposer: { propose: async () => Promise.reject(new Error('should not propose')) },
			builder: { build: async () => Promise.reject(new Error('no')) },
			sandbox: { start: async () => Promise.reject(new Error('no')) },
			verifier: { verify: async () => Promise.reject(new Error('no')) },
		};
		async function finished(id: string, end: 'kept' | 'reverted' | 'kill' | 'guardrail', by = 'person') {
			const patch = PATCH.replace('+b', `+${id}`);
			await verified(id, patch);
			const base = { experiment: id, siteCommit: 'c', patchHash: sha256(patch) };
			await ledger.append({ ...base, type: 'approved', payload: { by } });
			await ledger.append({ ...base, type: 'shipped', payload: {} });
			if (end === 'kill' || end === 'guardrail') {
				await ledger.append({ ...base, type: 'reverted', payload: { reason: end } });
				return;
			}
			await ledger.append({ ...base, type: 'measured', payload: { day: 1 } });
			await ledger.append({ ...base, type: end, payload: end === 'reverted' ? { reason: 'decision' } : {} });
		}

		it('waits for a person until the entry criteria hold', async () => {
			await finished('exp-0001', 'kept');
			await finished('exp-0002', 'reverted');
			await verified('exp-0003', PATCH.replace('+b', '+z'));
			const result = await tick({ ...deps({ config: autoConfig() }), ...noIterate, evidenceDir: dir });
			assert.equal(result.step, 'wait');
			assert.match(result.step === 'wait' ? result.reason : '', /2 experiment\(s\) completed the full loop.*kill switch has not been used/s);
			assert.deepEqual(log, []);
		});

		it('approves and ships by itself once they hold', async () => {
			await finished('exp-0001', 'kept');
			await finished('exp-0002', 'reverted');
			await finished('exp-0003', 'kept');
			await finished('exp-0004', 'kill');
			await verified('exp-0005', PATCH.replace('+b', '+z'));
			const result = await tick({ ...deps({ config: autoConfig() }), ...noIterate, evidenceDir: dir });
			assert.equal(result.step, 'ship');
			assert.deepEqual(log, ['ship exp-0005']);
			assert.equal((await ledger.history()).find((e) => e.experiment === 'exp-0005' && e.type === 'approved')?.payload.by, 'auto');
		});

		it('stops after an escape, and does not count its own approvals', async () => {
			await finished('exp-0001', 'kept');
			await finished('exp-0002', 'kept', 'auto');
			await finished('exp-0003', 'kept');
			await finished('exp-0004', 'kill');
			await finished('exp-0006', 'guardrail');
			await verified('exp-0007', PATCH.replace('+b', '+z'));
			const result = await tick({ ...deps({ config: autoConfig() }), ...noIterate, evidenceDir: dir });
			assert.equal(result.step, 'wait');
			assert.match(result.step === 'wait' ? result.reason : '', /2 experiment\(s\).*Guardrails rolled back exp-0006/s);
		});
	});

	it('tick waits for approval in gated mode instead of shipping', async () => {
		await verified();
		const iterate = { proposer: { propose: async () => Promise.reject(new Error('should not propose')) } };
		const result = await tick({ ...deps(), ...iterate, builder: { build: async () => Promise.reject(new Error('no')) }, sandbox: { start: async () => Promise.reject(new Error('no')) }, verifier: { verify: async () => Promise.reject(new Error('no')) }, evidenceDir: dir });
		assert.equal(result.step, 'wait');
		assert.deepEqual(log, []);
	});
});

describe('gitPromote', () => {
	it('commits the patch in the site repository and refuses a dirty tree', () => {
		const repo = mkdtempSync(join(tmpdir(), 'lab-git-'));
		try {
			const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo }).toString();
			git('init', '-q');
			execFileSync('mkdir', ['-p', join(repo, 'site', 'src')]);
			writeFileSync(join(repo, 'site', 'src', 'a.html'), 'a\n');
			git('add', '-A');
			git('commit', '-qm', 'base');
			process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
			process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@example.invalid';
			gitPromote(join(repo, 'site'), { experiment: 'exp-0001', patch: PATCH });
			assert.equal(readFileSync(join(repo, 'site', 'src', 'a.html'), 'utf8'), 'b\n');
			assert.match(git('log', '-1', '--format=%s'), /lab: keep exp-0001/);
			// The lab's own uncommitted files do not block a promotion, and are not committed with it.
			execFileSync('mkdir', ['-p', join(repo, 'site', 'lab')]);
			writeFileSync(join(repo, 'site', 'lab', 'ledger.jsonl'), '{}\n');
			const before = git('rev-parse', 'HEAD');
			gitPromote(join(repo, 'site'), { experiment: 'exp-0003', patch: PATCH.replaceAll('-a', '-b').replaceAll('+b', '+c') });
			assert.notEqual(git('rev-parse', 'HEAD'), before);
			assert.match(git('status', '--porcelain'), /\?\? site\/lab\//);
			// A staged lab file stays staged and out of the promotion commit.
			git('add', 'site/lab/ledger.jsonl');
			gitPromote(join(repo, 'site'), { experiment: 'exp-0004', patch: PATCH.replaceAll('-a', '-c').replaceAll('+b', '+d') });
			assert.doesNotMatch(git('show', '--name-only', '--format=', 'HEAD'), /ledger/);
			assert.match(git('status', '--porcelain'), /^A {2}site\/lab\/ledger\.jsonl/m);
			writeFileSync(join(repo, 'site', 'src', 'a.html'), 'dirty\n');
			assert.throws(() => gitPromote(join(repo, 'site'), { experiment: 'exp-0002', patch: PATCH }), (e: unknown) => e instanceof StageError && e.code === 'promote-dirty');
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
