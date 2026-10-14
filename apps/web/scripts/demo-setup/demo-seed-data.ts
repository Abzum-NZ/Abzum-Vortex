/**
 * Fictional demo content. Every person, company and address is invented; the `.example` domain is
 * reserved and never resolves. Indexes refer to positions in the arrays of `seed-demo-records.ts`.
 */

export type AdditionalContactSeed = Readonly<{
  companyIndex: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}>;

/** Second contacts for larger customers; their contact index follows the primary contacts. */
export const additionalContacts: readonly AdditionalContactSeed[] = [
  {
    companyIndex: 0,
    firstName: "Hemi",
    lastName: "Rangi",
    email: "hemi.rangi@kauricloud.example",
    phone: "+6495550111",
  },
  {
    companyIndex: 1,
    firstName: "Priya",
    lastName: "Desai",
    email: "priya.desai@southerncrosshealth.example",
    phone: "+6495550112",
  },
  {
    companyIndex: 3,
    firstName: "Tane",
    lastName: "Walker",
    email: "tane.walker@summitfield.example",
    phone: "+6495550114",
  },
  {
    companyIndex: 6,
    firstName: "Grace",
    lastName: "Fitzgerald",
    email: "grace.fitzgerald@redwoodlogistics.example",
    phone: "+6495550117",
  },
];

export type CaseSeed = Readonly<{
  subject: string;
  summary: string;
  priority: "low" | "normal" | "high" | "critical";
  status: "new" | "triage" | "waiting_customer" | "in_progress" | "resolved" | "closed";
  /** Hours before the seed runs; the SLA is two days, so only the oldest open case is breached. */
  openedHoursAgo: number;
  companyIndex: number;
  /** Index into the primary contacts followed by `additionalContacts`; the requester works at the company. */
  requesterIndex: number;
}>;

export const cases: readonly CaseSeed[] = [
  {
    subject: "VPN access drops during shift changes",
    summary:
      "Remote staff at Kauri Cloud Systems lose their VPN session for about two minutes at 7:00 and 15:00 each day. They reconnect on their own, but open sessions in the support console are lost.",
    priority: "high",
    status: "in_progress",
    openedHoursAgo: 20,
    companyIndex: 0,
    requesterIndex: 0,
  },
  {
    subject: "Invoice export is missing tax totals",
    summary:
      "The monthly invoice export for Southern Cross Health Group lists line items but leaves the GST total column empty, so finance cannot reconcile it with the ledger.",
    priority: "normal",
    status: "triage",
    openedHoursAgo: 9,
    companyIndex: 1,
    requesterIndex: 1,
  },
  {
    subject: "New starter cannot access the mobile app",
    summary:
      "A new starter at Harbourlight Financial receives an invitation error when signing in to the mobile app. Their email address matches the invitation.",
    priority: "normal",
    status: "waiting_customer",
    openedHoursAgo: 30,
    companyIndex: 2,
    requesterIndex: 2,
  },
  {
    subject: "Warehouse scanner reconnects repeatedly",
    summary:
      "Handheld scanners in the Summit Field Services depot drop off the wireless network several times an hour and need to be re-paired, which slows dispatch.",
    priority: "high",
    status: "in_progress",
    openedHoursAgo: 70,
    companyIndex: 3,
    requesterIndex: 3,
  },
  {
    subject: "Store tablet setup for the new branch",
    summary:
      "Goodnature Retail Network opens a new branch next month and needs twelve store tablets enrolled with the standard support profile before the launch date.",
    priority: "low",
    status: "new",
    openedHoursAgo: 3,
    companyIndex: 4,
    requesterIndex: 4,
  },
  {
    subject: "Analytics workspace invite expired",
    summary:
      "An analyst at Alpine Data Partners opened the workspace invitation after it had lapsed. A fresh invitation was sent and the analyst confirmed sign-in works.",
    priority: "normal",
    status: "resolved",
    openedHoursAgo: 100,
    companyIndex: 5,
    requesterIndex: 5,
  },
  {
    subject: "Dispatch dashboard loads without route data",
    summary:
      "The Redwood Logistics NZ dispatch dashboard opens with an empty route panel since this morning. Drivers cannot see their runs and are being briefed by phone.",
    priority: "critical",
    status: "triage",
    openedHoursAgo: 5,
    companyIndex: 6,
    requesterIndex: 6,
  },
  {
    subject: "Customer portal password reset loop",
    summary:
      "Tealway Energy customers who reset their portal password are returned to the reset page instead of being signed in. Three customers have reported it so far.",
    priority: "high",
    status: "in_progress",
    openedHoursAgo: 26,
    companyIndex: 7,
    requesterIndex: 7,
  },
  {
    subject: "Quarterly access review export request",
    summary:
      "Southern Cross Health Group asked for the quarterly list of users and their roles for its compliance review. The export was supplied and acknowledged.",
    priority: "low",
    status: "closed",
    openedHoursAgo: 160,
    companyIndex: 1,
    requesterIndex: 9,
  },
  {
    subject: "Service report is delayed after overnight run",
    summary:
      "The overnight service report for Summit Field Services arrived at noon instead of 6:00. We asked which depots were affected and are waiting for their reply.",
    priority: "normal",
    status: "waiting_customer",
    openedHoursAgo: 40,
    companyIndex: 3,
    requesterIndex: 10,
  },
  {
    subject: "New payment approver needs a role update",
    summary:
      "Harbourlight Financial has appointed a new payment approver who needs the approver role before the end-of-month run.",
    priority: "high",
    status: "new",
    openedHoursAgo: 2,
    companyIndex: 2,
    requesterIndex: 2,
  },
  {
    subject: "Product catalogue changes are not syncing",
    summary:
      "Price changes made in the Goodnature catalogue did not reach the store systems overnight. The sync job was restarted and the changes arrived.",
    priority: "normal",
    status: "resolved",
    openedHoursAgo: 120,
    companyIndex: 4,
    requesterIndex: 4,
  },
  {
    subject: "Field team cannot upload completion photos",
    summary:
      "Kauri Cloud Systems field engineers see an upload error when attaching completion photos larger than 5 MB to a job. Smaller photos work.",
    priority: "high",
    status: "in_progress",
    openedHoursAgo: 44,
    companyIndex: 0,
    requesterIndex: 8,
  },
  {
    subject: "Partner data feed returned an authentication error",
    summary:
      "The nightly data feed from Alpine Data Partners stopped with an authentication error after their credential rotation. Their team needs the new credential registered.",
    priority: "critical",
    status: "triage",
    openedHoursAgo: 12,
    companyIndex: 5,
    requesterIndex: 5,
  },
  {
    subject: "Request to add a regional reporting filter",
    summary:
      "Tealway Energy would like the operations report to filter by region (North Island, South Island) so regional managers see only their own sites.",
    priority: "low",
    status: "new",
    openedHoursAgo: 1,
    companyIndex: 7,
    requesterIndex: 7,
  },
];

