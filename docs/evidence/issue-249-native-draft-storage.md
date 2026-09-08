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
passed. Exact committed-source verification and hosted delivery remain pending.

The complete-source cases exercise create/save with exact bytes/fingerprints,
shell/slot identity requirements, mismatched stored metadata, broken home-page
references, duplicate page keys and explicit refusal of not-yet-implemented V2
publication. Shared edit/save validation preserves reference-shaped literal data
as data. No business-name-dependent behavior or new permission mechanism appears.

| Reviewed implementation | SHA-256 |
| --- | --- |
| Draft contracts | `384160e80613508602f00a0cc2c81adf67c65e4c051a997ff87c85c86421a33c` |
| Source identities | `7b3e6bd2586a5fe83b5631936344fb589f2b071a6f01ad4d24cd8bb7112b20f7` |
| Draft store | `75c124da67abe6836fed42a73462a8c4d551650e0f4b8ea8f7186412100cb4d2` |
| Publication repository | `29570af6d9a39568bbfce2b42b8bd5a9462ee0d2ba12eeed95562c39215105b6` |
| Publication boundary | `e1fc9ef0d510786bfdcbbb057d9df3aabfa00f8313e92a94e4543e79d0aab9bc` |
| Shared source validation | `42dee5339becddfdf7efef6f9e9ea7d249aba36a5f66de037b52afb218bc550c` |
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
hosted change was made; unrelated existing Local migrations were left intact.

| Reviewed artifact | SHA-256 |
| --- | --- |
| Migration | `ad9988a98018e3606052f4a07770253a044174989706aa6ee7557e5ffee762cd2` |
| Identity SQL tests | `3cf83a35f6337270b1a34b41c5df3a02df79082ae345fadc216912c7f38a0f40` |

The SQL fixture intentionally tests the trusted storage boundary. The complete
valid native application fixture separately passes application-level create/save.
Whole [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249) remains open for
the [coordinated publication/readback slice](../build-plan/issue-249-native-publication.md),
conversion and the headless editor adapter. No designer UI is introduced.
