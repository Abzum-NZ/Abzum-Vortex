# Shared record-save command — local contract evidence

[Task #47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47) ·
[Implementation plan](../build-plan/issue-47-save-command.md) ·
[Specification](../specification/appendices/data-contracts.md#record-save-command-and-result)

## Bounded implementation

The existing Record contract file defines strict V2 create/update commands and
saved, correction-required and refused responses. Forms, flow nodes, imports and
MCP can use this same boundary. It contains no application-specific fields,
database access, preliminary save engine, Event stub or caller-provided authority.
Its existing public export is unchanged.

Create omits an existing record identifier and revision; update requires both.
Sparse submitted field maps preserve missing/null distinctions, empty changes and
exact decimal text. Saved and conflict projections contain readable values, not
the full internal stored-record contract. Only conflict allows an optional current
projection. Shape validation does not establish authorization or disclosure safety.

## Frozen implementation

| File | SHA-256 |
| --- | --- |
| `contracts/src/records.ts` | `7c3fbda9815ba11c8b44f34dab4319177458d17535fe041ea1ab03a48159abf5` |
| `contracts/test/records.test.ts` | `4cd3e50b3dffd6658a9c7d70709c0cdbb68a295db197552353354c3e4726c997` |

The author reports 54/54 focused Record/general contract tests, Contracts
typecheck, scoped lint, formatting and diff checks passing. The independent Sol
reviewer approved the exact frozen implementation with no findings, independently
ran the same two-file focused suite (54/54 passed), and checked the scoped patch
and documentation. These checks are not a hosted save test.

## Remaining acceptance

The real protected save still must resolve exact installed definitions and
current Access, apply field/reference validation, rules, calculations and totals,
and atomically commit records, relationships, Activity, Events and the command
receipt. Current readability must be reapplied on receipt replay. Those are
remaining requirements of the same task, not successful mocks supplied by this
contract slice. No database, hosted environment or release was changed by this
implementation. The whole task remains open.
