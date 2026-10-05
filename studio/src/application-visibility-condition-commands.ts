import {
  applicationRootIdSchema, applicationSourceDocumentV2Schema, organizationIdSchema,
  revisionSchema, fingerprintSchema, timestampSchema,
  sourceQualifiedConditionSchema,
  namespacedKeySchema, moduleRootIdSchema, recordTypeIdSchema, semanticVersionSchema,
  moduleFieldV3Schema, moduleFieldValueV2Schemas, builderKeySchema,
  type ApplicationSourceDocumentV2, type ConditionNode, type ModuleFieldV3,
} from "@vortex/contracts";
import { validateStudioCondition, type StudioConditionControlsContext,
  type StudioConditionValidation, type StudioConditionValidationIssue } from "./condition-controls";
import type { StudioCompositionContext } from "./application-composition-commands";
import type { StudioSemanticSelection } from "./semantic-selection";

type SourceQualifiedCondition = NonNullable<ApplicationSourceDocumentV2["body"]["shells"][number]["layout"]
  ["placements"][string]["visibility_condition"]>;

export type StudioApplicationConditionContext = Readonly<{
  organizationId: string; rootId: string; key: string; draftRevision: number;
  sourceFingerprint: string; publishedRevision: number | null; createdAt: string; updatedAt: string;
  bindingsSignature: string; resolutionFingerprint: string; pageAlias: string;
  recordReference: string; recordTypeId: string;
  module: Readonly<{ organizationId: string; key: string; rootId: string; releaseRevision: number;
    releaseVersion: string; contentFingerprint: string; resolutionFingerprint: string }>;
  fields: readonly Readonly<{ field: ModuleFieldV3; aliases: readonly string[];
    preferredAlias: string; componentOwner: string }>[];
}>;
export type StudioApplicationConditionContextResult =
  | Readonly<{ kind: "available"; context: StudioApplicationConditionContext }>
  | Readonly<{ kind: "refused" | "conflict" | "temporarily_unavailable" }>;

