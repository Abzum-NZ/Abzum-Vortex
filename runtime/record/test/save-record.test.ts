import {
  recordTypeDefinitionV2Schema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";
import type {
  DatabaseRow,
  RequestDatabaseTransaction,
  RuntimeDatabaseTransaction,
} from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { createRecordSaveService, type RecordSaveServiceDependencies } from "../src/save-record";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const ids = {
  identity: id(1),
  session: id(2),
  organization: id(3),
  application: id(4),
  authority: id(5),
  tenant: id(6),
  account: id(7),
  correlation: id(8),
  recordType: id(9),
  storage: id(10),
  visibleField: id(11),
  hiddenField: id(12),
  record: id(13),
  command: id(14),
  activity: id(15),
  occurrence: id(16),
  moneyField: id(17),
  secondCommand: id(18),
  thirdCommand: id(19),
  calculatedField: id(20),
  fourthCommand: id(21),
  dueDateField: id(22),
  deadlineField: id(23),
} as const;

const session: IdentitySession = {
  identityId: ids.identity,
  sessionId: ids.session,
  authenticationStrength: "multi_factor",
  accessTokenIssuedAt: "2026-09-08T00:00:00.000Z",
  accessTokenExpiresAt: "2026-09-08T02:00:00.000Z",
};

const selection: OrganizationSelectionCandidate = {
  organizationId: ids.organization,
  applicationRootId: ids.application,
};

const textField = (fieldId: string, key: string, required: boolean) => ({
  fieldId,
  key,
  label: key,
  required,
  unique: false,
  filterable: true,
  sortable: true,
  personalData: "none" as const,
  publicDisplay: "refused" as const,
  type: "text" as const,
  settings: { maxLength: 40 },
});

const recordType = (includeHiddenRequiredField = false): RecordTypeDefinitionV2 =>
  recordTypeDefinitionV2Schema.parse({
    recordTypeId: ids.recordType,
    key: "service_record",
    singularLabel: "Service record",
    pluralLabel: "Service records",
    titleFieldId: ids.visibleField,
    storageContractId: ids.storage,
    storageScope: "application_contained",
    ownershipMode: "none",
    fields: [
      textField(ids.visibleField, "title", true),
      ...(includeHiddenRequiredField
        ? [textField(ids.hiddenField, "private_required_value", true)]
        : []),
    ],
    relationships: [],
    standardActions: ["create", "read", "update"],
    customActionIds: [],
  });

const moneyRecordType = (defaultValue?: string): RecordTypeDefinitionV2 =>
  recordTypeDefinitionV2Schema.parse({
    recordTypeId: ids.recordType,
    key: "service_record",
    singularLabel: "Service record",
    pluralLabel: "Service records",
    titleFieldId: ids.visibleField,
    storageContractId: ids.storage,
    storageScope: "application_contained",
    ownershipMode: "none",
    fields: [
      textField(ids.visibleField, "title", true),
      {
        fieldId: ids.moneyField,
        key: "amount",
        label: "amount",
        required: false,
        unique: false,
        filterable: true,
        sortable: true,
        personalData: "none" as const,
        publicDisplay: "refused" as const,
        type: "money" as const,
        settings: { currencyMode: "organization_default" as const, minimum: "0" },
        ...(defaultValue === undefined ? {} : { default: defaultValue }),
      },
    ],
    relationships: [],
    standardActions: ["create", "read", "update"],
    customActionIds: [],
  });

const calculatedRecordType = (): RecordTypeDefinitionV2 =>
  recordTypeDefinitionV2Schema.parse({
    recordTypeId: ids.recordType,
    key: "calculated_record",
    singularLabel: "Calculated record",
    pluralLabel: "Calculated records",
    titleFieldId: ids.visibleField,
    storageContractId: ids.storage,
    storageScope: "application_contained",
    ownershipMode: "none",
    fields: [
      textField(ids.visibleField, "title", true),
      {
        fieldId: ids.calculatedField,
        key: "derived_title",
        label: "derived title",
        required: true,
        unique: false,
        filterable: true,
        sortable: true,
        personalData: "none" as const,
        publicDisplay: "refused" as const,
        type: "calculation" as const,
        settings: {
          resultType: "text" as const,
          expression: {
            kind: "join_text" as const,
            fieldIds: [ids.visibleField],
            separator: "",
          },
          dependencyFieldIds: [ids.visibleField],
        },
      },
    ],
    relationships: [],
    standardActions: ["create", "read", "update"],
    customActionIds: [],
  });

const deadlineRecordType = (): RecordTypeDefinitionV2 =>
  recordTypeDefinitionV2Schema.parse({
    recordTypeId: ids.recordType,
    key: "deadline_record",
    singularLabel: "Deadline record",
    pluralLabel: "Deadline records",
    titleFieldId: ids.visibleField,
    storageContractId: ids.storage,
    storageScope: "application_contained",
    ownershipMode: "none",
    fields: [
      textField(ids.visibleField, "title", true),
      {
        fieldId: ids.dueDateField,
        key: "due_date",
        label: "due date",
        required: true,
        unique: false,
        filterable: true,
        sortable: true,
        personalData: "none" as const,
        publicDisplay: "refused" as const,
        type: "date" as const,
        settings: {},
      },
      {
        fieldId: ids.deadlineField,
        key: "deadline_passed",
        label: "deadline passed",
        required: true,
        unique: false,
        filterable: true,
        sortable: true,
        personalData: "none" as const,
        publicDisplay: "refused" as const,
        type: "calculation" as const,
        settings: {
          resultType: "yes_no" as const,
          expression: {
            kind: "deadline_passed" as const,
            dueFieldId: ids.dueDateField,
            terminalStatusValues: [],
          },
          dependencyFieldIds: [ids.dueDateField],
        },
      },
    ],
    relationships: [],
    standardActions: ["create", "read", "update"],
    customActionIds: [],
  });

const instantDeadlineRecordType = (): RecordTypeDefinitionV2 => {
  const dateDeadline = deadlineRecordType();
  return recordTypeDefinitionV2Schema.parse({
    ...dateDeadline,
    fields: dateDeadline.fields.map((field) =>
      field.fieldId === ids.dueDateField
        ? { ...field, type: "date_time" as const, settings: { displayTimeZone: "organization" } }
        : field,
    ),
  });
};

const scopeRows = [
  {
    tenant_id: ids.tenant,
    organization_id: ids.organization,
    organization_account_id: ids.account,
    application_root_id: ids.application,
    access_version: "1",
  },
] as const;

const updateCommand = (title: string) => ({
  contractVersion: "2.0.0" as const,
  commandId: ids.command,
  operation: "update" as const,
  recordTypeId: ids.recordType,
  recordId: ids.record,
  expectedConcurrencyNumber: 2,
  submittedValues: { [ids.visibleField]: title },
});

const createCommand = (commandId: string, submittedValues: Record<string, unknown>) => ({
  contractVersion: "2.0.0" as const,
  commandId,
  operation: "create" as const,
  recordTypeId: ids.recordType,
  submittedValues,
});

const runtimeSettingsRow = (currency: string) => ({
  organization_id: ids.organization,
  language: "en-NZ",
  time_zone: "Pacific/Auckland",
  currency,
  date_format: "medium",
  number_format: "auto",
  revision: "1",
});

type RequestQuery = <Row extends DatabaseRow>(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => Promise<readonly Row[]>;

const transactionRunner =
  (
    requestQuery: RequestQuery,
  ): NonNullable<RecordSaveServiceDependencies["resolvedRequestTransaction"]> =>
  async (resolve, operation) => {
    const resolved = await resolve({
      query: async <Row extends DatabaseRow>() => scopeRows as unknown as readonly Row[],
    } satisfies RuntimeDatabaseTransaction);
    return operation({ query: requestQuery } satisfies RequestDatabaseTransaction, resolved.scope);
  };

describe("base Record save service", () => {
  it("resolves a response-lost retry in preparation and never repeats the terminal write", async () => {
    let preparationCalls = 0;
    let terminalCalls = 0;
    let settingsReads = 0;
    const queries: string[] = [];
    const activityId = vi.fn(() => ids.activity);
    const occurrenceId = vi.fn(() => ids.occurrence);
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings) => {
      const sql = strings.join("$value");
      queries.push(sql);
      if (sql.includes("prepare_base_record_save")) {
        preparationCalls += 1;
        const preparation =
          preparationCalls === 1
            ? {
                outcome: "prepared",
                recordType: recordType(),
                existingValues: { [ids.visibleField]: "Before" },
                readableFieldIds: [ids.visibleField],
                correlationId: ids.correlation,
              }
            : preparationCalls === 2
              ? {
                  outcome: "saved",
                  recordId: ids.record,
                  concurrencyNumber: 3,
                  values: { [ids.visibleField]: "Current projection" },
                  correlationId: ids.correlation,
                  backgroundDelivery: "pending",
                }
              : {
                  outcome: "refused",
                  reasonCode: "command_identity_conflict",
                  correlationId: ids.correlation,
                };
        return [{ preparation }] as unknown as readonly Row[];
      }
      if (sql.includes("save_base_record")) {
        terminalCalls += 1;
        return [
          {
            result: {
              outcome: "saved",
              recordId: ids.record,
              concurrencyNumber: 3,
              values: { [ids.visibleField]: "Changed once" },
              correlationId: ids.correlation,
              backgroundDelivery: "pending",
              replayed: false,
            },
          },
        ] as unknown as readonly Row[];
      }
      if (sql.includes("read_current_organization_runtime_settings_for_application")) {
        settingsReads += 1;
        return [runtimeSettingsRow("NZD")] as unknown as readonly Row[];
      }
      return [] as unknown as readonly Row[];
    };
    const service = createRecordSaveService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-08T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId,
      occurrenceId,
      resolvedRequestTransaction: transactionRunner(requestQuery),
    });
    const command = updateCommand("Changed once");

    await expect(service.save(session, selection, command)).resolves.toEqual({
      kind: "available",
      value: {
        contractVersion: "2.0.0",
        outcome: "saved",
        recordId: ids.record,
        concurrencyNumber: 3,
        readableValues: { [ids.visibleField]: "Changed once" },
        correlationId: ids.correlation,
        backgroundDelivery: "pending",
      },
    });
    await expect(service.save(session, selection, command)).resolves.toEqual({
      kind: "available",
      value: {
        contractVersion: "2.0.0",
        outcome: "saved",
        recordId: ids.record,
        concurrencyNumber: 3,
        readableValues: { [ids.visibleField]: "Current projection" },
        correlationId: ids.correlation,
        backgroundDelivery: "pending",
      },
    });
    await expect(
      service.save(session, selection, updateCommand("Different content")),
    ).resolves.toEqual({
      kind: "available",
      value: {
        contractVersion: "2.0.0",
        outcome: "refused",
        error: {
          code: "conflict",
          messageKey: "errors.conflict",
          correlationId: ids.correlation,
        },
      },
    });

    expect(preparationCalls).toBe(3);
    expect(terminalCalls).toBe(1);
    expect(settingsReads).toBe(1);
    expect(
      queries.filter(
        (query) =>
          query.includes("prepare_base_record_save") ||
          query.includes("read_current_organization_runtime_settings_for_application") ||
          query.includes("save_base_record") ||
          query.includes("set local role"),
      ),
    ).toEqual([
      "set local role vortex_runtime",
      expect.stringContaining("prepare_base_record_save"),
      "set local role vortex_request",
      expect.stringContaining("read_current_organization_runtime_settings_for_application"),
      "set local role vortex_runtime",
      expect.stringContaining("save_base_record"),
      "set local role vortex_runtime",
      expect.stringContaining("prepare_base_record_save"),
      "set local role vortex_runtime",
      expect.stringContaining("prepare_base_record_save"),
    ]);
    expect(activityId).toHaveBeenCalledTimes(3);
    expect(occurrenceId).toHaveBeenCalledTimes(1);
  });

  it("does not call the terminal writer after preparation records a clean refusal", async () => {
    let terminalCalls = 0;
    let settingsReads = 0;
    const activityId = vi.fn(() => ids.activity);
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_base_record_save"))
        return [{ preparation: { outcome: "refused_recorded" } }] as unknown as readonly Row[];
      if (sql.includes("save_base_record")) terminalCalls += 1;
      if (sql.includes("read_current_organization_runtime_settings_for_application"))
        settingsReads += 1;
      return [] as unknown as readonly Row[];
    };
    const service = createRecordSaveService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-08T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId,
      resolvedRequestTransaction: transactionRunner(requestQuery),
    });

    await expect(service.save(session, selection, updateCommand("Refused"))).resolves.toEqual({
      kind: "unavailable",
    });
    expect(activityId).toHaveBeenCalledTimes(1);
    expect(terminalCalls).toBe(0);
    expect(settingsReads).toBe(0);
  });

  it("does not read settings for a malformed command or stale preparation", async () => {
    let settingsReads = 0;
    let terminalCalls = 0;
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_base_record_save"))
        return [
          { preparation: { outcome: "conflict", correlationId: ids.correlation } },
        ] as unknown as readonly Row[];
      if (sql.includes("read_current_organization_runtime_settings_for_application"))
        settingsReads += 1;
      if (sql.includes("save_base_record")) terminalCalls += 1;
      return [] as unknown as readonly Row[];
    };
    const service = createRecordSaveService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-08T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      resolvedRequestTransaction: transactionRunner(requestQuery),
    });

    await expect(service.save(session, selection, {})).resolves.toEqual({ kind: "unavailable" });
    await expect(service.save(session, selection, updateCommand("Stale"))).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "refused", error: { code: "conflict" } },
    });
    expect(settingsReads).toBe(0);
    expect(terminalCalls).toBe(0);
  });

  it("does not disclose an unreadable invalid required field in validation output", async () => {
    let terminalCalls = 0;
    const privateValue = "private-existing-value-that-must-not-escape";
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_base_record_save"))
        return [
          {
            preparation: {
              outcome: "prepared",
              recordType: {
                ...recordType(true),
                fields: [
                  textField(ids.visibleField, "title", true),
                  {
                    ...textField(ids.hiddenField, "private_required_value", true),
                    settings: { maxLength: 3 },
                  },
                ],
              },
              existingValues: {
                [ids.visibleField]: "Before",
                [ids.hiddenField]: privateValue,
              },
              readableFieldIds: [ids.visibleField],
              correlationId: ids.correlation,
            },
          },
        ] as unknown as readonly Row[];
      if (sql.includes("save_base_record")) terminalCalls += 1;
      return [] as unknown as readonly Row[];
    };
    const service = createRecordSaveService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-08T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      resolvedRequestTransaction: transactionRunner(requestQuery),
    });

    const result = await service.save(session, selection, updateCommand("Visible change"));

    expect(result).toEqual({
      kind: "available",
      value: {
        contractVersion: "2.0.0",
        outcome: "refused",
        error: {
          code: "operation_refused",
          messageKey: "errors.operation_refused",
          correlationId: ids.correlation,
        },
      },
    });
    expect(terminalCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(ids.hiddenField);
    expect(JSON.stringify(result)).not.toContain("private_required_value");
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(JSON.stringify(result)).not.toContain("nestedPath");
  });

  it("uses the current organisation currency for fresh defaults but not an exact replay", async () => {
    let preparationCalls = 0;
    let settingsReads = 0;
    const persistedValues: unknown[] = [];
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings, ...values) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_base_record_save")) {
        preparationCalls += 1;
        if (preparationCalls === 2)
          return [
            {
              preparation: {
                outcome: "saved",
                recordId: ids.record,
                concurrencyNumber: 1,
                values: { [ids.visibleField]: "First" },
                correlationId: ids.correlation,
                backgroundDelivery: "none",
              },
            },
          ] as unknown as readonly Row[];
        return [
          {
            preparation: {
              outcome: "prepared",
              recordType: moneyRecordType("12.34"),
              existingValues: {},
              readableFieldIds: [ids.visibleField, ids.moneyField],
              correlationId: ids.correlation,
            },
          },
        ] as unknown as readonly Row[];
      }
      if (sql.includes("read_current_organization_runtime_settings_for_application")) {
        settingsReads += 1;
        return [
          runtimeSettingsRow(settingsReads === 1 ? "NZD" : "AUD"),
        ] as unknown as readonly Row[];
      }
      if (sql.includes("save_base_record")) {
        persistedValues.push(JSON.parse(String(values[6])));
        return [
          {
            result: {
              outcome: "saved",
              recordId: ids.record,
              concurrencyNumber: persistedValues.length,
              values: { [ids.visibleField]: "Saved" },
              correlationId: ids.correlation,
              backgroundDelivery: "none",
            },
          },
        ] as unknown as readonly Row[];
      }
      return [] as unknown as readonly Row[];
    };
    const service = createRecordSaveService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-08T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId: () => ids.activity,
      occurrenceId: () => ids.occurrence,
      resolvedRequestTransaction: transactionRunner(requestQuery),
    });

    const first = createCommand(ids.command, { [ids.visibleField]: "First" });
    await expect(service.save(session, selection, first)).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "saved" },
    });
    await expect(service.save(session, selection, first)).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "saved", concurrencyNumber: 1 },
    });
    await expect(
      service.save(
        session,
        selection,
        createCommand(ids.secondCommand, { [ids.visibleField]: "Second" }),
      ),
    ).resolves.toMatchObject({ kind: "available", value: { outcome: "saved" } });

    expect(settingsReads).toBe(2);
    expect(persistedValues).toEqual([
      { [ids.visibleField]: "First", [ids.moneyField]: { amount: "12.34", currency: "NZD" } },
      { [ids.visibleField]: "Second", [ids.moneyField]: { amount: "12.34", currency: "AUD" } },
    ]);
  });

  it("allows explicit money without settings, refuses an unresolved default, and rolls back reader failures", async () => {
    const scenarios = [
      "missing-explicit",
      "missing-default",
      "malformed",
      "reader-failure",
    ] as const;
    for (const scenario of scenarios) {
      let terminalCalls = 0;
      let settingsReads = 0;
      const roles: string[] = [];
      const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings) => {
        const sql = strings.join("$value");
        if (sql.startsWith("set local role")) roles.push(sql);
        if (sql.includes("prepare_base_record_save"))
          return [
            {
              preparation: {
                outcome: "prepared",
                recordType: moneyRecordType(scenario === "missing-default" ? "12.34" : undefined),
                existingValues: {},
                readableFieldIds: [ids.visibleField, ids.moneyField],
                correlationId: ids.correlation,
              },
            },
          ] as unknown as readonly Row[];
        if (sql.includes("read_current_organization_runtime_settings_for_application")) {
          settingsReads += 1;
          if (scenario === "reader-failure") {
            const error = new Error("settings reader unavailable");
            Object.assign(error, { code: "42501" });
            throw error;
          }
          return scenario === "malformed"
            ? ([runtimeSettingsRow("ZZZ")] as unknown as readonly Row[])
            : ([] as unknown as readonly Row[]);
        }
        if (sql.includes("save_base_record")) {
          terminalCalls += 1;
          return [
            {
              result: {
                outcome: "saved",
                recordId: ids.record,
                concurrencyNumber: 1,
                values: {},
                correlationId: ids.correlation,
                backgroundDelivery: "none",
              },
            },
          ] as unknown as readonly Row[];
        }
        return [] as unknown as readonly Row[];
      };
      const service = createRecordSaveService({
        identityAuthorityId: ids.authority,
        clock: () => new Date("2026-09-08T01:00:00.000Z"),
        correlationId: () => ids.correlation,
        activityId: () => ids.activity,
        occurrenceId: () => ids.occurrence,
        resolvedRequestTransaction: transactionRunner(requestQuery),
      });
      const result = await service.save(
        session,
        selection,
        createCommand(ids.thirdCommand, {
          [ids.visibleField]: "Amount",
          ...(scenario === "missing-explicit"
            ? { [ids.moneyField]: { amount: "4.50", currency: "USD" } }
            : {}),
        }),
      );

      expect(settingsReads).toBe(1);
      expect(roles.slice(-2)).toEqual([
        "set local role vortex_request",
        "set local role vortex_runtime",
      ]);
      if (scenario === "missing-explicit") {
        expect(result).toMatchObject({ kind: "available", value: { outcome: "saved" } });
        expect(terminalCalls).toBe(1);
      } else if (scenario === "missing-default") {
        expect(result).toEqual({
          kind: "available",
          value: {
            contractVersion: "2.0.0",
            outcome: "refused",
            error: {
              code: "operation_refused",
              messageKey: "errors.operation_refused",
              correlationId: ids.correlation,
            },
          },
        });
        expect(terminalCalls).toBe(0);
      } else {
        expect(result).toEqual({ kind: "unavailable" });
        expect(terminalCalls).toBe(0);
      }
    }
  });

  it("calculates generated values in the protected create and update candidate", async () => {
    const persistedValues: unknown[] = [];
    let preparations = 0;
    let writes = 0;
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings, ...values) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_base_record_save")) {
        preparations += 1;
        return [
          {
            preparation: {
              outcome: "prepared",
              recordType: calculatedRecordType(),
              existingValues:
                preparations === 1
                  ? {}
                  : {
                      [ids.visibleField]: "Created",
                      [ids.calculatedField]: "Created",
                    },
              readableFieldIds: [ids.visibleField, ids.calculatedField],
              correlationId: ids.correlation,
            },
          },
        ] as unknown as readonly Row[];
      }
      if (sql.includes("read_current_organization_runtime_settings_for_application"))
        return [runtimeSettingsRow("NZD")] as unknown as readonly Row[];
      if (sql.includes("save_base_record")) {
        writes += 1;
        persistedValues.push(JSON.parse(String(values[6])));
        return [
          {
            result: {
              outcome: "saved",
              recordId: ids.record,
              concurrencyNumber: writes,
              values: JSON.parse(String(values[6])),
              correlationId: ids.correlation,
              backgroundDelivery: "none",
            },
          },
        ] as unknown as readonly Row[];
      }
      return [] as unknown as readonly Row[];
    };
    const service = createRecordSaveService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-08T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId: () => ids.activity,
      occurrenceId: () => ids.occurrence,
      resolvedRequestTransaction: transactionRunner(requestQuery),
    });
    await expect(
      service.save(
        session,
        selection,
        createCommand(ids.fourthCommand, { [ids.visibleField]: "Created" }),
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        outcome: "saved",
        readableValues: {
          [ids.visibleField]: "Created",
          [ids.calculatedField]: "Created",
        },
      },
    });
    await expect(
      service.save(session, selection, {
        ...updateCommand("Updated"),
        commandId: ids.thirdCommand,
      }),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        outcome: "saved",
        readableValues: {
          [ids.visibleField]: "Updated",
          [ids.calculatedField]: "Updated",
        },
      },
    });
    await expect(
      service.save(
        session,
        selection,
        createCommand(ids.secondCommand, {
          [ids.visibleField]: "Rejected",
          [ids.calculatedField]: "Caller-supplied",
        }),
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "correction_required" },
    });

    expect(persistedValues).toEqual([
      { [ids.visibleField]: "Created", [ids.calculatedField]: "Created" },
      { [ids.visibleField]: "Updated", [ids.calculatedField]: "Updated" },
    ]);
    expect(writes).toBe(2);
  });

  it("calculates a non-time value when organisation runtime settings are absent", async () => {
    let writes = 0;
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings, ...values) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_base_record_save"))
        return [
          {
            preparation: {
              outcome: "prepared",
              recordType: calculatedRecordType(),
              existingValues: {},
              readableFieldIds: [ids.visibleField, ids.calculatedField],
              correlationId: ids.correlation,
            },
          },
        ] as unknown as readonly Row[];
      if (sql.includes("read_current_organization_runtime_settings_for_application"))
        return [] as unknown as readonly Row[];
      if (sql.includes("save_base_record")) {
        writes += 1;
        const savedValues = JSON.parse(String(values[6]));
        return [
          {
            result: {
              outcome: "saved",
              recordId: ids.record,
              concurrencyNumber: 1,
              values: savedValues,
              correlationId: ids.correlation,
              backgroundDelivery: "none",
            },
          },
        ] as unknown as readonly Row[];
      }
      return [] as unknown as readonly Row[];
    };
    const service = createRecordSaveService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-08T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId: () => ids.activity,
      occurrenceId: () => ids.occurrence,
      resolvedRequestTransaction: transactionRunner(requestQuery),
    });

    await expect(
      service.save(
        session,
        selection,
        createCommand(ids.fourthCommand, { [ids.visibleField]: "No settings needed" }),
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        outcome: "saved",
        readableValues: { [ids.calculatedField]: "No settings needed" },
      },
    });
    expect(writes).toBe(1);
  });

  it("calculates an instant deadline when organisation runtime settings are absent", async () => {
    let writes = 0;
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings, ...values) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_base_record_save"))
        return [
          {
            preparation: {
              outcome: "prepared",
              recordType: instantDeadlineRecordType(),
              existingValues: {},
              readableFieldIds: [ids.visibleField, ids.dueDateField, ids.deadlineField],
              correlationId: ids.correlation,
            },
          },
        ] as unknown as readonly Row[];
      if (sql.includes("read_current_organization_runtime_settings_for_application"))
        return [] as unknown as readonly Row[];
      if (sql.includes("save_base_record")) {
        writes += 1;
        const savedValues = JSON.parse(String(values[6]));
        return [
          {
            result: {
              outcome: "saved",
              recordId: ids.record,
              concurrencyNumber: 1,
              values: savedValues,
              correlationId: ids.correlation,
              backgroundDelivery: "none",
            },
          },
        ] as unknown as readonly Row[];
      }
      return [] as unknown as readonly Row[];
    };
    const service = createRecordSaveService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-08T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId: () => ids.activity,
      occurrenceId: () => ids.occurrence,
      resolvedRequestTransaction: transactionRunner(requestQuery),
    });

    await expect(
      service.save(
        session,
        selection,
        createCommand(ids.fourthCommand, {
          [ids.visibleField]: "Instant deadline",
          [ids.dueDateField]: "2026-09-08T00:30:00.000Z",
        }),
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "saved", readableValues: { [ids.deadlineField]: true } },
    });
    expect(writes).toBe(1);
  });

  it("uses the request-issued instant and organisation-local date for a deadline", async () => {
    expect(() => deadlineRecordType()).not.toThrow();
    const clock = vi.fn(() => new Date("2026-09-08T12:30:00.000Z"));
    const persistedValues: unknown[] = [];
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings, ...values) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_base_record_save"))
        return [
          {
            preparation: {
              outcome: "prepared",
              recordType: deadlineRecordType(),
              existingValues: {},
              readableFieldIds: [ids.visibleField, ids.dueDateField, ids.deadlineField],
              correlationId: ids.correlation,
            },
          },
        ] as unknown as readonly Row[];
      if (sql.includes("read_current_organization_runtime_settings_for_application"))
        return [runtimeSettingsRow("NZD")] as unknown as readonly Row[];
      if (sql.includes("save_base_record")) {
        const savedValues = JSON.parse(String(values[6]));
        persistedValues.push(savedValues);
        return [
          {
            result: {
              outcome: "saved",
              recordId: ids.record,
              concurrencyNumber: 1,
              values: savedValues,
              correlationId: ids.correlation,
              backgroundDelivery: "none",
            },
          },
        ] as unknown as readonly Row[];
      }
      return [] as unknown as readonly Row[];
    };
    const service = createRecordSaveService({
      identityAuthorityId: ids.authority,
      clock,
      correlationId: () => ids.correlation,
      activityId: () => ids.activity,
      occurrenceId: () => ids.occurrence,
      resolvedRequestTransaction: transactionRunner(requestQuery),
    });
    const deadlineSession = {
      ...session,
      accessTokenExpiresAt: "2026-09-09T12:00:00.000Z",
    };

    await expect(
      service.save(
        deadlineSession,
        selection,
        createCommand(ids.thirdCommand, {
          [ids.visibleField]: "Boundary",
          [ids.dueDateField]: "2026-09-08",
        }),
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "saved", readableValues: { [ids.deadlineField]: true } },
    });
    expect(persistedValues).toEqual([
      {
        [ids.visibleField]: "Boundary",
        [ids.dueDateField]: "2026-09-08",
        [ids.deadlineField]: true,
      },
    ]);
    expect(clock).toHaveBeenCalledTimes(1);
  });
});
