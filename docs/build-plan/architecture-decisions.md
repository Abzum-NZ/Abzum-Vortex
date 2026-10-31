# Architecture decisions — flows, applications, packages and caching (ADR #1127)

These are the current architecture decisions behind Vortex's flows, applications, packages and
runtime caching. The [target architecture](target-architecture.md) is binding and wins where these
decisions differ. The repository history is the revision record.

**Goal:** Vortex is an application builder in which everything a customer uses is a definition that
generic engines render or execute. This includes Vortex's own administration, identity and access
applications. A person with the right permissions, or an agent acting for them through the page model,
can create, change, install and uninstall a complete application without code changes or
redeployment.

## Summary

| # | Decision | In one sentence |
| --- | --- | --- |
| 1 | One flow definition, one in-house flow engine | A stored Kestra-shaped flow definition is compiled into a flow plan and run by the in-house engine: one page runner, gated server segments, and a simulated back end. |
| 2 | Saving is a flow around one atomic operation | The default Save is an editable flow, and every record change goes through one protected apply-record-changes operation that enforces every record rule. |
| 3 | Save rules run where they cannot be bypassed | Rules that must always hold run inside the save transaction for every caller. Page rule steps are feedback only. |
| 4 | Formulas and read-time computed fields | Calculations use one typed formula tree. Values that depend on the current time are computed whenever they are read and are never stored. |
| 5 | One configurable Records table component | Lists are one component whose data, columns, sorting, filters, actions and states are all configured inputs. |
| 6 | The theme engine exists | The delivered theme engine is the only source of design values. No second theme engine is built. |
| 7 | Applications are delivered as packages, and custom logic follows a ladder | Configuration comes first. Custom UI components run in a sandbox in the browser. Custom backend scripts are installed only by Vortex super administrators. |
| 8 | Clean install, upgrade and uninstall | Each service records what it registers for an installation, uninstall removes everything recorded, and the report proves it. |
| 9 | An immutable runtime bundle per installation revision | Compiled installations are cached by an immutable key, so opening a page reads no definition. |
| 10 | Agents build applications through the same operations | Every builder operation is one typed, permission-checked operation used by the designer and by agents through the page model, including preview installation. |
| 11 | Building, installing and system applications are permission-gated | Only roles with the builder permissions can change definitions. System applications are customisable by them, but cannot be uninstalled. |
| 12 | shadcn/ui on Base UI is the component base | Every Vortex interface primitive is a shadcn/ui component built on Base UI, styled with Tailwind CSS and themed by the Vortex theme engine. |

## Decision 1 — One flow definition, one in-house flow engine

A flow is stored data inside the release of the module or application that owns it. It is never
code. Its shape follows the Kestra flow definition, and the in-house engine runs it entirely; Kestra
is the operations scheduler for two platform routes and runs no application flow.

**The engine.** A published release is compiled once into a **flow plan** of page segments (page
steps), server segments (server steps, each one gated request and one transaction) and back-end
steps, with the path guard that reaches each server segment. The plan is cached with the
installation's runtime bundle and never stored. The chain is:

1. the task **registry** declares every step type, where it runs and its effect class;
2. **compilation** turns the stored flow into the one flow plan per release;
3. the **page runner** (`packages/ui/src/flow-runtime`) runs page segments in the browser and calls
   the server once per server segment;
4. the server segment runs behind one admission gate through `/api/flows/invoke` (and
   `/api/flows/invoke/webmcp` for the page-model channel);
5. every record change, at the end of a segment, goes through `apply_record_changes`.

**The back end.** `backend.run` (modes `await` and `start`) runs a child flow through the back-end
adapter. The `simulated` adapter is the only adapter; the child runs in its own transaction after the
calling segment commits. There is no second back-end path.

**The flow definition.**

