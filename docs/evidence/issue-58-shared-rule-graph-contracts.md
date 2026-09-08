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

At the initial contract milestone these were **candidate contracts**, not a completed Rule engine or a successful
record save. Definition compilation, semantic graph validation, identity
allocation, publication, consumer reads, restore and explicit draft conversion
were still required before the interpreter. The initial structural embedding
tests did not claim those operations accepted Module 3. The subsequent milestone
below records the integration evidence separately.

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

## Definition integration milestone

The following work extends the contract milestone without adding an interpreter:

- Source identity resolution allocates graph nodes, inputs and variables within
  their permanent rule owner. The exact Module 3 pair remains separate from the
  unchanged V1/V2 formats.
- Complete linked Module fixtures compile through the ordinary Definition entry
  point. Compilation resolves field and dependency references, normalizes exact
  values and retains source provenance. Presentation reordering preserves the
  canonical artifact.
- The real publication gate checks node connections, finite reachable paths,
  legal field writes, compatible values and variables assigned before use.
- The publication service prepares and publishes the complete graph, the consumer
  reads it, and the history service restores its authored source. Repository
  decoding covers the same V3 draft format. These service tests use in-memory
  repositories and a database-query fixture; they are not hosted database tests.
- Existing graph behavior changes and V2/V3 representation changes receive major
  version impact. Unchanged canonical content does not create a new release.
- Table flow values declare only their data columns; record-field storage and
  value policy remain with the owning field.

Final local integration regression: **1,101 tests in 80 files passed**, covering
Contracts, Definition, Rule and the complete fixture set. All **23 package type
checks passed**. Scoped lint, formatting of all 41 changed files, package
boundaries and diff checks passed. Independent Sol reviewed the frozen actual
integration and approved it after the reference-default and parsed-data traversal
corrections; its final focused run passed **43 tests in 8 files**. The next draft
conversion slice is excluded from this frozen integration receipt.

Explicit new-draft conversion of older rules is next. Shared execution and the
protected save remain unfinished under [#58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58)
and [#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47).
