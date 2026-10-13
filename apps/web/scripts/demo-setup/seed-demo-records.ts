import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applicationRootIdSchema,
  identityAuthorityIdSchema,
  organizationSelectionCandidateSchema,
  saveRecordCommandSchema,
} from "@vortex/platform/schema";
import {
  createHumanOrganizationRequestService,
  readCurrentRecordOwnerGroupsAfterAuthorization,
} from "@vortex/platform/server";
import { createDatabaseSystemApplicationBoundReleaseSetService } from "@vortex/platform/server";
import { createRecordSaveService } from "@vortex/platform/server";
import { developmentPublicationCatalogue } from "../development-setup/definitions";
import {
  inSystemTransaction,
  mintSystemContext,
  nominatedOwnerSession,
  type SystemContextFacts,
} from "../development-setup/development-authority";
import { loadCurrentSetupState, type SetupState } from "../development-setup/state";
import { loadLocalWebEnvironment } from "./local-environment";

const uuidNamespace = Buffer.from("6d1f0c523b7a4c4e8a510e1a7b0c9d00", "hex");

const stableUuid = (name: string): string => {
  const digest = createHash("sha1").update(uuidNamespace).update(name).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

type BoundRecordType = Readonly<{
  recordTypeId: string;
  key: string;
  fields: readonly Readonly<{ key: string; fieldId: string; type: string }>[];
}>;

type BoundReleaseSet = Awaited<
  ReturnType<ReturnType<typeof createDatabaseSystemApplicationBoundReleaseSetService>["read"]>
>;

type CompanySeed = Readonly<{
  name: string;
  kind: string;
  industry: string;
  revenue: string;
  employees: number;
  website: string;
  customerSince: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}>;

const companies: readonly CompanySeed[] = [
  {
    name: "Kauri Cloud Systems",
    kind: "customer",
    industry: "technology",
    revenue: "2450000",
    employees: 86,
    website: "https://kauricloud.example",
    customerSince: "2023-04-12",
    firstName: "Amelia",
    lastName: "Ngata",
    email: "amelia.ngata@kauricloud.example",
    phone: "+6495550101",
  },
  {
    name: "Southern Cross Health Group",
    kind: "customer",
    industry: "healthcare",
    revenue: "6800000",
    employees: 230,
    website: "https://southerncrosshealth.example",
    customerSince: "2022-11-03",
    firstName: "Liam",
    lastName: "Patel",
    email: "liam.patel@southerncrosshealth.example",
    phone: "+6495550102",
  },
  {
    name: "Harbourlight Financial",
    kind: "prospect",
    industry: "financial_services",
    revenue: "12400000",
    employees: 410,
    website: "https://harbourlight.example",
    customerSince: "2025-08-18",
    firstName: "Sophie",
    lastName: "Morrison",
    email: "sophie.morrison@harbourlight.example",
    phone: "+6495550103",
  },
  {
    name: "Summit Field Services",
    kind: "customer",
    industry: "manufacturing",
    revenue: "3150000",
    employees: 124,
    website: "https://summitfield.example",
    customerSince: "2024-02-26",
    firstName: "Noah",
    lastName: "Williams",
    email: "noah.williams@summitfield.example",
    phone: "+6495550104",
  },
  {
    name: "Goodnature Retail Network",
    kind: "prospect",
    industry: "retail",
    revenue: "9200000",
    employees: 520,
    website: "https://goodnature.example",
    customerSince: "2026-01-09",
    firstName: "Mia",
    lastName: "Thompson",
    email: "mia.thompson@goodnature.example",
    phone: "+6495550105",
  },
  {
    name: "Alpine Data Partners",
    kind: "partner",
    industry: "technology",
    revenue: "1800000",
    employees: 48,
    website: "https://alpinedata.example",
    customerSince: "2024-07-15",
    firstName: "Jack",
    lastName: "Chen",
    email: "jack.chen@alpinedata.example",
    phone: "+6495550106",
  },
  {
    name: "Redwood Logistics NZ",
    kind: "customer",
    industry: "manufacturing",
    revenue: "7400000",
    employees: 305,
    website: "https://redwoodlogistics.example",
    customerSince: "2021-09-21",
    firstName: "Isla",
    lastName: "Brown",
    email: "isla.brown@redwoodlogistics.example",
    phone: "+6495550107",
  },
  {
    name: "Tealway Energy",
    kind: "prospect",
    industry: "other",
    revenue: "15600000",
    employees: 680,
    website: "https://tealway.example",
    customerSince: "2026-03-02",
    firstName: "Oliver",
    lastName: "King",
    email: "oliver.king@tealway.example",
    phone: "+6495550108",
  },
];

const opportunities = [
  {
    name: "Cloud migration phase two",
    value: "380000",
    discount: "0",
    stage: "proposal",
    probability: 70,
    days: 50,
  },
  {
    name: "Clinical workflow expansion",
    value: "525000",
    discount: "8",
    stage: "negotiation",
    probability: 80,
    days: 35,
  },
  {
    name: "Customer operations platform",
    value: "790000",
    discount: "5",
    stage: "discovery",
    probability: 25,
    days: 95,
  },
  {
    name: "Technician scheduling rollout",
    value: "245000",
    discount: "3",
    stage: "qualified",
    probability: 45,
    days: 68,
  },
  {
    name: "Store support transformation",
    value: "610000",
    discount: "10",
    stage: "proposal",
    probability: 65,
    days: 42,
  },
  {
    name: "Analytics delivery partnership",
    value: "155000",
    discount: "0",
    stage: "negotiation",
    probability: 75,
    days: 28,
  },
  {
    name: "Warehouse service integration",
    value: "420000",
    discount: "6",
    stage: "lost",
    probability: 0,
    days: -12,
  },
  {
    name: "Energy customer portal",
    value: "935000",
    discount: "12",
    stage: "qualified",
    probability: 40,
    days: 82,
  },
] as const;

const cases = [
  ["VPN access drops during shift changes", "high", "in_progress", 1],
  ["Invoice export is missing tax totals", "normal", "triage", 2],
  ["New starter cannot access the mobile app", "normal", "waiting_customer", 3],
  ["Warehouse scanner reconnects repeatedly", "high", "in_progress", 4],
  ["Store tablet setup for the new branch", "low", "new", 5],
  ["Analytics workspace invite expired", "normal", "resolved", 6],
  ["Dispatch dashboard loads without route data", "critical", "triage", 7],
  ["Customer portal password reset loop", "high", "in_progress", 8],
  ["Quarterly access review export request", "low", "closed", 2],
  ["Service report is delayed after overnight run", "normal", "waiting_customer", 4],
  ["New payment approver needs a role update", "high", "new", 3],
  ["Product catalogue changes are not syncing", "normal", "resolved", 5],
  ["Field team cannot upload completion photos", "high", "in_progress", 1],
  ["Partner data feed returned an authentication error", "critical", "triage", 6],
  ["Request to add a regional reporting filter", "low", "new", 8],
] as const;

const recordType = (
  releaseSet: BoundReleaseSet,
  moduleKey: string,
  recordTypeKey: string,
): BoundRecordType => {
  const found = releaseSet.modules
    .find((module) => module.definitionKey === moduleKey)
    ?.content.recordTypes.find((candidate) => candidate.key === recordTypeKey);
  if (found === undefined)
    throw new Error(`Demo record type ${moduleKey}:${recordTypeKey} was not in the bound release`);
  return found;
};

const submittedValues = (
  definition: BoundRecordType,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = definition.fields.find((candidate) => candidate.key === key);
    if (field === undefined) throw new Error(`Demo field ${definition.key}.${key} was not found`);
    if (["calculation", "reference_number", "total"].includes(field.type))
      throw new Error(`Demo seed cannot submit generated field ${definition.key}.${key}`);
    mapped[field.fieldId] = value;
  }
  return mapped;
};

