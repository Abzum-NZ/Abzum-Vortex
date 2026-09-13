import {
  organizationRuntimeSettingsSchema,
  type OrganizationRuntimeSettings,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RuntimeDatabaseTransaction } from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import {
  createOrganizationRuntimeSettingsStore,
  type OrganizationRuntimeSettingsError,
} from "../src/organization-runtime-settings";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const settings = (): OrganizationRuntimeSettings =>
  organizationRuntimeSettingsSchema.parse({
    organizationId: id(4),
    language: "en-NZ",
    timeZone: "Pacific/Auckland",
    currency: "NZD",
    dateFormat: "medium",
    numberFormat: "auto",
    revision: 1,
  });

const row = {
  organization_id: id(4),
  language: "en-NZ",
  time_zone: "Pacific/Auckland",
  currency: "NZD",
  date_format: "medium",
  number_format: "auto",
  revision: "1",
};

const statement = (strings: TemplateStringsArray): string => strings.join("$value");

const runtimeRunner =
  (
    rows: readonly DatabaseRow[],
    calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [],
  ) =>
  async <Result>(
    operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> =>
    operation({
      query: async <Row extends DatabaseRow>(
        strings: TemplateStringsArray,
        ...values: readonly DatabaseValue[]
      ) => {
        calls.push({ text: statement(strings), values });
        return rows as readonly Row[];
      },
    });

const runtimeTransaction = (
  calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [],
): RuntimeDatabaseTransaction => ({
  query: async <Row extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => {
    calls.push({ text: statement(strings), values });
    return [] as readonly Row[];
  },
});

describe("organisation runtime settings store", () => {
  it("initializes exactly the contract-validated settings through the trusted Identity operation", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const store = createOrganizationRuntimeSettingsStore({
      runtimeTransaction: runtimeRunner([row], calls),
    });

    await expect(store.initialize(settings())).resolves.toEqual(settings());
    expect(calls[0]?.text).toContain("initialize_organization_runtime_settings");
    expect(calls[0]?.values).toEqual([id(4), "en-NZ", "Pacific/Auckland", "NZD", "medium", "auto"]);
  });

  it("refuses malformed setup before opening a trusted transaction", async () => {
    const runtimeTransaction = vi.fn();
    const store = createOrganizationRuntimeSettingsStore({ runtimeTransaction });

    await expect(store.initialize({ ...settings(), currency: "nzd" })).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_RUNTIME_SETTINGS",
    } satisfies Partial<OrganizationRuntimeSettingsError>);
    await expect(store.initialize({ ...settings(), revision: 2 })).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_RUNTIME_SETTINGS",
    } satisfies Partial<OrganizationRuntimeSettingsError>);
    expect(runtimeTransaction).not.toHaveBeenCalled();
  });

  it("stages only a contract-validated update before the request role is entered", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const store = createOrganizationRuntimeSettingsStore();
    await expect(
      store.stageUpdate(runtimeTransaction(calls), {
        ...settings(),
        currency: "USD",
        revision: 2,
      }),
    ).resolves.toBeUndefined();
    expect(calls[0]?.text).toContain("stage_organization_runtime_settings_update");
    expect(calls[0]?.values).toEqual([
      JSON.stringify({ ...settings(), currency: "USD", revision: 2 }),
    ]);

    await expect(
      store.stageUpdate(runtimeTransaction(), { ...settings(), currency: "nzd" }),
    ).rejects.toMatchObject({ code: "INVALID_ORGANIZATION_RUNTIME_SETTINGS" });
    await expect(
      store.stageUpdate(runtimeTransaction(), { ...settings(), timeZone: "Pacific/Invalid" }),
    ).rejects.toMatchObject({ code: "INVALID_ORGANIZATION_RUNTIME_SETTINGS" });
  });

  it("accepts canonical BCP-47 language tags longer than the old database-only cap", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const store = createOrganizationRuntimeSettingsStore();
    const language = "en-US-u-ca-gregory-co-phonebk-nu-latn-x-example";

    await expect(
      store.stageUpdate(runtimeTransaction(calls), { ...settings(), language }),
    ).resolves.toBeUndefined();
    expect(calls[0]?.values).toEqual([JSON.stringify({ ...settings(), language })]);
  });
});
