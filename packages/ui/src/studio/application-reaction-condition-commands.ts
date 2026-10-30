import {
  applicationRootIdSchema,
  applicationSourceDocumentSchema,
  organizationIdSchema,
  revisionSchema,
  fingerprintSchema,
  timestampSchema,
  sourceQualifiedConditionSchema,
  namespacedKeySchema,
  moduleRootIdSchema,
  recordTypeIdSchema,
  semanticVersionSchema,
  moduleFieldSchema,
  moduleFieldValueSchemas,
  comparableConditionFieldType,
  builderKeySchema,
  sourceItemChildSlots,
  sourceItemTree,
  sourcePageItems,
  sourcePageZones,
  conditionValueType,
  type ApplicationSourceDocument,
  type ConditionNode,
  type ModuleField,
  type SourceItem,
  type SourceItemVortex,
  type SourcePageData,
  applicationModuleKeys,
  isRecord,
} from "@vortex/platform/schema";
import {
  validateStudioCondition,
  type StudioConditionControlsContext,
  type StudioConditionOperandPermission,
  type StudioConditionSemanticType,
  type StudioConditionValidation,
  type StudioConditionValidationIssue,
} from "./condition-model";
import type { StudioCompositionContext } from "./application-composition-commands";
import { projectStudioFlowDraftChoices } from "./application-flow-step-form";
import { studioDraftRecordType } from "./application-flow-values";
import type { StudioSemanticSelection } from "./semantic-selection";

type SourceQualifiedCondition = NonNullable<SourceItemVortex["visibility_condition"]>;

/** The four reactions a placement can declare: each is one condition over page, form and record values. */
export type StudioReactionSlot =
  "visibility_condition" | "required_condition" | "read_only_condition" | "enabled_condition";
export const studioReactionSlots: readonly Readonly<{
  slot: StudioReactionSlot;
  title: string;
  help: string;
}>[] = [
  {
    slot: "visibility_condition",
    title: "Show when",
    help: "Show this item only when the condition holds. This only hides or shows the item; who may open the page is set separately.",
  },
  {
    slot: "required_condition",
    title: "Required when",
    help: "Ask for an answer only when the condition holds.",
  },
  {
    slot: "read_only_condition",
    title: "Read-only when",
    help: "Show the answer but do not let it be changed while the condition holds.",
  },
  {
    slot: "enabled_condition",
    title: "Enabled when",
    help: "Let the item be used only while the condition holds.",
  },
];

export type StudioApplicationConditionContext = Readonly<{
  organizationId: string;
  rootId: string;
  key: string;
  draftRevision: number;
  sourceFingerprint: string;
  publishedRevision: number | null;
  createdAt: string;
  updatedAt: string;
  bindingsSignature: string;
  resolutionFingerprint: string;
  pageAlias: string;
  recordReference: string;
  fieldRecordReference: string;
  recordTypeId: string;
  module: Readonly<{
    organizationId: string;
    key: string;
    rootId: string;
    releaseRevision: number;
    releaseVersion: string;
    contentFingerprint: string;
    resolutionFingerprint: string;
  }>;
  fields: readonly Readonly<{
    field: ModuleField;
    aliases: readonly string[];
    preferredAlias: string;
    componentOwner: string;
  }>[];
}>;
export type StudioApplicationConditionContextResult =
  | Readonly<{ kind: "available"; context: StudioApplicationConditionContext }>
  | Readonly<{ kind: "refused" | "conflict" | "temporarily_unavailable" }>;

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const sourceAliasValid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 160 &&
  /^[a-z][a-z0-9_]*$/.test(value);
const qualifiedFieldValid = (field: unknown): boolean =>
  sourceQualifiedConditionSchema.safeParse({ field, operator: "is_empty" }).success;

