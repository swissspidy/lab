# Progress

## After M5: API design review (2026-11-15)

A read of every package's public surface for contracts that mislead,
duplicate or let wrong values through.

**Fixed**

- Ledger writes are typed. `LedgerEventInput` is a union over event types,
  each with its payload (`LedgerPayloads`): a `shipped` event without a
  share, or a `reverted` event with an unknown reason, no longer compiles.
  Payloads read back stay untrusted.
- `Meter.read` returns a `MeterReading`: counts and guardrails, no `days`.
  `StoreMeter` used to compute days from the first data point, which the
  lifecycle then silently replaced with the days since `shipped`. Only the
  lifecycle computes it now.
- `SpecCheck.check` may return a promise, so a check can use Graft's
  asynchronous surface validation.
- `@lab/next`: `decide()` and `Decision` are `route()` and `RouteDecision`,
  so they no longer share names with the keep/revert `Decider` and
  `Decision` in `@lab/core`. No live experiment is `experiment: null`, not
  `''`. `parseState` accepts only a share in (0, 0.5], as the collector does.
- `@lab/deploy`: `readState` validates `state.json` with `parseDeployState`
  instead of casting it, so a hand-edited file with a bad share or origin
  serves the baseline. `COOKIE` is `COOKIE_VISITOR`, the name `@lab/next`
  uses.
- Config: `site.serve` without `site.pages` is an error
  (`config-pages-required`). Without it the verifier looked for HTML files
  in a server app's build output (`.next`) and verified those.
- `runCommand`, `runFile` and `startService` take an options object
  (`{ cwd, timeoutMs, env }`) instead of four or five positional arguments.
- `approve` takes the lifecycle's clock (`now`) like `ship` and `measure`.

**Verified**

- `npm run check`: 179 tests, including new ones for each change (a
  malformed `state.json`, the share bounds and `null` experiment in the
  proxy, an async spec check, the server-app pages rule, the approval
  clock).
- `npm run test:nextjs`: the static loop, the unattended week and the proxy
  end to end.

**Not changed**

- `@lab/next` keeps its own copy of the bucketing function and protocol
  constants instead of importing `@lab/deploy`: the proxy runs inside the
  site's bundle and must not pull in the lab's Node-only code. A test keeps
  the two bucketing functions identical.
- A failed `deployer.ship` leaves the experiment `approved`, so the next run
  retries it. Recording an abort would turn a transient host error into a
  lost experiment.

## After M5: the website as a Graft host (2026-11-15)

Pascal asked whether the lab now follows Graft's principles. Partly: specs
and checks did, but Graft could not validate a lab spec, and a variant was
limited only by the site's allow and deny lists. Graft's ADR 0015 now
defines host `website`, implemented here.

**Built**

- `ExperimentSpec` gains `mount` (`site` or `page.<route>`) and
  `permissions` (`markup:write`, `style:write`, `content:write`,
  `script:write`, `asset:write`). `validateSpec` requires both
  (`spec-mount`, `spec-permissions`, `spec-permission-unknown`).
- `websiteHost()` in `@lab/core` describes a site as a host without
  Graft: a slot for the site and one per verified page, and a scope for
  each kind of file the config lets variants change that the site has.
  `sitePages()` moved there from the verifier, so both agree on the pages.
- The static gate's new `static.permissions` check: every changed file
  must be of a kind the spec's permissions cover; a file no scope covers
  (a shell script, a binary) is always refused.
- The model builder shows only the files the spec's permissions cover as
  editable, and refuses edits to others before making a patch.
- `@lab/adapters`: specs are written and read as plain Graft specs
  (frontmatter `host: website`, `mount`, `permissions`; hypothesis,
  expected effect, touches, source and checks as sections) and validated
  by Graft's `validateSpec`. `graftSurface()` turns a site into a Graft
  surface; `GraftSpecCheck` runs Graft's phase two (mount and permissions
  against the surface) once the baseline is built. A spec that does not
  fit the site is aborted before the variant starts (stage `spec`).
- The CLI, the Next.js harness and the fixture loop tests use
  `GraftSpecCheck`.
- Every replayed spec gained a mount and the permissions its patch needs.

**Verified**

- Unit tests: `static.permissions` rejects markup under a `style:write`
  grant, both sides of a rename, and files no scope covers; spec
  validation codes; the generated surface passes Graft's
  `validateSurface`; Graft rejects a mount on a missing page
  (`graft-mount-unknown-slot`) and a scope the site does not offer
  (`graft-permission-unknown-scope`); the orchestrator aborts on a failed
  spec check after the baseline and before the variant.
- The example spec in Graft's ADR passes the lab's reader (Graft's
  validator).
- The full suite, including the fixture and Next.js loops with the Graft
  check wired in.

**Not verified**

- The mount is not enforced on the patch: a diff does not say which pages
  a file affects. It records intent; the checks verify the change where
  they look.
- Ledgers written before this change hold specs without `mount` and
  `permissions`. They are history and are not re-validated.

## After M5: Next.js proxy and a GitHub Action (2026-11-15)

