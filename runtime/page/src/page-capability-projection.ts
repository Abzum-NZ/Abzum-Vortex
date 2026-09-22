import "server-only";

import type { PageDefinitionV2 } from "@vortex/contracts";
import type { ResolvedPageComposition } from "./page-composition-resolution";

export type PlacementCapabilityState = Readonly<{
  viewAllowed: boolean;
  useAllowed: boolean;
  operationBound: boolean;
  conditionAllowed?: boolean;
}>;

export type PageCapabilityState = Readonly<{
  pageAllowed: boolean;
  placements: Readonly<Record<string, PlacementCapabilityState>>;
}>;

export type ProjectedPageCapability = Readonly<Record<string, unknown>> | undefined;

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject => value as JsonObject;

const withoutKeys = (value: JsonObject, keys: readonly string[]): JsonObject =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

const placementAvailability = (state: PlacementCapabilityState, hasUseGate: boolean): JsonObject =>
  !hasUseGate && !state.operationBound
    ? {}
    : { availability: "unavailable", unavailableReason: "operation_unavailable" };

const projectV2Slot = (
  slotCandidate: unknown,
  states: PageCapabilityState["placements"],
): JsonObject => {
  const slot = object(slotCandidate);
  const placements = object(slot.placements);
  const projected = Object.fromEntries(
    Object.entries(placements).flatMap(([placementId, candidate]) => {
      const state = states[placementId];
      const placement = object(candidate);
      if (
        (placement.viewPermissionKey !== undefined && state?.viewAllowed !== true) ||
        (placement.visibilityCondition !== undefined && state?.conditionAllowed !== true)
      )
        return [];
      const effectiveState: PlacementCapabilityState = {
        viewAllowed: true,
        useAllowed: placement.usePermissionKey === undefined || state?.useAllowed === true,
        operationBound: state?.operationBound === true,
      };
      const slots = Object.fromEntries(
        Object.entries(object(placement.slots)).map(([key, child]) => [
          key,
          projectV2Slot(child, states),
        ]),
      );
      return [
        [
          placementId,
          {
            ...withoutKeys(placement, [
              "viewPermissionKey",
              "usePermissionKey",
              "visibilityCondition",
            ]),
            slots,
            ...placementAvailability(effectiveState, placement.usePermissionKey !== undefined),
          },
        ],
      ];
    }),
  );
  const retained = new Set(Object.keys(projected));
  const order = Object.fromEntries(
    Object.entries(object(slot.order)).map(([breakpoint, ids]) => [
      breakpoint,
      (ids as string[]).filter((id) => retained.has(id)),
    ]),
  );
  return { placements: projected, order };
};

const projectV2 = (
  resolved: ResolvedPageComposition,
  states: PageCapabilityState["placements"],
): JsonObject => {
  const page: PageDefinitionV2 = resolved.page;
  const source = object(page);
  if (resolved.roots.kind === "page")
    return {
      ...withoutKeys(source, ["accessPermissionKey"]),
      composition: { main: projectV2Slot(resolved.roots.main, states) },
    };
  return {
    ...withoutKeys(source, ["accessPermissionKey"]),
    composition: {
      stepContent: Object.fromEntries(
        Object.entries(resolved.roots.stepContent).map(([stepId, root]) => [
          stepId,
          projectV2Slot(root, states),
        ]),
      ),
    },
  };
};

/**
 * Pure server projection over an already verified, exact page and server-owned
 * permission results. Callers never supply this state directly.
 */
export const projectPageCapability = (
  resolved: ResolvedPageComposition,
  capability: PageCapabilityState,
): ProjectedPageCapability => {
  if (!capability.pageAllowed) return undefined;
  return projectV2(resolved, capability.placements);
};