export type LeadSeed = Readonly<{
  displayName: string;
  companyName: string;
  email: string;
  source: "web" | "referral" | "event" | "manual";
  interests: readonly ("software" | "services" | "support")[];
  score: number;
  status: "new" | "working" | "qualified" | "unqualified";
  unqualifiedReason?: string;
  receivedDaysAgo: number;
}>;

export const leads: readonly LeadSeed[] = [
  {
    displayName: "Aroha Tipene",
    companyName: "Bluegum Veterinary Group",
    email: "aroha.tipene@bluegumvets.example",
    source: "web",
    interests: ["software", "support"],
    score: 72,
    status: "new",
    receivedDaysAgo: 1,
  },
  {
    displayName: "Callum Fraser",
    companyName: "Pohutukawa Hospitality",
    email: "callum.fraser@pohutukawahospitality.example",
    source: "event",
    interests: ["software"],
    score: 64,
    status: "working",
    receivedDaysAgo: 4,
  },
  {
    displayName: "Fatima Hassan",
    companyName: "Mountain View Education Trust",
    email: "fatima.hassan@mountainviewtrust.example",
    source: "referral",
    interests: ["services", "support"],
    score: 85,
    status: "qualified",
    receivedDaysAgo: 9,
  },
  {
    displayName: "Ethan McKenzie",
    companyName: "Fernbird Construction",
    email: "ethan.mckenzie@fernbirdbuild.example",
    source: "web",
    interests: ["services"],
    score: 38,
    status: "unqualified",
    unqualifiedReason:
      "The company is below our minimum size and has no budget this financial year.",
    receivedDaysAgo: 14,
  },
  {
    displayName: "Hana Yoshida",
    companyName: "Taranaki Dairy Co-operative",
    email: "hana.yoshida@taranakidairy.example",
    source: "referral",
    interests: ["software", "services", "support"],
    score: 91,
    status: "qualified",
    receivedDaysAgo: 6,
  },
  {
    displayName: "Rawiri Kemp",
    companyName: "Wharf Street Legal",
    email: "rawiri.kemp@wharfstreetlegal.example",
    source: "manual",
    interests: ["support"],
    score: 55,
    status: "working",
    receivedDaysAgo: 3,
  },
  {
    displayName: "Zoe Campbell",
    companyName: "Coromandel Eco Tours",
    email: "zoe.campbell@coromandelecotours.example",
    source: "web",
    interests: ["software"],
    score: 47,
    status: "new",
    receivedDaysAgo: 0,
  },
  {
    displayName: "Dev Kapoor",
    companyName: "Otago Medical Imaging",
    email: "dev.kapoor@otagoimaging.example",
    source: "event",
    interests: ["software", "support"],
    score: 78,
    status: "working",
    receivedDaysAgo: 5,
  },
  {
    displayName: "Lucy Anderson",
    companyName: "Kiwi Freight Brokers",
    email: "lucy.anderson@kiwifreight.example",
    source: "web",
    interests: ["services"],
    score: 29,
    status: "unqualified",
    unqualifiedReason: "Asked for a consumer product; we serve organisations only.",
    receivedDaysAgo: 20,
  },
  {
    displayName: "Manu Parata",
    companyName: "Eastland Community Health",
    email: "manu.parata@eastlandhealth.example",
    source: "referral",
    interests: ["services", "support"],
    score: 68,
    status: "new",
    receivedDaysAgo: 2,
  },
];

