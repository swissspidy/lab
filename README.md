# lab

An open-source loop that lets an agent improve a live website on its own,
and never ships a change that has not been verified.

One iteration: propose a change, build it as a variant, test it in a
sandbox, verify it against compiled checks, serve it to a slice of traffic,
measure one metric, then keep or revert. Every step goes into an
append-only ledger in the site's repository.

"lab" is a working name.

## Kill switch

```sh
npm run lab -- kill path/to/site
```

Every variant share goes to 0% without a build or a deploy. On the reference
host it takes effect on the next request: the edge reads the state on each
one. A Next.js site's proxy caches the state, so there it takes effect within
the cache time (5 seconds by default, `cacheMs`). It works even when the
config or the ledger is broken, and records the kill in the ledger afterwards
when it can. With `LAB_URL` set, it needs `LAB_TOKEN` too, and refuses to run
otherwise rather than kill only a local copy.

## Try it in two minutes

Node 22.18 or later, and Playwright's Chromium (`npx playwright install chromium`).

```sh
npm install
npm run lab -- doctor fixtures/site
npm run lab -- run --dry fixtures/site --experiment fixtures/good/nav-docs
npm run lab -- run --dry fixtures/site --experiment fixtures/breakages/changed-price
```

The first experiment adds a Docs link to the fixture site's navigation and
ends in `verify_passed`. The second changes a price and ends in
`verify_failed`, naming `static.claims-numbers`. Both land in
`fixtures/site/lab/ledger.jsonl`; delete that file to run them again.

## Status

All six milestones have run, on a local Next.js site with synthetic traffic
and a simulated clock:

- M4: three experiments went through verify, approval, ship, measure and
  decide; two were kept and merged, one was reverted, and a breakage was
  rejected.
- M5 (rehearsal): after a kill switch test, the lab ran seven days in `auto`
  mode with no approvals but its own. See [docs/WEEK-ONE.md](docs/WEEK-ONE.md).

Nothing has met real visitors or a real model yet. See
[docs/PROGRESS.md](docs/PROGRESS.md) and the run's report,
[docs/runs/nextjs/index.html](docs/runs/nextjs/index.html).

## On a real Next.js site

A `proxy.js` with `@lab/next` serves the experiments at request time, a small
always-on collector keeps the state and the counts, and a GitHub Action runs
the loop on a schedule. See [docs/NEXTJS.md](docs/NEXTJS.md).

## Try it on a Next.js site

```sh
npm install
npm install --prefix examples/nextjs
npm run lab -- run --dry examples/nextjs --experiment examples/nextjs/experiments/nav-docs
npm run example:nextjs   # M4 and an unattended week on simulated time, about 6 minutes
```

`lab report` writes the ledger as a static HTML page that someone who has
never seen the repository can read.

