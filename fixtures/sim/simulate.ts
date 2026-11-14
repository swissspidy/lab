// A traffic simulator. It drives visitors through the real bucketing,
// metric store, meter, decider and lifecycle, with a configurable true
// effect, on a simulated clock. Only the deployer is a stand-in: it keeps the
// live share in memory instead of building the site.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BetaBinomialDecider, FileLedger, approve, measure, requiredSamples, sha256, ship } from '@lab/core';
import type { Deployer, LabConfig, LedgerEvent, LiveOutcome, Variant } from '@lab/core';
import { MetricStore, SITE, StoreMeter, assignBucket } from '@lab/deploy';
import type { Bucket } from '@lab/deploy';

/** Small, fast, seedable PRNG. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/**
 * Daily visits that let a true effect of `mde` reach a one-sided P ≥ 0.95
 * with 95% power by half of maxDays, from the same sample size calculation
 * the lab uses to plan an experiment. The thresholds are reachable by design.
 */
export function simulatedDailyVisits(config: LabConfig, baselineRate: number): number {
	const required = requiredSamples(baselineRate, config.traffic.minDetectableEffect, 0.95, 0.1);
	return Math.ceil(required / (config.traffic.share * config.traffic.maxDays * 0.5));
}

export class MemoryDeployer implements Deployer {
	live: { experiment: string; share: number } | null = null;
	readonly log: string[] = [];
	async ship(variant: Variant, share: number) {
		this.live = { experiment: variant.experiment, share };
		this.log.push(`ship ${variant.experiment}`);
	}
	async rollback(experiment: string) {
		if (this.live?.experiment === experiment) this.live = null;
		this.log.push(`rollback ${experiment}`);
	}
	async promote(experiment: string) {
		if (this.live?.experiment === experiment) this.live = null;
		this.log.push(`promote ${experiment}`);
	}
	async kill() {
		this.live = null;
		this.log.push('kill');
	}
}

export interface SimOptions {
	seed: number;
	config: LabConfig;
	baselineRate: number;
	/** The true relative effect on the conversion rate: 0.2 is +20%. */
	effect: number;
	dailyVisits?: number;
	engagedRate?: number;
	/** The variant starts throwing uncaught errors on this share of visits from this day on. */
	jsErrors?: { fromDay: number; rate: number };
}

export interface SimResult {
	outcome: LiveOutcome['outcome'];
	reason: string;
	/** Days from ship to the final decision. */
	days: number;
	events: LedgerEvent[];
	deployer: MemoryDeployer;
	start: Date;
}

const PATCH = 'diff --git a/src/pages/index.html b/src/pages/index.html\nindex 1..2 100644\n--- a/src/pages/index.html\n+++ b/src/pages/index.html\n@@ -1 +1 @@\n-a\n+b\n';

export async function simulate(options: SimOptions): Promise<SimResult> {
	const { config, baselineRate, effect, seed } = options;
	const random = mulberry32(seed);
	const dailyVisits = options.dailyVisits ?? simulatedDailyVisits(config, baselineRate);
	const engagedRate = options.engagedRate ?? 0.6;
	const intervalMs = config.traffic.intervalHours * 3_600_000;
	const perInterval = Math.round(dailyVisits / (24 / config.traffic.intervalHours));
	const start = new Date(Date.UTC(2026, 0, 8));
	let clock = start.getTime() - 7 * 86_400_000;
	const now = () => new Date(clock);

	const dir = mkdtempSync(join(tmpdir(), 'lab-sim-'));
	try {
		const store = new MetricStore({ intervalHours: config.traffic.intervalHours });
		const meter = new StoreMeter({ store, config, now });
		const ledger = new FileLedger(join(dir, 'ledger.jsonl'), { now });
		const deployer = new MemoryDeployer();
		const site = { dir, commit: 'sim' };
		const deps = { config, site, ledger, deployer, meter, decider: new BetaBinomialDecider(config), now, promote: async () => {} };
		const hex = () => Array.from({ length: 4 }, () => Math.floor(random() * 2 ** 32).toString(16).padStart(8, '0')).join('');

		const visitInterval = (shippedAt: number | null) => {
			const at = new Date(clock + intervalMs / 2);
			const counts: Record<Bucket, { visit: number; conversion: number; js_error: number; engaged: number }> = {
				baseline: { visit: 0, conversion: 0, js_error: 0, engaged: 0 },
				variant: { visit: 0, conversion: 0, js_error: 0, engaged: 0 },
			};
			const live = deployer.live;
			const day = shippedAt === null ? -1 : (clock - shippedAt) / 86_400_000;
			for (let i = 0; i < perInterval; i++) {
				const bucket: Bucket = live ? assignBucket(hex(), live.experiment, live.share) : 'baseline';
				const c = counts[bucket];
				c.visit++;
				const rate = bucket === 'variant' ? baselineRate * (1 + effect) : baselineRate;
				if (random() < rate) c.conversion++;
				if (random() < engagedRate) c.engaged++;
				if (bucket === 'variant' && options.jsErrors && day >= options.jsErrors.fromDay && random() < options.jsErrors.rate) c.js_error++;
			}
			const experiment = live?.experiment ?? SITE;
			for (const bucket of ['baseline', 'variant'] as const) {
				for (const [event, n] of Object.entries(counts[bucket])) {
					if (n > 0) store.record(experiment, experiment === SITE ? 'baseline' : bucket, event as 'visit', at, n);
				}
			}
		};

		// A week of site traffic before the experiment, for the traffic estimate.
		while (clock < start.getTime()) {
			visitInterval(null);
			clock += intervalMs;
		}

		// A verified, approved experiment.
		const id = 'exp-0001';
		const base = { experiment: id, siteCommit: 'sim', patchHash: sha256(PATCH) };
		await ledger.append({ ...base, type: 'proposed', patchHash: null, payload: { source: 'agent', spec: { id, intent: 'Simulated change.', expectedEffect: `${config.metric.id} up`, acceptance: ['x'], checks: [], hypothesis: 'h', touches: [], source: 'agent' } } });
		await ledger.append({ ...base, type: 'built', payload: { patch: PATCH } });
		await ledger.append({ ...base, type: 'verify_passed', payload: {} });
		await approve(deps, id, 'simulator');
		const shipped = await ship(deps, id);
		if (shipped.outcome !== 'shipped') return { outcome: shipped.outcome, reason: shipped.reason, days: 0, events: await ledger.history(), deployer, start };

		const shippedAt = clock;
		const end = shippedAt + (config.traffic.maxDays + 1) * 86_400_000;
		while (clock < end) {
			visitInterval(shippedAt);
			clock += intervalMs;
			const result = await measure(deps);
			if (result.outcome !== 'continue') {
				return { outcome: result.outcome, reason: result.reason, days: (clock - shippedAt) / 86_400_000, events: await ledger.history(), deployer, start };
			}
		}
		return { outcome: 'continue', reason: 'The simulation ran out of time.', days: config.traffic.maxDays + 1, events: await ledger.history(), deployer, start };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
