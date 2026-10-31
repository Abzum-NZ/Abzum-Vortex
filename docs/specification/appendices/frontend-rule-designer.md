# Frontend flow design and execution

[Specification index](../README.md) · [Forms, actions, rules and events](../08-forms-actions-rules-and-events.md) · [Page builder](page-builder-contracts.md) · [Architecture decisions](../../build-plan/architecture-decisions.md)

## One flow language

Every configurable behaviour is a **flow**: a stored definition inside the release of the module or
application that owns it, authored and executed in one language. Save rules, named actions, screen
behaviour and after-save work are all flows; there is no separate rule graph, workflow node graph or
pipeline language.

Publication compiles each flow once per release into one **flow plan** of page segments, server
segments and back-end steps, cached with the installation's runtime bundle and never stored. The page
runner (`packages/ui/src/flow-runtime`) runs page segments in the browser and calls the server once per
server segment through `/api/flows/invoke`; each server segment is one gated request and one
transaction. Back-end steps run through the `simulated` back-end adapter after the calling segment
commits. One task registry declares every step type, its effect class and where it runs.

## Flow shape

| Field | Meaning |
| --- | --- |
| `id`, `key` | Permanent identity and readable key. |
| `namespace` | Derived from the owning module or application; never authored. |
| `description`, `labels` | Text for builders. Labels are for search and diagnostics only. |
| `execution` | `interactive`, `transaction` or `background`. |
| `runAs` | `initiator` or `saver`. A step never overrides it. |
| `inputs`, `variables` | Typed with the one Vortex value-type catalogue. |
| `triggers[]` | `BeforeSave` or `Event`. Every other start is a binding. |
| `steps` | The ordered step list, with control steps for branches, iteration and order. |
| `outputs` | Typed results returned to the caller. |
| `errors`, `finally` | Steps that run on failure and always. |
| `retry`, `timeout`, `concurrency` | Policies resolved from the closed task defaults. |

A flow is executed by the one interpreter. `interactive` flows run in the page; a `transaction` flow
runs inside one record save; a `background` flow runs after the request commits. A `transaction` flow
may use only pure steps, reads under the saver's authority and changes to the record being saved.

## Pages compose flows; bindings define actions

A flow holds behaviour; a page holds composition. A component placement binds each semantic event it
raises to exactly one flow: the exact flow id plus a typed input map, a condition, a debounce, a
concurrency rule, an exclusive scope and a timeout. A button, menu command, record gesture, form
commit or page-model tool call starts its bound flow. No component contains hidden save logic or a
second action path.

An **action** is a flow a person or agent starts through a binding. A **named action** is a
declaration plus exactly one `transaction` flow of its Module (or one protected operation); it is not a
task list. The flow's record steps compile into one apply-record-changes call.

## Configure a component without leaving the App Builder

Selecting a placement opens its inspector: settings, visibility conditions, and its event bindings.
Choosing a flow offers compatible existing flows and a quick one-step flow where the intent is
unambiguous (Save form, Show message, Navigate). A custom flow opens in the shared step editor.
Keyboard submission, record gestures and page-model tool calls invoke the same binding; they never
create a second save or action path.

## Component data flows

Components receive runtime data only through their declared settings and bindings:

- a query binding with declared inputs for lists, boards, calendars, summaries, choices and related
  records;
- page values and record context resolved from the page address and current record;
- typed outputs from a flow step, returned to the component that started it.

Data is read through the Query engine under the viewer's current access and field policy. A component
never fetches a table directly, and a flow never bypasses the Query engine for a read.

## Formulas

Formulas are a typed JSON expression tree over a closed operator catalogue, never text evaluated as
code:

- exact decimal and money arithmetic with declared precision and rounding;
- comparison and boolean logic, and conditionals;
- text join;
- date offset and difference;
- `now`, allowed only in read-time computed fields and interactive or background flows.

There are no user-defined functions, loops or undeclared reads. One evaluator is shared by the page and
the server. A value that depends on the current time is a read-time computed field: computed whenever
read, never stored, and queries that use it bypass the data-result cache.

## Run as

A flow fixes `runAs` for its whole execution:

- `initiator` runs as the person who started the flow; an agent acts as its person.
- `saver` runs a `transaction` flow as the person whose save triggered it.

Access is rechecked before every protected step. A step cannot select another actor, and no
service-role credential or caller-supplied identifier supplies authority.

## Custom forms and all-or-nothing submission

A form commits through one typed flow binding. A guided form may collect several answers through
private form drafts and then run one bounded record change, or it may explicitly sequence several
protected operations. Each protected operation revalidates its own path, inputs, current authority and
revisions and commits atomically; a later refusal does not undo an earlier commit. Collect-first is an
authoring choice for the cases where no business change should occur until every answer passes. No
database transaction stays open while waiting for a person.

## Limits

- A flow holds at most 100 steps, nested no deeper than five levels.
- One run has at most 25 protected operations and 10 seconds of server time; a task-output path may add
  at most five named fields.
- A **For each** over record steps runs at most 200 items in one set-based change; other iteration is
  limited to 100 items.
- **Run flow** nesting is at most 3, and publication refuses cycles between flows.
- An exclusive binding declares a timeout; `latest_wins` is allowed only on a binding whose plan
  changes no data.

## Ownership and permissions

A flow belongs to exactly one module or application release. A named action declares its invocation
permission and precondition; its record steps are checked by the one record writer for current access,
field permissions, pipeline transitions, action-only fields, revisions and before-save rules. An
application role grants only the permissions its exact published template declares. A flow's
permission never widens because a page or an agent offers it.

## Designer

Studio's Frontend Rule Designer authors flows in the same page builder: conditions on the closed typed
vocabulary, typed value constructors, the shared step editors for every execution kind, and a test run
against the preview copy using the real runtime. Only the back end is simulated. Position on the
canvas is presentation; the ordered step list is the definition.
