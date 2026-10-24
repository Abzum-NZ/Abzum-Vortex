"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { compiledItemTree, recordIdSchema, sameId } from "@vortex/platform/schema";
import {
  ApplicationAccountActionsProvider,
  ContentTransition,
  createPlatformComponentRegistryForReleases,
  PageNavigationBusyContext,
  PagePuckRenderer,
  type ApplicationAccountActions,
  type ApplicationShellRuntime,
  type PagePuckRendererProps,
} from "@vortex/ui";
import { Toaster } from "@vortex/ui/components/sonner";
import type { ApplicationFrameModel } from "../../../../_lib/application-frame";
import { signOut } from "../../../../auth/actions";
import { searchApplicationAction } from "../frame-actions";
import {
  ApplicationFrameStateProvider,
  type ApplicationFramePageState,
  type ApplicationFrameStateValue,
  type FramePageStateOwner,
} from "./application-frame-state";
import { FrozenRouter } from "./frozen-router";
// The public router API takes the prefetch kind but does not export it; AUTO is named explicitly so
// a hover can never ask for a full (data) prefetch, whatever the router's default becomes.
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";

type ApplicationSearch = NonNullable<PagePuckRendererProps["applicationSearch"]>;
type Registration = Readonly<{ owner: FramePageStateOwner; value: unknown }>;

/** Every placement identity in a projected layout. */
const placementIdsOf = (layout: ApplicationFrameModel["frame"]["composition"]): Set<string> =>
  new Set(compiledItemTree(layout.content).map((item) => item.props.id));

/** The search expression an address asks for: none, one, or a refused repeated value. */
const expressionOf = (parameters: URLSearchParams): string | undefined => {
  const values = parameters.getAll("q");
  if (values.length === 0) return undefined;
  if (values.length > 1) return "";
  return values[0] === "" ? undefined : values[0];
};

/**
 * The application frame: the definition's shell, its menu and its header, rendered once for the
 * application and kept mounted while its pages change. The current page renders inside the shell's
 * outlet and tells the frame its breadcrumb name, agent-tool state, unsaved-work guard and release
 * offer through the frame state.
 */
