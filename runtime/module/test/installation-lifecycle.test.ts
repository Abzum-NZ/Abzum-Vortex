import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it } from "vitest";
import {
  ApplicationInstallationLifecycleError,
  createApplicationInstallationLifecycleRepository,
} from "../src/installation-lifecycle";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const command = {
  applicationRootId: id(1),
  applicationReleaseRevision: 4,
  expectedModuleBindings: [
    { moduleRootId: id(2), bindingRevision: 2 },
    { moduleRootId: id(3), bindingRevision: 1 },
  ],
} as const;
const activeResult = {
  organizationId: id(4),
  applicationRootId: id(1),
  applicationReleaseRevision: 4,
  state: "active",
  changed: true,
  moduleBindings: command.expectedModuleBindings.map((binding) => ({
    organizationId: id(4),
    applicationRootId: id(1),
    moduleRootId: binding.moduleRootId,
    bindingRevision: binding.bindingRevision + 1,
    applicationReleaseRevision: 4,
    moduleReleaseRevision: 1,
    state: "active" as const,
  })),
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

describe("Application installation lifecycle repository", () => {
  it("calls only the fixed Application-wide activation operation", async () => {
    const calls: QueryCall[] = [];
    await expect(
      createApplicationInstallationLifecycleRepository(
        transactionFor([{ lifecycle_result: activeResult }], calls),
      ).activate(command),
    ).resolves.toEqual(activeResult);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_module.activate_application_installation");
    expect(calls[0]?.values).toEqual([
      command.applicationRootId,
      4,
      JSON.stringify(command.expectedModuleBindings),
    ]);
  });

  it("calls only the fixed Application-wide detach operation", async () => {
    const calls: QueryCall[] = [];
    const detached = {
      ...activeResult,
      state: "detached",
      moduleBindings: activeResult.moduleBindings.map((binding) => ({
        ...binding,
        state: "detached",
      })),
    } as const;
    await expect(
      createApplicationInstallationLifecycleRepository(
        transactionFor([{ lifecycle_result: detached }], calls),
      ).detach(command),
    ).resolves.toEqual(detached);
    expect(calls[0]?.text).toContain("vortex_module.detach_application_installation");
  });

  it("refuses malformed commands before querying", async () => {
    const calls: QueryCall[] = [];
    await expect(
      createApplicationInstallationLifecycleRepository(transactionFor([], calls)).activate({
        ...command,
        expectedModuleBindings: [...command.expectedModuleBindings].reverse(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_APPLICATION_INSTALLATION_LIFECYCLE_COMMAND" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["22023", "INVALID_APPLICATION_INSTALLATION_LIFECYCLE_COMMAND"],
    ["42501", "APPLICATION_INSTALLATION_AUTHORITY_REFUSED"],
    ["P0002", "APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE"],
    ["40001", "APPLICATION_INSTALLATION_BINDING_CONFLICT"],
    ["23514", "APPLICATION_INSTALLATION_BINDINGS_INCOMPLETE"],
    ["55000", "APPLICATION_INSTALLATION_BINDINGS_INCOMPLETE"],
    ["XX000", "APPLICATION_INSTALLATION_CHANGE_FAILED"],
  ] as const)("maps SQLSTATE %s to safe code %s", async (code, expected) => {
    await expect(
      createApplicationInstallationLifecycleRepository(
        transactionFor(Object.assign(new Error("private detail"), { code })),
      ).activate(command),
    ).rejects.toEqual(new ApplicationInstallationLifecycleError(expected));
  });

  it("refuses missing or malformed lifecycle evidence", async () => {
    for (const rows of [
      [],
      [{ lifecycle_result: null }],
      [{ lifecycle_result: { ...activeResult, moduleBindings: [] } }],
    ])
      await expect(
        createApplicationInstallationLifecycleRepository(transactionFor(rows)).activate(command),
      ).rejects.toMatchObject({ code: "APPLICATION_INSTALLATION_CHANGE_FAILED" });
  });
});
