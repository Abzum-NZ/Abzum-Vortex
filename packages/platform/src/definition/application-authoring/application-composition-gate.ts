import {
  applicationAudienceSchema,
  type ApplicationAudience,
} from "../../catalogue/application-link";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "../application-source-contracts";
import { resolveStudioAccessGate } from "./application-access-commands";
import type {
  StudioCompositionContext,
  StudioDraftChangeResult,
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
  regions,
} from "./application-composition-regions";
import { sourceItemTree } from "../application-composition/source-composition";
import { studioFormChangeRefusal, studioFormShapeRefusal } from "./application-composition-forms";
import { studioPlacementReferenceSentence } from "./composition-references";
import type { StudioSemanticSelection } from "./semantic-selection";
import { validateStoredApplicationOutlets } from "./stored-composition";
import { describeFailure } from "../../catalogue/runtime-primitives";

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

/**
 * A use permission governs what the block starts: a block no workflow is bound to has nothing to
 * use, and the page read would show it unavailable to everyone.
 */
const startsWorkflow = (source: ApplicationSourceDocument, alias: string) =>
  source.body.flow_bindings.some((binding) => binding.control === alias);

const NO_WORKFLOW =
  "This block starts no workflow, so a use permission would only show it unavailable. " +
  "Add a workflow to it first.";

/**
 * Why an edit may not take the last workflow from a block that keeps a use permission, or
 * undefined: the use permission would then only show it unavailable, the state `NO_WORKFLOW`
 * refuses.
 */
export const studioWorkflowRemovalRefusal = (
  before: ApplicationSourceDocument,
  after: ApplicationSourceDocument,
): string | undefined => {
  const bound = new Set(after.body.flow_bindings.map((binding) => binding.control));
  const unbound = new Set(
    before.body.flow_bindings
      .map((binding) => binding.control)
      .filter((alias) => !bound.has(alias)),
  );
  if (unbound.size === 0) return undefined;
  const gated = regions(after).some((region) =>
    sourceItemTree(region.zone.items).some(
      (item) => unbound.has(item.props.id) && item.props.vortex.use_permission !== undefined,
    ),
  );
  return gated
    ? "This block has a use permission, so it keeps a workflow. Clear its use permission first."
    : undefined;
};

export const describeStudioCompositionGate = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
) => {
  try {
    const resolved = resolveGateTarget(context, selection, true);
    if (resolved.kind !== "available") return resolved;
    const vortex = resolved.target.item.props.vortex;
    return {
      kind: "available",
      permission: vortex.view_permission ?? null,
      use: vortex.use_permission ?? null,
      // A use permission set some other way can still be cleared here.
      useOffered:
        vortex.use_permission !== undefined || startsWorkflow(resolved.source, resolved.alias),
      audience: vortex.application_audience ?? null,
    } as const;
  } catch (error) {
    console.error(`[studio] block access could not be read: ${describeFailure(error)}`);
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
): StudioDraftChangeResult => {
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
  if (use?.key !== undefined && !startsWorkflow(source, alias))
    return { kind: "refused", reason: NO_WORKFLOW };
  const audience = named.includes("audience")
    ? ((input.audience as ApplicationAudience | null) ?? undefined)
    : undefined;
  const changes = {
    gate: view !== undefined && view.key !== vortex.view_permission,
    use: use !== undefined && use.key !== vortex.use_permission,
    audience: named.includes("audience") && audience !== vortex.application_audience,
  };
  if (!named.some((member) => changes[member])) {
    const unchanged = named[0]!;
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
  // A gate or an audience hides the block from people outside it: what its form needs stays
  // visible.
  if (view?.key !== undefined || audience !== undefined) {
    const hidden = studioFormChangeRefusal(
      current.catalogue,
      source,
      target.region.zone.items,
      regionAfter(target, alias),
    );
    if (hidden !== undefined && !studioFormShapeRefusal(hidden)) {
      const why = "A permission gate or audience hides this block from some people.";
      return { kind: "refused", reason: `${why} ${studioPlacementReferenceSentence(hidden)}` };
    }
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
