# Access operations and their consumers

[Current roadmap](README.md) · [Architecture review](architecture-review-2026-09-21.md) · [Access specification](../specification/04-access-and-permissions.md)

Current issue descriptions own delivery scope and ordering. Completion is implementation plus independent code review; this note requires no tests, database proof or hosted journey.

## Administration and IAM

#40 owns protected administration reads and changes under current management permissions. #267 supplies the IAM consumer journeys using the existing immutable invitation intent, approval response and atomic account/access writers.

Activation binds the beneficiary to the authenticated person and checks eligibility, role policy, finite duration, required reason and genuine recent authentication after each wait. Where policy requires independent approval, the response must cover the exact proposal. A submitted boolean or workflow identifier is not approval.

Invitation creation requires the invitation-management operation and delegated coverage of every intended Group/role. Acceptance begins with verified global identity before an organisation account exists, rechecks the intender's and required approver's current authority, and atomically creates the account and accepted access. Do not impersonate an approver from submitted identifiers or require an account the journey is meant to create.

Successful changes and content-free Activity commit with the single Access-version update. Expired authentication, replayed responses, changed proposals and revoked authority are refused by the protected operation.

## Application lifecycle

The installation foundation owns the fixed application lifecycle operation and organisation-scoped platform permission. It binds the exact target and does not require that target to be active. Registration grants nobody authority; role-administration rights cannot stand in for installation permission.

Compose verified caller context, current Access, locked complete before/after application scope, the existing application Access coordinator and Activity in one transaction. Preserve stewardship and source/supplier protections. Withdrawal derives the exact current application catalogue as its before scope and is immediate when authorised. Registration, update and reactivation do not silently accept or restore account/Group grants; required IAM acceptance remains with #267.

The lower-level installation foundation precedes full runtime rendering. Keep owner-only writers private; application adapters receive neither database-owner credentials nor a grant endpoint accepting unverifiable authority claims. Native dependencies in the current roadmap determine sequencing.
