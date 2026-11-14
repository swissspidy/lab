// Experiment specs as Graft specs: Markdown with YAML frontmatter, a title,
// an intent paragraph and an "Acceptance criteria" list. Reading goes
// through Graft's own parser; Graft has no writer yet, so this file has one.
// Graft's schema validation is host-specific (mount, permissions) and does
// not apply to websites, so only the parser is used.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSpec } from '@swissspidy/graft-core/parse';
import { StageError } from '@lab/core';
import type { Diagnostic, ExperimentSpec, Observation, Proposer } from '@lab/core';

/** Lab fields with no place in a Graft spec live under `lab:` in the frontmatter. */
interface LabFrontmatter {
	hypothesis: string;
	expectedEffect: string;
	touches: string[];
	source: ExperimentSpec['source'];
	checks: ExperimentSpec['checks'];
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Writes a spec as Graft Markdown. JSON is valid YAML, so nested lab fields are written as JSON. */
export function toGraftMarkdown(spec: ExperimentSpec): string {
	const lab: LabFrontmatter = { hypothesis: spec.hypothesis, expectedEffect: spec.expectedEffect, touches: spec.touches, source: spec.source, checks: spec.checks };
	const criteria = spec.acceptance.map((c, i) => `- ${oneLine(c)} {#c${i}}`);
	return [
		'---',
		'graft: 1',
		`id: ${JSON.stringify(spec.id)}`,
		'host: website',
		`lab: ${JSON.stringify(lab)}`,
		'---',
		`# ${oneLine(spec.intent)}`,
		'',
		oneLine(spec.intent),
		'',
		'## Acceptance criteria',
		'',
		...criteria,
		'',
	].join('\n');
}

/** Reads a spec from Graft Markdown with Graft's parser. Never throws; problems come back as diagnostics. */
export function fromGraftMarkdown(source: string): { spec: ExperimentSpec | null; diagnostics: Diagnostic[] } {
	const parsed = parseSpec(source);
	const diagnostics: Diagnostic[] = parsed.diagnostics
		.filter((d) => d.severity === 'error')
		.map((d) => ({ code: `graft-${d.code}`, severity: 'error' as const, message: d.message }));
	const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
	const lab = fm.lab as Partial<LabFrontmatter> | undefined;
	if (typeof fm.id !== 'string') diagnostics.push({ code: 'graft-spec-id', severity: 'error', message: 'The frontmatter needs an `id`.' });
	if (!lab || typeof lab !== 'object') diagnostics.push({ code: 'graft-spec-lab', severity: 'error', message: 'The frontmatter needs a `lab:` block with the hypothesis, effect and checks.' });
	if (!parsed.description) diagnostics.push({ code: 'graft-spec-intent', severity: 'error', message: 'The spec needs an intent paragraph under its title.' });
	if (diagnostics.length > 0 || !lab) return { spec: null, diagnostics };
	const spec: ExperimentSpec = {
		id: fm.id as string,
		hypothesis: String(lab.hypothesis ?? ''),
		intent: oneLine(parsed.description ?? ''),
		acceptance: parsed.criteria.map((c) => c.text),
		expectedEffect: String(lab.expectedEffect ?? ''),
		touches: Array.isArray(lab.touches) ? lab.touches.map(String) : [],
		source: lab.source === 'visitors' ? 'visitors' : 'agent',
		checks: Array.isArray(lab.checks) ? lab.checks : [],
	};
	return { spec, diagnostics };
}

/** Replays an experiment from a directory holding `spec.md` (Graft format). */
export class GraftSpecProposer implements Proposer {
	readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
	}

	async propose(_ctx: Observation): Promise<ExperimentSpec> {
		const file = join(this.dir, 'spec.md');
		if (!existsSync(file)) throw new StageError('graft-spec-missing', `No spec.md in ${this.dir}.`);
		const { spec, diagnostics } = fromGraftMarkdown(readFileSync(file, 'utf8'));
		if (!spec) throw new StageError('graft-spec-invalid', diagnostics.map((d) => `${d.code}: ${d.message}`).join(' '));
		return spec;
	}
}

/** Wraps a proposer so every proposal is also written as a Graft spec, for people to read and review. */
export function recordingGraftSpecs(proposer: Proposer, dir: string): Proposer {
	return {
		propose: async (ctx) => {
			const spec = await proposer.propose(ctx);
			mkdirSync(dir, { recursive: true });
			if (/^[a-z0-9][a-z0-9-]{1,62}$/.test(spec.id)) writeFileSync(join(dir, `${spec.id}.md`), toGraftMarkdown(spec));
			return spec;
		},
	};
}
