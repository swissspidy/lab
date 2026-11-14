// What the model is shown of a site. Everything in here is untrusted data:
// site content can carry text that looks like instructions.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { effectiveDeny, matchesAny } from '@lab/core';
import type { CheckResult, LabConfig, LedgerEvent } from '@lab/core';

const SKIP_DIRS = new Set(['node_modules', '.git', 'lab']);
const TEXT = /\.(html?|css|m?js|ts|tsx|jsx|astro|vue|svelte|md|json|svg|txt|ya?ml)$/i;
const MAX_FILE = 64 * 1024;
const MAX_TOTAL = 400 * 1024;

export interface SiteFile {
	path: string;
	content: string;
	/** The agent may change it. */
	editable: boolean;
}

export function siteFiles(dir: string, config: LabConfig): SiteFile[] {
	const deny = effectiveDeny(config);
	const out: SiteFile[] = [];
	let total = 0;
	const outDir = config.site.outDir.replace(/\/+$/, '');
	const walk = (current: string) => {
		for (const name of readdirSync(current).toSorted()) {
			const full = join(current, name);
			const rel = relative(dir, full).split(sep).join('/');
			const stat = statSync(full);
			if (stat.isDirectory()) {
				if (!SKIP_DIRS.has(name) && rel !== outDir && !name.startsWith('.')) walk(full);
				continue;
			}
			if (!TEXT.test(name) || stat.size > MAX_FILE || total + stat.size > MAX_TOTAL) continue;
			if (/lock|\.env/i.test(name)) continue;
			total += stat.size;
			out.push({ path: rel, content: readFileSync(full, 'utf8'), editable: matchesAny(rel, config.allow) && !matchesAny(rel, deny) });
		}
	};
	walk(dir);
	return out;
}

/** Escapes the closing tag so file content cannot end its own envelope. */
const fence = (text: string) => text.replaceAll('</site_file>', '<\\/site_file>');

export function renderFiles(files: SiteFile[]): string {
	return files
		.map((f) => `<site_file path="${f.path}" editable="${f.editable}">\n${fence(f.content)}\n</site_file>`)
		.join('\n\n');
}

export interface ExperimentSummary {
	id: string;
	intent: string;
	outcome: string;
	failedChecks: string[];
}

/** One line per past experiment: what was tried and how it ended. */
export function summarizeHistory(history: LedgerEvent[]): ExperimentSummary[] {
	const byId = new Map<string, ExperimentSummary>();
	for (const event of history) {
		let summary = byId.get(event.experiment);
		if (!summary) {
			summary = { id: event.experiment, intent: '', outcome: event.type, failedChecks: [] };
			byId.set(event.experiment, summary);
		}
		summary.outcome = event.type;
		if (event.type === 'proposed') {
			const intent = (event.payload.spec as { intent?: unknown } | undefined)?.intent;
			if (typeof intent === 'string') summary.intent = intent;
		}
		if (event.type === 'verify_failed') {
			summary.failedChecks = ((event.payload.failures as CheckResult[] | undefined) ?? []).map((f) => f.check);
		}
	}
	return [...byId.values()];
}

/** Pulls the first JSON object out of a model answer, fenced or not. */
export function extractJson(text: string): unknown {
	const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
	const candidate = fenced ? fenced[1]! : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
	if (!candidate.trim()) throw new Error('The answer holds no JSON object.');
	return JSON.parse(candidate);
}
