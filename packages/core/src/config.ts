import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Diagnostic, LabConfig } from './types.ts';

export const CONFIG_FILE = 'lab.config.ts';

/**
 * Paths the agent may never change, whatever the site config says: its own
 * checks, its memory, its config, dependencies and CI.
 */
export const ALWAYS_DENIED = [
	'lab/**',
	'lab.config.*',
	'**/package.json',
	'**/package-lock.json',
	'**/pnpm-lock.yaml',
	'**/yarn.lock',
	'.github/**',
	'.git/**',
] as const;

export const DEFAULTS = {
	guardrailMetrics: [] as string[],
	invariants: 'lab/invariants/',
	limits: { maxChangedLines: 200, maxFiles: 5 },
	viewports: [
		{ width: 1280, height: 800 },
		{ width: 390, height: 844 },
	],
	autonomy: 'gated' as const,
	intervalHours: 24,
	minDetectableEffect: 0.2,
	rollback: { jsErrorMargin: 0.02, bounceMargin: 0.1, minVisits: 100 },
};

/** The guardrail metrics the reference meter can measure. */
export const GUARDRAIL_METRICS = ['js_error_rate', 'bounce'] as const;

/** The largest variant share v0 allows. The variant stays the minority. */
export const MAX_SHARE = 0.5;

export interface ConfigResult {
	config: LabConfig | null;
	diagnostics: Diagnostic[];
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks a raw config object and fills in defaults. Unknown keys are errors:
 * a typo in a safety setting must not fall back to a default silently.
 */
export function validateConfig(raw: unknown): ConfigResult {
	const diagnostics: Diagnostic[] = [];
	const error = (code: string, path: string, message: string) =>
		diagnostics.push({ code, severity: 'error', path, message });
	const warn = (code: string, path: string, message: string) =>
		diagnostics.push({ code, severity: 'warning', path, message });

	if (!isObject(raw)) {
		error('config-not-object', '', 'The config must default-export an object.');
		return { config: null, diagnostics };
	}

	const shape: Record<string, Record<string, string> | string> = {
		site: { repo: 'string', build: 'string', outDir: 'string', check: 'string?' },
		metric: { id: 'string', kind: 'string' },
		guardrailMetrics: 'string[]',
		allow: 'string[]',
		deny: 'string[]',
		invariants: 'string',
		budgets: { lcpMs: 'number', cls: 'number', axeViolations: 'number', bundleKbDelta: 'number' },
		traffic: { share: 'number', minSamplesPerBucket: 'number', maxDays: 'number', intervalHours: 'number?', minDetectableEffect: 'number?' },
		rollback: { jsErrorMargin: 'number?', bounceMargin: 'number?', minVisits: 'number?' },
		limits: { maxChangedLines: 'number', maxFiles: 'number' },
		viewports: 'viewport[]',
		autonomy: 'string',
	};
	const required = new Set(['site', 'metric', 'allow', 'deny', 'budgets', 'traffic']);

	const checkType = (value: unknown, type: string, path: string): boolean => {
		const ok =
			type === 'string'
				? typeof value === 'string' && value.length > 0
				: type === 'number'
					? typeof value === 'number' && Number.isFinite(value)
					: type === 'string[]'
						? Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)
						: Array.isArray(value) &&
							value.length > 0 &&
							value.every(
								(v) =>
									isObject(v) &&
									Object.keys(v).length === 2 &&
									Number.isInteger(v.width) &&
									Number.isInteger(v.height) &&
									(v.width as number) > 0 &&
									(v.height as number) > 0,
							);
		if (!ok) {
			const expected =
				type === 'viewport[]' ? 'a non-empty list of { width, height } in pixels' : `a ${type === 'string' ? 'non-empty string' : type}`;
			error('config-invalid-type', path, `\`${path}\` must be ${expected}.`);
		}
		return ok;
	};

	for (const key of Object.keys(raw)) {
		if (!(key in shape)) {
			error('config-unknown-key', key, `Unknown key \`${key}\`. Remove it or fix the spelling.`);
		}
	}

