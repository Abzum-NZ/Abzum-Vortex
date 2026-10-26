// The render-only entry: the main entry would also bundle the whole editor for every page view.
import { Render } from "@puckeditor/core/rsc";
import type { CSSProperties, MouseEvent, ReactElement, ReactNode } from "react";
import type { Data } from "@puckeditor/core";
import {
  compiledItemTree,
  resolveShadcnIconLibrary,
  type ApplicationShell,
  type ApplicationPuckRootShell,
  type CompiledLayout,
  type ProjectedNavigation,
  type ShellOutletLocation,
} from "@vortex/platform/schema";
import {
  createDocumentThemeVariables,
  createThemeRootProps,
  createVortexStyleRootProps,
  resolveVortexStyleSelection,
  VortexStyleRoot,
  type ApplicationTheme,
  type PlatformThemeTokens,
} from "./theme";
import { IconLibraryProvider } from "./icons";
import {
  ApplicationSwitcherContext,
  type ApplicationShellRuntime,
  type ApplicationSwitcherSource,
} from "./navigation/application-shell";
import { DateFormatProvider } from "./display/date-format-context";
import { Button } from "./components/button";
import { Item } from "./components/item";
import { validatePlacementTree, type Breakpoint } from "./definition-error";
import {
  assertRuntimeInputKeysArePlacements,
  type PlatformComponentRegistry,
  type FieldInputControlReleaseMap,
  type RuntimeInputsByPlacement,
} from "./registry";
import {
  getVortexPuckConfig,
  VortexPuckThemeTokensProvider,
  type VortexPuckMetadata,
} from "./puck-config";
import { computeSlotOrderCss } from "./layout-styles";
import {
  contentConfigFor,
  frameConfigFor,
  ShellOutletProvider,
  withShellOutlet,
} from "./shell-outlet";
import {
  selectRenderedLayout,
  validateProjectedAvailabilityTree,
  type RenderedPage,
} from "./page-composition";

type ResolvedPageInputs = Readonly<{
  composition: PagePuckRendererProps["composition"];
  shell: PagePuckRendererProps["shell"];
  registry: PlatformComponentRegistry;
  pageId: string | undefined;
  activeStepId: string | undefined;
  breakpoint: Breakpoint | undefined;
}>;

type ResolvedPageData = Readonly<{
  layout: CompiledLayout;
  data: Data;
  orderCss: string;
}>;

const resolvedPages = new WeakMap<
  object,
  { inputs: ResolvedPageInputs; resolved: ResolvedPageData }[]
>();

/**
 * The validated Puck data of one rendered page. The page's layout already is Puck data, so the
 * renderer draws it directly: it only selects the active guided step and supplies the page root's
 * frame props. It depends only on the immutable inputs (page, shell, registry, step and
 * breakpoint), so it is computed once per distinct set of them; runtime inputs reach the blocks
 * through Puck metadata and never repeat it.
 */
const resolvedPageData = (inputs: ResolvedPageInputs): ResolvedPageData => {
  const { composition, shell, registry, pageId, activeStepId, breakpoint } = inputs;
  const entries = resolvedPages.get(composition) ?? [];
  const cached = entries.find(
    (entry) =>
      entry.inputs.shell === shell &&
      entry.inputs.registry === registry &&
      entry.inputs.pageId === pageId &&
      entry.inputs.activeStepId === activeStepId &&
      entry.inputs.breakpoint === breakpoint,
  );
  if (cached !== undefined) return cached.resolved;
  const layout = selectRenderedLayout(composition, activeStepId);
  const location = {
    ...(pageId === undefined ? {} : { pageId }),
    ...(activeStepId === undefined ? {} : { stepId: activeStepId }),
    ...(breakpoint === undefined ? {} : { breakpoint }),
  };
  // A permission-projected layout may hold a required slot the viewer was refused every child
  // of; publication itself refuses an empty required slot.
  validatePlacementTree(layout, registry, location, { allowEmptyRequiredSlots: true });
  validateProjectedAvailabilityTree(layout, location);
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
    layout,
    data: {
      root: {
        props: { gap: "medium", padding: "medium", applicationShell: rootShell },
      } as unknown as Data["root"],
      content: layout.content as unknown as Data["content"],
      zones: {},
    },
    orderCss: computeSlotOrderCss(layout, breakpoint),
  };
  entries.push({ inputs, resolved: result });
  resolvedPages.set(composition, entries);
  return result;
};

