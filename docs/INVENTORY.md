# Inventory

What Graft, Sandburg and Assay offer the lab today, read from their
repositories on 2026-11-14 (Graft `7d92b26`, Sandburg `8a92e8e`, Assay
`c519dac`). Nothing here was taken from the build brief; where a fact was
not verified, it says so.

All three are Apache-2.0, ESM only, TypeScript, and target Node 24.

## Summary

| Lab stage | Project | Fit today | Plan |
| --- | --- | --- | --- |
| Propose (spec format) | Graft | Yes, since Graft ADR 0015: host `website` | Specs are Graft specs; Graft's `validateSpec` checks them against a surface generated from the site (`@lab/adapters`) |
| Sandbox | Sandburg | No: no URL handed out, dev servers only | Built-in: build, then serve `outDir` on a loopback port |
| Verify (invariants) | Assay | Partial: deterministic checks fit, but need scripted actions and reference snapshots | Built-in Playwright invariants first; Assay adapter for compiled invariants in M4 |
| Verify (budgets) | none | No | Built-in: aXe, console, failed requests, overflow, Lighthouse |

## Graft

**What it is.** Spec-driven customizations for multi-tenant apps. A spec is
Markdown with YAML frontmatter; Graft compiles it into a declarative A2UI
build for one host version (WordPress, EmDash, a Chrome extension
prototype), verifies the build against checks derived from the acceptance
criteria, and migrates it when the host changes.

**What it exports.**

- `@swissspidy/graft-core` 0.1.1, public on npm according to its README and
  changelog (registry not checked). `parseSpec`, `validateSpec`, `hashSpec`,
  `deriveCriterionId`, `compileSpec`, `verifyBuild`, `specLifecycle`, and the
  `Spec`, `Criterion`, `Check`, `Diagnostic` types.
- `@swissspidy/graft-a2ui` 0.1.1: the A2UI catalog and its validation.
- A private CLI: `validate`, `build`, `check`, `verify`, `compile`, `canary`.

**Spec format** (`schemas/spec.schema.json`). Frontmatter requires `graft: 1`,
`id` (`^[a-z0-9][a-z0-9-]{1,62}$`), `host`, `mount.slot` and `permissions`,
with `additionalProperties: false`. The body is a `# Title`, an intent
paragraph, a required `## Acceptance criteria` list (items may end in
`{#id}`), and optional `## Out of scope` and `## Notes`.

**What works for the lab.** `parseSpec(source)` never throws and accepts
unknown frontmatter, so it can read a lab experiment written as a Graft-style
Markdown spec. The lab uses Graft's id pattern for experiment ids. The idea of
writing checks from criteria before the change exists, then freezing them, is
the same rule the lab follows for acceptance checks.

**What is missing.**

- `validateSpec` rejects `hypothesis`, `expectedEffect` and `touches`, and
  requires `host`, `mount` and `permissions`, which mean host slots and
  scopes, not file paths. A lab spec needs its own schema, or a `website`
  host in Graft.
- No serializer from a spec object back to Markdown.
- `compileSpec` needs a host `Surface`, a `HostGuide` and A2UI builds. There
  is no generic website host and no notion of a metric.

## Sandburg

**What it is.** Runs a web project's own dev server on a Node.js runtime
built to run inside a Chromium tab, and checks the app end to end with
Playwright in that tab. A Node host process drives Chromium and serves each
sandbox on its own `*.sandburg.localhost` origin through a service worker.

**What it exports.** npm package `sandburg` (0.2.0 on npm; the repo is at
0.3.0, unpublished). `Session` (`open`, `run`, `close`), `runProject`,
`runBatch`, `compare`, `renderReport`, `loadPageChecks`, and a CLI (`run`,
`batch`, `compare`, `snapshot`, `open`). A GitHub Action wraps `run`. Checks
are a `Record<name, ({ page, expect, appUrl }) => …>`, and built-in checks
cover console, network, aXe, accessibility snapshots and screenshots. Results
go to `.sandburg/runs/<id>/result.json` with classified failures.

