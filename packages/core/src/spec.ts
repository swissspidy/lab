import type { Diagnostic, ExperimentSpec, LabConfig, LedgerEvent } from './types.ts';
import { SLOT, WEBSITE_SCOPES, isWebsiteScope } from './website.ts';

const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A value for a message: strings as they are, anything else by its type, never through its own toString. */
const show = (v: unknown): string => (typeof v === 'string' ? v : `(${v === null ? 'null' : typeof v})`);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function validTarget(t: unknown): boolean {
	if (!isObject(t)) return false;
	const keys = Object.keys(t);
	if ('role' in t) return isText(t.role) && keys.every((k) => ['role', 'name', 'exact'].includes(k)) && (t.name === undefined || isText(t.name)) && (t.exact === undefined || typeof t.exact === 'boolean');
	if ('label' in t) return isText(t.label) && keys.length === 1;
	if ('text' in t) return isText(t.text) && keys.every((k) => ['text', 'exact'].includes(k)) && (t.exact === undefined || typeof t.exact === 'boolean');
	if ('css' in t) return isText(t.css) && keys.length === 1;
	return false;
}

function stepProblem(s: unknown): string | null {
	if (!isObject(s)) return 'a step must be an object';
	switch (s.do) {
		case 'click':
			return validTarget(s.target) && Object.keys(s).length === 2 ? null : 'a `click` step needs a `target`';
		case 'fill':
			return validTarget(s.target) && typeof s.value === 'string' && Object.keys(s).length === 3 ? null : 'a `fill` step needs a `target` and a `value`';
		case 'press':
			return validTarget(s.target) && isText(s.key) && Object.keys(s).length === 3 ? null : 'a `press` step needs a `target` and a `key`';
		case 'goto':
			return validPage(s.page) && Object.keys(s).length === 2 ? null : 'a `goto` step needs a relative `page`';
		default:
			return `unknown step \`${show(s.do)}\``;
	}
}

function validPage(p: unknown): boolean {
	return isText(p) && !/^[a-z]+:/i.test(p) && !p.startsWith('/') && !p.startsWith('//') && !p.split('/').includes('..');
}

function assertionProblem(a: unknown): string | null {
	if (!isObject(a)) return 'an assertion must be an object';
	const keys = new Set(Object.keys(a));
	const only = (...allowed: string[]) => [...keys].every((k) => k === 'expect' || allowed.includes(k));
	switch (a.expect) {
		case 'visible':
		case 'hidden':
		case 'in-viewport':
			return validTarget(a.target) && only('target') ? null : `\`${a.expect}\` needs a \`target\``;
		case 'text':
			return validTarget(a.target) && only('target', 'equals', 'contains') && (typeof a.equals === 'string') !== (typeof a.contains === 'string')
				? null
				: '`text` needs a `target` and exactly one of `equals` or `contains`';
		case 'count':
			return validTarget(a.target) && only('target', 'equals') && Number.isInteger(a.equals) && (a.equals as number) >= 0 ? null : '`count` needs a `target` and a whole number `equals`';
		case 'attribute':
			return validTarget(a.target) && only('target', 'name', 'equals') && isText(a.name) && typeof a.equals === 'string' ? null : '`attribute` needs a `target`, a `name` and `equals`';
		case 'clipboard':
			return only('equals') && typeof a.equals === 'string' ? null : '`clipboard` needs `equals`';
		case 'url':
			return only('endsWith') && isText(a.endsWith) ? null : '`url` needs `endsWith`';
		default:
			return `unknown assertion \`${show(a.expect)}\``;
	}
}

