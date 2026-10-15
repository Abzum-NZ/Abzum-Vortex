import { installedNamedActionReferenceSchema } from "../schema";
import type { FlowNamedAction } from "./flow-orchestrator-types";
import type { InstalledRuntimeContext } from "./installed-runtime-context";
import type { ActionInputDefinition } from "./module-contracts";

/**
 * Each installed named action of one release set by its key, as the exact action a Call protected
 * operation task names. An ambiguous key names no action rather than a guessed one.
 */
export const installedNamedActions = (
  application: InstalledRuntimeContext["releaseSet"]["application"],
  modules: InstalledRuntimeContext["releaseSet"]["modules"],
): Map<string, FlowNamedAction> => {
  const namedActions = new Map<string, FlowNamedAction>();
  const ambiguousActionKeys = new Set<string>();
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
    }>[],
  ) => {
    for (const action of actions) {
      const key = String(action.key);
      const reference = installedNamedActionReferenceSchema.safeParse({
        ...owner,
        actionId: action.actionId,
      });
      if (!reference.success) continue;
      if (namedActions.has(key) || ambiguousActionKeys.has(key)) {
        namedActions.delete(key);
        ambiguousActionKeys.add(key);
        continue;
      }
      namedActions.set(key, {
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
  return namedActions;
};
