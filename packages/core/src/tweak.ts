// Personal tweaks: a visitor's own restyling of a site. A tweak is a Graft
// spec for host `website` that may only change styles, plus its CSS. It is
// checked statically, verified against the site with the CSS injected (the
// same invariants, budgets and checks as a variant), then stored and served
// to the visitors who opt in. Tweaks are never measured: a tweaked visitor
// is left out of experiments.
import { randomBytes } from 'node:crypto';
import { validateChecks } from './spec.ts';
import { StageError } from './types.ts';
import type { CheckResult, CssInjector, Diagnostic, ExperimentSpec, LabConfig, RepoRef, RunningSite, Sandbox, SpecCheck, Tweak, TweakRecord, TweakSpec, Verifier, VerifyReport } from './types.ts';
import { SLOT, listSiteFiles, sitePages, websiteHost } from './website.ts';

export const TWEAK_ID = /^tw-[0-9a-f]{12}$/;
export const TWEAK_PERMISSIONS = ['style:write'] as const;
export const DEFAULT_TWEAK_BYTES = 16_384;

export const newTweakId = (): string => `tw-${randomBytes(6).toString('hex')}`;

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Checks a tweak's spec: a style-only Graft spec with a check for every criterion. */
export function validateTweakSpec(raw: unknown): { spec: TweakSpec | null; diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];
	const error = (code: string, path: string, message: string) => diagnostics.push({ code, severity: 'error', path, message });
	if (!isObject(raw)) {
		error('tweak-not-object', '', 'A tweak spec must be a JSON object.');
		return { spec: null, diagnostics };
	}
	for (const key of Object.keys(raw)) if (!['id', 'intent', 'acceptance', 'mount', 'permissions', 'checks'].includes(key)) error('tweak-unknown-key', key, `Unknown key \`${key}\`.`);
	if (typeof raw.id !== 'string' || !TWEAK_ID.test(raw.id)) error('tweak-id', 'id', '`id` must be `tw-` and twelve hex digits.');
	if (!isText(raw.intent)) error('tweak-intent', 'intent', '`intent` must say in one sentence what changes.');
	if (!Array.isArray(raw.acceptance) || raw.acceptance.length === 0 || !raw.acceptance.every(isText)) error('tweak-acceptance', 'acceptance', '`acceptance` must list at least one criterion.');
	if (typeof raw.mount !== 'string' || !SLOT.test(raw.mount)) error('tweak-mount', 'mount', '`mount` must be `site` or a page slot such as `page.docs`.');
	if (!Array.isArray(raw.permissions) || raw.permissions.length !== 1 || raw.permissions[0] !== 'style:write') {
		error('tweak-permissions', 'permissions', 'A personal tweak may only restyle: `permissions` must be exactly `["style:write"]`.');
	}
	validateChecks(raw.checks, Array.isArray(raw.acceptance) ? raw.acceptance.length : 0, error);
	return { spec: diagnostics.length === 0 ? (raw as unknown as TweakSpec) : null, diagnostics };
}

/**
 * Splits CSS the way a CSS tokenizer does: comments dropped, strings kept
 * apart from the code around them (their contents replaced by `""`), so a
 * quoted comment marker cannot hide code and a commented-out word cannot
 * hide in a string. Null when a comment or a string is not closed, or a
 * string runs over a line (a bad string to a browser).
 */
export function splitCss(css: string): { code: string; strings: string[] } | null {
	let code = '';
	const strings: string[] = [];
	let i = 0;
	while (i < css.length) {
		const c = css[i]!;
		if (c === '/' && css[i + 1] === '*') {
			const end = css.indexOf('*/', i + 2);
			if (end === -1) return null;
			code += ' ';
			i = end + 2;
		} else if (c === '"' || c === "'") {
			const end = css.indexOf(c, i + 1);
			if (end === -1 || /[\r\n\f]/.test(css.slice(i + 1, end))) return null;
			strings.push(css.slice(i + 1, end));
			code += '""';
			i = end + 1;
		} else {
			code += c;
			i++;
		}
	}
	return { code, strings };
}

