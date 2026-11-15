// The ledger viewer: one static HTML page that tells, experiment by
// experiment, what was tried, what changed, how it was checked, what the
// numbers said and what was decided. No scripts; every value is escaped,
// because the ledger holds text the model and the site wrote.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { CheckResult, LedgerEvent } from '@lab/core';

const escape = (value: unknown): string =>
	String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

interface Spec {
	hypothesis?: string;
	intent?: string;
	acceptance?: string[];
	expectedEffect?: string;
}

interface Counts {
	visits: number;
	conversions: number;
}

export interface ExperimentView {
	id: string;
	state: LedgerEvent['type'];
	source: string;
	spec: Spec;
	patch: string | null;
	results: CheckResult[];
	failures: CheckResult[];
	measurements: Array<{ at: string; day: number; baseline: Counts; variant: Counts; probability: number; decision: { action: string; reason: string } }>;
	events: LedgerEvent[];
	outcome: string;
	started: string;
	ended: string;
}

const OUTCOME: Record<string, string> = {
	proposed: 'Proposed',
	built: 'Built',
	verify_passed: 'Passed verification, waiting for approval',
	verify_failed: 'Rejected by verification',
	approved: 'Approved, waiting to ship',
	shipped: 'Live',
	measured: 'Live',
	kept: 'Kept',
	reverted: 'Reverted',
	aborted: 'Aborted',
};

function reasonOf(event: LedgerEvent): string {
	const p = event.payload;
	if (typeof p.detail === 'string') return p.detail;
	if (typeof p.reason === 'string') return p.reason === 'kill' ? 'Stopped with the kill switch.' : p.reason;
	if (typeof p.message === 'string') return p.message;
	if (Array.isArray(p.failures)) return (p.failures as CheckResult[]).map((f) => f.check).join(', ');
	if (Array.isArray(p.diagnostics)) return (p.diagnostics as Array<{ code?: unknown; message?: unknown }>).map((d) => `${String(d.code)}: ${String(d.message)}`).join(' ');
	return '';
}

export function experimentViews(events: LedgerEvent[]): ExperimentView[] {
	const byId = new Map<string, LedgerEvent[]>();
	for (const e of events) byId.set(e.experiment, [...(byId.get(e.experiment) ?? []), e]);
	return [...byId.entries()]
		.map(([id, list]) => {
			const last = list.at(-1)!;
			const proposed = list.find((e) => e.type === 'proposed');
			const built = list.find((e) => e.type === 'built');
			const verdict = list.find((e) => e.type === 'verify_passed' || e.type === 'verify_failed');
			const results = ((verdict?.payload.results as CheckResult[] | undefined) ?? []).filter(Boolean);
			const failures = ((verdict?.payload.failures as CheckResult[] | undefined) ?? (last.payload.failures as CheckResult[] | undefined) ?? []).filter(Boolean);
			return {
				id,
				state: last.type,
				source: String(proposed?.payload.source ?? 'agent'),
				spec: (proposed?.payload.spec as Spec | undefined) ?? {},
				patch: typeof built?.payload.patch === 'string' ? built.payload.patch : null,
				results,
				failures,
				measurements: list
					.filter((e) => e.type === 'measured')
					.map((e) => {
						const stats = e.payload.stats as { baseline: Counts; variant: Counts };
						return { at: e.at, day: Number(e.payload.day), baseline: stats.baseline, variant: stats.variant, probability: Number(e.payload.probability), decision: e.payload.decision as { action: string; reason: string } };
					}),
				events: list,
				outcome: `${OUTCOME[last.type] ?? last.type}${['kept', 'reverted', 'aborted', 'verify_failed'].includes(last.type) && reasonOf(last) ? `: ${reasonOf(last)}` : ''}`,
				started: list[0]!.at,
				ended: last.at,
			};
		})
		.toSorted((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0));
}

const pct = (c: Counts) => (c.visits === 0 ? '–' : `${((100 * c.conversions) / c.visits).toFixed(2)}%`);

function renderDiff(patch: string, label: string): string {
	const lines = patch.split('\n').map((line) => {
		const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
		return `<span${cls ? ` class="${cls}"` : ''}>${escape(line)}</span>`;
	});
	// Scrollable, so keyboard users can reach it; a region, so it has a name.
	return `<pre class="diff" tabindex="0" role="region" aria-label="${escape(label)}">${lines.join('\n')}</pre>`;
}

