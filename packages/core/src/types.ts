// The lab's contract. Every stage is an interface with one default
// implementation; stages meet only through the types in this file.

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
	source: HypothesisSource;
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

export interface VerifyReport {
	passed: boolean;
	results: CheckResult[];
}

export interface BucketCounts {
	visits: number;
	conversions: number;
}

export interface BucketStats {
	experiment: string;
	baseline: BucketCounts;
	variant: BucketCounts;
	/** Guardrail metric id → whether it degraded past its threshold. */
	guardrails: Record<string, { degraded: boolean; detail?: string }>;
	days: number;
}

export type Decision =
	| { action: 'keep'; reason: string }
	| { action: 'revert'; reason: string }
	| { action: 'continue'; reason: string };

export type Autonomy = 'propose-only' | 'gated' | 'auto';

export interface LabConfig {
	site: { repo: string; build: string; outDir: string };
	metric: { id: string; kind: 'conversion' };
	guardrailMetrics: string[];
	allow: string[];
	deny: string[];
	invariants: string;
	budgets: { lcpMs: number; cls: number; axeViolations: number; bundleKbDelta: number };
	traffic: { share: number; minSamplesPerBucket: number; maxDays: number };
	limits: { maxChangedLines: number; maxFiles: number };
	viewports: Array<{ width: number; height: number }>;
	autonomy: Autonomy;
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

/** What a caller supplies; the ledger fills in the rest. */
export type LedgerEventInput = Omit<LedgerEvent, 'v' | 'seq' | 'prev' | 'hash' | 'at'> & { at?: string };

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

export interface Verifier {
	verify(site: RunningSite, spec: ExperimentSpec): Promise<VerifyReport>;
}

export interface Deployer {
	ship(variant: Variant, share: number): Promise<void>;
	rollback(experiment: string): Promise<void>;
	promote(experiment: string): Promise<void>;
}

export interface Meter {
	read(experiment: string): Promise<BucketStats>;
}

export interface Decider {
	decide(stats: BucketStats, spec: ExperimentSpec): Decision;
}

export interface Ledger {
	append(event: LedgerEventInput): Promise<LedgerEvent>;
	history(): Promise<LedgerEvent[]>;
}
