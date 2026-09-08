# Native application change assessment checkpoint

Task: [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249).
Scope: [build and acceptance plan](../build-plan/issue-249-version-impact.md).
Rules: [version-impact policy](../specification/appendices/version-impact-policy.md#native-v2-composition-comparison).

## Outcome — 8 September 2026

The existing compare-and-confirm engine can assess native V2 application content:
shells, named slots, nested page and guided-form placements, exact block releases,
typed settings, access references, responsive order and themes. It distinguishes
appearance changes, optional additions and changes to existing behaviour. It
uses exact V2 request/history metadata, existing revisions and fingerprints, and
does not create another publication service, database store or approval gate.

A new non-public standalone page, including a guided form, is one optional minor
capability. Its new field/query/action-bearing descendants do not independently
force a major version. Existing content moved into that page remains a major
change, as do independent dependency changes and public/replacement pages.
This corrects an unnecessarily restrictive initial subtree rule, consistently
with the existing V1 page policy. Existing-page content keeps its normal rules.

## Review and checks

Independent Sol reviewed the actual final code and scoped acceptance and approved
it without remaining material findings. Root verified the same file hashes.
There is no business-name-dependent core branch. Root checks passed 100 test
files / 1,395 tests (two files and three tests retain existing skips), all 23
package builds including Next.js, all 23 package typechecks and import boundaries,
and changed-code lint/format/diff checks. The final page correction also passed
the Definition typecheck and the focused 174-test comparison/compiler suite.

The new V1 golden comparison fingerprint was independently established by running
the same test against pre-change source `92c5baa083732e26f3e2fb903295ba9ed5ff870d`:
`sha256:818a1405cf5bd1c43860a5bbb471242210e136e1925c71f1bd48afa2c88728ec`.
It remains exact in this implementation. Comparison does not mutate canonical
content; semantic normalization never rewrites stored bytes or fingerprints.

| Reviewed file | SHA-256 |
| --- | --- |
| Comparison contracts | `fdbf2d08f381a14bc2c81621a19c9d60065e243a1f83866477f758b2aa3ffd06` |
| Compare/confirm operations | `d58c11db72a1d0820137684a25200a5cfde8aadec5f200494e7a39d9567381b2` |
| Comparison policy | `a134f0f9faff2cc134ad09d1513ea4b717c1dac9d3f6023aded9e9e29e0a1c2c` |
| Native compiler/comparison tests | `3de7f38b685b6dde5de90017ea7615435f35f548f1a43fe4970cfef292f491d4` |
| V1 comparison tests | `9c44cbcc7a4f07bf62614b4be94fe90a90433a4e82a955567217b0f02f660ea1` |

Exact source `113f58cf36cc97e45e566cf1e51507ecad2669f1` passed the same complete
checks in a clean isolated worktree, including frozen offline dependency install.
Normal preview checks passed and
[PR #342](https://github.com/Abzum-NZ/Abzum-Vortex/pull/342) merged to Testing at
`2026-09-08T03:33:43Z`, merge `426c2739d8bda0eecf65bf77b9e8ea5c98e4fa15`.
Hosted Testing is verified for that exact merge. Execution
[`14NmonuXq1v5NDkT2Bdy2P`](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/14NmonuXq1v5NDkT2Bdy2P)
succeeded at `2026-09-08T04:14:07.078Z`; the schema-2 receipt was written at
`2026-09-08T04:14:07.024Z`. It names the exact repository, Testing ref, merge
commit and execution, with 66 migrations, all 25 selected concurrency proofs
completed and all six selected lint schemas completed. Root read the full receipt
and captured the successful execution screen without changing settings or runs.
The database/runner source diff from the preceding Testing merge is empty.

| Receipt evidence | SHA-256 |
| --- | --- |
| Migration set | `ec6b40803297598bfda603618d5178b7cccc3c6d8d673859d409fd47b72d07c2` |
| Runner | `49ca962194c35b4aaa8dc5af6fbaa392604f81df94b70836977f8b1376e68046` |
| Verification manifest | `0cfcb4d9995f0c79b132b479a4ec56448d504fa097520fc6610908d21c99dfc8` |
| Coverage | `7345fd22aa5f8040ddb4356965377e8863dbb5f6ff51bb666d6bc16c8c605f0e` |

The prior compiler delivery is [separately verified](issue-249-native-application-compiler.md).

## Remaining task scope

This homogeneous V2 comparator does not enable V2 stored publication, readers,
history or restore. [Persisted V2 drafts/identities](../build-plan/issue-249-native-draft-storage.md), exact block dependencies,
coordinated version-selected publication and symmetric V1/V2 transition handling,
confirmed draft conversion and the headless editor adapter remain. Whole
[#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249) and
[#38](https://github.com/Abzum-NZ/Abzum-Vortex/issues/38) stay open. No SQL candidate,
Production promotion or designer UI is included in this checkpoint.
