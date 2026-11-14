import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StageError, hashPatch, validateConfig } from '@lab/core';
import type { LabConfig } from '@lab/core';
import { LocalSandbox, serveDir } from '../src/index.ts';

const BUILD = `node -e "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html',fs.readFileSync('page.html'));fs.writeFileSync('dist/env.json',JSON.stringify(process.env))"`;

const configFor = (build = BUILD): LabConfig =>
	validateConfig({
		site: { repo: '.', build, outDir: 'dist' },
		metric: { id: 'm', kind: 'conversion' },
		allow: ['page.html'],
		deny: [],
		budgets: { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 },
		traffic: { share: 0.1, minSamplesPerBucket: 1000, maxDays: 14 },
	}).config!;

const PATCH = 'diff --git a/page.html b/page.html\nindex 1..2 100644\n--- a/page.html\n+++ b/page.html\n@@ -1 +1 @@\n-<h1>Base</h1>\n+<h1>Variant</h1>\n';

describe('LocalSandbox', () => {
	let site: string;
	let scratch: string;
	beforeEach(() => {
		site = mkdtempSync(join(tmpdir(), 'lab-site-'));
		scratch = mkdtempSync(join(tmpdir(), 'lab-scratch-'));
		writeFileSync(join(site, 'page.html'), '<h1>Base</h1>\n');
	});
	afterEach(() => {
		rmSync(site, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	});

	it('builds and serves the baseline', async () => {
		const running = await new LocalSandbox({ config: configFor(), scratch }).start({ dir: site, commit: 'c' });
		try {
			assert.equal(await (await fetch(running.url)).text(), '<h1>Base</h1>\n');
			assert.ok(running.root && existsSync(join(running.root, 'index.html')));
		} finally {
			await running.stop();
		}
		assert.ok(!existsSync(running.root!), 'stop() removes the scratch copy');
	});

	it('applies a variant patch to a copy and never writes to the site', async () => {
		const sandbox = new LocalSandbox({ config: configFor(), scratch });
		const running = await sandbox.start({ experiment: 'exp-1', base: { dir: site, commit: 'c' }, patch: PATCH, patchHash: hashPatch(PATCH) });
		try {
			assert.equal(await (await fetch(running.url)).text(), '<h1>Variant</h1>\n');
		} finally {
			await running.stop();
		}
		assert.equal(readFileSync(join(site, 'page.html'), 'utf8'), '<h1>Base</h1>\n');
		assert.ok(!existsSync(join(site, 'dist')));
	});

	it('gives the build no secrets from the environment', async () => {
		process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
		process.env.DEPLOY_TOKEN = 'secret';
		try {
			const running = await new LocalSandbox({ config: configFor(), scratch }).start({ dir: site, commit: 'c' });
			try {
				const env = JSON.parse(readFileSync(join(running.root!, 'env.json'), 'utf8')) as Record<string, string>;
				assert.equal(env.ANTHROPIC_API_KEY, undefined);
				assert.equal(env.DEPLOY_TOKEN, undefined);
				assert.equal(env.CI, '1');
			} finally {
				await running.stop();
			}
		} finally {
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.DEPLOY_TOKEN;
		}
	});

	it('names a patch that does not apply', async () => {
		const bad = PATCH.replace('<h1>Base</h1>', '<h1>Other</h1>');
		await assert.rejects(
			new LocalSandbox({ config: configFor(), scratch }).start({ experiment: 'exp-1', base: { dir: site, commit: 'c' }, patch: bad, patchHash: hashPatch(bad) }),
			(e: unknown) => e instanceof StageError && e.code === 'sandbox-patch-failed',
		);
	});

	it('names a failing build and keeps its log', async () => {
		await assert.rejects(
			new LocalSandbox({ config: configFor('echo broken >&2; exit 3'), scratch }).start({ dir: site, commit: 'c' }),
			(e: unknown) => e instanceof StageError && e.code === 'sandbox-build-failed' && (e.detail ?? '').includes('broken'),
		);
	});

	it('kills a build that runs too long', async () => {
		await assert.rejects(
			new LocalSandbox({ config: configFor('sleep 30'), scratch, timeoutMs: 300 }).start({ dir: site, commit: 'c' }),
			(e: unknown) => e instanceof StageError && /timed out/.test(e.message),
		);
	});
});

describe('serveDir', () => {
	it('serves nothing outside the directory', async () => {
		const root = mkdtempSync(join(tmpdir(), 'lab-serve-'));
		try {
			mkdirSync(join(root, 'site'));
			writeFileSync(join(root, 'site', 'index.html'), 'ok');
			writeFileSync(join(root, 'secret.txt'), 'secret');
			symlinkSync(join(root, 'secret.txt'), join(root, 'site', 'link.txt'));
			const server = await serveDir(join(root, 'site'));
			try {
				assert.equal(await (await fetch(server.url)).text(), 'ok');
				assert.equal((await fetch(`${server.url}%2e%2e/secret.txt`)).status, 404);
				assert.equal((await fetch(`${server.url}link.txt`)).status, 403);
				assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
			} finally {
				await server.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
