import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadInvariants } from '@lab/verify';
import type { InvariantKind } from '@lab/verify';

const root = mkdtempSync(join(tmpdir(), 'lab-invariants-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dirWith = (files: Record<string, string>) => {
	const dir = join(root, String(n++));
	mkdirSync(dir);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
};

describe('loadInvariants', () => {
	it('loads { id, description, run } modules, sorted by file name', async () => {
		const dir = dirWith({
			'b.mjs': "export default { id: 'b', description: 'B', run: async () => {} };",
			'a.mjs': "export default { id: 'a', description: 'A', run: async () => {} };",
		});
		assert.deepEqual((await loadInvariants(dir)).map((i) => i.id), ['a', 'b']);
	});

	it('lets a kind turn other exports into invariants, and leaves the rest alone', async () => {
		const dir = dirWith({
			'plain.mjs': "export default { id: 'plain', description: 'Plain', run: async () => {} };",
			'declared.mjs': "export default { id: 'declared', description: 'Declared', custom: true };",
		});
		const seen: string[] = [];
		const kind: InvariantKind = (value, file) => {
			seen.push(file);
			const v = value as { id: string; description: string; custom?: boolean };
			return v.custom ? { id: v.id, description: v.description, run: async () => {} } : null;
		};
		assert.deepEqual((await loadInvariants(dir, [kind])).map((i) => i.id), ['declared', 'plain']);
		assert.deepEqual(seen, [join(dir, 'declared.mjs'), join(dir, 'plain.mjs')]);
	});

	it('refuses an Assay invariant when the Assay kind was not given, and says how to give it', async () => {
		const dir = dirWith({ 'signup.mjs': "export default { id: 'signup', description: 'S', assay: {} };" });
		await assert.rejects(loadInvariants(dir), (e: Error & { code?: string }) => e.code === 'invariant-invalid' && /invariantKinds/.test(e.message));
	});

	it('refuses modules without a valid id or run, and duplicate ids', async () => {
		await assert.rejects(loadInvariants(dirWith({ 'x.mjs': "export default { id: 'Bad Id', description: 'x', run: async () => {} };" })), { code: 'invariant-invalid' });
		await assert.rejects(loadInvariants(dirWith({ 'x.mjs': "export default { id: 'x', description: 'x' };" })), { code: 'invariant-invalid' });
		await assert.rejects(
			loadInvariants(dirWith({ 'x.mjs': "export default { id: 'x', description: 'x', run: async () => {} };", 'y.mjs': "export default { id: 'x', description: 'y', run: async () => {} };" })),
			{ code: 'invariant-duplicate' },
		);
	});
});
