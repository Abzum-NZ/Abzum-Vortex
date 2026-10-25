import { applicationSourceDocumentSchema } from "@vortex/platform/schema";
import { resolveStudioAccessGate } from "./application-access-commands";
import type {
  StudioCompositionContext,
  StudioCompositionCommandResult,
} from "./application-composition-model";
import {
  closedPlain,
  commitWorking,
  manifestMatches,
  pinnedRelease,
  plainSource,
  resolve,
  validateRegion,
  workingCopy,
  workingItem,
  regionAfter,
} from "./application-composition-regions";
import { studioFormChangeRefusal, studioFormShapeRefusal } from "./application-composition-forms";
import { studioPlacementReferenceSentence } from "./composition-references";
import type { StudioSemanticSelection } from "./semantic-selection";
import { validateStoredApplicationOutlets } from "./stored-composition";

/**
 * Gate edits keep every placement, form context and flow reference intact, and never hide what a
 * form needs (the form rule of removal).
 */
const resolveGateTarget = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
) => {
  plainSource(context.source);
  const resolved = resolve(context, selection);
  if (resolved === undefined)
    return { kind: "refused", reason: "This block is no longer in the current draft." } as const;
  const { source, target } = resolved;
  const page = target.region.page;
  if (
    page !== undefined &&
    (page.type === "public" ||
      source.body.public_addresses.some((address) => address.page === page.id))
  )
    return {
      kind: "refused",
      reason: "A block on a public page cannot have its permission gate changed here.",
    } as const;
  if (page !== undefined && source.body.experiences?.some((entry) => entry.page === page.key))
    return {
      kind: "refused",
      reason:
        "This page belongs to an experience; its block permission gates cannot be changed here.",
    } as const;
  if (
    !manifestMatches(context.catalogue, source, target.region.zone.items) ||
    (target.region.parent !== undefined &&
      !pinnedRelease(context.catalogue, source, target.region.parent))
  )
    return {
      kind: "refused",
      reason:
        "This area contains a block release that is not in the draft's supported dependencies.",
    } as const;
  validateRegion(context.catalogue, target.region);
  return { kind: "available", ...resolved } as const;
};

export const describeStudioCompositionGate = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
) => {
  try {
    const resolved = resolveGateTarget(context, selection);
    if (resolved.kind !== "available") return resolved;
    return {
      kind: "available",
      permission: resolved.target.item.props.vortex.view_permission ?? null,
    } as const;
  } catch (error) {
    console.error("[studio] block permission gate could not be read", error);
    return {
      kind: "refused",
      reason: "This block's stored definition needs fixing before its permission gate can change.",
    } as const;
  }
};

/** Called inside the one composition command's context/revision check and refusal boundary. */
export const applyStudioCompositionGate = (
  current: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
  command: unknown,
): StudioCompositionCommandResult => {
  const input = closedPlain(command, ["kind", "gate"]);
  if (input.kind !== "gate" || (input.gate !== null && typeof input.gate !== "string"))
    return { kind: "invalid" };
  const resolved = resolveGateTarget(current, selection);
  if (resolved.kind !== "available") return resolved;
  const { source, target, alias } = resolved;
  const permission = input.gate === null ? null : resolveStudioAccessGate(source, input.gate);
  if (permission?.kind === "refused") return { kind: "refused", reason: permission.message };
  const key = permission?.key;
  if (key === target.item.props.vortex.view_permission)
    return {
      kind: "refused",
      reason:
        key === undefined
          ? "This block has no permission gate to clear."
          : "This block already has that permission gate.",
    };
  // A gate hides the block from people without the permission: what its form needs stays visible.
  if (key !== undefined) {
    const hidden = studioFormChangeRefusal(
      current.catalogue,
      source,
      target.region.zone.items,
      regionAfter(target, alias),
    );
    if (hidden !== undefined && !studioFormShapeRefusal(hidden))
      return {
        kind: "refused",
        reason: `A permission gate hides this block from people without the permission. ${studioPlacementReferenceSentence(hidden)}`,
      };
  }
  const working = workingCopy(target.region);
  const item = workingItem(working, target.steps, alias);
  if (key === undefined) delete item.props.vortex.view_permission;
  else item.props.vortex.view_permission = key;
  commitWorking(current.catalogue, target.region, working);
  validateStoredApplicationOutlets(current.catalogue, source);
  return { kind: "applied", source: applicationSourceDocumentSchema.parse(source) };
};