| Field | Meaning |
| --- | --- |
| `id`, `key` | Permanent identity and readable key. |
| `namespace` | Derived from the owning module or application; never authored. |
| `description`, `labels` | Text for builders. Labels are for search and diagnostics only. |
| `execution` | One of: `interactive`, started by a person or an agent through a binding and answered within the request; `transaction`, which runs inside one record-save transaction; `background`, a server run after a commit, started by the event dispatcher or a verified event. |
| `runAs` | Whose authority each protected step uses: `initiator` or `saver`. Access is rechecked before every protected step. |
| `inputs`, `variables` | Typed with the one Vortex value-type catalogue. |
| `triggers[]` | Only the automatic starts: `BeforeSave` and `Event` (after a committed record change). |
| `tasks[]` | An ordered, nested list. Control tasks: If, Switch, ForEach, Sequential, Run flow, Stop. Every other task comes from the task registry. |
| `outputs` | Typed results returned to the caller. |
| `errors`, `finally` | Tasks that run on failure and always. The default error handler shows refused, validation, conflict and uncertain outcomes safely. |
| `retry`, `timeout`, `concurrency` | Policies. |

Starts made by people and systems are **bindings**, not triggers. A component placement, navigation
item, interface operation, agent tool or parent flow holds a binding: the flow id plus a typed input
map. Pages never hold flow logic of their own.

**References** use a closed syntax: `{{ inputs.x }}`, `{{ vars.x }}`, `{{ trigger.record.field }}`,
`{{ trigger.previous.field }}`, `{{ outputs.task.key }}`, `{{ execution.actor }}` and
`{{ execution.now }}`. The compiler resolves every reference to a typed reference. No text is ever
evaluated as a template.

**Formulas** (Calculate steps, conditions and computed fields) are a typed JSON expression tree over
a closed operator catalogue: exact decimal and money arithmetic with declared precision and rounding;
comparison and boolean logic; conditionals; text join; date offset and difference; and `now`, which is
allowed only in read-time computed fields and interactive or background flows. There are no
user-defined functions, loops or undeclared reads. One evaluator is shared by the page and the server.

**Limits** for one run: at most 100 ForEach items, 25 protected operations, 10 seconds of server time
and a Run flow depth of 3. Cycles between flows are refused at publication. Transaction flows may use
only pure steps, reads under the saver's authority, and changes to the record being saved.

**Contract 4.3.0.** One `definitionContractVersion` constant and one `assertDefinitionContractPair`
govern applications, modules and record types, source and validation. The contract holds only what
the engine runs. Choice options carry an optional tone from the `PipelineStageTone` vocabulary
(`neutral`, `primary`, `destructive`, `chart_1` to `chart_5`); pipeline stages carry no tone. The
Group terminology is used throughout: the `CurrentPersonPart` value is `group`, the refusal code is
`current_group_ambiguous` and the shared-property label is `Group`. The published flow answer type is
`FormAnswer`. Stored definitions live under one contract version; no earlier version is accepted.

**Segment trust rules.**

1. A value returned by one segment and sent to the next through the page is a caller input: the server
   re-validates it by type and access and never trusts it as its own output.
2. A guard over page-only values (a page value, a confirmation answer) proves consistency, not
   authority. Studio warns when a refusing rule exists only in the page.
3. The browser plan holds only page steps and segment stubs (id, input and output types, labels): no
   operation inputs, server-step properties or secrets.
4. Admission refusals stay neutral (`refused`, no detail); business refusals (BeforeSave, an option no
   longer allowed) carry their reason.
5. The idempotency key is (gesture or form-instance id, segment id, iteration path), shared by people
   and agents. A form's gesture id is its form-instance submission id, minted when the form opens.
6. Each server segment carries a fingerprint of its compiled server steps and its input and output
   types. The gate admits a segment whose fingerprint is unchanged in the current release, so
   publishing does not refuse every open form.

## Decision 2 — Saving is a flow around one atomic operation

- **The default Save** of a form is a generated flow with one `record.save` step. A builder with the
  builder permission can add steps before it (look up values, calculate, confirm, validate) and after
  it (show a message, navigate, run a back-end flow).
- **Every record step calls one protected operation, apply record changes.** One call is one
  transaction. The record steps are `record.save`, `record.create`, `record.set_fields`,
  `record.link`, `record.delete`, `record.restore` and `record.changes`. For every call the operation
  enforces the access decision for each touched record, field permissions, pipeline transitions and
  gates, action-only fields, revision checks, before-save rules, and read-time and stored computed
  values. It also keeps one receipt for duplicate protection, and one Activity writer and one event
  writer.
