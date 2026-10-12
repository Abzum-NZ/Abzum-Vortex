import type { ContainedComponentId } from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";

/** A component's newest page-data request, scoped to one navigation instance. */
export type ComponentRequestGeneration = Readonly<{
  componentId: ContainedComponentId;
  navigationKey: string;
  generation: number;
}>;

/** Advances one placement's generation without resetting it when the page address changes. */
export const nextComponentRequestGeneration = (
  current: ComponentRequestGeneration | undefined,
  componentId: ContainedComponentId,
  navigationKey: string,
): ComponentRequestGeneration => ({
  componentId,
  navigationKey,
  generation:
    current !== undefined && sameId(current.componentId, componentId)
      ? current.generation + 1
      : 1,
});

/** A reread may update a placement only while both its navigation and generation are current. */
export const isCurrentComponentRequestGeneration = (
  current: ComponentRequestGeneration | undefined,
  request: ComponentRequestGeneration,
): boolean =>
  current !== undefined &&
  sameId(current.componentId, request.componentId) &&
  current.navigationKey === request.navigationKey &&
  current.generation === request.generation;