/** Finite metadata only. This boundary validates data; it never grants permission. */
export function parseStudioApplicationConditionContext(
  value: unknown,
): StudioApplicationConditionContext | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "organizationId",
      "rootId",
      "key",
      "draftRevision",
      "sourceFingerprint",
      "publishedRevision",
      "createdAt",
      "updatedAt",
      "bindingsSignature",
      "resolutionFingerprint",
      "pageAlias",
      "recordReference",
      "fieldRecordReference",
      "recordTypeId",
      "module",
      "fields",
    ]) ||
    !organizationIdSchema.safeParse(value.organizationId).success ||
    !applicationRootIdSchema.safeParse(value.rootId).success ||
    !namespacedKeySchema.safeParse(value.key).success ||
    !revisionSchema.safeParse(value.draftRevision).success ||
    !fingerprintSchema.safeParse(value.sourceFingerprint).success ||
    (value.publishedRevision !== null &&
      !revisionSchema.safeParse(value.publishedRevision).success) ||
    !timestampSchema.safeParse(value.createdAt).success ||
    !timestampSchema.safeParse(value.updatedAt).success ||
    typeof value.bindingsSignature !== "string" ||
    value.bindingsSignature.length > 100_000 ||
    !fingerprintSchema.safeParse(value.resolutionFingerprint).success ||
    !sourceAliasValid(value.pageAlias) ||
    typeof value.recordReference !== "string" ||
    !qualifiedFieldValid(`${value.recordReference}.field`) ||
    typeof value.fieldRecordReference !== "string" ||
    !qualifiedFieldValid(`${value.fieldRecordReference}.field`) ||
    !recordTypeIdSchema.safeParse(value.recordTypeId).success ||
    !isRecord(value.module) ||
    !Array.isArray(value.fields) ||
    value.fields.length > 500
  )
    return undefined;
  const module = value.module;
  if (
    !exactKeys(module, [
      "organizationId",
      "key",
      "rootId",
      "releaseRevision",
      "releaseVersion",
      "contentFingerprint",
      "resolutionFingerprint",
    ]) ||
    module.organizationId !== value.organizationId ||
    !namespacedKeySchema.safeParse(module.key).success ||
    !moduleRootIdSchema.safeParse(module.rootId).success ||
    !revisionSchema.safeParse(module.releaseRevision).success ||
    !semanticVersionSchema.safeParse(module.releaseVersion).success ||
    !fingerprintSchema.safeParse(module.contentFingerprint).success ||
    !fingerprintSchema.safeParse(module.resolutionFingerprint).success ||
    !(value.recordReference as string).startsWith(`${module.key}:`) ||
    !(value.fieldRecordReference as string).startsWith(`${module.key}:`)
  )
    return undefined;
  const aliases = new Set<string>();
  const identifiers = new Set<string>();
  const owners = new Set<string>();
  for (const item of value.fields) {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["field", "aliases", "preferredAlias", "componentOwner"]) ||
      !Array.isArray(item.aliases) ||
      item.aliases.length < 1 ||
      item.aliases.length > 2 ||
      !builderKeySchema.safeParse(item.preferredAlias).success ||
      !sourceAliasValid(item.componentOwner)
    )
      return undefined;
    const parsed = moduleFieldSchema.safeParse(item.field);
    if (
      !parsed.success ||
      comparableConditionFieldType(parsed.data) === undefined ||
      parsed.data.key !== item.preferredAlias ||
      !item.aliases.includes(item.preferredAlias) ||
      identifiers.has(parsed.data.fieldId) ||
      owners.has(item.componentOwner as string)
    )
      return undefined;
    identifiers.add(parsed.data.fieldId);
    owners.add(item.componentOwner as string);
    for (const alias of item.aliases) {
      if (
        !sourceAliasValid(alias) ||
        aliases.has(alias) ||
        !qualifiedFieldValid(`${value.fieldRecordReference}.${alias}`)
      )
        return undefined;
      aliases.add(alias);
    }
  }
  // Six scalar field declarations have a bounded shape; cap their total transport size as well.
  if (JSON.stringify(value).length > 1_000_000) return undefined;
  return value as unknown as StudioApplicationConditionContext;
}

