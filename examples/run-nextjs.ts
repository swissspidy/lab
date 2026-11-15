// The full loop on a real Next.js site, locally: a git copy of
// examples/nextjs, the reference host on a simulated clock, synthetic
// visitors over real HTTP, and experiments that go through verify, operator
// approval, ship, measure and decide, with kept variants merged in git.
//
// Run: node examples/run-nextjs.ts [--week] [--out docs/runs/nextjs]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { BetaBinomialDecider, FileLedger, LEDGER_FILE, approve, autonomyEntry, experimentStates, gitPromote, kill, loadConfig, siteCommit, tick, validateConfig } from '@lab/core';
import type { LabConfig, LedgerEvent, TickResult } from '@lab/core';
import { GraftSpecCheck } from '@lab/adapters';
import { ReplayBuilder, ReplayProposer } from '@lab/agent';
import { MetricStore, ReferenceDeployer, StoreMeter, startEdgeServer } from '@lab/deploy';
import { LocalSandbox } from '@lab/sandbox';
import { BrowserVerifier } from '@lab/verify';
import { writeReport } from '@lab/report';
import { mulberry32 } from '../fixtures/sim/simulate.ts';

const example = join(import.meta.dirname, 'nextjs');
const HOUR = 3_600_000;

/**
 * How a simulated visitor reacts to the page it is served. These are the
 * "true effects" the loop has to discover; it never sees them.
 */
// Commits are dated on the simulated clock, so their hashes (and the ledger) are reproducible.
function datedCommits(at: number): void {
	process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = new Date(at).toISOString();
}

export const VISITOR_MODEL = {
	baseRate: 0.1,
	docsInMainNav: 1.25,
	smallHero: 1.3,
	signupBeforeInstall: 0.8,
	ctaBeforeCommand: 1.2,
	engagedRate: 0.6,
};

/** The week's experiments and the effect each truly has, for judging the loop afterwards. */
export const WEEK_QUEUE = [
	{ name: 'cta-before-command', truth: '+20%' },
	{ name: 'hidden-search', truth: 'breaks search: must be rejected' },
	{ name: 'features-order', truth: 'none' },
] as const;

export interface RunOptions {
	/** Experiments to run, in order, from examples/nextjs/experiments. */
	experiments?: string[];
	dailyVisits?: number;
	seed?: number;
	/** Write the ledger report here. */
	out?: string;
	log?: (line: string) => void;
	browser?: Browser;
	/** After M4, test the kill switch, switch to auto and run seven unattended days (M5). */
	week?: boolean;
}

export interface WeekSummary {
	/** One line per scheduled run of `lab run`. */
	ticks: string[];
	/** Each queued experiment's last ledger state at the end of the week. */
	outcomes: Record<string, string>;
	/** Visitors who got a variant after the kill switch, out of `killChecked`. */
	variantAfterKill: number;
	killChecked: number;
	/** Approvals during the week by anyone but the lab itself. */
	manualApprovals: number;
	entryMet: boolean;
	markdown: string;
}

export interface RunResult {
	repo: string;
	events: LedgerEvent[];
	outcomes: Record<string, string>;
	commits: string[];
	browserConversions: number;
	week?: WeekSummary;
	cleanup(): void;
}

function makeRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), 'lab-nextjs-'));
	cpSync(example, repo, {
		recursive: true,
		verbatimSymlinks: true,
		filter: (src) => !/\/(node_modules|\.next|out|experiments|\.lab)(\/|$)/.test(src.slice(example.length)) && !src.endsWith('/lab/ledger.jsonl'),
	});
	if (!existsSync(join(example, 'node_modules'))) throw new Error('Run `npm install` in examples/nextjs first.');
	execFileSync('cp', ['-a', join(example, 'node_modules'), join(repo, 'node_modules')]);
	datedCommits(Date.UTC(2026, 10, 1));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
	git('init', '-q');
	git('add', '-A');
	git('-c', 'user.name=Site owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '--no-gpg-sign', '-m', 'Driftwood site');
	return repo;
}

