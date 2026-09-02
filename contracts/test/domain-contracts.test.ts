import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  accessGrantSchema,
  announcementSchema,
  blockPaletteGroupSchema,
  blockPaletteGroupKeys,
  blockSettingControlSchema,
  blockSettingControlKeys,
  businessRecordSchema,
  fieldDefinitionSchema,
  fieldTypeKeys,
  fixtureDocumentSchema,
  federatedFileOperationSchema,
  federatedRequestSchema,
  listArrangementKeys,
  listArrangementSchema,
  motionDefinitionSchema,
  organizationAccountSetSchema,
  pageTypeKeys,
  pageTypeSchema,
  pageDefinitionSchema,
  publishedApplicationDefinitionSchema,
  publishedModuleDefinitionSchema,
  roleSchema,
  secretReferenceSchema,
  workflowNodeSchema,
  workflowNodeTypeKeys,
  workflowNodeTypeSchema,
} from "../src";
import type {
  PublishedApplicationDefinition,
  PublishedModuleDefinition,
  ResolvedRecordTypeReference,
} from "../src";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const fingerprint = `sha256:${"a".repeat(64)}`;
const fieldBase = {
  fieldId: id(1),
  key: "example",
  label: "Example",
  required: false,
  unique: false,
  filterable: true,
  sortable: true,
  personalData: "none",
  publicDisplay: "refused",
} as const;
const unresolvedRecordType = {
  state: "unresolved",
  qualifiedKey: "crm_organisations:company",
} as const;

const fieldSettings: Record<(typeof fieldTypeKeys)[number], unknown> = {
  text: { maxLength: 200 },
  long_text: { maxLength: 10_000 },
  formatted_text: { allowedBlocks: ["paragraph"] },
  whole_number: { minimum: 0, step: 1 },
  decimal_number: { digitsBeforeDecimal: 12, decimalPlaces: 2 },
  money: { currencyMode: "organization_default" },
  yes_no: {},
  date: {},
  date_time: { displayTimeZone: "person" },
  choice: { options: [{ value: "open", label: "Open" }] },
  several_choices: { options: [{ value: "first", label: "First" }], maximumSelections: 1 },
  reference_number: { digits: 8, prefix: "CRM-" },
  email_address: {},
  phone_number: { defaultCountry: "NZ" },
  web_address: { allowedSchemes: ["https"] },
  table: {
    columns: [{ key: "quantity", type: "whole_number", required: true }],
    minimumRows: 0,
    maximumRows: 20,
  },
  link: { target: unresolvedRecordType, reverseKey: "contacts", onParentDelete: "empty_optional" },
  link_to_one_of_several: { targets: [unresolvedRecordType], onParentDelete: "refuse" },
  link_to_person: {
    audience: "organization_accounts",
    applicationRootIdRequired: false,
    onPersonDeactivation: "retain_reference",
  },
  calculation: {
    resultType: "text",
    expression: { operator: "concat" },
    dependencyFieldIds: [id(2)],
  },
  total: { relationshipId: id(3), operation: "count" },
  attachment: { allowedKinds: ["document"], maxFileSizeMb: 25, multiple: true, maxFiles: 5 },
};