**What works for the lab.** Its built-in console, network and aXe checks,
and its failure classes (`app-bug`, `runtime-unsupported`, `infra`), are
close to the lab's budget gate and to the "abort, don't blame the variant"
rule.

**What is missing.**

- No API returns a running site's URL and a `stop()`. The run lifecycle is
  closed: install, start, check, dispose.
- The app is served by a service worker inside Sandburg's own browser
  context, so a separate Playwright process probably cannot load it (inferred
  from its docs, not tested).
- Dev servers only: no production build, no static serve. The lab must test
  the artifact it would ship.
- Input is a directory, zip or file tree; no git refs or patches.
- Chromium's OS sandbox may not start as root in containers; it needs
  `--no-browser-sandbox` there (not tried).

## Assay

**What it is.** Compiled outcome verification for web agent tasks. A model
plus reference snapshots of a correct run compile a task into a JSON check
set (`assay.checks/v1`). After that, checks run with no model against an
evidence snapshot (accessibility tree, text, URL, network log, storage,
backend probes) and each returns pass, fail or abstain.

**What it exports.** `@swissspidy/assay` 0.1.0 (npm status not checked; about
30 changesets pending). `verify`, `verifyMany`, `validateCheckSet`,
`formatOutcome`, lock and sign functions; `./playwright` with `verifyPage`,
`captureSnapshot`, `captureBaseline`; `./compiler` with `compileTask`. A CLI
with `compile`, `capture`, `verify`, `stress`, `gate` and more. Exit codes:
0 pass, 1 fail, 2 abstain.

**What works for the lab.** The run step is deterministic and needs no model
or key: `verifyPage(page, checks)` on a Playwright page the caller navigated.
Each `CheckResult` names its check and carries evidence, which is what a
`verify_failed` ledger event needs. Check sets can be locked and signed,
which fits "invariants are created once and frozen".

**What is missing.**

- Compiling needs a reference snapshot of the action already done (a search
  run, a form submitted), not just a URL. Someone has to script the action
  for each invariant; checks read end state only.
- No aXe, Lighthouse or console-error checks.
- Abstain has no equivalent in the lab's pass or fail. The lab treats
  abstain as fail.
- Compiling a variant's acceptance criteria needs a model and a reference run
  of the variant, which is circular for an unverified variant. Acceptance
  checks have to be written from the criteria, before the variant is seen.

## Decisions taken from this inventory

1. The built-in fallbacks are the primary path through M3. Adapters come in
   M4, behind the same interfaces.
2. The built-in Sandbox runs the site's real build and serves `outDir`
   statically on 127.0.0.1. It needs no Docker and no browser of its own.
3. Invariants are Playwright scripts that drive an action and assert the end
   state. That keeps the door open to Assay: the script becomes the reference
   run, and Assay's checks replace the assertions.
4. Lab experiment ids follow Graft's id pattern, and `intent` and
   `acceptance` map to Graft's description and acceptance criteria.
5. Tooling follows the three projects: npm workspaces (as Sandburg and
   Assay), TypeScript 7 run directly by Node, `node --test`, oxlint,
   Apache-2.0.

## Adapter status (M4)

| Project | Adapter | Why |
| --- | --- | --- |
| Graft | Added (`@lab/adapters`) | Its parser is published as `@swissspidy/graft-core` 0.1.1 and reads lab specs written in its Markdown format. Graft has no writer, so the lab writes the Markdown itself. |
| Sandburg | Not added | No API returns a URL for a running site, and it serves dev servers, not built output. Published version: 0.2.0. |
| Assay | Not added | Not published to npm (404 on 2026-11-14), and no aXe, console or Lighthouse checks. Its deterministic checks would fit the invariants gate once it is published. |
