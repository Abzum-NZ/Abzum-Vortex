# Application installation authority catalogue

[Application runtime #64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64) ·
[Installation permission plan](../build-plan/issue-64-application-runtime.md#installation-permission-delivered-with-the-storage-engine)

## Implemented scope

The additive shipped platform catalogue `1.1.0` introduces
`platform.organization.applications.manage`. It does not grant that permission
to any account or Group. Historical catalogues `1.0.0` and `1.0.1` retain their
existing identities and meanings.

The fixed owner-only adoption operation selects an exact shipped catalogue using
its version and fingerprint, checks the expected registration revision, and
updates the existing registration and permission continuity evidence atomically.
The original thirteen permissions retain their meaning and continuity revisions.
The new permission gets its own continuity evidence, not an automatic role grant.
The permanent-steward minimum remains the original thirteen permissions plus the
existing management-application requirement.

This is a catalogue prerequisite, not a completed install/upgrade/detach command.
The real application lifecycle caller must still check installation permission
and delegated management over the complete affected scope. Storage provisioning,
activation and the rendered application remain separate unfinished integrations.

## Actual-work review and verification

The first independent GPT-5.6 Sol review found that the initial adoption operation
advanced the registration without advancing its continuity evidence. Current
Access evaluation would consequently reject existing permissions. It also found
that function-text assertions did not prove continued stewardship.

The author corrected both findings using the existing transaction and continuity
model. The final author checks passed:

- Nineteen rollback-only database assertions, including a real permanent steward
  and direct permission eligibility before and after adoption, unchanged role
  assignment and organisation-catalogue delegation, no grant of the new
  permission, exact replay and invalid-fingerprint refusal.
- Twenty-three focused Contracts/Access tests, both package typechecks, scoped
  lint/format checks and all twenty-three package boundaries.

The same independent reviewer rechecked the correction and approved it with both
findings resolved. Root matched all nine frozen implementation/test file hashes
and verified formatting of this evidence. A broader root Access run passed 356
tests in twenty-two files; two additional suites could not load because the
separate, uncommitted current-fixture conversion still used V1-only test loaders.
Those failures were returned to the fixture owner and are not reported as passes.

No Testing merge or hosted database completion is claimed by this record yet.
The isolated database verification rolled back; unfinished storage provisioning
was excluded and no full ordered migration-set success is claimed.
