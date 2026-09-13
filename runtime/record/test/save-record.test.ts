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
    const activityId = vi.fn(() => ids.activity);
    const occurrenceId = vi.fn(() => ids.occurrence);
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings) => {
      const sql = strings.join("$value");
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
    expect(activityId).toHaveBeenCalledTimes(3);
    expect(occurrenceId).toHaveBeenCalledTimes(1);
  });

  it("does not call the terminal writer after preparation records a clean refusal", async () => {
    let terminalCalls = 0;
    const activityId = vi.fn(() => ids.activity);
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_base_record_save"))
        return [{ preparation: { outcome: "refused_recorded" } }] as unknown as readonly Row[];
      if (sql.includes("save_base_record")) terminalCalls += 1;
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
});
