# 8. Forms, actions, rules and events

[Previous: Applications, navigation, pages and themes](07-applications-pages-and-themes.md) · [Specification index](README.md) · Next: [Workflows and process pipelines](09-workflows-and-pipelines.md)

## Behaviour levels

The platform separates work that must finish during a [record save](06-records-and-lifecycle.md) from work that can continue afterward.

```mermaid
flowchart LR
    START[Person, interface or workflow requests action] --> ACTION[Action prepares record changes]
    ACTION --> RULE[Rules validate and adjust save]
    RULE --> COMMIT{Save commits?}
    COMMIT -- No --> STOP[Return refusal; no event]
    COMMIT -- Yes --> EVENT[Write event to outbox]
    EVENT --> FLOW[Workflow performs background work]
```

An **action** is a named operation that participates in a save. A **rule** is immediate logic within the save. An **event** is a committed statement that something happened. A [workflow](09-workflows-and-pipelines.md) performs work after the save.

## Actions

An action belongs to a module when it expresses reusable business meaning, or to an application when it exists only for that application. It records:

- Permanent identifier, label, subject record type, and required permission.
- Inputs with names, labels, types, required flags, and validation that is valid for that type. Plain text accepts length and pattern constraints; formatted text accepts a closed block allowlist and maximum length; numbers accept numeric bounds; dates and date-times accept their own bounds; a record reference names one or more allowed record types; an organisation-account reference selects an account in the current organisation; a Boolean accepts none of those unrelated settings.
- A precondition.
- One to ten ordered effects.
- The events it may announce.
- A sharing setting of `refused` by default or `allowed`. Only an action explicitly published as shareable may be named by a cross-organisation grant.

Allowed immediate action effects are:

1. Set a field from a literal, action input, subject field, subject record, current actor, or current time.
2. Create a record using an explicit field-to-value map.
3. Copy an explicit non-empty list of the subject's published relationships to a record supplied through a declared link input.
4. Soft-delete the subject record.
5. Announce a declared business event when the save commits.

Every field, record type, relationship, input and event named by an effect must resolve during publication. A copy effect never means “all relationships”; the authored definition lists the relationship keys and publication resolves them to permanent relationship identifiers.

An action cannot wait, call an external system, send email, send notifications, invoke a model, or read arbitrary records. Those operations belong to a [workflow](09-workflows-and-pipelines.md). A shared action runs wholly in the source organisation and cannot create or link recipient-owned records.

## Rules

A rule has a trigger, condition, priority, and one effect. Rules for the same trigger run in a stable published order.

Allowed effects are:

- Refuse the save with a field-level message.
- Set a field value.
- Require a field.
- Show or hide a field in the current form.
- Warn without refusing.
- Request background work after a successful commit.

Server validation is authoritative. Client-side rule evaluation may provide immediate feedback, but the server re-evaluates the rule against current data before saving.

Rules must declare their read fields and write fields. Publication refuses cycles, conflicting writes without a declared order, and a rule that reads information unavailable to its execution context.

## Conditions

Conditions use a closed, typed vocabulary such as equals, not equals, comparison, between, empty, not empty, contains, changed, and is one of. Operators are allowed only for compatible field types.

Conditions may refer to:

- A field on the subject record.
- Its previous value during a change.
- A declared action input.
- A value carried by an event.
- A setting on the same page block when controlling builder presentation.

Relationship traversal is limited and validated. Conditions cannot execute code or network calls.

## Events

Every record type provides seven standard events:

- Created.
- Changed, with changed field names.
- Deleted, with record identifier and record type.
- Linked.
- Unlinked.
- Reassigned.
- State changed, with field and previous/new values.

A module may declare additional business events. An event carries identifiers and the minimum non-personal values required to choose later work. It never carries a complete record or a field classified as personal or sensitive. A workflow re-reads permitted current data when needed.

## Event envelope

Every event envelope includes:

- Unique event identifier.
- Organisation, application, module, record type, and record identifiers where applicable.
- Event name and published definition versions.
- Occurrence time, initiating person or system actor, correlation identifier, and causation identifier.
- Per-record sequence number.
- Declared carried values.

## Delivery guarantees

- An event is written in the same database transaction as the record change.
- Delivery is at least once; consumers use the event identifier as their duplicate-protection key.
- Events for the same record are handed to consumers in sequence order.
- A later event cannot cause an earlier undelivered event to be discarded. The dispatcher waits, retries, or moves the blocked sequence to an operator-visible failure state.
- A permanently failed event remains available for authorised retry and investigation.
- The committed outbox writes to a durable [Supabase Queue](https://supabase.com/docs/guides/queues). A database webhook wakes the platform dispatcher for normal low-latency delivery, and a scheduled [Kestra](https://kestra.io/docs/workflow-components/triggers) recovery flow calls the protected dispatcher endpoint to reclaim missed or stalled work. Kestra never reads the database directly.

```mermaid
sequenceDiagram
    participant DB as Record transaction
    participant Outbox as Event outbox
    participant Dispatch as Dispatcher
    participant Consumer as Workflow trigger
    DB->>Outbox: Commit event with record sequence
    Dispatch->>Outbox: Claim next unblocked sequence
    Dispatch->>Consumer: Deliver event identifier and envelope
    Consumer-->>Dispatch: Accepted or already accepted
    Dispatch->>Outbox: Mark delivered
    Note over Dispatch,Outbox: On failure, retry without skipping earlier sequence
```

## Acceptance examples

- A refused save does not emit an event or start background work.
- Re-delivering an event does not create a second workflow run for the same trigger.
- A later change cannot overtake an earlier failed event for the same record.
- A rule that drops an unsafe condition cannot publish; it must express a safe condition or refuse the operation.
- Actions called from pages, interfaces, and workflows follow the same validation and permission path.
