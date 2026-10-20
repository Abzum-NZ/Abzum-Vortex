import "server-only";

import { isRecord, type CompiledLayout, type PageDefinition } from "../schema";
import { TABLE_BLOCK_RELEASE } from "../definition/application-composition-catalogue";
import type { ResolvedPageComposition } from "./page-composition-resolution";
import { placementViewShown } from "./projected-navigation";

export type PlacementCapabilityState = Readonly<{
  viewAllowed: boolean;
  useAllowed: boolean;
  /** The placement binds an operation, or a binding it cannot prove; it then needs `operationBound`. */
  operationRequired?: boolean;
  operationBound: boolean;
  conditionAllowed?: boolean;
  /** The placement's bound action cannot run on the page's subject for the viewer when false. */
  actionAvailable?: boolean;
}>;

export type PageCapabilityState = Readonly<{
  pageAllowed: boolean;
  placements: Readonly<Record<string, PlacementCapabilityState>>;
  /** Current organisation Access version this projection was decided under, when known. */
  accessVersion?: number;
  /** Exact installed application release revision this projection was decided under, when known. */
  applicationReleaseRevision?: number;
}>;

/**
 * The permission-filtered page definition the viewer may render. It carries the `accessVersion`
 * and `applicationReleaseRevision` it was decided under when the server knows them; `undefined`
 * means the page itself is refused, never an empty page.
 */
export type ProjectedPageCapability = Readonly<Record<string, unknown>> | undefined;

/**
 * The one fixed neutral state of a link destination the current viewer may not open. Missing,
 * refused, withdrawn, not-installed and unknown targets all collapse to this exact frozen value,
 * which carries no name, icon, address or reason, so nothing can distinguish why it is
 * unavailable and a tile rendered in this state can only be removed.
 */
const unavailableLinkDestination = Object.freeze({
  availability: "unavailable" as const,
});

type UnavailableLinkDestination = typeof unavailableLinkDestination;

/** A link destination already proven openable for the current viewer from trusted evidence only. */
type AvailableLinkDestination =
  | Readonly<{ availability: "available"; kind: "page"; pageId: string }>
  | Readonly<{ availability: "available"; kind: "application"; applicationRootId: string }>
  | Readonly<{ availability: "available"; kind: "external"; address: string }>;

/**
 * Resolution of one declared link target at navigation time. An available variant names only what
 * the server proved; the unavailable variant is opaque. Callers render the opaque variant with no
 * name, icon, address or reason and never activate it.
 */
export type ProjectedLinkDestination = AvailableLinkDestination | UnavailableLinkDestination;

/** The shared opaque unavailable destination; callers never build a different one from input. */
export const projectUnavailableLinkDestination = (): UnavailableLinkDestination =>
  unavailableLinkDestination;

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject => value as JsonObject;

const withoutKeys = (value: JsonObject, keys: readonly string[]): JsonObject =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

/**
 * A placement with neither a use gate nor an operation binding is plain content. Otherwise it is
 * available only when the viewer may use it and its operation binding resolves in the release, so
 * an omitted use gate never makes an unresolved binding invocable. An available control carries no
 * marker; anything else is fixed to the unavailable state, which the renderer sends unbound.
 */
const placementAvailability = (state: PlacementCapabilityState, hasUseGate: boolean): JsonObject =>
  (!hasUseGate && state.operationRequired !== true && !state.operationBound) ||
  (state.useAllowed && state.operationBound)
    ? {}
    : { availability: "unavailable", unavailableReason: "operation_unavailable" };

const reservedProps = new Set(["id", "vortex"]);