/** What a tweak's stylesheet may not contain anywhere, comments and strings included. */
const FORBIDDEN_ANYWHERE: Array<[RegExp, string]> = [
	[/</, 'Markup does not belong in a stylesheet: no `<` anywhere, comments and strings included.'],
	[/\\/, 'Backslash escapes can hide anything else this gate refuses.'],
];

/** What its code may not contain, once comments are dropped and strings set apart. */
const FORBIDDEN_IN_CODE: Array<[RegExp, string]> = [
	[/@import\b/i, '`@import` loads more CSS from elsewhere.'],
	[/url\s*\(/i, '`url()` makes a request: no images, fonts or anything else from anywhere.'],
	[/image-set\s*\(/i, '`image-set()` makes a request.'],
	[/@font-face\b/i, '`@font-face` loads a font.'],
	[/expression\s*\(/i, '`expression()` runs script in old browsers.'],
	[/javascript\s*:/i, '`javascript:` is a script URL.'],
	[/(?:^|[;{\s])behavior\s*:/i, '`behavior` attaches script in old browsers.'],
	[/-moz-binding\b/i, '`-moz-binding` attaches script in old browsers.'],
	[/(?:^|[;{\s])content\s*:/i, '`content` writes text onto the page: a tweak changes how the site looks, not what it says.'],
];

/**
 * The static gate for a tweak's stylesheet: size, and nothing that makes a
 * request, runs script, writes text or hides any of those behind escapes,
 * comments or strings.
 */
export function checkTweakCss(css: string, config: Pick<LabConfig, 'tweaks'>): CheckResult[] {
	const max = config.tweaks?.maxBytes ?? DEFAULT_TWEAK_BYTES;
	const bytes = Buffer.byteLength(css, 'utf8');
	const problems = FORBIDDEN_ANYWHERE.filter(([pattern]) => pattern.test(css)).map(([, why]) => why);
	const split = splitCss(css);
	if (!split) {
		problems.push('A comment or a string is not closed, or a string runs over a line.');
	} else {
		problems.push(...FORBIDDEN_IN_CODE.filter(([pattern]) => pattern.test(split.code)).map(([, why]) => why));
		if (split.code.trim() === '') problems.push('The stylesheet is empty.');
	}
	return [
		{ gate: 'static', check: 'static.tweak-size', passed: bytes <= max, message: `${bytes} bytes; the limit is ${max}.` },
		{ gate: 'static', check: 'static.tweak-css', passed: problems.length === 0, message: problems.length === 0 ? 'Only styles: no requests, script or text.' : problems.join(' ') },
	];
}

/** A tweak as the verifier sees it: an experiment spec that changes styles only. */
export function tweakAsSpec(spec: TweakSpec, config: Pick<LabConfig, 'metric'>): ExperimentSpec {
	return {
		id: spec.id,
		hypothesis: spec.intent,
		intent: spec.intent,
		acceptance: spec.acceptance,
		expectedEffect: `${config.metric.id} up`,
		touches: [],
		mount: spec.mount,
		permissions: [...spec.permissions],
		source: 'visitors',
		checks: spec.checks,
	};
}

export interface TweakDeps {
	config: LabConfig;
	site: RepoRef;
	sandbox: Sandbox;
	injector: CssInjector;
	verifier: Verifier;
	evidenceDir: string;
	/** Graft's phase two: the spec's mount against the site's pages. */
	specCheck?: SpecCheck;
	now?: () => Date;
}

export type TweakOutcome =
	| { outcome: 'verified'; record: TweakRecord; results: CheckResult[] }
	| { outcome: 'rejected'; failures: CheckResult[]; results: CheckResult[]; diagnostics: Diagnostic[] }
	| { outcome: 'aborted'; reason: string };

/**
 * Verifies a tweak against the site: the static gates, then the site with
 * and without the tweak's CSS through the verifier. Only a tweak that
 * passes everything comes back as a record to store.
 */
export async function verifyTweak(deps: TweakDeps, tweak: Tweak): Promise<TweakOutcome> {
	const { config } = deps;
	if (!config.tweaks) return { outcome: 'aborted', reason: 'tweaks-disabled: This site offers no personal tweaks. Add `tweaks: {}` to lab.config.ts to offer them.' };
	const { spec, diagnostics } = validateTweakSpec(tweak.spec);
	const statics = checkTweakCss(tweak.css, config);
	const failingStatics = statics.filter((r) => !r.passed);
	if (!spec || failingStatics.length > 0) return { outcome: 'rejected', failures: failingStatics, results: statics, diagnostics };

	const running: RunningSite[] = [];
	try {
		let baseline: RunningSite;
		try {
			baseline = await deps.sandbox.start(deps.site);
			running.push(baseline);
		} catch (error) {
			return { outcome: 'aborted', reason: `The baseline does not build: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (deps.specCheck) {
			let problems: Diagnostic[];
			try {
				// A tweak restyles at run time, so `style:write` is on offer whatever files the site has.
				const host = websiteHost(config, listSiteFiles(deps.site.dir, config), sitePages(config, baseline.root));
				host.scopes['style:write'] = { files: host.scopes['style:write']?.files ?? 0 };
				problems = (await deps.specCheck.check(tweakAsSpec(spec, config), host)).filter((d) => d.severity === 'error');
			} catch (error) {
				return { outcome: 'aborted', reason: `The spec check failed: ${error instanceof Error ? error.message : String(error)}` };
			}
			if (problems.length > 0) return { outcome: 'rejected', failures: [], results: statics, diagnostics: problems };
		}
		const tweaked = await deps.injector.inject(baseline, tweak.css);
		running.push(tweaked);
		let report: VerifyReport;
		try {
			report = await deps.verifier.verify({ baseline, variant: tweaked, spec: tweakAsSpec(spec, config), evidenceDir: `${deps.evidenceDir}/${spec.id}` });
		} catch (error) {
			const code = error instanceof StageError ? `${error.code}: ` : '';
			return { outcome: 'aborted', reason: `${code}${error instanceof Error ? error.message : String(error)}` };
		}
		if (!report.baselinePassed) {
			return { outcome: 'aborted', reason: `The suite fails on the site without the tweak: ${report.baselineResults.filter((r) => !r.passed).map((r) => r.check).join(', ')}` };
		}
		const results = [...statics, ...report.results];
		const failures = results.filter((r) => !r.passed);
		if (!report.passed || failures.length > 0) return { outcome: 'rejected', failures, results, diagnostics: [] };
		const record: TweakRecord = {
			spec,
			css: tweak.css,
			verifiedAt: (deps.now?.() ?? new Date()).toISOString(),
			siteCommit: deps.site.commit,
			checks: results.map((r) => r.check),
		};
		return { outcome: 'verified', record, results };
	} finally {
		for (const site of running.toReversed()) await site.stop().catch(() => undefined);
	}
}

/** Validates a stored tweak record from outside (a request body, a file). Null when malformed. */
export function parseTweakRecord(value: unknown, config: Pick<LabConfig, 'tweaks'>): TweakRecord | null {
	if (!isObject(value)) return null;
	const { spec } = validateTweakSpec(value.spec);
	if (!spec || typeof value.css !== 'string' || typeof value.verifiedAt !== 'string' || Number.isNaN(Date.parse(value.verifiedAt))) return null;
	if (typeof value.siteCommit !== 'string' || !Array.isArray(value.checks) || !value.checks.every((c) => typeof c === 'string')) return null;
	if (checkTweakCss(value.css, config).some((r) => !r.passed)) return null;
	return { spec, css: value.css, verifiedAt: value.verifiedAt, siteCommit: value.siteCommit, checks: value.checks as string[] };
}
