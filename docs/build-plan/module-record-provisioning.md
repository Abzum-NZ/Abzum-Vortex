# Module installation and record storage

[Engine-first plan](engine-first-application-delivery.md) ·
[Module lifecycle #43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43) ·
[Record storage #45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45)

## Outcome and ownership

An exact published module release becomes usable in the intended organisation
and application without copying its definition or creating per-organisation
tables. Module owns binding activation and detachment; Record owns the protected
storage catalogue, physical mappings and record adapters. The fixed lower-level
Application-wide activation/detach operations are delivered by
[#43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43); the installation,
upgrade and runtime assembly orchestration remains with
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
3. Register the Application's exact permission snapshot through Access. Published
   event declarations remain in the immutable definitions and are consumed from
   there; installation does not copy them into another catalogue or create a mock
   readiness flag.
4. Activate all direct and transitively required Module bindings together only
   when every exact binding is provisioned and the exact permission snapshot is
   current. The command supplies the complete canonical pin set with each current
   binding revision. Omitted, inserted, mixed or substituted evidence refuses the
   whole operation. Activation also rechecks each binding through Record's narrow
   protected exact-release provision read, including its complete storage-contract
   set; Module receives that result without reading Record's private tables. An exact
   retry uses the existing binding revisions.
5. Exercise real protected create/read through
   [#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47), including the field
   preparation supplied by [#44](issue-44-record-field-values.md). Detachment changes
   only that Application's complete pin set and keeps its storage and records;
   another Application using the same Module keeps its own active bindings.

## Dependencies and failure behavior

### Selected implementation

The database is the sole storage generator; Module/Record TypeScript code only
calls the fixed operation using exact release IDs and expected binding revisions.

The [Module 3 compatibility slice](issue-45-module3-storage-compatibility.md) extends
that existing operation to exact source/validation pairs 2.0.0/2.0.0 and
3.0.0/3.0.0. Both use the same field storage meaning; rules do not affect the
physical shape. This is separate from Application version support, transitive
dependency provisioning, activation and the complete protected save operation.

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
after exact permission registration and protected adapters exist. Published event
declarations are read from the pinned definitions rather than copied during
activation. Later populated changes
may use Kestra over the same bounded operations; no new worker/queue is needed
for initial creation. Test the generic operation with fixture definitions as
inputs, not hardcoded business-schema migrations. The implementation remains
subject to independent patch review.

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
Both #43 and #45 retain native #37 blocked-by relationships for their integrated
acceptance. Inactive structural provisioning and catalogue development may proceed
independently before those checks complete; no active installation or protected
data path is claimed early.

The delivered reader supplies [exact active installation evidence](issue-43-active-installation-read.md),
including locally owned Applications with exact shared external Modules. It does
not require installation-management permission for ordinary runtime discovery
and refuses a detached target. Protected operations still check their own current
authority.

Transitive Module dependencies are delivered. One resolver,
`vortex_definition.reachable_module_dependency_edges`, owns the rule that an
Application's dependency closure pins each Module root at exactly one revision,
the publication writer refuses a closure that breaks it, and the coordinator,
both readers and the permission registry all read their Module set from it. An
exact Module reachable only through another Module is provisioned and registered;
an unrelated or substituted Module release is refused. The provisioner also
accepts the compiled ownership value `team`, which is what the compiler actually
emits for a Group-owned record type; the superseded runtime term `group` is
refused rather than carried as a second spelling.

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
   [#45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45). Read and change are
   delivered as one fixed parameterised pair over provisioned storage, with the
   complete record decision inside the adapter and the changeable-field bound
   enforced beside the write. The next private storage slice is
   [#402](https://github.com/Abzum-NZ/Abzum-Vortex/issues/402): trusted-human
   create and initial ownership, per-scope locked reference allocation,
   single-target relationship edge changes, and revision-checked recoverable
   delete/restore. It remains ungranted to request/runtime roles and supplies
   primitives to the complete save orchestration rather than a second endpoint.
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

For #402 specifically, test real published and provisioned definitions. Account
ownership is derived; Group ownership accepts only a selected current membership.
An omitted reference start is one and an explicit non-one start is exact. Digit
width is a minimum and never truncates a wider allocated integer. The
counter scope uses a null-safe database key, and concurrent creates serialize on
that counter. Link values and canonical edges remain atomic. A concurrent link
change and parent deletion serialize on the affected source row; after the lock,
deletion rechecks that the current link still names that parent before applying
the declared action. Optional clearing requires child update authority and exact
inherited-dependent deletion requires child delete authority. Create, delete and
restore load the fact closure for their actual action. Restore uses the retained
row but rechecks current access and definition, current required non-link
presence/canonical storage shape, and exact fixed-target required relationship
value/edge/target consistency after locking the target. Full final-value
settings and live-reference validation remains in
[#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47). Link-add versus target
delete and restore versus required-target delete must have two-session proofs.
Do not add System/specified-account execution, public save commands, Activity,
Events, receipts, lifecycle scheduling, transfer, polymorphic links or an
implicit many-to-many edge engine to this slice.

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
atomically. The following final-value handoff is the selected implementation for
#45/#47; it is not delivered by the pure value/calculation engines.

#### Final values and the trusted server boundary

Independent Sol architecture review approved this handoff after inspecting the
actual transaction runner and owning package boundaries.

The browser, import, flow and MCP adapters submit the same closed save command:
operation, target, expected record revision, command identifier and proposed
writable values/relationships. They cannot submit generated values or a claim
that validation succeeded. The server constructs a fresh final mutation from
authoritative locked state and its owning field, rule, calculation and totals
engines; it does not forward or spread caller JSON into the final write plan.
Keep submitted and generated changes structurally separate. Apply the existing
changeable-field bounds to submitted values; generated changes must match the
exact installed rule write sets or derived-field declarations and pass final
validation. Do not reject a legitimate declared rule output simply because the
initiator could not edit that field directly.

Use the existing request transaction for preparation, current Access checks,
dependency locking and calculation. The terminal Record repository call restores
the existing `vortex_runtime` session role and invokes one fixed private save
operation. Only that runtime role can invoke this terminal writer; the request
and Data API roles cannot. Runtime receives no raw content-table or private
Event-helper grants and never inherits the non-login Record owner. No new
credential, second transaction or general privileged-callback API is needed.

The fixed writer independently enforces current context, Access, exact installed
definition, revisions, storage mappings, field/reference constraints and the
existing retry receipt. It accepts only final fields supported by that definition
and the permitted owning operation, including legitimate immediate-rule and
derived changes, then writes matching Record, Activity and Event effects together.
It does not repeat the TypeScript business-rule/calculation engine in SQL or
accept a caller's validation booleans. The final dependency set must still match
the locked/re-read set used to calculate; a changed set requires whole-transaction
retry, not saving stale computed values.

This is a trusted-backend boundary, not a sandbox for hostile backend code.
The [existing transaction runner](../../db/src/request-transaction.ts) connects as
`vortex_runtime` and temporarily selects `vortex_request`.
[PostgreSQL permits resetting that role](https://www.postgresql.org/docs/current/sql-set-role.html),
so arbitrary SQL executing with the runtime connection could regain its runtime
capabilities. Since #386 that path cannot replace the established request context:
it lives in an owner-only row the runtime login cannot write, and the initializer
refuses a second establishment in the same transaction. Regaining the runtime role
yields only the pre-request surface (scope resolvers, launcher, identity projection
read/ensure, invitation acceptance). No user-facing adapter may accept SQL,
caller-selected helper names or a final mutation plan. Parameterized fixed
operations, server-only connection ownership and closed commands are part of the
boundary; role switching alone is not evidence of protection from a compromised
backend or stolen credential.

Verify both cases honestly: a genuinely restricted database session cannot call
the terminal writer/private helpers/raw tables; the real runtime connection can
complete the fixed save and its atomic effects but has no raw table or direct
Event-helper access. Also prove an untrusted save command cannot inject generated
values or bypass validation. A restricted `current_user` test must not be described
as proof that the underlying runtime `session_user` cannot reset its role.

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
required by [#45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45). The fixed
read and change adapters enforce those bounds on real provisioned tables, and
the request role holds no privilege on any `record_data` table, so the adapters
are its only route to a record. Run the existing
database tests and advisors for the actual generated objects and obtain independent
actual-work review. No new test framework or infrastructure service is required.