const supportedTypes = new Set(["text", "long_text", "whole_number", "yes_no", "date", "date_time"]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const sourceAliasValid = (value: unknown): value is string => typeof value === "string" &&
  value.length >= 1 && value.length <= 160 && /^[a-z][a-z0-9_]*$/.test(value);
const qualifiedFieldValid = (field: unknown): boolean =>
  sourceQualifiedConditionSchema.safeParse({ field, operator: "is_empty" }).success;

/** Finite metadata only. This boundary validates data; it never grants permission. */
export function parseStudioApplicationConditionContext(value: unknown): StudioApplicationConditionContext | undefined {
  if (!object(value) || !exactKeys(value, ["organizationId", "rootId", "key", "draftRevision",
    "sourceFingerprint", "publishedRevision", "createdAt", "updatedAt", "bindingsSignature",
    "resolutionFingerprint", "pageAlias", "recordReference", "recordTypeId", "module", "fields"]) ||
    !organizationIdSchema.safeParse(value.organizationId).success ||
    !applicationRootIdSchema.safeParse(value.rootId).success || !namespacedKeySchema.safeParse(value.key).success ||
    !revisionSchema.safeParse(value.draftRevision).success || !fingerprintSchema.safeParse(value.sourceFingerprint).success ||
    (value.publishedRevision !== null && !revisionSchema.safeParse(value.publishedRevision).success) ||
    !timestampSchema.safeParse(value.createdAt).success || !timestampSchema.safeParse(value.updatedAt).success ||
    typeof value.bindingsSignature !== "string" || value.bindingsSignature.length > 100_000 ||
    !fingerprintSchema.safeParse(value.resolutionFingerprint).success || !sourceAliasValid(value.pageAlias) ||
    typeof value.recordReference !== "string" || !qualifiedFieldValid(`${value.recordReference}.field`) ||
    !recordTypeIdSchema.safeParse(value.recordTypeId).success || !object(value.module) ||
    !Array.isArray(value.fields) || value.fields.length > 500) return undefined;
  const module = value.module;
  if (!exactKeys(module, ["organizationId", "key", "rootId", "releaseRevision", "releaseVersion",
    "contentFingerprint", "resolutionFingerprint"]) || module.organizationId !== value.organizationId ||
    !namespacedKeySchema.safeParse(module.key).success || !moduleRootIdSchema.safeParse(module.rootId).success ||
    !revisionSchema.safeParse(module.releaseRevision).success || !semanticVersionSchema.safeParse(module.releaseVersion).success ||
    !fingerprintSchema.safeParse(module.contentFingerprint).success || !fingerprintSchema.safeParse(module.resolutionFingerprint).success ||
    !(value.recordReference as string).startsWith(`${module.key}:`)) return undefined;
  const aliases = new Set<string>();
  const identifiers = new Set<string>();
  const owners = new Set<string>();
  for (const item of value.fields) {
    if (!object(item) || !exactKeys(item, ["field", "aliases", "preferredAlias", "componentOwner"]) ||
      !Array.isArray(item.aliases) || item.aliases.length < 1 || item.aliases.length > 2 ||
      !builderKeySchema.safeParse(item.preferredAlias).success || !sourceAliasValid(item.componentOwner))
      return undefined;
    const parsed = moduleFieldV3Schema.safeParse(item.field);
    if (!parsed.success || !supportedTypes.has(parsed.data.type) ||
      parsed.data.key !== item.preferredAlias || !item.aliases.includes(item.preferredAlias) ||
      identifiers.has(parsed.data.fieldId) || owners.has(item.componentOwner as string)) return undefined;
    identifiers.add(parsed.data.fieldId);
    owners.add(item.componentOwner as string);
    for (const alias of item.aliases) {
      if (!sourceAliasValid(alias) || aliases.has(alias) ||
        !qualifiedFieldValid(`${value.recordReference}.${alias}`)) return undefined;
      aliases.add(alias);
    }
  }
  // Six scalar field declarations have a bounded shape; cap their total transport size as well.
  if (JSON.stringify(value).length > 1_000_000) return undefined;
  return value as unknown as StudioApplicationConditionContext;
}

export const sameStudioVisibilityValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length &&
    left.every((entry, index) => sameStudioVisibilityValue(entry, right[index]));
  if (!object(left) || !object(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && sameStudioVisibilityValue(left[key], right[key]));
};

/** Canonical optional right operands have the same meaning when omitted or undefined. */
export const sameStudioVisibilityCondition = (left: ConditionNode | undefined, right: ConditionNode | undefined): boolean => {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind === "comparison" && right.kind === "comparison") return left.operator === right.operator &&
    sameStudioVisibilityValue(left.left, right.left) && sameStudioVisibilityValue(left.right, right.right);
  if (left.kind === "not" && right.kind === "not") return sameStudioVisibilityCondition(left.condition, right.condition);
  if ((left.kind === "all" || left.kind === "any") && (right.kind === "all" || right.kind === "any"))
    return left.kind === right.kind && left.conditions.length === right.conditions.length &&
      left.conditions.every((child, index) => sameStudioVisibilityCondition(child, right.conditions[index]));
  return false;
};

type SourceSlot = ApplicationSourceDocumentV2["body"]["shells"][number]["layout"];
type SourcePlacement = SourceSlot["placements"][string];
export type StudioVisibilityTarget = Readonly<{ pageAlias: string; recordReference: string;
  placementAlias: string; path: readonly (string | number)[]; placement: SourcePlacement }>;

