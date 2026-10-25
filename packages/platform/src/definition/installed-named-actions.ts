import { installedNamedActionReferenceSchema } from "../records/named-actions";
import type { FlowNamedAction } from "./flow-orchestrator-types";
import type { InstalledRuntimeContext } from "./installed-runtime-context";
import type { ActionInputDefinition } from "./module-contracts";

type InstalledNamedActionDescriptor = Readonly<{
  key: string;
  named: FlowNamedAction;
  setsChoice: Readonly<{ fieldId: string; option: string }> | undefined;
}>;

/**
 * The key a flow calls the action `actionId` contributed to the owner record type `recordTypeId`
 * by. It cannot equal an authored action key, so a contributed action never shadows or is shadowed
 * by one, and the generated flow that runs it and the named action map agree on it.
 */
export const contributedActionKey = (recordTypeId: string, actionId: string): string =>
  `contributed:${recordTypeId.toLowerCase()}:${actionId.toLowerCase()}`;

/**
 * Every installed named action of one release set, with the choice option it declares it sets,
 * and the actions other installed Modules contributed to its record types, each bound to its
 * owner record type and still owned by its contributor's exact release.
 */
export const installedNamedActionDescriptors = (
  application: InstalledRuntimeContext["releaseSet"]["application"],
  modules: InstalledRuntimeContext["releaseSet"]["modules"],
  contributions: InstalledRuntimeContext["recordContributions"] = [],
): InstalledNamedActionDescriptor[] => {
  const descriptors: InstalledNamedActionDescriptor[] = [];
  const addActions = (
    owner: Readonly<{
      ownerKind: "application" | "module";
      ownerId: string;
      releaseRevision: number;
    }>,
    actions: readonly Readonly<{
      actionId: string;
      key: string;
      subjectRecordTypeId: string;
      inputs: readonly ActionInputDefinition[];
      setsChoiceFieldId?: string | undefined;
      setsChoiceOption?: string | undefined;
    }>[],
  ) => {
    for (const action of actions) {
      const reference = installedNamedActionReferenceSchema.safeParse({
        ...owner,
        actionId: action.actionId,
      });
      if (!reference.success) continue;
      descriptors.push({
        key: String(action.key),
        named: {
          action: reference.data,
          subjectRecordTypeId: String(action.subjectRecordTypeId),
          referenceInputTypes: Object.fromEntries(
            action.inputs.flatMap((input) => {
              if (input.type !== "record_reference") return [];
              const resolved = input.recordTypes.flatMap((target) =>
                target.state === "resolved" ? [String(target.recordTypeId)] : [],
              );
              // An input that names several record types cannot be typed from the id alone.
              return resolved.length === 1 ? [[input.key, resolved[0]!]] : [];
            }),
          ),
        },
        setsChoice:
          action.setsChoiceFieldId !== undefined && action.setsChoiceOption !== undefined
            ? { fieldId: String(action.setsChoiceFieldId), option: action.setsChoiceOption }
            : undefined,
      });
    }
  };
  addActions(
    {
      ownerKind: "application",
      ownerId: application.rootId,
      releaseRevision: application.releaseRevision,
    },
    application.content.actions,
  );
  for (const module of modules)
    addActions(
      { ownerKind: "module", ownerId: module.rootId, releaseRevision: module.releaseRevision },
      module.content.actions,
    );
  // A contributed action is called by its own key on the owner record type, never by the key its
  // contributor authored: that key may name the contributor's own action (when this application
  // binds the contributor too) or an owner action, and an ambiguous key would disable both.
  const contributedKeys = new Set<string>();
  for (const entry of contributions)
    for (const action of entry.actions) {
      const key = contributedActionKey(entry.recordTypeId, action.actionId);
      // The same exact contribution listed again adds nothing.
      if (contributedKeys.has(key)) continue;
      const reference = installedNamedActionReferenceSchema.safeParse({
        ownerKind: "module",
        ownerId: action.contributorModuleRootId,
        releaseRevision: action.contributorReleaseRevision,
        actionId: action.actionId,
      });
      if (!reference.success) continue;
      contributedKeys.add(key);
      descriptors.push({
        key,
        named: {
          action: reference.data,
          subjectRecordTypeId: entry.recordTypeId,
          referenceInputTypes: {},
        },
        setsChoice: undefined,
      });
    }
  return descriptors;
};

/**
 * Each installed named action of one release set by its key, as the exact action a Call protected
 * operation task names. An ambiguous key names no action rather than a guessed one.
 */
export const installedNamedActions = (
  application: InstalledRuntimeContext["releaseSet"]["application"],
  modules: InstalledRuntimeContext["releaseSet"]["modules"],
  contributions: InstalledRuntimeContext["recordContributions"] = [],
): Map<string, FlowNamedAction> => {
  const namedActions = new Map<string, FlowNamedAction>();
  const ambiguousActionKeys = new Set<string>();
  for (const { key, named } of installedNamedActionDescriptors(
    application,
    modules,
    contributions,
  )) {
    if (namedActions.has(key) || ambiguousActionKeys.has(key)) {
      namedActions.delete(key);
      ambiguousActionKeys.add(key);
      continue;
    }
    namedActions.set(key, named);
  }
  return namedActions;
};
