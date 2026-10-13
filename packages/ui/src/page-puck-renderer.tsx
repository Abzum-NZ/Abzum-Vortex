// The render-only entry: the main entry would also bundle the whole editor for every page view.
import { Render } from "@puckeditor/core/rsc";
import type { CSSProperties, MouseEvent, ReactElement, ReactNode } from "react";
import {
  resolveShadcnIconLibrary,
  type ApplicationShell,
  type ApplicationPuckRootShell,
  type PageDefinition,
  type PageComposition,
  type ProjectedNavigation,
} from "@vortex/platform/schema";
import {
  ALL_UI_STYLES_CSS,
  createThemeRootProps,
  createVortexStyleRootProps,
  resolveVortexStyleSelection,
  VortexStyleRoot,
  type ApplicationTheme,
  type PlatformThemeTokens,
  type ThemeMode,
} from "./theme";
import { IconLibraryProvider } from "./icons";
import type { ApplicationShellRuntime } from "./navigation/application-shell";
import { DateFormatProvider } from "./display/date-format-context";
import { Button } from "./components/button";
import { validatePlacementTree, type Breakpoint } from "./definition-error";
import {
  assertRuntimeInputKeysArePlacements,
  type PlatformComponentRegistry,
  type FieldInputControlReleaseMap,
  type RuntimeInputsByPlacement,
} from "./registry";
import {
  getVortexPuckConfig,
  VortexPuckThemeScopeProvider,
  type VortexPuckMetadata,
} from "./puck-config";
import { createVortexPuckAdapter } from "./vortex-puck-adapter";
import {
  resolveRootPlacementSlotWithContext,
  validatePlacementDependencies,
  validateProjectedAvailabilityTree,
  type GuidedFormComposition,
  type MaterialisedApplicationComposition,
  type ProjectedPageCapability,
  type PlacementSlot,
} from "./page-composition";

const collectPlacementIds = (slot: PlacementSlot, ids: Set<string> = new Set()): Set<string> => {
  for (const [id, placement] of Object.entries(slot.placements)) {
    ids.add(id);
    for (const child of Object.values(placement.slots)) collectPlacementIds(child, ids);
  }
  return ids;
};

const adapters = new WeakMap<
  PlatformComponentRegistry,
  ReturnType<typeof createVortexPuckAdapter>
>();
const adapterFor = (registry: PlatformComponentRegistry) => {
  let adapter = adapters.get(registry);
  if (adapter === undefined) {
    adapter = createVortexPuckAdapter(registry.toPlatformBlockCatalogue());
    adapters.set(registry, adapter);
  }
  return adapter;
};

type ResolvedPageInputs = Readonly<{
  composition: PagePuckRendererProps["composition"];
  shells: PagePuckRendererProps["shells"];
  selectedShell: PagePuckRendererProps["shell"];
  registry: PlatformComponentRegistry;
  pageId: string | undefined;
  activeStepId: string | undefined;
  breakpoint: Breakpoint | undefined;
}>;

type ResolvedPageData = Readonly<{
  slot: PlacementSlot;
  data: ReturnType<ReturnType<typeof createVortexPuckAdapter>["toPuckData"]>;
}>;

const resolvedPages = new WeakMap<
  object,
  { inputs: ResolvedPageInputs; resolved: ResolvedPageData }[]
>();

/**
 * The resolved, validated Puck data of one page. It depends only on the immutable definition
 * inputs (composition, shells, registry, page, step and breakpoint), so it is computed once per
 * distinct set of them; runtime inputs reach the blocks through Puck metadata and never repeat it.
 */
const resolvedPageData = (inputs: ResolvedPageInputs): ResolvedPageData => {
  const { composition, shells, selectedShell, registry, pageId, activeStepId, breakpoint } = inputs;
  const entries = resolvedPages.get(composition) ?? [];
  const cached = entries.find(
    (entry) =>
      entry.inputs.shells === shells &&
      entry.inputs.selectedShell === selectedShell &&
      entry.inputs.registry === registry &&
      entry.inputs.pageId === pageId &&
      entry.inputs.activeStepId === activeStepId &&
      entry.inputs.breakpoint === breakpoint,
  );
  if (cached !== undefined) return cached.resolved;
  const resolved = resolveRootPlacementSlotWithContext({
    composition,
    shells: shells ?? [],
    registry,
    ...(pageId === undefined ? {} : { pageId }),
    ...(activeStepId === undefined ? {} : { activeStepId }),
  });
  const { slot, permissionProjected } = resolved;
  const shell = selectedShell ?? resolved.shell;
  const location = {
    ...(pageId === undefined ? {} : { pageId }),
    ...(activeStepId === undefined ? {} : { stepId: activeStepId }),
    ...(breakpoint === undefined ? {} : { breakpoint }),
  };
  if ("pages" in composition && Array.isArray(composition.pages))
    validatePlacementDependencies(slot, composition.platformBlockDependencies, location);
  validatePlacementTree(slot, registry, location, { allowEmptyRequiredSlots: permissionProjected });
  validateProjectedAvailabilityTree(slot, location);
  const rootShell: ApplicationPuckRootShell =
    shell === undefined
      ? { kind: "default" }
      : {
          kind: "application",
          shellId: shell.shellId,
          key: shell.key,
          name: shell.name,
          presentation: shell.presentation,
        };
  const result: ResolvedPageData = {
    slot,
    data: adapterFor(registry).toPuckData(slot, breakpoint, rootShell),
  };
  entries.push({ inputs, resolved: result });
  resolvedPages.set(composition, entries);
  return result;
};

