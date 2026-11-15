// Assay: site invariants as locked check sets.
//
// A hand-written invariant asserts whatever its author thought of. An Assay
// invariant states the task and its outcome in words; `lab invariants compile`
// drives the baseline through the task and through runs that must not pass,
// mines checks that tell them apart (no model), stress-tests them, and locks
// the result. Verify then runs the task on each site and evaluates the locked
// checks: a check set that was edited after it was locked fails, and so does
// an outcome Assay cannot decide.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { lockCheckSet, validateCheckSet, verifyLock } from '@swissspidy/assay';
import type { CheckSet, LockStatus } from '@swissspidy/assay';
import { EvidenceRecorder, captureSnapshot, expectOutcome } from '@swissspidy/assay/playwright';
import { compileTask } from '@swissspidy/assay/compiler';
import type { Reference } from '@swissspidy/assay/compiler';
import { stressTest } from '@swissspidy/assay/stress';
import type { StressReport } from '@swissspidy/assay/stress';
import { StageError } from '@lab/core';

/** What an Assay invariant's steps get: the same context as any invariant. */
export interface AssayStepContext {
	page: Page;
	/** The site's root URL, ending in `/`. */
	url: string;
	viewport: { width: number; height: number };
	ok(condition: unknown, message: string): void;
}

export type AssayStep = (ctx: AssayStepContext) => Promise<void>;

export interface AssayTask {
	/** What a person does, in one sentence. */
	instruction: string;
	/** What must be true afterwards: a Markdown list or plain lines, with quoted text where it matters. */
	outcomes: string;
	/** Assay stress variants that do not apply to this task. */
	skipVariants?: string[];
}

/**
 * What an invariant module default-exports to be an Assay invariant. It is
 * plain data and functions, so the module needs only a type import and runs
 * from a site that does not have the lab installed.
 */
export interface AssayInvariantSpec {
	/** Stable, kebab-case. Also the check set's task id. */
	id: string;
	description: string;
	assay: {
		task: AssayTask;
		/** The locked check set, as `lab invariants compile` writes it: a file name next to the module. */
		checks: string;
		/** Does the task on the site and waits until its outcome would show. */
		act: AssayStep;
		/** Runs that must not pass, by name: a wrong input, a step left out. At least one. */
		negatives: Record<string, AssayStep>;
	};
}

export interface AssayInvariant {
	id: string;
	description: string;
	run(ctx: AssayStepContext): Promise<void>;
	/** Set on Assay invariants only, for `lab invariants compile` and `lab doctor`. */
	assay: AssayInvariantSpec['assay'] & { checksFile: string };
}

const CHECKS_FILE = /^[a-z0-9][a-z0-9.-]*\.json$/;

/**
 * The invariant loader's hook for Assay: turns a module's default export
 * into a runnable invariant, or returns null when it is not an Assay
 * invariant. `file` is the module's path.
 */
export function assayInvariant(value: unknown, file: string): AssayInvariant | null {
	if (typeof value !== 'object' || value === null || !('assay' in value)) return null;
	const spec = value as AssayInvariantSpec;
	const where = basename(file);
	const { assay } = spec;
	if (
		typeof assay !== 'object' ||
		assay === null ||
		typeof assay.task?.instruction !== 'string' ||
		typeof assay.task.outcomes !== 'string' ||
		typeof assay.act !== 'function' ||
		typeof assay.negatives !== 'object' ||
		assay.negatives === null ||
		Object.values(assay.negatives).some((n) => typeof n !== 'function')
	) {
		throw new StageError('invariant-invalid', `${where} must export { id, description, assay: { task: { instruction, outcomes }, checks, act, negatives } }.`);
	}
	if (Object.keys(assay.negatives).length === 0) {
		throw new StageError('invariant-negatives-required', `${where} needs at least one negative run: without one, checks that pass on anything would compile.`);
	}
	if (typeof assay.checks !== 'string' || !CHECKS_FILE.test(assay.checks)) {
		throw new StageError('invariant-invalid', `${where}: \`checks\` must be a lowercase .json file name next to the module, such as \`${spec.id}.checks.json\`.`);
	}
	const checksFile = join(dirname(file), assay.checks);
	return {
		id: spec.id,
		description: spec.description,
		assay: { ...assay, checksFile },
		async run(ctx) {
			const checkSet = readLockedChecks(spec.id, checksFile);
			// The recorder must be attached before the page loads, so network checks have evidence.
			await EvidenceRecorder.attach(ctx.page.context());
			await assay.act(ctx);
			await expectOutcome(ctx.page, checkSet, { requireLocked: true, config: false, attach: false, timeout: 3000 });
		},
	};
}

export function isAssayInvariant(value: unknown): value is AssayInvariant {
	return typeof value === 'object' && value !== null && 'assay' in value && typeof (value as AssayInvariant).assay?.checksFile === 'string';
}

/** The lock state of an Assay invariant's check set: a diagnostic code, or null when it is valid. */
export function checkInvariantLock(invariant: AssayInvariant): { code: 'invariant-checks-missing' | 'invariant-checks-invalid' | 'invariant-lock-broken'; message: string } | null {
	try {
		readLockedChecks(invariant.id, invariant.assay.checksFile);
		return null;
	} catch (error) {
		if (error instanceof StageError && (error.code === 'invariant-checks-missing' || error.code === 'invariant-checks-invalid' || error.code === 'invariant-lock-broken')) {
			return { code: error.code, message: error.message };
		}
		throw error;
	}
}

