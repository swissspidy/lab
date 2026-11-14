// The loop. Deterministic code: only the Proposer and Builder may call a
// model, and only this file calls the Deployer, after Verify passes.
import { join } from 'node:path';
import { checkPatch, hashPatch } from './patch.ts';
import { validateSpec } from './spec.ts';
import { StageError } from './types.ts';
import type { BucketStats, Builder, CheckResult, ExperimentSpec, LabConfig, Ledger, LedgerEvent, Proposer, RepoRef, RunningSite, Sandbox, Verifier, VerifyReport } from './types.ts';

export interface IterationDeps {
	config: LabConfig;
	site: RepoRef;
	ledger: Ledger;
	proposer: Proposer;
	builder: Builder;
	sandbox: Sandbox;
	verifier: Verifier;
	/** Root for evidence; each experiment gets a subdirectory. */
	evidenceDir: string;
	baseline?: BucketStats | null;
	/** Stop after Verify. Always true until Ship exists (M3). */
	dry: boolean;
}

export type IterationOutcome = 'verify_passed' | 'verify_failed' | 'aborted';

export interface IterationResult {
	experiment: string | null;
	outcome: IterationOutcome;
	/** Why, in one line. */
	reason: string;
	failures: CheckResult[];
	report: VerifyReport | null;
	events: LedgerEvent[];
}

const failuresOf = (results: CheckResult[]) => results.filter((r) => !r.passed);

function describe(error: unknown): { code: string; message: string; detail?: string } {
	if (error instanceof StageError) return { code: error.code, message: error.message, ...(error.detail === undefined ? {} : { detail: error.detail }) };
	return { code: 'unexpected-error', message: error instanceof Error ? error.message : String(error) };
}

/** One pass through the loop, from Observe to Verify. Every step lands in the ledger. */
export async function runIteration(deps: IterationDeps): Promise<IterationResult> {
	const { config, site, ledger } = deps;
	if (!deps.dry) {
		throw new StageError('ship-unavailable', 'Ship, Measure and Decide arrive in M3. Run with --dry.');
	}
	const events: LedgerEvent[] = [];
	const append = async (event: Parameters<Ledger['append']>[0]) => {
		const written = await ledger.append(event);
		events.push(written);
		return written;
	};
	const result = (experiment: string | null, outcome: IterationOutcome, reason: string, failures: CheckResult[] = [], report: VerifyReport | null = null): IterationResult => ({
		experiment,
		outcome,
		reason,
		failures,
		report,
		events,
	});

	// Observe.
	const history = await ledger.history();

	// Propose.
	let raw: ExperimentSpec;
	try {
		raw = await deps.proposer.propose({ site, config, baseline: deps.baseline ?? null, history });
	} catch (error) {
		// Nothing to record against: no experiment id exists yet.
		const { code, message } = describe(error);
		return result(null, 'aborted', `${code}: ${message}`);
	}
	const { spec, diagnostics } = validateSpec(raw, config, history);
	const id = typeof raw?.id === 'string' && /^[a-z0-9][a-z0-9-]{1,62}$/.test(raw.id) && !history.some((e) => e.experiment === raw.id) ? raw.id : null;
	if (!spec) {
		const reason = diagnostics.map((d) => `${d.code}: ${d.message}`).join(' ');
		if (id) {
			await append({ type: 'proposed', experiment: id, siteCommit: site.commit, patchHash: null, payload: { source: raw.source === 'visitors' ? 'visitors' : 'agent', spec: raw } });
			await append({ type: 'aborted', experiment: id, siteCommit: site.commit, patchHash: null, payload: { stage: 'propose', diagnostics } });
		}
		return result(id, 'aborted', reason);
	}
	await append({ type: 'proposed', experiment: spec.id, siteCommit: site.commit, patchHash: null, payload: { source: spec.source, spec } });

	// Build.
	let variant;
	try {
		variant = await deps.builder.build(spec, site);
	} catch (error) {
		const failure = describe(error);
		await append({ type: 'aborted', experiment: spec.id, siteCommit: site.commit, patchHash: null, payload: { stage: 'build', ...failure } });
		return result(spec.id, 'aborted', `${failure.code}: ${failure.message}`);
	}
	const patchHash = hashPatch(variant.patch);
	const base = { experiment: spec.id, siteCommit: site.commit, patchHash };
	await append({ ...base, type: 'built', payload: { lines: variant.patch.split('\n').length } });

	// Static patch gate: the orchestrator reads the patch itself.
	const staticResults = checkPatch(variant.patch, config);
	if (failuresOf(staticResults).length > 0) {
		const failures = failuresOf(staticResults);
		await append({ ...base, type: 'verify_failed', payload: { failures, results: staticResults } });
		return result(spec.id, 'verify_failed', failures.map((f) => f.check).join(', '), failures);
	}

	// Sandbox.
	const running: RunningSite[] = [];
	try {
		let baselineSite: RunningSite;
		try {
			baselineSite = await deps.sandbox.start(site);
			running.push(baselineSite);
		} catch (error) {
			const failure = describe(error);
			await append({ ...base, type: 'aborted', payload: { stage: 'sandbox', target: 'baseline', ...failure } });
			return result(spec.id, 'aborted', `The baseline does not build: ${failure.message}`);
		}
		let variantSite: RunningSite;
		try {
			variantSite = await deps.sandbox.start(variant);
			running.push(variantSite);
		} catch (error) {
			const failure = describe(error);
			const check = failure.code === 'sandbox-check-failed' ? 'static.check' : failure.code === 'sandbox-patch-failed' ? 'static.patch-apply' : 'static.build';
			const failures: CheckResult[] = [
				{ gate: 'static', check, passed: false, message: failure.message, ...(failure.detail === undefined ? {} : { evidence: { detail: failure.detail } }) },
			];
			await append({ ...base, type: 'verify_failed', payload: { failures, results: [...staticResults, ...failures] } });
			return result(spec.id, 'verify_failed', check, failures);
		}

		// Verify.
		let report: VerifyReport;
		try {
			report = await deps.verifier.verify({ baseline: baselineSite, variant: variantSite, spec, evidenceDir: join(deps.evidenceDir, spec.id) });
		} catch (error) {
			const failure = describe(error);
			await append({ ...base, type: 'aborted', payload: { stage: 'verify', ...failure } });
			return result(spec.id, 'aborted', `${failure.code}: ${failure.message}`);
		}
		const results = [...staticResults, ...report.results];
		if (!report.baselinePassed) {
			const failures = failuresOf(report.baselineResults);
			await append({ ...base, type: 'aborted', payload: { stage: 'verify', reason: 'baseline-failed', failures } });
			return result(spec.id, 'aborted', `The suite fails on the baseline: ${failures.map((f) => f.check).join(', ')}`, failures, report);
		}
		const failures = failuresOf(results);
		if (report.passed && failures.length === 0) {
			await append({ ...base, type: 'verify_passed', payload: { results } });
			return result(spec.id, 'verify_passed', `${results.length} check(s) passed`, [], report);
		}
		await append({ ...base, type: 'verify_failed', payload: { failures, results } });
		return result(spec.id, 'verify_failed', failures.map((f) => f.check).join(', '), failures, report);
	} finally {
		await Promise.allSettled(running.map((s) => s.stop()));
	}
}
