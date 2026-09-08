# Module installation and record storage

[Engine-first plan](engine-first-application-delivery.md) ·
[Module lifecycle #43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43) ·
[Record storage #45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45)

## Outcome and ownership

An exact published module release becomes usable in the intended organisation
and application without copying its definition or creating per-organisation
tables. Module owns binding activation and detachment; Record owns the protected
storage catalogue, physical mappings and record adapters. The application-level
installation operation remains with
[#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64).

Reuse the existing Definition publication/readback, permission registry, request
context and Access operations. Do not rebuild their catalogues or grant the normal
request connection database-owner permissions.

## First integrated delivery

1. Consume an exact, integrity-checked published release and its resolved module
   dependencies. The coordinated [Module V2 field work](issue-44-record-field-values.md)
   must support that release before installation advertises it as usable.
2. Generate the storage mappings, typed columns, constraints and fixed protected
   record adapters from the published definitions. Apply structure changes through
   the existing owner/migration path, not browser-selected names or runtime DDL
   credentials. Follow the [record-table allocation rule](../specification/17-runtime-storage-and-caching.md#record-table-allocation).
3. Prepare actual permission and event registrations. The event-registration slice
   of [#50](https://github.com/Abzum-NZ/Abzum-Vortex/issues/50) can be co-delivered here;
   its system-field and protected-action completion still needs real record storage.
   This does not require a new event queue or a successful mock registration.
4. Activate the exact organisation/application binding only when its required
   mappings, registrations and protected operations are ready. A retry reuses the
   existing compatible storage and registration identities.
5. Exercise real protected create/read through
   [#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47), including the field
   preparation supplied by [#44](issue-44-record-field-values.md). Detachment keeps
   data and refuses removal that breaks another active binding's dependencies.

## Dependencies and failure behavior

The whole [Access phase #31](https://github.com/Abzum-NZ/Abzum-Vortex/issues/31)
is not an entry gate. Activation and data operations require the actual central
decision, row and field enforcement from
[#34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34),
[#35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35) and
[#37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37), plus the existing
[migration foundation #139](https://github.com/Abzum-NZ/Abzum-Vortex/issues/139).
Pure planning and generation may proceed before those integrated checks complete.

Treat #43, #45 and #50's registration slice as coordinated work, not a sequence
requiring a fake completed install before its storage exists. Likewise, #44's
value preparation precedes storage, while its full save/readback acceptance is
proved with the integrated path. No whole task is closed on a partial slice.

A failed table-creation transaction rolls back its own new objects and changes.
Never delete a pre-existing shared table or another installation's registrations
as cleanup. If provisioning has already completed but activation fails, retain
the valid inactive provisioned structure for retry; no active binding or usable
installation may be reported. This is ordinary transactional provisioning and
binding state, not a distributed rollback or additional recovery programme.

## Verification

### Save and event integration

Co-deliver the protected [save pipeline #47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47)
with the transactional enqueue slice of [event delivery #60](https://github.com/Abzum-NZ/Abzum-Vortex/issues/60)
on the real [record storage #45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45).
Neither task requires the other whole task to be marked Done first. Requiring
all of Phase 4 before #60 would prevent Phase 4 from proving its own atomic
record/event acceptance. #60 therefore depends on the concrete storage boundary,
not the whole phase epic. Its ordered dispatch, duplicate-safe consumers and
recovery acceptance remain required before closing #60.

The save owns one short transaction: current authority, inputs and revisions are
checked; record changes, success activity, declared event/start intent and logged
queue message commit together. A failure leaves none of those committed effects.
Dispatch happens afterward and cannot turn a committed record into a false save
failure. Input collection and external workflow execution hold no transaction.
Use the existing [save sequence](../specification/06-records-and-lifecycle.md#save-sequence),
[Activity foundation #252](https://github.com/Abzum-NZ/Abzum-Vortex/issues/252),
and [field preparation #44](issue-44-record-field-values.md); do not invent a
second queue platform or validator. Immediate rule/calculation integrations must
land with their owning engines before the full save acceptance is claimed.

Prove a real rollback leaves no record, success activity, outbox or queue message;
a commit leaves the intended matching effects; an exact retry does not duplicate
the record or event. Existing safe request-level refusal evidence is separate
from rolled-back success activity. Browser field feedback belongs to later
rendered forms and is not a prerequisite for the headless save engine.

### Storage and access proof

Prove two organisations reuse one compatible table without seeing each other's
rows; application-contained rows also retain their application boundary. Prove
the existing two-application fixtures read the same declared shared records,
while an independent same-named record type maps to different storage. Include
failed table creation, failed activation, retry and detach-with-retained-data.

Use the real restricted request role for allow/refuse checks. Generated storage
must set grants and row policies explicitly; do not rely on Supabase's changing
[default table exposure](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies).
Raw content access must not bypass the field projection/change bounds already
required by [#45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45). Run the existing
database tests and advisors for the actual generated objects and obtain independent
actual-work review. No new test framework or infrastructure service is required.