export const sameStudioReactionValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((entry, index) => sameStudioReactionValue(entry, right[index]))
    );
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameStudioReactionValue(left[key], right[key]))
  );
};

/** Canonical optional right operands have the same meaning when omitted or undefined. */
export const sameStudioReactionCondition = (
  left: ConditionNode | undefined,
  right: ConditionNode | undefined,
): boolean => {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind === "comparison" && right.kind === "comparison")
    return (
      left.operator === right.operator &&
      sameStudioReactionValue(left.left, right.left) &&
      sameStudioReactionValue(left.right, right.right)
    );
  if (left.kind === "not" && right.kind === "not")
    return sameStudioReactionCondition(left.condition, right.condition);
  if (
    (left.kind === "all" || left.kind === "any") &&
    (right.kind === "all" || right.kind === "any")
  )
    return (
      left.kind === right.kind &&
      left.conditions.length === right.conditions.length &&
      left.conditions.every((child, index) =>
        sameStudioReactionCondition(child, right.conditions[index]),
      )
    );
  return false;
};

/** The selected item's Vortex metadata, where its visibility condition lives, and its source path. */
export type StudioReactionTarget = Readonly<{
  pageAlias: string;
  recordReference: string;
  placementAlias: string;
  /** The page's own blocks can compare the record's fields; a block inside another compares page values and form answers only. */
  top: boolean;
  path: readonly (string | number)[];
  placement: SourceItemVortex;
}>;

/**
 * Only a unique, directly page-owned placement is editable. On a record page its conditions can
 * compare the record's fields; on any page they compare the page's values and its forms' answers.
 */
export function resolveStudioReactionTarget(
  source: ApplicationSourceDocument,
  selection: StudioSemanticSelection | null,
): StudioReactionTarget | undefined {
  if (selection?.kind !== "placement" || !applicationSourceDocumentSchema.safeParse(source).success)
    return undefined;
  const placementAlias = selection.placementAlias;
  const seen: {
    placement: SourceItemVortex;
    path: (string | number)[];
    pageAlias?: string;
    recordReference?: string;
    top: boolean;
  }[] = [];
  const visit = (
    items: readonly SourceItem[],
    path: (string | number)[],
    pageAlias?: string,
    recordReference?: string,
    top = false,
  ) => {
    items.forEach((item, index) => {
      const itemPath = [...path, index];
      if (item.props.id === placementAlias)
        seen.push({
          placement: item.props.vortex,
          path: [...itemPath, "props", "vortex"],
          ...(pageAlias === undefined ? {} : { pageAlias }),
          ...(recordReference === undefined ? {} : { recordReference }),
          top,
        });
      for (const [key, children] of sourceItemChildSlots(item))
        visit(children, [...itemPath, "props", key], pageAlias, recordReference);
    });
  };
  const visitData = (
    data: SourcePageData,
    path: (string | number)[],
    pageAlias?: string,
    recordReference?: string,
    top = false,
  ) => {
    for (const [zone, items] of sourcePageZones(data))
      visit(
        items,
        zone === "content" ? [...path, "content"] : [...path, "root", "props", zone],
        pageAlias,
        recordReference,
        top,
      );
  };
  source.body.shells.forEach((shell, index) =>
    visit(shell.layout.content, ["body", "shells", index, "layout", "content"]),
  );
  source.body.pages.forEach((page, index) => {
    const path = ["body", "pages", index, "composition"];
    if (page.type === "guided_form") {
      for (const [key, data] of Object.entries(page.composition.step_content))
        visitData(data, [...path, "step_content", key]);
    } else
      visitData(
        page.composition,
        path,
        page.id,
        page.type === "detail" ? page.record_type : "",
        true,
      );
  });
  const target = seen[0];
  if (
    seen.length !== 1 ||
    target === undefined ||
    target.pageAlias === undefined ||
    target.recordReference === undefined
  )
    return undefined;
  return {
    ...target,
    pageAlias: target.pageAlias,
    recordReference: target.recordReference,
    placementAlias,
  };
}

