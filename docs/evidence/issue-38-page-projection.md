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

## Contract delivery

The contract checkpoint merged normally through
[PR #339](https://github.com/Abzum-NZ/Abzum-Vortex/pull/339) at
`2026-09-08T00:50:28Z`. Reviewed source:
`1683b0f8971009f3fc0860b22c41594f705471d5`; Testing merge:
`a308ed54b236c7ae337a17ad8494976893404d73`.
An isolated checkout of that exact source passed all 23 package typechecks,
import boundaries and all 23 builds, including Next.js. Normal preview checks
passed before merge. Its hosted verification was queued at the last check;
no hosted success is claimed here.

## Recursive projection checkpoint

The bounded recursive projector and server-only authenticated callback seam have
passed independent Sol review. They remove refused page/subtree content and all
responsive-order references to removed placements. V1 visibility conditions need
explicit trusted admission; missing or false evidence removes the placement.
Optional V2 placement gates inherit page/ancestor admission and can only narrow it.

The review also corrected action availability: every use-gated or bound control
remains `operation_unavailable` until [#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250)
supplies the actual owning-operation integration. Page/view/use permission and
binding existence cannot substitute for that action's own current permission.
The focused tests cover the previously unsafe case where all placement gates
allow but the operation has no authority evidence.

The author reports all 10 focused tests passing. Root matched the reviewed file
hashes below. The adapter tests mock request/Access orchestration: this remains a
callback seam, not a registered stored Definition reader, shipped V1/V2 adapter,
working page route or live UI proof. Exact isolated delivery checks follow.

| Runtime candidate | SHA-256 |
| --- | --- |
| Projector | `e3f062ad1ac67f5eef756cc664fbe033b0223e14eb9c485821d0e79b335109a0` |
| Authenticated callback seam | `cb7e35ab123713d31d44dbf9f8f76812e13645517d7facb13a5b4d7e711ae307` |
| Projection tests | `4b886da1c9f901b88620bdb8934795f374977db86dc44cc2333f48016eb6b58c` |
| Callback tests | `80cb687d0f95a15b0527db33add270014cfb1f147de0b6e2d1f8d8d6136dcf4f` |

[PR #340](https://github.com/Abzum-NZ/Abzum-Vortex/pull/340) merged normally after
successful preview checks at `2026-09-08T01:17:51Z`. Reviewed source:
`0f6f03cac92d61e972e8e91364ec4ac5a7e19d75`; Testing merge:
`52e432ccbf4046fd4fc1c973707e68f25569e9de`.
Root's isolated exact-source verification passed 97 test files / 1,374 tests
(two files and three tests retain existing skips), all 23 package typechecks,
import boundaries and all 23 builds including Next.js. Focused formatting and
lint passed. The initial missing Vitest dependency declaration was corrected
using the existing workspace pattern and independently reviewed before this
successful run. No unreviewed compiler or SQL changes were included.
Hosted verification of this merge is not yet inspected.

## Remaining work

The V2 compiler, publication and stored readers remain owned by the open
[#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249). Current executable
Definition paths select V1; V2 contract parsing alone does not implement that
pipeline. Whole #38 remains open until the complete acceptance is proved.

No SQL migration, database reset, production promotion, page renderer or MCP
transport is delivered by these bounded checkpoints. The unrelated uncommitted
row/field enforcement candidates are not part of it.