- **A flow cannot split or bypass this operation.** Record changes that must succeed or fail together
  are one `record.changes` step.
- **A named action** is a declaration plus exactly one Module `transaction` flow, started through its
  binding; its record changes compile into one apply-record-changes call. There is no task list on the
  action declaration.

## Decision 3 — Save rules run where they cannot be bypassed

- A rule that must always hold is a flow with a `BeforeSave` trigger and `transaction` execution.
  Examples: a required value, an allowed status change, "a resolved case needs a resolution time".
- The rules of a record type run in its ordered rule list, inside the save transaction, for every
  writer: page, agent, interface and import. Their refusals, requirements and warnings are
  authoritative. There is no priority.
- The page runs page rule steps only to show feedback at once. Page results are never trusted.
- Work after a change (notify someone, create a follow-up, synchronise another system) is a flow with
  an `Event` trigger: an after-save subscriber that runs on the back end after commit.

## Decision 4 — Formulas and read-time computed fields

- **A read-time computed field** holds a value derived from other fields and the current time, such as
  overdue, age in days or days remaining. It is computed whenever a record is read, and it is never
  stored.
- **Read-time fields that are filterable or sortable** compile to SQL. That SQL uses one statement
  timestamp in the organisation's time zone.
- **Queries that use read-time fields bypass the data-result cache** (17), because their values change
  without any data change.
- **A stored calculated field** remains the right choice for a value that does not depend on time and
  that totals must use. Publication refuses a stored total over a read-time field.
- **Components never compute business values.** They display what the engines return, so every screen,
  list, filter and agent agrees.

## Decision 5 — One configurable Records table component

The Records table is a registered component. Every behaviour is a configured input:

- **data source:** a record type or a declared query, with parameters fixed or taken from the page;
- **columns:** field references with format, width, alignment and a responsive priority that says which
  columns hide first on small screens;
- **sorting:** the default sort and the fields a person may sort by;
- **filtering:** the fields a person may filter by, a search box and saved views;
- **paging:** the page size;
- **selection:** none, single or multiple;
- **row behaviour:** a row click (open the record page, open a panel or run a flow), row actions, bulk
  actions and inline edit, each held as a binding to a flow;
- **messages:** empty, refused and error.

The Records table runs its query directly through the Query engine, which enforces access, withheld
fields, paging and totals. A data flow is used only when a builder adds transform or write steps. The
component never fetches data itself.

Board, calendar and summary are separate components with the same data-source contract.

## Decision 6 — The theme engine exists

The delivered theme engine provides a platform theme release, application overrides, contrast and
focus checks, and CSS variables. It is the only source of design values. No second theme engine is
built.

## Decision 7 — Applications are delivered as packages, and custom logic follows a ladder

### The package is derived from a published application

Publishing an application derives its package: that application release plus its exact dependency
closure (module releases, flows, role templates, permission declarations, assets and custom
components). A package is not a third publishable kind. It has no draft and no version of its own, and
installation resolves nothing.

A package never contains records, accounts, secrets, sessions, drafts or live grants. Signatures are
added only when a package crosses clusters (16). Inside one cluster the immutable release fingerprints
are enough.

Every package also carries:

- **reference data:** a package may declare seed reference data (for example a price list). It is
  imported once, at first activation, as ordinary records. The import runs under a System actor scoped
  to the package's seed record types. The records pass normal validation and BeforeSave rules, and the
  import is recorded in Activity;
- **component ownership:** a custom component belongs to the application or module release that
  bundles it. Only that application, or applications that depend on that module, may place it. Any
  change to a bundle is a major version change.

### The custom-logic ladder

Use the first level that meets the need.

1. **Configuration.** Flows with registered tasks and formulas, with reference data kept as ordinary
   records.
2. **Custom UI component.** A package may bundle browser components. The detailed rules are in the
   [application packages appendix](../specification/appendices/application-packages.md). In summary, a
   custom component runs in a sandboxed frame loaded through a Vortex-owned bootstrap document on a
   dedicated domain; it has no Vortex credentials; it receives only the fields it is mapped to; and it
   talks only through one message channel. Its events are untrusted input: they start flows only
   through bindings, and a flow that changes data after such an event shows a host-rendered
   confirmation first.
