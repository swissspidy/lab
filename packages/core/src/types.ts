// The lab's contract. Every stage is an interface with one default
// implementation; stages meet only through the types in this file.
import type { WebsiteHost } from './website.ts';

/** Where a hypothesis came from. Only `agent` exists in v0; `visitors` is v1's morph clusters. */
export type HypothesisSource = 'agent' | 'visitors';

export interface ExperimentSpec {
	/** `exp-0007`. Unique within a site's ledger. */
	id: string;
	hypothesis: string;
	/** One sentence: what changes. Mirrors a Graft spec's description. */
	intent: string;
	/** Objectively checkable criteria. Mirrors a Graft spec's acceptance criteria. */
	acceptance: string[];
	/** `<metric> up` or `<metric> down`. */
	expectedEffect: string;
	/** Paths the change is expected to touch. The scope check reads the patch, not this list. */
	touches: string[];
	/**
	 * Where the change shows: `site`, or the slot of one page (`page.index`,
	 * `page.docs`). Mirrors a Graft spec's `mount.slot`.
	 */
	mount: string;
	/**
	 * The kinds of files the change may touch (`markup:write`, `style:write`,
	 * ...). Mirrors a Graft spec's permissions; the static gate rejects a
	 * patch that changes a file no listed scope covers.
	 */
	permissions: string[];
	source: HypothesisSource;
	/**
	 * Checks for the acceptance criteria, written with the spec, before the
	 * variant exists. Data, not code: the verifier interprets them, so a
	 * proposer never runs code of its own. Every criterion needs at least one.
	 */
	checks: AcceptanceCheck[];
}

/** How a check finds an element. The first match counts. */
export type Target =
	| { role: string; name?: string; exact?: boolean }
	| { label: string }
	| { text: string; exact?: boolean }
	| { css: string };

export type Step =
	| { do: 'click'; target: Target }
	| { do: 'fill'; target: Target; value: string }
	| { do: 'press'; target: Target; key: string }
	| { do: 'goto'; page: string };

export type Assertion =
	| { expect: 'visible'; target: Target }
	| { expect: 'hidden'; target: Target }
	/** Fully inside the viewport without scrolling. */
	| { expect: 'in-viewport'; target: Target }
	| { expect: 'text'; target: Target; equals?: string; contains?: string }
	| { expect: 'count'; target: Target; equals: number }
	| { expect: 'attribute'; target: Target; name: string; equals: string }
	| { expect: 'clipboard'; equals: string }
	| { expect: 'url'; endsWith: string };

export interface AcceptanceCheck {
	/** Index into `acceptance`. */
	criterion: number;
	/** A page of the built site, such as `index.html`. */
	page: string;
	/** Defaults to the config's first viewport. */
	viewport?: { width: number; height: number };
	steps?: Step[];
	expect: Assertion[];
}

/** A site at a commit, checked out in a working directory. */
export interface RepoRef {
	dir: string;
	commit: string;
}

/** A spec turned into a patch against a base commit. */
export interface Variant {
	experiment: string;
	base: RepoRef;
	/** A unified diff, as `git diff` writes it. */
	patch: string;
	/** sha256 of `patch`, hex. */
	patchHash: string;
}

export interface RunningSite {
	url: string;
	/** The built output on disk, when the sandbox has one. Static gates read it. */
	root?: string;
	stop(): Promise<void>;
}

/** The context the Proposer sees. Site content inside it is untrusted data. */
export interface Observation {
	site: RepoRef;
	config: LabConfig;
	baseline: BucketStats | null;
	history: LedgerEvent[];
}

export type Gate = 'static' | 'invariants' | 'budgets' | 'acceptance' | 'baseline';

export interface CheckEvidence {
	screenshot?: string;
	trace?: string;
	console?: string[];
	detail?: string;
}

export interface CheckResult {
	gate: Gate;
	/** Stable check id, such as `budgets.axe` or `invariants.search-returns-results`. */
	check: string;
	passed: boolean;
	message: string;
	evidence?: CheckEvidence;
}

export interface VerifyInput {
	baseline: RunningSite;
	variant: RunningSite;
	spec: ExperimentSpec;
	/** Where to write screenshots and traces. */
	evidenceDir: string;
}

export interface VerifyReport {
	/** True only when the baseline passed and every variant check passed. */
	passed: boolean;
	/** False means the suite fails on the baseline too: abort, don't blame the variant. */
	baselinePassed: boolean;
	/** Variant results, one per check id. */
	results: CheckResult[];
	/** Baseline results, gate `baseline`, one per check id. */
	baselineResults: CheckResult[];
}

