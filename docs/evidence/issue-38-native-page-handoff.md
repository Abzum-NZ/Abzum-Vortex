# Published pages and shared-layout visibility

Task: [#38](https://github.com/Abzum-NZ/Abzum-Vortex/issues/38).
Plan: [Page permission projection](../build-plan/issue-38-page-capability-projection.md).
Date: 8 September 2026.

## Delivered implementation

- One stored-page adapter selects the exact supported V1/V2 published application
  through the existing Definition/Access source and permission registration.
- Native pages attach their content to the selected shared layout before
  permissions are collected and applied. A refused parent removes its injected
  content; allowed siblings and custom layouts remain usable.
- Guided forms retain each step's own content and responsive order. An optional
  empty slot or a permitted layout emptied by filtering is a valid runtime result.
- Existing V1 behaviour remains intact. Published source is not mutated and the
  resolved per-person result is not a new canonical definition.
- Viewing a component grants no operation authority. Missing operation bindings
  remain unavailable. V2 conditions use the existing trusted evaluation hook;
  no extra evaluator or data-access path is created.

## Independent actual-work review

A different GPT-5.6 Sol agent reviewed the Page changes against the full task and
its approved plan. One concrete finding was corrected: separately valid shell
and page inputs could reuse a placement identity and therefore reuse the wrong
permission result. Resolution now checks unique ownership across the original
selected shell and page content before cloning guided layouts. Legitimate reuse
of that same shell across guided steps remains supported. No continuity counter,
fingerprint scheme or second permission engine was added.

The reviewer rechecked the fix and approved with no remaining actionable findings.
Their direct checks passed: four Page test files, 19 tests, Page type checking and
scoped diff checks. Root also confirmed that the earlier missing `postgres`
diagnostic came from restricted worktree dependency access: the permitted build
environment resolves the existing dependency and passes the same type check.
Nothing was reinstalled or changed to work around that diagnostic.

## Exact source verification

Source `7ba07de6ff5617bc749a770a0abf89b5a01bfb1f` is in
[PR #346](https://github.com/Abzum-NZ/Abzum-Vortex/pull/346). An isolated checkout
excluded the concurrent unfinished conversion work and passed 1,405 tests across
101 test files. Three existing opt-in identity integration tests were skipped.
All 23 package boundaries passed.

Normal preview and root lint both identified two unused bindings in the stored
page test fixture. The developer replaced only that fixture's property omission
construction, preserving its meaning and every runtime file. The independent Sol
reviewer accepted this one-file delta and directly passed its five tests, lint
and diff check. Reviewed SHA-256:
`75A074316BE5B770635D1E9E07BD0BB8139BE1945DBFC7CE8EA3DBD961FEC145`.
No lint rule or test expectation was weakened. Final source
`bb9fa094947018ebe53332dfe2665640c9dde5bc` passed the normal preview checks
and all 23 package type checks/builds. PR #346 merged to Testing at
2026-09-08T06:39:04Z as
`bfc75202ff870c10eff1c6bc424134a7d61a8fa8`. Its
[hosted execution](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/2RMK74QpwbkNYtQRHPY4gN)
failed at 2026-09-08T07:03:43.932Z: invitation tests 47/51 expected one account
but observed two, and role-storage test 35 also failed. The run executed 60 files
and 2,670 assertions; it did not issue a success receipt or complete the later
concurrency gate. Investigation of the existing fixture assumptions is underway.
This is not a successful hosted verification, and the task remains open.

## Scope and remaining delivery

This completes the remaining engine implementation, not a live application page.
Source delivery is recorded above; exact hosted verification remains required
before task closure.
The already reviewed earlier contract/compiler/projector work is not duplicated.

- [#64](../build-plan/issue-64-application-runtime.md) supplies installed release
  selection and real service context; it consumes the resolved filtered result,
  never reattaching raw shell content after filtering.
- [#69](https://github.com/Abzum-NZ/Abzum-Vortex/issues/69) integrates navigation,
  direct routes and live rendered/semantic controls. Its previously blank engine
  acceptance item now records this actual handoff.
- [#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250) owns actual bindings;
  [#107](https://github.com/Abzum-NZ/Abzum-Vortex/issues/107) owns anonymous
  authority; [#200](https://github.com/Abzum-NZ/Abzum-Vortex/issues/200) owns MCP
  transport. No renderer, route, context issuer, SQL migration or designer was
  introduced here.
