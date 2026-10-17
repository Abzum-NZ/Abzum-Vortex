import { builderKeySchema } from "../catalogue/identifiers";
import type { FlowValue } from "../workflows/flow-values";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";
import { changeableByPeople } from "./module-field-shape";
import { applicationUses, type ApplicationUsePlace } from "./application-uses";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];
type ModuleAction = InlineModule["actions"][number];
type ModulePermission = InlineModule["permissions"][number];
type ActionTask = ModuleAction["tasks"][number];

/** A named action's precondition: the authored condition tree a module action holds. */
export type InlineModuleActionPrecondition = NonNullable<ModuleAction["precondition"]>;

/** One field the action sets, and the value it sets it to (a fixed value, an input, the person or the time). */
export type InlineModuleActionEffect = Readonly<{ field: string; value: FlowValue }>;

/**
 * A named action of an owned Module's record type as Studio edits it: its label, when it may run,
 * the fields it sets, the permission that gates it and whether it owns the choice option it sets.
 * Saving that option anywhere else (a form, a board card, a Save record step) then runs this action.
 */
export type InlineModuleActionChange = Readonly<{
  moduleKey: string;
  recordKey: string;
  /** The action's key; absent for a new action. */
  actionKey?: string;
  label: string;
  precondition: InlineModuleActionPrecondition | undefined;
  effects: readonly InlineModuleActionEffect[];
  /** The action's own permission (created with it), or another named permission of its record type. */
  permission: Readonly<{ kind: "own" }> | Readonly<{ kind: "existing"; key: string }>;
  ownsChoice: boolean;
}>;

export type InlineModuleActionResult =
  | Readonly<{ kind: "changed"; source: ApplicationSourceDocument; actionKey: string }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>
  /** A permission the change would leave behind is still used elsewhere; nothing was changed. */
  | Readonly<{ kind: "referenced"; issue: string; references: readonly ApplicationUsePlace[] }>;

const effectTaskId = "set_fields";

const nameFrom = (label: string): string => {
  const words = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (/^[a-z]/.test(words) ? words : `action_${words}`).slice(0, 40).replace(/_+$/, "");
};