const workflowConfigs: Record<(typeof workflowNodeTypeKeys)[number], unknown> = {
  start: {},
  condition: {
    condition: {
      kind: "comparison",
      operator: "equals",
      left: { source: "value", value: true },
      right: { source: "value", value: true },
    },
  },
  decision_table: {
    decisions: [
      {
        when: {
          kind: "comparison",
          operator: "equals",
          left: { source: "value", value: 1 },
          right: { source: "value", value: 1 },
        },
        output: "yes",
      },
      {
        when: {
          kind: "comparison",
          operator: "not_equals",
          left: { source: "value", value: 1 },
          right: { source: "value", value: 2 },
        },
        output: "no",
      },
    ],
  },
  bounded_loop: { queryId: id(40), maximumRecords: 100 },
  delay: { seconds: 60 },
  wait_until: { dateTimeFieldId: id(4) },
  start_workflow: { workflowId: id(5) },
  stop: { reasonCode: "complete" },
  create_record: { recordTypeId: id(41), values: {} },
  change_record: { recordTypeId: id(41), values: { [id(42)]: "Changed" } },
  run_action: { actionKey: "crm.company.update", inputs: {} },
  soft_delete_record: { recordTypeId: id(41) },
  duplicate_record: { recordTypeId: id(41) },
  convert_record: {
    fromRecordTypeId: id(41),
    toRecordTypeId: id(43),
    mappingId: id(44),
  },
  add_relationship: { relationshipId: id(45) },
  copy_relationships: { relationshipIds: [id(45)] },
  add_comment: { visibility: "public", text: "Update" },
  change_tags: { add: ["priority"], remove: [] },
  request_form: { pageId: id(46) },
  request_approval: { reasonCode: "sensitive_change" },
  create_task: { subject: "Follow up" },
  create_calendar_event: { connectionBindingId: id(47), operationKey: "create_event" },
  notification: { audienceKey: "owner", messageKey: "record_changed" },
  send_email: {
    connectionBindingId: id(48),
    operationKey: "send_template",
    templateKey: "case_update",
  },
  query_records: { queryId: id(49) },
  set_values: { values: { [id(50)]: "open" } },
  format_value: { formatterKey: "currency", input: 10 },
  generate_export: { queryId: id(49), maximumRows: 10_000 },
  attach_file: { fieldId: id(6) },
  move_file: { fieldId: id(6) },
  generate_document: { templateKey: "case_summary" },
  call_connection: { connectionBindingId: id(51), operationKey: "post_json" },
  acknowledge_message: { messageKey: "provider_event" },
};

describe("closed catalogues and discriminated contracts", () => {
  test("exports every approved catalogue member exactly once", () => {
    expect(new Set(fieldTypeKeys).size).toBe(22);
    expect(new Set(pageTypeKeys).size).toBe(6);
    expect(new Set(listArrangementKeys).size).toBe(4);
    expect(new Set(blockPaletteGroupKeys).size).toBe(7);
    expect(new Set(blockSettingControlKeys).size).toBe(17);
    expect(new Set(workflowNodeTypeKeys).size).toBe(33);
    expect(pageTypeSchema.safeParse("unknown").success).toBe(false);
    expect(listArrangementSchema.safeParse("unknown").success).toBe(false);
    expect(blockPaletteGroupSchema.safeParse("unknown").success).toBe(false);
    expect(blockSettingControlSchema.safeParse("unknown").success).toBe(false);
    expect(workflowNodeTypeSchema.safeParse("unknown").success).toBe(false);
  });

  test.each(fieldTypeKeys)("accepts and strictly validates the %s field", (type) => {
    const value = { ...fieldBase, type, settings: fieldSettings[type] };
    expect(fieldDefinitionSchema.safeParse(value).success).toBe(true);
    expect(fieldDefinitionSchema.safeParse({ ...value, unexpected: true }).success).toBe(false);
    expect(
      fieldDefinitionSchema.safeParse({
        ...value,
        settings: { ...(fieldSettings[type] as object), unexpected: true },
      }).success,
    ).toBe(false);
  });

  test("rejects type-wrong defaults and inverted numeric settings", () => {
    expect(
      fieldDefinitionSchema.safeParse({
        ...fieldBase,
        type: "yes_no",
        default: "yes",
        settings: {},
      }).success,
    ).toBe(false);
    expect(
      fieldDefinitionSchema.safeParse({
        ...fieldBase,
        type: "whole_number",
        settings: { minimum: 10, maximum: 5 },
      }).success,
    ).toBe(false);
    expect(
      fieldDefinitionSchema.safeParse({
        ...fieldBase,
        type: "choice",
        default: "missing",
        settings: { options: [{ value: "open", label: "Open" }] },
      }).success,
    ).toBe(false);
  });

  test.each(workflowNodeTypeKeys)("accepts and strictly validates the %s workflow node", (type) => {
    const value = {
      nodeId: id(10),
      type,
      config: workflowConfigs[type],
      timeoutSeconds: 60,
      retry: {
        maximumAttempts: 3,
        initialDelaySeconds: 1,
        maximumDelaySeconds: 30,
        backoff: "exponential",
      },
      duplicateProtection: "required",
      activityKey: "workflow_node",
      redaction: "identifiers_only",
    };
    expect(workflowNodeSchema.safeParse(value).success).toBe(true);
    expect(
      workflowNodeSchema.safeParse({
        ...value,
        config: { ...(workflowConfigs[type] as object), unexpected: true },
      }).success,
    ).toBe(false);
  });
});

