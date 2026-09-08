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
passed before merge. Root then verified the exact hosted Testing receipt:
[execution 14aEJXmiZwWKadqFRMsjuM](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/14aEJXmiZwWKadqFRMsjuM)
succeeded at `2026-09-08T01:58:31.261Z`; the schema-2 receipt was published at
`2026-09-08T01:58:31.218Z` for the exact Testing merge above. It records 66 applied
migrations, all 25 selected concurrency proofs completed, and all six selected
lint schemas completed. Migration-set, runner, manifest and coverage fingerprints
match the preceding verified delivery. This contract-only merge has no changes
to `supabase` or `workflows/kestra` compared with the preceding merge. Reading
the receipt did not change settings, queues or database contents.

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

## Stored V1 adapter checkpoint — 8 September 2026

The server-only adapter now selects one exact stored application revision and
page, reads through the existing Definition consumer, resolves registered
permission identities, and separately projects the current human's page access.
An injected trusted system context is required; this is not a context issuer or
an installed-application selector. An application-scoped context cannot select a
different application. Both stages use the same server-owned correlation.

Independent review corrected the application-scope and correlation checks. Root
also identified that the first implementation used the runtime database role,
which cannot execute the existing consumer read. The final implementation reuses
the existing resolved request runner, including context initialization followed
by the request-role transition. No database grants, functions, migration or
second transaction framework were added.

Root verified 15 page tests and the page package typecheck. The additional proof
uses the real transaction runner with a test driver to verify role-transition
ordering; Definition and Access orchestration are mocked. Existing Definition
integrity tests and SQL consumer-read tests remain separate proofs. This is not
a new combined live-database test or a deployed page route. Independent Sol
review approved the bounded adapter; exact-source delivery verification follows.

| Reviewed implementation | SHA-256 |
| --- | --- |
| Stored adapter | `447cb5daa9ed302813d1e888c4abcefa36d914a76ac3c00919bbf8f2fb7f5095` |
| Authenticated handoff | `aef341afed1f5602fa98fbd8d8f8f46def95484b7a677ac586bdab75473dd890` |

### Exact-source check and ownership correction

Source `02364d1` passed an isolated 98 test files / 1,379 tests (two files and
three tests retain existing skips), all 23 package typechecks and all 23 builds,
plus scoped lint/formatting. However, the package-boundary check correctly refused
Page's direct use of the Access-only request runner and its private-schema test
assertion. This source has not been merged for Testing delivery.

The reviewed correction moves only the fixed stored application/permission-source
read to Access. Page retains page selection and projection. The temporary public
database factory export and private-schema assertion are removed; existing
database runner tests retain role-ordering proof. No boundary exception is added.
Independent Sol review approved the corrected implementation, including removing
redundant application/revision dependency fields so the fixed selection is the
sole selector. Root verified 14 page tests, page typechecking and all 23 package
boundaries. Author verification also passed 372 Access tests and Access
typechecking. New tests exercise operation-specific orchestration using injected
dependencies; they do not replace the existing database runner/consumer proofs
or claim a new live installed-application integration.

Final reviewed Page adapter:
`97c01c21d762b021cb6d955983757320fe13fc1904212565ca70676864e37b10`;
Page test: `80b1a66e042bda9947e74babe2c4949ec656853545763eda61e855331ed20f22`.

### Corrected checkpoint delivered to Testing

[PR #341](https://github.com/Abzum-NZ/Abzum-Vortex/pull/341) passed normal preview
checks and merged at `2026-09-08T02:25:37Z`. Reviewed source:
`92c5baa083732e26f3e2fb903295ba9ed5ff870d`; Testing merge:
`73f33ecc7db97d912a15f1e71b8efec44c8cdb4c`.
Root's clean isolated exact-source verification passed 100 test files / 1,386
tests (two files and three tests retain existing skips), all 23 package
typechecks, boundaries and builds including Next.js, and changed-code lint,
formatting and diff checks. This includes the corrected Access-owned read and
the independently reviewed native V2 compiler checkpoint. No SQL candidate or
new grant was included. Hosted verification of this merge is not yet inspected.

## Remaining work

The native V2 compiler checkpoint is delivered through
[#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249), but V2 publication
and stored readers remain unfinished there. Current stored Definition paths
select V1; compiler coverage alone does not implement that publication pipeline.
Whole [#38](https://github.com/Abzum-NZ/Abzum-Vortex/issues/38) remains open until
the complete acceptance is proved.

No SQL migration, database reset, production promotion, page renderer or MCP
transport is delivered by these bounded checkpoints. The unrelated uncommitted
row/field enforcement candidates are not part of it.
