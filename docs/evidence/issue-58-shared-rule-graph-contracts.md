# Shared Rule graph contracts — first profile

[Task #58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58) ·
[Implementation plan](../build-plan/issue-58-shared-rule-graph-foundation.md) ·
[Specification](../specification/appendices/frontend-rule-designer.md)

## What this change establishes

- One source/canonical node-graph representation, initially describing before-save
  rules with Start, Condition, Set variable, Set field, Require field, Warn,
  Refuse and Finish.
- Exact decimal, money and reference values use the existing field-value formats.
  Source aliases remain distinct from permanent canonical identities; dependency
  record types can be declared explicitly.
- Module 3.0.0 composes these graphs with the existing V2 fields. Historical V1/V2
  definitions retain their existing meaning and supported readers.
- A complete structural source/canonical example covers all eight node types and
  both condition outcomes. The fixture inventory explicitly lists and validates
  this new graph category alongside the existing application examples.
- Invalid HTTPS values now return ordinary validation failures. The previous
  shared URL refinement could throw while parsing malformed values; the repair
  uses the installed validation library's native HTTPS restriction.

## Scope of the evidence

The contract tests cover structural parsing, exact-value formats, alias/identity
separation, duplicate identifiers/ports/targets, deterministic canonical ordering,
explicit version pairs and bounded condition parsing. The existing fixture
inventory check still requires every JSON fixture exactly once.

These are **candidate contracts**, not a completed Rule engine or a successful
record save. Definition compilation, semantic graph validation, identity
allocation, publication, consumer reads, restore and explicit draft conversion
must be proven before the interpreter is written. Current Module 3 structural
embedding tests do not claim those operations already accept Module 3.

The remaining interactive, query, protected-action, form, background-workflow and
MCP requirements remain on [#58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58).
No designer, database operation, permission bypass or parallel legacy save runner
is introduced by this change.

## Verification receipt

- Independent Sol actual-patch review approved the frozen 13 code/test/fixture
  files with no remaining findings and matching file hashes.
- Independent focused checks: 30 tests, Contracts type checking, scoped lint and
  diff check passed.
- Root regression run against the frozen files: **1,052 tests in 71 files passed**
  across Contracts, Definition, Rule and the complete fixture set. The run used
  two workers to avoid local contention; no test timeout was increased.
- The authors also verified Testing type checking, formatting and all 23 package
  boundaries. Hosting/deployment is not claimed by these local checks.