/** A stage failed in a way it can name. `code` is stable. */
export class StageError extends Error {
	readonly code: string;
	readonly detail: string | undefined;
	constructor(code: string, message: string, detail?: string) {
		super(message);
		this.name = 'StageError';
		this.code = code;
		this.detail = detail;
	}
}

export interface BucketCounts {
	visits: number;
	/** Visits with the primary metric. */
	conversions: number;
	/** Visits with at least one uncaught script error. */
	jsErrors: number;
	/** Visits with any interaction. Bounce is 1 - engaged / visits. */
	engaged: number;
}

export interface BucketStats {
	experiment: string;
	/** Totals since the experiment shipped. */
	baseline: BucketCounts;
	variant: BucketCounts;
	/** The most recent measurement interval alone, so a sudden failure is not diluted by history. */
	latest: { baseline: BucketCounts; variant: BucketCounts } | null;
	/** Guardrail metric id → whether it degraded past its threshold. */
	guardrails: Record<string, { degraded: boolean; detail?: string }>;
	/** Days since the experiment shipped. */
	days: number;
}

/** Site-wide traffic, to check an experiment can reach its sample size before it ships. */
export interface TrafficEstimate {
	dailyVisits: number;
	conversionRate: number;
	/** Days of data behind the estimate. */
	days: number;
}

export type Decision =
	| { action: 'keep'; reason: string }
	| { action: 'revert'; reason: string }
	| { action: 'continue'; reason: string };

export type Autonomy = 'propose-only' | 'gated' | 'auto';

export interface LabConfig {
	/**
	 * `check` is an optional lint and type check command, run before `build`.
	 * `serve` runs a built app that needs a server (a Next.js app that is not a
	 * static export): it must listen on `$PORT`. Without it, `outDir` is served
	 * as static files. `pages` lists the routes to verify; without it, every
	 * HTML file in `outDir` is a page.
	 */
	site: { repo: string; build: string; outDir: string; check?: string; serve?: string; pages?: string[] };
	metric: { id: string; kind: 'conversion' };
	guardrailMetrics: string[];
	allow: string[];
	deny: string[];
	invariants: string;
	budgets: { lcpMs: number; cls: number; axeViolations: number; bundleKbDelta: number };
	traffic: {
		share: number;
		minSamplesPerBucket: number;
		maxDays: number;
		/** How often Measure runs and guardrails are checked. The decision rule runs once a day. */
		intervalHours: number;
		/** The relative lift the sample size is planned for: 0.2 means 10% to 12%. */
		minDetectableEffect: number;
	};
	/** When a guardrail counts as degraded, in absolute rate differences. */
	rollback: { jsErrorMargin: number; bounceMargin: number; minVisits: number };
	limits: { maxChangedLines: number; maxFiles: number };
	viewports: Array<{ width: number; height: number }>;
	autonomy: Autonomy;
	/**
	 * How variants of a server app are published (OriginDeployer): `publish`
	 * runs in a built scratch copy and prints the variant URL as its last line;
	 * `retire` takes it down. Both get LAB_EXPERIMENT, and only the environment
	 * variables named in `env` (deploy tokens).
	 */
	deploy?: { publish: string; retire?: string; env?: string[] };
	/**
	 * Personal tweaks: visitors may restyle the site for themselves. Absent,
	 * the site offers none. `maxBytes` caps a tweak's CSS (default 16384).
	 */
	tweaks?: { maxBytes?: number };
}

export const LEDGER_EVENT_TYPES = [
	'proposed',
	'built',
	'verify_passed',
	'verify_failed',
	'approved',
	'shipped',
	'measured',
	'kept',
	'reverted',
	'aborted',
] as const;

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

export interface LedgerEvent {
	/** Format version. */
	v: 1;
	/** Position in the ledger, from 0. */
	seq: number;
	type: LedgerEventType;
	experiment: string;
	/** ISO 8601 timestamp. */
	at: string;
	siteCommit: string;
	/** sha256 of the patch; null before the patch exists. */
	patchHash: string | null;
	payload: Record<string, unknown>;
	/** `hash` of the previous event, or null for the first. */
	prev: string | null;
	/** sha256 over the canonical JSON of every other field. */
	hash: string;
}

/**
 * The payload the lab writes for each event type. Readers still treat a
 * ledger's payloads as untrusted (older ledgers, hand edits): this types
 * what is appended, not what is read back.
 */