Pascal asked why the lab is a command and not something that runs in the
site. The parts that build, verify, propose and promote need a machine
(a filesystem, git, headless Chromium, a model key); the part that serves
variants runs at request time. So the lab now has both halves.

**Built**

- `@lab/next`: `createLabProxy()` for Next.js 16 `proxy.js` (sticky
  bucketing identical to the reference host, rewrites of pages and `_next`
  assets to the variant's origin, beacon forwarding, the kill switch through
  a cached state read, baseline on any failure, never rewrites to its own
  host, does nothing without `LAB_URL`), and `labBeaconScript()`. No
  dependency on Next.js: `NextResponse` is passed in.
- The collector (`lab collect`): public `GET /state` and `POST /beacon`;
  token-protected `PUT /state` (validated: share at most 0.5, http(s)
  origins only) and `GET /metrics`.
- `OriginDeployer` with a pluggable `VariantPublisher` and state store
  (local or `RemoteState`); `CommandPublisher` for `deploy.publish` (preview
  deployments on any host; only `deploy.env` variables reach it);
  `LocalServePublisher` for local runs; `RemoteMeter`.
- Server mode for the sandbox and verifier: `site.serve` (run the built app
  on `$PORT`) and `site.pages`.
- CLI: `lab collect`; with `LAB_URL` and `LAB_TOKEN`, `run`, `status` and
  `kill` use the remote collector.
- `action.yml`: one step of the loop per run, approval through
  `workflow_dispatch` (the GitHub user is the approver), the ledger and kept
  changes committed back. `docs/examples/lab-workflow.yml` and
  `docs/NEXTJS.md`.
- `examples/nextjs-proxy`: the Driftwood site as a Next.js server app with
  `proxy.js`.

**Verified**

- `examples/test/nextjs-proxy.test.ts`: server-mode verification, approval,
  the variant on its own `next start`, real Chromium visitors through the
  production server's proxy (variant pages, assets and interactivity for the
  variant bucket; production for the baseline bucket; no failed requests),
  beacons per bucket at the collector, the kill switch within the cache time.
- Unit tests for the proxy (bucketing parity, state parsing, rewrites,
  failure modes, kill switch, self-host guard, beacon forwarding), the
  collector's token and validation, `RemoteState`, `RemoteMeter`,
  `CommandPublisher`, and the CLI in remote mode.
- The action's run step, simulated locally; a CI job runs the action itself
  on the fixture (doctor, a passing and a rejected dry run).

**Found on the way**

- A variant deployment runs the same `proxy.js`; unconfigured, it still set
  `lab_exp` and `lab_bucket` cookies, which came back through the rewrite
  and overwrote the real ones, so variant beacons counted for the site. An
  unconfigured proxy now changes nothing (but still answers beacons with
  204, so pages see no 404).

**Not verified**

- The action on a real site with a real collector and a real host's preview
  deployments; the Vercel command in the docs has not been run.

## M5: One unattended week, rehearsed on the local Next.js site (2026-11-14)

A rehearsal of M5 on `examples/nextjs`, with synthetic visitors on a
simulated clock and experiments replayed from disk. It shows the loop runs a
week in `auto` mode without a person. It is not the launch week: no real
visitors, no real host, no model. See `docs/WEEK-ONE.md`.

**Built**

- `autonomy: 'auto'` is accepted (with a warning) and takes effect only when
  the ledger meets M5's entry criteria (`autonomyEntry` in core): at least
  three experiments completed the full loop with an approval other than the
  lab's own, no shipped variant tripped a guardrail (an escape), and the
  kill switch stopped a live experiment. Until then an auto site behaves as
  gated, and `tick` says which criteria are missing. `lab doctor` warns
  about each unmet criterion.
- Once they hold, `tick` approves a verified experiment as `auto` and ships
  it in the same run.
- The harness (`npm run example:nextjs`, `--week`) continues after M4:
  a kill drill on the site, the site owner switching to `auto` in a commit,
  then 28 scheduled runs (one per 6 hours) with nobody approving anything,
  and `WEEK-ONE.md` written from the ledger.

**Verified** (`npm run test:nextjs`)

- After `lab kill`, 0 of 40 visitors got a variant; the ledger records the
  kill, which satisfies the entry criterion.
- During the week: zero approvals but the lab's own. Get started above the
  command (true effect +20%) was proposed, verified, approved by the lab,
  shipped and kept on day 2.5, and merged. Hiding the search button was
  rejected by `invariants.search-returns-results`. A reordering with no true
  effect shipped and was still undecided at the end of the week.
- Auto-mode unit tests: waits while criteria are unmet, ships once they
  hold, stops after an escape, and never counts its own approvals.

**What the week showed**

- No wrong decision against the true effects.
- A variant with no effect holds the only experiment slot until maxDays
  (14 days). With one experiment at a time, a null result stalls the queue
  for up to two weeks. A shorter maxDays or a futility rule would help;
  left as a question.

**Not verified**

- Real visitors, a real host, consent, a model proposing: all skipped, as
  decided. The approvals that unlocked auto mode came from the agent acting
  as operator.

