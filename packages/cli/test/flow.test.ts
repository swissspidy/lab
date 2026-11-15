import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FileLedger } from '@lab/core';
import { MetricStore, readState, startCollector, writeState } from '@lab/deploy';

const cli = join(import.meta.dirname, '..', 'src', 'index.ts');
const fixtures = join(import.meta.dirname, '..', '..', '..', 'fixtures');

async function lab(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return labWith({}, ...args);
}

async function labWith(env: Record<string, string>, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		// Never inherit a real collector from the environment running the tests.
		const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, LAB_URL: '', LAB_TOKEN: '', ...env } });
		return { code: 0, stdout, stderr };
	} catch (error) {
		const e = error as { code: number; stdout: string; stderr: string };
		return { code: e.code, stdout: e.stdout, stderr: e.stderr };
	}
}

describe('lab run, approve, status, kill', () => {
	it('verifies, waits for approval, and refuses to ship without traffic data', { timeout: 120_000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-flow-'));
		try {
			cpSync(join(fixtures, 'site'), dir, { recursive: true, filter: (src) => !src.includes('/dist') && !src.includes('/.lab') });
			const good = join(fixtures, 'good', 'nav-docs');

			let r = await lab('run', dir, '--experiment', good);
			assert.equal(r.code, 0, r.stdout + r.stderr);
			assert.match(r.stdout, /good-nav-docs: verify_passed/);

			r = await lab('status', dir);
			assert.match(r.stdout, /good-nav-docs: verified, waiting for approval/);
			r = await lab('run', dir, '--experiment', good);
			assert.match(r.stdout, /waiting for approval/);

			r = await lab('approve', 'good-nav-docs', dir, '--by', 'tester');
			assert.equal(r.code, 0, r.stderr);
			r = await lab('approve', 'good-nav-docs', dir);
			assert.equal(r.code, 3);
			assert.match(r.stderr, /approve-invalid-state/);

			r = await lab('publish', dir);
			assert.equal(r.code, 0, r.stderr);
			r = await lab('run', dir);
			assert.equal(r.code, 2, r.stdout);
			assert.match(r.stdout, /good-nav-docs: aborted\n {2}No traffic data yet/);
			const types = (await new FileLedger(join(dir, 'lab', 'ledger.jsonl')).history()).map((e) => e.type);
			assert.deepEqual(types, ['proposed', 'built', 'verify_passed', 'approved', 'aborted']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('status and kill use a remote collector with LAB_URL and LAB_TOKEN', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-remote-'));
		const host = mkdtempSync(join(tmpdir(), 'lab-remote-host-'));
		const collector = await startCollector({ root: host, store: new MetricStore({ intervalHours: 24 }), token: 'tok' });
		try {
			cpSync(join(fixtures, 'site'), dir, { recursive: true, filter: (src) => !src.includes('/dist') && !src.includes('/.lab') });
			writeState(host, { live: { experiment: 'exp-0009', share: 0.1, origin: 'https://v.example' } });
			const env = { LAB_URL: collector.url, LAB_TOKEN: 'tok' };
			let r = await labWith(env, 'status', dir);
			assert.match(r.stdout, /Serving: exp-0009 to 10%/);
			r = await labWith(env, 'kill', dir);
			assert.equal(r.code, 0, r.stderr);
			assert.equal(readState(host).live, null);
			assert.ok(readState(host).killedAt);
			// LAB_URL without LAB_TOKEN is refused, never a silent local kill.
			r = await labWith({ LAB_URL: collector.url }, 'kill', dir);
			assert.equal(r.code, 3);
			assert.match(r.stderr, /LAB_TOKEN is not/);
			// A wrong token cannot change the state.
			writeState(host, { live: { experiment: 'exp-0009', share: 0.1, origin: 'https://v.example' } });
			r = await labWith({ LAB_URL: collector.url, LAB_TOKEN: 'wrong' }, 'kill', dir);
			assert.notEqual(readState(host).live, null);
		} finally {
			await collector.close();
			rmSync(dir, { recursive: true, force: true });
			rmSync(host, { recursive: true, force: true });
		}
	});

	it('kill works even when the config is broken', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-kill-'));
		try {
			writeFileSync(join(dir, 'lab.config.ts'), 'export default {');
			const r = await lab('kill', dir);
			assert.equal(r.code, 0, r.stderr);
			const state = JSON.parse(readFileSync(join(dir, '.lab', 'host', 'state.json'), 'utf8'));
			assert.equal(state.live, null);
			assert.ok(state.killedAt);
			assert.ok(existsSync(join(dir, '.lab', 'host')));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