/** What a page value of this type is compared as. */
const pageValueConditionType: Readonly<Record<string, StudioConditionSemanticType>> = {
  decimal_number: "decimal_number",
  money: "money",
  text: "text",
  yes_no: "yes_no",
  json: "opaque_json",
};

/**
 * The values besides the record's fields that a condition on this page can compare: the page's own
 * values and the current answers of the forms placed on it.
 */
export function studioReactionOperands(
  context: StudioCompositionContext,
  pageAlias: string,
): readonly StudioConditionOperandPermission[] {
  const page = context.source.body.pages.find((entry) => entry.id === pageAlias);
  if (page === undefined) return [];
  const operands: StudioConditionOperandPermission[] = Object.entries(page.values ?? {}).flatMap(
    ([name, declaration]): StudioConditionOperandPermission[] => {
      const type = pageValueConditionType[declaration.type];
      return type === undefined
        ? []
        : [
            {
              operand: { source: "page", name },
              label: declaration.label,
              role: "page_value",
              type,
            },
          ];
    },
  );
  const placed = new Set(sourcePageItems(page.composition).map((item) => item.props.id));
  const forms = projectStudioFlowDraftChoices({
    rootId: context.rootId as never,
    source: context.source,
    catalogue: context.catalogue,
  }).forms.filter((form) => placed.has(form.alias));
  // A choice field's answer is compared with one of its options, picked from them.
  const choicesOf = (
    formAlias: string,
  ): ReadonlyMap<string, readonly { value: string; label: string }[]> => {
    const options = new Map<string, readonly { value: string; label: string }[]>();
    const form = sourcePageItems(page.composition).find((item) => item.props.id === formAlias);
    for (const control of form === undefined ? [] : sourceItemTree([form])) {
      const reference = control.props.field;
      if (typeof reference !== "string") continue;
      const dot = reference.lastIndexOf(".");
      const field = studioDraftRecordType(
        context.source,
        reference.slice(0, dot),
        null,
      )?.record.fields.find((candidate) => candidate.key === reference.slice(dot + 1));
      const name =
        typeof control.props.name === "string" && control.props.name !== ""
          ? control.props.name
          : field?.key;
      const list = (
        field?.settings as { options?: readonly { value: string; label: string }[] } | undefined
      )?.options;
      if (field?.type === "choice" && name !== undefined && list !== undefined)
        options.set(
          name,
          list.map(({ value, label }) => ({ value, label })),
        );
    }
    return options;
  };
  for (const form of forms) {
    const choices = choicesOf(form.alias);
    for (const field of form.fields) {
      const type = conditionValueType(field.type);
      if (type === undefined) continue;
      const options = choices.get(field.name);
      operands.push({
        operand: { source: "form", form: form.alias, field: field.name },
        label: `${form.label}: ${field.label}`,
        role: "form_field",
        type,
        ...(options === undefined ? {} : { options }),
      });
    }
  }
  return operands;
}

export function studioReactionControlsContext(
  metadata: StudioApplicationConditionContext,
  extra: readonly StudioConditionOperandPermission[] = [],
): StudioConditionControlsContext {
  return {
    allowedOperands: [
      ...metadata.fields.map(({ field }): StudioConditionOperandPermission => ({
        operand: { source: "field", fieldId: field.fieldId },
        field,
        label: field.label,
        role: "current_field",
      })),
      ...extra,
    ],
    declaredFieldIds: metadata.fields.map(({ field }) => field.fieldId),
    parameterDeclarations: [],
    allowLiteralValues: true,
  };
}

