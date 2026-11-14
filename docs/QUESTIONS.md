# Questions

Blockers not covered by the brief's open questions. Each one records the
conservative choice the lab took meanwhile.

1. **Conventions source.** The brief says to follow web-ai-evals. That repo
   is not available to this session. The lab follows Graft, Sandburg and
   Assay instead: npm workspaces, TypeScript run directly by Node,
   `node --test`, oxlint, Apache-2.0. Revisit when web-ai-evals is shared.
2. **Node version.** The siblings pin Node 24 (`.nvmrc`). The lab pins 24 too,
   but runs on 22.18 or later, since it needs only type stripping.
3. **Sandburg's role.** Sandburg runs dev servers inside its own browser and
   hands out no URL, so it does not fit `Sandbox.start()` as is. Two options:
   (a) add a "serve a built directory and return its URL" mode to Sandburg;
   (b) treat Sandburg as a Verify backend instead (its checks run where it
   serves). Meanwhile the lab uses its built-in sandbox. Which do you want?
4. **Graft spec schema.** Graft's spec schema is closed and host-specific.
   Should Graft gain a `website` host (with `touches` as its scope), or
   should the lab keep its own JSON schema and only borrow Graft's Markdown
   layout? Meanwhile the lab keeps its own schema.
5. **Lighthouse.** Running Lighthouse adds a large dependency and a second
   Chrome launcher, and its scores vary on shared CI machines. The lab
   measures LCP and CLS in the page with `PerformanceObserver` and checks
   them against the budgets. Add Lighthouse if you want its other audits.
6. **Acceptance checks as data.** The brief does not say how acceptance
   criteria become checks. The proposer writes them as JSON steps and
   assertions with the spec, and the verifier interprets them, so no
   agent-written code ever runs. If a criterion cannot be expressed in that
   vocabulary, the spec is refused. The vocabulary grows when a real
   criterion needs it.
7. **Model budget.** The brief's open question on a budget ceiling per
   iteration is still open. Meanwhile an iteration makes at most six model
   calls (three to propose, three to build) at effort `high`, and the site
   context is capped at 400 KB of text.
8. **Peeking.** The brief's rule (keep at P ≥ 0.95, evaluated daily) keeps
   about 15% of null variants in simulation. I kept the rule as written and
   documented the rate. A sequential test, or a stricter keep threshold,
   would lower it. Your call.
9. **Guardrail sensitivity.** A guardrail needs the margin and a z-score set
   so that chance trips one less than 5% of the time over `maxDays`. Without
   the z-score, noisy 6-hour windows reverted good variants.

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
    the planned sample is reached and P sits between 0.2 and 0.8. Not changed
    yet; your call.