const uniqueAlias = (base: string, taken: ReadonlySet<string>): string => {
  const trimmed = base.slice(0, 150);
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? trimmed : `${trimmed}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

const moduleAliases = (module: InlineModule): Set<string> => new Set([
  module.id,
  ...module.record_types.flatMap((record) => [record.id, record.storage_contract_id,
    ...record.fields.map((field) => field.id), ...record.relationships.map((relationship) => relationship.id)]),
  ...module.permissions.map((permission) => permission.id),
  ...module.actions.map((action) => action.id),
  ...module.events.map((event) => event.id),
  ...module.queries.map((query) => query.id),
]);

/** The fields an authored condition reads, by key. */
const conditionFields = (condition: unknown): string[] => {
  if (condition === null || typeof condition !== "object") return [];
  const node = condition as Record<string, unknown>;
  if (Array.isArray(node.all)) return node.all.flatMap(conditionFields);
  if (Array.isArray(node.any)) return node.any.flatMap(conditionFields);
  if (node.not !== undefined) return conditionFields(node.not);
  const operands = [node.left, node.right].flatMap((operand) => operand !== null && typeof operand === "object" &&
    (operand as Record<string, unknown>).source === "field" ? [String((operand as Record<string, unknown>).field)] : []);
  return [...(typeof node.field === "string" ? [node.field] : []), ...operands];
};

/** The text of a fixed value, when an effect sets one. */
const fixedText = (value: FlowValue): string | undefined =>
  value.kind === "literal" && typeof value.literal.value === "string" ? value.literal.value : undefined;

const effectProblems = (record: RecordType, effects: readonly InlineModuleActionEffect[]): string[] => {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const effect of effects) {
    const field = record.fields.find((candidate) => candidate.key === effect.field);
    if (field === undefined) { issues.push(`Sets: ${record.name} has no field ${effect.field}.`); continue; }
    if (seen.has(field.key)) issues.push(`Sets: ${field.label} is set twice. Set each field once.`);
    seen.add(field.key);
    if (!changeableByPeople(field)) issues.push(`Sets: ${field.label} is worked out by the platform, so an action cannot set it.`);
    if (field.type === "choice") {
      const options = (field.settings as { options?: readonly { value: string; label: string }[] }).options ?? [];
      const chosen = fixedText(effect.value);
      if (effect.value.kind === "literal" && !options.some((option) => option.value === chosen))
        issues.push(`Sets: ${chosen ?? "this value"} is not an option of ${field.label}. Choose one of ${options.map((option) => option.label).join(", ")}.`);
    }
  }
  return issues;
};

/** The one choice field and option the effects set, when the action can own that option. */
const ownedOption = (record: RecordType, effects: readonly InlineModuleActionEffect[]):
  Readonly<{ field: string; option: string }> | undefined => {
  const choices = effects.filter((effect) => record.fields.find((field) => field.key === effect.field)?.type === "choice");
  const option = choices.length === 1 ? fixedText(choices[0]!.value) : undefined;
  return option === undefined ? undefined : { field: choices[0]!.field, option };
};

const parsed = (source: ApplicationSourceDocument, actionKey: string): InlineModuleActionResult => {
  const result = applicationSourceDocumentSchema.safeParse(source);
  return result.success ? { kind: "changed", source: result.data, actionKey }
    : { kind: "invalid", issues: result.error.issues.map((issue) => `${issue.message} (${issue.path.join(" / ")})`) };
};

/**
 * Creates or changes one named action of an owned Module's record type. A new action gets its own
 * named permission, granted to every access group of the Application as the standard permissions
 * are; its own permission follows the fields the action reads and sets. Tasks the action has besides
 * setting fields (announcing events, linking records) are kept as they are.
 */
export const saveInlineModuleAction = (
  current: ApplicationSourceDocument,
  change: InlineModuleActionChange,
): InlineModuleActionResult => {
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === change.moduleKey);
  const record = module?.record_types.find((item) => item.key === change.recordKey);
  if (module === undefined || record === undefined)
    return { kind: "invalid", issues: ["The record type is not in this application's modules any more."] };
  const label = change.label.trim();
  const issues: string[] = [];
  if (label.length < 1 || label.length > 60) issues.push("Name: give the action a name of at most 60 characters, such as Mark won.");
  const existing = change.actionKey === undefined ? undefined : module.actions.find((action) => action.key === change.actionKey);
  if (change.actionKey !== undefined && existing === undefined)
    return { kind: "invalid", issues: ["This action is not in the module any more."] };
  if (existing !== undefined && existing.record_type !== record.key)
    return { kind: "invalid", issues: ["This action belongs to another record type."] };
  if (existing?.protected_operation !== undefined)
    return { kind: "invalid", issues: ["This action runs a registered operation of the platform, so what it sets is not changed here."] };
  issues.push(...effectProblems(record, change.effects));
  const otherTasks = (existing?.tasks ?? []).filter((task) => task.type !== "record.set_fields");
  if (change.effects.length === 0 && otherTasks.length === 0) issues.push("Sets: choose at least one field the action sets.");
  const precondition = change.precondition;
  for (const field of conditionFields(precondition))
    if (!record.fields.some((candidate) => candidate.key === field)) issues.push(`Runs only when: ${record.name} has no field ${field}.`);
  const owned = change.ownsChoice ? ownedOption(record, change.effects) : undefined;
  if (change.ownsChoice && owned === undefined)
    issues.push("Owns the choice: the action must set exactly one choice field to one fixed option to own it.");
  if (owned !== undefined) {
    const rival = module.actions.find((action) => action !== existing && action.record_type === record.key &&
      action.sets_choice_field === owned.field && action.sets_choice_option === owned.option);
    if (rival !== undefined) issues.push(`Owns the choice: ${rival.label} already owns this option. Only one action can own it.`);
  }
  const name = existing === undefined ? undefined : existing.key.slice(existing.key.lastIndexOf(".") + 1);
  const taken = moduleAliases(module);
  const keys = new Set([...module.actions.map((action) => action.key), ...module.permissions.map((permission) => permission.key)]);
  const newName = name ?? (() => {
    const base = nameFrom(label);
    for (let n = 1; n < 1_000; n += 1) {
      const candidate = n === 1 ? base : `${base.slice(0, 36)}_${n}`;
      if (!keys.has(`${module.key}.${record.key}.${candidate}`)) return candidate;
    }
    return base;
  })();
  if (!builderKeySchema.safeParse(newName).success) issues.push("Name: start the name with a letter, such as Mark won.");
  let permissionKey: string;
  if (change.permission.kind === "existing") {
    const chosen = module.permissions.find((permission) => permission.key === (change.permission as { key: string }).key);
    if (chosen === undefined || chosen.action_kind !== "named" || chosen.record_type !== record.key)
      issues.push(`Permission: choose a named permission of ${record.plural_name}.`);
    permissionKey = chosen?.key ?? "";
  } else permissionKey = existing?.permission !== undefined && existing.permission === existing.key ? existing.permission
    : `${module.key}.${record.key}.${newName}`;
  if (issues.length > 0) return { kind: "invalid", issues };

  const actionKey = existing?.key ?? `${module.key}.${record.key}.${newName}`;
  // No orphan permissions: an action that moves off its own permission takes it away, unless
  // something else still uses it, which refuses the change with where.
  const ownBefore = module.permissions.find((permission) => permission.key === actionKey);
  if (change.permission.kind === "existing" && existing !== undefined && existing.permission === actionKey && ownBefore !== undefined) {
    const references = permissionReferences(source, module, actionKey, existing);
    if (references.length > 0)
      return { kind: "referenced", references,
        issue: `Permission: the action's own permission is still used in ${references.length === 1 ? "one place" : `${references.length} places`}, so it cannot be left behind. Remove those uses first.` };
    module.permissions = module.permissions.filter((permission) => permission !== ownBefore);
    for (const role of source.body.roles)
      (role as { permissions: string[] }).permissions = (role.permissions as string[]).filter((entry) => entry !== actionKey);
  }
  const values = Object.fromEntries(change.effects.map((effect) => [effect.field, structuredClone(effect.value)]));
  const effectTask = { id: uniqueAlias(effectTaskId, new Set(otherTasks.map((task) => task.id))), type: "record.set_fields",
    properties: { values } } as unknown as ActionTask;
  const firstEffect = (existing?.tasks ?? []).findIndex((task) => task.type === "record.set_fields");
  const tasks = change.effects.length === 0 ? otherTasks
    : firstEffect < 0 ? [effectTask, ...otherTasks]
      : [...otherTasks.slice(0, firstEffect), effectTask, ...otherTasks.slice(firstEffect)];
  const action = {
    id: existing?.id ?? uniqueAlias(`act_${record.key}_${newName}`, taken),
    key: actionKey,
    label,
    record_type: record.key,
    permission: permissionKey,
    shareable: existing?.shareable ?? false,
    inputs: existing?.inputs ?? [],
    ...(precondition === undefined ? {} : { precondition: structuredClone(precondition) }),
    tasks,
    ...(owned === undefined ? {} : { sets_choice_field: owned.field, sets_choice_option: owned.option }),
  } as unknown as ModuleAction;
  if (existing === undefined) {
    module.actions.push(action);
    (record.custom_actions as string[]).push(action.id);
  } else module.actions[module.actions.indexOf(existing)] = action;

  // The action's own permission reads what its condition reads and changes what it sets.
  const readable = [...new Set([...conditionFields(precondition), ...change.effects.map((effect) => effect.field)])];
  const changeable = [...new Set(change.effects.map((effect) => effect.field))];
  const own = module.permissions.find((permission) => permission.key === actionKey);
  if (change.permission.kind === "own") {
    const policy = { readable_fields: readable, changeable_fields: changeable };
    if (own === undefined) {
      module.permissions.push({
        id: uniqueAlias(`perm_${record.key}_${newName}`, taken), key: actionKey,
        label: `${label} (${record.name})`.slice(0, 60),
        description: `Allows the ${label} action on ${record.plural_name.toLowerCase()}.`.slice(0, 1_000),
        record_type: record.key, action_kind: "named", named_action: newName, administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] }, field_policy: policy,
      } as unknown as ModulePermission);
      for (const role of source.body.roles) {
        const entries = role.permissions as string[];
        if (!entries.includes("*") && !entries.includes(actionKey)) entries.push(actionKey);
      }
    } else (own as { field_policy?: unknown }).field_policy = policy;
  }
  return parsed(source, actionKey);
};