/** One projected item list: refused items dropped, kept items annotated, slot orders filtered. */
const projectItems = (
  itemsCandidate: unknown,
  states: PageCapabilityState["placements"],
): JsonObject[] =>
  (itemsCandidate as unknown[]).flatMap((candidate) => {
    const item = object(candidate);
    const props = object(item.props);
    const vortex = object(props.vortex);
    const placementId = String(props.id);
    const state = states[placementId];
    if (
      !placementViewShown(vortex.viewPermissionKey, state?.viewAllowed) ||
      (vortex.visibilityCondition !== undefined && state?.conditionAllowed !== true) ||
      state?.actionAvailable === false
    )
      return [];
    const effectiveState: PlacementCapabilityState = {
      viewAllowed: true,
      useAllowed: vortex.usePermissionKey === undefined || state?.useAllowed === true,
      operationRequired: state?.operationRequired === true,
      operationBound: state?.operationBound === true,
    };
    const projectedProps: JsonObject = {};
    const slotOrders: JsonObject = {};
    // The item's slots are exactly those its `vortex.slotOrders` orders; every other prop is a
    // plain setting value, a list setting included.
    const slotKeys = new Set(Object.keys(object(vortex.slotOrders)));
    for (const [key, value] of Object.entries(props)) {
      if (reservedProps.has(key)) continue;
      if (!slotKeys.has(key)) {
        // Default documents are server configuration, including potentially sensitive filter
        // values. Only the selected document, projected under current access, reaches the grid.
        projectedProps[key] =
          key === "features" &&
          isRecord(vortex.block) &&
          vortex.block.blockId === TABLE_BLOCK_RELEASE.blockId &&
          isRecord(value) &&
          isRecord(value.saved_views) &&
          value.saved_views.enabled === true
            ? { ...value, saved_views: { ...value.saved_views, default_views: [] } }
            : value;
        continue;
      }
      const children = projectItems(value, states);
      projectedProps[key] = children;
      slotOrders[key] = filteredOrder(object(vortex.slotOrders)[key], children);
    }
    return [
      {
        type: item.type,
        props: {
          id: props.id,
          ...projectedProps,
          vortex: {
            ...withoutKeys(vortex, [
              "viewPermissionKey",
              "usePermissionKey",
              "visibilityCondition",
            ]),
            slotOrders,
            ...placementAvailability(effectiveState, vortex.usePermissionKey !== undefined),
          },
        },
      },
    ];
  });

/** A breakpoint order keeping only the items the projection retained. */
const filteredOrder = (order: unknown, items: readonly JsonObject[]): JsonObject => {
  const retained = new Set(items.map((item) => String(object(item.props).id)));
  return Object.fromEntries(
    Object.entries(object(order)).map(([breakpoint, ids]) => [
      breakpoint,
      (ids as string[]).filter((id) => retained.has(id)),
    ]),
  );
};

/** One projected layout: its root zone's items and order. */
const projectLayout = (
  layout: CompiledLayout,
  states: PageCapabilityState["placements"],
): JsonObject => {
  const content = projectItems(layout.content, states);
  return {
    root: {
      props: {
        vortex: {
          slotOrders: {
            content: filteredOrder(layout.root.props.vortex.slotOrders.content, content),
          },
        },
      },
    },
    content,
  };
};

const project = (
  resolved: ResolvedPageComposition,
  states: PageCapabilityState["placements"],
): JsonObject => {
  const page: PageDefinition = resolved.page;
  const source = object(page);
  if (resolved.roots.kind === "page")
    return {
      ...withoutKeys(source, ["accessPermissionKey"]),
      composition: projectLayout(resolved.roots.main, states),
    };
  return {
    ...withoutKeys(source, ["accessPermissionKey"]),
    composition: {
      stepContent: Object.fromEntries(
        Object.entries(resolved.roots.stepContent).map(([stepId, root]) => [
          stepId,
          projectLayout(root, states),
        ]),
      ),
    },
  };
};

/**
 * Pure server projection over an already verified, exact page and server-owned
 * permission results. Callers never supply this state directly. The current organisation Access
 * version and installed application release revision are carried on the result when the server
 * knows them, so a client can refuse to restore older history, cache or late responses.
 */
export const projectPageCapability = (
  resolved: ResolvedPageComposition,
  capability: PageCapabilityState,
): ProjectedPageCapability => {
  if (!capability.pageAllowed) return undefined;
  return {
    ...project(resolved, capability.placements),
    ...(capability.accessVersion === undefined ? {} : { accessVersion: capability.accessVersion }),
    ...(capability.applicationReleaseRevision === undefined
      ? {}
      : { applicationReleaseRevision: capability.applicationReleaseRevision }),
  };
};