/** Shared validation plus the existing exact scalar leaf contract, without value coercion. */
export function validateStudioReactionCondition(
  condition: ConditionNode | undefined,
  metadata: StudioApplicationConditionContext,
  extra: readonly StudioConditionOperandPermission[] = [],
): StudioConditionValidation {
  const validation = validateStudioCondition(
    condition,
    studioReactionControlsContext(metadata, extra),
  );
  if (!validation.isValid || condition === undefined) return validation;
  const issues = [...validation.issues];
  const visit = (node: ConditionNode, path: (string | number)[]) => {
    if (node.kind === "not") {
      visit(node.condition, [...path, "condition"]);
      return;
    }
    if (node.kind !== "comparison") {
      node.conditions.forEach((child, index) => visit(child, [...path, "conditions", index]));
      return;
    }
    for (const [side, reference, literal] of [
      ["right", node.left, node.right],
      ["left", node.right, node.left],
    ] as const) {
      if (reference?.source !== "field" || literal?.source !== "value" || literal.value === null)
        continue;
      const field = metadata.fields.find((item) => item.field.fieldId === reference.fieldId)?.field;
      if (field === undefined) continue;
      const leaf =
        moduleFieldValueSchemas[
          comparableConditionFieldType(field) as keyof typeof moduleFieldValueSchemas
        ];
      const collection = side === "right" && (node.operator === "in" || node.operator === "not_in");
      const valid =
        collection && Array.isArray(literal.value)
          ? literal.value.every((value) => value === null || leaf.safeParse(value).success)
          : leaf.safeParse(literal.value).success;
      if (!valid) {
        const issuePath = [...path, side, "value"];
        issues.push({
          code: "invalid_literal",
          path: issuePath,
          pointer: `/${issuePath.join("/")}`,
          message: "Use a literal of the selected field's exact scalar type.",
        });
      }
    }
  };
  visit(condition, []);
  return { ...validation, issues, isValid: issues.length === 0 };
}

type Operand = Extract<ConditionNode, { kind: "comparison" }>["left"];
type SourceOperand =
  | { source: "field"; field: string }
  | { source: "page"; name: string }
  | { source: "form"; form: string; field: string }
  | { source: "value"; value: Extract<Operand, { source: "value" }>["value"] };
const projectOperand = (
  operand: { source: string; field?: string; value?: unknown; name?: string; form?: string },
  metadata: StudioApplicationConditionContext,
): Operand => {
  if (operand.source === "page") return { source: "page", name: operand.name! };
  if (operand.source === "form")
    return { source: "form", form: operand.form!, field: operand.field! };
  if (operand.source === "value")
    return {
      source: "value",
      value: operand.value as Extract<Operand, { source: "value" }>["value"],
    };
  if (operand.source !== "field") throw new TypeError("Unsupported visibility operand");
  const matches = metadata.fields.filter((item) =>
    item.aliases.some((alias) => `${metadata.fieldRecordReference}.${alias}` === operand.field),
  );
  if (matches.length !== 1) throw new TypeError("Unsupported visibility field");
  return { source: "field", fieldId: matches[0]!.field.fieldId };
};
export function projectStudioReactionCondition(
  source: SourceQualifiedCondition | undefined,
  metadata: StudioApplicationConditionContext,
): ConditionNode | undefined {
  if (source === undefined) return undefined;
  if (!sourceQualifiedConditionSchema.safeParse(source).success)
    throw new TypeError("Invalid visibility condition");
  if ("all" in source)
    return {
      kind: "all",
      conditions: source.all.map((child) => projectStudioReactionCondition(child, metadata)!),
    };
  if ("any" in source)
    return {
      kind: "any",
      conditions: source.any.map((child) => projectStudioReactionCondition(child, metadata)!),
    };
  if ("not" in source)
    return { kind: "not", condition: projectStudioReactionCondition(source.not, metadata)! };
  const left =
    "left" in source
      ? projectOperand(source.left, metadata)
      : projectOperand({ source: "field", field: source.field }, metadata);
  const right =
    "right" in source
      ? projectOperand(source.right, metadata)
      : "value" in source
        ? projectOperand({ source: "value", value: source.value }, metadata)
        : "parameter" in source
          ? projectOperand({ source: "parameter" }, metadata)
          : undefined;
  return {
    kind: "comparison",
    operator: source.operator,
    left,
    ...(right === undefined ? {} : { right }),
  };
}

