# Questions

Blockers not covered by the brief's open questions. Each one records the
conservative choice the lab took meanwhile.

1. **Conventions source.** The brief says to follow web-ai-evals. That repo
   is not available to this session. The lab follows Graft, Sandburg and
   Assay instead: npm workspaces, TypeScript run directly by Node,
   `node --test`, oxlint, Apache-2.0. Revisit when web-ai-evals is shared.
   Decided (2026-11-15): the sibling conventions stay. Nothing in the lab
   depends on web-ai-evals.
2. **Node version.** The siblings pin Node 24 (`.nvmrc`). The lab pins 24 too,
   but runs on 22.18 or later, since it needs only type stripping. Decided.
3. **Sandburg's role.** Sandburg runs dev servers inside its own browser and
   hands out no URL, so it does not fit `Sandbox.start()` as is. Two options:
   (a) add a "serve a built directory and return its URL" mode to Sandburg;
   (b) treat Sandburg as a Verify backend instead (its checks run where it
   serves). Meanwhile the lab uses its built-in sandbox. Decided
   (2026-11-15): neither, for now. The built-in sandbox builds static and
   server sites and returns a URL, which is all `Sandbox.start()` needs, and
   Assay now covers the part of Verify that Sandburg would have joined.
   Sandburg's adapter is worth it only once a site's build cannot run on the
   lab's machine.
4. **Graft spec schema.** Resolved 2026-11-15: Graft has a `website` host
   ([Graft ADR 0015](https://github.com/swissspidy/graft/blob/main/docs/adr/0015-website-host.md)).
   Experiment specs are valid Graft specs (a mount slot and permission
   scopes in the frontmatter; the lab's fields as sections), and Graft's
   `validateSpec` checks them against a surface generated from the site.
5. **Lighthouse.** Running Lighthouse adds a large dependency and a second
   Chrome launcher, and its scores vary on shared CI machines. The lab
   measures LCP and CLS in the page with `PerformanceObserver` and checks
   them against the budgets. Decided (2026-11-15): no Lighthouse. aXe covers
   accessibility, the bundle budget covers weight, and in-page LCP and CLS
   cover the vitals without a second browser.
6. **Acceptance checks as data.** The brief does not say how acceptance
   criteria become checks. The proposer writes them as JSON steps and
   assertions with the spec, and the verifier interprets them, so no
   agent-written code ever runs. If a criterion cannot be expressed in that
   vocabulary, the spec is refused. The vocabulary grows when a real
   criterion needs it.
7. **Model budget.** The brief's open question on a budget ceiling per
   iteration is still open. Meanwhile an iteration makes at most six model
   calls (three to propose, three to build) at effort `high`, and the site
   context is capped at 400 KB of text. Decided (2026-11-15): these caps
   are the budget until a real run's costs say otherwise.
8. **Peeking.** The brief's rule (keep at P ≥ 0.95, evaluated daily) keeps
   about 15% of null variants in simulation. I kept the rule as written and
   documented the rate. A sequential test, or a stricter keep threshold,
   would lower it. Decided (2026-11-15): the brief's 0.95 stays the
   default, now `traffic.keepProbability`, so a site can choose. Keeping
   already waits for the planned sample, and the futility rule (15) ends
   nulls earlier. Measured over 100 seeds: 0.95 keeps 8 nulls, every +20%
   change and 90 of 100 +10% changes; 0.99 keeps 1 null and 71 +10%
   changes.
9. **Guardrail sensitivity.** A guardrail needs the margin and a z-score set
   so that chance trips one less than 5% of the time over `maxDays`. Without
   the z-score, noisy 6-hour windows reverted good variants. Decided.

## Decisions taken on 2026-11-14

Pascal asked me to test with a local Next.js site, skip the metric,
consent and API key questions for now, and make the remaining decisions.

10. **Target site.** `examples/nextjs`, a Next.js 16 static export built for
    the lab, with the fixture's planted flaws. Static export keeps the
    reference host (and any static host) able to serve it. A Next.js site
    that needs a server (SSR, API routes) needs a different Deployer.
11. **Traffic.** Synthetic visitors over real HTTP, with documented true
    effects (`VISITOR_MODEL` in `examples/run-nextjs.ts`), on a simulated
    clock so two weeks run in minutes. Variant share 0.5 (the maximum),
    intervals of 6 hours.
12. **Approval.** In the local run the agent approves as `operator`. On a
    real site that must be a person running `lab approve`.
13. **Primary metric.** `next_step_click`, as on the fixture: a click on a
    tracked link to the docs.
14. **Auto mode.** `auto` now takes effect only once the ledger shows three
    completed gated loops, no guardrail rollbacks and a tested kill switch.
    I chose "a guardrail rollback" as the definition of an escape, since the
    lab cannot see invariants break in production.
15. **Null results stall the queue.** One experiment at a time plus
    `maxDays: 14` means a variant with no effect blocks the loop for up to two
    weeks. Options: a shorter `maxDays`, or a futility rule that reverts once
    the planned sample is reached and P sits between 0.2 and 0.8. Decided
    (2026-11-15): a futility rule. A change not kept once both buckets reach
    twice the planned sample is reverted as having no effect of the planned
    size. At twice the sample a real effect of that size is kept about 98%
    of the time. Over 100 seeds a null now frees the slot after 9.7 days on
    average instead of 12.1, and real +20% changes are still all kept.
16. **Where the collector runs.** The proxy and the scheduled loop both need an
    always-on place for the state and the counts. I made it a small service
    (`lab collect`). Alternatives: a key-value store of the host (Vercel Edge
    Config, Cloudflare KV) with an adapter. Your call which host to support
    first. Decided (2026-11-15): `lab collect` stays the one supported
    collector. It runs anywhere Node runs; a host key-value adapter is worth
    writing for the first real site that cannot run a small service.
17. **Promotion from CI.** The action pushes kept changes straight to the
    branch it runs on. Opening a pull request instead would add a human step
    after a keep; say if you want that. Decided (2026-11-15): direct push
    stays. A keep already follows a person's approval in `gated` mode, and
    `auto` mode is defined as no person in the loop; a pull request would
    turn `auto` back into `gated`. `git revert` undoes a kept change.
18. **Personal tweaks as generated CSS.** The brief's v1 has no generated
    CSS and composes personal views on the device. Pascal decided
    (2026-11-15) that generated CSS is fine: a tweak is a style-only Graft
    spec plus its stylesheet, verified like a variant before any visitor
    gets it. Decided.