export type LedgerPayloads = {
	/** `spec` is the proposal as received; it may be the invalid one an abort records. */
	proposed: { source: HypothesisSource; spec: unknown };
	built: { patch: string };
	verify_passed: { results?: CheckResult[] };
	verify_failed: { failures: CheckResult[]; results?: CheckResult[] };
	approved: { by: string };
	shipped: { share: number; plan?: unknown };
	measured: { day: number; stats: BucketStats; probability: number; decision: Decision };
	kept: { reason: string };
	reverted: { reason: 'guardrail' | 'decision' | 'kill'; detail?: string; stats?: BucketStats };
	/** `stage` names where the experiment stopped; the rest says why. */
	aborted: { stage: string; [key: string]: unknown };
};

/** What a caller supplies; the ledger fills in the rest. The payload must match the event type. */
export type LedgerEventInput = {
	[T in LedgerEventType]: Omit<LedgerEvent, 'v' | 'seq' | 'prev' | 'hash' | 'at' | 'type' | 'payload'> & { type: T; payload: LedgerPayloads[T]; at?: string };
}[LedgerEventType];

export interface Diagnostic {
	/** Stable, kebab-case: `config-unknown-key`. Tests assert on it. */
	code: string;
	severity: 'error' | 'warning';
	/** Says what is wrong and what to do. */
	message: string;
	/** Where: a config path (`traffic.share`) or `ledger:<line>`. */
	path?: string;
}

// Stage interfaces.

export interface Proposer {
	propose(ctx: Observation): Promise<ExperimentSpec>;
}

export interface Builder {
	build(spec: ExperimentSpec, repo: RepoRef): Promise<Variant>;
}

export interface Sandbox {
	start(ref: RepoRef | Variant): Promise<RunningSite>;
}

/**
 * Checks a spec against what the site offers, once that is known (after the
 * baseline is built). The Graft adapter implements it with Graft's own
 * validator.
 */
export interface SpecCheck {
	check(spec: ExperimentSpec, host: WebsiteHost): Diagnostic[] | Promise<Diagnostic[]>;
}

/**
 * A personal tweak: a visitor's own restyling of a site, as a Graft spec
 * for host `website` that may only change styles. It is verified like a
 * variant, then served to the visitors who opt in, and never measured.
 */
export interface TweakSpec {
	/** `tw-` and twelve hex digits; unguessable enough to share as a link. */
	id: string;
	/** One sentence: what changes for the visitor. */
	intent: string;
	acceptance: string[];
	/** Where the change shows: `site` or a page slot. */
	mount: string;
	/** Always exactly `['style:write']`. */
	permissions: string[];
	checks: AcceptanceCheck[];
}

export interface Tweak {
	spec: TweakSpec;
	/** The stylesheet, added after the site's own. */
	css: string;
}

/** A tweak the lab verified, as the collector stores and serves it. */
export interface TweakRecord extends Tweak {
	verifiedAt: string;
	siteCommit: string;
	/** Check ids that ran and passed. */
	checks: string[];
}

/** Serves a running site with extra CSS in every HTML page, for verifying a tweak. */
export interface CssInjector {
	inject(site: RunningSite, css: string): Promise<RunningSite>;
}

export interface TweakStore {
	put(record: TweakRecord): Promise<void>;
	get(id: string): Promise<TweakRecord | null>;
}

export interface Verifier {
	verify(input: VerifyInput): Promise<VerifyReport>;
}

export interface Deployer {
	ship(variant: Variant, share: number): Promise<void>;
	/** Stops serving the variant. Takes effect without a deploy. */
	rollback(experiment: string): Promise<void>;
	/** Serves the variant to everyone. */
	promote(experiment: string): Promise<void>;
	/** The kill switch: every variant share to 0, now, whatever the ledger says. */
	kill(): Promise<void>;
}

/**
 * What a Meter reports: the counts and guardrails. How long the experiment
 * has run is the ledger's to say (since its `shipped` event), not the meter's.
 */
export type MeterReading = Omit<BucketStats, 'days'>;

export interface Meter {
	read(experiment: string): Promise<MeterReading>;
	traffic(): Promise<TrafficEstimate>;
}

export interface Decider {
	/** `requiredPerBucket` is the sample size planned when the experiment shipped. */
	decide(stats: BucketStats, spec: ExperimentSpec, plan?: { requiredPerBucket: number }): Decision;
}

export interface Ledger {
	append(event: LedgerEventInput): Promise<LedgerEvent>;
	history(): Promise<LedgerEvent[]>;
}
