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

This milestone merged into Testing through [PR #367](https://github.com/Abzum-NZ/Abzum-Vortex/pull/367)
at `87fa4d596dce50a02e77ec3bd50849a8114847f3`, after its ordinary preview check
passed. A preview build is not a hosted database or user-journey verification.

Read-only storage follow-up found that the database's existing identity-kind
constraint did not include graph nodes, inputs or variables. The storage proof
below addresses that gap separately; the local service receipt above does not
imply database compatibility. No new privilege or storage system is required.

Explicit new-draft conversion of older rules is next alongside that storage proof. Shared execution and the
protected save remain unfinished under [#58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58)
and [#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47).

## Explicit draft conversion milestone

The pure V2-to-V3 converter preserves supported triggers, recursive conditions,
rule identity/priority, typed assignments and clears, requirements, warnings and
refusals. The V1 entry point reuses existing V1-to-V2 field conversion. Both
preserve their input and return a new source document, not a stored publication.
Unsupported behavior and missing safe messages produce located diagnostics.
Writes to generated reference numbers, calculations and totals are diagnosed,
including clears; conversion does not make those fields ordinarily writable.

Independent Sol actual-patch review approved the exact three-file converter
slice after correcting the generated-field diagnostic. Its verification passed
**48 tests in 3 files**, covering both converter generations and actual Module 3
compilation/semantic validation. The author's converter-only run passed 29 tests;
Definition type checking, scoped lint/formatting and all 23 package boundaries
also passed. Database persistence and Rule execution are not implied by this
receipt.

## Database identity compatibility proof

The migration adds exactly `rule_node`, `rule_input` and `rule_variable` to the
existing `source_identities_kind_valid` constraint, preserving all older kinds.
It changes no functions, grants or row policies. Supabase CLI 2.116.0 generated
the migration filename.

The author verified the exact local Vortex project/container
`supabase_db_Abzum-Vortex` (PostgreSQL 17). The migration and focused pgTAP suite
ran together inside a rollback-only transaction: **14 assertions passed**. The
same harness passed the existing source-identity suite's **49 assertions**.
The proof exercises ordinary root creation, revision-checked draft editing and
restore with stable graph child identities, retained alias history, refusal of
foreign-organisation edits and atomic refusal of unsupported identity kinds.
Minimal storage fixtures and a seeded release isolate the allocator; this is
not a full compiled-application installation or a hosted publication journey.

Both runs rolled back, and a subsequent constraint inspection confirmed no
graph kind remained installed locally. No migration history was written. These
results establish local compatibility, not application to Testing or Production.
