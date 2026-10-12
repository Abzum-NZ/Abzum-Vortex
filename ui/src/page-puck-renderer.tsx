import { Render } from "@puckeditor/core";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import type {
  ApplicationShellV2,
  PageDefinitionV2,
  PageCompositionV2,
  ProjectedNavigation,
} from "@vortex/contracts";
import {
  ALL_UI_STYLES_CSS,
  createThemeRootProps,
  createVortexStyleRootProps,
  resolveVortexStyleSelection,
  VortexFontStylesheets,
  VortexStyleRoot,
  VortexStyleStylesheet,
  type ApplicationThemeV2,
  type ThemeMode,
} from "./theme";
import { IconLibraryProvider } from "./icons";
import { DateFormatProvider } from "./display/date-format-context";
import { Button } from "./components/button";
import { validatePlacementTree, type Breakpoint } from "./definition-error";
import {
  assertRuntimeInputKeysArePlacements,
  type PlatformComponentRegistry,
  type RuntimeInputsByPlacement,
} from "./registry";
import { getVortexPuckConfig, type VortexPuckMetadata } from "./puck-config";
import { createVortexPuckAdapterV2 } from "./vortex-puck-adapter";
import {
  resolveRootPlacementSlot,
  validatePlacementDependencies,
  validateProjectedAvailabilityTree,
  type GuidedFormCompositionV2,
  type MaterialisedApplicationCompositionV2,
  type ProjectedPageCapability,
  type PlacementSlotV2,
} from "./page-composition";

const collectPlacementIds = (slot: PlacementSlotV2, ids: Set<string> = new Set()): Set<string> => {
  for (const [id, placement] of Object.entries(slot.placements)) {
    ids.add(id);
    for (const child of Object.values(placement.slots)) collectPlacementIds(child, ids);
  }
  return ids;
};

const adapters = new WeakMap<
  PlatformComponentRegistry,
  ReturnType<typeof createVortexPuckAdapterV2>
>();
const adapterFor = (registry: PlatformComponentRegistry) => {
  let adapter = adapters.get(registry);
  if (adapter === undefined) {
    adapter = createVortexPuckAdapterV2(registry.toPlatformBlockCatalogue());
    adapters.set(registry, adapter);
  }
  return adapter;
};

export type PagePuckRendererProps = Readonly<{
  composition:
    | MaterialisedApplicationCompositionV2
    | PageDefinitionV2
    | PageCompositionV2
    | GuidedFormCompositionV2
    | ProjectedPageCapability;
  /**
   * Explicit breakpoint for preview canvases, rendered with that breakpoint's inline geometry and
   * order. Omit it for a live page, which adapts to the visitor's width (#1010).
   */
  breakpoint?: Breakpoint;
  registry: PlatformComponentRegistry;
  shells?: readonly ApplicationShellV2[];
  pageId?: string;
  activeStepId?: string;
  guidedStepNavigation?: Readonly<{
    disabled?: boolean;
    onBack: () => void;
    onNext: () => void;
  }>;
  guidedSummaryValues?: Readonly<Record<string, unknown>>;
  className?: string;
  style?: CSSProperties;
  /** Viewport surface for an installed application; embedded previews keep their host's bounds. */
  applicationSurface?: boolean;
  /** Host-owned outcomes rendered inside the same application theme as the composition. */
  feedback?: ReactNode;
  /** Overlays such as toasts, mounted inside the theme root so they use the application theme. */
  overlay?: ReactNode;
  /**
   * Raw component runtime inputs keyed by stable placement identity. Every key must name a
   * placement in the resolved tree, and each entry is validated fail-closed by that placement's own
   * registration, so the renderer itself names no payload field, event or callback.
   */
  runtimeInputs?: RuntimeInputsByPlacement;
  /**
   * The viewer's permission-filtered application menu, threaded to every navigation placement in
   * the resolved tree. It is server-projected viewer data, never an authored setting.
   */
  projectedNavigation?: ProjectedNavigation;
  /** Page-address resolver supplied by the shell; route composition owns the address shape. */
  resolvePageHref?: (pageId: string) => string;
  /** Internal page identity currently shown, for a navigation placement's current-page state. */
  currentPageId?: string;
  /**
   * Resolved #594 application theme. Defaults to the materialised composition's theme;
   * without one the readable platform defaults apply.
   */
  theme?: ApplicationThemeV2 | undefined;
  /** Light, dark or system appearance for the runtime page or preview canvas. */
  themeMode?: ThemeMode | undefined;
  /** Organisation or viewer BCP 47 locale for date presentation. */
  locale?: string | undefined;
  /** Organisation or viewer IANA time zone for timestamp presentation. */
  timeZone?: string | undefined;
  /**
   * The configured dedicated component origin. A page that places a custom component passes it so
   * the sandboxed host can frame the Vortex-owned bootstrap document on that origin.
   */
  componentBundleOrigin?: string | undefined;
}>;

