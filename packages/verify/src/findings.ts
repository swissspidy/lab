// Findings: what the lab's own checks find wrong on one site, with ids that
// stay the same from run to run. The Observer shows them to the proposer;
// Verify compares them between the baseline and a variant, so a fix can be
// shown to remove what it cites and add nothing.
import type { Finding, LabConfig } from '@lab/core';
import type { PageMeasurement } from './measure.ts';

/** What a run of the suite measured on one site. */
export interface SiteRun {
	measurements: PageMeasurement[];
	/** Same-site link targets that do not resolve, as paths. */
	deadLinks: string[];
}

const sample = (items: string[]) => `${items.slice(0, 3).join('; ')}${items.length > 3 ? ` (+${items.length - 3} more)` : ''}`;

/** Every finding on a site, sorted by id. */
export function findingsOf(run: SiteRun, budgets: LabConfig['budgets']): Finding[] {
	const found = new Map<string, Finding & { items: string[] }>();
	const add = (id: string, kind: Finding['kind'], m: PageMeasurement | null, page: string, items: string[], describe: (items: string[]) => string, check?: string) => {
		const finding = found.get(id) ?? { id, kind, page, viewports: [], summary: '', items: [], ...(check ? { check } : {}) };
		if (m && !finding.viewports.includes(m.viewport)) finding.viewports.push(m.viewport);
		for (const item of items) if (!finding.items.includes(item)) finding.items.push(item);
		finding.summary = describe(finding.items);
		found.set(id, finding);
	};
	const at = (f: { viewports: string[] }) => (f.viewports.length ? ` at ${f.viewports.join(', ')}` : '');
	for (const m of run.measurements) {
		const rules = new Map<string, string[]>();
		for (const violation of m.axe) {
			const [rule, ...target] = violation.split(' ');
			rules.set(rule!, [...(rules.get(rule!) ?? []), target.join(' ')]);
		}
		for (const [rule, targets] of rules) {
			add(`a11y.${rule}@${m.page}`, 'accessibility', m, m.page, targets, (items) => `aXe rule ${rule} fails on ${items.length} element(s): ${sample(items)}`);
		}
		if (m.consoleErrors.length) add(`errors.console@${m.page}`, 'errors', m, m.page, m.consoleErrors, (items) => `Console errors: ${sample(items)}`, 'budgets.console-errors');
		if (m.failedRequests.length) add(`errors.request@${m.page}`, 'errors', m, m.page, m.failedRequests, (items) => `Failed requests: ${sample(items)}`, 'budgets.failed-requests');
		if (!(m.status >= 200 && m.status < 400)) add(`errors.status@${m.page}`, 'errors', m, m.page, [`status ${m.status}`], (items) => `The page does not load: ${sample(items)}`, 'budgets.status');
		if (m.overflow) add(`layout.overflow@${m.page}`, 'layout', m, m.page, [], () => 'The page scrolls sideways', 'budgets.overflow');
		if (m.lcpMs > budgets.lcpMs) add(`perf.lcp@${m.page}`, 'performance', m, m.page, [`${Math.round(m.lcpMs)} ms`], (items) => `LCP over the ${budgets.lcpMs} ms budget: ${sample(items)}`, 'budgets.lcp');
		if (m.cls > budgets.cls) add(`perf.cls@${m.page}`, 'performance', m, m.page, [m.cls.toFixed(3)], (items) => `CLS over the ${budgets.cls} budget: ${sample(items)}`, 'budgets.cls');
	}
	for (const target of run.deadLinks) {
		add(`errors.dead-link@${target}`, 'errors', null, target, [], () => `A same-site link to ${target} does not resolve`, 'budgets.dead-links');
	}
	const out: Finding[] = [];
	for (const { items: _items, ...f } of found.values()) {
		f.viewports.sort();
		f.summary = `${f.summary}${at(f)}.`;
		out.push(f);
	}
	return out.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