export type PagePuckRendererProps = Readonly<{
  /** The one page input: its layout already resolved into its frame, or one per guided step. */
  composition: RenderedPage;
  /**
   * Explicit breakpoint for preview canvases, rendered with that breakpoint's inline geometry and
   * order. Omit it for a live page, which adapts to the visitor's width.
   */
  breakpoint?: Breakpoint;
  registry: PlatformComponentRegistry;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
  /** The application shell that frames the page; absent for the platform default frame. */
  shell?: Pick<ApplicationShell, "shellId" | "key" | "name" | "presentation">;
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
  /** Intent to open an internal page, so the shell can start loading it before the click. */
  onPrefetchPage?: (pageId: string) => void;
  /** Internal page identity currently shown, for a navigation placement's current-page state. */
  currentPageId?: string;
  /** Resolved application theme; without one the readable platform defaults apply. */
  theme?: ApplicationTheme | undefined;
  /** Organisation or viewer BCP 47 locale for date presentation. */
  locale?: string | undefined;
  /** Organisation or viewer IANA time zone for timestamp presentation. */
  timeZone?: string | undefined;
  /** Runtime labels for the application shell root. */
  applicationShellRuntime?: ApplicationShellRuntime | undefined;
  /** Reads the shell's permitted applications when its switcher is opened. */
  applicationSwitcherSource?: ApplicationSwitcherSource | undefined;
  /** Protected search results for a search block placed in the application definition. */
  applicationSearch?: VortexPuckMetadata["applicationSearch"];
  /** Record subject preserved by a search form placed on a detail page. */
  applicationSearchPageSubject?: string | undefined;
  /**
   * The configured dedicated component origin. A page that places a custom component passes it so
   * the sandboxed host can frame the Vortex-owned bootstrap document on that origin.
   */
  componentBundleOrigin?: string | undefined;
  /**
   * Renders this composition as the application frame: the outlet at `location` shows `content`,
   * which the host renders separately so the frame stays mounted while the content changes.
   */
  outlet?: Readonly<{ location: ShellOutletLocation; content: ReactNode }>;
  /**
   * Renders only the composition's placements, for a page shown inside a frame's outlet. The frame
   * already supplies the theme root, the shell and the root slot gap.
   */
  contentRegion?: boolean;
}>;