export function PagePuckRenderer({
  composition,
  breakpoint,
  registry,
  shells = [],
  pageId,
  activeStepId,
  guidedStepNavigation,
  guidedSummaryValues,
  className,
  style,
  applicationSurface = false,
  feedback,
  overlay,
  runtimeInputs,
  projectedNavigation,
  resolvePageHref,
  currentPageId,
  theme,
  themeMode,
  locale,
  timeZone,
  componentBundleOrigin,
}: PagePuckRendererProps): ReactElement {
  const slot = resolveRootPlacementSlot({
    composition,
    shells,
    registry,
    ...(pageId === undefined ? {} : { pageId }),
    ...(activeStepId === undefined ? {} : { activeStepId }),
  });
  const projected =
    "composition" in composition &&
    !("type" in composition && "name" in composition) &&
    !("shellKind" in composition);
  const location = {
    ...(pageId === undefined ? {} : { pageId }),
    ...(activeStepId === undefined ? {} : { stepId: activeStepId }),
    ...(breakpoint === undefined ? {} : { breakpoint }),
  };
  if ("pages" in composition && Array.isArray(composition.pages))
    validatePlacementDependencies(slot, composition.platformBlockDependencies, location);
  validatePlacementTree(slot, registry, location, { allowEmptyRequiredSlots: projected });
  validateProjectedAvailabilityTree(slot, location);
  if (runtimeInputs !== undefined)
    assertRuntimeInputKeysArePlacements(collectPlacementIds(slot), runtimeInputs, location);
  const data = adapterFor(registry).toPuckData(slot);
  const applicationTheme = theme ?? ("theme" in composition ? composition.theme : undefined);
  const tokens = applicationTheme?.tokens ?? {};
  const vortexStyle = resolveVortexStyleSelection(applicationTheme?.selection);
  const metadata: VortexPuckMetadata = {
    ...(breakpoint === undefined ? {} : { breakpoint }),
    ...(runtimeInputs === undefined ? {} : { runtimeInputs }),
    ...(projectedNavigation === undefined ? {} : { projectedNavigation }),
    ...(resolvePageHref === undefined ? {} : { resolvePageHref }),
    ...(currentPageId === undefined ? {} : { currentPageId }),
    ...(componentBundleOrigin === undefined ? {} : { componentBundleOrigin }),
    themeScope: { application: tokens, inherited: tokens },
  };
  const guidedSteps =
    "steps" in composition && Array.isArray(composition.steps) ? composition.steps : undefined;
  const stepIndex =
    activeStepId === undefined
      ? -1
      : (guidedSteps?.findIndex((step) => step.id === activeStepId) ?? -1);
  const step = stepIndex < 0 ? undefined : guidedSteps?.[stepIndex];
  return (
    <VortexStyleRoot
      {...createThemeRootProps(applicationTheme, themeMode)}
      {...createVortexStyleRootProps(vortexStyle)}
      {...(applicationSurface ? { "data-vortex-application-surface": "" } : {})}
    >
      <VortexStyleStylesheet style={vortexStyle.style} />
      <VortexFontStylesheets tokens={tokens} />
      <style href="vortex-ui-styles" precedence="default">
        {ALL_UI_STYLES_CSS}
      </style>
      <IconLibraryProvider library={applicationTheme?.selection?.iconLibrary}>
        <DateFormatProvider locale={locale} timeZone={timeZone}>
          {feedback == null ? null : <div data-vortex-page-feedback="">{feedback}</div>}
          <div className={className} style={style}>
            <Render config={getVortexPuckConfig(registry)} data={data} metadata={metadata} />
          </div>
          {step?.summary !== true || guidedSummaryValues === undefined ? null : (
            <section aria-label="Review your answers" className="mt-6">
              <h2 className="text-lg font-semibold">Review your answers</h2>
              <dl className="mt-3 grid gap-3">
                {Object.entries(guidedSummaryValues).map(([field, value]) => (
                  <div key={field} className="rounded-md border p-3">
                    <dt className="font-medium">{field}</dt>
                    <dd className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {value === null
                        ? "Empty"
                        : typeof value === "string"
                          ? value
                          : JSON.stringify(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {guidedStepNavigation === undefined ||
          stepIndex < 0 ||
          guidedSteps === undefined ? null : (
            <nav aria-label="Guided form steps" className="mt-6 flex items-center gap-3">
              <span aria-live="polite" className="mr-auto text-sm text-muted-foreground">
                <span className="block font-medium text-foreground">{step?.name}</span>
                <span>
                  Step {stepIndex + 1} of {guidedSteps.length}
                </span>
              </span>
              <Button
                type="button"
                variant="secondary"
                disabled={guidedStepNavigation.disabled || stepIndex === 0}
                onClick={guidedStepNavigation.onBack}
              >
                Back
              </Button>
              <Button
                type="button"
                disabled={guidedStepNavigation.disabled}
                onClick={guidedStepNavigation.onNext}
              >
                {step?.summary === true ? "Confirm" : "Next"}
              </Button>
            </nav>
          )}
        </DateFormatProvider>
      </IconLibraryProvider>
      {overlay}
    </VortexStyleRoot>
  );
}
