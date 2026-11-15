import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { CheckEvidence, CheckResult, Gate, LabConfig, RunningSite, Verifier, VerifyInput, VerifyReport } from '@lab/core';
import { sitePages } from '@lab/core';
import { runAcceptanceCheck } from './acceptance.ts';
import { loadInvariants, runInvariant } from './invariants.ts';
import type { Invariant, InvariantKind } from './invariants.ts';
import { measurePage, newContext, screenshot } from './measure.ts';
import type { PageMeasurement } from './measure.ts';

export type { Invariant, InvariantContext, InvariantKind } from './invariants.ts';
export { loadInvariants } from './invariants.ts';

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

export interface BrowserVerifierOptions {
	config: LabConfig;
	/** The base site's directory. Invariants are loaded from here, never from the variant. */
	siteDir: string;
	/** Reuse a browser. When absent, the verifier launches and closes its own. */
	browser?: Browser;
	concurrency?: number;
	/** Kinds of invariant module besides `{ id, description, run }`, such as Assay invariants. */
	invariantKinds?: readonly InvariantKind[];
}

type Viewport = { width: number; height: number };

function assetBytes(root: string): number {
	let total = 0;
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const stat = statSync(path);
			if (stat.isDirectory()) walk(path);
			else if (/\.(m?js|css)$/.test(name)) total += stat.size;
		}
	};
	walk(root);
	return total;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = Array.from({ length: items.length });
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]!);
		}
	});
	await Promise.all(workers);
	return results;
}

const vpName = (v: Viewport) => `${v.width}x${v.height}`;
const where = (m: PageMeasurement) => `${m.page} at ${m.viewport}`;

interface SuiteRun {
	pages: string[];
	measurements: PageMeasurement[];
	invariants: Map<string, Array<{ viewport: string; passed: boolean; message: string; screenshot?: string; console: string[] }>>;
	deadLinks: string[];
}

/**
 * The built-in verifier: invariants, budgets, content claims and acceptance
 * checks, run with Playwright and aXe against both sites in the same run.
 */
export class BrowserVerifier implements Verifier {
	readonly config: LabConfig;
	readonly siteDir: string;
	readonly concurrency: number;
	private readonly sharedBrowser: Browser | undefined;
	private readonly invariantKinds: readonly InvariantKind[];

	constructor(options: BrowserVerifierOptions) {
		this.config = options.config;
		this.siteDir = options.siteDir;
		this.sharedBrowser = options.browser;
		this.concurrency = options.concurrency ?? 4;
		this.invariantKinds = options.invariantKinds ?? [];
	}

	async verify(input: VerifyInput): Promise<VerifyReport> {
		mkdirSync(input.evidenceDir, { recursive: true });
		const browser = this.sharedBrowser ?? (await chromium.launch());
		try {
			return await this.run(browser, input);
		} finally {
			if (!this.sharedBrowser) await browser.close();
		}
	}

	private async suite(browser: Browser, site: RunningSite, invariants: Invariant[], label: string, evidenceDir: string): Promise<SuiteRun> {
		const pages = sitePages(this.config, site.root);
		const viewports = this.config.viewports;
		const jobs = pages.flatMap((page) => viewports.map((viewport) => ({ page, viewport })));
		const measurements = await pool(jobs, this.concurrency, (j) => measurePage(browser, site.url, j.page, j.viewport, axeSource));
		const invJobs = invariants.flatMap((inv) => viewports.map((viewport) => ({ inv, viewport })));
		const outcomes = await pool(invJobs, this.concurrency, (j) =>
			runInvariant(browser, site.url, j.inv, j.viewport, join(evidenceDir, `${label}-invariant-${j.inv.id}-${vpName(j.viewport)}.png`)),
		);
		const byId = new Map<string, SuiteRun['invariants'] extends Map<string, infer V> ? V : never>();
		for (const [i, job] of invJobs.entries()) {
			const list = byId.get(job.inv.id) ?? [];
			list.push({ viewport: vpName(job.viewport), ...outcomes[i]! });
			byId.set(job.inv.id, list);
		}
		const targets = [...new Set(measurements.flatMap((m) => m.links))];
		const statuses = await pool(targets, 8, async (url) => {
			try {
				return (await fetch(url, { method: 'GET', redirect: 'manual' })).status;
			} catch {
				return 0;
			}
		});
		const deadLinks = targets.filter((_, i) => !(statuses[i]! >= 200 && statuses[i]! < 400)).map((u) => u.replace(site.url, ''));
		return { pages, measurements, invariants: byId, deadLinks };
	}

