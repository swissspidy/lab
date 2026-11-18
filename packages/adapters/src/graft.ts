// The website as a Graft host (Graft ADR 0015). An experiment spec is a Graft
// spec: frontmatter Graft's schema accepts as is (`host: website`, a mount
// slot, permission scopes), a title, an intent paragraph and acceptance
// criteria. The lab's own fields are sections Graft keeps but does not
// interpret: hypothesis, expected effect, touches, source and the checks,
// and for a fix or a spec that cites findings, its kind and evidence.
//
// Validation is Graft's: phase one (the schema) whenever a spec is read,
// phase two (mount and permissions against the site's surface) once the
// site's pages are known. Graft has no writer, so this file has one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSpec } from '@swissspidy/graft-core';
import type { Surface } from '@swissspidy/graft-core';
import { StageError, WEBSITE_SCOPES } from '@lab/core';
import type { Diagnostic, ExperimentSpec, Observation, Proposer, SpecCheck, WebsiteHost } from '@lab/core';

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The lab's sections, in the order they are written. */
const SECTIONS = ['Hypothesis', 'Expected effect', 'Touches', 'Source', 'Checks'] as const;
/** Written only when they say something: an experiment that cites nothing has neither. */
const OPTIONAL = ['Kind', 'Evidence'] as const;

/** Writes a spec as Graft Markdown. JSON is valid YAML, so frontmatter values are written as JSON. */
export function toGraftMarkdown(spec: ExperimentSpec): string {
	const criteria = spec.acceptance.map((c, i) => `- ${oneLine(c)} {#c${i}}`);
	return [
		'---',
		'graft: 1',
		`id: ${JSON.stringify(spec.id)}`,
		'host: website',
		`mount: ${JSON.stringify({ slot: spec.mount })}`,
		`permissions: ${JSON.stringify(spec.permissions)}`,
		'---',
		`# ${oneLine(spec.intent)}`,
		'',
		oneLine(spec.intent),
		'',
		'## Acceptance criteria',
		'',
		...criteria,
		'',
		...(spec.kind === 'fix' ? ['## Kind', '', 'fix', ''] : []),
		...(spec.evidence?.length ? ['## Evidence', '', ...spec.evidence.map((id) => `- ${id}`), ''] : []),
		'## Hypothesis',
		'',
		oneLine(spec.hypothesis),
		'',
		'## Expected effect',
		'',
		oneLine(spec.expectedEffect),
		'',
		'## Touches',
		'',
		...(spec.touches.length ? spec.touches.map((t) => `- ${oneLine(t)}`) : ['None.']),
		'',
		'## Source',
		'',
		spec.source,
		'',
		'## Checks',
		'',
		'```json',
		JSON.stringify(spec.checks, null, '\t'),
		'```',
		'',
	].join('\n');
}

function graftDiagnostics(diagnostics: readonly { severity: string; code: string; message: string; path?: string }[]): Diagnostic[] {
	const out: Diagnostic[] = [];
	for (const d of diagnostics) {
		if (d.severity !== 'error') continue;
		const diagnostic: Diagnostic = { code: `graft-${d.code}`, severity: 'error', message: d.message };
		if (d.path !== undefined) diagnostic.path = d.path;
		out.push(diagnostic);
	}
	return out;
}

/**
 * Reads a spec from Graft Markdown, validated by Graft: its schema always,
 * and the site's surface when one is given. Never throws; problems come
 * back as diagnostics. Graft codes are prefixed `graft-`.
 */