/** Normalized intent, to spot a proposal that repeats an earlier one. */
export function intentKey(intent: string): string {
	return intent.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Checks a spec's acceptance checks: each well formed, each naming a
 * criterion, and every criterion covered. Shared by experiment specs and
 * personal tweaks.
 */
export function validateChecks(checks: unknown, count: number, error: (code: string, path: string, message: string) => void): void {
	if (!Array.isArray(checks)) {
		error('spec-checks', 'checks', '`checks` must list acceptance checks.');
	} else {
		const covered = new Set<number>();
		for (const [i, c] of checks.entries()) {
			const path = `checks.${i}`;
			if (!isObject(c)) {
				error('spec-check-invalid', path, 'A check must be an object.');
				continue;
			}
			for (const key of Object.keys(c)) if (!['criterion', 'page', 'viewport', 'steps', 'expect'].includes(key)) error('spec-check-invalid', `${path}.${key}`, `Unknown key \`${key}\`.`);
			if (!Number.isInteger(c.criterion) || (c.criterion as number) < 0 || (c.criterion as number) >= count) {
				error('spec-check-invalid', `${path}.criterion`, '`criterion` must be the index of an acceptance criterion.');
			} else {
				covered.add(c.criterion as number);
			}
			if (!validPage(c.page)) error('spec-check-invalid', `${path}.page`, '`page` must be a relative page of the site, such as `index.html`.');
			if (c.viewport !== undefined && !(isObject(c.viewport) && Number.isInteger(c.viewport.width) && Number.isInteger(c.viewport.height) && (c.viewport.width as number) > 0 && (c.viewport.height as number) > 0)) {
				error('spec-check-invalid', `${path}.viewport`, '`viewport` must be `{ width, height }` in pixels.');
			}
			if (c.steps !== undefined) {
				if (!Array.isArray(c.steps)) error('spec-check-invalid', `${path}.steps`, '`steps` must be a list.');
				else for (const [j, s] of c.steps.entries()) {
					const problem = stepProblem(s);
					if (problem) error('spec-check-invalid', `${path}.steps.${j}`, `Invalid step: ${problem}.`);
				}
			}
			if (!Array.isArray(c.expect) || c.expect.length === 0) {
				error('spec-check-invalid', `${path}.expect`, '`expect` must list at least one assertion.');
			} else {
				for (const [j, a] of c.expect.entries()) {
					const problem = assertionProblem(a);
					if (problem) error('spec-check-invalid', `${path}.expect.${j}`, `Invalid assertion: ${problem}.`);
				}
			}
		}
		for (let i = 0; i < count; i++) {
			if (!covered.has(i)) error('spec-criterion-unchecked', `acceptance.${i}`, `Criterion ${i} has no check. Every criterion needs one that can be checked objectively.`);
		}
	}
}

/**
 * Checks a proposed spec against the config and the ledger. A spec with
 * errors never reaches Build.
 */
export function validateSpec(raw: unknown, config: LabConfig, history: LedgerEvent[] = []): { spec: ExperimentSpec | null; diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];
	const error = (code: string, path: string, message: string) => diagnostics.push({ code, severity: 'error', path, message });
	if (!isObject(raw)) {
		error('spec-not-object', '', 'A spec must be a JSON object.');
		return { spec: null, diagnostics };
	}
	const allowed = new Set(['id', 'hypothesis', 'intent', 'acceptance', 'expectedEffect', 'touches', 'mount', 'permissions', 'source', 'checks']);
	for (const key of Object.keys(raw)) if (!allowed.has(key)) error('spec-unknown-key', key, `Unknown key \`${key}\`.`);
	if (typeof raw.id !== 'string' || !ID.test(raw.id)) error('spec-id', 'id', '`id` must look like `exp-0007`: lowercase letters, digits and dashes.');
	for (const key of ['hypothesis', 'intent'] as const) if (!isText(raw[key])) error('spec-missing-text', key, `\`${key}\` must be a non-empty sentence.`);
	if (!Array.isArray(raw.acceptance) || raw.acceptance.length === 0 || !raw.acceptance.every(isText)) {
		error('spec-acceptance', 'acceptance', '`acceptance` must list at least one criterion.');
	}
	const effect = new RegExp(`^${config.metric.id} (up|down)$`);
	if (typeof raw.expectedEffect !== 'string' || !effect.test(raw.expectedEffect)) {
		error('spec-effect', 'expectedEffect', `\`expectedEffect\` must be \`${config.metric.id} up\` or \`${config.metric.id} down\`.`);
	}
	if (!Array.isArray(raw.touches) || !raw.touches.every(isText)) error('spec-touches', 'touches', '`touches` must list the paths the change touches.');
	if (typeof raw.mount !== 'string' || !SLOT.test(raw.mount)) error('spec-mount', 'mount', '`mount` must be `site`, or the slot of one page, such as `page.index` or `page.docs`.');
	if (!Array.isArray(raw.permissions) || raw.permissions.length === 0) {
		error('spec-permissions', 'permissions', `\`permissions\` must list the kinds of files the change touches: ${Object.keys(WEBSITE_SCOPES).join(', ')}.`);
	} else {
		for (const [i, scope] of raw.permissions.entries()) {
			if (!isWebsiteScope(scope)) error('spec-permission-unknown', `permissions.${i}`, `Unknown permission \`${show(scope)}\`. Available: ${Object.keys(WEBSITE_SCOPES).join(', ')}.`);
		}
		if (new Set(raw.permissions).size !== raw.permissions.length) error('spec-permissions', 'permissions', '`permissions` lists a scope twice.');
	}
	if (raw.source !== 'agent' && raw.source !== 'visitors') error('spec-source', 'source', '`source` must be `agent` or `visitors`.');
	validateChecks(raw.checks, Array.isArray(raw.acceptance) ? raw.acceptance.length : 0, error);

	if (diagnostics.length === 0) {
		const spec = raw as unknown as ExperimentSpec;
		const proposed = history.filter((e) => e.type === 'proposed');
		if (proposed.some((e) => e.experiment === spec.id)) {
			error('spec-id-taken', 'id', `${spec.id} is already in the ledger. Pick a new id.`);
		}
		const reverted = new Set(history.filter((e) => e.type === 'reverted').map((e) => e.experiment));
		const key = intentKey(spec.intent);
		for (const event of proposed) {
			const earlier = (event.payload.spec as { intent?: unknown } | undefined)?.intent;
			if (reverted.has(event.experiment) && typeof earlier === 'string' && intentKey(earlier) === key) {
				error('spec-repeats-reverted', 'intent', `This repeats ${event.experiment}, which was reverted. Propose something else.`);
			}
		}
	}
	return { spec: diagnostics.length === 0 ? (raw as unknown as ExperimentSpec) : null, diagnostics };
}