export type TaskSeed = Readonly<{ title: string; notes: string }>;

export const tasks: readonly TaskSeed[] = [
  {
    title: "Prepare the monthly service review pack",
    notes: "Collect case volumes, response times and the open critical cases for the 20th.",
  },
  {
    title: "Follow up on the Redwood dispatch dashboard fix",
    notes: "Confirm with Isla Brown that route data is showing again after the patch.",
  },
  {
    title: "Convert qualified leads to contacts",
    notes: "Fatima Hassan and Hana Yoshida are qualified and ready to convert.",
  },
  {
    title: "Review access roles for new support staff",
    notes: "Check the support agent role assignment for the two starters on Monday.",
  },
  {
    title: "Update the VPN troubleshooting article",
    notes: "Add the shift-change reconnect steps from the Kauri Cloud Systems case.",
  },
  {
    title: "Book the Harbourlight onboarding workshop",
    notes: "Two hours with Sophie Morrison and the payments team.",
  },
  {
    title: "Archive resolved cases older than 30 days",
    notes: "Close the resolved analytics workspace and catalogue sync cases once confirmed.",
  },
  {
    title: "Draft the quarterly customer newsletter",
    notes: "Highlight the new reporting filters and the winter support hours.",
  },
];

export const hrDepartments: readonly Readonly<{ code: string; name: string }>[] = [
  { code: "OPS", name: "Operations" },
  { code: "PEO", name: "People and Culture" },
  { code: "ENG", name: "Engineering" },
];

/** `departmentIndex` refers to a position in `hrDepartments`. */
export const hrPositions: readonly Readonly<{
  code: string;
  title: string;
  departmentIndex: number;
}>[] = [
  { code: "OPS-LEAD", title: "Operations lead", departmentIndex: 0 },
  { code: "PEO-ADV", title: "People advisor", departmentIndex: 1 },
  { code: "ENG-DEV", title: "Software engineer", departmentIndex: 2 },
];

/**
 * One employee: an Employee links one-to-one to a directory Person and the demo organisation has
 * a single person, its first owner. `positionIndex` refers to a position in `hrPositions`.
 */
export const hrEmployees: readonly Readonly<{
  number: string;
  status: "active" | "inactive";
  startDate: string;
  annualLeaveDays: number;
  positionIndex: number;
}>[] = [
  {
    number: "E-1001",
    status: "active",
    startDate: "2024-02-05",
    annualLeaveDays: 25,
    positionIndex: 0,
  },
];

/** `employeeIndex` refers to a position in `hrEmployees`. */
export const hrLeaveRequests: readonly Readonly<{
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  status: "draft" | "submitted" | "approved" | "rejected";
  employeeIndex: number;
}>[] = [
  {
    startDate: "2026-11-02",
    endDate: "2026-11-06",
    days: 5,
    reason: "Family holiday.",
    status: "submitted",
    employeeIndex: 0,
  },
  {
    startDate: "2026-12-21",
    endDate: "2026-12-31",
    days: 9,
    reason: "Summer break.",
    status: "approved",
    employeeIndex: 0,
  },
  {
    startDate: "2026-10-26",
    endDate: "2026-10-26",
    days: 1,
    reason: "Medical appointment.",
    status: "draft",
    employeeIndex: 0,
  },
  {
    startDate: "2026-03-09",
    endDate: "2026-03-13",
    days: 5,
    reason: "Spring break.",
    status: "approved",
    employeeIndex: 0,
  },
];
