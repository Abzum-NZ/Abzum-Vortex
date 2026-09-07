# Application drafts, publication, preview and restore services

Task: [#73](https://github.com/Abzum-NZ/Abzum-Vortex/issues/73). An editor-independent engine prerequisite under [engine-first delivery](engine-first-application-delivery.md).

**Blocked by:** [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249), [#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250), [#58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58), [#66](https://github.com/Abzum-NZ/Abzum-Vortex/issues/66).

## What will be built

1. Accept complete authored application files through the existing protected Definition draft operations. Reuse expected revisions, validation, publication, version comparison and history; no separate application store or editor-specific JSON.
2. Resolve every module/query/page/flow/operation/connection/workflow reference and preserve its exact source/canonical/provenance representation. Missing, incompatible and forbidden references fail with safe locations.
3. Provide an exact-draft preview artifact consumed by the shared registered renderer. Preview uses labelled sample or authorised data and performs no real writes or background starts. It does not require the installed application route or visual canvas.
4. Publish immutable application releases without installing them or retargeting live consumers. [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64) owns explicit runtime installation/activation and consumes this service, not the reverse.
5. Expose permitted history author/time/note/version. Restore copies an older release into a new revision-checked draft and never erases history or rolls back live consumers implicitly.
6. Preserve flow graphs, managed public/private projections, execution bindings and extension references across draft, compilation, release and restore. Definitions cannot create live execution grants. Keep private per-person form drafts separate from the application-definition draft.

## Acceptance criteria

- [ ] A complete application file can create/update a draft, validate, preview, publish and restore through a non-editor adapter.
- [ ] Preview resolves the selected draft, not an older installed release, and performs no effects.
- [ ] Stale edits, invalid or foreign references and unsafe values refuse without losing another author's work.
- [ ] Publishing/restoring never silently activates a release or copies an execution grant.
- [ ] Historical releases remain readable; restore produces reviewable source with complete reference mapping.
- [ ] A browser preview uses the same registered renderer and artifact as the later runtime integration; no Puck data is required.
- [ ] Independent actual-work review and relevant local/hosted evidence distinguish this service from the later [designer history/release UI #65](https://github.com/Abzum-NZ/Abzum-Vortex/issues/65).

## References

- [Composition and publication](../specification/03-composition-and-publication.md)
- [Applications and pages](../specification/07-applications-pages-and-themes.md)
- [Page contracts](../specification/appendices/page-builder-contracts.md)
