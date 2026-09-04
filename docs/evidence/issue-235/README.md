# Issue 235 local evidence

This directory records credential-free evidence for the Supabase foreign-key index
cleanup in [issue #235](https://github.com/Abzum-NZ/Abzum-Vortex/issues/235).
It contains no database address, credential, token or customer data.

## Scope

Migration `20260905050000_issue235_foreign_key_index_cleanup.sql` changes only
three indexes in `vortex_definition`:

| Foreign key | Covering index | Ordered key columns | Predicate |
| --- | --- | --- | --- |
| `release_dependencies_target_release_fk` | `release_dependencies_target_release_idx` | `target_root_id`, `target_release_revision`, `dependency_version`, `dependency_content_fingerprint` | `target_root_id IS NOT NULL` |
| `roots_current_release_fk` | `roots_current_release_idx` | `root_id`, `current_release_revision` | none |
| `source_identity_aliases_owner_fk` | `source_identity_aliases_owner_idx` | `root_id`, `owner_scope`, `kind`, `component_owner`, `identity_id` | none |

The first index replaces the former two-column target-release index under the
same name. Its two prior leading columns and its `target_root_id IS NOT NULL`
predicate remain intact. The `release_dependencies_target_shape` check requires
a non-null target root precisely for module rows, which are the only rows that
carry a target-release foreign-key tuple. Rows omitted by that predicate have
no target release to check. The two added indexes do not replace the existing
`roots_pkey` or `source_identity_aliases_pk` lookup paths.

## Local catalogue and test proof

After a clean Local reset, a PostgreSQL catalogue query showed that each named
constraint and its intended index have identical ordered key columns. Each
index reported `indisvalid = true` and `indisready = true`; the target-release
predicate deparsed as `(target_root_id IS NOT NULL)` and the other two indexes
had no predicate. A local equivalent of Supabase Splinter's
[`0001_unindexed_foreign_keys` check](https://github.com/supabase/splinter/blob/main/lints/0001_unindexed_foreign_keys.sql)
returned zero rows for all three constraints.

- `pnpm db:test` passed: 13 pgTAP files and 736 assertions.
- `pnpm db:concurrency` passed: all seven two-connection proofs.
- `pnpm db:lint` passed for every Vortex-owned schema with no errors.
- The `pnpm verify` gate's formatting, lint, type, boundary, unit, fixture and
  production-build phases passed with this feature revision.

The new pgTAP assertions resolve each index by its required name, bind it to
the named foreign key's referencing table, compare its complete ordered
key-column array, and require both validity and readiness. They also assert the
allowed target predicate or no predicate as appropriate.
As a mutation check, the Local-only target index was recreated with
`dependency_version` and `target_release_revision` swapped. The focused
`050_definition_release_store.test.sql` suite failed its new assertion,
reporting the reordered actual array; the database was then reset from the
committed migration chain and the full suite passed.

As a separate relation-binding mutation check, a single Local transaction
recreated `source_identity_aliases_owner_idx` on `source_identities`, which has
the same five column names. The pgTAP relation assertion emitted `not ok`,
showing `source_identities` where `source_identity_aliases` was required. The
same session explicitly rolled back and a follow-up catalogue query confirmed
the original valid, ready alias index was restored. This check changed no data
or durable Local schema state.

No table, policy, grant, function, runtime result, API contract or business rule
changed. Hosted Testing delivery, hosted advisers and independent review are
separate protected steps and are not claimed by this local evidence.
