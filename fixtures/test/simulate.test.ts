// M3's acceptance test: across 20 seeded simulations each, the loop keeps a
// variant with a true +20% effect at least 18 times and never keeps one with
// a true -20% effect; a variant that starts throwing errors is rolled back
// within one measurement interval.
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkLedger, loadConfig, validateConfig } from '@lab/core';
import type { LabConfig } from '@lab/core';
import { simulate, simulatedDailyVisits } from '../sim/simulate.ts';

const site = join(import.meta.dirname, '..', 'site');
const SEEDS = Array.from({ length: 20 }, (_, i) => 1000 + i);
const BASELINE_RATE = 0.1;

async function simConfig(): Promise<LabConfig> {
	const { config } = await loadConfig(site);
	assert.ok(config);
	// Measure every 6 hours; everything else is the fixture's own config.
	const { config: sim, diagnostics } = validateConfig({ ...config, traffic: { ...config.traffic, intervalHours: 6 } });
	assert.deepEqual(diagnostics, []);
	return sim!;
}

describe('simulated traffic (M3)', () => {
	it('sizes the simulation from the sample size calculation', async () => {
		const config = await simConfig();
		const daily = simulatedDailyVisits(config, BASELINE_RATE);
		assert.ok(daily > 1000 && daily < 20_000, `${daily} visits a day`);
	});

	it('keeps a true +20% variant in at least 18 of 20 runs', async () => {
		const config = await simConfig();
		const results = [];
		for (const seed of SEEDS) results.push(await simulate({ seed, config, baselineRate: BASELINE_RATE, effect: 0.2 }));
		const kept = results.filter((r) => r.outcome === 'kept').length;
		for (const r of results) assert.deepEqual(checkLedger(r.events), []);
		assert.ok(kept >= 18, `kept ${kept} of 20: ${results.map((r) => `${r.outcome}@${r.days.toFixed(1)}d`).join(' ')}`);
	});

	it('never keeps a true -20% variant', async () => {
		const config = await simConfig();
		for (const seed of SEEDS) {
			const r = await simulate({ seed, config, baselineRate: BASELINE_RATE, effect: -0.2 });
			assert.notEqual(r.outcome, 'kept', `seed ${seed}: ${r.reason}`);
			assert.equal(r.outcome, 'reverted', `seed ${seed}: ${r.reason}`);
			assert.deepEqual(checkLedger(r.events), []);
		}
	});

	it('reverts a variant with no true effect, by maxDays at the latest', async () => {
		const config = await simConfig();
		let kept = 0;
		for (const seed of SEEDS.slice(0, 10)) {
			const r = await simulate({ seed, config, baselineRate: BASELINE_RATE, effect: 0 });
			if (r.outcome === 'kept') kept++;
			else assert.equal(r.outcome, 'reverted', r.reason);
			assert.ok(r.days <= config.traffic.maxDays + 1e-9);
		}
		// Daily peeking makes false keeps possible; the README says so. They stay rare.
		assert.ok(kept <= 2, `kept ${kept} of 10 null variants`);
	});

	it('rolls back a variant that starts throwing errors within one measurement interval', async () => {
		const config = await simConfig();
		for (const seed of SEEDS.slice(0, 5)) {
			// No true effect, so the experiment is still running when the errors start.
			const fromDay = 1.5;
			const r = await simulate({ seed, config, baselineRate: BASELINE_RATE, effect: 0, jsErrors: { fromDay, rate: 0.3 } });
			assert.equal(r.outcome, 'reverted', `seed ${seed}: ${r.reason}`);
			const reverted = r.events.at(-1)!;
			assert.equal(reverted.payload.reason, 'guardrail');
			const shippedAt = Date.parse(r.events.find((e) => e.type === 'shipped')!.at);
			const errorsFrom = shippedAt + fromDay * 86_400_000;
			const lag = Date.parse(reverted.at) - errorsFrom;
			assert.ok(lag > 0 && lag <= config.traffic.intervalHours * 3_600_000, `rolled back ${lag / 3_600_000} h after the errors started`);
			assert.deepEqual(r.deployer.log.slice(-1), ['rollback exp-0001']);
		}
	});
});
