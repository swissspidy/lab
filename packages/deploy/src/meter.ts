import { normalQuantile } from '@lab/core';
import type { BucketCounts, BucketStats, LabConfig, Meter, TrafficEstimate } from '@lab/core';
import { SITE } from './metrics.ts';
import type { MetricStore } from './metrics.ts';

const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);

/**
 * Standard errors a guardrail's degradation must clear, besides the margin.
 * Set so that, over every check in maxDays (each interval, two windows, each
 * guardrail), a variant no worse than the baseline trips a guardrail by
 * chance less than 5% of the time.
 */
export function guardrailZ(config: LabConfig): number {
	const checks = Math.max(1, (config.traffic.maxDays * 24) / config.traffic.intervalHours) * 2 * Math.max(1, config.guardrailMetrics.length);
	return normalQuantile(1 - 0.05 / checks);
}

/**
 * Reads a MetricStore. Guardrails are judged on the latest interval and on
 * the totals, so a variant that starts failing is caught in the interval it
 * fails, not after its history has diluted the failure. A guardrail degrades
 * when the variant is worse than the baseline by more than the margin and by
 * at least `guardrailZ` standard errors.
 */
export class StoreMeter implements Meter {
	readonly store: MetricStore;
	readonly config: LabConfig;
	private readonly now: () => Date;
	private readonly z: number;

	constructor(options: { store: MetricStore; config: LabConfig; now?: () => Date }) {
		this.store = options.store;
		this.config = options.config;
		this.now = options.now ?? (() => new Date());
		this.z = guardrailZ(options.config);
	}

	private guardrails(windows: Array<{ baseline: BucketCounts; variant: BucketCounts }>): BucketStats['guardrails'] {
		const { jsErrorMargin, bounceMargin, minVisits } = this.config.rollback;
		const out: BucketStats['guardrails'] = {};
		for (const metric of this.config.guardrailMetrics) {
			let degraded = false;
			let detail: string | undefined;
			for (const { baseline, variant } of windows) {
				if (variant.visits < minVisits || baseline.visits < minVisits) continue;
				const [b, v, margin] =
					metric === 'js_error_rate'
						? [rate(baseline.jsErrors, baseline.visits), rate(variant.jsErrors, variant.visits), jsErrorMargin]
						: [1 - rate(baseline.engaged, baseline.visits), 1 - rate(variant.engaged, variant.visits), bounceMargin];
				// Past the margin, and clearly so: a noisy interval must not end a good experiment.
				const se = Math.sqrt((b * (1 - b)) / baseline.visits + (v * (1 - v)) / variant.visits);
				const z = se === 0 ? Infinity : (v - b) / se;
				if (v - b > margin && z >= this.z) {
					degraded = true;
					detail = `variant ${(v * 100).toFixed(1)}% vs baseline ${(b * 100).toFixed(1)}%, margin ${(margin * 100).toFixed(1)} points`;
					break;
				}
			}
			out[metric] = detail === undefined ? { degraded } : { degraded, detail };
		}
		return out;
	}

	async read(experiment: string): Promise<BucketStats> {
		const totals = this.store.totals(experiment);
		const current = this.store.intervalOf(this.now());
		// The latest interval with data, up to the current one.
		const latestIndex = this.store.intervals(experiment).findLast((i) => i <= current);
		const latest = latestIndex === undefined ? null : this.store.totals(experiment, latestIndex, latestIndex);
		const windows = latest ? [latest, totals] : [totals];
		const first = this.store.intervals(experiment)[0];
		return {
			experiment,
			baseline: totals.baseline,
			variant: totals.variant,
			latest,
			guardrails: this.guardrails(windows),
			days: first === undefined ? 0 : ((current - first + 1) * this.store.intervalMs) / 86_400_000,
		};
	}

	/** Site-wide visits per day and conversion rate over the last seven days. */
	async traffic(): Promise<TrafficEstimate> {
		const current = this.store.intervalOf(this.now());
		const perDay = 86_400_000 / this.store.intervalMs;
		const from = current - 7 * perDay;
		const intervals = this.store.intervals(SITE).filter((i) => i >= from && i < current);
		if (intervals.length === 0) return { dailyVisits: 0, conversionRate: 0, days: 0 };
		const { baseline } = this.store.totals(SITE, from, current - 1);
		const days = intervals.length / perDay;
		return { dailyVisits: baseline.visits / days, conversionRate: rate(baseline.conversions, baseline.visits), days };
	}
}