/** Only a unique, directly page-owned detail placement is editable. */
export function resolveStudioVisibilityTarget(source: ApplicationSourceDocumentV2,
  selection: StudioSemanticSelection | null): StudioVisibilityTarget | undefined {
  if (selection?.kind !== "placement" || !applicationSourceDocumentV2Schema.safeParse(source).success) return undefined;
  const placementAlias = selection.placementAlias;
  const seen: { placement: SourcePlacement; path: (string | number)[]; pageAlias?: string;
    recordReference?: string; top: boolean }[] = [];
  const visit = (slot: SourceSlot, path: (string | number)[], pageAlias?: string,
    recordReference?: string, top = false) => {
    for (const [alias, placement] of Object.entries(slot.placements)) {
      const placementPath = [...path, "placements", alias];
      if (alias === placementAlias) seen.push({ placement, path: placementPath,
        ...(pageAlias === undefined ? {} : { pageAlias }),
        ...(recordReference === undefined ? {} : { recordReference }), top });
      for (const [key, child] of Object.entries(placement.slots))
        visit(child, [...placementPath, "slots", key], pageAlias, recordReference);
    }
  };
  source.body.shells.forEach((shell, index) => visit(shell.layout, ["body", "shells", index, "layout"]));
  source.body.pages.forEach((page, index) => {
    const path = ["body", "pages", index, "composition"];
    if (page.type === "guided_form") {
      if (page.composition.shell_kind === "default") {
        for (const [key, slot] of Object.entries(page.composition.step_content)) visit(slot, [...path, "step_content", key]);
      } else {
        for (const [step, slots] of Object.entries(page.composition.step_content))
          for (const [key, slot] of Object.entries(slots)) visit(slot, [...path, "step_content", step, key]);
      }
    } else {
      const slots = page.composition.shell_kind === "default" ? [["main", page.composition.main] as const]
        : Object.entries(page.composition.content);
      for (const [key, slot] of slots) visit(slot,
        page.composition.shell_kind === "default" ? [...path, key] : [...path, "content", key],
        page.type === "detail" ? page.id : undefined, page.type === "detail" ? page.record_type : undefined, true);
    }
  });
  const target = seen[0];
  if (seen.length !== 1 || target === undefined || !target.top ||
    target.pageAlias === undefined || target.recordReference === undefined) return undefined;
  return { ...target, pageAlias: target.pageAlias, recordReference: target.recordReference,
    placementAlias };
}

export function studioVisibilityControlsContext(metadata: StudioApplicationConditionContext): StudioConditionControlsContext {
  return { allowedOperands: metadata.fields.map(({ field }) => ({ operand: { source: "field", fieldId: field.fieldId },
    field, label: field.label, role: "current_field" })),
    declaredFieldIds: metadata.fields.map(({ field }) => field.fieldId), parameterDeclarations: [], allowLiteralValues: true };
}

/** Shared validation plus the existing exact scalar leaf contract, without value coercion. */
export function validateStudioVisibilityCondition(condition: ConditionNode | undefined,
  metadata: StudioApplicationConditionContext): StudioConditionValidation {
  const validation = validateStudioCondition(condition, studioVisibilityControlsContext(metadata));
  if (!validation.isValid || condition === undefined) return validation;
  const issues = [...validation.issues];
  const visit = (node: ConditionNode, path: (string | number)[]) => {
    if (node.kind === "not") { visit(node.condition, [...path, "condition"]); return; }
    if (node.kind !== "comparison") { node.conditions.forEach((child, index) => visit(child, [...path, "conditions", index])); return; }
    for (const [side, reference, literal] of [["right", node.left, node.right], ["left", node.right, node.left]] as const) {
      if (reference?.source !== "field" || literal?.source !== "value" || literal.value === null) continue;
      const field = metadata.fields.find((item) => item.field.fieldId === reference.fieldId)?.field;
      if (field === undefined) continue;
      const leaf = moduleFieldValueV2Schemas[field.type];
      const collection = side === "right" && (node.operator === "in" || node.operator === "not_in");
      const valid = collection && Array.isArray(literal.value)
        ? literal.value.every((value) => value === null || leaf.safeParse(value).success)
        : leaf.safeParse(literal.value).success;
      if (!valid) {
        const issuePath = [...path, side, "value"];
        issues.push({ code: "invalid_literal", path: issuePath,
          pointer: `/${issuePath.join("/")}`, message: "Use a literal of the selected field's exact scalar type." });
      }
    }
  };
  visit(condition, []);
  return { ...validation, issues, isValid: issues.length === 0 };
}

