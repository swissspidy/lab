import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LEDGER_EVENT_TYPES } from './types.ts';
import type { Diagnostic, Ledger, LedgerEvent, LedgerEventInput, LedgerEventType } from './types.ts';

export const LEDGER_FILE = 'lab/ledger.jsonl';

/** JSON with object keys sorted at every level, so a hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

export function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export function hashEvent(event: Omit<LedgerEvent, 'hash'>): string {
	return sha256(canonicalJson(event));
}

/**
 * Which event may follow which, per experiment. `start` is "no event yet".
 * An experiment whose last event has no successors is finished.
 */
export const TRANSITIONS: Record<LedgerEventType | 'start', readonly LedgerEventType[]> = {
	start: ['proposed'],
	proposed: ['built', 'aborted'],
	built: ['verify_passed', 'verify_failed', 'aborted'],
	verify_failed: [],
	// In `propose-only` mode the loop stops here and opens a pull request.
	verify_passed: ['approved', 'aborted'],
	approved: ['shipped', 'aborted'],
	shipped: ['measured', 'reverted', 'aborted'],
	measured: ['measured', 'kept', 'reverted', 'aborted'],
	kept: [],
	reverted: [],
	aborted: [],
};

/**
 * States an iteration of the loop may end in. Anything else means the loop
 * stopped half way through an experiment.
 */
export const SETTLED: ReadonlySet<LedgerEventType> = new Set(['verify_failed', 'verify_passed', 'kept', 'reverted', 'aborted']);

const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Checks one event's fields, not its place in the ledger. */
export function validateEventShape(event: unknown, where: string): Diagnostic[] {
	const problems: string[] = [];
	if (typeof event !== 'object' || event === null || Array.isArray(event)) {
		return [{ code: 'ledger-invalid-event', severity: 'error', path: where, message: 'An event must be a JSON object.' }];
	}
	const e = event as Record<string, unknown>;
	const allowed = new Set(['v', 'seq', 'type', 'experiment', 'at', 'siteCommit', 'patchHash', 'payload', 'prev', 'hash']);
	for (const key of Object.keys(e)) {
		if (!allowed.has(key)) problems.push(`unknown field \`${key}\``);
	}
	if (e.v !== 1) problems.push('`v` must be 1');
	if (!Number.isInteger(e.seq) || (e.seq as number) < 0) problems.push('`seq` must be a whole number from 0');
	if (!LEDGER_EVENT_TYPES.includes(e.type as LedgerEventType)) problems.push(`\`type\` must be one of ${LEDGER_EVENT_TYPES.join(', ')}`);
	if (typeof e.experiment !== 'string' || !ID.test(e.experiment)) problems.push('`experiment` must be an id like `exp-0007`');
	if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) problems.push('`at` must be an ISO 8601 timestamp');
	if (typeof e.siteCommit !== 'string' || e.siteCommit.length === 0) problems.push('`siteCommit` must be a commit id');
	if (e.patchHash !== null && (typeof e.patchHash !== 'string' || !HEX64.test(e.patchHash))) {
		problems.push('`patchHash` must be a sha256 hex digest or null');
	}
	if (typeof e.payload !== 'object' || e.payload === null || Array.isArray(e.payload)) problems.push('`payload` must be an object');
	if (e.prev !== null && (typeof e.prev !== 'string' || !HEX64.test(e.prev))) problems.push('`prev` must be a sha256 hex digest or null');
	if (typeof e.hash !== 'string' || !HEX64.test(e.hash)) problems.push('`hash` must be a sha256 hex digest');
	if (problems.length === 0) {
		const payload = e.payload as Record<string, unknown>;
		if (e.type === 'proposed' && payload.source !== 'agent' && payload.source !== 'visitors') {
			problems.push('a `proposed` event needs `payload.source`: `agent` or `visitors`');
		}
		if (e.type === 'verify_failed' && !(Array.isArray(payload.failures) && payload.failures.length > 0)) {
			problems.push('a `verify_failed` event needs `payload.failures`, naming each failing check and its evidence');
		}
		if (e.type !== 'proposed' && e.type !== 'aborted' && e.patchHash === null) {
			problems.push(`a \`${String(e.type)}\` event needs \`patchHash\``);
		}
	}
	return problems.map((p) => ({ code: 'ledger-invalid-event', severity: 'error', path: where, message: `Invalid event: ${p}.` }));
}

/**
 * Checks a whole ledger: each event's shape, the hash chain, the sequence and
 * each experiment's lifecycle. Any edit or deletion breaks the chain.
 */
