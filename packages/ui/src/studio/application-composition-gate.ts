import {
  applicationAudienceSchema,
  applicationSourceDocumentSchema,
  type ApplicationAudience,
} from "@vortex/platform/schema";
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
  experiencePage,
  publishedPage,
} from "./application-composition-regions";
import { studioFormChangeRefusal, studioFormShapeRefusal } from "./application-composition-forms";
import { studioPlacementReferenceSentence } from "./composition-references";
import type { StudioSemanticSelection } from "./semantic-selection";
import { validateStoredApplicationOutlets } from "@vortex/platform/schema";

/**
 * Gate edits keep every placement, form context and flow reference intact, and never hide what a
 * form needs (the form rule of removal).
 */
const resolveGateTarget = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
  reading = false,
) => {
  plainSource(context.source);
  const resolved = resolve(context, selection, reading);
  if (resolved === undefined)
    return { kind: "refused", reason: "This block is no longer in the current draft." } as const;
  const { source, target } = resolved;
  const page = target.region.page;
  if (page !== undefined && publishedPage(source, page))
    return {
      kind: "refused",
      reason: experiencePage(source, page)
        ? "This page belongs to an experience; the access of its blocks cannot be changed here."
        : "A block on a public page cannot have its access changed here.",
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
    const resolved = resolveGateTarget(context, selection, true);
    if (resolved.kind !== "available") return resolved;
    return {
      kind: "available",
      permission: resolved.target.item.props.vortex.view_permission ?? null,
      use: resolved.target.item.props.vortex.use_permission ?? null,
      audience: resolved.target.item.props.vortex.application_audience ?? null,
    } as const;
  } catch (error) {
    console.error("[studio] block access could not be read", error);
    return {
      kind: "refused",
      reason: "This block's stored definition needs fixing before its access can change.",
    } as const;
  }
};

const members = ["gate", "use", "audience"] as const;
type Member = (typeof members)[number];

/** The words of each member for a change that would change nothing. */
const unchangedWords: Readonly<Record<Member, Readonly<{ none: string; same: string }>>> = {
  gate: {
    none: "This block has no permission gate to clear.",
    same: "This block already has that permission gate.",
  },
  use: {
    none: "This block has no use permission to clear.",
    same: "This block already has that use permission.",
  },
  audience: {
    none: "This block is already offered to everyone.",
    same: "This block is already offered to that audience.",
  },
};

/** Called inside the one composition command's context/revision check and refusal boundary. */
export const applyStudioCompositionGate = (
  current: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
  command: unknown,
): StudioCompositionCommandResult => {
  const named =
    typeof command === "object" && command !== null
      ? members.filter((member) => Object.hasOwn(command, member))
      : [];
  const input = closedPlain(command, ["kind", ...named]);
  const permissionInvalid = (value: unknown) => value !== null && typeof value !== "string";
  if (
    input.kind !== "gate" ||
    named.length === 0 ||
    (named.includes("gate") && permissionInvalid(input.gate)) ||
    (named.includes("use") && permissionInvalid(input.use)) ||
    (named.includes("audience") &&
      input.audience !== null &&
      !applicationAudienceSchema.safeParse(input.audience).success)
  )
    return { kind: "invalid" };
  const resolved = resolveGateTarget(current, selection);
  if (resolved.kind !== "available") return resolved;
  const { source, target, alias } = resolved;
  const vortex = target.item.props.vortex;
  // One permission choice for the view gate and the use permission: only the application's own
  // named permissions.
  const permissionOf = (value: unknown) => {
    if (value === null) return { kind: "resolved", key: undefined } as const;
    const choice = resolveStudioAccessGate(source, value as string);
    return choice.kind === "refused" ? choice : ({ kind: "resolved", key: choice.key } as const);
  };
  const view = named.includes("gate") ? permissionOf(input.gate) : undefined;
  const use = named.includes("use") ? permissionOf(input.use) : undefined;
  if (view?.kind === "refused") return { kind: "refused", reason: view.message };
  if (use?.kind === "refused") return { kind: "refused", reason: use.message };
  const audience = named.includes("audience")
    ? ((input.audience as ApplicationAudience | null) ?? undefined)
    : undefined;
  const changes = {
    gate: view !== undefined && view.key !== vortex.view_permission,
    use: use !== undefined && use.key !== vortex.use_permission,
    audience: named.includes("audience") && audience !== vortex.application_audience,
  };
  const unchanged = named.find((member) => !changes[member]);
  if (unchanged !== undefined && !named.some((member) => changes[member])) {
    const before = {
      gate: vortex.view_permission,
      use: vortex.use_permission,
      audience: vortex.application_audience,
    }[unchanged];
    return {
      kind: "refused",
      reason: unchangedWords[unchanged][before === undefined ? "none" : "same"],
    };
  }
  // A gate or an audience hides the block from people outside it: what its form needs stays visible.
  if (view?.key !== undefined || audience !== undefined) {
    const hidden = studioFormChangeRefusal(
      current.catalogue,
      source,
      target.region.zone.items,
      regionAfter(target, alias),
    );
    if (hidden !== undefined && !studioFormShapeRefusal(hidden))
      return {
        kind: "refused",
        reason: `A permission gate or audience hides this block from some people. ${studioPlacementReferenceSentence(hidden)}`,
      };
  }
  const working = workingCopy(target.region);
  const item = workingItem(working, target.steps, alias);
  if (view !== undefined) {
    if (view.key === undefined) delete item.props.vortex.view_permission;
    else item.props.vortex.view_permission = view.key;
  }
  if (use !== undefined) {
    if (use.key === undefined) delete item.props.vortex.use_permission;
    else item.props.vortex.use_permission = use.key;
  }
  if (named.includes("audience")) {
    if (audience === undefined) delete item.props.vortex.application_audience;
    else item.props.vortex.application_audience = audience;
  }
  commitWorking(current.catalogue, target.region, working);
  validateStoredApplicationOutlets(current.catalogue, source);
  return { kind: "applied", source: applicationSourceDocumentSchema.parse(source) };
};