	for (const [key, type] of Object.entries(shape)) {
		const value = raw[key];
		if (value === undefined) {
			if (required.has(key)) {
				error('config-missing-key', key, `\`${key}\` is required.`);
			}
			continue;
		}
		if (typeof type === 'string') {
			checkType(value, type, key);
			continue;
		}
		if (!isObject(value)) {
			error('config-invalid-type', key, `\`${key}\` must be an object.`);
			continue;
		}
		for (const sub of Object.keys(value)) {
			if (!(sub in type)) {
				error('config-unknown-key', `${key}.${sub}`, `Unknown key \`${key}.${sub}\`. Remove it or fix the spelling.`);
			}
		}
		for (const [sub, subType] of Object.entries(type)) {
			const path = `${key}.${sub}`;
			const optional = subType.endsWith('?');
			if (value[sub] === undefined) {
				if (!optional) error('config-missing-key', path, `\`${path}\` is required.`);
				continue;
			}
			checkType(value[sub], optional ? subType.slice(0, -1) : subType, path);
		}
	}

	if (diagnostics.some((d) => d.severity === 'error')) {
		return { config: null, diagnostics };
	}

	const rawTraffic = raw.traffic as Raw;
	const config = {
		guardrailMetrics: DEFAULTS.guardrailMetrics,
		invariants: DEFAULTS.invariants,
		limits: DEFAULTS.limits,
		viewports: DEFAULTS.viewports,
		autonomy: DEFAULTS.autonomy,
		...raw,
		traffic: { intervalHours: DEFAULTS.intervalHours, minDetectableEffect: DEFAULTS.minDetectableEffect, ...rawTraffic },
		rollback: { ...DEFAULTS.rollback, ...(isObject(raw.rollback) ? raw.rollback : {}) },
	} as LabConfig;

	// Value checks, now that the types are known to be right.
	if (config.metric.kind !== 'conversion') {
		error('config-metric-kind', 'metric.kind', 'v0 supports only `conversion` metrics: a binary outcome per visit.');
	}
	if (!['propose-only', 'gated', 'auto'].includes(config.autonomy)) {
		error('config-autonomy', 'autonomy', '`autonomy` must be `propose-only`, `gated` or `auto`.');
	}
	if (config.autonomy === 'auto') {
		warn(
			'config-autonomy-auto',
			'autonomy',
			'`auto` takes effect only once the ledger meets the entry criteria (three gated loops, no escapes, a tested kill switch). Until then experiments wait for `lab approve`. `lab doctor` shows which criteria are met.',
		);
	}
	const { share, minSamplesPerBucket, maxDays } = config.traffic;
	if (!(share > 0 && share <= MAX_SHARE)) {
		error('config-traffic-share', 'traffic.share', `\`traffic.share\` must be above 0 and at most ${MAX_SHARE}.`);
	}
	if (!Number.isInteger(minSamplesPerBucket) || minSamplesPerBucket < 100) {
		error('config-traffic-samples', 'traffic.minSamplesPerBucket', '`traffic.minSamplesPerBucket` must be a whole number of at least 100.');
	}
	if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 90) {
		error('config-traffic-days', 'traffic.maxDays', '`traffic.maxDays` must be a whole number from 1 to 90.');
	}
	const { intervalHours, minDetectableEffect } = config.traffic;
	if (!(intervalHours > 0 && intervalHours <= 24 && 24 % intervalHours === 0)) {
		error('config-traffic-interval', 'traffic.intervalHours', '`traffic.intervalHours` must divide a day: 1, 2, 3, 4, 6, 8, 12 or 24.');
	}
	if (!(minDetectableEffect > 0 && minDetectableEffect <= 1)) {
		error('config-traffic-mde', 'traffic.minDetectableEffect', '`traffic.minDetectableEffect` must be a relative lift above 0 and at most 1.');
	}
	for (const [key, value] of Object.entries(config.rollback)) {
		if (!(value >= 0) || (key !== 'minVisits' && value > 1) || (key === 'minVisits' && !Number.isInteger(value))) {
			error('config-rollback', `rollback.${key}`, key === 'minVisits' ? '`rollback.minVisits` must be a whole number.' : `\`rollback.${key}\` must be a rate difference from 0 to 1.`);
		}
	}
	for (const [i, metric] of config.guardrailMetrics.entries()) {
		if (!(GUARDRAIL_METRICS as readonly string[]).includes(metric)) {
			error('config-guardrail-unknown', `guardrailMetrics.${i}`, `\`${metric}\` is not a guardrail the lab measures. Use ${GUARDRAIL_METRICS.join(' or ')}.`);
		}
	}
	const { lcpMs, cls, axeViolations, bundleKbDelta } = config.budgets;
	for (const [path, value] of [
		['budgets.lcpMs', lcpMs],
		['budgets.cls', cls],
		['budgets.axeViolations', axeViolations],
		['budgets.bundleKbDelta', bundleKbDelta],
	] as const) {
		if (value < 0) {
			error('config-budget-negative', path, `\`${path}\` cannot be negative.`);
		}
	}
	if (axeViolations !== 0) {
		warn('config-budget-axe', 'budgets.axeViolations', 'Variants may add aXe violations. The brief asks for zero new violations.');
	}
	const { maxChangedLines, maxFiles } = config.limits;
	if (!Number.isInteger(maxChangedLines) || maxChangedLines < 1) {
		error('config-limits', 'limits.maxChangedLines', '`limits.maxChangedLines` must be a positive whole number.');
	}
	if (!Number.isInteger(maxFiles) || maxFiles < 1) {
		error('config-limits', 'limits.maxFiles', '`limits.maxFiles` must be a positive whole number.');
	}
	if (config.allow.length === 0) {
		error('config-allow-empty', 'allow', '`allow` is empty, so the agent could change nothing. List the paths it may change.');
	}
	for (const [i, pattern] of config.allow.entries()) {
		if (pattern.startsWith('/') || pattern.split('/').includes('..')) {
			error('config-allow-outside', `allow.${i}`, `\`${pattern}\` points outside the site repo. Use a path relative to it.`);
		}
		if (pattern === '**' || pattern === '**/*') {
			error('config-allow-everything', `allow.${i}`, `\`${pattern}\` allows every file. List the directories the agent may change.`);
		}
	}

	return { config: diagnostics.some((d) => d.severity === 'error') ? null : config, diagnostics };
}

