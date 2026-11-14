# Progress

## M3: Ship, measure, decide (simulated traffic) (2026-11-14)

**Built**

- `lifecycle.ts` in `@lab/core`: `approve`, `ship`, `measure`, `kill` and
  `tick` (one scheduled step: measure, ship, wait or iterate).
  - Ship takes the patch recorded in the ledger's `built` event and checks
    it against its hash, so what ships is exactly what was verified.
  - Ship refuses when another experiment is live, and aborts (recorded as
    `underpowered`) when the traffic cannot reach the planned sample size
    within `maxDays`, or when there is no traffic data.
  - Measure checks guardrails every interval and applies the decision rule
    once per whole day since shipping.
  - Keep merges the patch into the site's git repository (`gitPromote`,
    refusing a dirty tree), then promotes. A variant that cannot be merged
    is rolled back, not kept.
  - Kill stops traffic first and records it afterwards, and works with a
    broken ledger or config.
- `stats.ts`: normal CDF and quantile, P(variant > baseline) for
  Beta-Binomial posteriors, and the sample size formula. 10% to 12% at 80%
  power gives 3,841 visits per bucket, as the brief says.
- `BetaBinomialDecider` and `planShip`.
- `@lab/deploy`:
  - `ReferenceDeployer`: `current/`, `variants/<id>/`, `state.json`.
    Rollback and kill only rewrite the state.
  - The edge server with sticky bucketing on a random first-party cookie.
    It serves the variant to its share, keeps variant builds and host files
    out of reach, and injects the beacon.
  - The beacon endpoint: visit, conversion, js_error, engaged; validated,
    counted per experiment, bucket and interval, never per visitor. A
    site-wide series feeds the traffic estimate.
  - `StoreMeter`, with guardrails judged on the latest interval and on the
    totals.
- New config: `traffic.intervalHours`, `traffic.minDetectableEffect`,
  `rollback.{jsErrorMargin, bounceMargin, minVisits}`.
- CLI: `lab run` (one tick), `approve`, `status`, `kill`, `publish`,
  `serve`.
- `fixtures/sim/simulate.ts`: a traffic simulator on a simulated clock. It
  drives visitors through the real bucketing, store, meter, decider and
  lifecycle; only the deployer is an in-memory stand-in. Daily traffic is
  sized from the same sample size calculation.

**Verified** (129 tests)

- Acceptance (`fixtures/test/simulate.test.ts`), 20 seeds each, fixture
  config with 6-hour intervals:
  - a true +20% effect is kept in 20 of 20 runs (at least 18 required);
  - a true -20% effect is never kept; it is reverted in all 20;
  - a variant that starts throwing errors on 30% of visits at day 1.5 is
    rolled back within one 6-hour interval, in each of 5 runs.
- A variant with no true effect is kept in 3 of 20 runs, because of daily
  peeking. The test allows at most 2 of 10 and the README states the rate.
- `fixtures/test/deploy.test.ts`: publish, ship and real Chromium visits
  through the edge: sticky buckets, beacon counts per bucket, no access to
  variant builds or host files, the kill switch sending every visitor to
  the baseline at once, and promote.
- Lifecycle unit tests: approval states, one live experiment, hash
  mismatch, underpowered and no-traffic refusals, guardrail rollback,
  once-a-day decisions, keep only at the planned sample size, failed merges,
  maxDays, kill with a broken ledger, gated waiting; `gitPromote` commits
  and refuses a dirty tree.
- CLI: verify, wait, approve, publish, and a refused ship without traffic
  data; kill with a broken config.

**Found and fixed while doing it**

- With keep allowed as soon as `minSamplesPerBucket` was reached, 4 of 20
  null variants were kept. Keep now waits for the sample size planned at
  ship time, as the brief says (`minSamplesPerBucket` is a floor).
- Single-interval guardrail checks on about 190 variant visits tripped the
  bounce guardrail by chance and reverted 2 of 20 good variants. A guardrail
  now also needs a z-score set from the number of checks in `maxDays`.

**Not verified, or not done**

- No real traffic. The edge server is a Node process; a real host needs the
  same logic at its edge (M4).
