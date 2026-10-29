# Architecture decisions — flows, applications, packages and caching (25 September 2026)

> Historical design record. The [target architecture](target-architecture.md), approved 12 October 2026, supersedes conflicting technical direction and delivery guidance in this document. The original decisions below are retained for history.

**Status:** Approved direction from the product owner on 24–25 September 2026, reviewed independently by Claude Opus 5.5.

**Goal:** Vortex is an application builder in which everything a customer uses is a definition that generic engines render or execute. This includes Vortex's own administration, identity and access applications. A person with the right permissions, or an agent acting for them through the API or MCP, can create, change, install and uninstall a complete application without code changes or redeployment.

**Evidence:**
- the five-part modularisation review of 24–25 September against main `05a2bdf`;
- implementation issues #976–#1104 and the package issues created with this document.

## Sections superseded until rewritten

Where these sections conflict with this document, this document wins until each section is rewritten by its named issue.

| Section | Superseded by | Rewritten by |
| --- | --- | --- |
| [03](../specification/03-composition-and-publication.md) §Definition ownership and versions (packages are derived, not a third kind) | Decision 7 | package specification issue |
| [16](../specification/16-copying-sharing-import-export.md) §Definition packages (packages are derived; version ranges apply only across clusters) | Decision 7 | #722 |
| [Platform permission catalogue](../specification/appendices/platform-permission-catalogue.md) (current catalogue version 1.4.0, including the builder permissions) | Decision 11 | builder permissions issue |

## Summary

| # | Decision | In one sentence |
| --- | --- | --- |
| 1 | One flow definition, one Vortex flow engine, Kestra for durable work | Every behaviour is a stored flow definition. Our own flow engine runs it, the server drives any flow that touches protected data, and waiting work runs on Kestra. |
| 2 | Saving is a flow around one atomic operation | The default Save is an editable one-task flow, and every record change goes through one protected "apply record changes" operation that enforces every record rule. |
| 3 | Save rules run where they cannot be bypassed | Rules that must always hold run inside the save transaction for every caller. The browser runs the same rule only to give feedback. |
| 4 | Formulas and read-time computed fields | Calculations use one typed formula tree. Values that depend on the current time are computed whenever they are read and are never stored. |
| 5 | One configurable Records table component | Lists are one component whose data, columns, sorting, filters, actions and states are all configured inputs. |
| 6 | The theme engine exists | The delivered theme engine has a naming defect to fix. No second theme engine is built. |
| 7 | Applications are delivered as packages, and custom logic follows a ladder | Configuration comes first. Custom UI components run in a sandbox in the browser. Custom backend scripts are reviewed, tested and installed only by Vortex super administrators. |
| 8 | Clean install, upgrade and uninstall | Each service records what it registers for an installation, uninstall removes everything recorded, and the report proves it. |
| 9 | An immutable runtime bundle per installation revision | Compiled installations are cached by an immutable key, so opening a page reads no definition. |
| 10 | Agents build applications through the same operations | Every builder operation is one typed, permission-checked operation used by the designer, the API and MCP, including preview installation. |
| 11 | Building, installing and system applications are permission-gated | Only roles with the builder permissions can change definitions. System applications are customisable by them, but cannot be uninstalled. |
| 12 | shadcn/ui on Base UI is the component base | Every Vortex interface primitive is a shadcn/ui component built on Base UI, styled with Tailwind CSS and themed by the existing Vortex theme engine. |
| A | Amendment, 29 October 2026: Studio flows | One interpreter runs one compiled plan per release: page channels run page steps in the browser and call the server once per server segment, headless channels keep the server driver, and back-end work runs through a back-end adapter (simulated now, Kestra later). Contract 4 holds only what runs. |

## Amendment A (29 October 2026) — Studio flows: one compiled plan, page steps in the page, a back-end adapter

