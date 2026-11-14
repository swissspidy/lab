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
