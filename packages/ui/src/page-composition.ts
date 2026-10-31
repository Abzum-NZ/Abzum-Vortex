import {
  compiledItemTree,
  compiledPageShellId,
  resolveCompositionRoots,
  type AnyPageComposition,
  type ApplicationShell,
  type CompiledLayout,
  type PageDefinition,
} from "@vortex/platform/schema";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "./definition-error";
import { projectedAvailability } from "./placement-availability";

/**
 * The one input the page renderer draws: a page whose layout is already resolved into its frame
 * (its shell's layout with the page content placed in it), as Puck data, or one such layout for
 * every guided step. A server-projected page arrives in exactly this shape; a page definition
 * becomes it through `renderedPageOf`.
 */
export type RenderedPage = Readonly<{
  pageId?: string;
  steps?: readonly Readonly<{ id: string; name?: string; summary?: boolean }>[];
  composition: CompiledLayout | Readonly<{ stepContent: Readonly<Record<string, CompiledLayout>> }>;
}>;

export const validateProjectedAvailabilityTree = (
  layout: CompiledLayout,
  location: DefinitionRenderErrorLocation,
): void => {
  for (const item of compiledItemTree(layout.content))
    projectedAvailability(item.props.vortex, { ...location, placementId: item.props.id });
};

const requireUniqueShell = (
  shells: readonly ApplicationShell[],
  shellId: string,
  pageId: string,
): ApplicationShell => {
  const matches = shells.filter((candidate) => candidate.shellId === shellId);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new DefinitionRenderError(
      "UNRESOLVED_SHELL",
      `Shell '${shellId}' referenced by page '${pageId}' resolved ${matches.length} times`,
      { pageId, shellId },
    );
  }
  return matches[0];
};

/** One compiled composition resolved into its frame, as the renderer draws it. */
const renderedCompositionOf = (
  pageId: string,
  composition: AnyPageComposition,
  steps: readonly Readonly<{ id: string; name: string; summary: boolean }>[] | undefined,
  shells: readonly ApplicationShell[],
): Readonly<{ page: RenderedPage; shell?: ApplicationShell }> => {
  const shellId = compiledPageShellId(composition);
  const shell = shellId === null ? undefined : requireUniqueShell(shells, shellId, pageId);
  let roots: ReturnType<typeof resolveCompositionRoots>;
  try {
    roots = resolveCompositionRoots(
      composition,
      steps?.map((step) => String(step.id)),
      shell === undefined ? [] : [shell],
    );
  } catch (error) {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Page '${pageId}' content does not fit its frame`,
      { pageId, ...(shell === undefined ? {} : { shellId: shell.shellId }) },
      { cause: error },
    );
  }
  return {
    page: {
      pageId,
      ...(steps === undefined ? {} : { steps }),
      composition: roots.kind === "page" ? roots.main : { stepContent: roots.stepContent },
    },
    ...(shell === undefined ? {} : { shell }),
  };
};

/**
 * One page definition as the renderer draws it: its layout resolved into its frame, and the shell
 * that frames it. Shell resolution is the platform's one resolution, so a definition page renders
 * exactly as its projected form does.
 */
export const renderedPageOf = (
  page: PageDefinition,
  shells: readonly ApplicationShell[],
): Readonly<{ page: RenderedPage; shell?: ApplicationShell }> =>
  renderedCompositionOf(
    page.pageId,
    page.composition,
    page.type === "guided_form" ? page.steps : undefined,
    shells,
  );

/**
 * The layout one rendered page draws: the page's own layout, or the active guided step's. A
 * guided page's step content must match its declared steps exactly.
 */
export const selectRenderedLayout = (
  page: RenderedPage,
  activeStepId: string | undefined,
): CompiledLayout => {
  const location: DefinitionRenderErrorLocation =
    page.pageId === undefined ? {} : { pageId: page.pageId };
  const composition = page.composition;
  if (!("stepContent" in composition)) return composition;
  const stepMap = composition.stepContent;
  const contentIds = Object.keys(stepMap);
  if (page.steps !== undefined) {
    const declaredIds = page.steps.map((step) => String(step.id));
    if (
      declaredIds.length === 0 ||
      new Set(declaredIds).size !== declaredIds.length ||
      contentIds.length !== declaredIds.length ||
      contentIds.some((stepId) => !declaredIds.includes(stepId))
    )
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        "Guided-step content must match the declared ordered steps exactly once",
        location,
      );
    if (activeStepId !== undefined && !declaredIds.includes(activeStepId))
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Guided step '${activeStepId}' is not in the declared step order`,
        { ...location, stepId: activeStepId },
      );
  } else if (activeStepId === undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "An active guided-step identity is required when the ordered step definition is unavailable",
      location,
    );
  const stepId = activeStepId ?? String(page.steps?.[0]?.id);
  const layout = stepMap[stepId];
  if (layout === undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Guided step '${stepId}' has no step content`,
      { ...location, stepId },
    );
  return layout;
};