export async function runNextLoop(options: RunOptions = {}): Promise<RunResult> {
	const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
	const experiments = options.experiments ?? ['nav-docs', 'hero-height', 'signup-first', 'changed-price'];
	const random = mulberry32(options.seed ?? 42);
	const repo = makeRepo();
	const host = mkdtempSync(join(tmpdir(), 'lab-nextjs-host-'));
	process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'lab';
	process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'lab@example.invalid';

	let clock = Date.UTC(2026, 10, 1);
	const now = () => new Date(clock);
	let config = (await loadConfig(repo)).config as LabConfig;
	const intervalMs = config.traffic.intervalHours * HOUR;
	const dailyVisits = options.dailyVisits ?? 4000;
	const perInterval = Math.round((dailyVisits * config.traffic.intervalHours) / 24);

	const ledger = new FileLedger(join(repo, LEDGER_FILE), { now });
	const store = new MetricStore({ intervalHours: config.traffic.intervalHours, file: join(host, 'metrics.json') });
	const deployer = new ReferenceDeployer({ root: host, config, now });
	const ownBrowser = !options.browser;
	const commits: string[] = [];
	const removeDirs = () => {
		rmSync(repo, { recursive: true, force: true });
		rmSync(host, { recursive: true, force: true });
	};
	let browser: Browser | undefined;
	let edge: Awaited<ReturnType<typeof startEdgeServer>> | undefined;
	const release = async () => {
		await edge?.close();
		if (ownBrowser) await browser?.close();
	};
	try {
		browser = options.browser ?? (await chromium.launch());
		await deployer.publish({ dir: repo, commit: siteCommit(repo) });
		edge = await startEdgeServer({ root: host, store, config, now });
	} catch (error) {
		await release();
		removeDirs();
		throw error;
	}
	const edgeUrl = edge.url;
	const theBrowser = browser;
	log(`Published ${repo} at ${edgeUrl}`);

	// A synthetic visitor: one page view over HTTP, beacons as the page would send them.
	const cssCache = new Map<string, string>();
	// Reproducible traffic: each visitor has a fixed id (so a fixed bucket) and
	// draws its random numbers before any request, in creation order. Drawing
	// after a request would tie outcomes to network timing, not to the seed.
	let visitors = 0;
	async function visit(): Promise<void> {
		const cookie = `lab_vid=${(visitors++).toString(16).padStart(32, '0')}`;
		const [engagedDraw, conversionDraw] = [random(), random()];
		const res = await fetch(edgeUrl, { headers: { cookie } });
		const html = await res.text();
		const tag = /data-experiment="([^"]*)" data-bucket="(baseline|variant)"/.exec(html);
		const [e, b] = [tag?.[1] ?? '', tag?.[2] ?? 'baseline'];
		const css = [...html.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => m[1]!);
		let styles = '';
		for (const href of css) {
			// Builds can reuse a chunk name for different content: cache per experiment and bucket.
			// The visitor's cookie keeps the stylesheet request in the same bucket as the page.
			const key = `${e}:${b}:${href}`;
			if (!cssCache.has(key)) cssCache.set(key, await (await fetch(new URL(href, edgeUrl), { headers: { cookie } })).text());
			styles += cssCache.get(key);
		}
		const nav = /<nav aria-label="Main">[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
		let rate = VISITOR_MODEL.baseRate;
		if (nav.includes('href="/docs"')) rate *= VISITOR_MODEL.docsInMainNav;
		if (/height:\s*120px/.test(styles)) rate *= VISITOR_MODEL.smallHero;
		if (html.indexOf('Release notes by email') < html.indexOf('id="install-title"')) rate *= VISITOR_MODEL.signupBeforeInstall;
		if (html.indexOf('>Get started<') < html.indexOf('data-install-command')) rate *= VISITOR_MODEL.ctaBeforeCommand;
		const send = (k: string) => fetch(new URL('/_lab/beacon', edgeUrl), { method: 'POST', body: JSON.stringify({ e, b, k }) });
		await send('visit');
		if (engagedDraw < VISITOR_MODEL.engagedRate) await send('engaged');
		if (conversionDraw < rate) await send('conversion');
	}
	async function traffic(intervals: number): Promise<void> {
		for (let i = 0; i < intervals; i++) {
			for (let n = 0; n < perInterval; n += 50) await Promise.all(Array.from({ length: Math.min(50, perInterval - n) }, visit));
			clock += intervalMs;
		}
		store.flush();
	}


	const outcomes: Record<string, string> = {};
	const step = async (dir: string | null): Promise<TickResult> =>
		tick({
			config,
			site: { dir: repo, commit: siteCommit(repo) },
			ledger,
			proposer: new ReplayProposer(dir ?? join(example, 'experiments', 'none')),
			builder: new ReplayBuilder(dir ?? join(example, 'experiments', 'none')),
			sandbox: new LocalSandbox({ config }),
			verifier: new BrowserVerifier({ config, siteDir: repo, browser: theBrowser }),
			specCheck: new GraftSpecCheck(),
			evidenceDir: join(repo, 'lab', 'evidence'),
			deployer,
			meter: new StoreMeter({ store, config, now }),
			decider: new BetaBinomialDecider(config),
			now,
			promote: async (variant) => {
				datedCommits(clock);
				commits.push(gitPromote(repo, variant));
			},
		});

	let browserConversions = 0;
	let week: WeekSummary | undefined;
	let failed = false;
	try {
		// A day of traffic before the first experiment, for the traffic estimate.
		await traffic(24 / config.traffic.intervalHours);
		for (const name of experiments) {
			const dir = join(example, 'experiments', name);
			const id = (JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')) as { id: string }).id;
			const iterated = await step(dir);
			if (iterated.step !== 'iterate') throw new Error(`Expected a new iteration for ${name}, got ${iterated.step}.`);
			log(`${id} (${name}): ${iterated.result.outcome}${iterated.result.failures.length ? ` – ${iterated.result.failures.map((f) => f.check).join(', ')}` : ''}`);
			if (iterated.result.outcome !== 'verify_passed') {
				outcomes[id] = iterated.result.outcome;
				continue;
			}
			// The human gate: the operator approves the verified experiment.
			await approve({ ledger, site: { dir: repo, commit: siteCommit(repo) } }, id, 'operator');
			const shipped = await step(null);
			log(`${id}: ${shipped.step === 'ship' ? shipped.result.outcome : shipped.step} – ${shipped.step === 'ship' ? shipped.result.reason : ''}`);
			if (shipped.step !== 'ship' || shipped.result.outcome !== 'shipped') {
				// Refused (underpowered, say): nothing is live, so there is nothing to measure.
				outcomes[id] = experimentStates(await ledger.history()).get(id) ?? 'unknown';
				continue;
			}

			if (name === experiments[0]) {
				// A few real browser visits through the edge: the injected beacon works on a hydrated Next.js page.
				const before = store.totals(id);
				for (let i = 0; i < 4; i++) {
					const context = await theBrowser.newContext();
					// A fixed visitor id, so these visits land in the same bucket on every run.
					await context.addCookies([{ name: 'lab_vid', value: 'f'.repeat(31) + String(i), url: edgeUrl }]);
					const page = await context.newPage();
					await page.goto(edgeUrl);
					await page.getByRole('link', { name: 'Get started' }).click();
					await page.waitForURL(/\/docs$/);
					await context.close();
				}
				await new Promise((r) => setTimeout(r, 300));
				const after = store.totals(id);
				browserConversions = after.baseline.conversions + after.variant.conversions - before.baseline.conversions - before.variant.conversions;
				log(`${id}: ${browserConversions} conversion(s) from 4 real browser visits`);
			}

			for (let guard = 0; guard < 15 * 4; guard++) {
				await traffic(1);
				const measured = await step(null);
				if (measured.step !== 'measure') throw new Error(`Expected a measurement, got ${measured.step}.`);
				if (measured.result.outcome !== 'continue') {
					log(`${id}: ${measured.result.outcome} – ${measured.result.reason}`);
					break;
				}
			}
			outcomes[id] = experimentStates(await ledger.history()).get(id) ?? 'unknown';
		}
		if (options.week) week = await runWeek();
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		await release();
		if (failed) removeDirs();
	}

	async function runWeek(): Promise<WeekSummary> {
		const site = () => ({ dir: repo, commit: siteCommit(repo) });
		// The kill drill: ship a harmless experiment, then pull it with the kill switch.
		const drill = join(example, 'experiments', 'kill-drill');
		const drillId = (JSON.parse(readFileSync(join(drill, 'spec.json'), 'utf8')) as { id: string }).id;
		const drilled = await step(drill);
		if (drilled.step !== 'iterate' || drilled.result.outcome !== 'verify_passed') throw new Error('The kill drill did not pass Verify.');
		await approve({ ledger, site: site() }, drillId, 'operator');
		await step(null);
		await traffic(1);
		await kill({ deployer, ledger, site: site(), now });
		let variantAfterKill = 0;
		const killChecked = 40;
		for (let i = 0; i < killChecked; i++) {
			const html = await (await fetch(edgeUrl)).text();
			if (html.includes('data-bucket="variant"')) variantAfterKill++;
		}
		log(`${drillId}: killed; ${variantAfterKill} of ${killChecked} visitors got a variant afterwards`);

		// The site owner switches to auto and commits the change.
		const configFile = join(repo, 'lab.config.ts');
		writeFileSync(configFile, readFileSync(configFile, 'utf8').replace("autonomy: 'gated'", "autonomy: 'auto'"));
		datedCommits(clock);
		execFileSync('git', ['-c', 'user.name=Site owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '--no-gpg-sign', '-am', 'Switch the lab to auto'], { cwd: repo });
		config = validateConfig({ ...config, autonomy: 'auto' }).config as LabConfig;
		const entry = autonomyEntry(await ledger.history());
		log(`Auto mode entry criteria: ${entry.checks.map((c) => `${c.id} ${c.met ? 'met' : 'NOT met'}`).join(', ')}`);

		// Seven days, one scheduled `lab run` per interval, nobody watching.
		const weekStart = clock;
		const queue = WEEK_QUEUE.map((q) => ({ name: q.name, truth: q.truth, dir: join(example, 'experiments', q.name), id: (JSON.parse(readFileSync(join(example, 'experiments', q.name, 'spec.json'), 'utf8')) as { id: string }).id }));
		const ticks: string[] = [];
		for (let i = 0; i < (7 * 24) / config.traffic.intervalHours; i++) {
			await traffic(1);
			const seen = new Set((await ledger.history()).map((e) => e.experiment));
			const next = queue.find((q) => !seen.has(q.id));
			const result = await step(next?.dir ?? null);
			const day = ((clock - weekStart) / 86_400_000).toFixed(2);
			const line =
				result.step === 'iterate'
					? result.result.experiment
						? `${result.result.experiment}: proposed and verified: ${result.result.outcome}${result.result.failures.length ? ` (${result.result.failures.map((f) => f.check).join(', ')})` : ''}`
						: 'idle: nothing left to propose'
					: result.step === 'wait'
						? `${result.experiment}: waiting: ${result.reason}`
						: `${result.result.experiment}: ${result.step === 'ship' ? 'approved by the lab and ' : ''}${result.result.outcome}${result.result.outcome === 'continue' ? '' : `: ${result.result.reason}`}`;
			ticks.push(`day ${day}: ${line}`);
			if (!line.endsWith(': continue') && !line.startsWith('idle')) log(`week ${ticks.at(-1)}`);
		}

		const events = await ledger.history();
		const weekEvents = events.filter((e) => Date.parse(e.at) >= weekStart);
		const manualApprovals = weekEvents.filter((e) => e.type === 'approved' && e.payload.by !== 'auto').length;
		const outcomesWeek: Record<string, string> = {};
		for (const q of queue) outcomesWeek[q.id] = experimentStates(events).get(q.id) ?? 'never proposed';
		return { ticks, outcomes: outcomesWeek, variantAfterKill, killChecked, manualApprovals, entryMet: entry.met, markdown: weekMarkdown(events, queue, weekStart, entry, variantAfterKill, killChecked, manualApprovals) };
	}

	function weekMarkdown(events: LedgerEvent[], queue: Array<{ id: string; name: string; truth: string }>, weekStart: number, entry: ReturnType<typeof autonomyEntry>, variantAfterKill: number, killChecked: number, manualApprovals: number): string {
		const day = (at: string) => ((Date.parse(at) - weekStart) / 86_400_000).toFixed(1);
		const rows = queue.map((q) => {
			const list = events.filter((e) => e.experiment === q.id);
			const spec = list.find((e) => e.type === 'proposed')?.payload.spec as { intent?: string } | undefined;
			const last = list.at(-1);
			const measured = list.findLast((e) => e.type === 'measured');
			const p = measured ? Number(measured.payload.probability).toFixed(3) : '–';
			const outcome = !last ? 'never proposed' : last.type === 'measured' || last.type === 'shipped' ? 'still live at the end of the week' : last.type === 'verify_failed' ? `rejected by Verify (${((last.payload.failures as Array<{ check: string }>) ?? []).map((f) => f.check).join(', ')})` : last.type;
			return `| ${q.id} | ${spec?.intent ?? q.name} | ${q.truth} | ${outcome} | ${last ? day(list[0]!.at) : '–'} | ${p} |`;
		});
		const wrong: string[] = [];
		for (const q of queue) {
			const state = experimentStates(events).get(q.id);
			if (q.truth === 'none' && state === 'kept') wrong.push(`${q.id} was kept although it has no true effect.`);
			if (q.truth.startsWith('+') && state === 'reverted') wrong.push(`${q.id} was reverted although it has a true effect of ${q.truth}.`);
			if (q.truth.startsWith('+') && (state === 'measured' || state === 'shipped')) wrong.push(`${q.id} (true effect ${q.truth}) was still undecided at the end of the week.`);
			if (q.truth.startsWith('breaks') && state !== 'verify_failed') wrong.push(`${q.id} should have been rejected by Verify but ended as ${state}.`);
		}
		const stalled = queue.filter((q) => ['measured', 'shipped'].includes(experimentStates(events).get(q.id) ?? '')).map((q) => q.id);
		const startDate = new Date(weekStart).toISOString().slice(0, 10);
		return `# Week one

Seven unattended days of the lab in \`auto\` mode, on the local Next.js
example (\`examples/nextjs\`), starting ${startDate} on the simulated clock.
Generated by \`npm run example:nextjs\`; the numbers below come from the
ledger of that run (\`docs/runs/nextjs/ledger.jsonl\`, report in
\`docs/runs/nextjs/index.html\`).

This is a local rehearsal, not the launch week the brief asks for: the
visitors are synthetic, the clock is simulated, the experiments are replayed
from disk instead of proposed by a model, and the host is the reference edge
server. It shows that the loop runs a week without a person; it says nothing
about real visitors.

## Before the week

- Entry criteria, from the ledger: ${entry.checks.map((c) => `${c.id}: ${c.met ? 'met' : 'not met'} (${c.detail})`).join('; ')}
  In this rehearsal the "person" who approved the gated experiments was the
  agent running it, as \`operator\`.
- Kill switch tested on the site: after \`lab kill\`, ${variantAfterKill} of ${killChecked} visitors got a variant.
- The site owner switched \`autonomy\` to \`auto\` and committed it.

## The week

One \`lab run\` every ${config.traffic.intervalHours} hours, ${(7 * 24) / config.traffic.intervalHours} runs in all.
Approvals by anyone but the lab: ${manualApprovals}.

| Experiment | Change | True effect | Outcome | Started (day) | Last P |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## What the loop got wrong

${wrong.length ? wrong.map((w) => `- ${w}`).join('\n') : '- No wrong decision, against the true effects in this run.'}
${stalled.length ? `- ${stalled.join(', ')} had no clear effect and still held the only experiment slot at the end of the week. It can hold it until maxDays (14 days): with one experiment at a time, a null result stalls the queue for up to two weeks.` : ''}

Known limits this week did not exercise:

- Daily peeking keeps about 15% of variants with no effect (M3 simulation).
- The factual-claims check is a heuristic.
- No model proposed anything; a model's proposals are the untested part.
`;
	}

	const events = await ledger.history();
	if (options.out) {
		mkdirSync(options.out, { recursive: true });
		writeReport(events, options.out, { title: 'Lab report: Driftwood (Next.js example)', generatedAt: now() });
		writeFileSync(join(options.out, 'ledger.jsonl'), readFileSync(join(repo, LEDGER_FILE)));
		if (week) writeFileSync(join(options.out, 'WEEK-ONE.md'), week.markdown);
		log(`Report: ${join(options.out, 'index.html')}`);
	}
	return {
		repo,
		events,
		outcomes,
		commits,
		browserConversions,
		...(week ? { week } : {}),
		cleanup: removeDirs,
	};
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { out: { type: 'string' }, keep: { type: 'boolean' }, week: { type: 'boolean' } } });
	const result = await runNextLoop({ ...(values.out ? { out: resolve(values.out) } : {}), week: values.week ?? false });
	process.stdout.write(`\nOutcomes: ${JSON.stringify(result.outcomes)}\nCommits: ${result.commits.length}\n${values.keep ? `Repo kept at ${result.repo}\n` : ''}`);
	if (!values.keep) result.cleanup();
}
