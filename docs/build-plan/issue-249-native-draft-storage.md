# Native application draft storage

Owner: [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249).
Contract: [page composition](../specification/appendices/page-builder-contracts.md).
Preceding slice: [change assessment](issue-249-version-impact.md).
Sequence: [engines first](engine-first-application-delivery.md).

Implementation is independently reviewed and normally merged to Testing in
[PR #343](https://github.com/Abzum-NZ/Abzum-Vortex/pull/343).
[Evidence](../evidence/issue-249-native-draft-storage.md) records exact-source and
Local proof; hosted verification remains pending. Continue the
[coordinated publication/readback slice](issue-249-native-publication.md).

## What this enables

Save and revise a complete native application definition, including reusable
layouts, named content areas and nested/guided content, without losing component
identity. This is an existing draft-save capability extended to the new format,
not a designer, conversion command or new publication service.

## Bounded implementation

1. Extend existing create/save and stored-draft contracts to the exact V1 or V2
   application source. Require stored version agreement. Keep module contracts,
   V1 authored bytes and legacy compiler/publication payloads unchanged.
2. Select the existing V1 or V2 source validator and identity extractor by the
   exact application source version. Do not infer the format from shape.
3. Reuse existing revision-checked create/save operations and their atomic
   component/alias allocation. Add only the `shell` and `shell_content_slot`
   identity kinds to the existing database constraint. No new table, allocator,
   counter, timestamp ordering rule or grant.
4. Update affected repository/type handling only as needed for stored V2 drafts.
   Keep V2 release preparation/append/read/restore unsupported until the complete
   coordinated publication slice. Do not silently treat a V2 draft as V1.
5. Prove create/save, stable identity through alias changes, stale revision and
   alias conflict handling, transaction rollback, and organisation isolation
   through existing tests and database operations. Reuse V1 regression coverage;
   add only concrete V2 cases. No database reset belongs in this task.

## Acceptance and verification

- A complete V2 draft round-trips through existing create/save results with its
  exact source version/fingerprint; malformed or mismatched metadata refuses.
- Shell/slot identities are allocated once through the existing operation and
  remain attached to their permanent component owners across renames.
- Conflicting aliases and stale saves do not partially update draft or identity
  state; other organisations cannot change the draft.
- V1 stored source/fingerprints and existing publication/history/restore tests
  remain unchanged. V2 release paths remain unimplemented, not partially enabled.
- The additive constraint change is tested against a separately verified Local
  baseline. Use migration files and normal exact-commit Testing delivery; no
  dashboard schema changes, reset, extra grants or environment reconfiguration.
- Independent Sol reviews actual code and acceptance; root verifies exact source
  and updates the task/evidence. Follow [Supabase migrations](https://supabase.com/docs/guides/deployment/database-migrations)
  and [database testing guidance](https://supabase.com/docs/guides/local-development/testing/overview).

## Following coordinated slice

Exact platform-block dependencies must be persisted with publication and all
readback/integrity/history/restore paths together, not as a table-only allowance.
Reuse existing release/dependency tables, immutable catalogue, locks and revision
sequence. Add the block identity/version/content/catalogue fingerprints to the
existing manifest, validate one-to-one canonical correspondence, and retain
version-selected history entries. A supported V1/V2 representation transition
in either direction receives the next major version; restored historical content
keeps its exact bytes. Draft conversion and the pure editor adapter follow this
working publication path. No App Designer implementation is started here.