export type PagePuckRendererProps = Readonly<{
  composition:
    | MaterialisedApplicationComposition
    | PageDefinition
    | PageComposition
    | GuidedFormComposition
    | ProjectedPageCapability;
  /**
   * Explicit breakpoint for preview canvases, rendered with that breakpoint's inline geometry and
   * order. Omit it for a live page, which adapts to the visitor's width (#1010).
   */
  breakpoint?: Breakpoint;
  registry: PlatformComponentRegistry;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
  shells?: readonly ApplicationShell[];
  /** The selected definition shell for a page already projected by the server. */
  shell?: ApplicationShell;
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
  /**
   * Internal page activation supplied by the shell. It performs the client-side transition, so
   * the shell stays mounted; without it the browser follows the resolved address.
   */
  onNavigatePage?: (pageId: string, event: MouseEvent<HTMLAnchorElement>) => void;
  /** Internal page identity currently shown, for a navigation placement's current-page state. */
  currentPageId?: string;
  /**
   * Resolved #594 application theme. Defaults to the materialised composition's theme;
   * without one the readable platform defaults apply.
   */
  theme?: ApplicationTheme | undefined;
  /** Light, dark or system appearance for the runtime page or preview canvas. */
  themeMode?: ThemeMode | undefined;
  /** Organisation or viewer BCP 47 locale for date presentation. */
  locale?: string | undefined;
  /** Organisation or viewer IANA time zone for timestamp presentation. */
  timeZone?: string | undefined;
  /** Runtime labels and permitted application links for the application shell root. */
  applicationShellRuntime?: ApplicationShellRuntime | undefined;
  /** Protected search results for a search block placed in the application definition. */
  applicationSearch?: VortexPuckMetadata["applicationSearch"];
  /** Record subject preserved by a search form placed on a detail page. */
  applicationSearchPageSubject?: string | undefined;
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
  fieldInputControlReleases,
  platformThemeTokens,
  shells,
  shell: selectedShell,
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
  onNavigatePage,
  currentPageId,
  theme,
  themeMode,
  locale,
  timeZone,
  applicationShellRuntime,
  applicationSearch,
  applicationSearchPageSubject,
  componentBundleOrigin,
}: PagePuckRendererProps): ReactElement {
  const { slot, data } = resolvedPageData({
    composition,
    shells,
    selectedShell,
    registry,
    pageId,
    activeStepId,
    breakpoint,
  });
  const location = {
    ...(pageId === undefined ? {} : { pageId }),
    ...(activeStepId === undefined ? {} : { stepId: activeStepId }),
    ...(breakpoint === undefined ? {} : { breakpoint }),
  };
  if (runtimeInputs !== undefined)
    assertRuntimeInputKeysArePlacements(collectPlacementIds(slot), runtimeInputs, location);
  const applicationTheme = theme ?? ("theme" in composition ? composition.theme : undefined);
  const tokens = applicationTheme?.tokens ?? {};
  const vortexStyle = resolveVortexStyleSelection(applicationTheme?.selection);
  const themeRootProps = createThemeRootProps(applicationTheme, platformThemeTokens, themeMode);
  const vortexStyleProps = createVortexStyleRootProps(vortexStyle);
  const metadata: VortexPuckMetadata = {
    ...(breakpoint === undefined ? {} : { breakpoint }),
    ...(runtimeInputs === undefined ? {} : { runtimeInputs }),
    ...(projectedNavigation === undefined ? {} : { projectedNavigation }),
    ...(resolvePageHref === undefined ? {} : { resolvePageHref }),
    ...(onNavigatePage === undefined ? {} : { onNavigatePage }),
    ...(currentPageId === undefined ? {} : { currentPageId }),
    ...(componentBundleOrigin === undefined ? {} : { componentBundleOrigin }),
    ...(applicationShellRuntime === undefined ? {} : { applicationShellRuntime }),
    ...(applicationSearch === undefined ? {} : { applicationSearch }),
    ...(applicationSearchPageSubject === undefined ? {} : { applicationSearchPageSubject }),
  };
  const guidedSteps =
    "steps" in composition && Array.isArray(composition.steps) ? composition.steps : undefined;
  const stepIndex =
    activeStepId === undefined
      ? -1
      : (guidedSteps?.findIndex((step) => step.id === activeStepId) ?? -1);
  const step = stepIndex < 0 ? undefined : guidedSteps?.[stepIndex];
  const screen = (
    <DateFormatProvider locale={locale} timeZone={timeZone}>
      {feedback == null ? null : <div data-vortex-page-feedback="">{feedback}</div>}
      <div className={className} style={style}>
        <VortexPuckThemeScopeProvider scope={{ application: tokens, inherited: tokens }}>
          <Render
            config={getVortexPuckConfig(registry, fieldInputControlReleases, platformThemeTokens)}
            data={data}
            metadata={metadata}
          />
        </VortexPuckThemeScopeProvider>
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
      {guidedStepNavigation === undefined || stepIndex < 0 || guidedSteps === undefined ? null : (
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
  );
  return (
    <VortexStyleRoot
      {...themeRootProps}
      {...vortexStyleProps}
      style={{ ...themeRootProps.style, ...vortexStyleProps.style }}
      {...(applicationSurface ? { "data-vortex-application-surface": "" } : {})}
    >
      <style href="vortex-ui-styles" precedence="default">
        {ALL_UI_STYLES_CSS}
      </style>
      {applicationTheme === undefined ? (
        screen
      ) : (
        <IconLibraryProvider
          library={resolveShadcnIconLibrary(applicationTheme.selection.iconLibrary)}
        >
          {screen}
        </IconLibraryProvider>
      )}
      {overlay}
    </VortexStyleRoot>
  );
}
