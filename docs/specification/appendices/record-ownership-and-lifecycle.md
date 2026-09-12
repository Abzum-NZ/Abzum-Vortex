# Record ownership, offboarding and lifecycle policies

[Records](../06-records-and-lifecycle.md) · [People](../02-people-organisations-and-sign-in.md) · [Retention](../14-activity-privacy-and-retention.md)

These requirements implement the owner's 12 September 2026 decisions. They are
delivery requirements, not claims that the engines or administration pages exist.

## Initial ownership

For an account-owned record, the Access-resolved effective organisation account
performing the create is the initial owner (the creator in an ordinary request); a create form cannot nominate another account. For a Group-owned
record, the form must select an active Group in that organisation of which the
same effective account is currently a member. Keep the original initiator in
attribution when a governed specified-account flow performs the create. Missing, foreign, retired or non-member selections
are refused. Both cases also require the normal create and field permissions.
Recheck membership and account state in the create transaction. Ownership-disabled
types remain ownerless. A system actor has no fabricated human membership: a
system create uses its existing private scoped execution binding and a compatible
explicit target owner checked by the protected ownership operation. It cannot
accept a caller-supplied actor or bypass assignment authority. Human creates keep
the creator/current-membership defaults above.

Later ownership changes use the protected named ownership action, not ordinary
field updates. The new owner must be an active organisation account or active
Group permitted by the record type's published ownership mode and the operator's
transfer authority. Transferring ownership does not grant roles or membership and
never changes creator/changer history, record identity or organisation.

## Archive a person and transfer ownership

Archiving a person means making their **organisation account inactive** through
the existing protected account operation; it is not deletion of their global
identity. Entry and account-derived authority stop under current Access rules.
Their other organisation accounts are unaffected. The account remains available
as historical attribution. Reactivation uses existing governed restoration and
does not silently revive revoked grants or privileged activations.

An authorised administrator can preview and transfer records from either an
active or archived account to another permitted account or Group, **by application**
or across all applications in the organisation. Transfer can be used independently
of offboarding. Account-only ownership types accept accounts; Group-only types
accept Groups. A requested target incompatible with any selected type is shown
as refused, not silently converted to a different ownership model.

The inventory includes active, soft-deleted and otherwise retained records owned
by the source, including disabled application installations. Organisation-shared
records appear once in a separate shared section, with every affected application
shown. Selecting one application does not copy or privately reassign its shared
records; the user explicitly includes them with their organisation-wide impact.
Group memberships and creator/audit references are not account-owned records and
are not reassigned. Inherited ownership follows its authoritative owner record;
do not create a conflicting child-owner copy.

Preview includes per-application/type counts, target compatibility, refused items
and shared impact. Execution uses bounded, retry-safe batches of the same protected
ownership action, current permissions and expected revisions. It reports completed,
conflicted and refused records and can resume; it never claims a large transfer is
one atomic transaction. Recheck scope and target state for each batch. The same protected ownership
operation has a narrowly scoped offboarding path for retained/soft-deleted rows
and disabled installations using the exact stored definition and current transfer
authority. It does not restore the row or reactivate the application. Account
deletion additionally fences new ownership assignments to the closing account,
then checks all retained scopes in the final protected operation. It refuses while
any owned record remains or inventory completeness cannot be proved, including
records hidden from the requesting administrator. Safe counts/refusals disclose no
otherwise unreadable records.

Account deletion retains the minimum non-content historical reference required by
audit/retention; it does not erase authored history or bypass privacy/legal holds.
Global identity deletion remains a separate operation across every organisation.

```mermaid
flowchart LR
    A[Active or archived organisation account] --> P[Preview records by application]
    P --> T[Choose compatible account or Group]
    T --> B[Protected transfer in resumable batches]
    B --> C{Any owned records remain?}
    C -- Yes --> R[Report remaining or refused records]
    C -- No --> D[Account deletion may proceed after final checks]
    A --> I[Archive: stop account access immediately]
```

## Record-type lifecycle policy

Every installed record type has an explicit lifecycle policy selected by an
authorised administrator during application setup. It is not a PostgreSQL TTL
on a shared physical table. Policy scope is organisation + storage contract +
permanent application root ID for application-contained rows. Organisation-shared rows have
one organisation-owned policy referenced by all consuming applications. Ordinary
release/binding upgrades preserve policy identity, age and counts; installing
or editing another application cannot change it silently.