	private async evidence(browser: Browser, site: RunningSite, m: PageMeasurement | undefined, file: string): Promise<CheckEvidence> {
		if (!m) return {};
		const [width, height] = m.viewport.split('x').map(Number);
		const { context } = await newContext(browser, site.url, { width: width!, height: height! });
		try {
			const page = await context.newPage();
			await page.goto(new URL(m.page, site.url).href, { waitUntil: 'load' });
			const shot = await screenshot(page, file);
			return { ...(shot ? { screenshot: shot } : {}), ...(m.consoleErrors.length ? { console: m.consoleErrors } : {}) };
		} finally {
			await context.close();
		}
	}

	private budgetChecks(run: SuiteRun, against: SuiteRun | null): Array<{ check: string; failing: PageMeasurement[]; message: string; passMessage: string }> {
		const { budgets } = this.config;
		const prior = (m: PageMeasurement) => against?.measurements.find((b) => b.page === m.page && b.viewport === m.viewport);
		const checks: Array<{ check: string; failing: PageMeasurement[]; message: string; passMessage: string }> = [];
		const add = (check: string, pick: (m: PageMeasurement) => string[], passMessage: string) => {
			const found = run.measurements.map((m) => ({ m, items: pick(m) })).filter((x) => x.items.length > 0);
			const shown = found.slice(0, 3).map((x) => `${where(x.m)}: ${x.items.slice(0, 3).join('; ')}${x.items.length > 3 ? ` (+${x.items.length - 3} more)` : ''}`);
			const more = found.length > 3 ? ` | and ${found.length - 3} more page/viewport(s)` : '';
			checks.push({ check, failing: found.map((x) => x.m), message: `${shown.join(' | ')}${more}`, passMessage });
		};
		if (against) {
			const newAxe = (m: PageMeasurement) => {
				const before = new Set(prior(m)?.axe ?? []);
				return m.axe.filter((v) => !before.has(v));
			};
			const total = run.measurements.reduce((n, m) => n + newAxe(m).length, 0);
			const found = run.measurements.filter((m) => newAxe(m).length > 0);
			checks.push({
				check: 'budgets.axe',
				failing: total > budgets.axeViolations ? found : [],
				message: `${total} new aXe violation(s), budget ${budgets.axeViolations}: ${found.map((m) => `${where(m)}: ${newAxe(m).slice(0, 3).join('; ')}`).join(' | ')}`,
				passMessage: `No new aXe violations beyond the budget of ${budgets.axeViolations}.`,
			});
		}
		add('budgets.console-errors', (m) => {
			const before = new Set(prior(m)?.consoleErrors ?? []);
			return m.consoleErrors.filter((e) => !before.has(e));
		}, 'No new console errors.');
		add('budgets.failed-requests', (m) => m.failedRequests, 'No failed requests.');
		add('budgets.new-origins', (m) => {
			const before = new Set(prior(m)?.foreignOrigins ?? []);
			return m.foreignOrigins.filter((o) => !before.has(o));
		}, 'No requests to new origins.');
		add('budgets.overflow', (m) => (m.overflow ? ['the page scrolls sideways'] : []), 'No sideways scroll at any viewport.');
		add('budgets.lcp', (m) => (m.lcpMs > budgets.lcpMs ? [`LCP ${Math.round(m.lcpMs)} ms > ${budgets.lcpMs} ms`] : []), `LCP within ${budgets.lcpMs} ms everywhere.`);
		add('budgets.cls', (m) => (m.cls > budgets.cls ? [`CLS ${m.cls.toFixed(3)} > ${budgets.cls}`] : []), `CLS within ${budgets.cls} everywhere.`);
		add('budgets.status', (m) => (m.status >= 200 && m.status < 400 ? [] : [`status ${m.status}`]), 'Every page loads.');
		return checks;
	}

