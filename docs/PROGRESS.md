# Progress

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
