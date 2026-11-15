import { probabilityBetter, requiredSamples } from './stats.ts';
import type { BucketStats, Decider, Decision, ExperimentSpec, LabConfig, TrafficEstimate } from './types.ts';

/** The default for `traffic.keepProbability`. */
export const KEEP_PROBABILITY = 0.95;
export const REVERT_PROBABILITY = 0.05;
/**
 * Futility: a change not kept once both buckets reached this many times the
 * planned sample is reverted. The sample was planned for 80% power at the
 * minimum detectable effect; at twice that, a real effect of that size is
 * kept about 98% of the time, so what is left is most likely no effect.
 */
export const FUTILITY_MULTIPLE = 2;

/** P(the variant moves the metric the way the spec expects). */
export function probabilityExpected(stats: Pick<BucketStats, 'baseline' | 'variant'>, spec: Pick<ExperimentSpec, 'expectedEffect'>): number {
	const p = probabilityBetter(stats.baseline, stats.variant);
	return spec.expectedEffect.endsWith(' down') ? 1 - p : p;
}

/**
 * The v0 decision rule. In doubt, the baseline stays:
 * - revert at once when a guardrail degraded;
 * - keep when P(expected effect) ≥ traffic.keepProbability (0.95) and both buckets reached the
 *   sample size planned at ship time (never less than minSamplesPerBucket);
 * - revert when P ≤ 0.05 with the minimum sample, when both buckets reached
 *   twice the planned sample without a keep (futility), or when maxDays
 *   passed; reverting early costs little, keeping early is how false wins
 *   happen, and a change with no effect should not hold the only slot.
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
		const keepAt = this.config.traffic.keepProbability ?? KEEP_PROBABILITY;
		if (planned && p >= keepAt) return { action: 'keep', reason: `P(${spec.expectedEffect}) = ${p.toFixed(3)} ≥ ${keepAt} (${rates}).` };
		if (enough && p <= REVERT_PROBABILITY) return { action: 'revert', reason: `P(${spec.expectedEffect}) = ${p.toFixed(3)} ≤ ${REVERT_PROBABILITY} (${rates}).` };
		const futile = FUTILITY_MULTIPLE * target;
		if (stats.baseline.visits >= futile && stats.variant.visits >= futile) {
			return { action: 'revert', reason: `No effect of the planned size: P = ${p.toFixed(3)} after ${futile} visits per bucket, twice the planned sample (${rates}).` };
		}
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
