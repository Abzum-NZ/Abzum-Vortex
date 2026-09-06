# Activity foundation evidence

Task: [#252](https://github.com/Abzum-NZ/Abzum-Vortex/issues/252). Scope and acceptance: [approved plan](../build-plan/issue-252-activity-foundation.md).

## Current state

The foundation is implemented and local verification has passed. Independent plan review approved the bounded design at `441b3bc`; final actual-patch review and hosted delivery are tracked separately below. The existing local database was inspected before the single additive change: PostgreSQL 17.6, 42 applied migrations, latest `20260906071702`. The CLI-created migration `20260906090019_activity_append_foundation.sql` was then applied locally, without a reset, infrastructure upgrade or Production change.

## Required evidence

| Requirement | Evidence status |
|---|---|
| Content-free contract, actor attribution and canonical identifiers | Nine focused contract tests and database constraint cases pass |
| Atomic success and separate post-rollback refusal | Activity concurrency R1 commits a paired change/entry; R2 proves append-error rollback; R3 fully rolls back a change and its completed entry, then commits refusal for an existing local subject in a separate transaction |
| Exact retry and conflicting/concurrent duplicate identity | Exact retries retain one row; conflicting concurrent evidence refuses without altering the winner or committing the paired change |
| Append-only private store and denied direct/cross-organisation access | Activity database suite: 53 assertions, including actual request-role denial and private schema/default grants |
| Repository, complete database, concurrency and lint checks | Repository: 1,225 tests pass, three existing skips, eight fixture checks, 23 package typechecks/builds, formatting/lint/boundaries pass. Final database suite: 40 files, 1,956 assertions. All 21 concurrency proofs pass. Six-schema lint: no errors, three unchanged Access warnings, none in Activity |
| Independent actual-patch review | Sol reviewer approved the final six implementation files at the hashes below; no material findings remain |
| Hosted Testing checks for the delivered revision | Reviewed change merged through [PR #310](https://github.com/Abzum-NZ/Abzum-Vortex/pull/310); successful saved receipt verifies the exact revision, all 43 migrations, all 21 selected concurrency proofs and all six selected schemas |

## Hosted delivery — 6 September 2026

Both normal preview checks passed before the reviewed change was merged into Testing as `69bda089d012e1f35988f4eceeeff5f50bd8b804`. Its file tree is identical to the independently reviewed implementation. [Testing execution](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/419g5LBbj010D3XglyuPIb) completed its verification successfully. The full saved receipt was inspected read-only in the authenticated [Kestra KV store](https://kestra.abzum.com/ui/main/kv), namespace `vortex.operations`, key `database-testing-69bda089d012e1f35988f4eceeeff5f50bd8b804`, last modified `2026-09-06T10:03:59.196Z`. No receipt value was edited.

The receipt binds status `succeeded`, repository `Abzum-NZ/Abzum-Vortex`, ref `refs/heads/testing`, the exact commit and execution above, CLI `2.116.0` and PostgreSQL major 17. Its applied migration count is 43, and the selected/completed concurrency and lint lists match exactly. All four hashes below match independently computed delivered-source values. The hosted prerequisite is satisfied; this is not a claim that Production was promoted or that the local assertion count was separately extracted from hosted logs.

Delivered-source coverage, matched against the successful hosted receipt:

| Bound source fact | Verified value |
|---|---|
| Migration count | 43 |
| Concurrency proofs | 21 |
| Linted schemas | `public`, `vortex_context`, `vortex_identity`, `vortex_definition`, `vortex_access`, `vortex_activity` |
| Migration-set SHA-256 | `a205afd0e3a4be83b16145fc632d89025143432715b487a0a5d31dc1c7dbc0a2` |
| Runner SHA-256 | `49ca962194c35b4aaa8dc5af6fbaa392604f81df94b70836977f8b1376e68046` |
| Manifest SHA-256 | `00b4d7d302472b8f25f6f5b996a33a354745046e4b279050a9713f10e7e24d48` |
| Coverage SHA-256 | `dc923ad42b29aae47e6d3d30b1649dc0a83a187e79ff8875ddfa730fd31e2892` |

This task has no browser interface to screenshot. It proves the shared append foundation, not an Activity screen or complete integration of existing operations. [#115](https://github.com/Abzum-NZ/Abzum-Vortex/issues/115) owns the later permitted views and complete coverage.

## Reviewed implementation bytes

| File | SHA-256 |
|---|---|
| `contracts/src/operation-contracts.ts` | `f5e1f9dcc7429b5ffd38ba4a97984ecce052b9e4e07e7f74c8585f58d21b790d` |
| `contracts/test/activity-entry.test.ts` | `81b6f5baed7a657d1b543921d9d29df68a64d539b1dd67c80713503340d7cf43` |
| `supabase/migrations/20260906090019_activity_append_foundation.sql` | `657eb3111482c2bb2d41bb5d73dee62607c724ad01335171904d50ab53df1496` |
| `supabase/tests/320_activity_append_foundation.test.sql` | `3e6791b00d082b9d4bbd17741e8d1d099dfe25c6942a80d594615a008cd97cc7` |
| `supabase/tests/activity-append-concurrency.test.sh` | `9a4082c2c5d856485be75d19ea848c02ee1a6595ad3dfcaa2cbc3ef1c81c34c2` |
| `workflows/kestra/database-verification.json` | `00b4d7d302472b8f25f6f5b996a33a354745046e4b279050a9713f10e7e24d48` |

Review corrected proof gaps before delivery: refusal subjects use a verified existing organisation, successful state and evidence commit together, append failure rolls back the paired change, and a compact invalid-input matrix proves the database constraints. No additional authority mechanism was introduced.
