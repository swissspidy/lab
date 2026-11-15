import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FileLedger } from '@lab/core';
import type { LedgerEventInput } from '@lab/core';

const run = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'index.ts');
const fixture = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'site');

async function lab(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await run(process.execPath, [cli, ...args]);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const e = error as { code: number; stdout: string; stderr: string };
		return { code: e.code, stdout: e.stdout, stderr: e.stderr };
	}
}

function copyFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'lab-doctor-'));
	cpSync(fixture, dir, { recursive: true, filter: (src) => !src.includes('/dist') });
	return dir;
}

describe('lab doctor', () => {
	it('passes on the fixture site', async () => {
		const { code, stdout } = await lab('doctor', fixture);
		assert.equal(code, 0, stdout);
		assert.match(stdout, /^ok: .*lab\.config\.ts is valid; ledger has 0 event\(s\)\.$/m);
	});

	it('fails with a diagnostic code on an invalid config', async () => {
		const dir = copyFixture();
		try {
			const config = join(dir, 'lab.config.ts');
			writeFileSync(config, readFileSync(config, 'utf8').replace('share: 0.1', 'share: 0.9'));
			const { code, stdout } = await lab('doctor', dir);
			assert.equal(code, 1);
			assert.match(stdout, /error config-traffic-share \(traffic\.share\)/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('fails when the config cannot be loaded', async () => {
		const dir = copyFixture();
		try {
			writeFileSync(join(dir, 'lab.config.ts'), 'export default {');
			const { code, stdout } = await lab('doctor', dir, '--json');
			assert.equal(code, 1);
			assert.deepEqual(JSON.parse(stdout).diagnostics.map((d: { code: string }) => d.code), ['config-load-failed']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('checks the ledger and flags an edited one', async () => {
		const dir = copyFixture();
		try {
			const file = join(dir, 'lab', 'ledger.jsonl');
			const ledger = new FileLedger(file);
			await ledger.append({ type: 'proposed', experiment: 'exp-0001', siteCommit: 'abc', patchHash: null, payload: { source: 'agent' } } as LedgerEventInput);
			let result = await lab('doctor', dir, '--json');
			assert.equal(result.code, 0);
			assert.deepEqual(JSON.parse(result.stdout).diagnostics.map((d: { code: string }) => d.code), ['ledger-experiment-open']);

			writeFileSync(file, readFileSync(file, 'utf8').replace('"abc"', '"def"'));
			result = await lab('doctor', dir);
			assert.equal(result.code, 1);
			assert.match(result.stdout, /ledger-hash-mismatch/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('exits 64 on usage errors', async () => {
		assert.equal((await lab()).code, 64);
		assert.equal((await lab('fly')).code, 64);
		assert.equal((await lab('--help')).code, 0);
	});
});
