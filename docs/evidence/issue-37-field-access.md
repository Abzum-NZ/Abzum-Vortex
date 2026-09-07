# Field-access implementation evidence

Task: [#37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37). Scope and acceptance: [implementation plan](../build-plan/issue-37-field-access.md).

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