type Operand = Extract<ConditionNode, { kind: "comparison" }>["left"];
type SourceOperand = { source: "field"; field: string } | { source: "value"; value: Extract<Operand, { source: "value" }>["value"] };
const projectOperand = (operand: { source: string; field?: string; value?: unknown },
  metadata: StudioApplicationConditionContext): Operand => {
  if (operand.source === "value") return { source: "value", value: operand.value as Extract<Operand, { source: "value" }>["value"] };
  if (operand.source !== "field") throw new TypeError("Unsupported visibility operand");
  const matches = metadata.fields.filter((item) => item.aliases.some((alias) =>
    `${metadata.recordReference}.${alias}` === operand.field));
  if (matches.length !== 1) throw new TypeError("Unsupported visibility field");
  return { source: "field", fieldId: matches[0]!.field.fieldId };
};
export function projectStudioVisibilityCondition(source: SourceQualifiedCondition | undefined,
  metadata: StudioApplicationConditionContext): ConditionNode | undefined {
  if (source === undefined) return undefined;
  if (!sourceQualifiedConditionSchema.safeParse(source).success) throw new TypeError("Invalid visibility condition");
  if ("all" in source) return { kind: "all", conditions: source.all.map((child) => projectStudioVisibilityCondition(child, metadata)!) };
  if ("any" in source) return { kind: "any", conditions: source.any.map((child) => projectStudioVisibilityCondition(child, metadata)!) };
  if ("not" in source) return { kind: "not", condition: projectStudioVisibilityCondition(source.not, metadata)! };
  const left = "left" in source ? projectOperand(source.left, metadata) : projectOperand({ source: "field", field: source.field }, metadata);
  const right = "right" in source ? projectOperand(source.right, metadata)
    : "value" in source ? projectOperand({ source: "value", value: source.value }, metadata)
      : "parameter" in source ? projectOperand({ source: "parameter" }, metadata) : undefined;
  return { kind: "comparison", operator: source.operator, left, ...(right === undefined ? {} : { right }) };
}

/** Canonical editor paths are translated to the actual authored compact/explicit shape. */
export function locateStudioVisibilityIssue(path: readonly (string | number)[],
  source: SourceQualifiedCondition | undefined): readonly (string | number)[] {
  if (source === undefined || path.length === 0) return [];
  const [part, next, ...rest] = path;
  if ("all" in source || "any" in source) {
    const key = "all" in source ? "all" : "any";
    const children = "all" in source ? source.all : source.any;
    if (part === "conditions" && typeof next === "number") return [key, next,
      ...locateStudioVisibilityIssue(rest, children[next])];
    return [key];
  }
  if ("not" in source) return ["not", ...locateStudioVisibilityIssue(path.slice(1), source.not)];
  if (part === "kind") return [];
  if (part === "left" || part === "right") {
    if ("field" in source) return part === "left" ? ["field"] : ["value", ...path.slice(2)];
    return [part, ...path.slice(1).map((key) => key === "fieldId" ? "field" : key === "key" ? "parameter" : key)];
  }
  return path;
}

const inverseCondition = (condition: ConditionNode, original: SourceQualifiedCondition | undefined,
  metadata: StudioApplicationConditionContext): SourceQualifiedCondition => {
  const originals: { source: SourceQualifiedCondition; canonical: ConditionNode }[] = [];
  const collect = (source: SourceQualifiedCondition) => {
    originals.push({ source, canonical: projectStudioVisibilityCondition(source, metadata)! });
    if ("all" in source) source.all.forEach(collect);
    else if ("any" in source) source.any.forEach(collect);
    else if ("not" in source) collect(source.not);
  };
  if (original !== undefined) collect(original);
  const used = new Set<SourceQualifiedCondition>();
  const operand = (value: Operand): SourceOperand => {
    if (value.source === "value") return { source: "value", value: structuredClone(value.value) };
    if (value.source !== "field") throw new TypeError("Unsupported visibility operand");
    const matches = metadata.fields.filter(({ field }) => field.fieldId === value.fieldId);
    if (matches.length !== 1) throw new TypeError("Unsupported visibility field");
    return { source: "field", field: `${metadata.recordReference}.${matches[0]!.preferredAlias}` };
  };
  const convert = (node: ConditionNode): SourceQualifiedCondition => {
    const retained = originals.find((entry) => !used.has(entry.source) && sameStudioVisibilityCondition(entry.canonical, node));
    if (retained !== undefined) {
      used.add(retained.source);
      return structuredClone(retained.source);
    }
    if (node.kind === "all") return { all: node.conditions.map(convert) };
    if (node.kind === "any") return { any: node.conditions.map(convert) };
    if (node.kind === "not") return { not: convert(node.condition) };
    if (node.kind !== "comparison") throw new TypeError("Invalid visibility condition");
    return { operator: node.operator, left: operand(node.left),
      ...(node.right === undefined ? {} : { right: operand(node.right) }) } as SourceQualifiedCondition;
  };
  return convert(condition);
};

/** Locate a local draft against the authored shape it would produce, without changing source. */
export function locateStudioVisibilityDraftIssue(path: readonly (string | number)[],
  condition: ConditionNode | undefined, original: SourceQualifiedCondition | undefined,
  metadata: StudioApplicationConditionContext): readonly (string | number)[] {
  try {
    return locateStudioVisibilityIssue(path, condition === undefined ? undefined :
      inverseCondition(condition, original, metadata));
  } catch {
    return locateStudioVisibilityIssue(path, original);
  }
}

