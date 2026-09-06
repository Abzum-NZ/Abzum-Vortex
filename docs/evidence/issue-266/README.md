# Issue 266 implementation evidence

This directory records credential-free evidence for the exact-commit hosted database
verification correction in [issue #266](https://github.com/Abzum-NZ/Abzum-Vortex/issues/266). It
contains no database address, password, certificate, service token, customer data or hosted success
claim. The earlier implementation and author-run verification are recorded at code commit
`e91ad0b8bb564e7ed19e6e02ec6c1e6dfc0143a8`; this evidence update follows it without changing
runtime behavior. The sealed independent security scan covered the earlier tip
`a541be354a2a1e508ecbd55cc9ddd18634f3acab` and reported no security finding. That historical
scan is not the approval for the current candidate; the current independent review is recorded below.

## Proven behavior

- The image-owned entry point accepts only the fixed repository, protected environment ref, full
  commit, local receipt filename and fixed commit-runner path. It verifies protected-branch
  reachability, regular Git blob mode and checked-out runner bytes before restoring the scoped
  Doppler token and invoking the runner.
- The commit-owned runner verifies its checkout, runner, manifest, Supabase configuration, migration,
  pgTAP and concurrency-proof files before any secret lookup or database connection.
- One strict manifest owns every current migration/proof pair and all five operated schemas.
  Both Local proof/lint commands and hosted delivery read it. Repository discovery refuses an
  omitted, duplicate, missing or unexpected proof/schema.
- The Local lint launcher invokes the pinned package's JavaScript entry through the current Node
  executable. It does not rely on a Windows command shim or enable a command shell. Local and hosted
  schema discovery both accept ordinary SQL whitespace, including multiline `CREATE SCHEMA`.
- Receipt schema 2 records runner, manifest and expected-coverage fingerprints plus the selected and
  completed proof/schema lists. Production requires every selected and completed list to exactly
  match its manifest before secret lookup. An expected-coverage fingerprint alone is not completion
  evidence. The existing named-operator promotion checkpoint remains; standing user authority permits
  reviewed promotion without a new business approval. A schema-1 receipt cannot approve this gate.

## Historical verification

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
  while a newer reachable commit changes the runner, expands the manifest by one proof and adds
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

## Current candidate verification

The candidate incorporates delivered Testing through
`e954e0dd6832a9388b7b7f6be79b3e1ce1140867`. Its current manifest selects 13 concurrency proofs
and five operated schemas; these are discovered from the delivered revision, not a permanent limit.

- Full repository verification passed: 968 tests passed, three existing tests skipped, all 23 package
  type checks and builds, package boundaries, and eight fixture scenarios.
- The disposable operational contract suite passed with the expanded manifest. Prepared-but-empty,
  partial, extra and malformed completion evidence all refuse before Doppler or database access;
  exact successful evidence passes. Both flows validated against pinned Kestra 1.0.57, with only the
  existing `Pause.onResume` deprecation warning.
- Independent Sol review approved the complete 17-file repair against delivered Testing, including
  the actual-completion correction. Root verified the approved bytes:

| Artifact | SHA-256 |
|---|---|
| Production flow | `088345998bab26f329cff2fd4c2d55d03cc9076f7558e2cddfa5c38062eb248c` |
| Commit-owned runner | `49ca962194c35b4aaa8dc5af6fbaa392604f81df94b70836977f8b1376e68046` |
| Operational contract test | `7efad30c29b0f4332f102e5eb063b5a4a0ba1308578718e4098b9024edfae4d1` |
| Verification manifest | `76f446b51c79a908d561ec8f16a0a300fe16cbf9d37a9db55dea481227f0f916` |

## Hosted preflight — not a hosted verification result

The delivery lead inspected the existing Coolify resource and running containers through the
authenticated dashboard. The source is this repository's `main` branch with Commit SHA `HEAD`;
the last successful deployment inspected was `d58cb5a20240d3d76bb0d8c0367ae664ac418101`.

- Running Kestra is 1.0.57. Its image is
  `sha256:f80be4c10756e8d7e9af268cf29d90f9826de9e5483fbb9207663c8d936dbebd`.
- The existing workflow-state database uses PostgreSQL 18.4, pinned image
  `sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382`.
  This is Kestra's database, not Vortex's Supabase database.
- Existing Kestra storage, workflow working-directory bind mount and PostgreSQL data volume were
  inspected. The proposed Dockerfile and Compose files are unchanged from the deployed revision;
  this repair does not require a version or storage migration.
- Coolify reported image retention disabled. The exact running image was retained under
  `abzum-vortex-kestra:pre-issue266-f80be4c10756`, and inspection confirmed that tag resolves to the
  same image. No global retention setting, service restart, backup restore or database reset occurred.

This establishes the bounded same-version deployment prerequisite, not a proven database restore.
[Issue #271](https://github.com/Abzum-NZ/Abzum-Vortex/issues/271) remains deferred and is not a
dependency of this repair; [#198](https://github.com/Abzum-NZ/Abzum-Vortex/issues/198) remains deferred.
At that preflight, protected rollout and a fresh exact-commit hosted Testing receipt were still
required. The subsequent rollout and acceptance attempt are recorded below; they do not change
the historical preflight result.

## Bootstrap rollout and first complete-gate attempt — 6 September 2026

The shared Kestra service successfully deployed the independently reviewed bootstrap at exact
commit `cdb6debd0477789f9ad7e50278500618065d0990` through
[the existing Coolify resource](https://abzum.cloud/project/6upzwteumbhvxe0d1drp59o2/environment/6j90mxt7daujxhctmhgywyiu/application/hmdzjmvsy8f9cekvmrkmeygn),
deployment `nnf00tl0wbsr0rjiqmfkqpcw`.
Kestra remains 1.0.57, with the existing workflow-state database and storage mounts. This was
not a Kestra upgrade, backup restore or Supabase Production migration.

[Fresh Testing execution `tx8ZNynECTHR8qzhAwfyf`](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/tx8ZNynECTHR8qzhAwfyf/logs)
used flow revision 7 and selected `fcb1b85b493fea9d9cf45daa3462ede74eaddedb`. It passed all
28 SQL suites / 1,430 assertions and the first seven concurrency proofs, then **failed** the
permission-registry proof's platform-initializer lock observation. Failure propagated; there is
no schema-2 success receipt from that execution. Older successful runs using the image-baked
verification list do not establish acceptance of the repaired gate.

The failing observer relied on startup `PGAPPNAME` appearing unchanged in pooled backend metadata.
Hosted inspection did not show those worker names. The
[Supavisor upstream report](https://github.com/supabase/supavisor/issues/343) describes the
corresponding propagation limitation. The bounded repair captures each worker's actual database
backend identifier inside its transaction and checks the exact blocking relationship using
[PostgreSQL's `pg_blocking_pids`](https://www.postgresql.org/docs/17/functions-info.html).
An owned, bounded release barrier replaces the fixed holder sleep. Permission, revision,
competing-write and cleanup assertions remain in place.

Root verification of that repair passed the actual Local permission-registry proof with an
explicit connection-name override, followed by all 14 manifest-selected Local concurrency proofs.
These are Local results, not a hosted-success claim. The other 13 proofs have no startup-name
observer to repair. The hosted bootstrap already loads commit-owned proofs, so delivering this
script correction does not require another Kestra deployment.

The shared service is temporarily pinned to the reviewed bootstrap commit with manual deployment.
Restore normal protected `main`/`HEAD` tracking after a fresh complete Testing receipt and reviewed
merge to `main`. [Issue #266](https://github.com/Abzum-NZ/Abzum-Vortex/issues/266) remains open until
the current protected revision's full selected/completed proof and schema sets are verified in
its successful hosted receipt. Production remains unchanged.

## Hosted follow-up — permission proof passed; assignment-expiry setup repair

[PR #297](https://github.com/Abzum-NZ/Abzum-Vortex/pull/297) merged the independently reviewed
permission observer and its existing operational fixture correction into Testing as
`e9163da9059880d53968faded6366398577b9e5c`. Its normal preview check passed.
[Execution `2NnMq9tuBUjRRtd9emkm8G`](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/2NnMq9tuBUjRRtd9emkm8G/logs)
ran that exact revision with flow revision 7. All 30 SQL suites / 1,508 assertions and the first ten
concurrency proofs passed, including the repaired permission-registry proof. The execution then
**failed** the assignment-change expiry scenario: its five-second expiry elapsed before the
remote observer established the intended governance-lock wait. Failure propagated and no complete
success receipt was produced; schema lint and the remaining proofs are not claimed as completed.

The bounded follow-up changes only that scenario's setup: the database expiry is sampled after
the holder confirms acquisition of the governance lock, with a fifteen-second setup window.
The proof still establishes the exact blocking backend relationship while the expiry is in the
future, waits for database time to cross that expiry, then releases the holder. The real grant
must refuse with `40001`, without an assignment or Access-version change. Product expiry rules,
database migrations, worker cleanup and all final-state assertions are unchanged.

Independent Sol review approved the exact script SHA-256
`6dcbba9ca94acd75476cbb7db5bea85cc11dfb7ebc2f986cb820dd4f5a5cbf06`.
Root ran that actual assignment-change concurrency script against Local Vortex successfully;
shell syntax and whitespace checks also passed. This evidence does not replace the required fresh
complete hosted Testing receipt. No additional Kestra deployment or Production change is required
to deliver the commit-owned test correction.
