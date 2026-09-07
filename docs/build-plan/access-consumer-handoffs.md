# Access engines and their later consumers

[Engine-first delivery](engine-first-application-delivery.md) · [Access administration #40](issue-40-protected-access-administration.md) · [Application runtime #64](issue-64-application-runtime.md) · [IAM #267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267)

## Architecture decision — 7 September 2026

Build protected operations where their real caller and required evidence exist. Do not add a private wrapper that accepts an unverifiable approval, person, permission or authority scope just to mark an earlier task complete. Existing typed, owner-only writers remain reusable internal building blocks, not exposed grant endpoints. Independent Sol review confirmed this ownership split against the actual contracts and writers.

| Owner | Required delivery |
| --- | --- |
| #40 | Protected administration reads, non-grant changes and feasible membership/assignment/role/delegation compositions using current defined management permissions, existing candidates and atomic Activity. |
| #267 | Verified activation and invitation-intent invocation, including the real workflow response, current authority checks and atomic Activity around existing writers. |
| #64 | Exact application-lifecycle permission and caller binding, affected-scope evaluation and atomic Activity around the existing application Access coordinator. |

This replaces the earlier proposal to finish all three consumer-dependent wrappers in #40. It removes no product requirement, does not reopen #33 and creates no reverse dependency from #40 to #64 or #267. Neither a private helper nor a source test counts as a usable IAM or installation journey. The complete pre-designer proof still includes the real journeys through [#327](definition-first-application-proof.md).

## IAM acceptance additions

1. Activation consumes the existing activation command/writer but adds the genuine published IAM action and protected response binding. Bind the beneficiary to the current authenticated person; recheck exact eligibility, role policy, finite duration, required reason and genuine recent authentication after every wait. Required independent review must cover the exact proposal. A policy without independent review still uses the published action, not an early direct-grant endpoint.
2. Invitation-intent creation requires the declared invitation-management operation plus complete delegated coverage of every intended Group/role. Reuse the existing immutable intent store and coordinator. Do not add a second invitation or approval store.
3. Acceptance uses the verified global identity before an organisation account exists. Recheck the original intender/required approver's current authority through verified execution context before the existing coordinator creates the account and intended access. Never impersonate that person from submitted identifiers or require the invitee to already have the target account.
4. Apply successful changes and content-free Activity atomically with the existing single Access-version change. Prove stale/replayed response, changed proposal, expired authentication, revoked approver authority and failure rollback through the actual protected journey. No invented boolean or workflow identifier is approval evidence.

## Application-runtime acceptance additions

1. Define and register the permanent exact lifecycle operation and permission for the target application; do not accept a caller-selected permission or substitute role/assignment administration rights. Registration grants nobody authority.
2. Compose verified caller context, current permission decision, locked complete before/after application scope, the existing `coordinate_application_access_change` writer and Activity in one transaction. Reuse existing prepared template/source evidence and stewardship/supplier protections.
3. Withdrawal derives the current exact application catalogue as its affected before scope. It is immediate when authorised, not held for grant approval. Register/update/reactivate cannot silently accept or restore account/Group authority; required IAM acceptance remains with #267.
4. Prove actual restricted-caller success/refusal, isolation, stale revision, no automatic assignments, source retention and atomic failure. Do not hand the application database-owner credentials or expose the raw coordinator.

## Concrete evidence for the split

The [activation command](../../contracts/src/organization-role-activation-changes.ts) contains identity, revision, duration and eligibility, not reason, authentication or a verified approval response. The [application command](../../contracts/src/application-access-coordination.ts) describes prepared source changes, not the lifecycle permission owned by #64. The existing invitation composition already supplies the private immutable intent and atomic account/access writer. Adding wrappers before their real consumers would require missing evidence to be guessed or accepted without verification; implementing the concrete composition with its consumer avoids that duplication.
