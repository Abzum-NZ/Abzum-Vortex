# Preserve existing placement behaviour before conversion

Task: [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249).
Precedes: explicit V1-to-V2 draft conversion.
Follows: [coordinated native publication](issue-249-native-publication.md).

## Outcome and demonstrated gap

V1 placements can declare `visibility_condition` and `query`. Native V2
placements currently retain view/use permissions but have no place for these two
existing properties. Conversion must not silently discard a condition or change
which query supplies a component. Moving these properties into arbitrary settings
would change their meaning and make behaviour depend on a catalogue property name.

Keep the same optional properties in V2, compiled and verified through existing
condition/reference machinery. This is compatibility for existing functionality,
not the richer related-record/form/flow binding engine in
[#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250). It adds no reverse
dependency on that task, new evaluator, store, permission mechanism or UI.

## Bounded implementation

1. Extend existing authored and canonical V2 placement schemas/types with the
   optional V1 semantics: authored `visibility_condition` and `query`; canonical
   `visibilityCondition` and `queryId`. Absence remains absent, preserving existing
   V2 bytes/fingerprints. V1 contracts remain unchanged.
2. Reuse the existing condition compiler and exact field/query resolution. The
   composition compiler may receive an internal typed condition-resolver callback;
   do not create another evaluator or relocate unrelated compiler logic.
3. Traverse only these declared paths for source validation, dependency discovery
   and provenance, including shells, child slots and each guided step. Literal
   settings remain opaque. Unknown or foreign references fail through existing
   reference checks, without inventing primary-page-record equivalence.
4. Preserve publication/read/restore round trips using the coordinated native
   path. No database migration is required because placements remain in existing
   definition JSON.
5. Treat changes to conditional visibility or query selection as existing major
   permission/data-meaning changes. Do not downgrade them to layout changes.
6. Keep public-page allowlist validation and page/placement permission projection
   coherent. This does not implement dynamic condition execution or grant data
   access merely because a page is visible.

## Decisive acceptance

- One nested/guided fixture retains both properties from authored source through
  compilation, exact provenance, publication/readback and restoration.
- Unknown query or condition-field reference fails; existing valid references
  retain exact owners and values.
- Changing either property gives major impact; omitting both preserves existing
  V2 outputs and all V1 preservation checks.
- Existing public-surface restrictions still apply to the query and condition
  references. Do not add a new public authority path.
- Independent Sol reviews the actual bounded changes and integration tests before
  delivery. Reuse existing suites rather than adding a parallel harness.

## Conversion handoff

Conversion copies these leaves rather than guessing a setting key. Normal pages
use the already-defined default main slot; guided forms retain separate content
for every step. An optional custom shell needs an explicit complete slot mapping,
but no custom shell is mandatory. V1 list pages have no explicit placements, so
their conversion requires an explicit primary-list block selection and a new
authored placement alias allocated through existing draft identity operations.
Legacy registration versions and platform catalogue versions are independent;
the explicit mapping selects the intended exact platform release, without an
arbitrary requirement that their version strings match.

This slice is not permission to build the designer before the complete
[file-defined application runtime proof](engine-first-application-delivery.md).
