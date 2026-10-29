# 9. Workflows and process pipelines

This chapter specifies the product's workflow engine and process pipelines.

[Previous: Forms, actions, rules and events](08-forms-actions-rules-and-events.md) · [Specification index](README.md) · Next: [Queries, reports, search and live updates](10-queries-reports-search.md)

## Purpose and authority

A **back-end flow** is a flow that runs apart from the request that started it: a child started by a **Run on back end** (`backend.run`) step, or an after-save subscriber started by a committed record `Event` ([Amendment A](../build-plan/architecture-decisions-2026-09-25.md#amendment-a-29-october-2026--studio-flows-one-compiled-plan-page-steps-in-the-page-a-back-end-adapter)). There is no separate workflow language, engine or catalogue: every flow uses the one [flow language](appendices/frontend-rule-designer.md#one-flow-language), the one task registry, the one compiler and the one validator. A **process pipeline** describes the business stages through which a record moves; its transitions and entry and exit effects are tasks inside flows.

A back-end flow runs through a **back-end adapter**. Contract 4 has one adapter, `simulated`: it runs the flow's compiled plan with the same interpreter on the Vortex server, as the initiator, in its own transaction after the calling segment commits. `await` mode returns the child's outputs to the caller; `start` mode returns a run reference and runs after the reply. A Kestra adapter (and later n8n) plugs in behind the same interface with no change to flows or to Studio; its requirements are kept in [The Kestra adapter](#the-kestra-adapter-back-end-epic) below. None of the back-end chain runs today: publication refuses `backend.run` and `Event` subscribers by name until the simulated adapter ships.

Vortex remains authoritative for identities, tenant and organisation context, permissions, definitions, records, files, connections, and every application side effect. A back-end adapter receives no organisation database credential and cannot grant access or write organisation tables directly.

## Triggers

A flow's `triggers[]` holds only its automatic starts. Contract 4 has exactly two:

| Trigger | Starts | Execution kind |
| --- | --- | --- |
| `BeforeSave` | Inside the save transaction of a named record type, before commit, for every writer, in the order of the record type's ordered rule list | `transaction` |
| `Event` | After a committed record change: one of the seven standard [events](08-forms-actions-rules-and-events.md#events) or a declared business event. An after-save subscriber runs once on the back-end adapter and may declare "run after" another subscriber | `background` |

Schedules and verified incoming messages return with the back-end epic.

Every other start is a **binding**, not a trigger: a component placement, navigation item, form commit, interface operation, agent tool or parent flow holds the exact flow id plus a typed input map. Pages never hold flow logic of their own.

### The record a flow runs for

A flow reads the record it runs for in one way: `{{ trigger.record.<field> }}`. A `BeforeSave` flow's record is the record being saved (with `{{ trigger.previous.<field> }}` for its values before the change), an `Event` flow's is the record the event is about, and a named action's is its subject. An `interactive` flow bound to a record (a button on a record page, a board's card move) names the input that carries that record in its `recordInput`: a required `record_reference` input of exactly one record type. When the flow starts, and again whenever it resumes after a form or confirmation, the platform reads that record afresh under the initiator's current access, with field-level read policy applied: a field the initiator may not read reads as empty, and a record the initiator may not read refuses the start. The values are typed by their fields and never stored with a paused run. Only the started flow reads its record; a flow it runs through Run flow reads none. There is no separate step that loads the current record. Studio's condition and value controls offer the record's fields with their types and, for a choice, its options.

A **frontend flow** is a flow a person or agent starts through a binding (`interactive`, or `transaction` for a named action); a **back-end flow** runs through the back-end adapter (`background`). There is one start path ([#979](https://github.com/Abzum-NZ/Abzum-Vortex/issues/979)):

1. Every button, menu command, record gesture, agent tool call and interface operation starts a frontend flow through its binding. A form, interface operation or agent tool binds a flow entry point — a generated one-task flow by default — and never binds a lower-level operation directly. An interface read operation or a query tool names a declared query, which the Query engine runs directly under the caller's access; a data flow is used only when a builder adds transform or write steps.
2. A frontend flow starts a back-end flow only through a **Run on back end** (`backend.run`) step with declared typed inputs. The step ends a server segment; the child runs after that segment commits. A `transaction` flow runs inside a record save and cannot contain `backend.run`, and the target flow holds no page steps.
3. Back-end flows are otherwise started only by a committed record `Event`, and may call one another only with typed inputs and outputs through a **Run flow** or **Run on back end** step.

A flow a person or agent starts is an **action**; a lower-level protected change such as apply record changes is an **operation**, not an action.

Each trigger declares its typed inputs, a nullable entry condition and its duplicate-protection rule. Publication matches every declared input to its exact owning contract and refuses missing, extra or invented inputs. An `Event` trigger names both the event and its record type; publication proves that the event exists, belongs to that record type, and carries every declared record-field input the flow reads. A condition may reference only fields on the actual event or binding subject record.

The [Frontend Rule Designer](appendices/frontend-rule-designer.md) authors triggers, bindings and tasks in the same designer for every execution kind. A Show form step may collect private draft answers between server segments; [#68](https://github.com/Abzum-NZ/Abzum-Vortex/issues/68) and [#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250) own that private draft and binding runtime. No database transaction stays open while awaiting a person. Each server segment of an interactive flow is one request and one transaction, so earlier committed segments remain committed when a later one fails.

Flow inputs map explicitly to declared trigger inputs through the versioned binding extension in [#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250), completed by [#76](https://github.com/Abzum-NZ/Abzum-Vortex/issues/76), [#77](https://github.com/Abzum-NZ/Abzum-Vortex/issues/77) and [#78](https://github.com/Abzum-NZ/Abzum-Vortex/issues/78). This is a validated snapshot, never a shared mutable environment or a wholesale browser-variable payload. No unrelated interface or child-flow payload is silently widened.

### Interactive and save hand-off

Publication and the runtime compile each flow once per release into a plan of page segments, server segments and back-end steps; the plan is cached with the installation's runtime bundle and never stored. In the page and in WebMCP, page steps run in the browser and each server segment is one gated request: Vortex reloads the current active installation and the exact published binding, checks the caller's current permission, subject revision and the segment's path guard, validates only the declared typed inputs, and runs the segment's server steps in one transaction. Values a segment returns and the page sends to a later segment are caller inputs, re-validated by type and access. The browser plan holds only page steps and segment stubs (id, input and output types, labels), never operation inputs, server-step properties or secrets. An external API or MCP client is driven by the server, which returns page steps as intents with a continuation. Today the server drives every channel; the page driver arrives with the page runner.

```mermaid
sequenceDiagram
    participant B as Page
    participant V as Vortex gate
    participant DB as Vortex transaction
    participant A as Back-end adapter
    B->>B: Page segment (no request)
    B->>V: Server segment with typed inputs and idempotency key
    V->>V: Recheck access, revision, path guard and typed inputs
    V->>DB: Server steps in one transaction
    DB-->>V: Commit or refuse together
    V-->>B: Outputs, refresh rows, warnings or refusal
    V->>A: backend.run child after commit
```

The idempotency key of a server segment is (gesture or form-instance id, segment id, iteration path), shared by people and agents. A rejected or rolled-back save starts no back-end work.

<a id="safe-workflow-node-catalogue"></a>

## Task types in the shared registry

Every flow uses the same task types. There is no second frontend, background or workflow catalogue: every task type is registered once in the one task registry ([`flow-task-registry.ts`](../../packages/platform/src/workflows/flow-task-registry.ts), [#983](https://github.com/Abzum-NZ/Abzum-Vortex/issues/983)) with its version, its typed properties, outputs and outcomes, its default policy, its effect class (**pure**, **read**, **change** or **interface**) and its `runs` flags: where an implementation exists (**page**, **server**, **backend**). The page and server implementation maps are typed from the flags, so a flag without an implementation, or the reverse, fails the type check. Studio's palette offers a step only where it runs, and publication refuses a step placed where it has no implementation, naming the step. A step whose runtime is a later batch is refused at publication by name until it lands.

Control tasks give the ordered task list its structure: **If**, **Switch**, **For each**, **Sequential**, **Run flow** and **Stop** run wherever their children run. A **For each** over record steps inside a server segment compiles to one set-based change.

The registered task types of contract 4:

| Task group | Registered task types | Runs | Effect class |
| --- | --- | --- | --- |
| Record | Save record, Create record, Set fields, Link records, Delete record, Restore record and Apply record changes | Server | Change |
| Query | Query records, Read selected record fields, Acquire record pin identity | Server | Read |
| Data | Calculate (with a declared result type), Set values, Set variable, Format value and Build record link value | Page and server | Pure |
| Save rules | Require field, Warn and Refuse save | Page (feedback only) and save transaction | Pure |
| Interface | Show message (target, severity, one optional action), Clear message, Set page value, Validate form, Show form, Confirm, Navigate, Refresh, Open or close panel and Set filter | Page | Interface |
| Back end | Run on back end (`await` or `start`) | Server, ending the segment; the child runs on the back-end adapter | Change |
| Events | Announce event | Server and save transaction (the record being saved only) | Change |
| Protected operation | Call protected operation, whose operation descriptor declares its own effect | Server | Change, as declared by the called operation |

Run background flow, Call connection, Acknowledge message, Export to file, Attach file, Move file and the durable-only Parallel, Wait until and Wait for a person are not in contract 4; each returns with its runner in a later epic.

Every record task calls one protected operation, **apply record changes**: `record.save`, `record.create`, `record.setFields`, `record.link`, `record.delete`, `record.restore` and `record.changes`. One call is one transaction that enforces the access decision for each touched record, field permissions, pipeline transitions and gates, action-only fields, revision checks, `BeforeSave` flows, and read-time and stored computed values. A flow cannot split or bypass this operation: record changes that must succeed or fail together are one `record.changes` task.

Values passed between tasks are explicit. A value is a literal, a declared trigger value, a named output of a named earlier task, the current record, the current actor, or the current time. A task-output reference may add a path of at most five named fields, for example `{{ outputs.form.values.label }}`. Publication requires the selected output to be declared as JSON and every selected name to appear in its declared member shape; an unshaped JSON output cannot be read by field path. The selected member takes the type of its declaration. The runtime reads only own object properties, refuses a missing member, a wrong-type member or a non-object intermediate value, and never indexes arrays or follows inherited properties. Publication resolves readable task and field keys to permanent identifiers, rejects values outside the trigger contract, rejects missing or incompatible outputs, and rejects a reference to a task that cannot precede the consumer. A plain JSON object is a literal and is never interpreted as a hidden task reference.

A task property that takes a set of named values, such as the parameters of **Navigate**, reads them from a **map value**: a bounded set of named entries, each of which is a value of its own. Only that kind is resolved entry by entry, and each entry resolves under exactly the same rules as a value written directly in the property, so a nested reference reads the same input, variable or earlier task output. A map holds at most 100 entries and nests at most 5 maps deep. A plain JSON object literal keeps its literal meaning, and a map is refused where the names in the value are field aliases or an ordered change list, because those names are resolved by publication and a map resolves its values only.

Output types cover text and formatted text, numbers and money, Boolean, dates, choices, JSON, record or record-list references, organisation-account references, child-run references, relationship or relationship-list references, and file references. Record-producing tasks also declare how their target is derived: the task's configured record type, its query, or its input record. Publication propagates that target through create, change, duplicate, bounded-loop and query tasks, set-values tasks, trigger inputs and form-response outputs. Assigning a value to a link field checks the link's exact allowed record targets as well as the general record-reference type. File tasks accept only a file reference and only an attachment field on the selected record.

A named path can select a field from the `values` output of **Show form** and pass that answer to a later task. Show form's input map declares the names and types of the answers it accepts; publication checks the path against that map and the runtime refuses missing, extra or wrong-type answers before continuing. Paths cannot select fields from scalar, record-reference or unshaped JSON outputs. The flow interpreter resolves the path after the form resumes. Named-action effect collection refuses task-output references inside field values, and legacy `BeforeSave` rule-graph lowering refuses task-output formula operands; neither lowering carries intermediate task outputs.

The unary `record_id` formula takes a declared JSON value containing exactly the canonical Record-reference object's own `recordTypeId` and `recordId` members, both non-nil UUIDs, and returns the `recordId` as typed text. It returns an unresolved value for null, missing, malformed or extra members, arrays, scalars, or a non-JSON operand, so the caller refuses before effects. A picker answer can be declared as JSON with a null initial value, selected through its named outer field, and passed to this formula without changing path grammar. Extracting an identity grants no access or authority; the picker and protected operation retain their existing checks.

A **Run flow** task invokes another flow, which keeps its own declared execution kind, with a typed input map and typed outputs; a **Run on back end** step runs a flow through the back-end adapter with a typed input map. The parent's task is the binding: it names the exact child flow, and publication checks its input map against the child's declared inputs, refuses cycles between flows and enforces the Run flow depth limit. A child never inherits undeclared context, and no payload is widened by convention.

Authored definitions may omit repetitive execution policy. The versioned source contract then supplies the documented conservative defaults before publication: a five-minute timeout, three exponential retry attempts from one to thirty seconds, the task type as its activity key, and no payload in activity. Tasks that create or change records, relationships or back-end runs default to required duplicate protection; read, wait, branch, format and stop tasks default to not applicable. Canonical published tasks always contain the resolved policy explicitly, and publication refuses a policy that is unsafe for the task type.

The registry excludes arbitrary SQL, JavaScript, shell commands, database credentials, unrestricted expressions, arbitrary network addresses, unrestricted file-system operations, and vendor-specific direct table manipulation. New task types require a platform release, security review, contracts, tests, and documentation; builders cannot upload executable code.

## Limits and safeguards

- A flow holds at most 100 tasks including nested tasks, nested no deeper than five levels.
- One interactive or back-end run has at most 100 **For each** items, at most 25 protected operations, at most 10 seconds of server time and a **Run flow** depth of at most 3. A bulk action over up to 200 selected records is one set-based transaction; "all matching" beyond 200 runs as `backend.run` in `start` mode with per-batch transactions.
- An exclusive binding declares a timeout; `latest_wins` is allowed only on a binding whose plan changes no data.
- Every external side effect has a stable duplicate-protection key.
- Retries use bounded delay and a task-specific maximum attempt count.
- Cancelling stops future work but does not pretend that completed external effects were undone.
- Compensation is a separate, explicit path.
- Access is checked when the flow starts and again immediately before every protected read or side effect. Removing access therefore affects the next protected task request.
- A recipient flow cannot select, persist, export, or send live records shared from another organisation. A grant-approved action executes synchronously at the source.

## Process pipelines

A pipeline belongs to a record type and follows one of its choice fields. Its stages are that field's options, each exactly once, in the order a board shows them, and each has a colour role from the theme tokens. Its transitions are the only moves between two stages that a save accepts. The record write path enforces them for a person's save, a `BeforeSave` flow's output and a named action alike. A stage is gated when a named action owns its option (the action's `sets_choice_field` and `sets_choice_option`). Saving that option anywhere then runs the action, with its permission, condition and inputs. A board over the choice field takes its columns, colours and drag rules from the pipeline, and a board whose choice field has no pipeline is refused at publication.

```mermaid
stateDiagram-v2
    [*] --> New
    New --> Qualified: authorised transition
    Qualified --> Approved: gate passes
    Qualified --> Rejected: gate fails or authorised rejection
    Approved --> Completed
    New --> TimedOut: stage target passes
    Qualified --> TimedOut: stage target passes
```

The record's current stage is Vortex business data. Stage movement is a named [action](08-forms-actions-rules-and-events.md) checked inside the record transaction. Immediate entry and exit effects occur in that transaction; back-end work starts only after commit.

## Acceptance examples

- Publication compiles the same plan the runtime uses, and refuses a step placed where it has no implementation, naming the step.
- Page steps, refusal or rollback start nothing on the back end.
- Repeated delivery performs a Vortex transactional change once through its effect receipt. External calls use provider idempotency when supported; an uncertain non-idempotent outcome requires reconciliation before another attempt.
- Removing a role before the next task runs causes that protected operation to be refused.
- A flow cannot call an unapproved connection, arbitrary address, SQL statement, or uploaded script.
- A run started under one application version remains explainable after a newer version is published.
- A move between two pipeline stages that is not a declared transition is refused, and a move into a gated stage runs its owning action with that action's permission, even if a flow tries to save the stage directly.

## The Kestra adapter (back-end epic)

Nothing in this section runs today; the dead durable chain was deleted ([#3752](https://github.com/Abzum-NZ/Abzum-Vortex/issues/3752)). These are the requirements a Kestra adapter must meet when the back-end epic adds it behind the back-end adapter interface on contract 4, together with the [compiler rules in Decision 1](../build-plan/architecture-decisions-2026-09-25.md#keeping-customer-text-out-of-kestras-template-engine). Durable-only acceptance: publishing registers no Kestra flow; repeated registration converges; a start accepted before an upgrade stays pinned to its revision; Vortex shows Kestra's current run state and labels it unavailable during an outage.

### Authority

[Kestra](https://kestra.io/docs) is authoritative for whether a durable flow run or task is queued, running, waiting, completed, cancelled, or failed. Vortex asks Kestra for the current state whenever a person views a run. Vortex may keep a clearly labelled last-known snapshot for correlation, search, activity, and outage diagnosis, but never presents that snapshot as current when Kestra is unavailable.

```mermaid
sequenceDiagram
    participant V as Vortex
    participant K as Kestra
    participant P as Protected platform operation
    participant U as Person
    V->>K: Start published durable flow with correlation and security reference
    K->>P: Signed, versioned step request
    P->>P: Recheck current access and duplicate key
    P-->>K: Completed, waiting, retryable, or refused
    U->>V: View flow run
    V->>K: Read current execution state
    K-->>V: Authoritative state and step position
    V-->>U: Current state plus Vortex activity links
```

### Ownership and versioning

Durable flows are contained in an [application version](03-composition-and-publication.md#definition-ownership-and-versions). Publishing an application produces the immutable flow definition and deterministic input from which its Kestra flow can be generated. Publication is inert: it neither registers a flow nor changes a live installation. An explicit application install or upgrade registers and activates the exact published application and flow versions used by new runs. A run remains pinned to the application and flow version from which it started unless an authorised, tested migration moves it.

#### Installation registration and activation

One private Workflow Kestra adapter deploys every installed application's durable flows into the shared Kestra instance without redeploying the engine. The adapter accepts only an immutable candidate prepared from the exact published application release and its resolved dependencies. It never accepts browser-supplied YAML, namespaces, flow identifiers, credentials, or claims that registration succeeded.

```mermaid
sequenceDiagram
    participant Install as Application install or upgrade
    participant V as Vortex
    participant K as Shared Kestra
    Install->>V: Authorise exact immutable candidate
    V->>K: Prepare versioned flows inactive
    K-->>V: Verify every identity and fingerprint
    V->>V: Activate installation revision
    V->>K: Enable current schedules and disable superseded schedules
    Note over V,K: Starts and schedules recheck current activation
```

The generated namespace and flow identity are scoped by permanent environment, organisation, installation, application, and flow identifiers plus exact revisions. Labels and mutable keys are diagnostic only and never select or authorise a flow. A schedule is registered disabled or otherwise unable to start application work while its candidate is being prepared.

Preparation registers every durable flow version and verifies its exact generated fingerprint before Vortex activates the installation revision. The activation is one Vortex transaction after external preparation; Vortex never claims that its database and Kestra share a transaction. An interactive start request and every scheduled wake-up must therefore verify that the exact installation revision is still current and active before Vortex durably accepts a new start. Once accepted, that intent is pinned to the exact application and flow revision like an in-flight run: a normal upgrade neither retargets nor drops it. Post-commit dispatch rechecks current permission and withdrawal state and verifies that the accepted exact revision remains retained; it does not require that revision to remain the installation's current pointer. A prepared but unactivated flow cannot pass initial acceptance.

Registration is duplicate-safe. Repeating the same installation, flow version, and fingerprint converges on the same prepared flow; the same identity with different content is refused. A failed first registration leaves the installation not ready. A failed upgrade leaves the existing active revision unchanged. Only after every new flow is verified does Vortex switch the active revision, so partial external registration cannot create a partly upgraded live application.

After activation, an idempotent reconciliation enables the current revision's prepared schedules and disables superseded schedules. Failed or interrupted synchronisation remains visible and retryable; it cannot leave an enabled old schedule authorised to start new work, because Vortex still checks the active revision. Vortex distinguishes an active installation from pending schedule synchronisation and does not claim that a schedule is running until its enablement is verified.

Older flow versions and their private mappings remain available for accepted starts and runs already in flight. Explicit rollback activates a previously verified exact application revision through the same checks; it does not mutate history. Uninstalling or withdrawing the installation first blocks new acceptance in Vortex, including scheduled starts. An accepted start that has not begun execution is explicitly refused or cancelled with a retained status rather than discarded; an already running execution follows the published cancellation policy. Execution, mapping, intent, and activity history remain available to explain each outcome. Later external deactivation and retention cleanup are reconciled operations, not the authority for whether a new start may be accepted.

The public Vortex execution reference stores the Vortex run identifier, flow and application versions, tenant and organisation references, trigger, start actor, duplicate-protection key, human-input links, safe activity links, and a non-authoritative last-known state snapshot. The Workflow Kestra adapter privately maps that run to Kestra's execution identifier and namespace; provider-specific fields are not part of the core application contract. Kestra stores the executable state, current step, retries, waits, and final execution outcome.

### Protected operation contract

Each Kestra request carries the execution, task, attempt, tenant, organisation, application and flow versions, named operation, typed input, issue and expiry times, and duplicate-protection key in a signed envelope. Vortex verifies the caller, current account or system authority, access version, definition version, and operation before acting.

Vortex records an application side effect and its duplicate key before acknowledging it. Repeating the same request returns the existing result without applying the side effect again. The response is completed, already completed, waiting, retryable failure, or permanent refusal. Kestra uses that response to advance its authoritative execution state.

The published release retains one canonical operation-reference set in each protected `application_flow_node` entry. The entry keys the source task ID within its exact flow; the durable compiler attaches that set to the corresponding retained callback node. A Query node has exactly one reference: the query's owning Application or Module and its query ID. A Record node's references identify its statically bounded record types by owner and record-type ID: the task's `record_type`, both record types at a `record.link` relationship's ends, or the declared `recordTypeIds` of a record-reference or change-list input. Each set is deduplicated and canonically sorted. A node without a static type bound retains an empty set and is marked not grantable; it may run as the person, but cannot receive a run-as grant. There is no first-type fallback or platform-wide apply-record reference. Existing `operation.call` identity and release pinning remain unchanged.

The durable compiler accepts this map as trusted input from the exact published release and carries each set into the retained node binding. It does not infer an owner from an ID or task label. A run-as grant is pinned to the exact flow, node, actor, and complete current reference set; a changed set after republication invalidates the grant.

### Asking a person

The durable **Wait for a person** task pauses for one published form response with assignee rules, due time and timeout path. Only an authorised responder can submit it. Kestra waits for the protected completion signal and remains authoritative for the overall run state.

An application that needs a task list or approval queue defines ordinary task, request and decision record types and the pages that display them. Those records can trigger or complete the generic human-input step, but they cannot grant permissions or activate cross-organisation sharing. Grant activation uses the protected [grant-consent boundary](04-access-and-permissions.md#protected-grant-consent).

The [IAM application](appendices/iam-application.md) uses this same human-input mechanism for role requests and approval history. Its durable flow may apply an approved role change only through a verified published protected-operation binding and current Access checks. A mutable request status is never authority; changing a proposal invalidates earlier approval, and losing approver authority before application refuses the grant. IAM introduces no special flow task or separate approval engine.

### Failure and display behaviour

- If Kestra is unavailable, Vortex shows “flow status temporarily unavailable,” the last successful refresh time, and any safe local activity. It does not infer completion.
- A permanent refusal stops that path with a stable reason; it never broadens permissions to finish the run.
- Operators can correlate one Kestra execution with Vortex activity and side effects without treating the duplicate local snapshot as authority.
- Reconciliation reports missing executions, mismatched identifiers, and callbacks with no matching published definition; it does not silently rewrite business data.

## External outcome uncertainty

A local duplicate key cannot prove that an external provider did not act before a timeout. Use provider-supported idempotency keys where available. Otherwise record an unknown outcome and reconcile or obtain an explicit authorised resolution before retrying a possibly completed side effect. Never promise exactly-once third-party execution from a local receipt alone. [Connection execution #100](https://github.com/Abzum-NZ/Abzum-Vortex/issues/100) covers both cases.