## M4: One real site, gated, on a local Next.js site (2026-11-14)

The target site is a local Next.js app, `examples/nextjs` (Driftwood, a
fictional product), as decided in `docs/QUESTIONS.md`. M4's gate is met on it:
three experiments completed the full loop with approval at Ship. Traffic is
synthetic, so this proves the machinery on a real framework, not the effect
on real visitors.

**Built**

- `examples/nextjs`: Next.js 16 (App Router, Turbopack, static export) with
  client components for search, signup and copy, its own six invariants, and
  the same two planted flaws as the fixture. Four experiments in
  `examples/nextjs/experiments`, generated by
  `scripts/make-nextjs-patches.sh`.
- `examples/run-nextjs.ts` (`npm run example:nextjs`): a git copy of the
  site, the reference host on a simulated clock, synthetic visitors over
  real HTTP through the edge server, and `tick` for every step. Visitors
  react to what they are served (a Docs link in the main navigation, the
  hero's height in the served CSS, section order), so the loop has true
  effects to find but never sees them. The operator approves each verified
  experiment.
- `docs/runs/nextjs/`: the report and ledger of one run.

**Fixed on the way**, each found by running a real Next.js build:

- Turbopack refuses a `node_modules` symlinked from outside the project, so
  scratch builds now copy `node_modules` (0.5 s for Next's 352 MB). A copy
  also keeps a build from writing into the site's dependencies.
- Static exports write `/docs` as `docs.html` next to a `docs/` directory.
  `resolveStatic` in core resolves a path as file, then `<path>.html`, then
  `<path>/index.html`, for the sandbox and the edge alike.
- Baseline sanity aborted every iteration: Next's `<Link>` prefetches,
  cancelled when the measuring page closed, were counted as failed
  requests. A request the page cancels itself (`net::ERR_ABORTED`) is no
  longer a failure; error responses and network errors still are.
- The `url` assertion checked right after a click; client-side navigation
  is asynchronous, so it now waits like every other assertion.
- `gitPromote` and `siteCommit` ignore the lab's own files under `lab/`, so
  the ledger can live uncommitted in the site repository, as the brief asks,
  without blocking promotion or marking every commit dirty.

**Verified** (`npm run test:nextjs`, its own CI job)

| Experiment | True effect | Outcome |
| --- | --- | --- |
| exp-0001: Docs link in the main navigation | +25% | kept on day 2 (P 0.993), merged |
| exp-0002: smaller hero, on top of exp-0001 | +30% | kept on day 2 (P 1.000), merged |
| exp-0003: signup above install | -20% | reverted on day 2 (P 0.009) |
| exp-0004: Team price raised | n/a | rejected: `static.claims-numbers`, `invariants.pricing` |

- Every experiment that shipped was approved first; the breakage never
  reached Ship; the ledger is valid; both kept variants are commits in the
  site's history (`git revert` undoes them).
- Four real Chromium visits through the edge each recorded a conversion:
  the injected beacon works on a hydrated Next.js page.
- The report reads end to end: `docs/runs/nextjs/index.html`.

**Not verified**

- Real visitors, a real host's edge, consent, and a real model: all
  skipped for now, as decided.
- The operator who approved was me (the agent), standing in for a person.

## M4, first part: report and Graft adapter (2026-11-14)

The gate is blocked: M4's acceptance test (three experiments through the full
loop on the real site, with human approval at Ship) needs the target site,
which is still an open question in the brief. Everything that does not need
it is done.

**Built**

- `@lab/report` and `lab report [dir] [--out d]`: one static HTML page, no
  scripts, every value escaped. Newest first, each experiment shows its
  outcome, hypothesis, change, expected effect, acceptance criteria (met or
  not), the diff, every verification result with its evidence (screenshots
  copied next to the page, console output, build logs), the daily
  measurements and decisions, and a timeline including who approved it. A
  short "how to read this" explains the loop and P(expected effect).
- `@lab/adapters`, Graft: an experiment spec written as a Graft spec
  (frontmatter, title, intent paragraph, `## Acceptance criteria` with
  `{#c0}` ids; lab-only fields under `lab:`) and read back with Graft's own
  published parser (`@swissspidy/graft-core/parse`). `lab run --experiment`
  replays a Graft `spec.md`; model proposals are also written to
  `lab/specs/<id>.md` for review.
- The Sandburg and Assay adapters are not added: the inventory says neither
  is ready (`docs/INVENTORY.md`, "Adapter status").

**Verified**

- The report: a ledger with a kept and a rejected experiment renders the
  diff, criteria, results, measurements and approver; a `<script>` in a
  hypothesis comes out escaped and the page has no script tags; evidence is
  copied. A report built from five real fixture runs was checked by eye in
  Chromium.
- The Graft adapter: a fixture spec round-trips exactly through Graft
  Markdown and Graft's parser.

**Not done**

- Wiring the lab to the target site, and the three gated experiments.
- A real host's edge function: the reference edge server is a Node process.
  The first concrete host follows from where the target site is hosted.

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
