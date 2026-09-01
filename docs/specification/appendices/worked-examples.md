# Worked examples

[Specification index](../README.md) · [Data contracts](data-contracts.md) · [Coverage map](traceability.md)

The worked examples are executable acceptance fixtures, not informal illustrations. They must validate against the same contracts used for customer definitions.

```mermaid
flowchart TD
    PEOPLE[Platform module: people and organisations] --> SALES[Sales Hub application]
    WORK[Platform module: work and tasks] --> SALES
    TAGS[Platform module: tags and categories] --> SALES
    CRM[CRM module] --> SALES
    SALES --> PAGES[Pages and navigation]
    SALES --> FLOWS[Rules, workflows and pipeline]
    SALES --> INTEGRATIONS[Email, Slack and Sales Hub interface]
```

## Required fixture set

The complete fixture set must contain:

1. CRM module.
2. People and organisations platform module.
3. Work and tasks platform module.
4. Tags and categories platform module.
5. Sales Hub application.
6. Qualification workflow contained by Sales Hub.
7. Deal-won workflow contained by Sales Hub.
8. Sales process pipeline contained by Sales Hub.
9. Email-sending connection type.
10. Slack connection type.
11. Sales Hub programmable interface.
12. Theme used by Sales Hub or an explicit platform-default theme reference.
13. Organisation and application roles referenced by the application.

The current [fixture README](../../../testing/fixtures/README.md), [CRM fixture](../../../testing/fixtures/vortex.crm.json), and [Sales Hub fixture](../../../testing/fixtures/app.sales_hub.json) remain source material, but they are not yet valid 2.0 fixtures. They omit the three platform modules and several referenced definitions, and their definition envelopes and fields predate this specification.

## CRM module

The CRM module contains:

- **Account:** a company, titled by company name, with reference number, industry, revenue, web address, phone, and totals.
- **Contact:** a person linked to one account, with personal-data classifications.
- **Lead:** an owned prospective enquiry that can be qualified or converted.
- **Deal:** an opportunity with account, owner, stage, amount, probability, expected close date, and controlled state changes.
- **Activity:** a dated business interaction linked to relevant CRM records.