	private async run(browser: Browser, input: VerifyInput): Promise<VerifyReport> {
		const { baseline, variant, spec, evidenceDir } = input;
		const invariants = await loadInvariants(resolve(this.siteDir, this.config.invariants), this.invariantKinds);
		const [base, varRun] = [
			await this.suite(browser, baseline, invariants, 'baseline', evidenceDir),
			await this.suite(browser, variant, invariants, 'variant', evidenceDir),
		];

		const result = (gate: Gate, check: string, passed: boolean, message: string, evidence?: CheckEvidence): CheckResult => ({
			gate,
			check,
			passed,
			message,
			...(evidence && Object.keys(evidence).length > 0 ? { evidence } : {}),
		});

		// Baseline sanity: the same suite, on the baseline, in this run.
		const baselineResults: CheckResult[] = [];
		for (const [id, outcomes] of base.invariants) {
			const failed = outcomes.filter((o) => !o.passed);
			baselineResults.push(result('baseline', `baseline.invariants.${id}`, failed.length === 0, failed.length ? failed.map((o) => `${o.viewport}: ${o.message}`).join(' | ') : outcomes[0]!.message, failed[0]?.screenshot ? { screenshot: failed[0].screenshot, console: failed[0].console } : undefined));
		}
		for (const b of this.budgetChecks(base, null)) {
			baselineResults.push(result('baseline', `baseline.${b.check}`, b.failing.length === 0, b.failing.length ? b.message : b.passMessage));
		}
		baselineResults.push(result('baseline', 'baseline.budgets.dead-links', base.deadLinks.length === 0, base.deadLinks.length ? `Dead links: ${base.deadLinks.join(', ')}` : 'Every same-site link resolves.'));
		const baselinePassed = baselineResults.every((r) => r.passed);

		const results: CheckResult[] = [];
		// Static: bundle size and content claims.
		if (baseline.root && variant.root) {
			const delta = (assetBytes(variant.root) - assetBytes(baseline.root)) / 1024;
			results.push(result('static', 'static.bundle-size', delta <= this.config.budgets.bundleKbDelta, `JS and CSS grew by ${delta.toFixed(1)} KB; the budget is ${this.config.budgets.bundleKbDelta} KB.`));
		} else {
			results.push(result('static', 'static.bundle-size', false, 'The sandbox exposes no built output, so the bundle size cannot be measured.'));
		}
		const union = (run: SuiteRun, pick: (m: PageMeasurement) => string[]) => new Set(run.measurements.flatMap(pick));
		const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));
		const claim = (check: string, what: string, pick: (m: PageMeasurement) => string[], both: boolean) => {
			const before = union(base, pick);
			const after = union(varRun, pick);
			const added = diff(after, before);
			const removed = both ? diff(before, after) : [];
			const passed = added.length === 0 && removed.length === 0;
			const parts = [added.length ? `added ${added.map((x) => JSON.stringify(x)).join(', ')}` : '', removed.length ? `removed ${removed.map((x) => JSON.stringify(x)).join(', ')}` : ''].filter(Boolean);
			results.push(result('static', check, passed, passed ? `No ${what} added${both ? ' or removed' : ''}.` : `${what[0]!.toUpperCase()}${what.slice(1)} changed: ${parts.join('; ')}.`));
		};
		claim('static.claims-numbers', 'numbers and prices', (m) => m.content.numbers, true);
		claim('static.claims-names', 'names', (m) => m.content.names, false);
		claim('static.claims-links', 'link targets', (m) => m.content.hrefs, false);
		claim('static.claims-forms', 'forms', (m) => m.content.forms, true);
		const lostPages = diff(new Set(base.pages), new Set(varRun.pages));
		results.push(result('static', 'static.claims-pages', lostPages.length === 0, lostPages.length ? `Pages removed: ${lostPages.join(', ')}.` : 'Every page is still there.'));

		// Invariants.
		if (invariants.length === 0) {
			results.push(result('invariants', 'invariants.missing', false, `No invariants in ${this.config.invariants}. Every variant is rejected until the site has some.`));
		}
		for (const [id, outcomes] of varRun.invariants) {
			const failed = outcomes.filter((o) => !o.passed);
			results.push(result('invariants', `invariants.${id}`, failed.length === 0, failed.length ? failed.map((o) => `${o.viewport}: ${o.message}`).join(' | ') : outcomes[0]!.message, failed[0] ? { ...(failed[0].screenshot ? { screenshot: failed[0].screenshot } : {}), console: failed[0].console } : undefined));
		}

		// Budgets.
		for (const b of this.budgetChecks(varRun, base)) {
			const evidence = b.failing.length ? await this.evidence(browser, variant, b.failing[0], join(evidenceDir, `variant-${b.check}.png`)) : undefined;
			results.push(result('budgets', b.check, b.failing.length === 0, b.failing.length ? b.message : b.passMessage, evidence));
		}
		// The baseline has none (baseline sanity), so every dead link is new.
		results.push(result('budgets', 'budgets.dead-links', varRun.deadLinks.length === 0, varRun.deadLinks.length ? `Dead links: ${varRun.deadLinks.join(', ')}` : 'Every same-site link resolves.'));

		// Acceptance: the experiment's own criteria.
		const defaultViewport = this.config.viewports[0]!;
		for (const [i, check] of spec.checks.entries()) {
			const outcome = await runAcceptanceCheck(browser, variant.url, check, defaultViewport, join(evidenceDir, `variant-acceptance-${i}.png`));
			const criterion = spec.acceptance[check.criterion] ?? '';
			results.push(result('acceptance', `acceptance.${i}`, outcome.passed, `“${criterion}” ${outcome.message}`, outcome.passed ? undefined : { ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}), console: outcome.console }));
		}

		return { passed: baselinePassed && results.every((r) => r.passed), baselinePassed, results, baselineResults };
	}
}
