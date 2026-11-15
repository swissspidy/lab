// The proxy's decision, kept free of Next.js so it can be tested alone.
import { createHash, randomBytes } from 'node:crypto';

export const COOKIE_VISITOR = 'lab_vid';
export const COOKIE_EXPERIMENT = 'lab_exp';
export const COOKIE_BUCKET = 'lab_bucket';
export const BEACON_PATH = '/_lab/beacon';

export type Bucket = 'baseline' | 'variant';

/** What the lab's state endpoint returns. `origin` is where the variant is served. */
export interface LabState {
	live: { experiment: string; share: number; origin?: string } | null;
}

const VISITOR = /^[0-9a-f]{32}$/;
const EXPERIMENT = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Sticky bucketing; the same function as the lab's reference host. */
export function assignBucket(visitorId: string, experiment: string, share: number): Bucket {
	const hash = createHash('sha256').update(`${experiment}:${visitorId}`).digest();
	return hash.readUInt32BE(0) / 2 ** 32 < share ? 'variant' : 'baseline';
}

export const newVisitorId = (): string => randomBytes(16).toString('hex');

export interface Decision {
	visitor: string;
	/** True when the visitor id is new and its cookie must be set. */
	newVisitor: boolean;
	experiment: string;
	bucket: Bucket;
	/** The variant's origin to rewrite to, or null to serve this app. */
	rewriteTo: string | null;
}

/** Validates a state document. Anything unexpected means: no experiment, serve the baseline. */
export function parseState(value: unknown): LabState {
	if (typeof value !== 'object' || value === null) return { live: null };
	const live = (value as { live?: unknown }).live as Record<string, unknown> | null | undefined;
	if (!live || typeof live !== 'object') return { live: null };
	const { experiment, share, origin } = live;
	if (typeof experiment !== 'string' || !EXPERIMENT.test(experiment)) return { live: null };
	if (typeof share !== 'number' || !(share >= 0 && share <= 1)) return { live: null };
	if (origin !== undefined) {
		try {
			const url = new URL(String(origin));
			if (url.protocol !== 'http:' && url.protocol !== 'https:') return { live: null };
		} catch {
			return { live: null };
		}
	}
	return { live: { experiment, share, ...(typeof origin === 'string' ? { origin } : {}) } };
}

export function decide(visitorCookie: string | undefined, state: LabState): Decision {
	const newVisitor = !visitorCookie || !VISITOR.test(visitorCookie);
	const visitor = newVisitor ? newVisitorId() : visitorCookie!;
	const live = state.live;
	if (!live) return { visitor, newVisitor, experiment: '', bucket: 'baseline', rewriteTo: null };
	const bucket = assignBucket(visitor, live.experiment, live.share);
	// A variant with no origin to serve it from cannot be shown: serve the baseline.
	const rewriteTo = bucket === 'variant' && live.origin ? live.origin : null;
	return { visitor, newVisitor, experiment: live.experiment, bucket: rewriteTo ? 'variant' : 'baseline', rewriteTo };
}
