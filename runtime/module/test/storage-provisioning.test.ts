import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it } from "vitest";
import {
  createModuleInstallationStorageRepository,
  ModuleInstallationStorageError,
} from "../src/storage-provisioning";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fingerprint = (digit: string): string => `sha256:${digit.repeat(64)}`;
const command = {
  applicationRootId: id(1),
  applicationReleaseRevision: 4,
  moduleRootId: id(2),
  moduleReleaseRevision: 3,
  expectedBindingRevision: null,
} as const;

type QueryCall = Readonly<{ text: string; values: readonly DatabaseValue[] }>;

const transactionFor = (
  response: readonly DatabaseRow[] | Error,
  calls: QueryCall[] = [],
): RequestDatabaseTransaction => ({
  query: async <Row extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => {
    calls.push({ text: strings.join("$value"), values });
    if (response instanceof Error) throw response;
    return response as readonly Row[];
  },
});

const resultRow = {
  state: "provisioned",
  changed: true,
  binding_revision: "1",
  application_root_id: command.applicationRootId,
  application_release_revision: 4n,
  module_root_id: command.moduleRootId,
  module_release_revision: "3",
  content_fingerprint: fingerprint("a"),
  resolution_fingerprint: fingerprint("b"),
  generator_contract_version: "1.0.0",
  storage_contract_ids: [id(3), id(4)],
};

describe("Module installation storage repository", () => {
  it("calls only the fixed coordinator with exact release identities", async () => {
    const calls: QueryCall[] = [];
    const repository = createModuleInstallationStorageRepository(
      transactionFor([resultRow], calls),
    );

    await expect(repository.provision(command)).resolves.toEqual({
      state: "provisioned",
      changed: true,
      bindingRevision: 1,
      applicationRootId: command.applicationRootId,
      applicationReleaseRevision: 4,
      moduleRootId: command.moduleRootId,
      moduleReleaseRevision: 3,
      contentFingerprint: fingerprint("a"),
      resolutionFingerprint: fingerprint("b"),
      generatorContractVersion: "1.0.0",
      storageContractIds: [id(3), id(4)],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_module.provision_module_installation_storage");
    expect(calls[0]?.values).toEqual([command.applicationRootId, 4, command.moduleRootId, 3, null]);
    expect(calls[0]?.text).not.toContain("record_data");
  });

  it("refuses invalid caller-selected input before querying", async () => {
    const calls: QueryCall[] = [];
    const repository = createModuleInstallationStorageRepository(transactionFor([], calls));
    await expect(
      repository.provision({ ...command, expectedBindingRevision: 0 }),
    ).rejects.toMatchObject({
      code: "INVALID_MODULE_INSTALLATION_STORAGE_COMMAND",
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["22023", "INVALID_MODULE_INSTALLATION_STORAGE_COMMAND"],
    ["42501", "MODULE_INSTALLATION_AUTHORITY_REFUSED"],
    ["P0002", "MODULE_INSTALLATION_RELEASE_UNAVAILABLE"],
    ["23514", "MODULE_INSTALLATION_RELEASE_MISMATCH"],
    ["40001", "MODULE_INSTALLATION_BINDING_CONFLICT"],
    ["55000", "RECORD_STORAGE_INCOMPATIBLE"],
    ["XX000", "RECORD_STORAGE_PROVISIONING_FAILED"],
  ] as const)("maps SQLSTATE %s without exposing database details", async (code, expected) => {
    const databaseError = Object.assign(new Error("private database detail"), { code });
    const repository = createModuleInstallationStorageRepository(transactionFor(databaseError));
    await expect(repository.provision(command)).rejects.toEqual(
      new ModuleInstallationStorageError(expected),
    );
  });

  it("refuses malformed or ambiguous database evidence", async () => {
    for (const rows of [[], [resultRow, resultRow], [{ ...resultRow, state: "active" }]]) {
      const repository = createModuleInstallationStorageRepository(transactionFor(rows));
      await expect(repository.provision(command)).rejects.toMatchObject({
        code: "RECORD_STORAGE_PROVISIONING_FAILED",
      });
    }
  });
});