/**
 * Every place that uses an action's own permission besides the access groups that hold it, the
 * module's permissions and the action itself, which all let it go with the permission.
 */
const permissionReferences = (source: ApplicationSourceDocument, module: InlineModule, key: string,
  action: ModuleAction): readonly ApplicationUsePlace[] => {
  const moduleIndex = source.body.modules.indexOf(module);
  const actionIndex = module.actions.indexOf(action);
  return applicationUses(source, { kind: "permission", permissionKey: key }, (path) => path[1] === "roles" ||
    (path[1] === "modules" && path[2] === moduleIndex && (path[3] === "permissions" || (path[3] === "actions" && path[4] === actionIndex))));
};

/**
 * The Application source without one named action. It is refused while a flow, board or block still
 * runs it. Its own permission goes with it, from the module and from every access group.
 */
export const deleteInlineModuleAction = (
  current: ApplicationSourceDocument, moduleKey: string, actionKey: string,
): InlineModuleActionResult | Readonly<{ kind: "referenced"; references: readonly ApplicationUsePlace[] }> => {
  const references = applicationUses(current, { kind: "action", moduleKey, actionKey });
  if (references.length > 0) return { kind: "referenced", references };
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const action = module?.actions.find((item) => item.key === actionKey);
  if (module === undefined || action === undefined) return { kind: "invalid", issues: ["This action is not in the module any more."] };
  module.actions = module.actions.filter((item) => item !== action);
  for (const record of module.record_types)
    (record as { custom_actions: string[] }).custom_actions = (record.custom_actions as string[]).filter((id) => id !== action.id);
  const ownPermission = action.permission === actionKey;
  if (ownPermission) {
    module.permissions = module.permissions.filter((permission) => permission.key !== actionKey);
    for (const role of source.body.roles)
      (role as { permissions: string[] }).permissions = (role.permissions as string[]).filter((entry) => entry !== actionKey);
  }
  return parsed(source, actionKey);
};
