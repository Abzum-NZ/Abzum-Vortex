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
   record adapters from the published definitions. Install the generic generator
   through reviewed platform migrations, then call its fixed private operation
   for arbitrary app installation. There is no per-customer migration, caller SQL
   or runtime DDL credential. Follow the [record-table allocation rule](../specification/17-runtime-storage-and-caching.md#record-table-allocation)
   and [provisioning boundary](../specification/17-runtime-storage-and-caching.md#record-storage-provisioning).
3. Prepare actual permission and event registrations. The event-registration slice
   of [#50](https://github.com/Abzum-NZ/Abzum-Vortex/issues/50) can be co-delivered here;
   its system-field and protected-action completion still needs real record storage.
   This does not require a new event queue or a successful mock registration.
   The [event availability plan](issue-50-system-fields-actions-events.md) uses
   exact immutable definitions and real binding state, not a copied catalogue
   or a boolean claiming registration succeeded.
4. Activate the exact organisation/application binding only when its required
   mappings, registrations and protected operations are ready. A retry reuses the
   existing compatible storage and registration identities.
5. Exercise real protected create/read through
   [#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47), including the field
   preparation supplied by [#44](issue-44-record-field-values.md). Detachment keeps
   data and refuses removal that breaks another active binding's dependencies.

## Dependencies and failure behavior

### Selected implementation

The database is the sole storage generator; Module/Record TypeScript code only
calls the fixed operation using exact release IDs and expected binding revisions.
The private non-login Record owner owns generated objects but is never inherited
by request/runtime roles. The Module coordinator rechecks Access from the trusted
organisation context and verifies the exact Application-to-Module dependency;
it does not require the application to be active before installation.

Use `record_data`, `rt_<full storage-contract UUID hex>` and
`f_<full field UUID hex>` for new allocations. Reuse verified existing mappings.
The catalogue's existing fingerprint identifies storage meaning: an equal shape
can be reused, while a changed shape requires a real compatibility comparison and
upgrade. Do not introduce additional plan/receipt fingerprints. Ownership uses
Groups, including `owner_group_id` in the illustrative fixture and its validator.

First create/compatible provisioning locks the binding and storage identities and
commits objects plus mappings as inactive. Activation is a separate transaction
after real registrations and protected adapters exist. Later populated changes
may use Kestra over the same bounded operations; no new worker/queue is needed
for initial creation. Test the generic operation with fixture definitions as
inputs, not hardcoded business-schema migrations. This decision was independently
reviewed before implementation; the actual implementation still requires review.

The first provisioning proof must distinguish locally owned Application roots
from shared Module dependencies, support response-lost retries of the original
first command, and prove real simultaneous first-request convergence. It must
also prove that an older exact release can reuse newer compatible nullable
storage without rolling back the shared mappings. These use the existing
transaction, exact release and binding revision model.

### Integration prerequisites

Co-deliver the concrete [Application lifecycle permission/caller slice](issue-64-application-runtime.md#installation-permission-delivered-with-the-storage-engine)
owned by #64 with this first real provisioning path. An absent installation
permission is not solved by borrowing role-management rights, exposing an owner
helper or leaving a mock-authorised installation. Its catalogue addition preserves
existing permission meanings, assignments and the exact permanent-steward minimum.
The full #64 renderer is not a prerequisite for this lower-level operation.

The whole [Access phase #31](https://github.com/Abzum-NZ/Abzum-Vortex/issues/31)
is not an entry gate. Activation and data operations require the actual central
decision, row and field enforcement from
[#34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34),
[#35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35) and
[#37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37), plus the existing
[migration foundation #139](https://github.com/Abzum-NZ/Abzum-Vortex/issues/139).
Catalogue and generic provisioning development may proceed before those integrated
checks complete; no active installation or protected data path is claimed early.

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

#### Package wiring and bounded delivery

Record owns the protected save operation. Its required Event participant prepares
occurrences using the existing request transaction and exact installation/release
evidence; Event implements that participant and the higher-level application
composition wires it. The participant is a closed, named Record-owned interface,
not an arbitrary callback registry or caller-supplied function. It prepares a
closed plan and does not itself append events. Access opens the request
transaction; Record controls its save sequence. The fixed protected database save
unconditionally invokes the private Event append helper. Do not export a
lower-level writer that lets another caller omit Activity or event participation.
Record does not import Event, and neither participant starts or commits a second
transaction. There is no optional or successful no-op event hook. This preserves
the [core contract boundary](../specification/appendices/core-contract-boundary.md) while using the
existing request transaction rather than introducing another transaction framework.

Deliver the missing pieces in this order:

1. Complete the fixed protected storage adapters and their row/field checks in
   [#45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45).
2. Define the protected save command/result and its existing specified retry
   receipt, including refusal of a reused command identity with different inputs.
3. Add the private outbox and logged queue append required by
   [#60](https://github.com/Abzum-NZ/Abzum-Vortex/issues/60). Use the existing
   per-record event sequence contract: one save can announce several occurrences,
   so its record concurrency number alone cannot uniquely order those occurrences.
   Allocate their sequence in the locked record transaction; do not introduce a
   separate authorization counter or timestamp ordering rule.
4. Resolve the actual active installation and exact Definition release in that
   same transaction, reusing the delivered event catalogue and value validation.
   Align the queued occurrence contract with V2 `occurrenceId` and causal-chain
   depth rather than silently reinterpreting the older `eventId` contract.
5. Integrate field preparation, live reference/choice/person/file checks,
   uniqueness, reference allocation, immediate rules, calculations and totals;
   revalidate the final values before the fixed writer commits them with Activity
   and event/queue entries. Queue dispatch remains strictly after commit.

The pure typed calculation work in
[#48](https://github.com/Abzum-NZ/Abzum-Vortex/issues/48) can proceed before the
whole save task closes. Its transactional totals and concurrent-save proof are
co-delivered with [#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47), not
deferred until after a supposedly complete save engine. These are delivery
boundaries, not claims that the missing integrations already exist.

#### Event append authority

Independent review rejected a request-callable Event batch append: describing
TypeScript inputs as trusted would not stop that database role from fabricating
events outside a save. Only the non-login role owning the protected Record save
operation may call the private Event helper. Browser, request and runtime roles
receive no direct append, outbox or queue capability. This is the intentional
database composition boundary; it creates no reverse TypeScript package import.

The helper checks the actual binding/release and derives scope, actor, time and
sequence from database-controlled operation facts. It accepts no caller-selected
queue, sequence or `saveSucceeded` claim. The existing Record row lock serializes
sequence allocation from the prior outbox maximum; the uniqueness key follows
the actual record identity, without adding Application scope to an
organisation-shared record. Each real occurrence receives its own identifier.
An exact command-receipt retry returns the stored outcome without appending again.

Use one [Basic logged Supabase Queue](https://supabase.com/docs/guides/queues/quickstart#queue-types)
and a private immutable outbox. The minimal V2 queue message carries contract
version and `occurrenceId`; pgmq's message identifier is transport metadata.
Preserve legacy `eventId` contracts and declaration identifiers unchanged.
Fresh user saves have no causation identifier and internal causal depth zero.
Before caused workflow events are supported, #60 must define a trusted parent
handoff and explicitly extend/version the external depth contract; do not accept
a caller-authored parent or reinterpret the current V2 envelope silently.

The existing TypeScript Rule/Record engines still evaluate business rules and
calculations. This design does not duplicate them in PostgreSQL. The fixed writer
enforces database-authoritative context, access, binding, revision, field/reference
constraints and receipt handling, then persists Record, Activity and Event effects
atomically. Resolving the final-value handoff remains part of the real protected
writer in #45/#47, not a successful validation flag supplied by a caller.

Concrete missing integrations are the Module active-binding reader/activation,
protected Record writer and 30-day command receipt, the private Event queue/outbox
migration, and Application composition. Co-deliver these required parts; a new
reviewed migration is ordinary implementation work, not a user approval gate.
Dispatcher, webhook, consumer and Kestra work are outside this first append slice.

Prove direct request-role event fabrication fails, a committed save creates its
matching effects, a forced append failure rolls all of them back, exact retries
create no duplicates, and concurrent saves maintain per-record sequence. A mocked
participant is not evidence of database atomicity.

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