Relationships are explicit. Required parent links use the deletion decision in [D07](decisions.md#d07-required-links-and-deletion). Money totals use [D08](decisions.md#d08-multi-currency-totals). Unique email and reference values use [D10](decisions.md#d10-uniqueness-and-restoration).

The module must declare every action and business event that the Sales Hub application references. At minimum this includes the lead-conversion and public-enquiry creation actions that are currently referenced but absent. A permission without an executable action is valid only when it protects a field option or ordinary record operation under an explicit contract.

## Sales Hub application

The Sales Hub application composes the four modules and includes:

- Executive dashboard.
- Deal pipeline board.
- Lead list and guided qualification form.
- Account and contact lists and details.
- Personal open-task view.
- Public sales-enquiry form.
- Application roles for sales representatives and sales managers.
- A sales pipeline with gated stage movement and escalation.
- Qualification and deal-won workflows.
- Optional assistant, public-form, and discount-approval capabilities.
- Email and Slack connection grants.
- A versioned Sales Hub programmable interface.

## Example working path

```mermaid
sequenceDiagram
    participant Visitor
    participant Public as Public enquiry page
    participant Record as Record service
    participant Event as Event service
    participant Workflow as Qualification workflow
    participant Rep as Sales representative
    Visitor->>Public: Submit approved enquiry fields
    Public->>Record: Run public create-enquiry action
    Record->>Event: Commit lead-created event
    Event->>Workflow: Start one run
    Workflow->>Rep: Assign qualification task
    Rep->>Record: Complete guided qualification
    Record->>Event: Commit lead-qualified event
    Event->>Workflow: Continue or start conversion work
```

Every step uses [access and permissions](../04-access-and-permissions.md), [record saving](../06-records-and-lifecycle.md), [events](../08-forms-actions-rules-and-events.md), and [workflow callbacks](../09-workflows-and-pipelines.md). The public submission cannot set owner, stage, permissions, connection, workflow, or any field not explicitly listed by the public operation.

## Fixture acceptance

The complete fixture suite must prove:

- Every root, contained component, field, relationship, action, permission, role, option, page, block, query, event, workflow step, pipeline transition, connection operation, and interface operation resolves.
- Every field uses one of the twenty-two types and its exact allowed settings.
- Every public field has both field approval and operation allowlisting if [D04](decisions.md#d04-public-field-approval) option A is selected.
- Every visible screen has desktop and phone layouts and normal, empty, refused, validation, failure, and recovery states where applicable.
- Every referenced module and service definition is present; the validator never relaxes reference checks merely to accept a partial example.
- The fixtures use draft and published root envelopes chosen in [D02](decisions.md#d02-publication-boundaries).
- The fixture assertion count is generated from the current contract catalogue rather than maintained as a fixed marketing number.

## Sharing examples

These examples extend the CRM and Sales Hub fixtures to demonstrate the approved local-and-cross-cluster [shared-record access](../04-access-and-permissions.md#shared-record-access) architecture. Implementation remains blocked by open business-policy decisions [D26–D28](decisions.md#d26-cross-organisation-sharing-approval) and [D32–D36](decisions.md#d32-recipient-audience).

### Inter-application sharing

A Support Portal and Sales Hub both bind a compatible version of the CRM module. Because CRM accounts use `organisation_shared` storage, no sharing grant is needed: each application's roles still require their own account-read permission.

An Executive Review application also binds the Service Desk module. Draft response records use `application_contained` storage, so a narrow inter-application grant is required before Executive Review can read them.

That grant names:

- Source and recipient applications: Support Portal and Executive Review.
- Module and record type: Service Desk and `draft_response`.
- Scope kind: record type.
- Allowed action: read only.
- Readable fields: subject, safe response text, status, and owner.
- Export: refused.

The grant does not let Executive Review use any Service Desk record type, field, or action that is not named. It also does not create a second copy of a draft response.

### Cross-organisation sharing with filter

Organisation A operates a Sales Hub application. Organisation B is a partner. Organisation A shares deals that are tagged for partner collaboration.

The proposed grant:

- Source organisation: Organisation A.
- Recipient organisation: Organisation B.
- Recipient application and role: Partner Portal, Partner Manager.
- Module: `vortex.crm`.
- Record type: `deal`.
- Scope: published saved sharing condition `partner_deals`, with Organisation B as its declared partner parameter.
- Allowed actions: read, add a comment, and change `partner_status`.
- Readable fields: deal name, stage, close date, amount, and `partner_status`.
- Changeable field: `partner_status` only.
- Export: refused.
- Expiry: required by the approved sharing policy.

Organisation B's Partner Managers can use a dedicated shared-deals list, view matching deals, add comments, and update `partner_status`. They cannot see unnamed or sensitive fields, change the amount, export, re-share, or access deals that no longer match. The records do not enter Organisation B's global search index.

### The same grant across two clusters

Organisation A is hosted in Cluster North and Organisation B is hosted in Cluster South. The grant above is unchanged; it additionally records the two cluster identifiers and compatible contract fingerprint.

```mermaid
sequenceDiagram
    participant Person as Partner Manager in Organisation B
    participant South as Cluster South gateway
    participant North as Cluster North federation endpoint
    participant Access as Cluster North Access service
    participant Records as Cluster North Record service
    Person->>South: Open shared deals with filter and page size
    South->>South: Verify identity, account, app, role and access version
    South->>North: Send signed bounded query and recipient assertion
    North->>Access: Verify cluster, assertion and authoritative grant
    Access->>Records: Run approved source-side query and field projection
    Records-->>North: Approved fields and continuation token
    North-->>South: Signed response
    South-->>Person: Display the shared list without persisting it
```

If both organisations later move into one cluster, the gateway uses its local adapter and the visible result is the same. If Cluster North is unavailable, Organisation B sees “Source organisation temporarily unavailable” and no stored deal list. Revoking the source grant refuses the next request even if Cluster South has not yet received the revocation notice.

### Approval workflow for cross-organisation sharing

Before the cross-organisation grant above becomes active:

1. An administrator in Organisation A proposes the exact grant through the platform-owned `vortex.approvals` experience.
2. The protected request fingerprints its source, recipient, application, roles, saved condition and parameters, actions, fields, export choice, start, and expiry.
3. An authorised source approver records an immutable decision.
4. Whether Organisation B must also accept depends on [D26](decisions.md#d26-cross-organisation-sharing-approval).
5. Organisation B's cluster returns a signed acceptance for the unchanged fingerprint.
6. Organisation A's Access service verifies the required decisions and acceptance, activates the authoritative grant, changes its local access version, and returns a signed activation receipt.
7. Organisation B stores the receipt in a non-content grant mirror and changes its local access version. A missed message is repaired by asking Organisation A for authoritative status.
8. A later authorised revocation ends the source grant and records a separate event; it does not rewrite the original approval. Delayed recipient notification cannot keep access alive.
9. Directly editing an approval display record never creates, activates, or revokes a grant.
