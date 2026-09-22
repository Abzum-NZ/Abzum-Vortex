## What this changes

Closes #

## Checks

- [ ] The Vercel build passes: `pnpm build` type-checks every shipping package and builds the Next.js application.
- [ ] A separate reviewer confirmed the issue's acceptance criteria against the changed code.
- [ ] Every schema change ships as an ordered migration file; an already-applied file is corrected by a later migration.
- [ ] Organisation isolation, current permission checks, atomic writes, revision checks and safe errors are preserved.
- [ ] No package reaches inside another package's files; nothing depends upward.
- [ ] Specification, data contracts and build plan were reviewed and either updated here or recorded as unchanged.
- [ ] No secret or credential appears in source, logs, prompts or browser bundles.

Development completion is implementation plus code review, as recorded in
`docs/specification/18-delivery-and-testing.md` and `docs/specification/20-quality-and-acceptance.md`.
Tests, database review, hosted evidence and screenshots are not required for a development task,
and merging this change claims no Production release.