3. **Custom backend scripts.** These are platform-reviewed code. Only a Vortex super administrator can
   add a script to a package and install that package, after reviewing and testing it. Customer
   builders and administrators cannot author or install scripts. A script receives only its declared
   inputs, with time and memory limits; its results reach Vortex only through a following protected
   step; and values that must be authoritative at save time use formulas.

Customer-authored code never runs on Vortex servers or in the Vortex browser origin.

## Decision 8 — Clean install, upgrade and uninstall

**Install** is one command. Its inputs are the package, the installer's confirmation of the manifest,
and the role templates the installer accepts. It has two steps.

1. **Prepare**, which leaves the previous installation active if any part fails: verify the installer's
   permissions (Decision 11); provision module storage; upload custom component bundles to immutable
   storage; build the runtime bundle (Decision 9).
2. **Activate**, which is one transaction: move the installation's active revision and increment the
   Access version. Navigation, launcher entries and agent tools follow from the active revision.

Abandoned prepared candidates are cleaned up.

**Upgrade** prepares the new release set and activates it the same way. The previous release set stays
active if anything fails.

**Uninstall** withdraws the installation in one atomic step: module bindings detach (stored records
remain) and access is withdrawn. No new work is accepted afterwards; accepted work that has not begun
is refused or cancelled with a retained status. There is no intermediate draining state.

Each owning service records the registrations it creates for an installation, and can list and remove
them. The uninstall report is the union of those lists. Uninstall is complete when nothing remains
except items the uninstaller chose to keep. The registrations covered are connection-instance grants; interface operations, public addresses and incoming-message routes;
search documents; pending outbox entries and start intents, which are marked refused; form drafts;
the default-application setting; custom
component bundles that no other installation uses; cached runtime bundles; and permission
registrations (the Access version increments).

Uninstall has these rules for data and access:

- **Deleting data** applies only to record types that no other active installation binds. Records
  shared with other applications are never deleted.
- **Extension-field values** follow the data choice. Columns with shared lineage are never dropped.
- **Kept role assignments** are suspended until they are accepted again.
- **Blocked uninstalls:** uninstalling a steward-protected application (IAM) is refused; uninstalling a
  module is refused while an active installation depends on it.

## Decision 9 — An immutable runtime bundle per installation revision

**What the bundle is:** prepare builds one runtime bundle per installation revision. It holds
compiled pages and navigation, compiled flows, theme tokens, component registry entries and the access
plan, in the sections `pages`, `navigation`, `flows`, `theme`, `component_registry` and `access_plan`.
The compiled flow plans are built from the release and cached with it, never stored. The access plan
holds the declared permission requirements only; it holds no decisions. The bundle format version is
3, and the bundle is an index plus parts of under 1 MB each, stored in Postgres.

**How it is keyed and read:** bundle keys are immutable — (organisation, installation, revision,
bundle-format version). A format mismatch triggers a rebuild. Each request reads the installation's
active revision inside its request-context transaction, then reads the bundle by its immutable key.
There is no invalidation step, because a new revision is simply a new key. A request that names a stale
revision gets a reload outcome.

**Caching:** servers keep bundle parts in a memory cache bounded by bytes. Custom component bundles are
served from immutable, content-addressed URLs with long cache lifetimes. Permission decisions are
never cached across people. Query results keep using the Access-version-keyed cache, except queries
that use read-time fields (Decision 4).

## Decision 10 — Agents build applications through the same operations

Every builder operation is one typed operation, shared by App Studio and by agents acting through the
page model. The operations cover creating and changing modules, fields, relationships, pages, component
placements, flows and role templates; uploading component bundles; validating and running a flow in
test mode; previewing; installing into a **preview installation**; and publishing, installing,
upgrading and uninstalling.

A preview installation compiles the draft into an ephemeral candidate, never a release; its record
types get fresh preview storage identities; back-end steps are simulated; only the previewing person
and their agent can use it; and expiry removes its storage, records and registrations. Expired previews
and their retired storage are cleaned by the scheduled maintenance route.

Each operation is permission-checked (Decision 11) and revision-checked. It returns located validation
errors, so an agent can iterate: change, validate, preview, publish, install. There is no agent-only
path. Every definition an agent produces follows the same primitives, permissions and validation as one
built in Studio.

