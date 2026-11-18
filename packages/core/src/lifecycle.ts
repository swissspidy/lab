// What happens after Verify: approve, ship, measure, decide, kill. Only this
// file calls the Deployer, and only for an experiment the ledger shows as
// verified (and approved).
import { autonomyEntry } from './autonomy.ts';
import { planShip, probabilityExpected } from './decider.ts';
import { experimentStates, sha256 } from './ledger.ts';
import { runIteration } from './orchestrator.ts';
import type { IterationDeps, IterationResult } from './orchestrator.ts';
import { StageError } from './types.ts';
import type { BucketStats, Decider, Deployer, ExperimentSpec, LabConfig, Ledger, LedgerEvent, Meter, RepoRef, Variant } from './types.ts';

const DAY_MS = 86_400_000;

export interface LiveDeps {
	config: LabConfig;
	site: RepoRef;
	ledger: Ledger;
	deployer: Deployer;
	meter: Meter;
	decider: Decider;
	now?: () => Date;
	/** Merges a kept variant into the site repo. Runs before the deployer promotes it. */
	promote: (variant: Variant) => Promise<void>;
}

const LIVE = new Set(['shipped', 'measured']);

export function liveExperiment(events: LedgerEvent[]): string | null {
	for (const [id, state] of experimentStates(events)) if (LIVE.has(state)) return id;
	return null;
}

export function specFromLedger(events: LedgerEvent[], id: string): ExperimentSpec {
	const proposed = events.find((e) => e.experiment === id && e.type === 'proposed');
	const spec = proposed?.payload.spec as ExperimentSpec | undefined;
	if (!spec) throw new StageError('ledger-no-spec', `The ledger has no spec for ${id}.`);
	return spec;
}

/** The variant exactly as it was verified: the patch from the `built` event, checked against its hash. */
export function variantFromLedger(events: LedgerEvent[], id: string, site: RepoRef): Variant {
	const built = events.find((e) => e.experiment === id && e.type === 'built');
	const patch = built?.payload.patch;
	if (!built || typeof patch !== 'string') throw new StageError('ledger-no-patch', `The ledger has no patch for ${id}.`);
	if (sha256(patch) !== built.patchHash) throw new StageError('ledger-patch-mismatch', `The patch recorded for ${id} does not match its hash.`);
	return { experiment: id, base: site, patch, patchHash: built.patchHash };
}

function stateOf(events: LedgerEvent[], id: string) {
	return experimentStates(events).get(id);
}

export async function approve(deps: { ledger: Ledger; site: RepoRef; now?: () => Date }, id: string, by: string): Promise<LedgerEvent> {
	const events = await deps.ledger.history();
	const state = stateOf(events, id);
	if (state !== 'verify_passed') throw new StageError('approve-invalid-state', `${id} is ${state ? `at \`${state}\`` : 'not in the ledger'}; only a verified experiment can be approved.`);
	const built = events.find((e) => e.experiment === id && e.type === 'built')!;
	return deps.ledger.append({ type: 'approved', experiment: id, siteCommit: deps.site.commit, patchHash: built.patchHash, payload: { by }, ...(deps.now ? { at: deps.now().toISOString() } : {}) });
}

export type LiveOutcome =
	| { outcome: 'shipped' | 'kept' | 'merged' | 'reverted' | 'continue' | 'aborted'; experiment: string; reason: string }
	| { outcome: 'idle'; experiment: null; reason: string };

export async function ship(deps: LiveDeps, id: string): Promise<LiveOutcome> {
	const events = await deps.ledger.history();
	const state = stateOf(events, id);
	if (state !== 'approved') throw new StageError('ship-invalid-state', `${id} is ${state ? `at \`${state}\`` : 'not in the ledger'}; only an approved experiment can ship.`);
	if (specFromLedger(events, id).kind === 'fix') throw new StageError('ship-fix', `${id} is a fix: it is merged, not shown to visitors. The next \`lab run\` merges it.`);
	const live = liveExperiment(events);
	if (live) throw new StageError('ship-experiment-live', `${live} is live. v0 runs one experiment at a time.`);
	const variant = variantFromLedger(events, id, deps.site);
	const base = { experiment: id, siteCommit: deps.site.commit, patchHash: variant.patchHash };
	const plan = planShip(await deps.meter.traffic(), deps.config);
	if (!plan.ok) {
		await deps.ledger.append({ ...base, type: 'aborted', payload: { stage: 'ship', reason: 'underpowered', plan } });
		return { outcome: 'aborted', experiment: id, reason: plan.reason };
	}
	await deps.deployer.ship(variant, deps.config.traffic.share);
	await deps.ledger.append({ ...base, type: 'shipped', payload: { share: deps.config.traffic.share, plan }, at: (deps.now?.() ?? new Date()).toISOString() });
	return { outcome: 'shipped', experiment: id, reason: plan.reason };
}