function readLockedChecks(id: string, file: string): CheckSet {
	if (!existsSync(file)) {
		throw new StageError('invariant-checks-missing', `Invariant ${id} has no check set at ${file}. Run \`lab invariants compile\` and commit the file.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch (error) {
		throw new StageError('invariant-checks-invalid', `${file} is not JSON (${(error as Error).message}). Run \`lab invariants compile\` again.`);
	}
	const validation = validateCheckSet(parsed);
	if (!validation.ok) {
		throw new StageError('invariant-checks-invalid', `${file} is not a valid check set: ${validation.errors.slice(0, 3).join('; ')}. Run \`lab invariants compile\` again.`);
	}
	const checkSet = parsed as CheckSet;
	const lock: LockStatus = verifyLock(checkSet);
	if (lock.state !== 'valid') {
		const why = lock.state === 'none' ? 'it is not locked' : lock.problems.join('; ') || 'its lock does not match its content';
		throw new StageError('invariant-lock-broken', `The check set of invariant ${id} cannot be trusted: ${why}. Compile it again with \`lab invariants compile\` and review the diff.`);
	}
	return checkSet;
}

export interface CompileInvariantOptions {
	/** Default: a Chromium launched for this compile. */
	browser?: Browser;
	/** The baseline site's root URL, ending in `/`. */
	url: string;
	viewport: { width: number; height: number };
	/** Who locks the check set: the site owner who reviews and commits it. */
	by: string;
	at?: string;
}

export interface CompiledInvariant {
	checkSet: CheckSet;
	stress: StressReport;
}

/**
 * Compile an Assay invariant against the baseline: capture the task and its
 * negatives, mine checks (no model), stress-test them, and lock them. Throws
 * `invariant-compile-failed` when no checks tell the runs apart and
 * `invariant-stress-failed` when the checks are brittle or miss breakages.
 */
export async function compileInvariant(invariant: AssayInvariant, options: CompileInvariantOptions): Promise<CompiledInvariant> {
	const browser = options.browser ?? (await chromium.launch());
	try {
		return await compileWith(browser, invariant, options);
	} finally {
		if (!options.browser) await browser.close();
	}
}

async function compileWith(browser: Browser, invariant: AssayInvariant, options: CompileInvariantOptions): Promise<CompiledInvariant> {
	const { task, act, negatives } = invariant.assay;
	const capture = async (step: AssayStep) => {
		const context = await browser.newContext({ viewport: options.viewport, serviceWorkers: 'block' });
		context.setDefaultTimeout(5000);
		try {
			const recorder = await EvidenceRecorder.attach(context);
			const page = await context.newPage();
			const ok: AssayStepContext['ok'] = (condition, message) => {
				if (!condition) throw new Error(message);
			};
			await step({ page, url: options.url, viewport: options.viewport, ok });
			return await captureSnapshot(page, { recorder });
		} finally {
			await context.close();
		}
	};
	const success = await capture(act);
	const refs: Reference[] = [{ name: 'baseline', kind: 'success', snapshot: success }];
	for (const [name, step] of Object.entries(negatives)) refs.push({ name, kind: 'negative', snapshot: await capture(step) });
	const result = await compileTask({ id: invariant.id, instruction: task.instruction, outcomes: task.outcomes, ...(task.skipVariants ? { skipVariants: task.skipVariants } : {}) }, refs, {
		discovery: 'mine-only',
		rubric: 'deterministic',
	});
	if (!result.checkSet || result.report.status !== 'compiled') {
		throw new StageError(
			'invariant-compile-failed',
			`No checks for invariant ${invariant.id} tell the baseline from its negatives: ${result.report.reason ?? 'no reason given'}. Quote the text the page shows in the outcomes, or add a negative that differs only in the outcome.`,
		);
	}
	const stress = stressTest(result.checkSet, [{ name: 'baseline', snapshot: success }], task.skipVariants ? { skipVariants: task.skipVariants } : {});
	const problems = [
		...stress.overConstrained.map((f) => `${f.check} fails on a valid variant`),
		...stress.fragile.map((f) => `${f.check} abstains on a valid variant`),
		...stress.weak.map((f) => `${f.check} passes when its evidence is broken`),
		...(stress.missed.length ? [`${stress.missed.length} breakage(s) not caught`] : []),
	];
	if (problems.length > 0) {
		throw new StageError('invariant-stress-failed', `The checks for invariant ${invariant.id} did not survive the stress test: ${problems.join('; ')}. Make the outcomes more specific.`);
	}
	return { checkSet: lockCheckSet(result.checkSet, options.by, options.at), stress };
}

export function writeCompiledInvariant(invariant: AssayInvariant, compiled: CompiledInvariant): string {
	writeFileSync(invariant.assay.checksFile, `${JSON.stringify(compiled.checkSet, null, '\t')}\n`);
	return invariant.assay.checksFile;
}