/** Canonical editor paths are translated to the actual authored compact/explicit shape. */
export function locateStudioReactionIssue(
  path: readonly (string | number)[],
  source: SourceQualifiedCondition | undefined,
): readonly (string | number)[] {
  if (source === undefined || path.length === 0) return [];
  const [part, next, ...rest] = path;
  if ("all" in source || "any" in source) {
    const key = "all" in source ? "all" : "any";
    const children = "all" in source ? source.all : source.any;
    if (part === "conditions" && typeof next === "number")
      return [key, next, ...locateStudioReactionIssue(rest, children[next])];
    return [key];
  }
  if ("not" in source) return ["not", ...locateStudioReactionIssue(path.slice(1), source.not)];
  if (part === "kind") return [];
  if (part === "left" || part === "right") {
    if ("field" in source) return part === "left" ? ["field"] : ["value", ...path.slice(2)];
    return [
      part,
      ...path
        .slice(1)
        .map((key) => (key === "fieldId" ? "field" : key === "key" ? "parameter" : key)),
    ];
  }
  return path;
}

const inverseCondition = (
  condition: ConditionNode,
  original: SourceQualifiedCondition | undefined,
  metadata: StudioApplicationConditionContext,
): SourceQualifiedCondition => {
  const subtree = (source: SourceQualifiedCondition): SourceQualifiedCondition[] => {
    if ("all" in source) return [source, ...source.all.flatMap(subtree)];
    if ("any" in source) return [source, ...source.any.flatMap(subtree)];
    if ("not" in source) return [source, ...subtree(source.not)];
    return [source];
  };
  const originals: {
    source: SourceQualifiedCondition;
    canonical: ConditionNode;
    provenance: readonly SourceQualifiedCondition[];
  }[] = [];
  const collect = (source: SourceQualifiedCondition) => {
    originals.push({
      source,
      canonical: projectStudioReactionCondition(source, metadata)!,
      provenance: subtree(source),
    });
    if ("all" in source) source.all.forEach(collect);
    else if ("any" in source) source.any.forEach(collect);
    else if ("not" in source) collect(source.not);
  };
  if (original !== undefined) collect(original);
  const used = new Set<SourceQualifiedCondition>();
  const operand = (value: Operand): SourceOperand => {
    if (value.source === "value") return { source: "value", value: structuredClone(value.value) };
    if (value.source === "page") return { source: "page", name: value.name };
    if (value.source === "form") return { source: "form", form: value.form, field: value.field };
    if (value.source !== "field") throw new TypeError("Unsupported visibility operand");
    const matches = metadata.fields.filter(({ field }) => field.fieldId === value.fieldId);
    if (matches.length !== 1) throw new TypeError("Unsupported visibility field");
    return {
      source: "field",
      field: `${metadata.fieldRecordReference}.${matches[0]!.preferredAlias}`,
    };
  };
  const childrenOf = (source: SourceQualifiedCondition | undefined) =>
    source === undefined
      ? undefined
      : "all" in source
        ? source.all
        : "any" in source
          ? source.any
          : undefined;
  // Reserve unchanged positions before an edited earlier node can consume their authored form.
  const reservations = new Map<SourceQualifiedCondition, string>();
  const reserve = (
    node: ConditionNode,
    preferred: SourceQualifiedCondition | undefined,
    path: string,
  ) => {
    const retained = originals.find(
      (entry) => entry.source === preferred && sameStudioReactionCondition(entry.canonical, node),
    );
    if (retained !== undefined) {
      retained.provenance.forEach((source) => reservations.set(source, path));
      return;
    }
    const children = childrenOf(preferred);
    if (node.kind === "all" || node.kind === "any") {
      node.conditions.forEach((child, index) =>
        reserve(child, children?.[index], `${path}/${index}`),
      );
    } else if (node.kind === "not") {
      reserve(
        node.condition,
        preferred !== undefined && "not" in preferred ? preferred.not : undefined,
        `${path}/not`,
      );
    }
  };
  reserve(condition, original, "");
  const convert = (
    node: ConditionNode,
    preferred: SourceQualifiedCondition | undefined,
    path: string,
  ): SourceQualifiedCondition => {
    const matches = (entry: (typeof originals)[number]) =>
      entry.provenance.every(
        (source) =>
          !used.has(source) && (!reservations.has(source) || reservations.get(source) === path),
      ) && sameStudioReactionCondition(entry.canonical, node);
    // Keep an untouched sibling's own authored form before considering an equivalent node elsewhere.
    const retained =
      originals.find((entry) => entry.source === preferred && matches(entry)) ??
      originals.find(matches);
    if (retained !== undefined) {
      retained.provenance.forEach((source) => used.add(source));
      return structuredClone(retained.source);
    }
    const children = childrenOf(preferred);
    if (node.kind === "all")
      return {
        all: node.conditions.map((child, index) =>
          convert(child, children?.[index], `${path}/${index}`),
        ),
      };
    if (node.kind === "any")
      return {
        any: node.conditions.map((child, index) =>
          convert(child, children?.[index], `${path}/${index}`),
        ),
      };
    if (node.kind === "not")
      return {
        not: convert(
          node.condition,
          preferred !== undefined && "not" in preferred ? preferred.not : undefined,
          `${path}/not`,
        ),
      };
    if (node.kind !== "comparison") throw new TypeError("Invalid visibility condition");
    return {
      operator: node.operator,
      left: operand(node.left),
      ...(node.right === undefined ? {} : { right: operand(node.right) }),
    } as SourceQualifiedCondition;
  };
  return convert(condition, original, "");
};

