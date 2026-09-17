import {
  actionDefinitionV2Schema,
  recordTypeDefinitionV2Schema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import type {
  DatabaseRow,
  RequestDatabaseTransaction,
  RuntimeDatabaseTransaction,
} from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import {
  createNamedActionService,
  type NamedActionServiceDependencies,
} from "../src/named-actions";

vi.mock("server-only", () => ({}));

const id = (value: number) => `71000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const ids = {
  identity: id(1),
  session: id(2),
  organization: id(3),
  application: id(4),
  authority: id(5),
  tenant: id(6),
  account: id(7),
  correlation: id(8),
  module: id(9),
  recordType: id(10),
  storage: id(11),
  field: id(12),
  action: id(13),
  record: id(14),
  command: id(15),
  activity: id(16),
  occurrence: id(17),
} as const;

const session: IdentitySession = {
  identityId: ids.identity,
  sessionId: ids.session,
  authenticationStrength: "multi_factor",
  accessTokenIssuedAt: "2026-09-15T00:00:00.000Z",
  accessTokenExpiresAt: "2026-09-15T02:00:00.000Z",
};
const selection: OrganizationSelectionCandidate = {
  organizationId: ids.organization,
  applicationRootId: ids.application,
};
const recordType = recordTypeDefinitionV2Schema.parse({
  recordTypeId: ids.recordType,
  key: "item",
  singularLabel: "Item",
  pluralLabel: "Items",
  titleFieldId: ids.field,
  storageContractId: ids.storage,
  storageScope: "application_contained",
  ownershipMode: "none",
  fields: [
    {
      fieldId: ids.field,
      key: "title",
      label: "Title",
      required: true,
      unique: false,
      filterable: true,
      sortable: true,
      personalData: "none",
      publicDisplay: "refused",
      type: "text",
      settings: { maxLength: 40 },
    },
  ],
  relationships: [],
  standardActions: ["read"],
  customActionIds: [ids.action],
});
const action = actionDefinitionV2Schema.parse({
  actionId: ids.action,
  key: "example.item.rename",
  label: "Rename",
  subjectRecordTypeId: ids.recordType,
  permissionKey: "example.item.rename",
  sharing: "refused",
  inputs: [{ key: "title", label: "Title", required: true, type: "text" }],
  effects: [
    { kind: "set_field", fieldId: ids.field, value: { source: "input", inputKey: "title" } },
  ],
});

type RequestQuery = <Row extends DatabaseRow>(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => Promise<readonly Row[]>;

const transactionRunner =
  (
    requestQuery: RequestQuery,
  ): NonNullable<NamedActionServiceDependencies["resolvedRequestTransaction"]> =>
  async (resolve, operation) => {
    const resolved = await resolve({
      query: async <Row extends DatabaseRow>() =>
        [
          {
            tenant_id: ids.tenant,
            organization_id: ids.organization,
            organization_account_id: ids.account,
            application_root_id: ids.application,
            access_version: "1",
          },
        ] as unknown as readonly Row[],
    } satisfies RuntimeDatabaseTransaction);
    return operation(
      {
        query: requestQuery,
      } satisfies RequestDatabaseTransaction,
      resolved.scope,
    );
  };

describe("named action service", () => {
  it("composes typed input and reaches only the total-aware terminal writer", async () => {
    const queries: string[] = [];
    let prepareCalls = 0;
    const query: RequestQuery = async <Row extends DatabaseRow>(strings) => {
      const sql = strings.join("$value");
      queries.push(sql);
      if (
        sql.includes("preview_named_action_set_announce") ||
        sql.includes("prepare_named_action_set_announce(")
      ) {
        prepareCalls += 1;
        return [
          {
            value: {
              outcome: prepareCalls === 1 ? "previewed" : "prepared",
              action,
              validationContractVersion: "2.0.0",
              recordType,
              recordId: ids.record,
              existingValues: { [ids.field]: "Before" },
              readableFieldIds: [ids.field],
              changeableFieldIds: [ids.field],
              eventDescriptors: [],
              actorOrganizationAccountId: ids.account,
              correlationId: ids.correlation,
            },
          },
        ] as unknown as readonly Row[];
      }
      if (sql.includes("prepare_named_action_relationship_totals"))
        return [{ value: { outcome: "not_required" } }] as unknown as readonly Row[];
      if (sql.includes("validate_named_action_reference_inputs"))
        return [{ value: true }] as unknown as readonly Row[];
      if (sql.includes("read_current_organization_runtime_settings_for_application"))
        return [
          {
            organization_id: ids.organization,
            language: "en-NZ",
            time_zone: "Pacific/Auckland",
            currency: "NZD",
            date_format: "medium",
            number_format: "auto",
            revision: "1",
          },
        ] as unknown as readonly Row[];
      if (sql.includes("save_named_action_set_announce_with_relationship_totals"))
        return [
          {
            value: {
              outcome: "saved",
              recordId: ids.record,
              concurrencyNumber: 3,
              values: { [ids.field]: "After" },
              correlationId: ids.correlation,
              backgroundDelivery: "pending",
            },
          },
        ] as unknown as readonly Row[];
      return [] as unknown as readonly Row[];
    };
    const occurrenceId = vi.fn(() => ids.occurrence);
    const service = createNamedActionService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-15T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId: () => ids.activity,
      occurrenceId,
      resolvedRequestTransaction: transactionRunner(query),
    });

    await expect(
      service.execute(session, selection, {
        contractVersion: "2.0.0",
        commandId: ids.command,
        action: {
          ownerKind: "module",
          ownerId: ids.module,
          releaseRevision: 1,
          actionId: ids.action,
        },
        recordTypeId: ids.recordType,
        recordId: ids.record,
        expectedConcurrencyNumber: 2,
        inputs: { title: "After" },
      }),
    ).resolves.toEqual({
      kind: "available",
      value: {
        contractVersion: "2.0.0",
        outcome: "completed",
        recordId: ids.record,
        concurrencyNumber: 3,
        readableValues: { [ids.field]: "After" },
        correlationId: ids.correlation,
        backgroundDelivery: "pending",
      },
    });
    expect(prepareCalls).toBe(2);
    expect(occurrenceId).toHaveBeenCalledTimes(1);
    expect(
      queries.filter((sql) =>
        sql.includes("save_named_action_set_announce_with_relationship_totals"),
      ),
    ).toHaveLength(1);
    expect(queries.some((sql) => sql.includes("save_base_record_with_relationship_totals"))).toBe(
      false,
    );
  });

  it("turns a preview denial into exactly one locked owning refusal", async () => {
    let preparationCalls = 0;
    const queries: string[] = [];
    const query: RequestQuery = async <Row extends DatabaseRow>(strings) => {
      const sql = strings.join("$value");
      queries.push(sql);
      if (sql.includes("preview_named_action_set_announce")) {
        preparationCalls += 1;
        return [
          { value: { outcome: "permission_refused", correlationId: ids.correlation } },
        ] as unknown as readonly Row[];
      }
      if (sql.includes("prepare_named_action_set_announce(")) {
        preparationCalls += 1;
        return [
          { value: { outcome: "refused_recorded", correlationId: ids.correlation } },
        ] as unknown as readonly Row[];
      }
      return [] as unknown as readonly Row[];
    };
    const service = createNamedActionService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-15T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId: () => ids.activity,
      occurrenceId: () => ids.occurrence,
      resolvedRequestTransaction: transactionRunner(query),
    });
    await expect(
      service.execute(session, selection, {
        contractVersion: "2.0.0",
        commandId: ids.command,
        action: {
          ownerKind: "module",
          ownerId: ids.module,
          releaseRevision: 1,
          actionId: ids.action,
        },
        recordTypeId: ids.recordType,
        recordId: ids.record,
        expectedConcurrencyNumber: 2,
        inputs: { title: "After" },
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(preparationCalls).toBe(2);
    expect(queries.some((sql) => sql.includes("prepare_named_action_relationship_totals"))).toBe(
      false,
    );
    expect(
      queries.some((sql) =>
        sql.includes("save_named_action_set_announce_with_relationship_totals"),
      ),
    ).toBe(false);
  });
});
