import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assayInvariant, checkInvariantLock, isAssayInvariant } from '@lab/adapters';
import type { AssayInvariant, AssayInvariantSpec } from '@lab/adapters';

const invariants = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'site', 'lab', 'invariants');
const committed = readFileSync(join(invariants, 'signup-submits.checks.json'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'lab-assay-unit-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const spec = (assay: Partial<AssayInvariantSpec['assay']> = {}): AssayInvariantSpec => ({
	id: 'signup-submits',
	description: 'test',
	assay: { task: { instruction: 'Do it.', outcomes: '- The page shows "Done."' }, checks: 'signup-submits.checks.json', act: async () => {}, negatives: { none: async () => {} }, ...assay },
});
const make = (s: AssayInvariantSpec, where = dir): AssayInvariant => assayInvariant(s, join(where, 'signup-submits.ts'))!;

describe('assayInvariant', () => {
	it('leaves other invariant modules to the loader', () => {
		assert.equal(assayInvariant({ id: 'x', description: 'x', run: async () => {} }, join(dir, 'x.ts')), null);
		assert.equal(assayInvariant(undefined, join(dir, 'x.ts')), null);
	});

	it('resolves the check set next to the module', () => {
		const inv = make(spec(), invariants);
		assert.ok(isAssayInvariant(inv));
		assert.equal(inv.assay.checksFile, join(invariants, 'signup-submits.checks.json'));
		assert.equal(isAssayInvariant({ id: 'x', description: 'x', run: async () => {} }), false);
	});

	it('rejects malformed specs, specs with no negative run, and check paths outside the module directory', () => {
		assert.throws(() => make(spec({ negatives: {} })), { code: 'invariant-negatives-required' });
		assert.throws(() => make(spec({ act: 'click' as never })), { code: 'invariant-invalid' });
		assert.throws(() => make(spec({ negatives: { bad: 1 as never } })), { code: 'invariant-invalid' });
		assert.throws(() => make({ ...spec(), assay: null as never }), { code: 'invariant-invalid' });
		for (const checks of ['../ledger.json', '/etc/x.json', 'sub/x.json', 'x.ts']) assert.throws(() => make(spec({ checks })), { code: 'invariant-invalid' }, checks);
	});

	it('accepts the committed, locked check set', () => {
		assert.equal(checkInvariantLock(make(spec(), invariants)), null);
	});

	it('rejects a missing, malformed, unlocked or edited check set', () => {
		const set = JSON.parse(committed);
		const { locked: _, ...unlocked } = set;
		const edited = structuredClone(set);
		edited.checks[0].assert.match.text.contains = 'Thanks';
		const cases: Array<[string, string | null, string]> = [
			['missing.json', null, 'invariant-checks-missing'],
			['malformed.json', '{', 'invariant-checks-invalid'],
			['not-a-set.json', '{"schema":"nope"}', 'invariant-checks-invalid'],
			['unlocked.json', JSON.stringify(unlocked), 'invariant-lock-broken'],
			['edited.json', JSON.stringify(edited), 'invariant-lock-broken'],
		];
		for (const [name, content, code] of cases) {
			if (content !== null) writeFileSync(join(dir, name), content);
			assert.equal(checkInvariantLock(make(spec({ checks: name })))?.code, code, name);
		}
	});

	it('fails its run on a check set it cannot trust, before touching the page', async () => {
		const inv = make(spec({ checks: 'missing.json' }));
		await assert.rejects(inv.run({ page: null as never, url: '', viewport: { width: 1, height: 1 }, ok: () => {} }), { code: 'invariant-checks-missing' });
	});
});
