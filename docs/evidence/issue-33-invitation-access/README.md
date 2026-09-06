# Issue 33 E invitation access evidence

## Delivered boundary

[Roles, Groups and assignments #33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33)
now includes private invitation creation with immutable intended memberships and
direct role assignments, followed by atomic acceptance. Creation grants nothing.
Acceptance derives its beneficiary from verified Identity evidence and either
activates the account and creates every intended fact with one Access change, or
rolls everything back. Existing accounts preserve their original invitation
provenance; the result separately identifies the invitation being accepted.

The account-only acceptance route refuses pending intent without disclosing or
omitting its grants. Genuine account-only invitations and exact completed replays
remain compatible. Replay never recreates removed access. Intent changes require
revoking and reissuing, not a binding API, approval store or historical authority.

All paths lock organisation governance before invitation facts. First acceptance
rechecks fixed deadlines after the required role/Group locks. Revisions and Access
remain authoritative ordering; timestamps do not become another authorization layer.

These are private foundations, not a user-invocable granting endpoint.
[The central decision #34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34) and
[protected invocation #40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40) must
verify current inviter/approver authority and bind trusted operation evidence to the
exact intent. [IAM #267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267) owns the
human journey. The test-only handoff returns an owner-only in-transaction secret;
external delivery must wait for the outer commit.

## Local verification — 6 September 2026

- 38 applied migrations through `20260906040352`; no reset or hosted E mutation.
- All 36 SQL files passed: 1,813 assertions. E has 67 assertions covering private
  access, new/existing/reactivated accounts, membership-only and assignment-only
  intent, replay, stale roles, unavailable Groups, elapsed windows, conflicting
  facts, revoked invitations and atomic Access exhaustion.
- All 19 manifest-listed separate-session concurrency proofs passed. E proves
  simultaneous acceptance applies once, creation publishes invitation and intent
  together, and a real Group lock wait crossing expiry refuses without partial facts.
- Five-schema lint passed without errors. The same three existing warnings remain:
  two unused variables in the private application coordinator and text-to-UUID
  initialization in the platform-catalogue helper. No new warning was introduced.
- Full repository verification passed: 1,187 tests, three existing skipped tests,
  80 passing test files, two skipped files, eight fixtures and all 23 package
  typechecks, builds and boundary checks, plus formatting and lint.

SQL and concurrency suites ran sequentially. SQL fixtures roll back; concurrency
cleanup checks uniquely owned fixtures. Independent Sol review approved the frozen E
source/tests and mapped the complete A–E implementation to the whole issue, finding
no missing functional acceptance criterion. Downstream caller authorization and IAM
interfaces remain explicitly outside this private foundation task.

This does not claim hosted E verification, Production delivery or a rendered IAM
interface. Earlier hosted coverage through D2 is recorded in the
[management-application evidence](../issue-33-management-application/README.md#hosted-testing-follow-up).

## Frozen database artifacts

- `20260906040221_add_invitation_access_accepted_reason.sql`:
  `09438cf2faf238a3bad649f8ca2f38fe2c9bb21dacd32c76133dba8d1ad3a0a0`
- `20260906040352_coordinate_organization_invitation_access.sql`:
  `6cd1e0b8ae7dfd12c0f2c08c89ae652568c7628e310446191cb649be8f88e822`
- `280_organization_invitation_access.test.sql`:
  `bfa7c368278126f6cc2831e8dfb1813641f64858d55c8540bf716884211f7ba8`
- `organization-invitation-access-concurrency.test.sh`:
  `6e6723ad6def9b9143e6f95e62f544aa303a00bddf42e4a12f34b58d484ef7c4`
- `workflows/kestra/database-verification.json`:
  `bbf8c2217f522be5b9b0da4070730c81d35aac764d3cf9195654ebb16aefb6ee`
