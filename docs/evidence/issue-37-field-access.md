# Field-access implementation evidence

Task: [#37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37). Scope and acceptance: [implementation plan](../build-plan/issue-37-field-access.md).

## Protected-share typed operation — 8 September 2026

The strict grant/revoke commands accept normal record, recipient, field, time and
revision inputs, never caller-supplied authority or field ceilings. Grant and
Activity identifiers are generated server-side. The runtime invokes a fixed
trusted adapter through the existing governance-first change transaction.
Read-only sharing retains the existing nonempty readable-field invariant and
does not require update authority. The SQL adapter still owns the actual exact
record and field-ceiling checks before calling the existing private writer.

Independent Sol review approved the actual typed/runtime slice. Root reran its
seven focused tests and the Access typecheck successfully, then the full shared
worktree suite: 95 files passed (two skipped), 1,363 tests passed (three skipped),
12 fixture checks, and all 23 package typechecks and boundaries. This is source
and orchestration evidence, not a live sharing endpoint or completed SQL proof.
The pending neutral database adapter tests remain separately required.

## Pure field-resolution checkpoint — 8 September 2026

[PR #337](https://github.com/Abzum-NZ/Abzum-Vortex/pull/337) merged normally into
Testing at `2026-09-07T23:45:25Z`, after preview success on reviewed head
`800c3abdc6cd6df3f37ef7b84ab385b6a766be7e`. Testing merge:
`480ee21f6ba8349919f676a861aa6418168f5c01`.
An isolated clean checkout of the exact head passed 93 test files (two skipped),
1,356 tests (three skipped), all 12 fixture checks, all 23 package typechecks and
boundaries, and all 23 production builds. No unfinished SQL was included.
These results supersede the earlier partial rerun qualification below; they do
not claim a new hosted database receipt or completion of the whole task.

The pure engine now combines only complete exact-record contributions. Each
permission is matched to its immutable declaration, source owner, action, record
type and scope. Direct-share limits intersect that contribution before the final
readable/changeable field union. Missing historical policy contributes no fields.

Projection removes unreadable values and derived values whose declared field
dependencies are not all readable. Those dependencies and source values must come
from trusted server-resolved definitions, not caller assertions. Write validation
accepts only fields allowed by the already-authorised create, update or named
action and refuses the whole proposed change if any field is disallowed. It does
not turn read permission into write authority.

The helpers bind to existing current request evidence and a trusted observation,
including the account, application, Access version, correlation and expiry.
They add no stored token, permission evaluator, counter or authority cache.

Independent Sol actual-work review approved the final bounded slice after fixing
UUID-case identity comparison and adding create/named-action proof. Final source
SHA-256: `0e2cd49be0f24c54e8e624fc4f811687e5284f74bad6026173208a782156e84b`.
Final test SHA-256:
`6536592b31679641bb3a632d3e70f7105e63cf95f098ccfc7629d64044e00c28`.
Root reran the final combined record-contract/contribution/field/runtime tests:
38/38 passed. The earlier full candidate run passed 1,355 tests with three skipped,
and all 23 package typechecks and boundaries passed. The focused final rerun
covers the subsequent small reviewed field correction; it is not a new hosted
receipt. The author also passed Contracts typecheck, lint and formatting.

These are pure contracts/helpers, not a public endpoint or proof that all future
query, filter, sort, export, semantic-map or form executors enforce fields. The
actual neutral database projection/write and protected sharing proof remains
required by [#37](../build-plan/issue-37-field-access.md). The private #35 SQL
candidate is not delivered with this checkpoint.

## Isolated source delivery — 8 September 2026

[PR #336](https://github.com/Abzum-NZ/Abzum-Vortex/pull/336) merged normally into
Testing at `2026-09-07T23:17:58Z`, after both preview checks passed on reviewed head
`968c7712ce1ee27f6e34a727191fceab40be45b1`. Testing merge:
`eaef6ce34e46cdc977705068c77822b96e0d5bd8`.

The architect created a clean detached checkout of that exact reviewed head,
installed the frozen lockfile from the local package cache, and verified:

- 90 test files passed, two skipped; 1,328 tests passed, three skipped.
- Complete fixture gate: 12/12 passed.
- All 23 package type checks and import boundaries passed.
- All 23 package builds passed, including the Next.js production build.
- No tracked checkout changes; no unfinished #35 source was included.

The independent reviewer confirmed no committed #37 dependency on the excluded
#35 changes. This replaces the earlier shared-worktree qualification with exact
isolated source evidence. It does not claim hosted database verification of the
new field-catalogue migration; its exact Testing receipt remains to be checked.
No Production promotion occurred, and the whole #37 enforcement task stays open.

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