/** Locate a local draft against the authored shape it would produce, without changing source. */
export function locateStudioReactionDraftIssue(
  path: readonly (string | number)[],
  condition: ConditionNode | undefined,
  original: SourceQualifiedCondition | undefined,
  metadata: StudioApplicationConditionContext,
): readonly (string | number)[] {
  try {
    return locateStudioReactionIssue(
      path,
      condition === undefined ? undefined : inverseCondition(condition, original, metadata),
    );
  } catch {
    return locateStudioReactionIssue(path, original);
  }
}

export type StudioReactionEditorModel =
  | Readonly<{
      kind: "available";
      target: StudioReactionTarget;
      condition: ConditionNode | undefined;
      controls: StudioConditionControlsContext;
      /** The record fields this page's record offers; none on a page without a record. */
      metadata: StudioApplicationConditionContext;
      /** The page values and form answers the condition can compare besides the record's fields. */
      extra: readonly StudioConditionOperandPermission[];
    }>
  | Readonly<{ kind: "unsupported" | "stale" }>;

/** The conditions of a page that shows no record: no record fields, only page values and form answers. */
const noRecordConditionContext = (
  context: StudioCompositionContext,
  pageAlias: string,
): StudioApplicationConditionContext => ({
  organizationId: context.organizationId,
  rootId: context.rootId,
  key: context.key,
  draftRevision: 0,
  sourceFingerprint: "",
  publishedRevision: null,
  createdAt: "",
  updatedAt: "",
  bindingsSignature: JSON.stringify(applicationModuleKeys(context.source)),
  resolutionFingerprint: "",
  pageAlias,
  recordReference: "",
  fieldRecordReference: "",
  recordTypeId: "",
  module: {
    organizationId: context.organizationId,
    key: "",
    rootId: "",
    releaseRevision: 0,
    releaseVersion: "",
    contentFingerprint: "",
    resolutionFingerprint: "",
  },
  fields: [],
});

