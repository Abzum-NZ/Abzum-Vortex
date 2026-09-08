# Native application draft storage checkpoint

Task: [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249).
Acceptance: [bounded draft-storage plan](../build-plan/issue-249-native-draft-storage.md).
Specification: [page composition](../specification/appendices/page-builder-contracts.md).

## Implementation checkpoint — 8 September 2026

This slice extends existing draft saves to native application layouts and content
areas. It does not enable publication, historical restore or the App Designer.
Independent Sol approved the actual complete bounded implementation and acceptance
without material findings. Root matched every reviewed code and SQL hash.
The preceding full regression run passed 1,395 tests across 100 files; the final
four new draft cases then passed within the 16-test native compiler suite. All 23
package typechecks/builds, import boundaries and changed-code lint/format checks
passed. Exact committed source `1591ded06ea576c4a4be6fa6b9bd10f9657b37c4`
then passed 1,399 tests across 100 files, all 23 typechecks/builds and boundaries
in the clean isolated worktree with frozen offline dependencies. One existing
compiler test timed out under the initial parallel load; the full rerun with two
workers passed without changing assertions or its timeout. Normal preview checks
passed and [PR #343](https://github.com/Abzum-NZ/Abzum-Vortex/pull/343) merged to
Testing at `2026-09-08T04:07:10Z`, merge
`d2b101b506d734ff273c24438c6c58162b48fd8a`. Hosted verification is now verified.
[Execution 4SjhDyLZtnluIF39z1ywlY](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/4SjhDyLZtnluIF39z1ywlY)
failed at `2026-09-08T04:16:21.088Z` while connecting to GitHub to fetch source,
before database verification began (exit 128, connection timeout on port 443).
It was restarted with the unchanged flow revision 7 at `04:47:22.320Z`.
A separate already-queued delivery,
[execution 3zP9aFLZygXN600FTuz2FL](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/3zP9aFLZygXN600FTuz2FL),
succeeded at `2026-09-08T04:56:43.201Z`. Its schema-2 receipt, written at
`04:56:43.172Z`, matches the exact repository, Testing ref and merge commit with
**67 migrations, all 25 selected concurrency proofs and all six lint schemas
completed**. Root independently recomputed the migration-set, runner, manifest
and coverage fingerprints from that exact Git revision and matched the receipt.
A screenshot of the successful execution was shown in the work conversation.
This completes hosted evidence for this bounded draft-storage slice, not the
whole task or the later publication implementation.

| Hosted evidence       | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Migration set         | `3ffa57f8a16777a15e666077d64a1961b80fc0c10055d6ebdf6c2c919864ac9d` |
| Runner                | `49ca962194c35b4aaa8dc5af6fbaa392604f81df94b70836977f8b1376e68046` |
| Verification manifest | `0cfcb4d9995f0c79b132b479a4ec56448d504fa097520fc6610908d21c99dfc8` |
| Verification coverage | `7345fd22aa5f8040ddb4356965377e8863dbb5f6ff51bb666d6bc16c8c605f0e` |

The complete-source cases exercise create/save with exact bytes/fingerprints,
shell/slot identity requirements, mismatched stored metadata, broken home-page
references, duplicate page keys and explicit refusal of not-yet-implemented V2
publication. Shared edit/save validation preserves reference-shaped literal data
as data. No business-name-dependent behavior or new permission mechanism appears.

| Reviewed implementation     | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Draft contracts             | `384160e80613508602f00a0cc2c81adf67c65e4c051a997ff87c85c86421a33c` |
| Source identities           | `7b3e6bd2586a5fe83b5631936344fb589f2b071a6f01ad4d24cd8bb7112b20f7` |
| Draft store                 | `75c124da67abe6836fed42a73462a8c4d551650e0f4b8ea8f7186412100cb4d2` |
| Publication repository      | `29570af6d9a39568bbfce2b42b8bd5a9462ee0d2ba12eeed95562c39215105b6` |
| Publication boundary        | `e1fc9ef0d510786bfdcbbb057d9df3aabfa00f8313e92a94e4543e79d0aab9bc` |
| Shared source validation    | `42dee5339becddfdf7efef6f9e9ea7d249aba36a5f66de037b52afb218bc550c` |
| Native compiler/draft tests | `8f7f45f4070d094bbe854e2168c0482be6822cdffadb89f84368ce465cd4b73b` |

## Database evidence

The existing source-identity kind constraint admits `shell` and
`shell_content_slot`. No tables, functions, grants, policies or extra allocation
mechanisms are introduced. Independent Sol reviewed the exact migration and its
database tests before application.

On the verified Local database, the existing draft/identity suites first passed
129 assertions. With the additive migration and new cases, the same two suites
passed 137 assertions. New cases cover creation, stable owners across shell/slot
alias renames, historical alias conflicts and stale saves without partial changes.
Existing organisation isolation and V1 cases remain in those suites.

Only migration `20260908033210_support_application_shell_draft_identities.sql`
was pending and applied through the migration ledger. The official schema pull
then reported **No schema changes found**: Local matches the migration files for
`vortex_definition`. Database advisors reported no issues. No database reset or
hosted change was made during that Local exercise; the subsequent hosted delivery
is recorded above. Unrelated existing Local migrations were left intact.

| Reviewed artifact  | SHA-256                                                             |
| ------------------ | ------------------------------------------------------------------- |
| Migration          | `ad9988a98018e3606052f4a07770253a044174989706aa6ee7557e5ffee762cd2` |
| Identity SQL tests | `3cf83a35f6337270b1a34b41c5df3a02df79082ae345fadc216912c7f38a0f40`  |

The SQL fixture intentionally tests the trusted storage boundary. The complete
valid native application fixture separately passes application-level create/save.
Whole [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249) remains open for
the [coordinated publication/readback slice](../build-plan/issue-249-native-publication.md),
conversion and the headless editor adapter. No designer UI is introduced.
