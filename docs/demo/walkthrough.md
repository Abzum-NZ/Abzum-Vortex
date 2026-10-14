# Demo walkthrough (M2 journeys)

A scripted tour of the local demo. Every name below is seeded by `pnpm demo:setup`; all people, companies and addresses are fictional (`.example` addresses).

## Before you start

1. Start the local database and run `pnpm demo:setup` (it resets the database, installs every application and seeds records).
2. Run `pnpm dev` and open the site URL printed by the setup.
3. Pages live under `/<tenant>/<organisation>/<application>/<page>`. The setup uses `abzum/abzum`, so the examples read `/abzum/abzum/vortex.app.crm/crm_leads`.

What the seed holds:

| Application  | Seeded content                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM          | 8 companies, 12 contacts (Amelia Ngata at Kauri Cloud Systems, Liam Patel at Southern Cross Health Group, ...), 8 opportunities across the pipeline stages and 10 leads (new, working, qualified, unqualified) |
| Service Desk | 15 cases (all priorities and statuses, each with a company, requester and description), the Standard Support service level and the New Zealand Business Hours calendar     |
| Tasks        | 8 tasks                                                                                                                                                                    |
| IAM, Landing Zone, Operations, Administration | Installed with the first owner holding the application roles                                                                              |

## 1. Sign in

1. Open `/auth/sign-in`.
2. Enter `VORTEX_DEMO_OWNER_EMAIL` and `VORTEX_DEMO_OWNER_PASSWORD` from `apps/web/.env.development.local`.
3. You arrive on **Landing Zone > Home**, the organisation's default application.

## 2. Create and resolve a Service Desk case

1. Landing Zone > **All applications** > **Service Desk** > **Open**, then **Cases** (`service_desk_cases`).
2. The queue lists the 15 seeded cases, for example **CAS-0000001 VPN access drops during shift changes** (High, In progress) and **CAS-0000007 Dispatch dashboard loads without route data** (Critical, Triage). Open one to read its description.
3. Select **New case** and enter:
   - Subject: `Printer on level 2 offline`
   - Description: `The shared printer on level 2 shows offline for all staff since this morning.`
   - Customer company: **Kauri Cloud Systems**
   - Requester: **Amelia Ngata**
   - Service level: **Standard Support**
4. Select **Submit**. The page confirms **Saved.**
5. Back in the case queue, open the new case. It is **New**, with the first response due four hours and the resolution due two days after it was opened.
6. In **Resolve case**, enter `Print server restarted; printing confirmed by the requester.` and select **Resolve case**. The status becomes **Resolved**.

## 3. Work a CRM lead

1. Open **CRM** > **Leads** (`crm_leads`). Ten leads are listed, for example **Hana Yoshida** (Taranaki Dairy Co-operative, score 91, Qualified), **Fatima Hassan** (Mountain View Education Trust, Qualified) and **Callum Fraser** (Pohutukawa Hospitality, Working).
2. Open **Hana Yoshida** to read the lead: source, interests, score and status.
3. Select **Edit** to change the status or score, and save.
4. The related records are under **Companies**, **Contacts** and **Opportunities**, for example the prospect **Goodnature Retail Network** and its opportunity **Store support transformation** (Proposal).

Lead conversion is not available yet: the **Qualify lead** page (`crm_qualify_lead`) answers "This is not available yet." when continued. Until it ships, create the contact from **Contacts** > **New contact**.

## 4. Manage a task

1. Open **Tasks** from All applications. The list shows the seeded tasks, for example **Prepare the monthly service review pack** and **Convert qualified leads to contacts**.
2. Select **Create task**, enter the title `Call Southern Cross about the invoice export` and the notes `Confirm the GST total column appears after the fix.`, then select **Create task**. The page confirms **Saved.**
3. Return to **Tasks**; the new task is in the list.

## 5. Find the IAM and Landing Zone views

1. **Landing Zone** > **Home** shows the application tiles; **All applications** lists CRM, IAM, Landing Zone, Operations, Organisation Administration, Service Desk, Tasks and Tenant Administration.
2. **IAM** > **People** lists the organisation's accounts (the first owner).
3. **IAM** > **Assignments** is the role assignment ledger: the application installer and the CRM, Service Desk and other roles granted to the first owner.
4. **IAM** > **Roles and Groups** shows the roles and groups; **Access Requests** holds requests for access.

## Known gaps

These show in the walkthrough and are product issues, not seed issues:

- Link fields (Customer company, Requester, Company) show `—` in lists and on detail pages, although the relationship is stored and the picker lists the records.
- Person fields (Owner, Relationship owner) cannot be set by the record save path, so seeded cases have no owner.
- Date-time columns show the raw timestamp.
- Lead conversion answers "This is not available yet."