export function PagePuckRenderer({
  composition,
  breakpoint,
  registry,
  fieldInputControlReleases,
  platformThemeTokens,
  shell,
  pageId,
  activeStepId,
  guidedStepNavigation,
  guidedSummaryValues,
  className,
  style,
  applicationSurface = false,
  feedback,
  runtimeInputs,
  projectedNavigation,
  resolvePageHref,
  onNavigatePage,
  onPrefetchPage,
  currentPageId,
  theme,
  locale,
  timeZone,
  applicationShellRuntime,
  applicationSwitcherSource,
  applicationSearch,
  applicationSearchPageSubject,
  componentBundleOrigin,
  outlet,
  contentRegion = false,
}: PagePuckRendererProps): ReactElement {
  const { layout, data, orderCss } = resolvedPageData({
    composition,
    shell,
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
    assertRuntimeInputKeysArePlacements(
      new Set(compiledItemTree(layout.content).map((item) => item.props.id)),
      runtimeInputs,
      location,
    );
  const applicationTheme = theme;
  const tokens = applicationTheme?.tokens ?? {};
  const vortexStyle = resolveVortexStyleSelection(applicationTheme?.selection);
  const themeRootProps = createThemeRootProps(applicationTheme, platformThemeTokens);
  const vortexStyleProps = createVortexStyleRootProps(vortexStyle);
  const metadata: VortexPuckMetadata = {
    ...(breakpoint === undefined ? {} : { breakpoint }),
    ...(runtimeInputs === undefined ? {} : { runtimeInputs }),
    ...(projectedNavigation === undefined ? {} : { projectedNavigation }),
    ...(resolvePageHref === undefined ? {} : { resolvePageHref }),
    ...(onNavigatePage === undefined ? {} : { onNavigatePage }),
    ...(onPrefetchPage === undefined ? {} : { onPrefetchPage }),
    ...(currentPageId === undefined ? {} : { currentPageId }),
    ...(componentBundleOrigin === undefined ? {} : { componentBundleOrigin }),
    ...(applicationShellRuntime === undefined ? {} : { applicationShellRuntime }),
    ...(applicationSearch === undefined ? {} : { applicationSearch }),
    ...(applicationSearchPageSubject === undefined ? {} : { applicationSearchPageSubject }),
  };
  const guidedSteps = composition.steps;
  const stepIndex =
    activeStepId === undefined
      ? -1
      : (guidedSteps?.findIndex((step) => step.id === activeStepId) ?? -1);
  const step = stepIndex < 0 ? undefined : guidedSteps?.[stepIndex];
  const baseConfig = getVortexPuckConfig(registry, fieldInputControlReleases);
  const guidedSummary =
    step?.summary !== true || guidedSummaryValues === undefined ? null : (
      <section aria-label="Review your answers" className="mt-6">
        <h2 className="font-heading text-lg font-semibold">Review your answers</h2>
        <dl className="mt-3 grid gap-3">
          {Object.entries(guidedSummaryValues).map(([field, value]) => (
            <Item key={field} variant="outline" size="sm" className="flex-col items-start">
              <dt className="font-medium">{field}</dt>
              <dd className="whitespace-pre-wrap text-sm text-muted-foreground">
                {value === null
                  ? "Empty"
                  : typeof value === "string"
                    ? value
                    : JSON.stringify(value)}
              </dd>
            </Item>
          ))}
        </dl>
      </section>
    );
  const guidedNavigation =
    guidedStepNavigation === undefined || stepIndex < 0 || guidedSteps === undefined ? null : (
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
    );
  const order = orderCss.length === 0 ? null : <style>{orderCss}</style>;
  if (contentRegion)
    return (
      <>
        {feedback == null ? null : <div data-vortex-page-feedback="">{feedback}</div>}
        {order}
        <Render config={contentConfigFor(baseConfig)} data={data} metadata={metadata} />
        {guidedSummary}
        {guidedNavigation}
      </>
    );
  const rendered = (
    <ApplicationSwitcherContext.Provider value={applicationSwitcherSource}>
      {outlet === undefined ? (
        <Render config={baseConfig} data={data} metadata={metadata} />
      ) : (
        <ShellOutletProvider content={outlet.content}>
          <Render
            config={frameConfigFor(baseConfig)}
            data={withShellOutlet(data, outlet.location)}
            metadata={metadata}
          />
        </ShellOutletProvider>
      )}
    </ApplicationSwitcherContext.Provider>
  );
  const screen = (
    <DateFormatProvider locale={locale} timeZone={timeZone}>
      {feedback == null ? null : <div data-vortex-page-feedback="">{feedback}</div>}
      <div className={className} style={style}>
        <VortexPuckThemeTokensProvider tokens={tokens}>
          {order}
          {rendered}
        </VortexPuckThemeTokensProvider>
      </div>
      {guidedSummary}
      {guidedNavigation}
    </DateFormatProvider>
  );
  return (
    <VortexStyleRoot
      {...themeRootProps}
      {...vortexStyleProps}
      style={
        applicationSurface
          ? createDocumentThemeVariables(applicationTheme, platformThemeTokens)
          : { ...themeRootProps.style, ...vortexStyleProps.style }
      }
      {...(applicationSurface ? { "data-vortex-application-surface": "" } : {})}
      documentTheme={applicationSurface}
    >
      {applicationTheme === undefined ? (
        screen
      ) : (
        <IconLibraryProvider
          library={resolveShadcnIconLibrary(applicationTheme.selection.iconLibrary)}
        >
          {screen}
        </IconLibraryProvider>
      )}
    </VortexStyleRoot>
  );
}
