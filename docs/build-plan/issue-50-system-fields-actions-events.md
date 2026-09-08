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
publication validator. The Event package is currently a boundary stub, not a
working event registry or dispatcher.

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
  one content-free known refusal after rollback using verified local scope;
  no duplicate success activity or fabricated evidence for unexpected/pre-scope
  failures.

Obtain independent review of the actual implementation and record the delivered
revision and relevant Testing evidence. Keep #50 open until all its system-field,
action and event acceptance is satisfied, even when the installation slice is
delivered first.
