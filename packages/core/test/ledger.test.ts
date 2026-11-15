import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FileLedger, LedgerError, checkLedger, sha256 } from '../src/index.ts';
import type { LedgerEventInput, LedgerEventType } from '../src/index.ts';

const PATCH = sha256('diff --git a/x b/x');

function input(type: LedgerEventType, experiment = 'exp-0001', payload: Record<string, unknown> = {}): LedgerEventInput {
	const defaults: Partial<Record<LedgerEventType, Record<string, unknown>>> = {
		proposed: { source: 'agent', spec: { id: experiment } },
		verify_failed: { failures: [{ gate: 'budgets', check: 'budgets.axe', message: '1 new violation', evidence: { screenshot: 'a.png' } }] },
	};
	return {
		type,
		experiment,
		siteCommit: 'abc1234',
		patchHash: type === 'proposed' ? null : PATCH,
		payload: { ...defaults[type], ...payload },
	} as LedgerEventInput;
}

describe('FileLedger', () => {
	let dir: string;
	let file: string;
	let clock: number;
	const ledger = () => new FileLedger(file, { now: () => new Date(Date.UTC(2026, 10, 14, 12, 0, clock++)) });

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'lab-ledger-'));
		file = join(dir, 'lab', 'ledger.jsonl');
		clock = 0;
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it('starts empty when the file does not exist', async () => {
		assert.deepEqual(await ledger().history(), []);
	});

	it('round-trips every event type through the file', async () => {
		const l = ledger();
		const full: LedgerEventType[] = ['proposed', 'built', 'verify_passed', 'approved', 'shipped', 'measured', 'measured', 'kept'];
		const written = [];
		for (const type of full) written.push(await l.append(input(type)));
		for (const type of ['proposed', 'built', 'verify_failed'] as const) written.push(await l.append(input(type, 'exp-0002')));
		for (const type of ['proposed', 'built', 'verify_passed', 'approved', 'shipped', 'reverted'] as const) written.push(await l.append(input(type, 'exp-0003')));
		written.push(await l.append(input('proposed', 'exp-0004')), await l.append(input('aborted', 'exp-0004')));

		const read = await ledger().history();
		assert.deepEqual(read, written);
		assert.deepEqual(new Set(read.map((e) => e.type)), new Set(['proposed', 'built', 'verify_passed', 'verify_failed', 'approved', 'shipped', 'measured', 'kept', 'reverted', 'aborted']));
		assert.deepEqual(read.map((e) => e.seq), read.map((_, i) => i));
		assert.equal(read[0]?.prev, null);
		for (let i = 1; i < read.length; i++) assert.equal(read[i]?.prev, read[i - 1]?.hash);
		assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, read.length);
	});

	it('stores verification failures with the failing check and its evidence', async () => {
		const l = ledger();
		await l.append(input('proposed'));
		await l.append(input('built'));
		const event = await l.append(input('verify_failed'));
		assert.deepEqual(event.payload.failures, [{ gate: 'budgets', check: 'budgets.axe', message: '1 new violation', evidence: { screenshot: 'a.png' } }]);
	});

	it('refuses events that break an experiment lifecycle', async () => {
		const l = ledger();
		await assert.rejects(l.append(input('shipped')), (e: unknown) => e instanceof LedgerError && e.diagnostics[0]?.code === 'ledger-invalid-transition');
		await l.append(input('proposed'));
		await l.append(input('built'));
		await l.append(input('verify_failed'));
		// A rejected variant can never be shipped.
		await assert.rejects(l.append(input('shipped')), /ledger-invalid-transition/);
		await assert.rejects(l.append(input('approved')), /ledger-invalid-transition/);
		assert.equal((await l.history()).length, 3);
	});

	it('refuses to ship without approval, or to keep without measuring', async () => {
		const l = ledger();
		for (const type of ['proposed', 'built', 'verify_passed'] as const) await l.append(input(type));
		await assert.rejects(l.append(input('shipped')), /ledger-invalid-transition/);
		await l.append(input('approved'));
		await l.append(input('shipped'));
		await assert.rejects(l.append(input('kept')), /ledger-invalid-transition/);
	});

	it('refuses malformed events', async () => {
		const l = ledger();
		await assert.rejects(l.append({ ...input('proposed'), payload: {} } as LedgerEventInput), /payload.source/);
		await assert.rejects(l.append({ ...input('proposed'), experiment: 'Exp 1' }), /ledger-invalid-event/);
		await l.append(input('proposed'));
		await assert.rejects(l.append({ ...input('built'), patchHash: null }), /needs `patchHash`/);
		await l.append(input('built'));
		await assert.rejects(l.append({ ...input('verify_failed'), payload: { failures: [] } } as LedgerEventInput), /payload.failures/);
	});

	it('detects an edited event', async () => {
		const l = ledger();
		await l.append(input('proposed'));
		await l.append(input('built'));
		const lines = readFileSync(file, 'utf8').split('\n');
		lines[0] = lines[0]!.replace('"exp-0001"', '"exp-0009"');
		writeFileSync(file, lines.join('\n'));
		const { diagnostics } = await ledger().read();
		assert.ok(diagnostics.some((d) => d.code === 'ledger-hash-mismatch' && d.path === 'ledger:1'));
		await assert.rejects(ledger().append(input('verify_passed')), LedgerError);
	});

	it('detects a deleted event', async () => {
		const l = ledger();
		for (const type of ['proposed', 'built', 'verify_passed'] as const) await l.append(input(type));
		const lines = readFileSync(file, 'utf8').trim().split('\n');
		writeFileSync(file, `${[lines[0], lines[2]].join('\n')}\n`);
		const codes = new Set((await ledger().read()).diagnostics.map((d) => d.code));
		assert.ok(codes.has('ledger-seq-gap'));
		assert.ok(codes.has('ledger-chain-broken'));
	});

	it('reports a line that is not JSON', async () => {
		await ledger().append(input('proposed'));
		writeFileSync(file, `${readFileSync(file, 'utf8')}{oops\n`);
		assert.deepEqual((await ledger().read()).diagnostics.map((d) => d.code), ['ledger-invalid-json']);
	});

	it('hashes do not depend on key order', async () => {
		const a = await ledger().append(input('proposed', 'exp-0001', { spec: { b: 1, a: 2 } }));
		assert.deepEqual(checkLedger([JSON.parse(JSON.stringify({ ...a, payload: { spec: { a: 2, b: 1 }, source: 'agent' } }))]), []);
	});
});
