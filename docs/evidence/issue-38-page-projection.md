# Page permission projection evidence

Task: [#38](https://github.com/Abzum-NZ/Abzum-Vortex/issues/38).
Scope: [reviewed implementation plan](../build-plan/issue-38-page-capability-projection.md).

## Optional V2 placement permission contracts — 8 September 2026

The existing recursive placement schemas now accept optional authored
`view_permission` / `use_permission` and canonical `viewPermissionKey` /
`usePermissionKey`. This covers shell, page and guided-step placement shapes
without adding a Section entity. Omitted values remain omitted; no defaults or
immutable-release rewrites are introduced.

An independent Sol reviewer approved the actual source/test slice. Root's first
typecheck found narrow inferred fixture types in the new test; the author replaced
direct assignments with `Object.assign`, preserving all values and assertions.
The reviewer approved that test-only correction without repeating the full review.

Frozen files:

| File | SHA-256 |
| --- | --- |
| [V2 composition contracts](../../contracts/src/application-composition-v2.ts) | `0896810b2ab358893e4bbd8eac755eee54307e8e303bb5cbec1dcfba4beaa8c8` |
| [Composition tests](../../contracts/test/application-composition-v2.test.ts) | `c420f54551fb9add608884fc879f71ba03cd3a6626d6a0ae0ce8773a1360dc98` |

Root verification: complete contracts suite passed, 33 files and 500 tests;
contracts typecheck and focused formatting passed. The focused composition suite
also passed all 46 tests. These are local contract checks, not a hosted V2
publication or rendered-interface proof.

## Remaining work

The contract checkpoint merged normally through
[PR #339](https://github.com/Abzum-NZ/Abzum-Vortex/pull/339) at
`2026-09-08T00:50:28Z`. Reviewed source:
`1683b0f8971009f3fc0860b22c41594f705471d5`; Testing merge:
`a308ed54b236c7ae337a17ad8494976893404d73`.
An isolated checkout of that exact source passed all 23 package typechecks,
import boundaries and all 23 builds, including Next.js. Normal preview checks
passed before merge. Its hosted verification is queued, not claimed complete.

The recursive projection and trusted authenticated adapter are still in progress.
The current adapter is a server-only integration seam, not a registered stored
Definition reader or a working page route. Independent review found that control
availability must also require the bound operation's own current authority;
placement view/use permission and binding existence are insufficient. The author
is adding that refusal coverage before this runtime candidate is delivered.
The V2 compiler, publication and stored readers remain owned by the open
[#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249). Current executable
Definition paths select V1; V2 contract parsing alone does not implement that
pipeline. Whole #38 remains open until the complete acceptance is proved.

No SQL migration, database reset, production promotion, page renderer or MCP
transport is delivered by this contract checkpoint. The unrelated uncommitted
row/field enforcement candidates are not part of it.
