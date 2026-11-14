# lab

An open-source loop that lets an agent improve a live website on its own,
and never ships a change that has not been verified.

One iteration: propose a change, build it as a variant, test it in a
sandbox, verify it against compiled checks, serve it to a slice of traffic,
measure one metric, then keep or revert. Every step goes into an
append-only ledger in the site's repository.

"lab" is a working name.

## Kill switch

`lab kill` will set the variant share to 0% without a deploy. It arrives in
M3, before the lab serves any variant to visitors. Until then the lab ships
nothing.

## Status

M0 of six milestones is done: the stage interfaces, the config, the ledger,
`lab doctor` and a fixture site. See [docs/PROGRESS.md](docs/PROGRESS.md).
`lab run --dry` arrives in M1.

## Try it

Node 22.18 or later.

```sh
npm install
npm run lab -- doctor fixtures/site
npm run check
```

## How it is built

- `packages/core`: the stage interfaces (`src/types.ts`), the config
  (`lab.config.ts`, written by the site owner), the ledger and `doctor`.
- `packages/cli`: the `lab` command.
- `fixtures/site`: a small static site with two planted flaws, used by the
  tests.
- `docs/INVENTORY.md`: what Graft, Sandburg and Assay offer the lab today.
- `docs/QUESTIONS.md`: open decisions, with the choice taken meanwhile.

## License

Apache-2.0.
