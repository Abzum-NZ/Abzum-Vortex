import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it } from "vitest";
import {
  ActiveApplicationInstallationError,
  createActiveApplicationInstallationRepository,
} from "../src/installation-binding-reader";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const evidence = {
  organizationId: id(1),
  applicationRootId: id(2),
  applicationReleaseRevision: 7,
  moduleBindings: [
    {
      organizationId: id(1),
      applicationRootId: id(2),
      moduleRootId: id(3),
      bindingRevision: 2,
      applicationReleaseRevision: 7,
      moduleReleaseRevision: 4,
      state: "active",
    },
  ],
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

describe("active Application installation reader", () => {
  it("calls one fixed no-input reader and parses complete active evidence", async () => {
    const calls: QueryCall[] = [];
    const repository = createActiveApplicationInstallationRepository(
      transactionFor([{ active_installation: evidence }], calls),
    );
    await expect(repository.readCurrent()).resolves.toEqual(evidence);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_module.read_current_active_installation()");
    expect(calls[0]?.values).toEqual([]);
  });

  it("refuses absent, partial, mixed and malformed evidence", async () => {
    const invalidRows: readonly (readonly DatabaseRow[])[] = [
      [],
      [{ active_installation: null }],
      [{ active_installation: { ...evidence, moduleBindings: [] } }],
      [
        {
          active_installation: {
            ...evidence,
            moduleBindings: [{ ...evidence.moduleBindings[0], state: "detached" }],
          },
        },
      ],
    ];
    for (const rows of invalidRows)
      await expect(
        createActiveApplicationInstallationRepository(transactionFor(rows)).readCurrent(),
      ).rejects.toMatchObject({
        code:
          rows.length === 0 || rows[0]?.active_installation === null
            ? "ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE"
            : "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE",
      });
  });

  it.each([
    ["42501", "ACTIVE_APPLICATION_CONTEXT_REFUSED"],
    ["22023", "ACTIVE_APPLICATION_CONTEXT_REFUSED"],
    ["P0002", "ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE"],
    ["23514", "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE"],
    ["55000", "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE"],
    ["XX000", "ACTIVE_APPLICATION_INSTALLATION_READ_FAILED"],
  ] as const)("maps SQLSTATE %s to safe code %s", async (code, expected) => {
    await expect(
      createActiveApplicationInstallationRepository(
        transactionFor(Object.assign(new Error("private detail"), { code })),
      ).readCurrent(),
    ).rejects.toEqual(new ActiveApplicationInstallationError(expected));
  });
});
