import { probabilityBetter, requiredSamples } from './stats.ts';
import type { BucketStats, Decider, Decision, ExperimentSpec, LabConfig, TrafficEstimate } from './types.ts';

export const KEEP_PROBABILITY = 0.95;
export const REVERT_PROBABILITY = 0.05;

/** P(the variant moves the metric the way the spec expects). */
export function probabilityExpected(stats: BucketStats, spec: Pick<ExperimentSpec, 'expectedEffect'>): number {
	const p = probabilityBetter(stats.baseline, stats.variant);
	return spec.expectedEffect.endsWith(' down') ? 1 - p : p;
}

/**
 * The v0 decision rule. In doubt, the baseline stays:
 * - revert at once when a guardrail degraded;
 * - keep when P(expected effect) ≥ 0.95 and both buckets reached the
 *   sample size planned at ship time (never less than minSamplesPerBucket);
 * - revert when P ≤ 0.05 with the minimum sample, or when maxDays passed;
 *   reverting early costs little, keeping early is how false wins happen.
 * - otherwise keep running.
 */
export class BetaBinomialDecider implements Decider {
	readonly config: LabConfig;
	constructor(config: LabConfig) {
		this.config = config;
	}

	decide(stats: BucketStats, spec: ExperimentSpec, plan?: { requiredPerBucket: number }): Decision {
		const degraded = Object.entries(stats.guardrails).filter(([, g]) => g.degraded);
		if (degraded.length > 0) return { action: 'revert', reason: `Guardrail degraded: ${degraded.map(([id, g]) => `${id}${g.detail ? ` (${g.detail})` : ''}`).join(', ')}.` };
		const { minSamplesPerBucket, maxDays } = this.config.traffic;
		const enough = stats.baseline.visits >= minSamplesPerBucket && stats.variant.visits >= minSamplesPerBucket;
		const target = Math.max(minSamplesPerBucket, plan?.requiredPerBucket ?? 0);
		const planned = stats.baseline.visits >= target && stats.variant.visits >= target;
		const p = probabilityExpected(stats, spec);
		const rates = `baseline ${(rate(stats.baseline) * 100).toFixed(2)}%, variant ${(rate(stats.variant) * 100).toFixed(2)}%`;
		if (planned && p >= KEEP_PROBABILITY) return { action: 'keep', reason: `P(${spec.expectedEffect}) = ${p.toFixed(3)} ≥ ${KEEP_PROBABILITY} (${rates}).` };
		if (enough && p <= REVERT_PROBABILITY) return { action: 'revert', reason: `P(${spec.expectedEffect}) = ${p.toFixed(3)} ≤ ${REVERT_PROBABILITY} (${rates}).` };
		if (stats.days >= maxDays) return { action: 'revert', reason: `Inconclusive after ${maxDays} days: P = ${p.toFixed(3)} (${rates}).` };
		return {
			action: 'continue',
			reason: planned ? `P = ${p.toFixed(3)}; keep running (${rates}).` : `P = ${p.toFixed(3)}; waiting for ${target} visits per bucket (baseline ${stats.baseline.visits}, variant ${stats.variant.visits}).`,
		};
	}
}

const rate = (c: { visits: number; conversions: number }) => (c.visits === 0 ? 0 : c.conversions / c.visits);

export interface ShipPlan {
	ok: boolean;
	/** Visits per bucket needed at 80% power for the configured effect. */
	requiredPerBucket: number;
	/** Days until the variant bucket has them. */
	daysNeeded: number;
	reason: string;
}

/**
 * Whether the site's traffic can answer the experiment within maxDays. The
 * lab refuses to ship an experiment it could never decide.
 */
export function planShip(traffic: TrafficEstimate, config: LabConfig): ShipPlan {
	const { share, maxDays, minDetectableEffect, minSamplesPerBucket } = config.traffic;
	if (traffic.days < 1 || traffic.dailyVisits <= 0) {
		return { ok: false, requiredPerBucket: 0, daysNeeded: Infinity, reason: 'No traffic data yet. Let the beacon run for a day before shipping.' };
	}
	const p = traffic.conversionRate;
	if (!(p > 0) || p * (1 + minDetectableEffect) >= 1) {
		return { ok: false, requiredPerBucket: 0, daysNeeded: Infinity, reason: `The baseline conversion rate (${p}) leaves nothing to detect.` };
	}
	const requiredPerBucket = Math.max(requiredSamples(p, minDetectableEffect), minSamplesPerBucket);
	const daysNeeded = Math.ceil(requiredPerBucket / (traffic.dailyVisits * share));
	const ok = daysNeeded <= maxDays;
	return {
		ok,
		requiredPerBucket,
		daysNeeded,
		reason: `${requiredPerBucket} visits per bucket detect a ${Math.round(minDetectableEffect * 100)}% lift on ${(p * 100).toFixed(2)}% at 80% power; at ${Math.round(traffic.dailyVisits)} visits a day and a ${share} share that takes ${daysNeeded} day(s)${ok ? '' : `, more than the ${maxDays} allowed`}.`,
	};
}