describe("identity, sharing and secret invariants", () => {
  const account = (accountId: number, organizationId: number) => ({
    organizationAccountId: id(accountId),
    organizationId: id(organizationId),
    identityId: id(100),
    displayName: "Example person",
    state: "active",
    accessVersionContribution: 1,
  });

  test("allows one identity to have separately scoped accounts in several organisations", () => {
    expect(organizationAccountSetSchema.safeParse([account(1, 10), account(2, 11)]).success).toBe(
      true,
    );
    expect(organizationAccountSetSchema.safeParse([account(1, 10), account(2, 10)]).success).toBe(
      false,
    );
    expect(
      organizationAccountSetSchema.safeParse([{ identityId: id(100), displayName: "Unscoped" }])
        .success,
    ).toBe(false);
  });

  test("refuses roles without organisation scope", () => {
    const role = {
      roleId: id(120),
      organizationId: id(121),
      key: "case_reader",
      label: "Case reader",
      description: "Reads cases in one organisation.",
      kind: "organization",
      liveRevision: 1,
      permissions: [],
    };
    expect(roleSchema.safeParse(role).success).toBe(true);
    expect(roleSchema.safeParse({ ...role, organizationId: undefined }).success).toBe(false);
  });

  test("requires a shared record's changeable fields to be readable and cross-org approval to expire", () => {
    const grant = {
      scopeKind: "record",
      grantId: id(1),
      sourceClusterId: id(2),
      sourceOrganizationId: id(3),
      sourceApplicationRootId: id(4),
      recipientClusterId: id(2),
      recipientOrganizationId: id(3),
      recipientApplicationRootId: id(5),
      recipientRoleIds: [id(6)],
      moduleRootId: id(7),
      recordTypeId: id(8),
      recordId: id(9),
      readableFieldIds: [id(10), id(11)],
      changeableFieldIds: [id(11)],
      allowedActionKeys: ["vortex.case.add_public_comment"],
      exportAllowed: false,
      approvedRecipientRegion: "nz-north",
      startsAt: "2026-09-02T01:00:00+00:00",
      status: "active",
      createdByOrganizationAccountId: id(12),
      activatedAt: "2026-09-02T01:00:01+00:00",
      contractVersion: "1.0.0",
      contractFingerprint: fingerprint,
      recipientBindingId: id(13),
      definitionMappingFingerprint: fingerprint,
    };
    expect(accessGrantSchema.safeParse(grant).success).toBe(true);
    expect(accessGrantSchema.safeParse({ ...grant, changeableFieldIds: [id(14)] }).success).toBe(
      false,
    );
    expect(accessGrantSchema.safeParse({ ...grant, recipientOrganizationId: id(15) }).success).toBe(
      false,
    );
    expect(
      accessGrantSchema.safeParse({
        ...grant,
        recipientOrganizationId: id(15),
        approvalRequestId: id(16),
        expiresAt: "2026-09-03T01:00:00+00:00",
      }).success,
    ).toBe(true);
    const grantWithoutRecord = Object.fromEntries(
      Object.entries(grant).filter(([key]) => key !== "recordId"),
    );
    const savedConditionGrant = {
      ...grantWithoutRecord,
      scopeKind: "saved_condition",
      savedConditionId: id(17),
      savedConditionRevision: 1,
      savedConditionFingerprint: fingerprint,
      parameters: { region: "NZ" },
    };
    expect(accessGrantSchema.safeParse(savedConditionGrant).success).toBe(true);
    expect(
      accessGrantSchema.safeParse({
        ...savedConditionGrant,
        parameters: { unsafe: BigInt(1) },
      }).success,
    ).toBe(false);
  });

  test("accepts a Doppler reference and refuses an embedded credential", () => {
    expect(
      secretReferenceSchema.safeParse({ provider: "doppler", referenceId: id(1), key: "crm_email" })
        .success,
    ).toBe(true);
    expect(
      secretReferenceSchema.safeParse({
        provider: "doppler",
        referenceId: id(1),
        key: "crm_email",
        secret: "plaintext",
      }).success,
    ).toBe(false);
  });

  test("represents organisation-account and team record ownership without using names", () => {
    const record = {
      storageScope: "organization_shared" as const,
      organizationId: id(200),
      moduleRootId: id(201),
      recordTypeId: id(202),
      storageContractId: id(203),
      recordId: id(204),
      definitionRevision: 1,
      lifecycleState: "active",
      concurrencyNumber: 1,
      values: {},
      createdAt: "2026-09-02T01:00:00+00:00",
      createdBy: id(205),
      updatedAt: "2026-09-02T01:00:00+00:00",
      updatedBy: id(205),
    };
    expect(
      businessRecordSchema.safeParse({
        ...record,
        owner: { kind: "organization_account", organizationAccountId: id(206) },
      }).success,
    ).toBe(true);
    expect(
      businessRecordSchema.safeParse({ ...record, owner: { kind: "team", teamId: id(207) } })
        .success,
    ).toBe(true);
    expect(
      businessRecordSchema.safeParse({ ...record, owner: { kind: "team", teamName: "Support" } })
        .success,
    ).toBe(false);
    expect(
      businessRecordSchema.safeParse({
        ...record,
        storageScope: "application_contained",
        applicationRootId: id(208),
      }).success,
    ).toBe(true);
    expect(businessRecordSchema.safeParse({ ...record, applicationRootId: id(208) }).success).toBe(
      false,
    );
    expect(
      businessRecordSchema.safeParse({ ...record, lifecycleState: "soft_deleted" }).success,
    ).toBe(false);
    expect(
      businessRecordSchema.safeParse({
        ...record,
        lifecycleState: "soft_deleted",
        deletedAt: "2026-09-02T02:00:00+00:00",
        deletedBy: id(205),
      }).success,
    ).toBe(true);
  });

  test("locks the approved, intentionally small motion contract", () => {
    const motion = {
      library: "motion/react",
      simpleFeedback: "css",
      featureLoading: "lazy",
      tokenSet: "platform_default",
      semanticTokens: ["feedback", "enter_exit", "refresh", "panel", "page", "layout_spring"],
      currentStateWins: true,
      reducedMotion: "required",
      experimentalViewTransitions: false,
    };
    expect(motionDefinitionSchema.safeParse(motion).success).toBe(true);
    expect(motionDefinitionSchema.safeParse({ ...motion, durationMs: 250 }).success).toBe(false);
  });
});

