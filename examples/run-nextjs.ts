// The full loop on a real Next.js site, locally: a git copy of
// examples/nextjs, the reference host on a simulated clock, synthetic
// visitors over real HTTP, and experiments that go through verify, operator
// approval, ship, measure and decide, with kept variants merged in git.
//
// Run: node examples/run-nextjs.ts [--out docs/runs/nextjs]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { BetaBinomialDecider, FileLedger, LEDGER_FILE, approve, experimentStates, gitPromote, loadConfig, siteCommit, tick } from '@lab/core';
import type { LabConfig, LedgerEvent, TickResult } from '@lab/core';
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
export const VISITOR_MODEL = {
	baseRate: 0.1,
	docsInMainNav: 1.25,
	smallHero: 1.3,
	signupBeforeInstall: 0.8,
	engagedRate: 0.6,
};

export interface RunOptions {
	/** Experiments to run, in order, from examples/nextjs/experiments. */
	experiments?: string[];
	dailyVisits?: number;
	seed?: number;
	/** Write the ledger report here. */
	out?: string;
	log?: (line: string) => void;
	browser?: Browser;
}

export interface RunResult {
	repo: string;
	events: LedgerEvent[];
	outcomes: Record<string, string>;
	commits: string[];
	browserConversions: number;
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
	const config = (await loadConfig(repo)).config as LabConfig;
	const intervalMs = config.traffic.intervalHours * HOUR;
	const dailyVisits = options.dailyVisits ?? 4000;
	const perInterval = Math.round((dailyVisits * config.traffic.intervalHours) / 24);

	const ledger = new FileLedger(join(repo, LEDGER_FILE), { now });
	const store = new MetricStore({ intervalHours: config.traffic.intervalHours, file: join(host, 'metrics.json') });
	const deployer = new ReferenceDeployer({ root: host, config, now });
	const ownBrowser = !options.browser;
	const browser = options.browser ?? (await chromium.launch());
	const commits: string[] = [];

	await deployer.publish({ dir: repo, commit: siteCommit(repo) });
	const edge = await startEdgeServer({ root: host, store, config, now });
	log(`Published ${repo} at ${edge.url}`);

	// A synthetic visitor: one page view over HTTP, beacons as the page would send them.
	const cssCache = new Map<string, string>();
	async function visit(): Promise<void> {
		const res = await fetch(edge.url);
		const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
		const html = await res.text();
		const tag = /data-experiment="([^"]*)" data-bucket="(baseline|variant)"/.exec(html);
		const [e, b] = [tag?.[1] ?? '', tag?.[2] ?? 'baseline'];
		const css = [...html.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => m[1]!);
		let styles = '';
		for (const href of css) {
			// Builds can reuse a chunk name for different content: cache per experiment and bucket.
			// The visitor's cookie keeps the stylesheet request in the same bucket as the page.
			const key = `${e}:${b}:${href}`;
			if (!cssCache.has(key)) cssCache.set(key, await (await fetch(new URL(href, edge.url), { headers: { cookie } })).text());
			styles += cssCache.get(key);
		}
		const nav = /<nav aria-label="Main">[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
		let rate = VISITOR_MODEL.baseRate;
		if (nav.includes('href="/docs"')) rate *= VISITOR_MODEL.docsInMainNav;
		if (/height:\s*120px/.test(styles)) rate *= VISITOR_MODEL.smallHero;
		if (html.indexOf('Release notes by email') < html.indexOf('id="install-title"')) rate *= VISITOR_MODEL.signupBeforeInstall;
		const send = (k: string) => fetch(new URL('/_lab/beacon', edge.url), { method: 'POST', body: JSON.stringify({ e, b, k }) });
		await send('visit');
		if (random() < VISITOR_MODEL.engagedRate) await send('engaged');
		if (random() < rate) await send('conversion');
	}
	async function traffic(intervals: number): Promise<void> {
		for (let i = 0; i < intervals; i++) {
			for (let n = 0; n < perInterval; n += 50) await Promise.all(Array.from({ length: Math.min(50, perInterval - n) }, visit));
			clock += intervalMs;
		}
		store.flush();
	}

	// A day of traffic before the first experiment, for the traffic estimate.
	await traffic(24 / config.traffic.intervalHours);

	const outcomes: Record<string, string> = {};
	const step = async (dir: string | null): Promise<TickResult> =>
		tick({
			config,
			site: { dir: repo, commit: siteCommit(repo) },
			ledger,
			proposer: new ReplayProposer(dir ?? join(example, 'experiments', 'none')),
			builder: new ReplayBuilder(dir ?? join(example, 'experiments', 'none')),
			sandbox: new LocalSandbox({ config }),
			verifier: new BrowserVerifier({ config, siteDir: repo, browser }),
			evidenceDir: join(repo, 'lab', 'evidence'),
			deployer,
			meter: new StoreMeter({ store, config, now }),
			decider: new BetaBinomialDecider(config),
			now,
			promote: async (variant) => void commits.push(gitPromote(repo, variant)),
		});

	let browserConversions = 0;
	try {
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

			if (name === experiments[0]) {
				// A few real browser visits through the edge: the injected beacon works on a hydrated Next.js page.
				const before = store.totals(id);
				for (let i = 0; i < 4; i++) {
					const context = await browser.newContext();
					const page = await context.newPage();
					await page.goto(edge.url);
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
	} finally {
		await edge.close();
		if (ownBrowser) await browser.close();
	}

	const events = await ledger.history();
	if (options.out) {
		mkdirSync(options.out, { recursive: true });
		writeReport(events, options.out, { title: 'Lab report: Driftwood (Next.js example)', generatedAt: now() });
		writeFileSync(join(options.out, 'ledger.jsonl'), readFileSync(join(repo, LEDGER_FILE)));
		log(`Report: ${join(options.out, 'index.html')}`);
	}
	return {
		repo,
		events,
		outcomes,
		commits,
		browserConversions,
		cleanup: () => {
			rmSync(repo, { recursive: true, force: true });
			rmSync(host, { recursive: true, force: true });
		},
	};
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { out: { type: 'string' }, keep: { type: 'boolean' } } });
	const result = await runNextLoop(values.out ? { out: resolve(values.out) } : {});
	process.stdout.write(`\nOutcomes: ${JSON.stringify(result.outcomes)}\nCommits: ${result.commits.length}\n${values.keep ? `Repo kept at ${result.repo}\n` : ''}`);
	if (!values.keep) result.cleanup();
}
