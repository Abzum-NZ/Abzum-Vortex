# Individual role activation

[Roles and Groups #33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33) · [Activation specification](../../specification/appendices/groups-and-privileged-access.md#activation-and-immediate-loss-of-access)

## Implemented scope

The private composition creates an individual time-limited activation from an exact reviewed
direct or Group eligibility source, or terminally revokes an exact activation. The database derives
the historical role, policy and source evidence. Expiry is capped by the requested duration, policy
maximum and finite assignment/membership windows, using time observed after acquiring the locks.
An updated role may activate its retained accepted permissions, never its unaccepted additions.

Independent activation windows may coexist. Revoking one preserves the others; revocation remains
possible after its source becomes inactive or expires. Each successful operation advances Access
once with the existing mechanism and the new truthful `role_activation_changed` reason. There is
no new approval store, ordering counter, evaluator or per-activation permission copy.

## Local verification — 6 September 2026

- Full database suite: 32 files / 1,575 assertions passed, including 60 activation assertions and
  six retained-permission assertions. The latter uses matching current/immutable registration
  evidence and forces deferred constraints at each supplied-role transition.
- All 15 manifest-selected concurrency proofs passed. The new proof covers activation before/after
  a policy change, eligibility revocation, Group membership removal, and source expiry while the
  exact activation request waits on the governance lock. The expiry scenario observes the actual
  blocker before expiry, then crosses database expiry before releasing the holder.
- All five operated schemas passed lint without errors.
- Complete repository gate passed: 1,046 tests, three existing skips, all 23 package type checks
  and builds, package boundaries, eight fixture scenarios, formatting and lint. Subsequent changes
  were limited to reviewed SQL/shell fixture corrections and this evidence; the final SQL/race
  results above include those corrections.
- Independent Sol task-versus-work review covered the whole composition, contracts, test-only
  handoff, private denial, specification/build plan and manifest. Review corrections made the
  retained-authority fixture match real source evidence and made expiry-during-wait proof explicit;
  neither required changing a product rule or adding another mechanism.

| Artifact | SHA-256 |
|---|---|
| Command contract | `68dd2b7a689073d28de10a49c8f7c88d1d9035edad78e55e9074de51ccc3f103` |
| Access reason migration | `47fdfd9c0258d826d1b7da53f14aa681ec5881287f549947071e9aeb9b3b648f` |
| Activation coordinator and validator migration | `d97b3a098c2689e71c9e601407e97582106e78d361d72b2f57ab59d97939579a` |
| Activation SQL proof | `fbce62a630109145ebf1577e18aacba3a51fdd5460b777f7290df3370d1b28a8` |
| Retained-authority SQL proof | `afa824a9df575954df9ac48bf161f432a3362fd0257f00793a5dba5a82130336` |
| Activation concurrency proof | `d598d6663602e53102885e523de154443a2c47239de1e3d9e2004c7f5d87736b` |

## Boundaries and remaining work

These are headless private capabilities, not a rendered IAM/PIM journey; there is no new screen
to capture. The test-only handoff is not a shipping invocation boundary. No business-domain or AI
functionality, owner-credential runtime adapter or public grant endpoint is introduced.

[Access #34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34) owns the effective permission
decision. [Protected operations #40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40) must bind
the authenticated beneficiary and verify required reason, recent authentication and independent
approval in its atomic invocation. [IAM #267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267)
supplies the ordinary application request/approval experience. Delegation, stewardship and
invitation composition remain in #33; this slice does not close its parent or start dependency-blocked
[#30](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30).

The two migrations were applied to Local only for this verification. Hosted Testing must execute
the exact delivered revision's full manifest through [#266](https://github.com/Abzum-NZ/Abzum-Vortex/issues/266).
No hosted activation delivery or Production success is claimed by these Local results.