- `propose-only` stops after Verify but does not open a pull request yet.
- The consent question is still open: the beacon and cookie must not reach
  real visitors until it is answered.

## M2: Real proposer and builder (2026-11-14)

**Built**

- `ModelProvider`, with one real implementation, `AnthropicProvider`. It
  uses the official SDK, `claude-opus-5-5` by default (`LAB_MODEL`
  overrides), effort `high` and server-side refusal fallbacks. A refusal from
  the whole chain, a truncated answer, bad credentials or rate limits become
  named stage errors.
- `ScriptedProvider` for tests: answers from a script per request kind, and
  records every request.
- `ModelProposer`: shows the model the config, the viewports, the ledger
  history (each experiment's intent, last state and failed checks) and the
  site's text files, each fenced as `<site_file>` data and marked editable
  or not. Invariants and the ledger are never shown. The proposer assigns
  the id itself, validates the answer with `validateSpec` and, when it is
  refused, sends the diagnostics back (three attempts).
- `ModelBuilder`: the model answers with search-and-replace edits, not a
  diff. The builder refuses edits to paths outside `allow` or inside the
  deny list before touching anything, requires each search to match exactly
  once, applies the edits to a scratch copy and lets git write the patch.
  Refusals go back to the model (three attempts). The orchestrator still
  checks the resulting patch itself.
- `lab run --dry [--iterations n]` without `--experiment` uses the model.
- The scope checker, patch caps and factual-claims check that the brief puts
  in M2 already shipped in M1.

**Verified**

- Acceptance (`fixtures/test/agent-loop.test.ts`), ten iterations with a
  scripted provider, on a ledger seeded with a reverted experiment:
  - every iteration leaves a valid ledger with every experiment settled;
  - no patch touches a denied path; the builder refused three attempts to
    edit `lab/invariants/pricing.ts` and `package.json`, and the iteration
    aborted;
  - the repeat of the reverted experiment was refused and the model's
    second proposal was used instead;
  - two variants fix the planted flaws (Docs in the main navigation, Get
    started above the fold at 1280x800) and pass Verify;
  - a price change and a contrast change were proposed, built and rejected
    by Verify (`static.claims-numbers`, `budgets.axe`);
  - unreadable answers, an unchecked criterion and edits whose search did
    not match were sent back to the model with the reason.
- Unit tests for JSON extraction, id assignment, history summaries, the
  envelope escape, and the provider's request (model, fallbacks) and its
  refusal and truncation errors, against a fake client.

**Not verified**

- No real model has run the loop: this session has no API key. The scripted
  answers show the plumbing and the guardrails hold, not that Claude
  proposes good experiments. Run `npm run lab -- run --dry fixtures/site --iterations 10`
  with a key to see that, and record the result here.

## M1: Dry loop with a scripted proposer (2026-11-14)

**Built**

- `runIteration` in `@lab/core`: Observe, Propose, Build, the static patch
  gate, Sandbox and Verify, each step written to the ledger. It stops after
  Verify; `--dry` is required until Ship exists.
- The orchestrator's own guards, which read the patch rather than trusting
  the agent: format (no binary changes, symlinks or unsafe paths), scope
  (`allow` minus `deny` minus the fixed deny list, both sides of a rename)
  and size (200 lines, 5 files by default).
- Spec validation. Acceptance checks are data, not code: a small set of
  steps (`click`, `fill`, `press`, `goto`) and assertions (`visible`,
  `hidden`, `in-viewport`, `text`, `count`, `attribute`, `clipboard`,
  `url`). Every criterion needs a check. Ids already in the ledger and
  intents that repeat a reverted experiment are refused.
- `@lab/sandbox`: copies the site to a scratch directory, applies the patch
  with `git apply`, runs `site.check` and `site.build` with a stripped
  environment (no keys or tokens) and a timeout, and serves `outDir` on
  127.0.0.1. The site directory is never written to.
- `@lab/verify`: Playwright and aXe against baseline and variant in the
  same run.
  - Static: bundle size, and content claims: numbers and prices (added or
    removed), names (added), link targets (added), forms (changed) and pages
    (removed).
  - Invariants: the site's `lab/invariants/*.ts`, loaded from the base site
    only, run at every configured viewport.
  - Budgets: new aXe violations, new console errors, failed requests,
    requests to new origins (the sandbox refuses all of them), sideways
    scroll, LCP, CLS, page status and dead same-site links.
  - Acceptance: the spec's checks.
  - Baseline sanity: if the suite fails on the baseline, the iteration is
    aborted, not blamed on the variant.
  - Each failure names its check and carries evidence: a screenshot and the
    console output.
- `@lab/agent`: `ReplayProposer` and `ReplayBuilder`, which replay
  `spec.json` and `patch.diff` from a directory.
- `lab run --dry [dir] --experiment <d>`.
- Six invariants for the fixture site; five known-good patches and 20
  breakages, regenerated from scripted edits by
  `scripts/make-fixture-patches.sh`.

**Verified** (99 tests)

- Acceptance (`fixtures/test/loop.test.ts`): each of the five good patches
  ends in `verify_passed`; each of the 20 breakages ends in `verify_failed`
  with the expected check named (dead link, hidden button, broken form,
  contrast, layout shift, console error, oversized bundle, out-of-scope
  file, changed price, edited invariant, new dependency, third-party script,
  overflow, build failure, oversized patch, symlink, removed page, new
  claim, missed acceptance criterion, patch that does not apply). The CLI
  takes a good patch to `verify_passed`.
- Unit tests for the glob matcher, patch parser and gate, spec validation,
  the orchestrator with fake stages (scope rejected before anything is
  built, baseline failures abort, a verifier that says "passed" over a
  failing check is overruled), and the sandbox (no secrets in the build,
  no writes to the site, patch and build failures named, timeouts, no
  path or symlink escape from the server).
- One good patch first failed its own criterion (the button still crossed
  the fold at 1280x800). The verifier was right; the patch was fixed.

**Not verified, or not done**

- Lighthouse itself is not run. LCP and CLS are measured in the page with
  `PerformanceObserver`, which is what Lighthouse reports for them. See
  `docs/QUESTIONS.md`.
- The name check is a heuristic: a capitalized word that does not start a
  sentence. It can miss a lowercase name and flag a capitalized term.
- The sandbox copies the working directory rather than checking out the
  recorded commit; the ledger marks a dirty tree with `+dirty`.

## M0: Inventory and skeleton (2026-11-14)

**Built**

- `docs/INVENTORY.md` for Graft, Sandburg and Assay.
- An npm workspace with two packages:
  - `@lab/core`: the stage interfaces and domain types, the config loader
    and validator, the ledger, and `doctor`.
  - `@lab/cli`: `lab doctor [dir] [--json]`.
- The ledger is append-only JSON Lines with a hash chain: each event carries
  `seq`, the previous event's hash and its own. It refuses events that break
  an experiment's lifecycle (no `shipped` after `verify_failed`, no `shipped`
  without `approved`, no `kept` without `measured`).
