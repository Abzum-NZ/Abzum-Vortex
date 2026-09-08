# Native application publication checkpoint

Task: [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249).
Acceptance: [publication/readback plan](../build-plan/issue-249-native-publication.md).
Specification: [page composition](../specification/appendices/page-builder-contracts.md).

## Reviewed implementation — 8 September 2026

Independent Sol approved the actual combined publication, readback, restore and
storage changes, including the final downstream compatibility corrections. Root
matched all 24 reviewed source, test and SQL file hashes. Final repository verification passes: **1,401 tests
across 100 files**, with three existing skipped tests across two files. The full
suite ran sequentially without changing any test timeout or assertion.

The focused publication acceptance passes 206 tests, including a complete native
publish/read/restore journey. The same application history advances from V1 to
V2 at `2.0.0`, uses native comparison for a V2 `2.0.1` follow-up, then publishes
restored V1 source at `3.0.0`. Exact historical source remains unchanged.
Canonical, resolution, catalogue and manifest substitutions refuse; provenance
is validated where the source is compiled for publication.

Wider checks exposed obsolete tests expecting the formerly reserved V2 format
to remain disabled, plus a V1-only page reader whose type needed explicit
version narrowing. Those corrections passed 53 focused contract tests, Page
typechecking and lint, and independent Sol reviewed their actual final bytes.
The V1 page reader still does not implement a V2 route. No existing assertion or
timeout was weakened to accommodate an aggregate-load compiler test timeout;
the same test passed alone and the final suite is run without competing builds.
The complete sequential run then exposed two incomplete page-reader test mocks;
their canonical V1 content was completed without changing the original behaviour
assertions. The five focused page cases pass, including explicit V2 refusal, and
a separate independent Sol approved that test-only correction. All 23 package
typechecks and builds pass (46 tasks), as do all 23 package boundaries and
changed-source lint. No V2 route or designer UI is implied by these checks.

## Local storage evidence

The existing release dependency table now admits the exact platform-block
dependency shape. Three existing functions reconstruct that shape for append,
consumer read and historical restore. Their signatures, security properties,
organisation scope, locks and privileges remain unchanged. There is no new table,
grant, public operation or catalogue copy.

The reviewed SQL body was copied into the CLI-created migration
`20260908041122_support_native_application_release_dependencies.sql`. A direct
comparison proved equality apart from trailing whitespace. The CLI query command
could not execute multiple statements in one prepared query, so the same body
was applied in one PostgreSQL transaction in the verified Local container.

Before the extension, the three publication/read/restore suites passed 147
assertions. The final six Definition suites (drafts, identities, releases,
publication, consumer reads and restore) pass **360 assertions**. A first added
source-version assertion exposed an incorrectly labelled V1 fixture; the fixture
was corrected and then extended to retain V1 and V2 application revisions under
one root. Independent Sol approved that actual mixed-history proof. It verifies
explicit historical/current readback and unchanged V1 content fingerprint, with
the existing narrow restore test covering authored-source evidence.

The three unchanged Definition concurrency proofs also pass: publication races,
consumer reads during publication, and restore/save/publication races. Their
temporary test fixtures were cleaned up by the existing scripts. No user data
or database was reset.

Local advisors reported no issues. Only the new migration was pending and
recorded; the subsequent official schema pull reported **No schema changes
found** for `vortex_definition`. Unrelated existing Local migrations were left
unchanged. Hosted delivery will use only committed migrations and its exact
revision-selected verification set.

## Scope correction found before delivery

Do not require every typed reference inside a native page to target its primary
record type. Native composition validates declared references and exact ownership;
explicit related/row/query binding contexts belong to
[#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250). The public-page
allowlist remains distinct and strict. The attempted blanket restriction was
removed before application of that runtime patch. Issue #250 now records this
handoff and its previously empty page-permission acceptance item is completed
with the actual required behaviour.

Architect and independent Sol also rejected adding raw authored source to the
canonical consumer and recompiling on every read solely to reproduce provenance.
Source-to-canonical provenance is checked during compilation/publication. Reads
verify their actual canonical/resolution/manifest/catalogue inputs; restore
creates an editable draft that must pass compilation again before publication.
The [acceptance plan](../build-plan/issue-249-native-publication.md#proportional-integrity-decision)
records this boundary explicitly.

## Remaining delivery

- Verify the exact hosted receipt for the Testing delivery below.
- Keep whole #249 open for placement compatibility, explicit draft conversion
  and the headless adapter.

## Testing delivery

Source `752abdc13b3a46e294c45a0ab0f0d11d1dfc4e71` was committed and pushed.
[PR #344](https://github.com/Abzum-NZ/Abzum-Vortex/pull/344) passed both normal
preview checks and merged to Testing at `2026-09-08T05:40:35Z`, merge
`ba7289beeb8286e7485ae445f2ee57d6dc28101f`. No check was bypassed.

[Hosted execution 7B4lfifIp4AKiMXjf0D5SC](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/7B4lfifIp4AKiMXjf0D5SC)
started at `05:40:38.412Z` on unchanged flow revision 7. The visible log confirms
that exact Testing commit and successful application of only the new publication
migration; verification is still running. This is not yet a successful receipt.
Root recomputed expected evidence from the exact merged Git revision, excluding
unrelated uncommitted Local files: 68 migrations, 25 concurrency proofs and six
lint schemas.

| Expected hosted evidence | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| Migration set            | `f3e6f03a936fc32f27b37c9858bbcf19e013d9edc3ed5b6d8253a8cd0309130b` |
| Runner                   | `49ca962194c35b4aaa8dc5af6fbaa392604f81df94b70836977f8b1376e68046` |
| Manifest                 | `0cfcb4d9995f0c79b132b479a4ec56448d504fa097520fc6610908d21c99dfc8` |
| Coverage                 | `7345fd22aa5f8040ddb4356965377e8863dbb5f6ff51bb666d6bc16c8c605f0e` |
