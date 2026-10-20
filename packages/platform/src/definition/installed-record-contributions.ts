import "server-only";

import { z } from "zod";
import { sameId, type SystemApplicationBoundReleaseSetResult } from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import { DefinitionError } from "./definition-error";
import { moduleFieldSchema } from "./module-contracts";

/**
 * The exact installed contributions on the record types an application's active installation binds:
 * each is a field another installed Module of the organisation added to an owner record type, with
 * the contributor's own exact field definition. The database resolves them once, from the
 * contribution storage the exact install provisioned and the contributor's active installation, and
 * serves the same fields from every record read and write; this is the one place the runtime
 * context learns them, so nothing downstream names or guesses a contributor.
 */
const installedFieldContributionSchema = z
  .object({
    kind: z.literal("field"),
    contributionId: z.uuid(),
    contributorModuleRootId: z.uuid(),
    contributorReleaseRevision: z.number().int().min(1),
    contributorApplicationRootIds: z.array(z.uuid()).min(1),
    field: moduleFieldSchema,
  })
  .strict();

const installedRecordContributionsSchema = z.array(
  z
    .object({
      moduleRootId: z.uuid(),
      recordTypeId: z.uuid(),
      contributions: z.array(installedFieldContributionSchema).min(1).max(100),
    })
    .strict(),
);

export type InstalledRecordTypeContributions = Readonly<{
  moduleRootId: string;
  recordTypeId: string;
  fields: readonly Readonly<{
    fieldId: string;
    contributorModuleRootId: string;
    contributorReleaseRevision: number;
  }>[];
}>;

type ContributedFields = ReadonlyMap<string, readonly z.infer<typeof moduleFieldSchema>[]>;

export type InstalledRecordContributions = Readonly<{
  /** The owner record types with the fields contributed to them, for the page and flow consumers. */
  recordTypes: readonly InstalledRecordTypeContributions[];
  /** The contributed field definitions by `${moduleRootId}:${recordTypeId}`, lowercase. */
  fieldsByRecordType: ContributedFields;
}>;

export const noInstalledRecordContributions: InstalledRecordContributions = Object.freeze({
  recordTypes: Object.freeze([]),
  fieldsByRecordType: new Map(),
});

const recordTypeKey = (moduleRootId: string, recordTypeId: string): string =>
  `${moduleRootId.toLowerCase()}:${recordTypeId.toLowerCase()}`;

type ContributionRow = DatabaseRow & { readonly contributions: unknown };

/** Reads the contributions under the verified human request transaction, failing loudly on any malformed row. */
export const readInstalledRecordContributions = async (
  transaction: RequestDatabaseTransaction,
): Promise<InstalledRecordContributions> => {
  const rows = await transaction.query<ContributionRow>`
    select vortex_record.read_installed_record_contributions() as contributions
  `;
  if (rows.length !== 1 || rows[0] === undefined)
    throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");
  const parsed = installedRecordContributionsSchema.safeParse(rows[0].contributions);
  if (!parsed.success) {
    console.error(
      `[contributions] installed record contributions are malformed: ${parsed.error.message}`,
    );
    throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED", {
      cause: { part: "record_contributions", reason: "malformed" },
    });
  }
  const fieldsByRecordType = new Map<string, readonly z.infer<typeof moduleFieldSchema>[]>();
  const recordTypes = parsed.data.map((entry) => {
    fieldsByRecordType.set(
      recordTypeKey(entry.moduleRootId, entry.recordTypeId),
      entry.contributions.map((contribution) => contribution.field),
    );
    return Object.freeze({
      moduleRootId: entry.moduleRootId,
      recordTypeId: entry.recordTypeId,
      fields: Object.freeze(
        entry.contributions.map((contribution) =>
          Object.freeze({
            fieldId: contribution.contributionId,
            contributorModuleRootId: contribution.contributorModuleRootId,
            contributorReleaseRevision: contribution.contributorReleaseRevision,
          }),
        ),
      ),
    });
  });
  return Object.freeze({ recordTypes: Object.freeze(recordTypes), fieldsByRecordType });
};

/**
 * The release set the context serves: each owner record type with the fields contributed to it
 * after its own, so every consumer of an installed record type (display, forms, flows, reference
 * choices) reads one effective field list, exactly the one the record paths serve. The contributed
 * field keeps its permanent identity and the contributor's definition; nothing else is merged.
 */
export const withInstalledRecordContributions = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
  contributions: InstalledRecordContributions,
): SystemApplicationBoundReleaseSetResult => {
  if (contributions.recordTypes.length === 0) return releaseSet;
  const modules = releaseSet.modules.map((module) => {
    const entries = contributions.recordTypes.filter((entry) =>
      sameId(entry.moduleRootId, module.rootId),
    );
    if (entries.length === 0) return module;
    const recordTypes = module.content.recordTypes.map((recordType) => {
      const added = contributions.fieldsByRecordType.get(
        recordTypeKey(module.rootId, recordType.recordTypeId),
      );
      return added === undefined
        ? recordType
        : Object.freeze({ ...recordType, fields: [...recordType.fields, ...added] });
    });
    return Object.freeze({
      ...module,
      content: Object.freeze({ ...module.content, recordTypes }),
    });
  });
  return { application: releaseSet.application, modules };
};
