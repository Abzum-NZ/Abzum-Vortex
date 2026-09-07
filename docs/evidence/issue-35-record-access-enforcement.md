# Record-access enforcement evidence

Task: [#35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35). Governing scope: [row-policy composition plan](../build-plan/issue-35-row-policy-composition.md).

## Testing source delivery — 8 September 2026

[PR #333](https://github.com/Abzum-NZ/Abzum-Vortex/pull/333) merged through the normal protected Testing path at `2026-09-07T20:16:16Z`, after both preview checks succeeded. Source `032fb23472e1810dbc4d1b3007d28ac27c9c69a3` is the source-identical branch update of reviewed `ee496da9117ceee66209fb1c27a231251adf34be`; Testing merge is `80c5b626177a255cbccba6207f9d7e8ca0f81e7c`. The change contains compiler metadata, tests and documentation, not the unfinished record-policy SQL or assignment-cleanup work. No Production promotion or exact hosted database receipt is claimed.

The scoped security diff review of compiler commit `d69a3672cb77d56f6f6d5ce06d4f310069937685` completed as scan `81973b14-5243-448e-b2a6-ea0bf0db8b50`: six changed production files and three changed tests were inspected with no reportable findings or deferred in-scope candidates. It included an independent architecture review and retained the original failed full-verification result and the later, separately reviewed test-import correction. It is not a repository-wide audit or a proof of the pending database runtime.

## Permission-alternative definitions — 8 September 2026

This checkpoint supports one action with several declared permission routes, so a future shared screen can serve people with own-record or wider access. It defines and validates those alternatives; it does not execute an action or establish a final database record-access decision.

Reviewed compiler source: `d69a3672cb77d56f6f6d5ce06d4f310069937685`. Test-only package-boundary correction: `72dc55c1f36473036fc8f5c4abfd0a4e1f91170e`.

| Delivered behavior | Verification |
| --- | --- |
| Single-permission compatibility | Existing authored `permission` and compiled `permissionKey` remain unchanged. No immutable historical definition is rewritten. |
| Explicit alternatives | Mutually exclusive `permission_alternatives` / `permissionKeys` require at least two unique, canonically ordered keys. Missing, mixed, duplicate and noncanonical bindings refuse. |
| Exact meaning and owner | Each alternative resolves to the same subject record and action meaning; named alternatives share their actual declaring owner. Application actions can bind module permissions. Ambiguous application/module keys refuse. |
| Complete compilation and provenance | Both module-owned and application-owned action examples compile and pass the complete definition-set validation. Every alternative maps back to its authored location. Interface exposure permission stays separate. |
| Release impact | A changed permission set produces one major permission-change reason. An unchanged plural set produces no change. |
| Independent actual-work review | Sol approved the nine implementation/test files after correcting the positive full-validation proof, discriminating key-collision proof and plural-set comparison coverage. A separate Sol review approved the later one-line test-import correction. |

The initial isolated full check found that the new contract test imported its own package by workspace name, violating the repository's package-boundary rule. The correction imports the existing local source entry instead; production code is unchanged. The earlier compiler review and focused tests alone did not establish a passing whole-workspace gate.

After that correction, the isolated snapshot passed the complete database-free `pnpm verify` gate: formatting, lint, all 23 package typechecks, package boundaries, **1,308 tests across 88 passing files**, **8 fixture checks**, and all 23 build tasks including the Next.js production build. Three live Identity tests across two files were intentionally skipped because this isolated run had no live proof credentials. The snapshot used its own locked dependencies rather than workspace links back to unfinished source. A byte/content comparison against Git verified all **609 tracked files** matched `72dc55c1f36473036fc8f5c4abfd0a4e1f91170e`.

These checks do not prove hosted database delivery, live Identity behavior, field enforcement, generated storage, or a complete user-facing application. No App Designer work was added.

## Private eligibility checkpoint — unmerged

The separately reviewed private eligibility core retains each candidate's exact permission identity, record scope, immutable source and validity deadline while preserving the existing non-record wrapper. A rollback-only test run passed **57/57** new SQL assertions, with unchanged legacy SQL290 **48/48** and SQL300 **28/28** also passing. The corrected new proof includes two simultaneously eligible alternatives with different scopes and 15/20-minute deadlines, preserving both contributions and the minimum overall deadline. Independent Sol review approved the exact corrected SQL425 hash `e21d9e6cc5f5427f720f04d9934cb59ed1dfc2aee754c5c2a1a486556aaae00d`.

That checkpoint remains unfinished delivery work: its migration and tests were not committed or merged with the compiler change, and its rollback-only proof persisted no database state. It must participate in a complete per-permission row-scope decision and four-operation neutral policy proof before SQL delivery. The next implementation composes the existing ownership, share, saved-condition and relationship primitives; [field enforcement #37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37) and [generated storage #45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45) remain downstream.

## Recorded state

- #35 remains **In progress**; no complete row-enforcement claim is made by this metadata checkpoint.
- The implementation plan and Access specification preserve one central decision, exact permission/scope pairing, no new authority cache, and conservative expiry checks for both states of an update.
- [Complete file-defined application proof #327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327) includes module/application-owned actions and both permission representations through the completed engine; it still precedes App Designer delivery.
- No new dependency was introduced. Existing hosted receipts remain unverified. The separate #40 removal-only cleanup was approved on 8 September and remains outside this implementation; it does not resolve #35's separately recorded tool-execution restriction.
