# System fields, protected actions and event declarations

[Task #50](https://github.com/Abzum-NZ/Abzum-Vortex/issues/50) ·
[Record lifecycle](../specification/06-records-and-lifecycle.md) ·
[Actions and events](../specification/08-forms-actions-rules-and-events.md) ·
[Installation plan](module-record-provisioning.md)

## Outcome

An installed application can expose its records' system information, invoke its
published named actions through the same protected operation for every caller,
and discover the exact events that its installed release supports. Declaring or
registering an event does not announce that it happened or start a workflow.

## Existing foundation and remaining work

Published Module and Application contracts already contain actions and custom
event declarations. Definition resolves their identifiers and rejects carried
fields that are missing, personal or sensitive. Reuse this implementation and
improve its event/field diagnostics; do not add another definition format or
publication validator. The delivered Event slice validates installed event
catalogues and occurrences against exact definitions; see the
[reviewed delivery evidence](../evidence/issue-50-installed-events.md). Real active
binding resolution, transactional occurrence creation and dispatch remain to be
integrated. A pure catalogue or validation result is not proof of delivery.

Record already defines creation/change metadata and optional account/Group
ownership. Expose those real values rather than duplicate them as editable
business fields. Preserve record types with ownership disabled. The standard
record operations and declared custom actions must use the current Record,
Access, Rule and Activity boundaries, not a new executor in page components.

## Delivery slices

1. **System information:** integrate creator/time, last changer/time and enabled
   ownership with the real storage/read path. Query can filter and sort supported
   system values through the same declared query vocabulary. The protected
   operation supplies audit metadata; an ordinary field patch cannot forge it.
   Ownership changes use their current permission-checked operation.
2. **Action execution:** resolve the exact published action, subject, inputs,
   precondition, required permission alternatives and ordered effects. Execute
   its supported effects in one short transaction using the
   [save path #47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47). An invalid
   input, denied operation or stale subject leaves no partial action effects.
   Pages, MCP, interfaces and workflows use this same boundary. The later
   Frontend Flow engine may invoke multiple such operations; it is not a
   prerequisite for the protected action implementation.
3. **Event availability:** resolve the seven standard record events and exact
   custom declarations belonging to the installed Application and bound Modules.
   Use the immutable releases and actual installation state as authority, not a
   caller-supplied declaration or a successful registration flag. Co-deliver this
   slice with [Module #43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43) and
   [storage #45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45). Runtime
   availability follows activation/detachment; publication alone exposes no
   installed event. A retry must not create duplicate identities or retarget
   another installation's definitions.
4. **Actual occurrences:** integrate the declaration checks with #47 and the
   transactional enqueue slice of
   [event delivery #60](https://github.com/Abzum-NZ/Abzum-Vortex/issues/60).
   Only a committed protected operation produces an occurrence. Ordered
   dispatch, retry and durable workflow execution remain their owning tasks;
   a declaration test is not evidence that they work.

### Delivered protected named-action slice (2026-09-15)

The first Action execution slice now provides one public human-request service
for exact installed Application/Module action identities. It accepts the
published typed inputs and value sources and deliberately supports only ordered
`set_field` and `announce_event` effects. It reuses the existing named
permission, record scope, field bounds, precondition, calculation, relationship
total, Activity and transactional Event/queue boundaries; it does not introduce
a generic executor or another permission engine.

The terminal transaction rechecks current authority and subject revision under
lock, then commits the Record change, calculated values and parent totals,
content-free Activity, declared occurrence/outbox row, queue message and command
receipt atomically. Event-only actions are valid. Unsupported effects or Rule
participation, invalid fields or inputs, foreign/nonexistent account and Record
references, failed preconditions and stale revisions refuse without partial
effects. A denied exact named permission is recorded once through the existing
locked owning refusal append; replay never bypasses withdrawn authority.

Focused evidence covers the public preview → typed composition → reference
validation → locked preparation → total calculation → writer path against real
PostgreSQL. It includes named-only authority without ordinary Record read,
event-only/set-only/mixed actions, exact-owner refusal under an Application V1 +
Module V2 installation, parent-total propagation, replay, authority withdrawal,
late rollback and a competing-revision race with one complete success and one
safe refusal.

Later Action slices still own every effect kind other than `set_field` and
`announce_event`, supported Rule execution for named actions, non-human caller
surfaces, and any page/MCP/workflow adapters. The System information and broader
Event availability/occurrence work described elsewhere in this plan also remains;
this bounded delivery does not close task #50.

### Delivered `create_record` effect slice (2026-09-21)

A named action may now mix ordered `create_record` effects with the delivered
`set_field` and `announce_event` effects in the same protected transaction. Each
authored field map is composed from the same six declared value sources against
the target record type the published resolved reference names, and the command
commits the subject change (when it has one), every created record with its
derived ownership, allocated reference numbers and relationship edges, all
affected parent totals, the content-free Activity for the subject and one
completed Activity per created record, the standard `created` occurrence per
created record, the declared occurrences, the queue message and the command
receipt together. The public result contract is unchanged: it still reports the
subject's identity, revision and readable values, and does not return created
record identities. That omission is stated, not silent, and is the first
question for the next slice.

Three behaviours are worth stating exactly. Executing a permitted action still
requires no ordinary read authority on its own subject, including when a created
record links back to that subject: a named-action-specific edge writer decides
that one target by re-evaluating the exact installed action, taking no
caller-supplied trust, while every other link target keeps the ordinary read
check unchanged. A create-only action writes the subject only when one of its
own derived values actually changes, so a created record that moves the
subject's total bumps the revision once and emits one `changed` occurrence,
while one that does not leaves the subject untouched. An exact create decision
only exists after the insert and the edges, so a target the actor may not create,
or a target field outside the create field bounds, rolls the whole command back
with no created record, no reference number, no edge, no Activity and no
receipt, rather than returning a refusal that would be committed.

The relationship total closure is now computed once for the whole command, with
the subject and every creation as roots of one merged graph locked in a single
canonical pass. Two preparations were rejected: they are numerically wrong
whenever the subject and a created record share a total parent, because the
second pass would be evaluated from a pre-mutation snapshot.

Evidence is the existing real-PostgreSQL proof, extended with a neutral
`created_note` target record type. It covers every value source into a target
field map, the subject-link authority case beside an unrelated unreadable target
refused on the same action and field, mixed set/create/announce in one commit,
create-only with and without a subject total, a merged closure where the subject
and its created sibling both reach one parent that advances by exactly one
revision, exact replay creating nothing and burning no reference number,
conflicting command reuse, stale revisions, forged action owners, and both late
rollback classes. Twenty real concurrent iterations race the new create-bearing
path against an ordinary create of the same target type linked to the same
record, contending on the same reference-number counter, link-target row and
relationship advisory key; both complete every time. The same real writer now
refuses created-field person, file and permissioned-choice pending checks before
its terminal call, with equality proofs over records, counters, edges, Activity,
Event/outbox/queue rows and receipts.

Because the unsynchronised full-service race cannot guarantee that two sessions
hold the opposite resources at the same moment,
`supabase/tests/named-action-create-concurrency.test.sh` separately isolates the
named path's share-then-counter lock protocol with deterministic barriers. It
does not claim to execute the full named-action preflight or terminal writer.
One scenario holds the same link share while the ordinary create holds the
reference counter and releases each into the other's resource; a second repeats
it with an exclusive waiter queued on the link target so the only soft edge in
the wait-for cycle is the ordinary create's queue position. Neither deadlocks.
The shell proof records the exact shell/backend identities, barrier releases,
exit statuses and live blocker state when a run fails.

One earlier full-service run exceeded its unchanged 45-second Vitest budget,
but its raw failure log and backend identity were not retained. Later sampled
runs do not identify that missing process and therefore do not explain the
failure. Reproduction with the new process evidence, or recovery of the
original raw receipt, remains the exact prerequisite for diagnosing it.

### Known limitation of this slice

An action that combines a `set_field` on a **link** field with a `create_record`
effect refuses as `unsupported`. This is a reported gap, not accepted final
behaviour: whole #50 cannot close while it stands.

The cause is exact. `save_named_action_set_fields_internal:591` writes the
subject's relationship edge inside the same call that claims the command
receipt, so the link target's `for share` and the relationship advisory key are
necessarily taken before any creation can allocate a reference-number counter.
Ordinary create takes those in the opposite order — `create_record_internal`
allocates every counter in its field loop (`:787-806`) before its relationship
loop (`:868-877`) reaches the edge writer. The resulting cycle is two hard
waits, which no wait-queue rearrangement can break: this command would hold
`A(relS, X)` and wait for `C(storage(S), refField)` while a concurrent ordinary
create of `S` linked to `X` holds that counter and waits for `A(relS, X)`.

The stated prerequisite to lift it is an explicit named-action subject writer
that allocates the creations' reference numbers between claiming the receipt and
writing the subject's edges. That is deliberately not built here: restating a
~700-line reviewed writer is the drift risk the #511 post-mortem records.

A second, pre-existing prerequisite is recorded rather than corrected. The two
ordinary writers already order one record's edge locks differently from each
other — the create primitive iterates the compiled relationships array with no
`order by` (`20260913030000:868-870`), while the update path orders by field id
(`20260920140000:586-589`) — so two ordinary commands on one record type with
two link fields can already invert. Making that ordering total needs a canonical
edge order inside the ordinary create primitive, which is outside this slice.

`copy_relationships` and `soft_delete_subject` remain unimplemented and keep
their stated dependencies. This slice closes none of #50.

### Event availability implementation

Use a closed descriptor: either a standard event kind and record type, or a
custom event's owning Application/Module root, permanent definition identifier,
namespaced key, record type and allowed carried fields. Its installation scope
comes from the exact binding revision and release evidence; allocate no synthetic
registration identifier, counter or fingerprint.

A small pure Definition projector verifies the exact Application consumer result
and every bound Module consumer result against their existing dependency manifest,
then returns a canonical catalogue. Include Application-owned declarations,
bound-Module declarations and the seven standard kinds for each bound record
type. Follow the supported owning contract versions explicitly: Application V1
with Module V2 must not be rejected merely because those versions differ.

The Event service resolves this catalogue through the real binding reader and
exact Definition reads. Runtime discovery requires an active binding. The
Application installation coordinator may resolve the exact inactive candidate
for readiness, then activate it through Module with current authority and
revision checks. Candidate readiness is not runtime availability and cannot be
submitted as a caller-authored success receipt. Compose these operations in the
existing Application boundary; Module must not call Event back up the tier graph.

The existing workflow trigger resolves a namespaced custom event and record
type. Standard-event workflow subscriptions need an explicit versioned trigger
extension in [workflow registration #76](https://github.com/Abzum-NZ/Abzum-Vortex/issues/76);
standard catalogue discovery alone does not make them executable or justify
rewriting historical trigger definitions.

## Contract corrections required before occurrence delivery

The existing envelope uses a simple builder key for `eventName`, but custom
declarations use namespaced keys. Its `eventId` also names an occurrence while
the declaration uses that property for a reusable definition identifier.
Use an explicit, versioned occurrence contract that distinguishes the exact
declaration reference from the new occurrence identifier and supports the
published namespaced key without rewriting historical contracts or guessing
identity from labels. Standard events need an explicit fixed kind plus their
owning record type/release; they do not need fabricated custom declarations.

Carry only declared, correctly typed, non-personal values. This restriction
also applies to previous/new values of a standard state-change event. A
classified field may still change and produce a lifecycle fact containing the
safe identifiers; its classified values are omitted, not copied into an event.
Consumers re-read current permitted information when needed.

Keep value validation with Record's existing field semantics; the Event consumer
reuses them rather than maintaining another field-type/settings switch inside
Definition. Definition owns the pure exact-release catalogue projection. A
state-change payload must represent both setting an absent value and clearing a
present value, using the existing absence representation, without inventing a
persisted null value. Classified values remain omitted in either case.

Custom declaration identity includes its owning Application or Module root.
Do not reject identical event keys in different owners unless the owning
publication contract explicitly requires that wider uniqueness. Occurrence and
declaration identifiers have separate meanings and slots; allocation and retry
handling in the committed save path provide occurrence identity, not an arbitrary
cross-namespace UUID inequality check.

## Boundaries and verification

- No second event catalogue, queue or registration ledger merely to copy
  immutable definitions. If implementation demonstrates a necessary persisted
  index, document that concrete need and keep the published release authoritative.
- Preserve the runtime dependency graph: Module must not import the higher-level
  Event service, which already depends on Record. Share pure contract/definition
  resolution below these consumers or compose the real operations at the
  existing application boundary; do not introduce an import cycle.
- Prove exact-release event discovery for installed applications, inactive and
  detached refusal, isolated same-named applications, retry and an explicit
  upgrade without silently changing an older installation's event meaning.
- Prove safe standard/custom event payloads and useful publication diagnostics
  identifying the event and offending field without echoing their values.
- Prove actual metadata readback/filtering, protected action allow/refuse/stale
  paths and rollback with real storage before closing this whole task.
- Preserve shareable-action restrictions from the
  [source-organisation sharing contract](../specification/06-records-and-lifecycle.md#collaborative-access).
  A grant does not imply ownership changes, deletion, restoration or access to
  recipient-owned relationships.
- Integrate the existing [request-level Activity boundary](issue-41-access-activity.md):
  one content-free clean permission refusal before the first write using established local scope;
  no duplicate success activity or fabricated evidence for unexpected/pre-scope
  failures.

Obtain independent review of the actual implementation and record the delivered
revision and relevant Testing evidence. Keep #50 open until all its system-field,
action and event acceptance is satisfied, even when the installation slice is
delivered first.