- The config validator rejects unknown keys, keeps the variant share at or
  below 50%, refuses `autonomy: 'auto'` until M5, and adds a deny list the
  site cannot override: `lab/**`, the config, package manifests and lock
  files, `.github/**`.
- `fixtures/site`: Kestrel, a three-page static site with a search box and a
  signup form, a component catalog with schemas (for v1), and two planted
  flaws (see `fixtures/README.md`).
- CI: lint, typecheck, tests, and `lab doctor` on the fixture.

**Verified** (39 tests, all passing locally)

- Config: defaults, unknown keys, missing keys, types, share, sample and
  duration bounds, autonomy, allow-list checks, the fixed deny list.
- Ledger: every event type round-trips through the file; the hash chain
  detects an edited, a deleted or a non-JSON line; invalid transitions and
  malformed events are refused.
- `lab doctor`: passes on the fixture, fails with codes on a bad config, an
  unloadable config and an edited ledger.
- Fixture site: zero aXe violations, no console errors and no sideways
  scroll on all three pages at 1280x800 and 390x844; search returns
  results; the signup form submits; both planted flaws are present.

**Not verified**

- CI has not run on GitHub yet; it ran locally only.
- Nothing from Graft, Sandburg or Assay is called yet. The inventory is from
  reading their code, not running it.
