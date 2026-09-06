# Invitation acceptance audit-time correction

Task: [#315](https://github.com/Abzum-NZ/Abzum-Vortex/issues/315). Requirement: [invitations and Groups](../specification/02-people-organisations-and-sign-in.md#invitations-and-groups). This is a bounded correction discovered during [Access administration](issue-40-access-administration.md), not a reopening of [approved Roles and Groups #33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33).

## Reviewed correction — 7 September 2026

The existing invitation writer sampled statement-start audit time before serialization waits. Locked invitation/account facts could already contain a later audit time, causing an otherwise valid next revision to be rejected. The correction retains the supported path's fresh post-lock expiry check, then clamps only the written audit time against the locked invitation and account audit values. It leaves the existing signature, privileges, protectors, revision rules, account eligibility and accepted replay unchanged. No clock configuration, service restart, additional authority counter or approval mechanism is involved.

Independent Sol review compared the actual replacement function mechanically against its latest predecessor and approved the final migration, SQL proof and extended existing concurrency proof.

| Reviewed file | SHA-256 |
|---|---|
| `20260906123805_preserve_invitation_acceptance_audit_time.sql` | `c6a9e1a866042fbed991e7c753814afc7b6d7197d96d66d2358f8e7bc7cf437b` |
| `355_invitation_acceptance_audit_time.test.sql` | `f2baf85942eb784976f46ea6de1fc2a9a599799d827255b03e88859a8bb4675f` |
| `organization-invitation-access-concurrency.test.sh` | `7cfacea675aa3e1e63e63969aead7a2a3fda534af4d7d1c25e0b953047c6f1d0` |

## Actual local execution

The unchanged old writer reproduced the diagnosed account-revision failure on the new fixture. The same fixture with the reviewed function loaded in a rolled-back transaction passed all 13 assertions. Its audit timestamp is later than the invitation expiry, while actual database time is still before expiry; successful acceptance therefore distinguishes real expiry time from clamped audit evidence. The proof also covers exact revision advancement, expired first-use refusal without a new Identity projection, unchanged accepted replay after expiry, and preserved private privileges.

The approved additive migration was then applied locally without resetting data. The full database suite passed all 45 files / 2,100 assertions. All 23 selected concurrency proofs passed in one uninterrupted run, including the extended invitation proof's observed account-lock wait across expiry and unchanged state after refusal. Six-schema database lint retained only the same three pre-existing Access warnings, and local security advisors reported no issues. Supported local history now records 48 applied migrations, ending with `20260906123805`.

Combined repository verification passed 1,265 tests with three existing skips, eight fixture checks, all 23 package typechecks/builds, formatting/lint and boundaries. It also included the separately reviewed [application-condition checkpoint](issue-36-record-visibility.md#application-owned-saved-conditions--7-september-2026). The local runner warned that it used globally installed Turbo 2.10.12 rather than a local installation; this matches the repository's declared version and did not prevent the gate passing. Source delivery and the exact hosted receipt remain separate; no Production delivery is claimed at this checkpoint.

## Testing source delivery

[PR #316](https://github.com/Abzum-NZ/Abzum-Vortex/pull/316) merged normally at `2026-09-06T13:05:16Z`, after both Vercel preview checks passed. Reviewed source `48718f0821b8f91e6571ef1f8995e9ab98e06306` and Testing merge `e501d0baff65f491803fb1c99c3fbaeb2ca1f024` have identical file trees. The exact hosted database/security/concurrency receipt remains unverified, so the task stays In review rather than Done. No required check was bypassed and no Production promotion is claimed.

A subsequent bounded read-only attempt could identify the existing Edge KV Store tab, but selecting it timed out in the browser controller. No receipt content was available, so no hosted success or failure can be inferred. No credential change, direct-API workaround or infrastructure repair was attempted; independent core implementation continues.
