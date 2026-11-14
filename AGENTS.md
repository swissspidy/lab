# Working on the lab

The build brief is the source of truth:
https://claude.ai/artifact/SfkfNVh5FHY525oSX5wPxP (read it with the docs
tools). Work through its milestones in order and stop at each gate.

- Every milestone ends with a passing acceptance test in CI and an entry in
  `docs/PROGRESS.md`: what was built, what was verified, what was not.
- Code against the interfaces in `packages/core/src/types.ts`, not against
  Graft, Sandburg or Assay. Adapters wrap them later.
- Blockers that are not open questions in the brief go into
  `docs/QUESTIONS.md`, with the conservative choice taken meanwhile.
- Never weaken a guardrail to make a test pass. Every guardrail has a test
  that proves it rejects what it should.
- Stages meet only through `@lab/core`; no stage imports another stage's
  implementation.
- Diagnostics have a stable `code` and a message that says what to do.
  Tests assert on codes.
- Tabs, ESM, `.ts` extensions in imports, erasable TypeScript only (Node
  runs it directly). `npm run check` runs lint, typecheck and tests.