export type DemoSeedFacts = Readonly<{
  identityAuthorityId: ReturnType<typeof identityAuthorityIdSchema.parse>;
  system: SystemContextFacts;
  stewardIdentityId: string;
  releases: ReadonlyMap<string, Readonly<{ rootId: string; releaseRevision: number }>>;
  tenantShortName: string;
  organizationShortName: string;
}>;

const requiredRelease = (
  facts: DemoSeedFacts,
  key: string,
): Readonly<{ rootId: string; releaseRevision: number }> => {
  const release = facts.releases.get(key);
  if (release === undefined) throw new Error(`Demo setup did not publish ${key}`);
  return release;
};

export const seedDemoRecords = async (facts: DemoSeedFacts): Promise<void> => {
  const setupKey = `${facts.tenantShortName}/${facts.organizationShortName}`;
  const context = mintSystemContext(facts.system);
  const crmRelease = requiredRelease(facts, "vortex.app.crm");
  const serviceDeskRelease = requiredRelease(facts, "vortex.app.service_desk");
  const [crm, serviceDesk] = await Promise.all([
    inSystemTransaction(context, (transaction) =>
      createDatabaseSystemApplicationBoundReleaseSetService(
        developmentPublicationCatalogue,
        transaction,
      ).read(context, {
        applicationRootId: applicationRootIdSchema.parse(crmRelease.rootId),
        applicationReleaseRevision: crmRelease.releaseRevision,
      }),
    ),
    inSystemTransaction(context, (transaction) =>
      createDatabaseSystemApplicationBoundReleaseSetService(
        developmentPublicationCatalogue,
        transaction,
      ).read(context, {
        applicationRootId: applicationRootIdSchema.parse(serviceDeskRelease.rootId),
        applicationReleaseRevision: serviceDeskRelease.releaseRevision,
      }),
    ),
  ]);
  const companyType = recordType(crm, "vortex.crm.organisations", "company");
  const contactType = recordType(crm, "vortex.crm.people", "contact");
  const opportunityType = recordType(crm, "vortex.crm.opportunities", "opportunity");
  const calendarType = recordType(serviceDesk, "vortex.service_desk.sla", "business_calendar");
  const serviceLevelType = recordType(serviceDesk, "vortex.service_desk.sla", "service_level");
  const caseType = recordType(serviceDesk, "vortex.service_desk.cases", "case");
  const crmRootId = applicationRootIdSchema.parse(crmRelease.rootId);
  const serviceDeskRootId = applicationRootIdSchema.parse(serviceDeskRelease.rootId);
  const ownerSession = nominatedOwnerSession(facts.stewardIdentityId);
  const saveRecord = createRecordSaveService({ identityAuthorityId: facts.identityAuthorityId });
  const readOwnerGroup = async (applicationRootId: string): Promise<string> => {
    const result = await createHumanOrganizationRequestService({
      identityAuthorityId: facts.identityAuthorityId,
    }).run(
      ownerSession,
      organizationSelectionCandidateSchema.parse({
        organizationId: facts.system.organizationId,
        applicationRootId,
      }),
      (transaction) => readCurrentRecordOwnerGroupsAfterAuthorization(transaction),
    );
    if (result.kind !== "available")
      throw new Error(`The current record owner groups were unavailable (${result.kind}).`);
    const group = result.value[0];
    if (group === undefined)
      throw new Error("The demo owner has no current record owner group for new records.");
    return group.groupId;
  };
  const crmOwnerGroupId = await readOwnerGroup(crmRootId);
  const serviceDeskOwnerGroupId = await readOwnerGroup(serviceDeskRootId);
  const save = async (
    applicationRootId: string,
    definition: BoundRecordType,
    key: string,
    values: Readonly<Record<string, unknown>>,
    selectedOwnerGroupId?: string,
  ): Promise<string> => {
    const saved = await saveRecord.save(
      ownerSession,
      organizationSelectionCandidateSchema.parse({
        organizationId: facts.system.organizationId,
        applicationRootId,
      }),
      saveRecordCommandSchema.parse({
        contractVersion: "2.0.0",
        commandId: stableUuid(
          `${setupKey}/demo-seed/${key.startsWith("contact/") ? "v3" : "v2"}/${key}`,
        ),
        operation: "create",
        recordTypeId: definition.recordTypeId,
        submittedValues: submittedValues(definition, values),
        ...(selectedOwnerGroupId === undefined ? {} : { selectedOwnerGroupId }),
      }),
    );
    if (saved.kind !== "available")
      throw new Error(`Demo save ${key} did not complete (${saved.kind})`);
    if (saved.value.outcome !== "saved")
      throw new Error(
        `Demo save ${key} was refused (${saved.value.outcome === "refused" ? saved.value.error.code : "correction_required"})`,
      );
    return saved.value.recordId;
  };

  const companyIds: string[] = [];
  const contactIds: string[] = [];
  for (const [index, company] of companies.entries()) {
    const companyId = await save(
      crmRootId,
      companyType,
      `company/${index + 1}`,
      {
        name: company.name,
        company_kind: [company.kind],
        industry: company.industry,
        annual_revenue: { amount: company.revenue, currency: "NZD" },
        employee_count: company.employees,
        website: company.website,
        phone: company.phone,
        description: {
          blocks: [
            {
              kind: "paragraph",
              children: [
                {
                  kind: "text",
                  text: `${company.name} is a New Zealand organisation in the ${company.industry.replaceAll("_", " ")} sector.`,
                },
              ],
            },
          ],
        },
        customer_since: company.customerSince,
      },
      crmOwnerGroupId,
    );
    companyIds.push(companyId);
  }

  for (const [index, company] of companies.entries()) {
    const contactId = await save(
      crmRootId,
      contactType,
      `contact/${index + 1}`,
      {
        first_name: company.firstName,
        last_name: company.lastName,
        email: company.email,
        phone: company.phone,
        company: { recordTypeId: companyType.recordTypeId, recordId: companyIds[index]! },
        email_consent: index % 3 !== 2,
      },
      crmOwnerGroupId,
    );
    contactIds.push(contactId);
  }

  const referenceDate = new Date("2026-10-13T12:00:00.000Z");
  for (const [index, opportunity] of opportunities.entries()) {
    const expectedCloseDate = new Date(referenceDate);
    expectedCloseDate.setUTCDate(expectedCloseDate.getUTCDate() + opportunity.days);
    await save(
      crmRootId,
      opportunityType,
      `opportunity/${index + 1}`,
      {
        name: opportunity.name,
        company: { recordTypeId: companyType.recordTypeId, recordId: companyIds[index]! },
        primary_contact: { recordTypeId: contactType.recordTypeId, recordId: contactIds[index]! },
        value: { amount: opportunity.value, currency: "NZD" },
        discount_percent: opportunity.discount,
        probability: opportunity.probability,
        stage: opportunity.stage,
        expected_close_date: expectedCloseDate.toISOString().slice(0, 10),
      },
      crmOwnerGroupId,
    );
  }

  const calendarId = await save(
    serviceDeskRootId,
    calendarType,
    "service-desk/calendar",
    {
      name: "New Zealand Business Hours",
      time_zone: "Pacific/Auckland",
      working_hours: [
        { day: "monday", starts_at: "09:00", ends_at: "17:00" },
        { day: "tuesday", starts_at: "09:00", ends_at: "17:00" },
        { day: "wednesday", starts_at: "09:00", ends_at: "17:00" },
        { day: "thursday", starts_at: "09:00", ends_at: "17:00" },
        { day: "friday", starts_at: "09:00", ends_at: "17:00" },
      ],
    },
    serviceDeskOwnerGroupId,
  );
  const serviceLevelId = await save(
    serviceDeskRootId,
    serviceLevelType,
    "service-desk/standard-sla",
    {
      name: "Standard Support",
      calendar: { recordTypeId: calendarType.recordTypeId, recordId: calendarId },
      first_response_minutes: 240,
      resolution_minutes: 2_880,
      active: true,
    },
    serviceDeskOwnerGroupId,
  );

  for (const [index, [subject, priority, status, companyIndex]] of cases.entries()) {
    const openedAt = new Date(referenceDate);
    openedAt.setUTCDate(openedAt.getUTCDate() - (index + 1) * 2);
    openedAt.setUTCHours(8 + (index % 8), 15, 0, 0);
    const firstResponseDueAt = new Date(openedAt);
    firstResponseDueAt.setUTCHours(firstResponseDueAt.getUTCHours() + 4);
    const resolutionDueAt = new Date(openedAt);
    resolutionDueAt.setUTCDate(resolutionDueAt.getUTCDate() + 2);
    const resolvedAt =
      status === "resolved" || status === "closed" ? new Date(openedAt) : undefined;
    if (resolvedAt !== undefined) resolvedAt.setUTCHours(resolvedAt.getUTCHours() + 2);
    const companyIndexZeroBased = companyIndex - 1;
    await save(
      serviceDeskRootId,
      caseType,
      `service-desk/case/${index + 1}`,
      {
        subject,
        description: {
          blocks: [
            {
              kind: "paragraph",
              children: [
                {
                  kind: "text",
                  text: `${subject}. The customer supplied the relevant steps and requested an update through the support team.`,
                },
              ],
            },
          ],
        },
        customer_company: {
          recordTypeId: companyType.recordTypeId,
          recordId: companyIds[companyIndexZeroBased]!,
        },
        requester: {
          recordTypeId: contactType.recordTypeId,
          recordId: contactIds[companyIndexZeroBased]!,
        },
        status,
        priority,
        service_level: { recordTypeId: serviceLevelType.recordTypeId, recordId: serviceLevelId },
        opened_at: openedAt.toISOString(),
        first_response_due_at: firstResponseDueAt.toISOString(),
        resolution_due_at: resolutionDueAt.toISOString(),
        ...(resolvedAt === undefined ? {} : { resolved_at: resolvedAt.toISOString() }),
      },
      serviceDeskOwnerGroupId,
    );
  }

  process.stdout.write(
    `[demo seed] ${setupKey}: ${companies.length * 3} CRM companies, contacts and opportunities; ${cases.length} Service Desk cases, a service calendar and SLA.\n`,
  );
};