**Status:** owner-approved direction of 29 October 2026 (Epic 1, [#3660](https://github.com/Abzum-NZ/Abzum-Vortex/issues/3660); recorded by [#3725](https://github.com/Abzum-NZ/Abzum-Vortex/issues/3725)). Where it conflicts with Decisions 1, 3 and 9 below, this amendment wins. It also replaces the earlier workflow-foundation decision that every flow is server-driven with no in-page interpreter.

### What runs today, and what this amendment changes

- **Today** every flow is driven by the server orchestrator, even a flow that only navigates. The page renders the intents the server returns (Show message, Confirm, Show form, Navigate) and resumes with a continuation. No interpreter runs in the browser, so Decision 3's browser feedback is not built.
- **Today** no durable, Schedule, IncomingMessage or background start runs. The Kestra compiler, the start-intent chain, the protected-node callback and the node-level run-as model have no live caller and are deleted ([#3752](https://github.com/Abzum-NZ/Abzum-Vortex/issues/3752)). Git history keeps them; the Kestra adapter is rebuilt later behind the back-end adapter interface on contract 4.

### The decisions

1. **One interpreter, one compiled plan, two drivers.** Publication and the runtime use one compiler that turns each flow into a plan of **page segments** (page steps), **server segments** (server steps, each one request and one transaction) and **back-end steps**, with the path guard that reaches each server segment. The plan is built once per release and cached with the installation's runtime bundle; it is never stored. Page channels (the page, WebMCP) run page segments in the browser and call the server once per server segment. Headless channels (external API and MCP) keep the server driver: the orchestrator's drive loop returns intents and continuations. One interpreter with two drivers chosen by channel is one engine, not two.
2. **S1: Run on back end is a step with a back-end adapter.** `backend.run` (modes `await` and `start`) replaces Run background flow. The `simulated` adapter is the only one now; Kestra and n8n are later adapters behind the same interface, with no change to flows or to Studio. The simulated child runs in its own transaction after the calling segment commits, as Kestra will; `start` mode runs after the reply. `backend.run` ends a server segment.
3. **S2: every action-bearing event has a default flow**, generated as visible steps (validate, rules, save, message, navigate or refresh). What a builder sees is what runs; the page holds no hidden behaviour.
4. **S3: page rule steps are feedback only.** Authority stays in BeforeSave flows and server segments. Every server segment re-checks its path guard.
5. **S4: reads stay data bindings, not flows.** Lists, paging, filters, expansion and choices are query bindings whose filters may read page values. Only the `load` and `refresh` events may run flows; an opt-in rows flow is a read-only exception with the same paging limits.
6. **Kept from the workflow foundation:** one admission gate, now admitting server segments; named actions are flows only; guided forms run flows on their events, while their steps stay page composition edited on the canvas. **Deferred to the back-end epic:** the run ledger, event starts under system authority, IncomingMessage, durable Event triggers, registration at install, run-as grants and the Inbox.
7. **Event names keep their contract names.** The 53 shipped bindings keep `action`, `form_submit`, `row_action`, `row_clicked` and the rest; Studio shows friendly labels.

### Behaviour the plan carries (Studio flows design)

- **Events.** Every interaction is a component event bound to exactly one flow. A binding is (component, event) → flow plus optional condition, debounce (0 to 250 ms), concurrency (`ignore_while_running`, `latest_wins`, `queue`), exclusive scope (`none`, `form`, `page`) and timeout. Defaults live in the definition. `latest_wins` is allowed only on a binding whose plan has no change segment; an exclusive binding needs a timeout. Values set by a flow fire `changed` marked as flow-set; a flow is not re-entered for the same component in one cycle, and a cycle stops after 3 levels with a visible reason.
- **Options.** A choice or link field has one options source on the field (data model): a fixed list, a query binding with declared inputs, or an options flow returning value, label and description. Options run under the person's permissions, load on demand (keyset 40, 200 maximum), are cached per input values, and the save re-checks membership inside its transaction. An options flow holds only pure and read steps.
- **Agents.** Agents act through the same page model: field, option, button, grid and page tools generated from the definition, through the same gate (channel `webmcp` in the person's page, `mcp` for external clients). A hidden field is not a tool; a read-only field refuses; WebMCP never skips a confirmation. The separate agent tool bundle is deleted.
- **Grid.** Rows load through query bindings; every grid gesture (open, cell edit, paste and fill, undo, card move, quick add, bulk action, selection) is an event bound to a flow. Up to 200 selected ids is one transaction and one set-based write; "all matching" beyond 200 runs as `backend.run` in `start` mode with progress and per-batch transactions.
- **Order.** One flow per component event. UI reactions (show or hide, required, read-only, dependent options, calculated values, filters) are declarations, not flows. BeforeSave flows run in the declared order of the record type's ordered list inside the save transaction; any refusal stops the save and warnings are collected. After-save subscribers (`Event` trigger) are independent, run once each on the simulated back end after commit, and may declare "run after". The page runner settles in-flight change flows before a submit (up to 2 s; beyond that the submit is refused with the reason, typed values kept).
- **Page values and messages.** A page declares typed page values (number, money, text, boolean, list); flows write them with `set_value`. They live only in the page and are never trusted by the server. `show_message` has a target (toast, banner, inline under a component, a message slot by placement id) and a severity (info, success, warning, error), plus one optional action bound to a flow; `clear_message` removes a message. `data.calculate` declares its result type. Formulas are typed text parsed in Studio only, compiled to closures over the typed tree and never evaluated as code.
- **Studio.** One node registry says where each step runs (`runs: page, server, backend`); the palette offers a step only where it runs, and publish refuses a step with no implementation where it is placed. Test runs use the real runtime on the preview copy; only the back end is simulated.
- **Speed.** Page-only flows make no request; one server segment is one request and one transaction; `for_each` over record steps compiles to one set-based change.

### Contract 4

One definition contract version, `4.0.0`, replaces 3.0.0 for applications, modules and record types; the old version is no longer accepted. It holds only what Epic 1 runs:

- **Bindings** gain `condition`, `debounceMs`, `concurrency`, `exclusive` and `timeoutMs`; the channel set gains `webmcp`. The node-level execution binding and the second effect vocabulary are removed.
- **Events** gain `field_focus_lost`, `options_requested` (the one options event), `form_cancel`, `record_loaded` and `batch_edit`; every existing name stays.
- **BeforeSave** has no `priority`: order is the record type's ordered rule list. The `transition` operation is removed; `delete` and `restore` are added and refused at publication until the one record writer applies rules to them.
- **Registry** tasks carry `runs: {page, server, backend}` flags, and the page and server implementation maps are typed from them. Added: `backend.run`, `interface.set_value`, `interface.clear_message`, `interface.validate_form`; `show_message` target, severity and action; a declared result type on `data.calculate`. Removed: `flow.run_background`, `connection.call`, `message.acknowledge`, `file.attach`, `file.move`, `file.export` and the durable-only control tasks (`parallel`, `wait_until`, `wait_for_person`). Execution kind `durable` and triggers `Schedule` and `IncomingMessage` are removed; `Event` stays.
- **References** gain `page` (a declared page value) and `form` (a field of a named form on the page). A server segment refuses a `page` reference: only typed caller inputs cross.
- **Options source** is one declaration on each choice or link field and absorbs `dependsOn` and choice `parentValues`.
- **One of each:** one flow id brand, one structure rule set, no unused flow-target dependency kinds, no run-as vocabulary without a reader.
- **Not yet runnable** steps, settings and sources are refused at publication by name and hidden in the palette by the `runs` flags until their runtime lands; nothing that already runs is refused.
- **Stored definitions** are forward-migrated: one migration converts every draft; every active installation moves to a contract-4 release through the existing publication and adoption operations; old releases stay as sealed history and restoring one is refused with a reason.

### Segment trust rules

1. A value returned by one segment and sent to the next through the page is a caller input: the server re-validates it by type and access and never trusts it as its own output.
2. A guard over page-only values (a page value, a confirmation answer) proves consistency, not authority. Studio warns when a refusing rule exists only in the page.
3. The browser plan holds only page steps and segment stubs (id, input and output types, labels): no operation inputs, server-step properties or secrets.
4. Admission refusals stay neutral (`refused`, no detail); business refusals (BeforeSave, an option no longer allowed) carry their reason.
5. The idempotency key is (gesture or form-instance id, segment id, iteration path), shared by people and agents. A form's gesture id is its form-instance submission id, minted when the form opens.
6. Each server segment carries a fingerprint of its compiled server steps and its input and output types. The gate admits a segment whose fingerprint is unchanged in the current release, so publishing does not refuse every open form.

### Decisions taken on their recommended defaults

| # | Decision |
| --- | --- |
| D1 | Studio-built drafts and installations are forward-migrated to contract 4, not reset. |
| D2 | The options source lives on the field, so every writer (pages, import, API, agents) is checked. |
| D3 | After-save subscribers run now, on the simulated back end. |
| D4 | The simulated back-end child runs in its own transaction after the caller commits. |
| D5 | Formulas are typed text with autocomplete, parsed in Studio only, compiled to closures. |
| D6 | Up to 200 selected ids is one transaction; "all matching" runs as `backend.run` in `start` mode. |
| D7 | A save while a lookup runs longer than 2 s is refused with the reason, keeping typed values. |
| A4 | The dead chains (durable and Kestra, start intents, node-level run-as, the runtime-bundle trigger index, `executeAction`) are deleted before contract 4, not converted. |
| A5 | Contract 4 holds only what Epic 1 runs; a registered task that runs nowhere is removed, not kept refused. Later epics add each back with its runner. |
| A8 | Rule-like declarations outside flows stay declarations: pipeline transitions, choice-option `requiredPermissionId`, sharing and visibility conditions, conditional formatting. |
| A9 | The SQL condition evaluator (`evaluate_typed_condition_node_internal`) and the query filter compiler (`compile_query_filter_internal`) stay: they are read-time query predicates, not a second flow evaluator. One TypeScript checker, one TypeScript evaluator and one SQL predicate compiler each keep a distinct job. |

## Decision 1 — One flow definition, one Vortex flow engine, Kestra for durable work

### The flow definition

A flow is stored data inside the release of the module or application that owns it. It is never code. Its shape follows the Kestra flow definition, so a later Kestra adapter can run it.

> Contract 4 ([Amendment A](#amendment-a-29-october-2026--studio-flows-one-compiled-plan-page-steps-in-the-page-a-back-end-adapter)) removes the `durable` execution kind, the `Schedule` and `IncomingMessage` triggers, Run background flow and the durable-only control tasks; the rows below that name them describe the back-end epic's direction, not contract 4.

| Field | Meaning |
| --- | --- |
| `id`, `key` | Permanent identity and readable key. |
| `namespace` | Derived from the owning module or application; never authored. The Kestra namespace and flow id are generated per installation (09) and are never this value. |
| `description`, `labels` | Text for builders. Labels are for search and diagnostics only. |
| `execution` | One of: `interactive`, started by a person or an agent through a binding and answered within the request; `transaction`, which runs inside one record-save transaction; `background`, a server run after a commit, started by the event dispatcher or a verified incoming message; `durable`, which runs on Kestra and is required for schedules, waits and human tasks. |
| `runAs` | Whose authority each protected task uses. Interactive flows, and durable flows started through Run background flow, run as the initiating person; an agent acts as its person. Access is rechecked before every protected task. Background flows, and durable flows started by Schedule or IncomingMessage, declare a specified account or System through the scoped execution grants (#322, #541). |
| `inputs`, `variables` | Typed with the one Vortex value-type catalogue (#982). |
| `triggers[]` | Only the automatic starts: `BeforeSave`, `Event` (after a committed record change), `Schedule` and `IncomingMessage`. |
| `tasks[]` | An ordered, nested list. Control tasks: If, Switch, ForEach, Sequential, Run flow, Stop. Durable-only control tasks: Parallel, Wait until, Wait for a person. Every other task comes from the task registry. |
| `outputs` | Typed results returned to the caller. |
| `errors`, `finally` | Tasks that run on failure and always. The default error handler shows refused, validation, conflict and uncertain outcomes safely. |
| `retry`, `timeout`, `concurrency` | Policies. Retries and long timeouts are allowed only in durable flows. |

Starts made by people and systems are **bindings**, not triggers. A component placement, navigation item, interface operation, agent tool or parent flow holds a binding: the flow id plus a typed input map. Pages never hold flow logic of their own.

**References** use a closed syntax: `{{ inputs.x }}`, `{{ vars.x }}`, `{{ trigger.record.field }}`, `{{ trigger.previous.field }}`, `{{ outputs.task.key }}`, `{{ execution.actor }}` and `{{ execution.now }}`. The compiler resolves every reference to a typed reference. No text is ever evaluated as a template.

**Formulas** (Calculate tasks, conditions and computed fields) are a typed JSON expression tree over a closed operator catalogue:
- exact decimal and money arithmetic with declared precision and rounding;
- comparison and boolean logic, and conditionals;
- text join;
- date offset and difference;
- `now`, which is allowed only in read-time computed fields and interactive or background flows.

There are no user-defined functions, loops or undeclared reads. One evaluator is shared by the browser and the server.

**Limits** for one interactive or background run:
- at most 100 ForEach items;
- at most 25 protected operations;
- at most 10 seconds of server time;
- a Run flow depth of at most 3.

Cycles between flows are refused at publication. Transaction flows may use only pure tasks, reads under the saver's authority, and changes to the record being saved.

### The task registry

Every task type is registered once (#983). Contract 4 replaces the run locations below with `runs: {page, server, backend}` flags and typed implementation maps (Amendment A). The original registration held:
- its version;
- its run locations: `browser`; `server`, a protected operation in its own short transaction; `transaction`, only inside the owning record save; `durable`, on Kestra;
- its effect class: pure, read, change, background start or interface;
- its typed properties, outputs and outcomes, and its default policy;
- how it compiles for Kestra.

Publication refuses a flow that puts a task where it cannot run. Work moves between execution kinds only through an explicit Run flow or Run background flow task.

### The Vortex flow engine

> Superseded by [Amendment A](#amendment-a-29-october-2026--studio-flows-one-compiled-plan-page-steps-in-the-page-a-back-end-adapter): one interpreter runs one compiled plan with a page driver and a server driver; page steps run in the page and each server segment is one request.

The flow engine is built in-house and is part of the application. It has two parts today:
- a pure interpreter in `packages/platform/src/rules`;
- a server orchestrator in `packages/platform/src/definition`, which runs protected tasks through the one protected-operation executor (#989).

**Who drives a flow today:** the server orchestrator drives every flow from its first task. At a page task, such as Show form, Confirm or Show message, the server returns a typed intent and a continuation, and the page or MCP client resumes the flow with it. No interpreter runs in the browser yet; the page driver of Amendment A adds it.

**When a protected task is refused:** a refused, conflict or invalid outcome sends the flow to its `errors` handler, unless the task sets `allowRefusal: true`. In that case the flow branches on `{{ outputs.task.outcome }}`.

**Back-end runs** (Amendment A) re-run in full on redelivery. Duplicate keys make every protected effect happen once.

**Options considered and rejected:**

| Option | Why it does not fit |
| --- | --- |
| Vercel Workflow SDK (`workflow`, workflow-sdk.dev) | Workflows are TypeScript functions compiled at build time (`"use workflow"`, `"use step"`). There are no stored definitions that a designer or agent can create at run time. Steps run asynchronously across requests, which adds delay to every button click. It is a durable engine, so it would duplicate Kestra. |
| Conductor OSS JavaScript SDK | It is a client for a separately run Conductor server. It duplicates Kestra and does not run inside the application. |
| Hand-built drag-and-drop graph builders (React Flow with free node-and-edge JSON) | The canvas library is right, and the designer uses xyflow/React Flow (#633). Free node-and-edge graphs are what this decision replaces: the canvas edits the structured task list, like Kestra's topology view. |

### Keeping customer text out of Kestra's template engine

**Who can reach Kestra.** Kestra is core platform infrastructure. Only Vortex super administrators reach it. Customer builders and administrators never do.

**Why the compiler still matters.** Customer builders do write flow definitions, and those definitions are compiled into Kestra flows. Kestra's template engine (Pebble) uses the same `{{ }}` delimiters as Vortex references. Any text Kestra treats as a template is evaluated with Kestra's own functions, including its secret lookup, which on the open-source edition can read every instance secret from any namespace. So the protection must sit in the compiler and in what the instance holds, not in who can open Kestra.

**The Kestra compiler (#1087) and the Kestra setup follow four rules:**
1. **No customer text as template text.** The compiler emits customer text (labels, values, conditions) only as typed Kestra inputs or as JSON inside `{% raw %}` blocks.
2. **Automatic check.** After compilation, a check refuses the flow if any `{{` or `{%` appears outside the references the compiler generated itself. A flow that fails the check is never registered.
3. **Only the callback key.** Customer flows run on an application Kestra instance whose environment holds only the callback signing key. Operational secrets, such as delivery and database tokens, live only in a separate operations Kestra instance, which runs Vortex's own delivery flows.
4. **Vortex evaluates conditions and formulas.** Durable conditions and calculations are evaluated by the Vortex evaluator through the protected callback, and Kestra's native control tasks branch only on that result. This keeps Vortex's typed semantics, such as nulls and exact decimals.

### One start path

1. A binding (button, menu, row action, form submit, agent tool, interface operation) starts a flow. Web controls, MCP tools and interface operations use the same entry point (#1014, #1097).
2. Each server segment of the compiled plan passes the one admission gate (Amendment A).
3. A **Run on back end** step (`backend.run`) runs a flow through the back-end adapter: the simulated adapter now, Kestra later. Waits, human tasks, schedules, retries and external calls arrive with the Kestra adapter; none runs today.
4. Committed record events start after-save subscribers (`Event` trigger) on the back-end adapter.

### Performance

- A page-only flow makes no request; one server segment is one request and one transaction.
- Compiled plans are built once per release and cached with the runtime bundle (Decision 9).

## Decision 2 — Saving is a flow around one atomic operation

- **The default Save** of a form is a generated flow with one task, `record.save`. A builder with the builder permission can add tasks before it (look up values, calculate, confirm, validate) and after it (show a message, navigate, run a background flow).
- **Every record task calls one protected operation, apply record changes** (#1060–#1065). One call is one transaction. The record tasks are `record.save`, `record.create`, `record.setFields`, `record.link`, `record.delete`, `record.restore` and `record.changes`. For every call the operation enforces:
  - the access decision for each touched record;
  - field permissions;
  - pipeline transitions and gates: a stage field changes only through its named transition action;
  - action-only fields;
  - revision checks;
  - before-save rules (Decision 3);
  - read-time and stored computed values.

  It also keeps one receipt for duplicate protection, and one Activity writer and one event writer.
- **A flow cannot split or bypass this operation.** Record changes that must succeed or fail together are one `record.changes` task.
- **A named action** is a `transaction` flow started through its binding. It replaces the effect list in 08 §Actions, and its record changes compile into one apply-record-changes call (#1062, #1063).

## Decision 3 — Save rules run where they cannot be bypassed

- A rule that must always hold is a flow with a `BeforeSave` trigger and `transaction` execution. Examples: a required value, an allowed status change, "a resolved case needs a resolution time".
- The server runs it inside the save transaction for every writer: web, agent, interface, import and Kestra. Its refusals, requirements and warnings are authoritative. This integration exists since #578, and its definition moves to the flow format under #976.
- The page runs the same definition while a person edits, to show feedback at once, once the page driver of Amendment A runs page segments; it does not today. Page results are never trusted.
- Work after a change (notify someone, create a follow-up, synchronise another system) is a flow with an `Event` trigger: an after-save subscriber that runs on the back-end adapter after commit.

## Decision 4 — Formulas and read-time computed fields

- **A read-time computed field** holds a value derived from other fields and the current time, such as overdue, age in days or days remaining. It is computed whenever a record is read, and it is never stored.
- **Read-time fields that are filterable or sortable** compile to SQL. That SQL uses one statement timestamp in the organisation's time zone.
- **Queries that use read-time fields bypass the data-result cache** (17), because their values change without any data change.
- **A stored calculated field** remains the right choice for a value that does not depend on time and that totals must use. Publication refuses a stored total over a read-time field.
- **Components never compute business values.** They display what the engines return, so every screen, list, filter and agent agrees.
- Implemented by #994, #995 and the read-time computed-field contract issue. The deadline worker and due metadata are retired by #1067, and escalations become durable scheduled flows (#1092).

## Decision 5 — One configurable Records table component

The Records table is a registered component. Every behaviour is a configured input:
- **data source:** a record type or a declared query, with parameters fixed or taken from the page;
- **columns:** field references with format, width, alignment and a responsive priority that says which columns hide first on small screens;
- **sorting:** the default sort and the fields a person may sort by;
- **filtering:** the fields a person may filter by, a search box and saved views;
- **paging:** the page size;
- **selection:** none, single or multiple;
- **row behaviour:** a row click (open the record page, open a panel or run a flow), row actions, bulk actions and inline edit, each held as a binding to a flow;
- **messages:** empty, refused and error.

The Records table runs its query directly through the Query engine, which enforces access, withheld fields, paging and totals. A data flow is used only when a builder adds transform or write steps. The component never fetches data itself.

Board, calendar and summary are separate components with the same data-source contract (#871). Implemented by #1002–#1005 and #583–#585.

## Decision 6 — The theme engine exists

- #71, #594 and #595 delivered the theme engine: a platform theme release, application overrides, contrast and focus checks, and CSS variables.
- The defect is that the renderer reads different token names from the platform theme. #1000 and #1001 fix it.
- No second theme engine is built.

## Decision 7 — Applications are delivered as packages, and custom logic follows a ladder

### The package is derived from a published application

Publishing an application derives its package: that application release plus its exact dependency closure (module releases, flows, role templates, permission declarations, tool bundle, assets, custom components). A package is not a third publishable kind. It has no draft and no version of its own, and installation resolves nothing.

A package never contains records, accounts, secrets, sessions, drafts or live grants. Signatures are added only when a package crosses clusters (16). Inside one cluster the immutable release fingerprints are enough.

Every package also carries:
- **reference data:** a package may declare seed reference data (for example a price list). It is imported once, at first activation, as ordinary records. The import runs under a System actor scoped to the package's seed record types. The records pass normal validation and BeforeSave rules, and the import is recorded in Activity;
- **component ownership:** a custom component belongs to the application or module release that bundles it. Only that application, or applications that depend on that module, may place it. Any change to a bundle is a major version change.

### The custom-logic ladder

Use the first level that meets the need.

1. **Configuration.** Flows with registered tasks and formulas, with reference data kept as ordinary records.
2. **Custom UI component.** A package may bundle browser components, for example a 3D canopy diagram. The detailed rules are in the [application packages appendix](../specification/appendices/application-packages.md). In summary, a custom component:
   - runs in a sandboxed frame loaded through a Vortex-owned bootstrap document on a dedicated domain;
   - has no Vortex credentials;
   - receives only the fields it is mapped to;
   - talks only through one message channel.

   Its events are untrusted input. They start flows only through bindings, and a flow that changes data after such an event shows a host-rendered confirmation first.
3. **Custom backend scripts.** These are platform-reviewed code:
   - Only a Vortex super administrator can add a script to a package and install that package, after reviewing and testing it. Customer builders and administrators cannot author or install scripts.
   - A script runs as a Kestra script task inside a durable flow, on the application Kestra instance, which holds only the callback key.
   - A script receives only its declared inputs, with time and memory limits.
   - Its results reach Vortex only through a following protected task.
   - Scripts run asynchronously. Values that must be authoritative at save time use formulas.

Customer-authored code never runs on Vortex servers, in Kestra or in the Vortex browser origin.

### Example: a canopy quote page

| Part | Built with |
| --- | --- |
| Quote, Canopy option and Price list | Record types in a module. The price list arrives as seed reference data. |
| Quote calculator page | Generic components plus the custom canopy component. |
| Live area, material and price preview | An interactive flow of Calculate tasks, run when the dimensions change. This is a preview only. |
| 3D canopy diagram | A custom UI component. It receives the dimensions as mapped properties, and its "shape changed" event runs the preview flow. |
| Save quote | The default Save flow. A BeforeSave transaction flow recomputes area and price from the dimensions and the price list, so a tampered browser cannot change the saved price. |
| Send quote | A Run background flow task. A durable Kestra flow renders the PDF, emails it and waits for acceptance. |

## Decision 8 — Clean install, upgrade and uninstall

**Install** is one command. Its inputs are the package, the installer's confirmation of the manifest, and the role templates the installer accepts. It has two steps.

1. **Prepare**, which leaves the previous installation active if any part fails:
   - verify the installer's permissions (Decision 11);
   - provision module storage;
   - compile the durable flows and register them in Kestra as inactive;
   - upload custom component bundles to immutable storage;
   - build the runtime bundle (Decision 9).
2. **Activate**, which is one transaction:
   - move the installation's active revision;
   - increment the Access version.

   Navigation, launcher entries and agent tools follow from the active revision. Only enabling Kestra triggers runs afterwards (09).

Abandoned prepared candidates are cleaned up.

**Upgrade** prepares the new release set and activates it the same way. The previous release set stays active if anything fails (#598).

**Uninstall** withdraws the installation in one atomic step: module bindings detach (stored records remain) and access is withdrawn. No new work is accepted afterwards; accepted work that has not begun is refused or cancelled with a retained status, and running executions follow 09's cancellation policy. There is no intermediate draining state (#2871).

Each owning service records the registrations it creates for an installation, and can list and remove them. The uninstall report is the union of those lists. Uninstall is complete when nothing remains except items the uninstaller chose to keep. The registrations covered are:
- Kestra flows, triggers, namespace files, key-value entries and execution storage, purged according to retention and legal hold;
- execution grants (#322) and connection-instance grants;
- interface operations, public addresses and incoming-message routes;
- search documents;
- pending outbox entries and start intents, which are marked refused;
- form drafts;
- record-sharing grants, which are revoked with notice;
- MCP grant scopes;
- the default-application setting;
- custom component bundles that no other installation uses;
- cached runtime bundles;
- permission registrations (the Access version increments).

Uninstall has these rules for data and access:
- **Deleting data** applies only to record types that no other active installation binds. Records shared with other applications are never deleted.
- **Extension-field values** follow the data choice. Columns with shared lineage are never dropped.
- **Kept role assignments** are suspended until they are accepted again.
- **Blocked uninstalls:**
  - uninstalling a steward-protected application (IAM) is refused;
  - uninstalling a module is refused while an active installation depends on it.

## Decision 9 — An immutable runtime bundle per installation revision

**What the bundle is:**
- Prepare builds one runtime bundle per installation revision. It holds compiled pages and navigation, compiled flows, theme tokens, component registry entries and the access plan. The compiled flow plans of Amendment A are built from the release and cached with it, never stored.
- The access plan holds the declared permission requirements only. It holds no decisions.
- The bundle is an index plus parts of under 1 MB each, stored in Postgres.

**How it is keyed and read:**
- Bundle keys are immutable: (organisation, installation, revision, bundle-format version). A format mismatch triggers a rebuild.
- Each request reads the installation's active revision inside its request-context transaction, then reads the bundle by its immutable key. There is no invalidation step, because a new revision is simply a new key.
- A request that names a stale revision gets a reload outcome.

**Caching:**
- Servers keep bundle parts in a memory cache bounded by bytes. The Vercel runtime cache tier is optional.
- Custom component bundles are served from immutable, content-addressed URLs with long cache lifetimes.
- Permission decisions are never cached across people.
- Query results keep using the Access-version-keyed cache (#39), except queries that use read-time fields (Decision 4).

## Decision 10 — Agents build applications through the same operations

Every builder operation is one typed operation, shared by the App Designer, the API and MCP (#715 and the agent-building issues). The operations cover:
- creating and changing modules, fields, relationships, pages, component placements, flows and role templates;
- uploading component bundles;
- validating, and running a flow in test mode;
- previewing;
- installing into a **preview installation**:
  - it compiles the draft into an ephemeral candidate, never a release;
  - its record types get fresh preview storage identities;
  - durable tasks are simulated, and nothing is registered in Kestra;
  - only the previewing person and their agent can use it;
  - expiry removes its storage, records and registrations;
- publishing, installing, upgrading and uninstalling.

Each operation is permission-checked (Decision 11) and revision-checked. It returns located validation errors, so an agent can iterate: change, validate, preview, publish, install.

An MCP grant must include explicit build and install scopes. Installing custom code or accepting role templates also requires the person's recent authentication.

There is no agent-only path. Every definition an agent produces follows the same primitives, permissions and validation as one built in the designer.

## Decision 11 — Building, installing and system applications are permission-gated

**The new permissions.** Platform permission catalogue 1.4.0 adds:
- `platform.organization.definition_drafts.manage` — change module and application drafts;
- `platform.organization.definition_releases.manage` — publish releases;
- `platform.organization.custom_code.manage` — needed in addition to `platform.organization.applications.manage` to install, upgrade or uninstall packages that bundle custom components or scripts;
- `platform.organization.system_applications.manage` — needed to change system applications.

The existing `platform.organization.applications.manage` covers install, upgrade and uninstall.

**Approvals and the one fixed rule.** Who must approve a grant is decided by the organisation's approval workflow in Kestra (Decision 7, #1051). The organisation configures that workflow, and makes it mandatory with the required-caller policy (#1053).

One rule is not configurable: the grant operation itself refuses any role or role template that contains a permission outside the actor's own delegated scope (04). This holds whatever the workflow says, because workflows are editable definitions. Without it, a person who can edit a workflow could remove its approval step and grant themselves anything.

Changing an operation's required-caller policy is itself a protected access-administration operation.

**Who holds them.** Ordinary organisation administrators do not hold these permissions unless a role grants them.

**System applications** (IAM, Organisation Administration, Tenant Administration, the Landing Zone):
- They are platform packages, installed when an organisation is created.
- They cannot be uninstalled.
- Their protected operations and operation bindings stay platform-owned.
- People holding `system_applications.manage` customise them through extension fields, theme, navigation and their own dependent applications, or through an organisation-owned customised copy (#1058). A customised copy replaces the system application's installation and never exists alongside it. It cannot add, remove or retarget protected-operation bindings, and it receives platform fixes through compare-and-merge (#721).
- Platform upgrades never overwrite customisations.
- The organisation always keeps a working way for its steward to manage access.

## Decision 12 — shadcn/ui on Base UI is the component base

Owner decision, 26 September 2026.

- **Base.** Vortex interface primitives are [shadcn/ui](https://ui.shadcn.com) components initialised with Base UI primitives (`shadcn init --base base`, a `base-*` style), not Radix. They are styled with Tailwind CSS v4 and live as source in the shared `ui` workspace package, which `apps/web` and `studio` consume. The CLI's `--monorepo` layout is followed: one `components.json` per workspace, one shared `globals.css`.
- **Theme.** The existing theme engine (Decision 6) stays the only source of design values. A theme bridge maps its resolved tokens to the shadcn CSS variables (`--background`, `--foreground`, `--primary`, `--ring`, `--radius` and the rest, light and dark). Contrast and focus checks still run on the Vortex tokens. No component hard-codes a colour, radius or spacing value.
- **Theme catalogue.** Every option offered by [shadcn/create](https://ui.shadcn.com/create) at the pinned shadcn version is imported into the platform theme catalogue: visual style (Vega, Nova, Maia, Lyra, Mira, Luma, Sera, Rhea and any later style), base colour, theme colour, chart colour, heading font, body font, icon library, radius, menu and menu accent. An application theme selects one value per dimension and may override individual tokens. A shadcn preset code or preset URL can be imported into those selections. The versioned catalogue snapshot is used at runtime without fetching registry data; the default Inter face is loaded locally with `next/font`, and other font tokens retain their declared family with a system fallback.
- **Styles at run time.** In the Base UI registry, components carry `cn-*` classes. The web app loads one shared component stylesheet, while each application root carries its resolved CSS variables and visual style attribute. Colour, type, chart, radius, menu and style spacing values come from that application's definition; an application change does not replace a shared stylesheet.
- **Scope.** Registered platform blocks keep their definition contracts, settings, events and permission behaviour. Only their rendering moves to shadcn components. Application definitions, flows and access rules do not change.
- **Composition.** The Records table (Decision 5) uses the shadcn Table, Checkbox, Dropdown Menu and Pagination parts for presentation; its data, sorting, filtering, actions and states stay configured inputs. Forms use the shadcn Field, Input, Select, Combobox, Checkbox, Switch, Radio Group, Textarea, Calendar and Popover parts. Overlays use Dialog, Sheet and Drawer.
- **Designers.** The flow designer's conditions editor uses react-querybuilder's shadcn compatibility layer on the same Base UI components.
- **Custom components.** Package custom components (Decision 7) may use the same `ui` package through the sandbox bootstrap, but never receive Vortex credentials.
- **Migration.** Each existing bespoke control, display, layout, navigation and launcher component is replaced in bounded issues. The old CSS classes and style modules are deleted once nothing references them.

## Placement

| Before the Phase 6 milestone | After Phase 6 |
| --- | --- |
| Flow contract, registry, compiler, validator and conversions (#976). Protected-operation executor (#989). Server and browser flow runners (#579, #1013, #1014). Read-time computed fields (#994, #995). Records table (#1002–#1005). Theme fix (#1000, #1001). | System modules (#1025). Access operations and approvals as Kestra flows (#1051). One record-change path (#1059). Scalable lists (#1079). Runnable Kestra flows with safe compilation (#1085). Packages, custom components, clean uninstall, runtime bundle and agent building (package issues). The application Kestra instance holds only the callback key, and scripts install only through Vortex super administrators. |
