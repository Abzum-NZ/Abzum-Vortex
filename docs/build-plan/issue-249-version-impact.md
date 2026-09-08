# Native V2 application change assessment

Owner: [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249).
Policy: [version impact](../specification/appendices/version-impact-policy.md#native-v2-composition-comparison).
Sequence: [engines before designer](engine-first-application-delivery.md).

## Outcome and current position

Before publishing a changed application, explain whether its appearance,
optional capabilities, behaviour or permissions changed and calculate the
minimum next release version. The native compiler and stored V1 permission
handoff passed independent review and merged in
[PR #341](https://github.com/Abzum-NZ/Abzum-Vortex/pull/341). This is the next
bounded, database-free engine slice; it does not build the App Designer.

## Build

1. Add strict native V2 comparison request/history evidence with exact outer
   version metadata. Keep the existing V1 request and fingerprints unchanged.
2. Extend the existing compare-and-confirm operations, not a second public API.
   Reuse common component comparison and current revision/fingerprint checks.
3. Compare complete shells, slots, nested placements, guided-step content,
   settings, permission references, themes and exact catalogue dependencies by
   permanent identity. Preserve parent/owner context and meaningful ordering.
4. Apply the linked policy: distinguish same-slot presentation movement from
   moving content into different inherited access or binding context. No new
   proof framework, counters or caller approval mechanism.
5. Keep V2 publication, storage, consumer/history and restore selectors disabled
   until their coordinated implementation. No SQL change belongs in this slice.

## Acceptance

- Exact native V2 metadata is required; unknown/missing/mixed versions refuse.
- First release, no change, change reasons, minimum version and confirmation are
  deterministic; stale history/fingerprints/confirmation and duplicate IDs refuse.
- Complete nested/shell/guided fixtures distinguish same-slot reorder (patch)
  from cross-parent/slot/page/step movement (major).
- Every view/use permission change and existing setting/reference/dependency
  change is major. Optional presentation-only additions are distinguished from
  data/action/access-bearing or required additions.
- Slot requirement/category widening and narrowing are classified in the correct
  direction. Theme-only changes remain patch.
- A complete new non-public standalone page (including a guided form) is one
  minor optional capability. Its new descendants do not separately force major;
  public/replacement pages, moved existing placements, changed shared shells and
  independent dependency changes retain their normal classification.
- A representative V1 fingerprint remains exact; existing V1 comparison and
  publication/history/consumer suites still pass. Stored V2 paths remain closed.
- Independent review covers the actual patch and the whole bounded acceptance;
  clean exact-source checks precede normal Testing delivery.

## Still outside this checkpoint

V1-to-V2 publication on a root with existing V1 history needs explicit transition
comparison preserving release numbering and immutable history. Homogeneous V2
comparison does not prove that case. The coordinated path must also permit normal
publication of exact V1 content restored after V2: either supported representation
transition is major, assigned from the latest release, while each historical
entry retains its own decoder and bytes. No one-way conversion restriction.
Complete it with coordinated publication,
additive storage/readback, then confirmed draft conversion and the headless editor
adapter. Installed application proof remains
[#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64) and
[#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327); whole #249 stays open.