/** A table in a named, keyboard-scrollable region, so a wide table scrolls on its own instead of the page. */
function renderTable(id: string, caption: string, headers: string[], rows: string[]): string {
	return `<div class="table-wrap" tabindex="0" role="region" aria-labelledby="${escape(id)}"><table><caption id="${escape(id)}" class="visually-hidden">${escape(caption)}</caption><thead><tr>${headers.map((h) => `<th scope="col">${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

export interface ReportOptions {
	title?: string;
	/** Maps an evidence file on disk to the path the page links to. */
	evidenceHref?: (file: string) => string | null;
	generatedAt?: Date;
}

export function renderReport(events: LedgerEvent[], options: ReportOptions = {}): string {
	const views = experimentViews(events);
	const title = options.title ?? 'Lab report';
	const href = options.evidenceHref ?? (() => null);
	const count = (state: string) => views.filter((v) => v.state === state).length;
	const sections = views.map((v) => {
		const criteria = (Array.isArray(v.spec.acceptance) ? v.spec.acceptance : []).map((c, i) => {
			const checks = v.results.filter((r) => r.gate === 'acceptance');
			const mine = checks.filter((r) => r.message.startsWith(`“${c}”`));
			const status = mine.length === 0 ? '' : mine.every((r) => r.passed) ? ' <span class="pass">met</span>' : ' <span class="fail">not met</span>';
			return `<li>${escape(c)}${status}<span class="muted"> (criterion ${i})</span></li>`;
		});
		const rows = (v.results.length ? v.results : v.failures).toSorted((a, b) => Number(a.passed) - Number(b.passed)).map((r) => {
			const shot = r.evidence?.screenshot ? href(r.evidence.screenshot) : null;
			return `<tr class="${r.passed ? 'ok' : 'bad'}"><td>${escape(r.gate)}</td><td><code>${escape(r.check)}</code></td><td>${r.passed ? '<span class="pass">pass</span>' : '<span class="fail">fail</span>'}</td><td>${escape(r.message)}${shot ? ` <a href="${escape(shot)}">screenshot</a>` : ''}${r.evidence?.console?.length ? `<details><summary>console</summary><pre tabindex="0" role="region" aria-label="Console output of ${escape(r.check)}">${escape(r.evidence.console.join('\n'))}</pre></details>` : ''}${r.evidence?.detail ? `<details><summary>log</summary><pre tabindex="0" role="region" aria-label="Log of ${escape(r.check)}">${escape(r.evidence.detail)}</pre></details>` : ''}</td></tr>`;
		});
		const measured = v.measurements.map(
			(m) => `<tr><td>${escape(m.day)}</td><td>${escape(pct(m.baseline))} <span class="muted">(${escape(m.baseline.conversions)}/${escape(m.baseline.visits)})</span></td><td>${escape(pct(m.variant))} <span class="muted">(${escape(m.variant.conversions)}/${escape(m.variant.visits)})</span></td><td>${escape(m.probability.toFixed(3))}</td><td>${escape(m.decision.action)}: ${escape(m.decision.reason)}</td></tr>`,
		);
		const timeline = v.events.map((e) => `<li><time>${escape(e.at.replace('T', ' ').slice(0, 16))}</time> ${escape(e.type)}${reasonOf(e) && !['verify_failed', 'verify_passed'].includes(e.type) ? ` – ${escape(reasonOf(e))}` : ''}${e.type === 'approved' ? ` by ${escape(e.payload.by)}` : ''}</li>`);
		return `<section id="${escape(v.id)}" class="exp state-${escape(v.state)}">
<h2><a href="#${escape(v.id)}">${escape(v.id)}</a> <span class="badge">${escape(OUTCOME[v.state] ?? v.state)}</span></h2>
${v.outcome !== (OUTCOME[v.state] ?? v.state) ? `<p class="outcome">${escape(v.outcome)}</p>` : ''}
<dl>
<dt>Hypothesis</dt><dd>${escape(v.spec.hypothesis)}</dd>
<dt>Change</dt><dd>${escape(v.spec.intent)}</dd>
<dt>Expected effect</dt><dd>${escape(v.spec.expectedEffect)}</dd>
<dt>Proposed by</dt><dd>${escape(v.source === 'visitors' ? 'visitor requests' : 'the agent')}</dd>
</dl>
${criteria.length ? `<h3>Acceptance criteria</h3><ul>${criteria.join('')}</ul>` : ''}
${v.patch ? `<details><summary>Diff</summary>${renderDiff(v.patch, `Diff of ${v.id}`)}</details>` : ''}
${rows.length ? `<details${v.state === 'verify_failed' ? ' open' : ''}><summary>Verification: ${v.results.filter((r) => r.passed).length} passed, ${(v.results.length ? v.results : v.failures).filter((r) => !r.passed).length} failed</summary>${renderTable(`${v.id}-checks`, `Verification checks of ${v.id}`, ['Gate', 'Check', 'Result', 'Detail'], rows)}</details>` : ''}
${measured.length ? `<h3>Measurements</h3>${renderTable(`${v.id}-measurements`, `Daily measurements of ${v.id}`, ['Day', 'Baseline', 'Variant', 'P(expected effect)', 'Decision'], measured)}` : ''}
<details><summary>Timeline</summary><ol class="timeline">${timeline.join('')}</ol></details>
</section>`;
	});

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(title)}</title>
<style>
:root { --ink: #1b1f24; --muted: #5a636e; --line: #d5dae0; --pass: #116329; --fail: #a40e26; --bg: #fff; --code: #f3f4f6; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6e8eb; --muted: #9aa4af; --line: #3a4048; --pass: #4ac26b; --fail: #ff7b72; --bg: #111418; --code: #1c2128; } }
body { font: 16px/1.5 system-ui, sans-serif; color: var(--ink); background: var(--bg); margin: 0; }
main { max-width: 64rem; margin: 0 auto; padding: 1rem; }
h1 { margin-bottom: .25rem; } h2 { margin-bottom: 0; } h2 a { color: inherit; }
.muted, time { color: var(--muted); }
.exp { border-top: 1px solid var(--line); padding: 1rem 0; }
.badge { font-size: .8rem; font-weight: 600; border: 1px solid var(--line); border-radius: 999px; padding: .1rem .6rem; vertical-align: middle; }
.state-kept .badge, .pass { color: var(--pass); } .state-verify_failed .badge, .state-reverted .badge, .state-aborted .badge, .fail { color: var(--fail); }
.outcome { margin-top: .25rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; } dt { color: var(--muted); } dd { margin: 0; }
.table-wrap { overflow-x: auto; position: relative; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; } th, td { text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); padding: .3rem .5rem; }
code, pre { font-family: ui-monospace, monospace; } pre { background: var(--code); padding: .5rem; overflow-x: auto; font-size: .85rem; }
.diff .add { color: var(--pass); } .diff .del { color: var(--fail); } .diff .meta, .diff .hunk { color: var(--muted); }
summary { cursor: pointer; margin: .5rem 0; }
.timeline { padding-left: 1.25rem; }
</style>
</head>
<body>
<main>
<h1>${escape(title)}</h1>
<p class="muted">${views.length} experiment(s): ${count('kept')} kept, ${count('reverted')} reverted, ${count('verify_failed')} rejected by verification, ${count('aborted')} aborted, ${views.filter((v) => ['shipped', 'measured'].includes(v.state)).length} live. Generated ${escape((options.generatedAt ?? new Date()).toISOString().slice(0, 16).replace('T', ' '))} UTC from the ledger.</p>
<details><summary>How to read this</summary>
<p>The lab improves a website one experiment at a time. For each experiment an agent writes a hypothesis, the change it wants to make and acceptance criteria. The change is built as a patch and tested in a sandbox. It must pass every check: the site's own invariants (what the site must always do), quality budgets (accessibility, errors, speed, layout) and its own criteria. Only then can a person approve it. It is then shown to a share of visitors, measured against the current site on one metric, and kept or reverted. Rejected and reverted experiments are normal results.</p>
<p><em>P(expected effect)</em> is the probability, given the data so far, that the change moves the metric the way the hypothesis says. The lab keeps a change at the site's keep threshold (0.95 by default) or more, once the planned sample is in, and reverts it at 0.05 or less, or when twice the planned sample shows no effect of the planned size.</p>
</details>
${sections.join('\n') || '<p>The ledger is empty.</p>'}
</main>
</body>
</html>
`;
}

/** Writes `index.html` to `outDir`, with the evidence screenshots copied next to it. */
export function writeReport(events: LedgerEvent[], outDir: string, options: Omit<ReportOptions, 'evidenceHref'> & { siteDir?: string } = {}): string {
	mkdirSync(join(outDir, 'evidence'), { recursive: true });
	const copied = new Map<string, string>();
	const { siteDir, ...renderOptions } = options;
	const html = renderReport(events, {
		...renderOptions,
		evidenceHref: (recorded) => {
			// The ledger records evidence relative to the site directory when it is inside it.
			const file = isAbsolute(recorded) ? recorded : resolve(siteDir ?? '.', recorded);
			if (!existsSync(file)) return null;
			let rel = copied.get(file);
			if (!rel) {
				rel = `evidence/${copied.size}-${basename(file).replace(/[^\w.-]/g, '_')}`;
				copyFileSync(file, join(outDir, rel));
				copied.set(file, rel);
			}
			return rel;
		},
	});
	const file = join(outDir, 'index.html');
	writeFileSync(file, html);
	return file;
}
