# Installed event definitions and occurrence validation

[Task #50](https://github.com/Abzum-NZ/Abzum-Vortex/issues/50) ·
[Implementation plan](../build-plan/issue-50-system-fields-actions-events.md)

## Reviewed scope

Definition projects the event catalogue from exact published releases and active
binding evidence. Custom declaration identities and keys are scoped to their
owning Application or Module. Event validates occurrences against those exact
descriptors and releases, reusing one Record-owned persisted-field-value checker
for V1/V2 field meanings and settings. The existing Record preparation API remains
unchanged.

State changes support setting a previously absent value and clearing a present
value through omission. Persisted null is not introduced. Classified field values
remain omitted while safe record/field identities remain available. Occurrence
identity and reusable declaration identity have separate meanings; there is no
arbitrary cross-namespace UUID inequality requirement.

The first review identified duplicated field validation, rejection of legitimate
absence transitions and unnecessarily global declaration uniqueness. Its reviewer
became the correction author, so a different GPT-5.6 Sol agent independently
reviewed the final implementation and approved it with no findings.

## Verification and limits

The independent review at `6094868a88614c1c799e05dbc57557b9f6b4b5c4` matched the
frozen implementation, tests and specification. All 48 focused tests passed;
Contracts, Definition, Record and Event typechecks, scoped lint/format and all 23
package-boundary checks passed. Root independently reran the same four suites
successfully. Both reviewers separately approved their respective Event and
Testing importer changes in the shared lockfile.

This is pure catalogue projection and occurrence validation, not database event
emission or an activated installation proof. Static reference shapes and allowed
targets do not prove current record existence, permission or file eligibility.
The real binding reader and protected save must supply verified context;
[#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47) and
[#60](https://github.com/Abzum-NZ/Abzum-Vortex/issues/60) still own atomic persistence,
queueing and delivery. No second event registry, queue or readiness flag was added.
The whole #50 task remains open, and no Testing deployment or Production promotion
is claimed by this local review record.
