# Field-access implementation evidence

Task: [#37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37). Scope and acceptance: [implementation plan](../build-plan/issue-37-field-access.md).

## TypeScript field engine removed — PR #388 — 11 September 2026

Source: [PR #388](https://github.com/Abzum-NZ/Abzum-Vortex/pull/388), head
`661e5c3234de2d9bf61449eb6979791f8b9862bb`, merged into Testing at
`2026-09-11T00:26:08Z` as `ba4dac8a6ed46d00d85406dd2240d5e157866b3b`. It deletes
`contracts/src/record-field-access.ts`, its test file and the barrel export.
That engine had no consumer and took policy declarations from its caller. The
SQL resolver `vortex_access.resolve_record_field_bounds_internal` is now the
only owner of field bounds. The query channels (filter, sort, group and
aggregate) moved to [#54](https://github.com/Abzum-NZ/Abzum-Vortex/issues/54).

Local verification, as reported on #37: repository-wide typecheck passed for all
23 packages and the contracts suite passed 638 tests in 47 files. A
repository-wide search found no remaining reference to a removed symbol.

Hosted Testing, as recorded on #37 and not re-checked here: the
`testing_database_delivery` execution recorded there as `41D7gITE` succeeded in
45m 31s. It wrote the evidence record
`database-testing-ba4dac8a6ed46d00d85406dd2240d5e157866b3b` at `01:11:42Z`.

## Database field enforcement and protected sharing — PR #385 — 10 September 2026

Source: [PR #385](https://github.com/Abzum-NZ/Abzum-Vortex/pull/385), head
`af1117ab71092dde216eb102d8523cc5b818ad97`, merged into Testing at
`2026-09-10T22:11:03Z` as `575d0b03d11e8bb5b85156c3cac1f46d06c34a6f`. It adds
[`20260910094534_resolve_record_field_bounds.sql`](../../supabase/migrations/20260910094534_resolve_record_field_bounds.sql),
[`20260910114716_coordinate_protected_record_share.sql`](../../supabase/migrations/20260910114716_coordinate_protected_record_share.sql)
and SQL440, SQL445 and SQL450. It is built on #35's exact-record decision,
which [PR #380](https://github.com/Abzum-NZ/Abzum-Vortex/pull/380) delivered
into Testing as `645b4a61576f49d7dfae8c0055d03ae667b072a6` at `2026-09-10T09:17:31Z`.

The resolver takes only an allowed decision and reads each contribution's policy
from the live catalogue. It checks each policy against that contribution's exact
source release and intersects each direct-share contribution with the share's
own field sets. The fixed projection and change adapters withhold unreadable
fields and refuse an unauthorised write as a whole. The protected grant requires
a current `record.share` decision on the real target row and a readable
ceiling, plus an update ceiling when changeable fields are proposed. Revocation
requires the caller's application to match an application-contained share, and
either the share's own non-delegated grantor or a current share permission whose
scope needs no record row (all records, no saved condition). Four independent
reviews examined the change and three rejected it before the fourth approved;
the rejected findings are recorded on #37.

Local verification, as reported on #37: 69 files and 3,112 SQL assertions
passed, and `db:lint` was clean on both changed functions. The concurrency suite
was not claimed at that point (#384).

Hosted Testing, as recorded on #37 and not re-checked here: execution
[`6vXnFUL80sLyqVApTjnU4n`](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/6vXnFUL80sLyqVApTjnU4n)
validated Testing commit `575d0b03d11e8bb5b85156c3cac1f46d06c34a6f` and
succeeded in 45m 27s. It wrote the evidence record
`database-testing-575d0b03d11e8bb5b85156c3cac1f46d06c34a6f` at `22:56:33Z`.

## Reviewed neutral database candidate — 8 September 2026

The local candidate implements private field resolution, protected projection and
whole-write validation over #35's complete exact-record contributions. It reuses
current context, Access version, source/catalogue policy and validity evidence.
Per-share limits intersect before union; missing and empty policies grant no
fields. Actual restricted-role proof withholds raw content-table and helper
access and uses fixed operation adapters with no caller-selectable authority.

The protected grant proof requires exact share authority and read ceiling, and
only evaluates an update ceiling when changeable fields are proposed. Revocation
checks the stored complete application/module/type/storage/record scope and
revision without requiring the old field ceiling. Existing governance ordering
and the single private writer's Access/Activity change remain authoritative.

Independent Sol actual-work review approved the final candidate after closing
the reported binding, SQL-null and test-adapter issues. The author reports
rollback-only SQL430 + SQL440 + SQL445 passing 88 assertions; SQL445 alone passed
23. Root matched the final file hashes, without repeating the approved review.

| Candidate | SHA-256 |
| --- | --- |
| Private field migration | `00a5e2756fbbf37efb09d4858dd1effc39d84f29591ae274eb54be7bc2f2d5d6` |
| SQL440 field proof | `a601c2c37f8780eabc9b79287525198614a95dcfbf9c6412e5cba1f94ddd4b1b` |
| SQL445 protected sharing proof | `bfbe34647e263a30f921049f1fb648429489de9c4e634905ab304c3909841a88` |
| Shared neutral fixture | `f36321dcfc1ca416fef728b25de5f3fae2e89ae70a3bd11aa557b3784a6a534a` |
| Extracted SQL430 row proof | `5e358040f3e9d58b5ee48d162f1ecd5ae9e173aa53cfb4509658939490c11ecc` |

This 8 September candidate was not delivered as it stood. Its #35 prerequisite
was re-implemented and delivered separately in PR #380, without the fixed limits
recorded here. The field-bounds and protected-sharing SQL delivered to Testing
is the later implementation merged in PR #385, recorded above. Permanent
generated adapters belong to #45; no screen, transport or whole #37 completion is
claimed.

The author rebuilt only the disposable local Supabase database to apply the
candidate, then used rollback-only tests. This was not a hosted reset; no
Production database change occurred. Local-only pre-reset data is not restored
by the test scripts. Further reset runs were stopped by the architect.

## Protected-share typed operation — 8 September 2026

[PR #338](https://github.com/Abzum-NZ/Abzum-Vortex/pull/338) merged normally into
Testing at `2026-09-08T00:02:44Z` after preview success. Reviewed source:
`95254d8cbab50784d2b372a60afe5aa365e90c80`; Testing merge:
`62a19dc4c30b111dcb43475e297115ac390d726c`. All 23 package builds also passed.
No unfinished SQL was included. The subsequent exact hosted receipt is now verified:
[Testing execution Sw6MM3qeYlSuf3I2tjPSv](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/Sw6MM3qeYlSuf3I2tjPSv)
succeeded, with receipt `database-testing-62a19dc4c30b111dcb43475e297115ac390d726c`
published at `2026-09-08T01:18:22.683Z`. Root read the stored schema-2 receipt:
the repository, Testing ref, exact merge and execution match; all 66 migrations,
25 selected/completed concurrency proofs and six selected/completed lint schemas
are recorded. Migration-set, runner, manifest and coverage fingerprints match
the preceding verified receipts. Root confirmed no Git changes to `supabase` or
`workflows/kestra` between the PR #337 and PR #338 merges. This proves the selected
database gate for this revision, not delivery of the separate pending SQL candidate.

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

### Hosted Testing result

The exact PR #336 Testing merge `eaef6ce34e46cdc977705068c77822b96e0d5bd8`
passed [execution 6DEAIaJH6yyc4Elwd8Ul5G](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/6DEAIaJH6yyc4Elwd8Ul5G).
Its stored `database-testing-eaef6ce34e46cdc977705068c77822b96e0d5bd8`
receipt reports `succeeded`, 66 applied migrations, all 25 selected concurrency
proofs completed, and all six selected lint schemas completed. Logs confirm
60 database test files and 2,649 assertions passed. Receipt publication was
`2026-09-07T23:58:11.548Z`.

Root independently calculated all four fingerprints from that exact Git revision
and matched the receipt:

| Evidence | SHA-256 |
| --- | --- |
| Migration set | `ec6b40803297598bfda603618d5178b7cccc3c6d8d673859d409fd47b72d07c2` |
| Committed verification runner | `49ca962194c35b4aaa8dc5af6fbaa392604f81df94b70836977f8b1376e68046` |
| Verification manifest | `0cfcb4d9995f0c79b132b479a4ec56448d504fa097520fc6610908d21c99dfc8` |
| Selected verification coverage | `7345fd22aa5f8040ddb4356965377e8863dbb5f6ff51bb666d6bc16c8c605f0e` |

This closes the hosted-receipt qualification for the definition-to-catalogue
checkpoint below, not the later PR #337/#338 checkpoints or the unfinished
database enforcement. No Production promotion occurred. Whole #37 remains open.

### Later source checkpoint hosted verification — PR #337

The exact Testing merge `480ee21f6ba8349919f676a861aa6418168f5c01`
completed [execution 5kGsBKQGoKwb4f3yDaMrqf](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/5kGsBKQGoKwb4f3yDaMrqf?revision=7)
successfully. Its stored exact-commit receipt was published at
`2026-09-08T00:38:17.562Z`, names the correct Testing repository/ref/commit and
execution, and reports 66 applied migrations, all 25 selected concurrency proofs
and all six selected lint schemas completed.

All four receipt fingerprints equal the verified #336 values above. Root also
compared the exact Git revisions across `supabase` and `workflows/kestra` and
confirmed no database/verification artifact changed. This is the later #337
hosted receipt, not a claim that the pending row/field SQL is deployed. #338's
separate hosted execution was still running when this result was recorded.

### Source verification

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
new field-catalogue migration by itself; the later exact receipt is recorded above.
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
