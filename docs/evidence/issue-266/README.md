# Issue 266 implementation evidence

This directory records credential-free Local evidence for the exact-commit hosted database
verification correction in [issue #266](https://github.com/Abzum-NZ/Abzum-Vortex/issues/266). It
contains no database address, password, certificate, service token, customer data or hosted success
claim. The implementation was reviewed and exercised at commit
`4b015396ec1b38d4b12f0c3997f699eb3cd57cb1` before this evidence-only follow-up.

## Proven behavior

- The image-owned entry point accepts only the fixed repository, protected environment ref, full
  commit, local receipt filename and fixed commit-runner path. It verifies protected-branch
  reachability, regular Git blob mode and checked-out runner bytes before restoring the scoped
  Doppler token and invoking the runner.
- The commit-owned runner verifies its checkout, runner, manifest, Supabase configuration, migration,
  pgTAP and concurrency-proof files before any secret lookup or database connection.
- One strict manifest owns all seven current migration/proof pairs and the five operated schemas.
  Both Local proof/lint commands and hosted delivery read it. Repository discovery refuses an
  omitted, duplicate, missing or unexpected proof/schema.
- Receipt schema 2 records runner, manifest and completed-coverage fingerprints plus the selected and
  completed proof/schema lists. Production retains its explicit approval hold and also requires the
  Testing runner, manifest and coverage to match. A schema-1 receipt remains historical evidence and
  cannot approve this gate.

## Verification

- `pnpm verify` passed: formatting, lint, 23-package type checks, package boundaries, 45 test files
  with 647 tests passing and 2 files/3 tests skipped, eight fixture tests, and the production build.
- Both delivery flows passed validation in the pinned
  `abzum-vortex-kestra:v1.0.57-operations.1` image. The Production flow emitted only the previously
  documented `Pause.onResume` deprecation warning.
- The pinned-image operational contract suite passed. Its disposable Git remote keeps an older
  bootstrap while a newer reachable commit changes the runner and expands the manifest to eight
  proofs; the receipt identifies that newer runner and all eight selected checks.
- The suite refuses invalid repository/ref/commit/evidence path, unreachable commit, missing runner,
  incomplete manifest, failed/legacy/mismatched Testing evidence, wrong database project or role,
  embedded passwords, invalid certificates and remote migration-history drift.
- The pgTAP, concurrency-proof and lint fixtures execute as real commands. Deliberate non-zero exits
  propagate and leave no success receipt; the normal fixture run records every selected proof and all
  five schemas as completed.

No Local or hosted database was started, reset or changed. Coolify rollout and a fresh normal hosted
Testing receipt remain separate protected steps owned by the delivery lead. Production remains
unchanged and unapproved.
