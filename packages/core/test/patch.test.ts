import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkPatch, globToRegExp, matchesAny, parsePatch, validateConfig } from '../src/index.ts';

const config = validateConfig({
	site: { repo: '.', build: 'npm run build', outDir: 'dist' },
	metric: { id: 'next_step_click', kind: 'conversion' },
	allow: ['src/pages/**', 'src/components/**', 'src/styles/**', 'lab/**'],
	deny: ['**/legal/**', '**/*analytics*'],
	budgets: { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 },
	traffic: { share: 0.1, minSamplesPerBucket: 1000, maxDays: 14 },
	limits: { maxChangedLines: 10, maxFiles: 2 },
}).config!;

const diff = (path: string, body = '@@ -1 +1 @@\n-a\n+b\n', header = '') =>
	`diff --git a/${path} b/${path}\n${header}index 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}`;
const failing = (patch: string) => checkPatch(patch, config).filter((r) => !r.passed).map((r) => r.check);

describe('globToRegExp', () => {
	it('matches like a glob', () => {
		assert.ok(globToRegExp('src/**').test('src/a/b.css'));
		assert.ok(globToRegExp('src/**').test('src/a.css'));
		assert.ok(globToRegExp('**/legal/**').test('legal/terms.html'));
		assert.ok(globToRegExp('**/legal/**').test('src/pages/legal/terms.html'));
		assert.ok(globToRegExp('**/*analytics*').test('src/js/analytics.js'));
		assert.ok(!globToRegExp('src/*.css').test('src/a/b.css'));
		assert.ok(globToRegExp('src/?.css').test('src/a.css'));
		assert.ok(globToRegExp('lab/invariants/').test('lab/invariants/x.ts'));
		assert.ok(!globToRegExp('src/a.b').test('src/aXb'));
		assert.ok(!matchesAny('srcx/a.css', ['src/**']));
	});
});

describe('parsePatch', () => {
	it('counts lines and reads paths', () => {
		const { files, problems } = parsePatch(diff('src/pages/a.html', '@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n'));
		assert.deepEqual(problems, []);
		assert.deepEqual(files, [{ from: 'src/pages/a.html', to: 'src/pages/a.html', added: 2, removed: 1, binary: false, specialMode: null }]);
	});

	it('reads new, deleted and renamed files', () => {
		const patch = [
			'diff --git a/src/pages/new.html b/src/pages/new.html\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/src/pages/new.html\n@@ -0,0 +1 @@\n+x\n',
			'diff --git a/src/pages/old.html b/src/pages/old.html\ndeleted file mode 100644\nindex 1..0\n--- a/src/pages/old.html\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n',
			'diff --git a/src/pages/a.html b/legal/a.html\nsimilarity index 100%\nrename from src/pages/a.html\nrename to legal/a.html\n',
		].join('');
		const { files } = parsePatch(patch);
		assert.deepEqual(files.map((f) => [f.from, f.to]), [[null, 'src/pages/new.html'], ['src/pages/old.html', null], ['src/pages/a.html', 'legal/a.html']]);
	});

	it('treats an empty or foreign patch as a problem', () => {
		assert.deepEqual(parsePatch('').problems, ['The patch is empty.']);
		assert.equal(parsePatch('--- a/x\n+++ b/x\n').problems.length, 1);
	});
});

describe('checkPatch', () => {
	it('passes an allowed, small, plain patch', () => {
		assert.deepEqual(failing(diff('src/styles/site.css')), []);
	});

	it('rejects paths outside allow, and denied paths inside it', () => {
		assert.deepEqual(failing(diff('src/scripts/site.js')), ['static.scope']);
		assert.deepEqual(failing(diff('src/pages/legal/terms.html')), ['static.scope']);
		assert.deepEqual(failing(diff('src/components/analytics.html')), ['static.scope']);
	});

	it('always denies the lab directory and manifests, even when allow lists them', () => {
		assert.deepEqual(failing(diff('lab/invariants/pricing.ts')), ['static.scope']);
		assert.deepEqual(failing(diff('src/pages/package.json')), ['static.scope']);
	});

	it('checks both sides of a rename', () => {
		assert.deepEqual(failing('diff --git a/src/pages/a.html b/lab/a.html\nsimilarity index 100%\nrename from src/pages/a.html\nrename to lab/a.html\n'), ['static.scope']);
	});

	it('caps changed lines and files', () => {
		const body = `@@ -1,0 +1,11 @@\n${'+x\n'.repeat(11)}`;
		assert.deepEqual(failing(diff('src/styles/a.css', body)), ['static.patch-size']);
		const three = ['a', 'b', 'c'].map((n) => diff(`src/styles/${n}.css`)).join('');
		assert.deepEqual(failing(three), ['static.patch-size']);
	});

	it('rejects binary changes, symlinks and unsafe paths', () => {
		assert.deepEqual(failing('diff --git a/src/styles/a.png b/src/styles/a.png\nindex 1..2 100644\nGIT binary patch\nliteral 1\n'), ['static.patch-format']);
		assert.deepEqual(failing('diff --git a/src/styles/l.css b/src/styles/l.css\nnew file mode 120000\nindex 0..1\n--- /dev/null\n+++ b/src/styles/l.css\n@@ -0,0 +1 @@\n+../../package.json\n'), ['static.patch-format']);
		assert.ok(failing(diff('src/../package.json')).includes('static.patch-format'));
	});

	it('rejects an empty patch', () => {
		assert.deepEqual(failing(''), ['static.patch-format', 'static.scope']);
	});
});
