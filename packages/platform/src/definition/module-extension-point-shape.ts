import { z } from "zod";
import { builderKeySchema } from "../catalogue/identifiers";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";
import type { ApplicationUsePlace } from "./application-uses";

/** Actual published or installed contributions, read in the owner's organisation. */
export const moduleExtensionPointUseSchema = z
  .object({
    moduleKey: z.string().min(1),
    extensionPointKey: builderKeySchema,
    kind: z.enum(["field", "action"]),
    contributorName: z.string().min(1),
  })
  .strict();
export type ModuleExtensionPointUse = z.infer<typeof moduleExtensionPointUseSchema>;

type Point = ApplicationSourceDocument["body"]["modules"][number]["extension_points"][number];
type Result =
  | Readonly<{ kind: "changed"; source: ApplicationSourceDocument; pointId: string }>
  | Readonly<{ kind: "invalid"; issues: readonly string[]; field?: "key" | "record" | "accepts" }>
  | Readonly<{ kind: "referenced"; issue: string; references: readonly ApplicationUsePlace[] }>;

/** The contract has no separate label: the permanent key supplies its displayed name. */
export const moduleExtensionPointName = (key: string): string => {
  const words = key.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const referenced = (uses: readonly ModuleExtensionPointUse[]): Result => ({
  kind: "referenced",
  issue:
    "This extension is used by a contribution. Remove its uses before changing its target, accepted kinds or deleting it.",
  references: uses.map((use) => ({
    label: `${use.contributorName} (${use.kind === "field" ? "field" : "action"} contribution)`,
    open: { kind: "none" },
  })),
});

/** One source command for creation, editing and removal; existing identities never change. */
export const changeInlineModuleExtensionPoint = (
  current: ApplicationSourceDocument,
  change:
    | Readonly<{ operation: "remove"; moduleKey: string; pointId: string }>
    | Readonly<{
        operation: "save";
        moduleKey: string;
        pointId?: string;
        key: string;
        recordKey: string;
        accepts: readonly string[];
      }>,
  uses: readonly ModuleExtensionPointUse[],
): Result => {
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === change.moduleKey);
  if (module === undefined)
    return { kind: "invalid", issues: ["Choose a module owned by this application."] };
  const existing = module.extension_points.find((point) => point.id === change.pointId);
  if (change.pointId !== undefined && existing === undefined)
    return { kind: "invalid", issues: ["This extension is no longer in the module."] };
  const references = uses.filter(
    (use) => use.moduleKey === module.key && use.extensionPointKey === existing?.key,
  );
  if (change.operation === "remove") {
    if (references.length > 0) return referenced(references);
    module.extension_points = module.extension_points.filter((point) => point !== existing);
  } else {
    const key = change.key.trim();
    if (!builderKeySchema.safeParse(key).success)
      return {
        kind: "invalid",
        field: "key",
        issues: ["Use lowercase words separated by underscores, up to 40 characters."],
      };
    if (existing !== undefined && key !== existing.key)
      return { kind: "invalid", field: "key", issues: ["An extension's key is permanent."] };
    if (module.extension_points.some((point) => point !== existing && point.key === key))
      return {
        kind: "invalid",
        field: "key",
        issues: ["This module already has an extension with that key."],
      };
    if (!module.record_types.some((record) => record.key === change.recordKey))
      return {
        kind: "invalid",
        field: "record",
        issues: ["Choose a record type owned by this module."],
      };
    if (
      change.accepts.length === 0 ||
      change.accepts.some((kind) => kind !== "field" && kind !== "action") ||
      new Set(change.accepts).size !== change.accepts.length
    )
      return {
        kind: "invalid",
        field: "accepts",
        issues: ["Choose Fields, Actions, or both, once each."],
      };
    const accepts = ["field", "action"].filter((kind) =>
      change.accepts.includes(kind),
    ) as Point["accepts"];
    if (
      existing !== undefined &&
      (existing.record_type !== change.recordKey ||
        references.some((use) => !accepts.includes(use.kind)))
    )
      if (references.length > 0) return referenced(references);
    // Aliases share the source identity namespace. Derive a distinct alias once, never on edit.
    const aliases = new Set<string>();
    const collect = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      if ("id" in value && typeof value.id === "string") aliases.add(value.id);
      for (const child of Object.values(value)) collect(child);
    };
    collect(source);
    const base = `extension_${key}`;
    let id = base;
    for (let suffix = 2; aliases.has(id); suffix += 1) id = `${base}_${suffix}`;
    const point: Point = { id: existing?.id ?? id, key, record_type: change.recordKey, accepts };
    if (existing === undefined) module.extension_points.push(point);
    else module.extension_points[module.extension_points.indexOf(existing)] = point;
  }
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  return parsed.success
    ? {
        kind: "changed",
        source: parsed.data,
        pointId:
          change.operation === "remove"
            ? change.pointId
            : module.extension_points.find((point) => point.key === change.key.trim())!.id,
      }
    : {
        kind: "invalid",
        issues: parsed.error.issues.map((issue) => `${issue.message} (${issue.path.join(" / ")})`),
      };
};