Organisation settings specify the maximum permitted retention days and maximum
retained-record count, and allowed end-of-life actions/archive destinations. Each
record-type policy may be stricter but not exceed those limits. Either limit may
be absent only when the organisation explicitly allows that absence; choosing
unlimited retention is an explicit setting, not a missing-policy fallback.

Age is elapsed UTC time since record creation, not since the last edit. Count
includes all retained records in that policy scope, including recoverable or held
records; permanently removed records do not count. At most N retained records are
within the count limit: excess candidates are selected oldest-created first, with
permanent record ID as the tie-breaker. If both age and count are configured,
either can make a record due. Count/age are lifecycle targets, not entitlement
quotas: blocked removal reports a visible over-limit condition rather than silently
deleting protected data or inventing a create denial.

End-of-life actions are an explicit recoverable deletion under the existing
recovery policy, or an exact registered backend durable workflow to archive to an
approved destination followed by that protected deletion. Permanent removal still
follows recovery periods, legal holds and privacy rules. There is no unrestricted
SQL, URL or provider credential in a policy. The archive workflow receives stable
record references, executes through normal Vortex permissions and Connections,
and produces verified destination evidence before any source deletion is accepted.
Failed, unavailable or incomplete archival retains the source and reports pending
or failed status; retries do not duplicate archives or delete a newer record.
Recheck record revision and current policy before deletion. A legal hold prevents
removal and cannot be bypassed by an archive workflow.

Definition validation checks declared lifecycle shape/references; protected live
policy save and application activation require a concrete
policy within current organisation limits and all capabilities that its selected
action needs. A workflow-based policy cannot be enabled before workflow registration
and the required Connection are ready. Definition-only authoring remains possible.
Lowering organisation limits or changing a policy previews affected records and
requires the normal authorised confirmation, then applies the new policy revision
in bounded batches. It never starts an unbounded deletion inside settings save.

The maximum also covers recoverable source retention; the active period plus
recovery period must fit the organisation ceiling. Legal holds are an explicit
exception, not a new unlimited policy. An archive destination must have its own
approved retention/residency/deletion handling; moving records elsewhere is not
proof of deletion or a way around organisation limits.

```mermaid
flowchart TD
    O[Organisation limits and allowed actions] --> P[Record-type policy at app setup]
    P --> S[Select due records by age or count]
    S --> H{Held or otherwise protected?}
    H -- Yes --> E[Keep source and report exception]
    H -- No --> A{Configured action}
    A --> D[Recoverable deletion]
    A --> W[Registered durable archive workflow]
    W --> V{Verified archive and unchanged record?}
    V -- No --> E
    V -- Yes --> D
    D --> R[Existing recovery and permanent-removal rules]
```

## Scheduled time-based calculations

A stored calculation that changes at a deadline refreshes automatically without
a person editing its record. The same calculation engine supplies its next due
time. A committed save updates that due time alongside the value; changing or
clearing the deadline cancels/replaces the pending work. The shared scheduler
processes due work in bounded batches through a protected recalculation operation,
not a separate formula engine or one deployed Kestra flow per record.

Recalculation rechecks the current definition, record revision and authority,
reuses the calculation engine's transitive dependency closure (including parent
relationship totals), updates affected values and revision/Activity/events atomically,
and schedules the next transition if one exists. Retries do not repeat successful
effects; deleted records and stale deadlines do not reactivate obsolete work.
Restart catch-up selects overdue work. No provider scheduler guarantees execution
at an exact instant: before a query filters, sorts or aggregates a due calculation,
the Query/Record boundary refreshes the relevant due set through this same operation,
including due child inputs of a parent total with no own deadline, or returns an
explicit temporary-unavailable result. It must not silently use stale
values or fix only the already-selected page of rows. This freshness rule also
applies to detail views, exports and MCP.

Publication accepts only supported time expressions with a determinable next
transition; it does not promise continuously changing arbitrary expressions through
an unbounded polling loop. Ordinary non-time-based calculations remain save-driven.
Background work uses existing Event/worker scheduling and later durable workflow
integration where appropriate; it does not create a second scheduling platform.
