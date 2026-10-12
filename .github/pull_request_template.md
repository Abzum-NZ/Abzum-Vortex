## What changed

Issue #
Describe the behaviour implemented and its scope.

## Product correctness

- [ ] Organisation isolation, current permission checks, atomic writes, revision checks and safe errors are preserved.
- [ ] Every schema change ships as a new numbered migration file; function changes keep the `supabase/schemas` canonical file identical to the migration.
- [ ] No package reaches inside another package's files; nothing depends upward.
- [ ] No secret or credential appears in source, logs or browser bundles.
- [ ] Specification and build plan updated where behaviour changed.
