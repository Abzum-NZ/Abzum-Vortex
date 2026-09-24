# Architecture decisions — flows, applications, packages and caching (25 September 2026)

**Status:** Approved direction from the product owner on 24–25 September 2026. These decisions supersede conflicting text in the specification until the named sections are rewritten. Each decision names the issues that implement it.

**Goal:** Vortex is an application builder in which everything a customer uses — including Vortex's own administration, identity and access applications — is a definition rendered or executed by generic engines. A person with the right platform permissions, or an agent acting for them through the API or MCP, can create, change, install and uninstall a complete application without code changes or redeployment.

**Evidence:** the [architecture review of 21 September](architecture-review-2026-09-21.md) and the five-part modularisation review of 24–25 September against main `05a2bdf`. The issues are #976–#1104 and the package issues added with this document.

## Summary

| # | Decision | In one sentence |
| --- | --- | --- |
| 1 | One flow definition, one Vortex flow engine, Kestra for durable work | Every behaviour is a stored flow definition shaped like a Kestra flow; our own flow engine runs it first, and hands long-running work to Kestra. |
| 2 | Saving is a flow around one atomic operation | The default Save is an editable one-task flow; every record change goes through one protected "apply record changes" operation. |
| 3 | Save rules run where they cannot be bypassed | Rules that must always hold run inside the save transaction for every caller; the browser runs the same rule only to give instant feedback. |
| 4 | Time-dependent values are read-time computed fields | Values such as "overdue" are computed by the record and query engines whenever they are read, never stored. |
| 5 | One configurable Records table component | Lists are one component whose data, columns, sorting, filters, actions and states are all configured inputs. |
| 6 | The theme engine exists | The delivered theme engine has a naming defect to fix; no second theme engine is built. |
| 7 | Applications are packages; custom logic follows a ladder | Configuration first; custom UI components run sandboxed in the browser; custom backend code runs only in isolated Kestra script tasks. |
| 8 | Clean install, upgrade and uninstall, with an immutable runtime cache | Installation registers everything an application needs; uninstall removes every registration; compiled installations are cached by identity. |
| 9 | Agents build applications through the same operations | Every builder operation is one typed, permission-checked operation used by the designer, the API and MCP. |
| 10 | Building and installing are permission-gated | Only roles holding the builder and installer permissions can change or install definitions, so system applications can be customisable without being locked. |

## Decision 1 — One flow definition, one Vortex flow engine, Kestra for durable work

### The flow definition

A flow is stored data inside the release of the module or application that owns it. It is never code. Its shape follows the Kestra flow definition, so the part of a flow that must run durably compiles directly to a Kestra flow.

