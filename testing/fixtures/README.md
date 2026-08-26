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

## Two things the specification leaves unclear

Recorded here rather than resolved by guessing.

**Are workflows and pipelines inside an application or beside it?**
[Section 26.2](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#s26-2) lists what
an application *carries inside it*: "its workflows, its process pipelines". Section 29.2 gives both as
"a list of **references** to" definitions. Carried inside and referenced are different things, and
they decide whether publishing an application publishes its pipelines in the same revision. These
files follow 29.2 and hold references, because 29.2 is the contract chapter. If 26.2 is the intent,
29.2 needs changing and so do these files.

**`vortex.crm.deal.mark_won` guards an option rather than an action.** Appendix A gives the permission
"mark a deal as won" but no action to attach it to. The nearest mechanism the contract offers is
[section 28.8](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#s28-8)'s
`permission` on a choice option, so the `closed_won` option on the deal's stage field carries it. That
matches the intent — only a sales manager moves a deal to won — but it is a reading, not something the
appendix states.

## Checked before landing

603 assertions were run over both files, taken from the rules the contract chapters state: the
envelope's names, the closed list of body names, the twenty-two field types and their required
settings, the settings each type refuses, the reserved field keys, what may title a record, permission
key shapes, that every total names a reverse key some link actually produces, that every navigation
entry and role home page points at a real page, and that every permission a role names is one a module
registers or the application declares.

They all pass. That is not the same as passing the real validator, which
[#16](https://github.com/Abzum-NZ/Abzum-Vortex/issues/16) runs once phase 1 has built it — and where
these files and the contracts disagree, the appendices win and the contract is corrected.