/**
 * Merges an approved fix into the site's repository. A fix is verified
 * offline (Verify showed its findings gone and nothing new), so it needs no
 * traffic. It waits while an experiment is live: merging would change the
 * baseline under it. The variant passed to `promote` has the commit it was
 * verified on as its base, so `promote` can refuse a site that changed
 * since (gitPromote's `verifiedAt`). The site's own deploy publishes the
 * merge.
 */
export async function merge(deps: Pick<LiveDeps, 'ledger' | 'site' | 'promote' | 'now'>, id: string): Promise<LiveOutcome> {
	const events = await deps.ledger.history();
	const state = stateOf(events, id);
	if (state !== 'approved') throw new StageError('merge-invalid-state', `${id} is ${state ? `at \`${state}\`` : 'not in the ledger'}; only an approved fix can be merged.`);
	const spec = specFromLedger(events, id);
	if (spec.kind !== 'fix') throw new StageError('merge-not-fix', `${id} is an experiment: it ships to visitors and is kept only once measured.`);
	const live = liveExperiment(events);
	if (live) throw new StageError('merge-experiment-live', `${live} is live. A fix waits until it ends, so the baseline does not change under it.`);
	// The variant as verified: its base is the commit it was built and checked on.
	const built = events.find((e) => e.experiment === id && e.type === 'built')!;
	const variant = { ...variantFromLedger(events, id, deps.site), base: { dir: deps.site.dir, commit: built.siteCommit } };
	const base = { experiment: id, siteCommit: deps.site.commit, patchHash: variant.patchHash };
	const at = (deps.now?.() ?? new Date()).toISOString();
	try {
		await deps.promote(variant);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await deps.ledger.append({ ...base, type: 'aborted', at, payload: { stage: 'merge', reason: message } });
		return { outcome: 'aborted', experiment: id, reason: `Could not merge: ${message}` };
	}
	const reason = `Verified fix for ${(spec.evidence ?? []).join(', ')}; merged without an experiment.`;
	await deps.ledger.append({ ...base, type: 'merged', at, payload: { reason, verifiedCommit: built.siteCommit } });
	return { outcome: 'merged', experiment: id, reason };
}

/**
 * One measurement. Guardrails are checked every interval; the decision rule
 * runs once per whole day since the experiment shipped.
 */
export async function measure(deps: LiveDeps): Promise<LiveOutcome> {
	const now = deps.now?.() ?? new Date();
	const events = await deps.ledger.history();
	const id = liveExperiment(events);
	if (!id) return { outcome: 'idle', experiment: null, reason: 'No experiment is live.' };
	const shipped = events.find((e) => e.experiment === id && e.type === 'shipped')!;
	const base = { experiment: id, siteCommit: deps.site.commit, patchHash: shipped.patchHash };
	const at = now.toISOString();
	// The meter counts; the ledger says how long the experiment has run.
	const stats: BucketStats = { ...(await deps.meter.read(id)), days: (now.getTime() - Date.parse(shipped.at)) / DAY_MS };
	const spec = specFromLedger(events, id);

	const degraded = Object.entries(stats.guardrails).filter(([, g]) => g.degraded);
	if (degraded.length > 0) {
		await deps.deployer.rollback(id);
		const reason = `Guardrail degraded: ${degraded.map(([g, v]) => `${g}${v.detail ? ` (${v.detail})` : ''}`).join(', ')}.`;
		await deps.ledger.append({ ...base, type: 'reverted', at, payload: { reason: 'guardrail', detail: reason, stats } });
		return { outcome: 'reverted', experiment: id, reason };
	}

	const day = Math.floor(stats.days + 1e-9);
	const decided = new Set(events.filter((e) => e.experiment === id && e.type === 'measured').map((e) => e.payload.day));
	if (day < 1 || decided.has(day)) return { outcome: 'continue', experiment: id, reason: `Guardrails hold; the next decision is on day ${Math.max(day, 0) + 1}.` };

	const plan = shipped.payload.plan as { requiredPerBucket?: unknown } | undefined;
	const decision = deps.decider.decide(stats, spec, typeof plan?.requiredPerBucket === 'number' ? { requiredPerBucket: plan.requiredPerBucket } : undefined);
	await deps.ledger.append({ ...base, type: 'measured', at, payload: { day, stats, probability: probabilityExpected(stats, spec), decision } });
	if (decision.action === 'continue') return { outcome: 'continue', experiment: id, reason: decision.reason };
	if (decision.action === 'revert') {
		await deps.deployer.rollback(id);
		await deps.ledger.append({ ...base, type: 'reverted', at, payload: { reason: 'decision', detail: decision.reason } });
		return { outcome: 'reverted', experiment: id, reason: decision.reason };
	}
	try {
		await deps.promote(variantFromLedger(events, id, deps.site));
		await deps.deployer.promote(id);
	} catch (error) {
		// A variant that cannot be merged is not kept: the baseline stays.
		await deps.deployer.rollback(id);
		const message = error instanceof Error ? error.message : String(error);
		await deps.ledger.append({ ...base, type: 'aborted', at, payload: { stage: 'promote', reason: message } });
		return { outcome: 'aborted', experiment: id, reason: `Could not promote: ${message}` };
	}
	await deps.ledger.append({ ...base, type: 'kept', at, payload: { reason: decision.reason } });
	return { outcome: 'kept', experiment: id, reason: decision.reason };
}

/**
 * The kill switch. Stops every variant first, then records it. It works even
 * when the ledger is unreadable: stopping traffic never waits for paperwork.
 */
export async function kill(deps: { deployer: Deployer; ledger: Ledger; site: RepoRef; now?: () => Date }): Promise<{ experiment: string | null; ledgerError?: string }> {
	await deps.deployer.kill();
	try {
		const events = await deps.ledger.history();
		const id = liveExperiment(events);
		if (!id) return { experiment: null };
		const shipped = events.find((e) => e.experiment === id && e.type === 'shipped')!;
		await deps.ledger.append({ type: 'reverted', experiment: id, siteCommit: deps.site.commit, patchHash: shipped.patchHash, at: (deps.now?.() ?? new Date()).toISOString(), payload: { reason: 'kill' } });
		return { experiment: id };
	} catch (error) {
		return { experiment: null, ledgerError: error instanceof Error ? error.message : String(error) };
	}
}

export type TickResult = { step: 'measure' | 'ship' | 'merge'; result: LiveOutcome } | { step: 'iterate'; result: IterationResult } | { step: 'wait'; experiment: string; reason: string };

/** Ships an approved experiment, or merges an approved fix. */
async function release(deps: IterationDeps & LiveDeps, events: LedgerEvent[], id: string): Promise<TickResult> {
	return specFromLedger(events, id).kind === 'fix' ? { step: 'merge', result: await merge(deps, id) } : { step: 'ship', result: await ship(deps, id) };
}

/**
 * One scheduled run of the loop: measure the live experiment if there is
 * one; otherwise ship an approved experiment or merge an approved fix;
 * otherwise wait for an approval; otherwise start a new iteration.
 */
export async function tick(deps: IterationDeps & LiveDeps): Promise<TickResult> {
	const events = await deps.ledger.history();
	if (liveExperiment(events)) return { step: 'measure', result: await measure(deps) };
	for (const [id, state] of experimentStates(events)) {
		if (state === 'approved') return release(deps, events, id);
	}
	if (deps.config.autonomy !== 'propose-only') {
		for (const [id, state] of experimentStates(events)) {
			if (state !== 'verify_passed') continue;
			if (deps.config.autonomy === 'auto') {
				const entry = autonomyEntry(events);
				if (entry.met) {
					await approve(deps, id, 'auto');
					return release(deps, await deps.ledger.history(), id);
				}
				const unmet = entry.checks.filter((c) => !c.met).map((c) => c.detail).join(' ');
				return { step: 'wait', experiment: id, reason: `${id} passed Verify. Auto mode is not active yet: ${unmet} It waits for \`lab approve ${id}\`.` };
			}
			return { step: 'wait', experiment: id, reason: `${id} passed Verify and waits for \`lab approve ${id}\`.` };
		}
	}
	return { step: 'iterate', result: await runIteration(deps) };
}
