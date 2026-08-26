# The two worked examples

| File | What it is |
|---|---|
| `vortex.crm.json` | The CRM module of [Appendix A](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#appa) |
| `app.sales_hub.json` | The Sales Hub application of [Appendix B](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#appb) |

Every later phase measures itself against these. A change to a contract that breaks one of them is a
change that would have broken a real customer's module, found before anything is built on it.

Each file is a **whole definition**: the envelope of
[section 26.1](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#s26-1) around the
body, as a published revision carries it. A body on its own could not exercise the envelope contract
that [#11](https://github.com/Abzum-NZ/Abzum-Vortex/issues/11) builds.

Every name comes from the contract chapters. Nothing here is invented to fill a gap; where something
is missing it is listed below instead.

## What is deliberately absent

**The three other modules Sales Hub uses.**
[B.2](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#appb) has the application
using People and organisations, Work and tasks, and Tags and categories alongside the CRM. The
application here declares the CRM only.

Those three are the platform modules of Appendix D, and the specification describes them nowhere in
the detail a definition needs — no record types, no fields, no keys. Writing them would mean inventing
three modules and then measuring every later phase against the invention. The gap is real:
[section 29.3](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#s29-3) refuses a
publish where a module in the list is missing, so this application cannot fully resolve its references
until they exist. That is a thing to fix by writing them, not by pretending.

**Definitions that are referenced but published on their own.** The application names
`app.sales_hub.qualification`, `app.sales_hub.on_deal_won`, `conn.slack`, `conn.email_sending` and
`iface.sales_hub`. The contract says references, and references are what is written. The definitions
behind them belong to Chapters 30 and 32 and are not part of these two files.

**Two actions the pages name.** `vortex.crm.lead.convert` and `vortex.crm.lead.create_from_enquiry`
are named as `commit_action` on the guided form and the public page. The module declares no `actions`
list, because [Appendix A](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#appa)
declares none — it gives the permission to convert a lead but never the action definition. Adding one
would be invention.

**Starter data.** [B.10](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#appb)
loads starter tags from the tags and categories module, which is one of the three absent above.

## Two things that were unclear, both now settled

**Workflows and pipelines are carried, and that is now settled.** Section 26.2 said an application
*carries inside it* "its workflows, its process pipelines"; section 29.2 said it held *references* to
them. The two decided different things about whether publishing an application publishes its
pipelines in the same revision, so the specification was corrected: 29.2 now reads "list of workflow
definitions" and "list of process pipeline definitions", and 26.2 says plainly that publishing an
application publishes every page, workflow and pipeline in it, in one revision.

This file carries both, written from B.7 and B.8.

**`vortex.crm.deal.mark_won` guards the `closed_won` option, and that is the mechanism rather than a
substitute for one.** Appendix A gives the permission "mark a deal as won" and declares no action to
attach it to. That is the appendix's choice, not a gap in the contract:
[section 27.3](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#s27-3) lets a module declare up to a
hundred actions, and this one declares none.

The permission belongs on the option because that is what the platform offers for this exact shape, and it
is enforced rather than merely drawn. [Section 28.8](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#s28-8)
says only a person holding the permission may set the field to that option, and that **the server refuses a
save that sets an option the caller does not hold the permission for, whatever the browser sent**. An action
would guard one operation and leave the plain field write beside it open; the permission on the option
guards every way into the value — a form, the API, an import, and a workflow acting as its `runs_as` role.

None of that is particular to selling. "Only this role may move a record into this state" is what an
approval, a publishing state, an order being fulfilled and an expense being signed off all need, and the
platform answers all of them with the one mechanism. Two rules come with it, and both hold here: the module
registers `vortex.crm.deal.mark_won`, and the deal's stage starts at `discovery`, which needs no
permission — a starting value a person may not pick is refused.

## Checked before landing

669 assertions were run over both files, taken from the rules the contract chapters state: the
envelope's names, the closed list of body names, the twenty-two field types and their required
settings, the settings each type refuses, the reserved field keys, what may title a record, permission
key shapes, that every total names a reverse key some link actually produces, that every navigation
entry and role home page points at a real page, that every permission a role names is one a module registers
or the application declares, that every option guarded by a permission names one the module registers, and
that no value a new record starts with is one a person may need permission to pick.

They all pass. That is not the same as passing the real validator, which
[#16](https://github.com/Abzum-NZ/Abzum-Vortex/issues/16) runs once phase 1 has built it — and where
these files and the contracts disagree, the appendices win and the contract is corrected.

## Two readings inside the workflow and the pipeline

Appendix B describes both in prose, and two details had to be read rather than copied.

**The Slack step stops the run when its retries are exhausted.** B.8 says the platform retries and
*"the deal is unaffected"*. The deal is unaffected whatever happens, because the whole run is
background work. What B.8 does not say is what follows a step that never succeeds, so the step keeps
section 30.10's default of `stop`. The onboarding task is created first, so it survives.

**The Close stage requires the stage field.** B.7 says the work leaving that stage needs *"stage set
to Closed Won"*, which is a value rather than a filled-in field. `required_fields` holds field keys,
so it names `stage`. Requiring the particular value belongs on the move's `condition`, and there is
no move out of Close to hang it on.