Every experiment spec is a [Graft](https://github.com/swissspidy/graft) spec
for host `website` (Graft ADR 0015). Its frontmatter names a mount slot
(`site`, or one page such as `page.docs`) and the kinds of files it may
change (`markup:write`, `style:write`, `content:write`, `script:write`,
`asset:write`). Graft's own validator checks both against what the site
offers once the baseline is built, and the static gate rejects a patch that
changes a file no listed permission covers (`static.permissions`).

Model proposals are also written to `lab/specs/<id>.md` as Graft specs. Ignore
`lab/specs/`, `lab/report/` and `lab/evidence/` in the site's `.gitignore`, or
commit them: a kept experiment is merged only into a clean tree.

With a key (`ANTHROPIC_API_KEY`, or `ant auth login`), let the model propose
and build:

```sh
npm run lab -- run --dry fixtures/site --iterations 3
```

## The full loop

Run `lab run` from a scheduler once per measurement interval. Each run does
one step:

1. If an experiment is live, measure it: roll it back at once if a guardrail
   degraded; once a day, apply the decision rule and keep, revert or keep
   running.
2. Otherwise, if an experiment is approved, ship it to `traffic.share` of
   visitors, unless the site's traffic cannot reach the planned sample size
   within `traffic.maxDays`.
3. Otherwise, if an experiment passed Verify, wait for `lab approve <id>`.
4. Otherwise, start a new iteration: propose, build, verify.

`lab status` shows where things stand. The reference host (`lab publish`,
`lab serve`) serves the baseline and the variant, buckets visitors with a
random first-party id that carries nothing else, and counts visits,
conversions, errors and engagement per bucket and interval, never per
visitor.

### Autonomy

`autonomy` is `propose-only` (stop after Verify), `gated` (a person runs
`lab approve`; the default) or `auto`. `auto` takes effect only once the
ledger shows three experiments that completed the loop with a person's
approval, no guardrail rollbacks, and a kill switch used on a live
experiment. Until then an `auto` site waits for approval like a gated one.

### Decision rule

Beta-Binomial posteriors on each bucket's conversion rate:

- keep when P(variant beats baseline) ≥ 0.95, both buckets reached the
  sample size planned at ship time, and no guardrail degraded;
- revert when P ≤ 0.05 (after `minSamplesPerBucket`), when a guardrail
  degrades, or when `maxDays` passes;
- otherwise keep running.

Guardrails (`js_error_rate`, `bounce`) degrade when the variant is worse than
the baseline by more than the margin in `rollback` and by enough standard
errors that chance alone trips one less than 5% of the time over the whole
experiment. They are checked every interval, on that interval alone and on
the totals.

**Peeking.** The rule is evaluated once a day, not continuously, and the
daily looks are not corrected for. In simulation, a variant with no true
effect is kept about 15% of the time (3 of 20). A sequential test would fix
this; it is a later improvement.

## Verification

A variant passes only if every check passes, on top of a baseline that
passes the same suite in the same run:

| Gate | Checks |
| --- | --- |
| Static | patch format, scope and size; site check and build; bundle size; numbers, names, links, forms and pages unchanged |
| Invariants | the site's own `lab/invariants/*.ts`, at every viewport: Playwright scripts, or Assay invariants with locked checks mined from the baseline |
| Budgets | aXe, console errors, failed requests, new origins, overflow, LCP, CLS, page status, dead links |
| Acceptance | the experiment's own checks, written as data with the spec |

`npm run check` runs lint, typecheck and all tests.

### Assay invariants

A hand-written invariant checks what its author thought to assert. An Assay
invariant states the task and the outcome in words, with a run that does the
task and runs that must not pass:

```ts
import type { AssayInvariantSpec } from '@lab/adapters';

export default {
	id: 'signup-submits',
	description: 'The signup form subscribes an email address and confirms it',
	assay: {
		task: {
			instruction: 'Subscribe reader@example.com to the release notes with the signup form.',
			outcomes: '- The page shows "Thanks. We will send release notes to reader@example.com."',
		},
		checks: 'signup-submits.checks.json',
		act: (ctx) => subscribe(ctx, 'reader@example.com'),
		negatives: { 'not-submitted': (ctx) => subscribe(ctx, 'reader@example.com', false) },
	},
} satisfies AssayInvariantSpec;
```

`lab invariants compile` builds the baseline, runs each Assay invariant's
task and negatives there, and has Assay mine checks that pass on the task and
fail on every negative, with no model. It stress-tests them (valid variations
of the page must pass, broken evidence must fail), locks them, and writes the
check set next to the invariant. Review the diff and commit it. Verify then
does the task on both sites and evaluates the locked checks; a check set
edited after it was locked fails, and so does an outcome Assay cannot decide.
`lab doctor` reports a missing or broken lock (`invariant-lock-broken`).

Assay is installed from a git commit until it is published to npm.

## How it is built

- `packages/core`: the stage interfaces (`src/types.ts`), the config
  (`lab.config.ts`, written by the site owner), the ledger, the patch and
  spec guards, and the orchestrator.
- `packages/sandbox`: the built-in sandbox.
- `packages/verify`: the built-in verifier.
- `packages/agent`: proposers and builders, replayed or model-backed, and
  the `ModelProvider` they use.
- `packages/deploy`: the reference deployer, edge server, beacon and meter.
- `packages/report`: the static ledger viewer.
- `packages/adapters`: adapters to Graft (spec format) and Assay (invariants).
- `packages/next`: `@lab/next`, the proxy helper and beacon for Next.js sites.
- `packages/cli`: the `lab` command.
- `action.yml`: the GitHub Action.
- `fixtures/sim`: the traffic simulator.
- `fixtures/site`: a small static site with two planted flaws.
- `fixtures/good`, `fixtures/breakages`: patches that must pass, and patches
  that must be rejected with a named check.
- `docs/INVENTORY.md`: what Graft, Sandburg and Assay offer the lab today.
- `docs/QUESTIONS.md`: open decisions, with the choice taken meanwhile.

## License

Apache-2.0.
