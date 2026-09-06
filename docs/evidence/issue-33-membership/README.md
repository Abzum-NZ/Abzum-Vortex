# Group membership changes and permission-registration correction

[Roles and Groups #33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33) · [Audit correction #295](https://github.com/Abzum-NZ/Abzum-Vortex/issues/295) · [Membership specification](../../specification/appendices/groups-and-privileged-access.md#current-state-checks-and-revocation)

## Delivered scope

The private membership composition adds, removes, restores and renews same-organisation
Group memberships. Original grant windows stay fixed. Restoration preserves the original
identity and window; renewal closes an expired predecessor and creates a distinct successor
in one transaction. Neither operation revives an old privileged activation. Each successful
operation advances Access once, including renewal's two rows.

The associated #295 correction changes only audit observation in the two existing permission
registration writers. It retains the latest delivered qualified JSON aliases, security,
signatures, revision checks and permission semantics. It does not change expiry clocks or
introduce an approval mechanism.

## Verification on 6 September 2026

- Complete Local database suite: 30 files, 1,508 assertions passed, including 61 membership
  assertions and the permission-registration regression.
- All 14 manifest-selected concurrency proofs passed. All five operated schemas passed lint.
- Complete repository gate: 1,004 tests passed, three existing tests skipped, all 23 package
  type checks/builds and boundaries, eight fixture scenarios, formatting and lint passed.
- Before the correction, the real registration update in SQL235 failed with `23514` after
  three passing assertions against the old functions. After correction, the complete suite
  passed. The separate incomplete direct-update assertion is not an isolated timestamp proof.
- Independent Sol review compared the whole membership change with its task and verified the
  correction against the latest prior function bodies. Its two requested membership cases
  (permanent restoration and duplicate identity with an otherwise-free pair) are included.

| Reviewed artifact | SHA-256 |
|---|---|
| Membership migration | `929ed587e7f16d94a4770ecadc4cc7c7fafa3098ff887f9eb82817980b2bf684` |
| Membership SQL proof | `bdd7438e2356a1d24f905dee5923337905048f2673d01c3b25a1965741a26b14` |
| Membership concurrency proof | `c826ce7b9e953b028498ea05c1a0791c72040ddf9d7e99ec85891610ebb80734` |
| Permission-registration correction | `44e43ca85b6f22fd2120e79a10054dde710ee73b004419ec5891b122fde9547c` |
| Permission-registration SQL proof, final assertion wording | `de30ea09a3565bc8abc6b33059e4f84a1042497fb90236da9da20426c3b51aef` |

## Boundaries and remaining work

These are headless private capabilities, not a rendered IAM administration experience; there
is no new screen to capture. No public writer, owner-credential runtime adapter, business-domain
logic or AI feature is added. The test-only handoff is not a shipping invocation boundary.

The specification, contracts, build plan and shared hosted verification manifest are updated.
The task and dependent boundaries were reviewed: individual activation, delegation, stewardship
and invitation composition remain in #33; [#34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34)
owns the access decision, [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40) protects
invocation and [#267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267) owns the IAM journey.
This does not complete #33 or unblock [#30](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30)
ahead of those dependencies. Hosted acceptance is separate from these Local results.