describe("published, page and federation boundaries", () => {
  test("published inferred types expose only resolved record-type references", () => {
    type ModuleField =
      PublishedModuleDefinition["content"]["recordTypes"][number]["fields"][number];
    type LinkTarget = Extract<ModuleField, { type: "link" }>["settings"]["target"];
    type ApplicationPage = PublishedApplicationDefinition["content"]["pages"][number];
    type ListRecordType = Extract<ApplicationPage, { type: "list" }>["recordType"];
    expectTypeOf<LinkTarget>().toEqualTypeOf<ResolvedRecordTypeReference>();
    expectTypeOf<ListRecordType>().toEqualTypeOf<ResolvedRecordTypeReference>();
  });

  test("accepts a complete published module definition and refuses an incomplete envelope", () => {
    const fieldId = id(501);
    const published = {
      publication: {
        kind: "module",
        rootId: id(500),
        revision: 1,
        releaseVersion: "1.0.0",
        contentFingerprint: fingerprint,
        publishedAt: "2026-09-02T01:00:00+00:00",
        publishedBy: id(502),
        validationContractVersion: "1.0.0",
      },
      content: {
        name: "Example module",
        description: "A complete published module used to prove the envelope.",
        dependencies: [],
        recordTypes: [
          {
            recordTypeId: id(503),
            key: "example",
            singularLabel: "Example",
            pluralLabel: "Examples",
            titleFieldId: fieldId,
            storageContractId: id(504),
            storageScope: "organization_shared",
            ownershipMode: "none",
            fields: [{ ...fieldBase, fieldId, type: "text", settings: { maxLength: 120 } }],
            relationships: [],
            standardActions: ["read"],
            customActionIds: [],
          },
        ],
        actions: [],
        events: [],
        rules: [],
        extensionPoints: [],
      },
      dependencyManifest: [],
      releaseNote: "Initial release.",
    };
    expect(publishedModuleDefinitionSchema.safeParse(published).success).toBe(true);
    expect(
      publishedModuleDefinitionSchema.safeParse({ ...published, releaseNote: undefined }).success,
    ).toBe(false);
    expect(
      publishedModuleDefinitionSchema.safeParse({
        ...published,
        content: {
          ...published.content,
          dependencies: [
            {
              dependencyKey: "missing_root",
              moduleKey: "example:dependency",
              version: { selection: "compatible", range: "^1.0.0" },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      publishedModuleDefinitionSchema.safeParse({
        ...published,
        content: {
          ...published.content,
          recordTypes: [
            {
              ...published.content.recordTypes[0],
              fields: [
                {
                  ...fieldBase,
                  fieldId,
                  type: "link",
                  settings: {
                    target: unresolvedRecordType,
                    reverseKey: "examples",
                    onParentDelete: "empty_optional",
                  },
                },
              ],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  test("accepts a complete independently versioned published application definition", () => {
    const pageId = id(540);
    const placementId = id(541);
    const application = {
      publication: {
        kind: "application",
        rootId: id(542),
        revision: 1,
        releaseVersion: "1.0.0",
        contentFingerprint: fingerprint,
        publishedAt: "2026-09-02T01:00:00+00:00",
        publishedBy: id(543),
        validationContractVersion: "1.0.0",
      },
      content: {
        name: "Example application",
        description: "A complete published application used to prove the envelope.",
        icon: "example",
        moduleBindings: [
          {
            moduleRootId: id(544),
            version: { selection: "exact", version: "1.0.0" },
            resolvedVersion: "1.0.0",
            purpose: "primary",
          },
        ],
        navigation: [],
        pages: [
          {
            pageId,
            key: "home",
            name: "Home",
            type: "public",
            accessPermissionKey: "example.public.open",
            states: ["normal"],
            layout: {
              desktop: { columns: 12, componentOrder: [placementId] },
              phone: { componentOrder: [placementId] },
            },
            publicFieldIds: [],
            blocks: [
              {
                placementId,
                blockId: id(545),
                blockReleaseVersion: "1.0.0",
                settings: {},
                desktop: { startColumn: 1, span: 12, height: 1 },
                phone: { order: 0, behaviour: "full_width" },
                viewPermissionKey: "example.public.open",
              },
            ],
            rateLimitPerMinute: 60,
          },
        ],
        roles: [
          {
            roleId: id(546),
            key: "reader",
            name: "Reader",
            homePageId: pageId,
            permissionKeys: ["example.public.open"],
          },
        ],
        queries: [],
        blockRegistrations: [],
        pipelines: [],
        permissionKeys: ["example.public.open"],
        actions: [],
        rules: [],
        events: [],
        workflows: [],
        connectionBindings: [],
        interfaces: [],
        publicAddresses: [],
        theme: {
          mode: "application",
          lightAndDark: true,
          tokens: {
            brand: "indigo",
            density: "comfortable",
            corners: "medium",
            focus: "high_contrast",
          },
        },
        motion: {
          library: "motion/react",
          simpleFeedback: "css",
          featureLoading: "lazy",
          tokenSet: "platform_default",
          semanticTokens: ["feedback", "enter_exit", "refresh", "panel", "page", "layout_spring"],
          currentStateWins: true,
          reducedMotion: "required",
          experimentalViewTransitions: false,
        },
        homePageId: pageId,
      },
      dependencyManifest: [],
      releaseNote: "Initial release.",
    };
    expect(publishedApplicationDefinitionSchema.safeParse(application).success).toBe(true);
  });

  test("requires calendar mappings exactly for calendar list pages", () => {
    const base = {
      pageId: id(510),
      key: "records",
      name: "Records",
      type: "list",
      accessPermissionKey: "crm.record.read",
      states: ["normal"],
      layout: { desktop: { columns: 12, componentOrder: [] }, phone: { componentOrder: [] } },
      recordType: unresolvedRecordType,
      queryId: id(511),
      arrangements: ["table", "calendar"],
    };
    expect(pageDefinitionSchema.safeParse(base).success).toBe(false);
    expect(
      pageDefinitionSchema.safeParse({
        ...base,
        calendarMapping: { kind: "start_end", startFieldId: id(512), endFieldId: id(513) },
      }).success,
    ).toBe(true);
    expect(
      pageDefinitionSchema.safeParse({
        ...base,
        arrangements: ["table"],
        calendarMapping: { kind: "start_end", startFieldId: id(512), endFieldId: id(513) },
      }).success,
    ).toBe(false);
    expect(
      pageDefinitionSchema.safeParse({
        pageId: id(514),
        key: "public_records",
        name: "Public records",
        type: "public",
        accessPermissionKey: "public.records.open",
        states: ["normal"],
        layout: {
          desktop: { columns: 12, componentOrder: [id(515)] },
          phone: { componentOrder: [id(515)] },
        },
        publicFieldIds: [id(516)],
        blocks: [
          {
            placementId: id(515),
            blockId: id(517),
            blockReleaseVersion: "1.0.0",
            settings: {},
            desktop: { startColumn: 1, span: 12, height: 1 },
            phone: { order: 0, behaviour: "full_width" },
            viewPermissionKey: "public.records.open",
          },
        ],
        rateLimitPerMinute: 60,
      }).success,
    ).toBe(false);
  });

  test.each(pageTypeKeys)("accepts a strict canonical %s page", (type) => {
    const placementId = id(600);
    const block = {
      placementId,
      blockId: id(601),
      blockReleaseVersion: "1.0.0",
      settings: {},
      desktop: { startColumn: 1, span: 12, height: 1 },
      phone: { order: 0, behaviour: "full_width" },
      viewPermissionKey: "example.page.open",
    } as const;
    const base = {
      pageId: id(602),
      key: `${type}_page`,
      name: `${type} page`,
      type,
      accessPermissionKey: "example.page.open",
      states: ["normal"],
      layout: {
        desktop: { columns: 12, componentOrder: [placementId] },
        phone: { componentOrder: [placementId] },
      },
    } as const;
    const pages = {
      list: {
        ...base,
        type: "list",
        recordType: unresolvedRecordType,
        queryId: id(603),
        arrangements: ["table"],
      },
      detail: { ...base, type: "detail", recordType: unresolvedRecordType, blocks: [block] },
      dashboard: { ...base, type: "dashboard", blocks: [block] },
      form: {
        ...base,
        type: "form",
        recordType: unresolvedRecordType,
        commitActionKey: "example.record.create",
        blocks: [block],
      },
      guided_form: {
        ...base,
        type: "guided_form",
        recordType: unresolvedRecordType,
        commitActionKey: "example.record.create",
        steps: [
          { id: id(604), name: "Details", summary: false, blocks: [block] },
          { id: id(605), name: "Summary", summary: true, blocks: [block] },
        ],
      },
      public: {
        ...base,
        type: "public",
        publicFieldIds: [],
        blocks: [block],
        rateLimitPerMinute: 60,
      },
    } as const;
    const page = pages[type];
    expect(pageDefinitionSchema.safeParse(page).success).toBe(true);
    expect(pageDefinitionSchema.safeParse({ ...page, unexpected: true }).success).toBe(false);
  });

  test("accepts only HTTPS announcement links", () => {
    const announcement = {
      announcementId: id(610),
      publisherKind: "platform",
      publisherId: id(611),
      audienceScope: "platform",
      type: "information",
      message: "Planned maintenance",
      approvedLink: "https://status.example.com/maintenance",
      startsAt: "2026-09-02T01:00:00+00:00",
      endsAt: "2026-09-02T02:00:00+00:00",
      dismissible: true,
      state: "published",
      createdBy: id(612),
      publishedBy: id(612),
      activityId: id(613),
    };
    expect(announcementSchema.safeParse(announcement).success).toBe(true);
    expect(
      announcementSchema.safeParse({ ...announcement, approvedLink: "http://example.com" }).success,
    ).toBe(false);
  });

  test("couples federation operations, assertions, payloads and duplicate protection", () => {
    const grantId = id(520);
    const duplicateProtectionKey = "federation-change-0001";
    const recipientAssertion = {
      assertionId: id(521),
      recipientClusterId: id(522),
      recipientClusterRegion: "nz-north",
      recipientOrganizationId: id(523),
      recipientOrganizationAccountId: id(524),
      identityId: id(525),
      recipientApplicationId: id(526),
      recipientRoleIds: [id(527)],
      recipientAccessVersion: 1,
      grantId,
      intendedSourceClusterId: id(528),
      authenticationStrength: "multi_factor",
      issuedAt: "2026-09-02T01:00:00+00:00",
      expiresAt: "2026-09-02T01:05:00+00:00",
      nonce: "recipient-nonce-0001",
      correlationId: id(529),
    };
    const payload = {
      kind: "list",
      grantId,
      sourceOrganizationId: id(530),
      moduleRootId: id(531),
      recordTypeId: id(532),
      publishedModuleRevision: 1,
      readableFieldIds: [id(533)],
      grouping: [],
      totals: [],
      sort: [{ fieldId: id(533), direction: "ascending" }],
      page: { pageSize: 50 },
      countRequested: false,
    };
    const request = {
      protocolVersion: "1.0.0",
      operation: "query",
      senderClusterId: id(522),
      receiverClusterId: id(528),
      issuedAt: "2026-09-02T01:00:00+00:00",
      expiresAt: "2026-09-02T01:05:00+00:00",
      nonce: "federation-nonce-0001",
      correlationId: id(529),
      sharedContractVersion: "1.0.0",
      sharedContractFingerprint: fingerprint,
      recipientAssertion,
      payload,
    };
    expect(federatedRequestSchema.safeParse(request).success).toBe(true);
    expect(
      federatedRequestSchema.safeParse({ ...request, recipientAssertion: undefined }).success,
    ).toBe(false);
    expect(
      federatedRequestSchema.safeParse({ ...request, operation: "action", duplicateProtectionKey })
        .success,
    ).toBe(false);
    expect(
      federatedRequestSchema.safeParse({ ...request, payload: { ...payload, grantId: id(599) } })
        .success,
    ).toBe(false);
    expect(
      federatedRequestSchema.safeParse({
        ...request,
        payload: { ...payload, filter: { arbitrary: { executable: true } } },
      }).success,
    ).toBe(false);
    expect(
      federatedRequestSchema.safeParse({ ...request, payload: { ...payload, recordId: id(536) } })
        .success,
    ).toBe(false);
    expect(
      federatedRequestSchema.safeParse({
        ...request,
        payload: { ...payload, kind: "record", recordId: id(536) },
      }).success,
    ).toBe(true);
    expect(
      federatedRequestSchema.safeParse({ ...request, payload: { ...payload, kind: "search" } })
        .success,
    ).toBe(false);
    expect(
      federatedRequestSchema.safeParse({
        ...request,
        payload: { ...payload, kind: "search", searchTerm: "example" },
      }).success,
    ).toBe(true);
    expect(
      federatedFileOperationSchema.safeParse({
        grantId,
        sourceRecord: {
          storageScope: "organization_shared",
          organizationId: id(530),
          moduleRootId: id(531),
          recordTypeId: id(532),
          storageContractId: id(534),
          recordId: id(535),
        },
        attachmentFieldId: id(533),
        operation: "upload_complete",
      }).success,
    ).toBe(false);

    const pendingGrant = {
      scopeKind: "record" as const,
      grantId,
      sourceClusterId: id(528),
      sourceOrganizationId: id(530),
      sourceApplicationRootId: id(537),
      recipientClusterId: id(522),
      recipientOrganizationId: id(523),
      recipientApplicationRootId: id(526),
      recipientRoleIds: [id(527)],
      moduleRootId: id(531),
      recordTypeId: id(532),
      recordId: id(535),
      allowedActionKeys: ["vortex.case.comment"],
      readableFieldIds: [id(533)],
      changeableFieldIds: [id(533)],
      exportAllowed: false,
      approvedRecipientRegion: "nz-north",
      startsAt: "2026-09-02T01:00:00+00:00",
      expiresAt: "2026-09-03T01:00:00+00:00",
      status: "pending_approval" as const,
      createdByOrganizationAccountId: id(538),
      approvalRequestId: id(539),
      contractVersion: "1.0.0",
      contractFingerprint: fingerprint,
      recipientBindingId: id(540),
      definitionMappingFingerprint: fingerprint,
    };
    const controlBase = {
      protocolVersion: "1.0.0",
      operation: "grant_control" as const,
      senderClusterId: id(522),
      receiverClusterId: id(528),
      issuedAt: "2026-09-02T01:00:00+00:00",
      expiresAt: "2026-09-02T01:05:00+00:00",
      nonce: "grant-control-nonce-0001",
      correlationId: id(529),
      duplicateProtectionKey: "grant-control-0001",
      sharedContractVersion: "1.0.0",
      sharedContractFingerprint: fingerprint,
    };
    const evidenceBase = {
      grantId,
      evidenceFingerprint: fingerprint,
      evidenceSignature: "s".repeat(64),
      issuedAt: "2026-09-02T01:00:00+00:00",
    };
    const proposal = { ...evidenceBase, kind: "proposal", proposedGrant: pendingGrant };
    const decision = {
      ...evidenceBase,
      kind: "decision",
      decision: {
        decisionId: id(541),
        requestId: id(539),
        side: "recipient_acceptance",
        payloadFingerprint: fingerprint,
        approverOrganizationId: id(523),
        approverOrganizationAccountId: id(524),
        decision: "approved",
        decidedAt: "2026-09-02T01:01:00+00:00",
        authenticationStrength: "multi_factor",
        correlationId: id(529),
      },
    };
    const activeGrant = {
      ...pendingGrant,
      status: "active" as const,
      activatedAt: "2026-09-02T01:02:00+00:00",
    };
    const activation = {
      ...evidenceBase,
      kind: "activation_receipt",
      activeGrant,
      recipientDecisionId: id(541),
      signedActivationReceipt: "a".repeat(64),
    };
    const revokedGrant = {
      ...activeGrant,
      status: "revoked" as const,
      revokedAt: "2026-09-02T02:00:00+00:00",
      revokedByOrganizationAccountId: id(538),
      revocationReason: "No longer required",
    };
    const revocation = {
      ...evidenceBase,
      kind: "revocation_evidence",
      revokedGrant,
      sourceAccessVersion: 2,
      signedRevocationEvidence: "r".repeat(64),
    };
    for (const controlPayload of [proposal, decision, activation, revocation])
      expect(
        federatedRequestSchema.safeParse({ ...controlBase, payload: controlPayload }).success,
      ).toBe(true);
    expect(
      federatedRequestSchema.safeParse({ ...controlBase, payload: pendingGrant }).success,
    ).toBe(false);
    expect(
      federatedRequestSchema.safeParse({
        ...controlBase,
        payload: { ...activation, activeGrant: pendingGrant },
      }).success,
    ).toBe(false);
  });
});

describe("complete definition-source fixture set", () => {
  test("parses every manifest-listed document through its strict source schema", async () => {
    const fixtureRoot = resolve(process.cwd(), "testing/fixtures");
    const manifest = JSON.parse(
      await readFile(resolve(fixtureRoot, "fixture-set.json"), "utf8"),
    ) as { files: string[] };
    expect(manifest.files).toHaveLength(15);
    for (const file of manifest.files) {
      const document = JSON.parse(await readFile(resolve(fixtureRoot, file), "utf8"));
      const result = fixtureDocumentSchema.safeParse(document);
      expect(
        result.success,
        result.success ? undefined : `${file}: ${JSON.stringify(result.error.issues)}`,
      ).toBe(true);
    }
  });

  test("refuses an unknown workflow condition operator in definition-source JSON", async () => {
    const fixtureRoot = resolve(process.cwd(), "testing/fixtures");
    const application = JSON.parse(
      await readFile(resolve(fixtureRoot, "applications/crm.json"), "utf8"),
    ) as {
      body: { workflows: { nodes: { type: string; config: Record<string, unknown> }[] }[] };
    };
    const condition = application.body.workflows
      .flatMap((workflow) => workflow.nodes)
      .find((node) => node.type === "condition");
    expect(condition).toBeDefined();
    if (condition) condition.config.operator = "execute_anything";
    expect(fixtureDocumentSchema.safeParse(application).success).toBe(false);
  });
});