/** The effective deny list: the site's own patterns plus `ALWAYS_DENIED`. */
export function effectiveDeny(config: LabConfig): string[] {
	return [...new Set([...ALWAYS_DENIED, ...config.deny])];
}

export interface LoadedConfig extends ConfigResult {
	/** Absolute path of the config file. */
	file: string;
	/** Absolute path of the site repo the config describes. */
	siteDir: string;
}

/** Loads `lab.config.ts` from a directory, or a config file given directly. */
export async function loadConfig(path: string): Promise<LoadedConfig> {
	const absolute = resolve(path);
	const file = existsSync(absolute) && statSync(absolute).isDirectory() ? resolve(absolute, CONFIG_FILE) : absolute;
	const base = { file, siteDir: dirname(file) };
	if (!existsSync(file)) {
		return {
			...base,
			config: null,
			diagnostics: [{ code: 'config-missing', severity: 'error', path: file, message: `No config at ${file}. Create ${CONFIG_FILE} in the site repo.` }],
		};
	}
	let raw: unknown;
	try {
		const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
		raw = mod.default;
	} catch (cause) {
		return {
			...base,
			config: null,
			diagnostics: [
				{
					code: 'config-load-failed',
					severity: 'error',
					path: file,
					message: `Could not load ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
				},
			],
		};
	}
	const result = validateConfig(raw);
	const siteDir = result.config ? resolve(dirname(file), result.config.site.repo) : base.siteDir;
	if (result.config) {
		const invariants = resolve(siteDir, result.config.invariants);
		if (!existsSync(invariants)) {
			result.diagnostics.push({
				code: 'config-invariants-missing',
				severity: 'warning',
				path: 'invariants',
				message: `No invariants at ${invariants}. Verify rejects every variant until the site has invariants.`,
			});
		}
	}
	return { ...result, file, siteDir };
}