export function checkLedger(events: unknown[]): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const state = new Map<string, LedgerEventType>();
	let prevHash: string | null = null;
	for (const [i, raw] of events.entries()) {
		const where = `ledger:${i + 1}`;
		const shape = validateEventShape(raw, where);
		if (shape.length > 0) {
			diagnostics.push(...shape);
			return diagnostics;
		}
		const event = raw as LedgerEvent;
		const { hash, ...rest } = event;
		if (event.seq !== i) {
			diagnostics.push({ code: 'ledger-seq-gap', severity: 'error', path: where, message: `Expected seq ${i}, found ${event.seq}. An event was removed or reordered.` });
		}
		if (event.prev !== prevHash) {
			diagnostics.push({ code: 'ledger-chain-broken', severity: 'error', path: where, message: 'This event does not point at the one before it. The ledger was edited; restore it from git.' });
		}
		if (hashEvent(rest) !== hash) {
			diagnostics.push({ code: 'ledger-hash-mismatch', severity: 'error', path: where, message: 'This event\'s content does not match its hash. It was edited; restore the ledger from git.' });
		}
		const from = state.get(event.experiment) ?? 'start';
		if (!TRANSITIONS[from].includes(event.type)) {
			diagnostics.push({
				code: 'ledger-invalid-transition',
				severity: 'error',
				path: where,
				message: `\`${event.type}\` cannot follow \`${from === 'start' ? 'nothing' : from}\` for ${event.experiment}. Allowed: ${TRANSITIONS[from].join(', ') || 'none, the experiment is finished'}.`,
			});
		}
		state.set(event.experiment, event.type);
		prevHash = hash;
	}
	return diagnostics;
}

/** Each experiment's latest event type. */
export function experimentStates(events: LedgerEvent[]): Map<string, LedgerEventType> {
	const states = new Map<string, LedgerEventType>();
	for (const event of events) states.set(event.experiment, event.type);
	return states;
}

export class LedgerError extends Error {
	readonly diagnostics: Diagnostic[];
	constructor(diagnostics: Diagnostic[]) {
		super(diagnostics.map((d) => `${d.path ?? ''} ${d.code}: ${d.message}`.trim()).join('\n'));
		this.name = 'LedgerError';
		this.diagnostics = diagnostics;
	}
}

/**
 * An append-only JSON Lines ledger. It refuses to append to a ledger that
 * fails `checkLedger`, and refuses events that would break an experiment's
 * lifecycle.
 */
export class FileLedger implements Ledger {
	readonly file: string;
	private readonly now: () => Date;

	constructor(file: string, options: { now?: () => Date } = {}) {
		this.file = file;
		this.now = options.now ?? (() => new Date());
	}

	async read(): Promise<{ events: LedgerEvent[]; diagnostics: Diagnostic[] }> {
		if (!existsSync(this.file)) return { events: [], diagnostics: [] };
		const text = await readFile(this.file, 'utf8');
		const lines = text.split('\n');
		if (lines.at(-1) === '') lines.pop();
		const parsed: unknown[] = [];
		for (const [i, line] of lines.entries()) {
			try {
				parsed.push(JSON.parse(line));
			} catch {
				return {
					events: [],
					diagnostics: [{ code: 'ledger-invalid-json', severity: 'error', path: `ledger:${i + 1}`, message: 'This line is not JSON. Restore the ledger from git.' }],
				};
			}
		}
		const diagnostics = checkLedger(parsed);
		return { events: parsed as LedgerEvent[], diagnostics };
	}

	async history(): Promise<LedgerEvent[]> {
		const { events, diagnostics } = await this.read();
		if (diagnostics.length > 0) throw new LedgerError(diagnostics);
		return events;
	}

	async append(input: LedgerEventInput): Promise<LedgerEvent> {
		const events = await this.history();
		const last = events.at(-1);
		const body: Omit<LedgerEvent, 'hash'> = {
			v: 1,
			seq: events.length,
			type: input.type,
			experiment: input.experiment,
			at: input.at ?? this.now().toISOString(),
			siteCommit: input.siteCommit,
			patchHash: input.patchHash,
			payload: input.payload,
			prev: last?.hash ?? null,
		};
		const event: LedgerEvent = { ...body, hash: hashEvent(body) };
		const diagnostics = checkLedger([...events, event]);
		if (diagnostics.length > 0) throw new LedgerError(diagnostics);
		mkdirSync(dirname(this.file), { recursive: true });
		await appendFile(this.file, `${JSON.stringify(event)}\n`, { flag: 'a' });
		return event;
	}
}