| Field | Meaning |
| --- | --- |
| `id`, `key` | Permanent identity and readable key. |
| `namespace` | Derived from the owning module or application; never authored. |
| `description`, `labels` | Text shown to builders; labels are for search and diagnostics only. |
| `execution` | `interactive` (started by a person or agent and answered within the request), `transaction` (runs inside one record-save transaction) or `durable` (runs on Kestra). |
| `runAs` | Whose authority each protected task uses: the initiating person by default; a specified account or System only through the scoped execution grants (#322, #541). |
| `inputs`, `variables` | Typed with the one Vortex value-type catalogue (#982). |
| `triggers[]` | What starts the flow: Action (button, menu, row action, agent tool), FormSubmit, Component event, BeforeSave, Event (after a committed record change), Schedule, IncomingMessage, Interface operation, Invoked (called by another flow). |
| `tasks[]` | An ordered, nested list. Control tasks: If, Switch, ForEach, Sequential, Parallel (durable only), Run flow, Wait for a person, Wait until, Stop. All other tasks come from the task registry. |
| `outputs` | Typed results returned to the caller. |
| `errors`, `finally` | Tasks that run on failure and always. The default error handler shows refused, validation, conflict and uncertain outcomes safely. |
| `retry`, `timeout`, `concurrency` | Policies; retries and long timeouts are allowed only for durable tasks. |

References use a closed syntax: `{{ inputs.x }}`, `{{ vars.x }}`, `{{ trigger.record.field }}`, `{{ trigger.previous.field }}`, `{{ outputs.task.key }}`, `{{ execution.actor }}` and `{{ execution.now }}`. There are no functions, filters or code in references. Calculations use the Calculate task with the shared formula syntax used by computed fields (Decision 4).

### The task registry

Every task type is registered once (#983) with:

- its version;
- where it may run: `browser`, `server` (a protected operation in its own short transaction), `transaction` (only inside the owning record save) and `durable` (Kestra);
- its effect class (pure, read, change, background start, interface);
- its typed properties, outputs and outcomes, and its default policy;
- how it compiles to Kestra: as a native control task, or as one generic protected callback.

Publication refuses a flow that places a task where it cannot run. Work moves between execution kinds only through an explicit Run flow or Run background flow task, so every commit boundary is visible.

### The Vortex flow engine

The flow engine is built in-house and is part of the application:

- a pure interpreter in `runtime/rule`, shared by browser and server;
- a server orchestrator in `runtime/app`, which runs protected tasks through the one protected-operation executor (#989);
- a browser runner in `ui`, which runs interface tasks such as show message, navigate, refresh, open panel and set filter (#1013).

It runs `interactive` and `transaction` flows. It does not persist long-running state; anything that waits, retries over time or needs a person's later response is durable work for Kestra.

**Options considered and rejected:**

| Option | Why it does not fit |
| --- | --- |
| Vercel Workflow SDK (`workflow`, workflow-sdk.dev) | Workflows are TypeScript functions compiled at build time (`"use workflow"`, `"use step"`). There are no stored definitions that a designer or agent can create at run time. Steps run asynchronously across requests, which adds delay to every button click. It is a durable engine, so it would duplicate Kestra. Using it only to host a generic interpreter adds a dependency without removing any work. |
| Conductor OSS JavaScript SDK | It is a client for a separately run Conductor server, so it duplicates Kestra and does not run inside the application. |
| Hand-built drag-and-drop graph builders (React Flow with free node-and-edge JSON) | The canvas library is right, and the designer already uses xyflow/React Flow (#633). Free node-and-edge graphs are what this decision replaces: the canvas edits the structured task list, like Kestra's topology view. |

### One start path

1. A trigger starts a flow in the Vortex flow engine. Web controls, agent tool calls and interface operations use the same entry point (#1014, #1097).
2. Browser tasks run in the page. Protected tasks run on the server, one short transaction each, with the current access decision. Transaction tasks run only inside the record save.
3. A **Run background flow** task commits a start intent with typed inputs, and the start is dispatched to Kestra (#666, #667, #1088). Kestra runs waits, human tasks, schedules, retries and external calls. It calls back into Vortex only for protected operations (#664).
4. Record events, schedules and verified incoming messages start the Vortex flow engine in server mode. That flow may hand off to Kestra at once.

### Performance

- Interactive flows run synchronously in the request.
- Compiled flows are part of the cached installed runtime bundle (Decision 8), so starting a flow reads no definition from the database.
- A queue hop happens only at a Run background flow task.

## Decision 2 — Saving is a flow around one atomic operation

- The default Save of a form is a generated flow with one task, `record.save`. A builder with the builder permission can add tasks before it (look up values, calculate, ask for confirmation, validate) and after it (show a message, navigate, run a background flow).
- `record.save`, `record.create`, `record.setFields`, `record.link`, `record.delete`, `record.restore` and the other record tasks all call one protected operation: **apply record changes** (#1060–#1065). One call is one transaction. It covers:
  - the access decision for each touched record;
  - revision checks;
  - before-save rules (Decision 3) and computed values;
  - one receipt for duplicate protection;
  - one Activity writer and one event writer.
- A flow cannot split or bypass this operation. Several record tasks that must succeed or fail together are one `record.changes` task.
- A named action is a `transaction` flow with an Invoked trigger. Its record changes compile into one apply-record-changes call (#1062, #1063).

## Decision 3 — Save rules run where they cannot be bypassed

- A rule that must always hold (a required value, an allowed status change, "a resolved case needs a resolution time") is a flow with a `BeforeSave` trigger and `transaction` execution.
- The server runs it inside the save transaction for every writer: web, agent, interface, import and Kestra. Its refusals, requirements and warnings are authoritative. This integration exists since #578; its definition moves to the flow format under #976.
- The browser runs the same definition while a person edits, to show feedback at once. Browser results are never trusted.
- Work that should happen after a change (notify someone, create a follow-up, synchronise another system) is a flow with an `Event` trigger, run after the commit. Long-running reactions hand off to Kestra.

## Decision 4 — Time-dependent values are read-time computed fields

- A value derived from other fields and the current time is a **read-time computed field**. Examples: overdue, age in days, days remaining.
- The record and query engines compute it whenever a record is read: lists, detail, filters, sorting, API, MCP and flows all see the same value. It is never stored.
- A stored calculated field remains the right choice for a value that does not depend on time and that totals must use.
- A component never computes a business value. It only displays what the engines return, so every screen, list, filter and agent agrees.
- Formulas use the same syntax as flow calculations.
- Implemented by #994 and #995. The deadline worker and due metadata are retired by #1067, and escalations become scheduled Kestra flows (#1092).

## Decision 5 — One configurable Records table component

The Records table is a registered component. Every behaviour is a configured input:

- **Data source:** a record type or a declared query, with fixed parameters or parameters taken from the page.
- **Columns:** field references with format, width, alignment and a responsive priority that says which columns hide first on small screens.
- **Sorting:** the default sort and the fields a person may sort by. **Filters:** the fields a person may filter by, a search box and saved views.
- **Paging:** the page size.
- **Selection:** none, single or multiple.
- **Row behaviour:** what a row click does (open the record page, open a panel or run a flow), plus row actions, bulk actions and inline edit, each bound to a flow.
- **Messages:** the empty, refused and error messages.

The Query engine enforces access, withheld fields, paging and totals. The component never fetches data itself.

Board, calendar and summary are separate components with the same data-source contract (#871). Implemented by #1002–#1005 and #583–#585.

## Decision 6 — The theme engine exists

- #71, #594 and #595 delivered the theme engine: a platform theme release, application overrides, contrast and focus checks, and CSS variables.
- The defect found on 24 September is that the renderer reads different token names from the platform theme. #1000 and #1001 fix it.
- No second theme engine is built.

## Decision 7 — Applications are packages; custom logic follows a ladder

### The application package

An application package is the unit of installation, upgrade, uninstall and distribution. It contains exact immutable releases of:

- the application: pages, navigation, theme, flows, forms and components placed;
- the modules it requires: record types, fields, relationships, rules and actions;
- its role templates and permission declarations;
- its agent tool bundle (derived at publication, #865);
- its assets;
- any custom components it bundles.

A package never contains records, accounts, secrets, sessions or live grants. The package manifest is signed and states what installation will require. The detailed contract is in the [application packages appendix](../specification/appendices/application-packages.md).

### The custom-logic ladder

Use the first level that meets the need.

1. **Configuration.** Flows with registered tasks and formulas, with reference data kept as ordinary records (for example a price list).
2. **Custom UI component.** A package may include browser components, for example a 3D canopy diagram. A custom component:
   - declares the same contract as a built-in component: properties, events, data contract and state operations;
   - is rendered by the generic renderer inside a sandboxed iframe on a separate origin, with a strict Content Security Policy;
   - never receives Vortex cookies, sessions or tokens;
   - can reach only its declared asset hosts;
   - exchanges data only through a typed message bridge: properties in, events out.

   The App Designer shows it in the palette for applications that install the package, next to the generic components. Its events start flows like any other component event.
3. **Custom backend code.** Allowed only as a Kestra script task that runs in an isolated container, inside a background flow. It has declared inputs and outputs and no database credentials, and it writes results back only through protected operations.

No customer code runs on Vortex servers or in the Vortex browser origin.

### Example: a canopy quote page

| Part | Built with |
| --- | --- |
| Quote, Canopy option and Price list records | A module |
| Quote calculator page | Application pages composed of generic components and the custom canopy component |
| Area, material and price calculation | An interactive flow with Calculate tasks that read the price-list records |
| 3D canopy diagram | A custom UI component: it receives the dimensions as properties and emits a "shape changed" event that runs the recalculation flow |
| Save quote | The default Save flow (`record.save`) |
| Send quote | A Run background flow task; the Kestra flow renders the PDF, emails it and waits for acceptance |

## Decision 8 — Clean install, upgrade and uninstall, with an immutable runtime cache

### Install

Installation has two steps: prepare, then activate atomically. It extends #598 and #662, and the package lifecycle #722–#724.

**Prepare:**
- check the package signature, the permissions it needs and the installer's permissions, including the custom-code permission when the package bundles custom components or scripts;
- provision module storage;
- compile the durable flows and register them in Kestra as inactive;
- upload custom component bundles to immutable storage;
- present role templates for acceptance;
- build the installed runtime bundle.

**Activate:** switch the installation to the new release set in one step, then:
- enable Kestra triggers and schedules;
- publish the tool bundle;
- make the navigation and launcher entries visible.

A failed preparation leaves the previous installation active.

### Upgrade

Prepare the new release set, then activate it in one step. The previous release set stays active if anything fails. This already exists as #598.

### Uninstall

1. **Deactivate in one step:**
   - refuse new flow starts;
   - disable Kestra triggers and schedules;
   - withdraw the tool bundle;
   - remove navigation and launcher entries.
2. **Remove every registration:**
   - delete the installation's Kestra flows and namespace;
   - end or keep role-template assignments as the uninstaller chooses;
   - delete custom component bundles that no other installation uses;
   - delete the cached runtime bundles.
3. **Handle the data** as the uninstaller chooses:
   - keep it detached and restorable;
   - export it, then delete it;
   - or delete it after the retention grace period.

   A legal hold always blocks deletion (#117).
4. **Produce an uninstall report** listing everything removed and everything kept.

No registration may outlive its installation.

### Caching

Releases are immutable, so they are cached by identity:

- **The installed runtime bundle.** At activation, the platform builds one bundle per installation revision. It contains:
  - compiled pages and navigation;
  - compiled flows and trigger index;
  - theme tokens and component registry entries;
  - the access plan (#996);
  - the tool bundle.

  The bundle is stored in Postgres. Servers keep it in memory and in the Next.js/Vercel runtime cache, keyed by installation revision. The only invalidation is a change of the installation's active revision.
- **Custom component bundles** are served from immutable, content-addressed URLs (Supabase Storage behind a CDN) with long cache lifetimes.
- **Permission decisions** are never cached across people. Query results keep using the Access-version-keyed cache (#39). There is no separate "Supabase cache" product: Postgres holds the durable copy, and the runtime cache holds the hot copy.

## Decision 9 — Agents build applications through the same operations

- Every builder operation is one typed operation. That covers creating and changing modules, fields, relationships, pages, component placements, flows, role templates and packages, and validating, previewing, publishing, installing, upgrading and uninstalling.
- Each operation is:
  - the same for the App Designer, the API and MCP (authoring tools, #715);
  - checked against the builder and installer permissions;
  - revision-checked;
  - answered with located validation errors, so an agent can iterate: change the draft, validate, preview, publish, install.
- There is no agent-only path.
- Every definition an agent produces follows the same primitives, permissions and validation as one built in the designer.

## Decision 10 — Building and installing are permission-gated

- These are separate platform permissions:
  - `platform.application.author`: change module and application drafts;
  - `platform.application.publish`;
  - `platform.application.install`: install, upgrade and uninstall;
  - `platform.application.install_custom_code`: install a package that bundles custom components or scripts.
- Ordinary organisation administrators do not hold them unless a role grants them.
- System applications (IAM, Organisation Administration, Tenant Administration, the Landing Zone) are therefore customisable by the people trusted to build, and every security rule stays inside the protected operations those applications call.

## Placement

| Before the Phase 6 milestone | After Phase 6 |
| --- | --- |
| Flow contract, registry, compiler, validator and conversions (#976). Protected-operation executor (#989). Server and browser flow runners (#579, #1013, #1014). Read-time computed fields (#994, #995). Records table data contract (#1002–#1005). Theme fix (#1000, #1001). | System modules (#1025). Access operations and approvals as Kestra flows (#1051). One record-change path (#1059). Scalable lists (#1079). Runnable Kestra flows (#1085). Application packages, custom components, clean uninstall, runtime cache and MCP authoring (the package scope created with this document). |
