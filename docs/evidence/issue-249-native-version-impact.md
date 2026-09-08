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

Exact committed-source verification and normal Testing delivery follow; no hosted
result for this comparator is claimed yet. The prior compiler delivery is
[separately verified](issue-249-native-application-compiler.md).

## Remaining task scope

This homogeneous V2 comparator does not enable V2 stored publication, readers,
history or restore. Persisted V2 drafts/identities, exact block dependencies,
coordinated version-selected publication and symmetric V1/V2 transition handling,
confirmed draft conversion and the headless editor adapter remain. Whole
[#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249) and
[#38](https://github.com/Abzum-NZ/Abzum-Vortex/issues/38) stay open. No SQL candidate,
Production promotion or designer UI is included in this checkpoint.