export function fromGraftMarkdown(source: string, surface?: Surface): { spec: ExperimentSpec | null; diagnostics: Diagnostic[] } {
	const validation = validateSpec(source, surface ? { surface } : {});
	const diagnostics = graftDiagnostics(validation.diagnostics);
	const graft = validation.spec;
	if (!graft) return { spec: null, diagnostics };
	if (graft.manifest.host !== 'website') {
		diagnostics.push({ code: 'graft-spec-host', severity: 'error', message: `This spec is for "${graft.manifest.host}". Experiment specs use \`host: website\`.`, path: '/host' });
	}
	const section = (heading: (typeof SECTIONS)[number] | (typeof OPTIONAL)[number]) => graft.sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase())?.content;
	for (const heading of SECTIONS) {
		if (section(heading) === undefined) diagnostics.push({ code: 'graft-spec-section', severity: 'error', message: `The spec needs a "## ${heading}" section.` });
	}
	if (!graft.description) diagnostics.push({ code: 'graft-spec-intent', severity: 'error', message: 'The spec needs an intent paragraph under its title.' });
	let checks: unknown = [];
	const fenced = /```json\n([\s\S]*?)\n```/.exec(section('Checks') ?? '');
	if (!fenced) {
		diagnostics.push({ code: 'graft-spec-checks', severity: 'error', message: 'The "## Checks" section needs the checks as a ```json block.' });
	} else {
		try {
			checks = JSON.parse(fenced[1]!);
		} catch (error) {
			diagnostics.push({ code: 'graft-spec-checks', severity: 'error', message: `The checks are not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	if (diagnostics.length > 0) return { spec: null, diagnostics };
	const list = (text: string | undefined) =>
		(text ?? '')
			.split('\n')
			.filter((line) => line.startsWith('- '))
			.map((line) => line.slice(2));
	const touches = list(section('Touches')).map((t) => t.trim());
	const kind = section('Kind');
	if (kind !== undefined && !['fix', 'experiment'].includes(oneLine(kind))) {
		return { spec: null, diagnostics: [{ code: 'graft-spec-kind', severity: 'error', message: 'The "## Kind" section must say `fix` or `experiment`.' }] };
	}
	const evidence = list(section('Evidence'));
	const spec: ExperimentSpec = {
		id: graft.manifest.id,
		...(kind !== undefined && oneLine(kind) === 'fix' ? { kind: 'fix' as const } : {}),
		...(evidence.length ? { evidence } : {}),
		hypothesis: oneLine(section('Hypothesis') ?? ''),
		intent: oneLine(graft.description),
		acceptance: graft.criteria.map((c) => c.text),
		expectedEffect: oneLine(section('Expected effect') ?? ''),
		touches,
		mount: graft.manifest.mount.slot,
		permissions: [...graft.manifest.permissions],
		source: oneLine(section('Source') ?? '') === 'visitors' ? 'visitors' : 'agent',
		checks: checks as ExperimentSpec['checks'],
	};
	return { spec, diagnostics };
}

/**
 * The site as a Graft surface: a slot for the whole site and one per page
 * (extension slots: they attach to what is there), and a scope per kind of
 * file the site lets variants change. No capabilities: a variant is a patch
 * the lab checks and serves, not a build that calls the host.
 */
export function graftSurface(host: WebsiteHost, hostVersion = '1'): Surface {
	const slots: Surface['slots'] = {};
	for (const [id, slot] of Object.entries(host.slots)) {
		slots[id] = { kind: 'extension', title: slot.title, ...(slot.page === null ? {} : { anchor: slot.page }) };
	}
	const scopes: Surface['scopes'] = {};
	for (const scope of Object.keys(host.scopes) as (keyof typeof WEBSITE_SCOPES)[]) {
		scopes[scope] = { title: WEBSITE_SCOPES[scope].title, host: [...WEBSITE_SCOPES[scope].extensions] };
	}
	// No `hash`: Graft computes it asynchronously and verifies it only when present.
	return { graft: 1, host: 'website', hostVersion, slots, capabilities: {}, scopes };
}

/**
 * Phase two, by Graft: the spec, written as Graft Markdown, validated
 * against the site's surface. Catches a mount on a page the site does not
 * have and a permission for files the site does not let variants change.
 */
export class GraftSpecCheck implements SpecCheck {
	check(spec: ExperimentSpec, host: WebsiteHost): Diagnostic[] {
		return fromGraftMarkdown(toGraftMarkdown(spec), graftSurface(host)).diagnostics;
	}
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
