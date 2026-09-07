# Field-access implementation evidence

Task: [#37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37). Scope and acceptance: [implementation plan](../build-plan/issue-37-field-access.md).

## Definition-to-catalogue checkpoint — 8 September 2026

The next bounded slice is implemented and independently source-approved. Module
and application sources may explicitly declare field policies; compilation
resolves aliases only within the exact bound record type, sorts permanent UUIDs
and preserves per-field provenance. New publication requires the explicit policy;
historical source and immutable canonical omission remain readable without added
defaults. Policy presence/content participates in the existing major permission
change comparison and meaning fingerprint.

The existing private permission catalogue retains nullable `field_policy` through
registration, exact candidate comparison, current reads and withdrawal history.
It adds no authority table, public operation, evaluator, continuity counter or
approval mechanism. UUID uniqueness/order/subset checks compare UUID identities
case-insensitively while retaining original stored policy bytes. Existing
governance locking, revisions, Access invalidation and private privileges remain.

All 94 record permissions in the eight module fixtures now name their intended
fields. The [fixture notes](../../testing/fixtures/README.md#explicit-field-permissions)
document sensitive-notes separation, generated read-only fields, unchanged Case
Summary grants, and the later action-binding gaps; the new fixture tests enforce
those boundaries rather than merely making empty policies parse.

Verification of the candidate:

- Independent Sol actual-patch review approved source/compiler/publication,
  provenance, comparison, catalogue persistence and fixture authority. Findings
  about application-owned provenance, valid-but-foreign aliases, the approval
  fixture assertion and UUID case parity were fixed before approval.
- Full local test suite: 91 files passed, two skipped; 1,337 tests passed and
  three skipped. Complete fixture gate: 12/12 passed.
- All 23 workspace package type checks and import-boundary checks passed.
- The full workspace build passed, including the Next.js production build.
  Formatting and the configured focused lint passed; the fixture file is excluded
  by the repository's existing lint configuration and is covered by type/tests.
- The catalogue author ran the candidate migration and SQL435 rollback-only:
  33/33 assertions passed. Unchanged SQL340 under that candidate passed 23/23.
  No database reset or migration-history write occurred.
- These local checks ran in the shared worktree, which also contains separate
  uncommitted #35 work. They are not an isolated hosted source-revision receipt.

Reviewed migration:
[`20260907223932_preserve_permission_field_policy.sql`](../../supabase/migrations/20260907223932_preserve_permission_field_policy.sql),
SHA-256 `0689f5f225c062c9f60aa95bc11c25e13eec8abb1ba7400159cbab8e8892f8fa`.
SQL435 SHA-256
`ee443646b5405ca2b9b599c272ea46410860cd25bc71ee44ad2e674cc2e2464b`.

This checkpoint does not implement field projection/write enforcement, grantor
ceilings, protected sharing, screens or MCP transport. Those remain the explicit
rest of [#37](../build-plan/issue-37-field-access.md); record integration still
requires [#35](../build-plan/issue-35-row-policy-composition.md). No new hosted
Testing success or Production delivery is claimed for this slice.

## Canonical permission policy — 8 September 2026

The first bounded implementation adds an optional explicit `fieldPolicy` to the
existing canonical record-permission declaration. Readable and changeable field
identities must be unique and in canonical UUID order; changeable fields must be a
subset of readable fields. Empty lists are valid. Non-record permissions cannot
declare this policy. Historical omission remains omission, without generated
defaults or changed immutable bytes. The schema neither infers an action nor
creates a wildcard for future fields.

Implementation: [permission contracts](../../contracts/src/permissions.ts) and
[focused policy tests](../../contracts/test/permission-field-policy.test.ts).
An independent Sol reviewer inspected the actual two-file patch against this
bounded scope and approved it with no findings, including the generic-platform
boundary and absence of a new authorization model.

Local checks passed:

- Nine focused tests across the field-policy and existing record-scope test files.
- Contracts typecheck, focused lint, formatting and diff validation.
- A broader contracts/Definition/fixture run: 47 files, 792 tests passed. The
  worktree also contains separate uncommitted #35 changes, so this is local
  compatibility evidence, not an isolated delivered-revision result.

This is a canonical data contract only. Authored aliases, compiler/provenance,
publication requirements, permission-meaning comparison, field enforcement and
protected sharing are not yet implemented by this slice. Parsing a field list
does not enforce read/write authority. No database migration, hosted receipt,
screen or MCP endpoint is claimed. The whole task remains in progress.
