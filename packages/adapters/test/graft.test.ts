import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ExperimentSpec, Observation } from '@lab/core';
import { GraftSpecProposer, fromGraftMarkdown, recordingGraftSpecs, toGraftMarkdown } from '../src/index.ts';

const fixtures = join(import.meta.dirname, '..', '..', '..', 'fixtures');
const spec = JSON.parse(readFileSync(join(fixtures, 'good', 'install-in-hero', 'spec.json'), 'utf8')) as ExperimentSpec;

describe('Graft spec adapter', () => {
	it('round-trips a spec through Graft Markdown and Graft’s parser', () => {
		const md = toGraftMarkdown(spec);
		assert.match(md, /^---\ngraft: 1\nid: "good-install-in-hero"\nhost: website\n/);
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
		assert.ok(codes.has('graft-spec-id'));
		assert.ok(codes.has('graft-spec-lab'));
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
});
