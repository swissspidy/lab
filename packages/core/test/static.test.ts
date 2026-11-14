import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatic } from '../src/index.ts';

describe('resolveStatic', () => {
	it('resolves files, extensionless pages and directory indexes, and nothing outside the root', () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-static-'));
		try {
			const root = join(dir, 'out');
			mkdirSync(join(root, 'docs'), { recursive: true });
			mkdirSync(join(root, 'blog'), { recursive: true });
			writeFileSync(join(root, 'index.html'), 'home');
			writeFileSync(join(root, 'docs.html'), 'docs');
			writeFileSync(join(root, 'docs', '__next.docs.txt'), 'rsc');
			writeFileSync(join(root, 'blog', 'index.html'), 'blog');
			writeFileSync(join(dir, 'secret.txt'), 'secret');
			symlinkSync(join(dir, 'secret.txt'), join(root, 'link.txt'));
			writeFileSync(join(dir, 'out.html'), 'a sibling of the root');
			const canonical = realpathSync(root);
			const rel = (p: string) => {
				const r = resolveStatic(root, p);
				return typeof r === 'string' && r !== 'forbidden' ? r.slice(canonical.length) : r;
			};
			assert.equal(rel('/'), '/index.html');
			assert.equal(rel('/docs'), '/docs.html');
			assert.equal(rel('/docs/__next.docs.txt'), '/docs/__next.docs.txt');
			assert.equal(rel('/blog'), '/blog/index.html');
			assert.equal(rel('/blog/'), '/blog/index.html');
			assert.equal(rel('/missing'), null);
			assert.equal(rel('/link.txt'), 'forbidden');
			assert.equal(rel('/../secret.txt'), 'forbidden');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
