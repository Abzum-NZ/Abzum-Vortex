# Issue 266 implementation evidence

This directory records credential-free Local evidence for the exact-commit hosted database
verification correction in [issue #266](https://github.com/Abzum-NZ/Abzum-Vortex/issues/266). It
contains no database address, password, certificate, service token, customer data or hosted success
claim. The corrected implementation and author-run verification are recorded at code commit
`e91ad0b8bb564e7ed19e6e02ec6c1e6dfc0143a8`; this evidence update follows it without changing
runtime behavior. The sealed independent security scan covered the earlier tip
`a541be354a2a1e508ecbd55cc9ddd18634f3acab` and reported no security finding. It does not approve
the later functional corrections. Fresh independent review of the final tip remains required.

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
- The Local lint launcher invokes the pinned package's JavaScript entry through the current Node
  executable. It does not rely on a Windows command shim or enable a command shell. Local and hosted
  schema discovery both accept ordinary SQL whitespace, including multiline `CREATE SCHEMA`.
- Receipt schema 2 records runner, manifest and completed-coverage fingerprints plus the selected and
  completed proof/schema lists. Production retains its explicit approval hold and also requires the
  Testing runner, manifest and coverage to match. A schema-1 receipt remains historical evidence and
  cannot approve this gate.

## Verification

- `pnpm verify` passed at `e91ad0b8bb564e7ed19e6e02ec6c1e6dfc0143a8`: formatting, lint,
  23-package type checks, package boundaries, 47 test files with 655 tests passing and 2 files/3
  tests skipped, eight fixture tests, and the production build. The standard test gate includes
  eight new isolated launcher/manifest tests. They exercise direct Node launch of a fake package
  entry, exact schema arguments, a real child exit of 23, launcher-error propagation, omitted and
  unexpected schemas, and duplicate migration, proof and schema entries without a database.
- Both delivery flows passed validation in the pinned
  `abzum-vortex-kestra:v1.0.57-operations.1` image. The Production flow emitted only the previously
  documented `Pause.onResume` deprecation warning.
- The pinned-image operational contract suite passed against code commit
  `e91ad0b8bb564e7ed19e6e02ec6c1e6dfc0143a8`. Its disposable Git remote keeps an older bootstrap
  while a newer reachable commit changes the runner, expands the manifest to eight proofs and adds
  a sixth schema using multiline `CREATE SCHEMA`; the receipt identifies that newer runner and every
  selected proof/schema.
- The suite refuses invalid repository/ref/commit/evidence path, an unreachable commit, a missing or
  symbolic runner, a symbolic manifest, post-checkout runner byte modification, every missing
  migration/proof counterpart, an omitted proof, duplicate migration/proof/schema manifest entries,
  an unlisted created schema and a manifest-only schema. A Git wrapper also proves the Doppler token
  is absent from Git children before the commit and runner have been verified.
- Production preparation refuses failed or historical Testing evidence and independently exercised
  mismatched runner, manifest and completed-coverage fingerprints. It also refuses a wrong database
  project or role, embedded passwords, invalid certificates and remote migration-history drift.
- The pgTAP, concurrency-proof and lint fixtures execute as real commands. Deliberate non-zero exits
  propagate and leave no success receipt; the normal disposable fixture run records every selected
  proof and all six selected schemas as completed.

No Local or hosted database was started, reset or changed. Coolify rollout and a fresh normal hosted
Testing receipt remain separate protected steps owned by the delivery lead. Production remains
unchanged and unapproved. The final evidence-only tip still requires independent review before those
steps.