export function projectStudioReactionEditor(
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
  candidateMetadata: unknown,
  slot: StudioReactionSlot,
): StudioReactionEditorModel {
  const target = resolveStudioReactionTarget(context.source, selection);
  if (target === undefined) return { kind: "unsupported" };
  const metadata =
    !target.top || target.recordReference === ""
      ? noRecordConditionContext(context, target.pageAlias)
      : parseStudioApplicationConditionContext(candidateMetadata);
  if (metadata === undefined) return { kind: "unsupported" };
  if (
    context.organizationId !== metadata.organizationId ||
    context.rootId !== metadata.rootId ||
    context.key !== metadata.key ||
    !Number.isSafeInteger(context.localLifetime) ||
    context.localLifetime < 1 ||
    context.source.key !== context.key ||
    target.pageAlias !== metadata.pageAlias ||
    (target.top && target.recordReference !== metadata.recordReference) ||
    JSON.stringify(applicationModuleKeys(context.source)) !== metadata.bindingsSignature
  )
    return { kind: "stale" };
  try {
    const extra = studioReactionOperands(context, target.pageAlias);
    const controls = studioReactionControlsContext(metadata, extra);
    const condition = projectStudioReactionCondition(target.placement[slot], metadata);
    if (!validateStudioReactionCondition(condition, metadata, extra).isValid)
      return { kind: "unsupported" };
    return { kind: "available", target, controls, condition, metadata, extra };
  } catch {
    return { kind: "unsupported" };
  }
}

export type StudioReactionCommandResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "noop"; source: Readonly<ApplicationSourceDocument> }>
  | Readonly<{ kind: "stale" | "unsupported" }>
  | Readonly<{
      kind: "invalid";
      issues: readonly Readonly<{ path: readonly (string | number)[]; message: string }>[];
    }>;

/** Mutate a detached original whole document, validating without replacing it with parsed output. */
export function applyStudioReactionCondition(
  expected: StudioCompositionContext,
  current: StudioCompositionContext,
  selection: StudioSemanticSelection,
  candidateMetadata: unknown,
  condition: ConditionNode | undefined,
  slot: StudioReactionSlot,
): StudioReactionCommandResult {
  if (
    expected.organizationId !== current.organizationId ||
    expected.rootId !== current.rootId ||
    expected.key !== current.key ||
    expected.draftRevision !== current.draftRevision ||
    expected.localLifetime !== current.localLifetime ||
    expected.source !== current.source
  )
    return { kind: "stale" };
  const model = projectStudioReactionEditor(current, selection, candidateMetadata, slot);
  if (model.kind !== "available") return model;
  const { metadata } = model;
  const validation = validateStudioReactionCondition(condition, metadata, model.extra);
  let authored: SourceQualifiedCondition | undefined;
  try {
    authored =
      condition === undefined
        ? undefined
        : inverseCondition(condition, model.target.placement[slot], metadata);
  } catch {
    return { kind: "unsupported" };
  }
  const base = [...model.target.path, slot];
  if (!validation.isValid)
    return {
      kind: "invalid",
      issues: validation.issues.map((issue: StudioConditionValidationIssue) => ({
        path: [...base, ...locateStudioReactionIssue(issue.path, authored)],
        message: issue.message,
      })),
    };
  if (sameStudioReactionCondition(model.condition, condition))
    return { kind: "noop", source: current.source };
  if (authored !== undefined && !sourceQualifiedConditionSchema.safeParse(authored).success)
    return {
      kind: "invalid",
      issues: [{ path: base, message: "The authored condition is invalid." }],
    };
  const candidate = structuredClone(current.source) as ApplicationSourceDocument;
  const target = resolveStudioReactionTarget(candidate, selection);
  if (target === undefined) return { kind: "stale" };
  if (authored === undefined) delete target.placement[slot];
  else target.placement[slot] = authored;
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (!parsed.success)
    return {
      kind: "invalid",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.filter(
          (part): part is string | number => typeof part === "string" || typeof part === "number",
        ),
        message: "The application source is invalid at this location.",
      })),
    };
  return { kind: "applied", source: candidate };
}
