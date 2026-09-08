# Shared before-save Rule runtime

[Rule engine #58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58) ·
[Protected save #47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47) ·
[Implementation plan](../build-plan/issue-58-shared-rule-graph-foundation.md)

## Functionality

The first shared interpreter consumes an exact published Module 3 definition.
It selects applicable before-save graphs and follows their explicit connections,
in priority and permanent rule-ID order. Start, Condition, Set variable, Set
field, Require field, Warn, Refuse and Finish share that interpreter. Existing
typed condition behavior is reused rather than replaced by another expression
engine.

Run-local typed inputs and variables retain exact value formats. Later nodes see
earlier candidate changes. Missing values, explicit clearing and previous values
remain distinct; a create operation has no previous record. An explicit refusal
returns no applicable patch. Requirements and warnings accumulate without a
database write.

Record-owned preparation now separates typed initial values from final owning
field policy. This allows a configured rule to supply a required value or correct
an intermediate value before validation. Final checks include required generated
values after their owning generators and accumulated Rule requirements. The
existing public field-preparation wrapper retains its prior behavior. Neither
helper is an authorization boundary or a successful save result.

## Scope of the connected proof

The higher-level fixture test uses Definition publication and consumer-read
operations, the shared Rule interpreter and the Record candidate helpers through
their public package boundaries. Definition persistence in this test uses a
test adapter. This demonstrates engine handoffs, not a hosted database save.

The actual protected transaction, current Access, authoritative generators,
reference checks, Activity and Event delivery remain required by #47. Interactive
forms, query/action profiles, background starts, MCP and App Designer integration
remain unfinished portions of #58 and its owning dependencies.

No new database operation, permission grant, UI, application-specific runtime
behavior or AI functionality is introduced by this interpreter milestone.

## Verification

- Combined Contracts, Definition, Rule, Record and fixture regression: 85 files,
  1,182 tests passed.
- Workspace type checking: all 23 packages passed. Package boundaries: all 23
  packages passed. Scoped lint, formatting and diff checks passed.
- An independent Sol reviewer approved the actual frozen implementation after
  independently running Record's 40 tests, Rule's 25 tests and the connected
  Definition-to-Rule-to-Record fixture test. Frozen file hashes matched.
- Review corrections ensure final validation includes required generated values
  and remove redundant whole-definition validation from every rule execution.
  Runtime inputs and bounded graph traversal remain checked.

An earlier combined run during workspace dependency installation could not
import some packages. After restoring the locked dependencies, the complete
1,182-test run above passed; the interrupted run is not counted as a completed
regression run or an application assertion failure.

This milestone does not establish hosted database verification or complete #47
or #58. No production promotion is included.
