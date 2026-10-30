import {
  applicationUses,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
} from "@vortex/platform/schema";
import { syncStudioRecordRuleLists } from "./application-record-rules";

export type StudioFlowDelete =
  | Readonly<{ kind: "deleted"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "referenced"; references: readonly ApplicationUsePlace[] }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * The Application source without one flow, application-level (`moduleKey` null) or a module's. It is
 * refused, naming where, while anything of the draft still uses the flow: the same reference index
 * the inspector's "Used in" section reads.
 */
export const deleteStudioFlow = (
  source: Readonly<ApplicationSourceDocument>,
  flowAlias: string,
  moduleKey: string | null,
): StudioFlowDelete => {
  const references = applicationUses(source, { kind: "flow", flowAlias, moduleKey });
  if (references.length > 0) return { kind: "referenced", references };
  const candidate: ApplicationSourceDocument = structuredClone(source);
  if (moduleKey === null) {
    const flow = candidate.body.flows.find((entry) => entry.id === flowAlias);
    if (flow === undefined)
      return { kind: "refused", reason: "This flow is no longer in the draft." };
    candidate.body.flows = candidate.body.flows.filter((entry) => entry !== flow);
    return { kind: "deleted", source: candidate };
  }
  const module = candidate.body.modules.find((entry) => entry.key === moduleKey);
  const flow = module?.flows.find((entry) => entry.id === flowAlias);
  if (module === undefined || flow === undefined)
    return { kind: "refused", reason: "This flow is no longer in the draft." };
  module.flows = module.flows.filter((entry) => entry !== flow);
  syncStudioRecordRuleLists(module);
  return { kind: "deleted", source: candidate };
};