export function ApplicationFrame({
  model,
  children,
}: Readonly<{ model: ApplicationFrameModel; children: ReactNode }>): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { application } = model;
  // Each registered part remembers the registration that set it, so a leaving page can withdraw
  // only what is still its own.
  const [registrations, setRegistrations] = useState<
    Readonly<Partial<Record<keyof ApplicationFramePageState, Registration>>>
  >({});
  const setPageState = useCallback<ApplicationFrameStateValue["setPageState"]>(
    (key, value, owner) =>
      setRegistrations((current) => {
        const existing = current[key];
        if (existing?.owner === owner && existing.value === value) return current;
        const next = { ...current };
        if (value === undefined) delete next[key];
        else next[key] = { owner, value };
        return next;
      }),
    [],
  );
  const clearPageState = useCallback<ApplicationFrameStateValue["clearPageState"]>(
    (key, owner) =>
      setRegistrations((current) => {
        if (current[key]?.owner !== owner) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }),
    [],
  );
  const pageState = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(registrations).map(([key, registration]) => [key, registration.value]),
      ) as ApplicationFramePageState,
    [registrations],
  );

  const registry = useMemo(
    () => createPlatformComponentRegistryForReleases(model.platformBlockReleases),
    [model.platformBlockReleases],
  );
  const basePath = `/${encodeURIComponent(application.tenantShortName)}/${encodeURIComponent(application.organizationShortName)}/${encodeURIComponent(application.key)}`;
  const pageKeyOf = useMemo(
    () => new Map(model.pages.map((page) => [page.pageId.toLowerCase(), page.key])),
    [model.pages],
  );
  const resolvePageHref = useCallback(
    (pageId: string) => {
      const key = pageKeyOf.get(pageId.toLowerCase());
      return key === undefined ? basePath : `${basePath}/${encodeURIComponent(key)}`;
    },
    [basePath, pageKeyOf],
  );
  // The page the address shows now: the menu and the breadcrumb follow a click at once, before
  // the next page's server render arrives.
  const currentSegment = pathname.startsWith(`${basePath}/`)
    ? pathname.slice(basePath.length + 1).split("/")[0]
    : undefined;
  const currentPage = model.pages.find((page) => encodeURIComponent(page.key) === currentSegment);

  // A plain click on a menu page link is a client-side transition: the frame stays mounted and only
  // the next page's server render is fetched. Modified, middle and targeted clicks keep the
  // browser's own behaviour. The next page is still composed and authorised on the server for its
  // own request, exactly as a document load is.
  const [pageTransitionPending, startPageTransition] = useTransition();
  const navigateToPage = useCallback(
    (pageId: string, event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        (event.currentTarget.target !== "" && event.currentTarget.target !== "_self")
      )
        return;
      event.preventDefault();
      startPageTransition(() => router.push(resolvePageHref(pageId)));
    },
    [resolvePageHref, router],
  );
  // A page change the page itself starts (a row opening a record, a flow's Navigate) runs in the
  // same transition, so it dims the page and shows the progress line exactly as a menu click does.
  // Back and Forward cannot join it: the router carries those out itself and renders the next
  // address in full before anything commits, so the frame has no moment to show a busy state.
  const startPageChange = useCallback<ApplicationFrameStateValue["startPageChange"]>(
    (navigate) => startPageTransition(navigate),
    [],
  );
  // Intent to open a menu page (the pointer rests on its link or focus reaches it) asks the router
  // for an automatic prefetch of that address, never a full one. An automatic prefetch of these
  // dynamic pages carries only the route tree and what lies above the nearest loading boundary
  // (the organisation's quiet loading state), which is no viewer data; the frame, the page and
  // their authorisation-filtered data are never prefetched or cached, and with `staleTimes.dynamic`
  // at 0 (next.config.ts) the click always reads the page fresh on the server for its own request.
  // Links never approached are never fetched.
  const prefetchPage = useCallback(
    (pageId: string) => router.prefetch(resolvePageHref(pageId), { kind: PrefetchKind.AUTO }),
    [resolvePageHref, router],
  );

  // The header search follows the address. The layout searched for the address it was rendered
  // for; a later query change without a new document searches again through the server.
  const expression = expressionOf(new URLSearchParams(searchParams.toString()));
  const searchEnabled = model.search.kind !== "disabled";
  const [searched, setSearched] = useState<
    Readonly<{
      source: ApplicationFrameModel["search"];
      expression: string | undefined;
      view: ApplicationSearch;
    }>
  >(() => ({ source: model.search, expression, view: model.search }));
  const current =
    searched.source === model.search
      ? searched
      : { source: model.search, expression, view: model.search };
  useEffect(() => {
    if (current.expression === expression || expression === undefined) return;
    let cancelled = false;
    void searchApplicationAction(
      application.tenantShortName,
      application.organizationShortName,
      application.key,
      expression,
    )
      .then((view) => {
        if (!cancelled) setSearched({ source: model.search, expression, view });
      })
      .catch((error: unknown) => {
        console.error("[application-frame] search failed", error);
        if (!cancelled)
          setSearched({ source: model.search, expression, view: { kind: "unavailable" } });
      });
    return () => {
      cancelled = true;
    };
  }, [application, current.expression, expression, model.search]);
  const applicationSearch: ApplicationSearch =
    expression === undefined
      ? searchEnabled
        ? { kind: "available", expression: "", results: [], more: false }
        : { kind: "disabled" }
      : current.expression === expression
        ? current.view
        : searchEnabled
          ? { kind: "available", expression, results: [], more: false }
          : { kind: "disabled" };
  const searchSubject = recordIdSchema.safeParse(searchParams.get("record_id") ?? undefined);
  const applicationSearchPageSubject = searchSubject.success ? searchSubject.data : undefined;

  const unsavedWork = pageState.unsavedWork;
  const leaveIfConfirmed = useCallback(
    async (): Promise<boolean> =>
      unsavedWork === undefined ||
      !unsavedWork.hasUnsavedWork() ||
      (await unsavedWork.confirmDiscardUnsavedWork()),
    [unsavedWork],
  );
  const accountActions: ApplicationAccountActions = {
    account: model.account,
    organizationName: application.organizationShortName,
    ...(pageState.releaseAdoption === undefined
      ? {}
      : { releaseAdoption: pageState.releaseAdoption }),
    chooseOrganization: async () => {
      if (await leaveIfConfirmed()) router.push("/signed-in");
    },
    openApplication: async (href: string) => {
      if (await leaveIfConfirmed()) router.push(href);
    },
    signOut: async () => {
      if (await leaveIfConfirmed()) await signOut();
    },
  };

  const frame = pageState.frame ?? model.frame;
  const shell =
    frame.shellId === undefined
      ? undefined
      : model.shells.find((candidate) => sameId(candidate.shellId, frame.shellId!));
  // The page runtime wires every placement of its projection; the frame takes the inputs of the
  // placements it renders itself (a definition may place data, form or action blocks in its shell).
  const framePlacementIds = useMemo(() => placementIdsOf(frame.composition), [frame]);
  const frameRuntimeInputs = useMemo(() => {
    const inputs = pageState.runtimeInputs;
    if (inputs === undefined) return undefined;
    const own = Object.entries(inputs).filter(([placementId]) =>
      framePlacementIds.has(placementId),
    );
    return own.length === 0 ? undefined : Object.fromEntries(own);
  }, [framePlacementIds, pageState.runtimeInputs]);
  const applicationShellRuntime: ApplicationShellRuntime = {
    applicationName: application.name,
    applicationHref: `${basePath}/${encodeURIComponent(application.homePageKey)}`,
    organizationName: application.organizationShortName,
    pageName:
      pageState.page !== undefined && sameId(pageState.page.pageId, currentPage?.pageId ?? "")
        ? pageState.page.name
        : (currentPage?.name ?? pageState.page?.name ?? application.name),
    ...(pageState.webMcp === undefined ? {} : { webMcp: pageState.webMcp }),
  };

  const frameState = useMemo<ApplicationFrameStateValue>(
    () => ({
      setPageState,
      clearPageState,
      navigateToPage,
      startPageChange,
      applicationSearch,
      applicationSearchPageSubject,
    }),
    [
      applicationSearch,
      applicationSearchPageSubject,
      clearPageState,
      navigateToPage,
      setPageState,
      startPageChange,
    ],
  );

  return (
    <ApplicationFrameStateProvider value={frameState}>
      <ApplicationAccountActionsProvider actions={accountActions}>
        <PageNavigationBusyContext.Provider value={pageTransitionPending}>
          <PagePuckRenderer
            overlay={<Toaster position="bottom-right" />}
            applicationSurface
            composition={frame}
            registry={registry}
            fieldInputControlReleases={model.fieldInputControlReleases}
            platformThemeTokens={model.platformThemeTokens}
            {...(shell === undefined ? {} : { shell })}
            theme={model.theme}
            applicationShellRuntime={applicationShellRuntime}
            applicationSwitcher={model.applicationSwitcher}
            applicationSearch={applicationSearch}
            applicationSearchPageSubject={applicationSearchPageSubject}
            projectedNavigation={pageState.navigation ?? model.navigation}
            {...(frameRuntimeInputs === undefined ? {} : { runtimeInputs: frameRuntimeInputs })}
            resolvePageHref={resolvePageHref}
            onNavigatePage={navigateToPage}
            onPrefetchPage={prefetchPage}
            {...(currentPage === undefined ? {} : { currentPageId: currentPage.pageId })}
            outlet={{
              location: frame.outlet,
              content: (
                <ContentTransition
                  transitionKey={pathname}
                  busy={pageTransitionPending}
                  loaderMark={model.theme.loaderMark}
                >
                  <FrozenRouter>{children}</FrozenRouter>
                </ContentTransition>
              ),
            }}
          />
        </PageNavigationBusyContext.Provider>
      </ApplicationAccountActionsProvider>
    </ApplicationFrameStateProvider>
  );
}