export type StudioVisibilityEditorModel =
  | Readonly<{ kind: "available"; target: StudioVisibilityTarget; condition: ConditionNode | undefined;
    controls: StudioConditionControlsContext }>
  | Readonly<{ kind: "unsupported" | "stale" }>;
export function projectStudioVisibilityEditor(context: StudioCompositionContext,
  selection: StudioSemanticSelection | null, candidateMetadata: unknown): StudioVisibilityEditorModel {
  const metadata = parseStudioApplicationConditionContext(candidateMetadata);
  const target = resolveStudioVisibilityTarget(context.source, selection);
  if (metadata === undefined || target === undefined) return { kind: "unsupported" };
  if (context.organizationId !== metadata.organizationId || context.rootId !== metadata.rootId ||
    context.key !== metadata.key || context.draftRevision !== metadata.draftRevision ||
    !Number.isSafeInteger(context.localLifetime) || context.localLifetime < 1 ||
    context.source.key !== context.key || target.pageAlias !== metadata.pageAlias ||
    target.recordReference !== metadata.recordReference ||
    JSON.stringify(context.source.body.module_bindings) !== metadata.bindingsSignature) return { kind: "stale" };
  try {
    const controls = studioVisibilityControlsContext(metadata);
    const condition = projectStudioVisibilityCondition(target.placement.visibility_condition, metadata);
    if (!validateStudioVisibilityCondition(condition, metadata).isValid) return { kind: "unsupported" };
    return { kind: "available", target, controls, condition };
  } catch { return { kind: "unsupported" }; }
}

export type StudioVisibilityCommandResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocumentV2 }>
  | Readonly<{ kind: "noop"; source: Readonly<ApplicationSourceDocumentV2> }>
  | Readonly<{ kind: "stale" | "unsupported" }>
  | Readonly<{ kind: "invalid"; issues: readonly Readonly<{ path: readonly (string | number)[]; message: string }>[] }>;

/** Mutate a detached original whole document, validating without replacing it with parsed output. */
export function applyStudioVisibilityCondition(expected: StudioCompositionContext, current: StudioCompositionContext,
  selection: StudioSemanticSelection, metadata: StudioApplicationConditionContext,
  condition: ConditionNode | undefined): StudioVisibilityCommandResult {
  if (expected.organizationId !== current.organizationId || expected.rootId !== current.rootId ||
    expected.key !== current.key || expected.draftRevision !== current.draftRevision ||
    expected.localLifetime !== current.localLifetime || expected.source !== current.source) return { kind: "stale" };
  const model = projectStudioVisibilityEditor(current, selection, metadata);
  if (model.kind !== "available") return model;
  const validation = validateStudioVisibilityCondition(condition, metadata);
  let authored: SourceQualifiedCondition | undefined;
  try { authored = condition === undefined ? undefined : inverseCondition(condition,
    model.target.placement.visibility_condition, metadata); } catch { return { kind: "unsupported" }; }
  const base = [...model.target.path, "visibility_condition"];
  if (!validation.isValid) return { kind: "invalid", issues: validation.issues.map((issue: StudioConditionValidationIssue) => ({
    path: [...base, ...locateStudioVisibilityIssue(issue.path, authored)], message: issue.message })) };
  if (sameStudioVisibilityCondition(model.condition, condition)) return { kind: "noop", source: current.source };
  if (authored !== undefined && !sourceQualifiedConditionSchema.safeParse(authored).success)
    return { kind: "invalid", issues: [{ path: base, message: "The authored condition is invalid." }] };
  const candidate = structuredClone(current.source) as ApplicationSourceDocumentV2;
  const target = resolveStudioVisibilityTarget(candidate, selection);
  if (target === undefined) return { kind: "stale" };
  if (authored === undefined) delete target.placement.visibility_condition;
  else target.placement.visibility_condition = authored;
  const parsed = applicationSourceDocumentV2Schema.safeParse(candidate);
  if (!parsed.success) return { kind: "invalid", issues: parsed.error.issues.map((issue) => ({
    path: issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
    message: "The application source is invalid at this location.",
  })) };
  return { kind: "applied", source: candidate };
}