## Decision 11 — Building, installing and system applications are permission-gated

Platform permission catalogue 1.4.0 adds:

- `platform.organization.definition_drafts.manage` — change module and application drafts;
- `platform.organization.definition_releases.manage` — publish releases;
- `platform.organization.custom_code.manage` — needed in addition to
  `platform.organization.applications.manage` to install, upgrade or uninstall packages that bundle
  custom components or scripts;
- `platform.organization.system_applications.manage` — needed to change system applications.

The existing `platform.organization.applications.manage` covers install, upgrade and uninstall.

One rule is not configurable: the grant operation itself refuses any role or role template that
contains a permission outside the actor's own delegated scope (04). Changing an operation's
required-caller policy is itself a protected access-administration operation.

Ordinary organisation administrators do not hold these permissions unless a role grants them.

**System applications** (IAM, Organisation Administration, Tenant Administration, the Landing Zone)
are platform packages, installed when an organisation is created. They cannot be uninstalled. Their
protected operations and operation bindings stay platform-owned. People holding
`system_applications.manage` customise them through extension fields, theme, navigation and their own
dependent applications, or through an organisation-owned customised copy. A customised copy replaces
the system application's installation and never exists alongside it. It cannot add, remove or retarget
protected-operation bindings, and it receives platform fixes through compare-and-merge. Platform
upgrades never overwrite customisations. The organisation always keeps a working way for its steward
to manage access.

## Decision 12 — shadcn/ui on Base UI is the component base

Owner decision, 26 September 2026.

- **Base.** Vortex interface primitives are [shadcn/ui](https://ui.shadcn.com) components initialised
  with Base UI primitives (`shadcn init --base base`, a `base-*` style), not Radix. They are styled with
  Tailwind CSS v4 and live as source in the shared `ui` workspace package, which `apps/web` and Studio
  consume. The CLI's `--monorepo` layout is followed: one `components.json` per workspace, one shared
  `globals.css`.
- **Theme.** The existing theme engine (Decision 6) stays the only source of design values. A theme
  bridge maps its resolved tokens to the shadcn CSS variables (`--background`, `--foreground`,
  `--primary`, `--ring`, `--radius` and the rest, light and dark). Contrast and focus checks still run
  on the Vortex tokens. No component hard-codes a colour, radius or spacing value.
- **Theme catalogue.** Every option offered by [shadcn/create](https://ui.shadcn.com/create) at the
  pinned shadcn version is imported into the platform theme catalogue: visual style, base colour, theme
  colour, chart colour, heading font, body font, icon library, radius, menu and menu accent. An
  application theme selects one value per dimension and may override individual tokens. A shadcn
  preset code or preset URL can be imported into those selections. The versioned catalogue snapshot is
  used at runtime without fetching registry data; the default Inter face is loaded locally with
  `next/font`, and other font tokens retain their declared family with a system fallback.
- **Styles at run time.** In the Base UI registry, components carry `cn-*` classes. The web app loads
  one shared component stylesheet, while each application root carries its resolved CSS variables and
  visual style attribute. Colour, type, chart, radius, menu and style spacing values come from that
  application's definition; an application change does not replace a shared stylesheet.
- **Scope.** Registered platform blocks keep their definition contracts, settings, events and
  permission behaviour. Only their rendering moves to shadcn components. Application definitions,
  flows and access rules do not change.
- **Composition.** The Records table (Decision 5) uses the shadcn Table, Checkbox, Dropdown Menu and
  Pagination parts for presentation; its data, sorting, filtering, actions and states stay configured
  inputs. Forms use the shadcn Field, Input, Select, Combobox, Checkbox, Switch, Radio Group, Textarea,
  Calendar and Popover parts. Overlays use Dialog, Sheet and Drawer.
- **Designers.** The flow designer's conditions editor uses react-querybuilder's shadcn compatibility
  layer on the same Base UI components.
- **Custom components.** Package custom components (Decision 7) may use the same `ui` package through
  the sandbox bootstrap, but never receive Vortex credentials.
- **Theme changes.** Each existing bespoke control, display, layout, navigation and launcher component
  uses the shadcn components; the old CSS classes and style modules are deleted once nothing references
  them.
