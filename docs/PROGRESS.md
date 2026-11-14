# Progress

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
