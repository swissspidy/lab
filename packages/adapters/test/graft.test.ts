import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSurface } from '@swissspidy/graft-core';
import { pageSlot, validateConfig, websiteHost } from '@lab/core';
import type { ExperimentSpec, Observation } from '@lab/core';
import { GraftSpecCheck, GraftSpecProposer, fromGraftMarkdown, graftSurface, recordingGraftSpecs, toGraftMarkdown } from '../src/index.ts';

const fixtures = join(import.meta.dirname, '..', '..', '..', 'fixtures');
const spec = JSON.parse(readFileSync(join(fixtures, 'good', 'install-in-hero', 'spec.json'), 'utf8')) as ExperimentSpec;

describe('Graft spec adapter', () => {
	it('round-trips a spec through Graft Markdown and Graft’s parser', () => {
		const md = toGraftMarkdown(spec);
		assert.match(md, /^---\ngraft: 1\nid: "good-install-in-hero"\nhost: website\nmount: \{"slot":"page.index"\}\npermissions: \["markup:write"\]\n---\n/);
		assert.doesNotMatch(md, /^lab:/m, 'the frontmatter is plain Graft: no extra keys');
		assert.match(md, /## Acceptance criteria\n\n- The install command is visible without scrolling at 1280x800 and 390x844\. \{#c0\}/);
		const { spec: back, diagnostics } = fromGraftMarkdown(md);
		assert.deepEqual(diagnostics, []);
		assert.deepEqual(back, spec);
	});

	it('keeps literal {#…} text and numeric-looking ids as they are', () => {
		const odd = { ...spec, id: '123', acceptance: ['Keep {#install} as typed.', 'Second.'], checks: [] };
		const { spec: back, diagnostics } = fromGraftMarkdown(toGraftMarkdown(odd));
		assert.deepEqual(diagnostics, []);
		assert.equal(back?.id, '123');
		assert.deepEqual(back?.acceptance, odd.acceptance);
	});

	it('reports what is missing instead of throwing', () => {
		const codes = new Set(fromGraftMarkdown('# Title only\n').diagnostics.map((d) => d.code));
		assert.ok(codes.has('graft-frontmatter-missing') || codes.has('graft-frontmatter-schema'), [...codes].join(', '));
		const noChecks = toGraftMarkdown(spec).replace(/## Checks[\s\S]*$/, '');
		assert.deepEqual(fromGraftMarkdown(noChecks).diagnostics.map((d) => d.code), ['graft-spec-section', 'graft-spec-checks']);
		const badJson = toGraftMarkdown(spec).replace('```json\n[', '```json\n[,');
		assert.deepEqual(fromGraftMarkdown(badJson).diagnostics.map((d) => d.code), ['graft-spec-checks']);
	});

	it('replays spec.md and records proposals as Graft specs', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-graft-'));
		try {
			writeFileSync(join(dir, 'spec.md'), toGraftMarkdown(spec));
			const proposer = recordingGraftSpecs(new GraftSpecProposer(dir), join(dir, 'specs'));
			const proposed = await proposer.propose({} as Observation);
			assert.deepEqual(proposed, spec);
			assert.equal(readFileSync(join(dir, 'specs', 'good-install-in-hero.md'), 'utf8'), toGraftMarkdown(spec));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('rejects frontmatter Graft does not accept, and specs for another host', () => {
		const extra = toGraftMarkdown(spec).replace('host: website\n', 'host: website\nlab: {}\n');
		assert.ok(fromGraftMarkdown(extra).diagnostics.some((d) => d.code === 'graft-frontmatter-schema'));
		const noPermissions = toGraftMarkdown(spec).replace(/permissions: .*\n/, '');
		assert.ok(fromGraftMarkdown(noPermissions).diagnostics.some((d) => d.code === 'graft-frontmatter-schema'));
		const wordpress = toGraftMarkdown(spec).replace('host: website', 'host: wordpress');
		assert.deepEqual(fromGraftMarkdown(wordpress).diagnostics.map((d) => d.code), ['graft-spec-host']);
	});
});

describe('The website as a Graft surface', () => {
	const config = validateConfig({
		site: { repo: '.', build: 'npm run build', outDir: 'dist' },
		metric: { id: 'next_step_click', kind: 'conversion' },
		allow: ['src/**'],
		deny: ['src/legal/**'],
		budgets: { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 },
		traffic: { share: 0.1, minSamplesPerBucket: 1000, maxDays: 14 },
	}).config!;
	const files = ['src/pages/index.html', 'src/pages/docs.html', 'src/legal/terms.css', 'package.json', 'scripts/build.js', 'src/logo.png'];
	const host = websiteHost(config, files, ['index.html', 'docs.html', 'docs/intro.html']);

	it('has a slot for the site and each page, and scopes only for files the config lets variants change', async () => {
		assert.deepEqual(Object.keys(host.slots).toSorted(), ['page.docs', 'page.docs.intro', 'page.index', 'site']);
		// The CSS file is denied, the script and package.json are outside allow, the PNG has no scope.
		assert.deepEqual(host.scopes, { 'markup:write': { files: 2 } });
		const validation = await validateSurface(graftSurface(host));
		assert.deepEqual(validation.diagnostics, []);
		assert.ok(validation.ok);
	});

	it('Graft accepts a spec that fits the site', () => {
		assert.deepEqual(new GraftSpecCheck().check(spec, host), []);
		assert.deepEqual(new GraftSpecCheck().check({ ...spec, mount: 'site' }, host), []);
	});

	it('Graft rejects a mount on a page the site does not have', () => {
		assert.deepEqual(new GraftSpecCheck().check({ ...spec, mount: 'page.blog' }, host).map((d) => d.code), ['graft-mount-unknown-slot']);
	});

	it('Graft rejects a permission for files the site does not let variants change', () => {
		const codes = new GraftSpecCheck().check({ ...spec, permissions: ['markup:write', 'style:write'] }, host).map((d) => d.code);
		assert.deepEqual(codes, ['graft-permission-unknown-scope']);
	});

	it('gives every route its own slot, derived from that page alone', () => {
		assert.equal(pageSlot('docs.html'), 'page.docs');
		assert.equal(pageSlot('docs/index.html'), 'page.docs');
		assert.equal(pageSlot('.'), 'page.index');
		assert.match(pageSlot('About.html'), /^page\.about--[0-9a-f]{8}$/);
		assert.match(pageSlot('404.html'), /^page\.p-404--[0-9a-f]{8}$/);
		// A page named like another page's hashed slot is not plain, so it is hashed too.
		const about = pageSlot('About.html');
		const lookalike = `${about.slice('page.'.length)}.html`;
		assert.notEqual(pageSlot(lookalike), about);
		assert.deepEqual(Object.keys(websiteHost(config, files, ['About.html', lookalike]).slots).length, 3);
		const zh = pageSlot('docs/中文.html');
		const guide = pageSlot('docs/指南.html');
		assert.match(zh, /^page\.docs\.p--[0-9a-f]{8}$/);
		assert.notEqual(zh, guide);

		const pages = ['docs/中文.html', 'docs/指南.html', 'docs.html', 'docs/index.html'];
		const before = websiteHost(config, files, pages);
		assert.deepEqual(
			Object.entries(before.slots).map(([slot, { page }]) => [slot, page]).toSorted(),
			[['page.docs', 'docs.html'], [zh, 'docs/中文.html'], [guide, 'docs/指南.html'], ['site', null]].toSorted(),
		);
		// Two routes that still land on one slot (a found 32-bit hash collision) are refused, not merged.
		assert.equal(pageSlot("X~*$$Y.html"), pageSlot("X(+')~Y.html"));
		assert.throws(() => websiteHost(config, files, ["X~*$$Y.html", "X(+')~Y.html"]), (e: Error & { code?: string }) => e.code === 'website-slot-collision');
		// A new page that sorts first renames nothing: every slot keeps its page.
		const after = websiteHost(config, files, ['docs/一.html', ...pages]);
		for (const [slot, value] of Object.entries(before.slots)) assert.deepEqual(after.slots[slot], value);
		assert.equal(Object.keys(after.slots).length, Object.keys(before.slots).length + 1);
		assert.deepEqual(new GraftSpecCheck().check({ ...spec, mount: guide }, after), []);
	});
});
