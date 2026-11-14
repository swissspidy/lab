// M5's entry criteria for `autonomy: 'auto'`, read from the ledger. Until
// they all hold, an auto site behaves exactly like a gated one: verified
// experiments wait for a person.
import type { LedgerEvent } from './types.ts';

export const REQUIRED_GATED_LOOPS = 3;

export interface EntryCheck {
	id: 'gated-loops' | 'no-escapes' | 'kill-tested';
	met: boolean;
	detail: string;
}

export interface AutonomyEntry {
	met: boolean;
	checks: EntryCheck[];
}

export function autonomyEntry(events: LedgerEvent[]): AutonomyEntry {
	const approvedBy = new Map<string, string>();
	for (const e of events) if (e.type === 'approved') approvedBy.set(e.experiment, String(e.payload.by ?? ''));
	const shipped = new Set(events.filter((e) => e.type === 'shipped').map((e) => e.experiment));
	const finished = events.filter((e) => shipped.has(e.experiment) && (e.type === 'kept' || (e.type === 'reverted' && e.payload.reason === 'decision')));
	const gated = finished.filter((e) => approvedBy.has(e.experiment) && approvedBy.get(e.experiment) !== 'auto');
	// An escape: a shipped variant that hurt visitors in production badly enough to trip a guardrail.
	const escapes = events.filter((e) => e.type === 'reverted' && e.payload.reason === 'guardrail').map((e) => e.experiment);
	const kills = events.filter((e) => e.type === 'reverted' && e.payload.reason === 'kill').map((e) => e.experiment);
	const checks: EntryCheck[] = [
		{
			id: 'gated-loops',
			met: gated.length >= REQUIRED_GATED_LOOPS,
			detail: `${gated.length} experiment(s) completed the full loop with a person's approval; ${REQUIRED_GATED_LOOPS} needed.`,
		},
		{
			id: 'no-escapes',
			met: escapes.length === 0,
			detail: escapes.length === 0 ? 'No shipped variant has tripped a guardrail.' : `Guardrails rolled back ${escapes.join(', ')}.`,
		},
		{
			id: 'kill-tested',
			met: kills.length > 0,
			detail: kills.length > 0 ? `The kill switch stopped ${kills.join(', ')}.` : 'The kill switch has not been used on a live experiment yet. Ship one and run `lab kill`.',
		},
	];
	return { met: checks.every((c) => c.met), checks };
}
