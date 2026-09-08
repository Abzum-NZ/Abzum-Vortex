# Native application composition compiler checkpoint

Task: [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249).
Specification: [page composition contracts](../specification/appendices/page-builder-contracts.md).
Sequence: [engines before designer](../build-plan/engine-first-application-delivery.md).

## Scope — 8 September 2026

The existing Definition compiler entry point now selects the exact supported
Application V1 or V2 source/validation pair. Native V2 compilation materialises
reusable shells and slots, nested placements, distinct guided-form step content,
typed settings, responsive inheritance, theme content and exact catalogue
dependencies. It resolves page actions and placement permission references in
their allowed owner context, with deterministic identities and leaf provenance.
V1 behavior remains unchanged; no V2 stored publication/read/restore selector is
enabled by this checkpoint.

Root and the Sol author corrected concrete theme, slot, inherited-layout and
provenance mapping errors before freezing the candidate. Reference-shaped literal
property keys stay literal. Compilation does not depend on business application
names; the existing example applications are test data only.

Independent Sol review found a missing accessible-name declaration in the
catalogue. The fix completes the planned contract: required and optional names
declare an exact property path through groups to text. Compilation uses the
materialised value after defaults. Required names must exist; any supplied name
must contain non-whitespace text. Optional absence is allowed. No property name
is guessed, and no temporary refusal of all accessible blocks was introduced.

## Review and verification

Independent Sol review approved the actual final compiler and contract files.
Root's focused contract/compiler checks passed 51 tests, Definition typechecking
and scoped lint. The final full Definition suite passed 307 tests and the full
contracts suite passed 501 tests.

Root verified exact source `92c5baa083732e26f3e2fb903295ba9ed5ff870d` in a
clean isolated worktree: 100 test files / 1,386 tests passed (two files and three
tests retain existing skips), all 23 package typechecks, import boundaries and
builds passed, including Next.js. Changed-code formatting, lint and diff checks
passed. [PR #341](https://github.com/Abzum-NZ/Abzum-Vortex/pull/341) passed the
normal preview checks and merged into Testing at `2026-09-08T02:25:37Z`, merge
`73f33ecc7db97d912a15f1e71b8efec44c8cdb4c`. Hosted verification of this merge
has not yet been inspected. Neither these results nor the merge enable V2
stored publication or close this task.

| Reviewed file | SHA-256 |
| --- | --- |
| Composition contracts | `00777629ee5a65d92963a5ffc51c1ecc0dd2dc9350e3737352a841ed3ce95f1b` |
| Contract tests | `009d7e4ca95153a3703cf9f7f060e747f1830b57011f5ffdeb96ff6891c2fc91` |
| Compiler | `c3d0df357c7977f4b813c9e9e25d6605589a2cb2cfac02294e06d967d1f0bf35` |
| Composition materialisation | `41dbe5a5861d1eb5de4169a6978948d37e2b9f07cd07a44f9c00007a5c582918` |
| Resolution mapping | `bcf79bc03997082b9b2f7bf3c93eb1b1e934aa03449f65bbe2103ee2eae96b61` |
| Compiler tests | `a828d72237f5febb28d4964b62290e5304231c76ea15833ecc06f8922654e866` |
| Definition exports | `209db11061810abd34a448120a09f07074236657e791fa02c0b35ad96483ed79` |

## Still required by the task

Complete V2 version-impact comparison, coordinated publication/storage and exact
consumer/history/restore support, explicit draft conversion, and the pure editor
adapter remain required by [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249).
The [page visibility task](https://github.com/Abzum-NZ/Abzum-Vortex/issues/38)
depends on that real published V2 integration. Contract parsing or compiler tests
do not close either task. Later installed application execution belongs to
[#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64), and complete file-defined
application acceptance remains with
[#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327), before the designer.
