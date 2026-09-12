# Access Activity evidence

Task: [#41](https://github.com/Abzum-NZ/Abzum-Vortex/issues/41).

## Implemented boundary

Each standalone request writer below validates its input and local target, holds
the organisation Access lock, and makes its exact permission decision before its
first write. Only a bound clean permission refusal appends the fixed, content-free
organisation Activity and returns `refused`. Every other failure retains its
existing error and records nothing.

| Request entry point | Fixed refused action | SQL proof |
| --- | --- | --- |
| Group create | `create_group` | `350` |
| Group rename | `revise_group_label` | `350` |
| Group retire | `retire_group` | `410` |
| Group membership remove | `remove_group_membership` | `410` |
| Role metadata prepare | `revise_role_metadata` | `410` |
| Role metadata revise | `revise_role_metadata` | `410` |
| Role retire | `retire_role` | `410` |
| Role activation revoke | `revoke_role_activation` | `390` |
| Delegation revoke | `revoke_delegation` | `380` |
| Role assignment revoke | `revoke_role_assignment` | `350` and `395` |

Preparation and revision receive the same server-generated Activity identifier.
The adapter stops after a refused preparation. A well-formed refusal is returned
from the request callback so its transaction commits, then maps to the existing
`unavailable` result. Malformed evidence and commit failure remain
`temporarily_unavailable`; TypeScript does not classify a database refusal error.

The committed PostgreSQL integration proof calls the real service through the
existing request transaction runner, observes `unavailable`, then uses a separate
connection to confirm exactly one committed refusal, no Group write and no Access
version change. It is invoked by the existing local database verifier alongside
the existing PostgreSQL integration proof; no new runner or testing framework is
introduced.

## Preserved boundaries

- The existing owner-only Activity append is reused; no append wrapper, table
  privilege or new grantee is added.
- Browser, Data API, request and runtime roles still cannot read Activity or call
  its append helper directly.
- Missing/foreign/stale targets, stale Access, invalid input, binding mismatch,
  unavailable target policy, permanent-steward protection and append conflicts
  cannot create refusal Activity.
- Refusal subjects contain the established organisation only. Submitted target
  identifiers and field values are never recorded.
- Existing permitted changes still commit their one completed Activity with the
  business and Access change, and existing append conflicts roll everything back.

## Verification

Final local and hosted receipts are recorded after independent review and merge.