const readFactsFromCurrentSetup = (argv: readonly string[]): DemoSeedFacts => {
  let tenantShortName: string | undefined;
  let organizationShortName: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    if (flag !== "--tenant-short-name" && flag !== "--organization-short-name")
      throw new Error(`Unsupported demo seed argument ${String(flag)}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    index += 1;
    if (flag === "--tenant-short-name") tenantShortName = value;
    else organizationShortName = value;
  }
  const state: SetupState = loadCurrentSetupState();
  if (!state.setupCompleted)
    throw new Error("Run pnpm setup:local successfully before seeding demo records.");
  if (
    (tenantShortName !== undefined && tenantShortName !== state.metadata.tenantShortName) ||
    (organizationShortName !== undefined &&
      organizationShortName !== state.metadata.organizationShortName)
  )
    throw new Error(
      "The requested demo seed names do not match the most recently set up organisation.",
    );
  return {
    identityAuthorityId: identityAuthorityIdSchema.parse(process.env.VORTEX_IDENTITY_AUTHORITY_ID),
    system: {
      tenantId: state.metadata.tenantId,
      organizationId: state.organizationId,
      systemActorId: state.metadata.systemActorId,
      accessVersion: state.metadata.accessVersion,
    },
    stewardIdentityId: state.metadata.stewardIdentityId,
    releases: new Map(Object.entries(state.releases)),
    tenantShortName: state.metadata.tenantShortName,
    organizationShortName: state.metadata.organizationShortName,
  };
};

const main = async (): Promise<void> => {
  try {
    loadLocalWebEnvironment();
    const facts = readFactsFromCurrentSetup(process.argv.slice(2));
    await seedDemoRecords(facts);
  } catch (error) {
    process.stderr.write(
      `[demo seed] failed: ${error instanceof Error ? error.message : "unexpected error"}\n`,
    );
    process.exitCode = 1;
  }
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void main();
