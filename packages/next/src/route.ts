// Where the proxy routes a request, kept free of Next.js so it can be tested alone.
import { createHash, randomBytes } from 'node:crypto';

export const COOKIE_VISITOR = 'lab_vid';
export const COOKIE_EXPERIMENT = 'lab_exp';
export const COOKIE_BUCKET = 'lab_bucket';
export const BEACON_PATH = '/_lab/beacon';
/** The visitor's personal tweaks, as a comma-separated list of ids. Readable by the page's script. */
export const COOKIE_TWEAKS = 'lab_tweaks';
/** `GET /_lab/tweak/<id>` opts in (`?off` opts out; `/_lab/tweak/off` drops every tweak). */
export const TWEAK_OPT_IN = '/_lab/tweak/';
/** `GET /_lab/tweaks/<id>.css` serves a tweak's stylesheet from the lab. */
export const TWEAK_CSS = '/_lab/tweaks/';
export const MAX_TWEAKS = 5;
const TWEAK_ID = /^tw-[0-9a-f]{12}$/;

/** The valid tweak ids in a cookie value, at most MAX_TWEAKS, without repeats. */
export function parseTweaks(cookie: string | undefined): string[] {
	return [...new Set((cookie ?? '').split(',').filter((id) => TWEAK_ID.test(id)))].slice(0, MAX_TWEAKS);
}

export const isTweakId = (id: string): boolean => TWEAK_ID.test(id);

/**
 * The stylesheets of a visitor's tweaks, from the lab_tweaks cookie, for a
 * server-rendered layout to put in <head> so the tweaks apply before the
 * first paint. Render each as `<link rel="stylesheet" href={href}
 * data-lab-tweak={id} />`; the beacon script skips the ones already there.
 */
export function tweakStylesheets(cookie: string | undefined): Array<{ id: string; href: string }> {
	return parseTweaks(cookie).map((id) => ({ id, href: `${TWEAK_CSS}${id}.css` }));
}

export type Bucket = 'baseline' | 'variant';

/** What the lab's state endpoint returns. `origin` is where the variant is served. */
export interface LabState {
	live: { experiment: string; share: number; origin?: string } | null;
}

const VISITOR = /^[0-9a-f]{32}$/;
/** The largest variant share the lab ever serves. */
const MAX_SHARE = 0.5;
const EXPERIMENT = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Sticky bucketing; the same function as the lab's reference host. */
export function assignBucket(visitorId: string, experiment: string, share: number): Bucket {
	const hash = createHash('sha256').update(`${experiment}:${visitorId}`).digest();
	return hash.readUInt32BE(0) / 2 ** 32 < share ? 'variant' : 'baseline';
}

export const newVisitorId = (): string => randomBytes(16).toString('hex');

/** Where one request goes. Not the lab's keep/revert `Decision`: this is per request. */
export interface RouteDecision {
	visitor: string;
	/** True when the visitor id is new and its cookie must be set. */
	newVisitor: boolean;
	/** The live experiment, or null when none is. */
	experiment: string | null;
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
	// The collector never stores a share outside (0, 0.5]; anything else is not its state.
	if (typeof share !== 'number' || !(share > 0 && share <= MAX_SHARE)) return { live: null };
	if (origin !== undefined) {
		if (typeof origin !== 'string') return { live: null };
		try {
			const url = new URL(origin);
			if (url.protocol !== 'http:' && url.protocol !== 'https:') return { live: null };
		} catch {
			return { live: null };
		}
	}
	return { live: { experiment, share, ...(typeof origin === 'string' ? { origin } : {}) } };
}

/**
 * `tweaked`: the visitor has personal tweaks. They are left out of any
 * experiment (baseline, no experiment id): their view is their own, and
 * counting it would skew the comparison.
 */
export function route(visitorCookie: string | undefined, state: LabState, tweaked = false): RouteDecision {
	const newVisitor = !visitorCookie || !VISITOR.test(visitorCookie);
	const visitor = newVisitor ? newVisitorId() : visitorCookie!;
	const live = state.live;
	if (!live || tweaked) return { visitor, newVisitor, experiment: null, bucket: 'baseline', rewriteTo: null };
	const bucket = assignBucket(visitor, live.experiment, live.share);
	// A variant with no origin to serve it from cannot be shown: serve the baseline.
	const rewriteTo = bucket === 'variant' && live.origin ? live.origin : null;
	return { visitor, newVisitor, experiment: live.experiment, bucket: rewriteTo ? 'variant' : 'baseline', rewriteTo };
}
