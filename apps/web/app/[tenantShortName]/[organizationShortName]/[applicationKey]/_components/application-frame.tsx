"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactElement,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  compiledItemTree,
  recordIdSchema,
  sameId,
  readCompiledItemSettings,
} from "@vortex/platform/schema";
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
import { forgetPagesWrittenSince, NavigatorProvider, type Navigator } from "@vortex/ui/routing";
import type { ApplicationFrameModel } from "../../../../_lib/application-frame";
import { signOut } from "../../../../auth/actions";
import {
  readApplicationSwitcherAction,
  searchApplicationAction,
  searchLauncherAction,
} from "../frame-actions";
import {
  ApplicationFrameStateProvider,
  emptyControlDrafts,
  type ApplicationFramePageState,
  type ApplicationFrameStateValue,
  type FramePageStateOwner,
} from "./application-frame-state";
import { FrozenRouter } from "./frozen-router";
import { ReleaseOfferNotice } from "./release-offer-notice";

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
 * action through the frame state.
 */
export function ApplicationFrame({
  model,
  children,
}: Readonly<{ model: ApplicationFrameModel; children: ReactNode }>): ReactElement {
  const controlDraftsRef = useRef(emptyControlDrafts());
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

  const [pageTransitionPending, startPageTransition] = useTransition();

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
  const [loadingMore, setLoadingMore] = useState(false);
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
  const searchView: ApplicationSearch =
    expression === undefined
      ? searchEnabled
        ? { kind: "available", expression: "", results: [], more: false }
        : { kind: "disabled" }
      : current.expression === expression
        ? current.view
        : searchEnabled
          ? { kind: "available", expression, results: [], more: false }
          : { kind: "disabled" };
  const applicationSearch: ApplicationSearch =
    searchView.kind === "available" && searchView.cursor !== undefined && !loadingMore
      ? {
          ...searchView,
          showMore: () => {
            setLoadingMore(true);
            void searchApplicationAction(
              application.tenantShortName,
              application.organizationShortName,
              application.key,
              searchView.expression,
              searchView.cursor,
            )
              .then((next) => {
                setSearched((previous) => {
                  if (
                    previous.source !== model.search ||
                    previous.expression !== searchView.expression ||
                    previous.view.kind !== "available" ||
                    previous.view.cursor !== searchView.cursor
                  )
                    return previous;
                  return {
                    ...previous,
                    view:
                      next.kind === "available"
                        ? { ...next, results: [...previous.view.results, ...next.results] }
                        : next,
                  };
                });
              })
              .catch((error: unknown) => {
                console.error("[application-frame] search continuation failed", error);
              })
              .finally(() => setLoadingMore(false));
          },
        }
      : searchView;
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
  // Every in-place page change inside the frame (a link, a menu item, a flow's Navigate, a toast
  // action) asks before discarding unsaved work (except a change of the shown page's own query),
  // then runs in the frame's page transition: the frame stays mounted and the page dims until the
  // next page is ready, while the clicked link shows it is pending. The next page is still composed
  // and authorised on the server for its own request. Back and Forward cannot join the transition:
  // the router carries those out itself.
  const leaveIfConfirmedRef = useRef(leaveIfConfirmed);
  leaveIfConfirmedRef.current = leaveIfConfirmed;
  const navigator = useMemo<Navigator>(
    () => ({
      navigate: (path, options) => {
        void (async () => {
          if (options?.withinPage !== true && !(await leaveIfConfirmedRef.current())) {
            options?.onCancelled?.();
            return;
          }
          forgetPagesWrittenSince(router);
          startPageTransition(() =>
            options?.replace === true ? router.replace(path) : router.push(path),
          );
        })();
      },
    }),
    [router],
  );
  const accountActions: ApplicationAccountActions = {
    account: model.account,
    organizationName: application.organizationDisplayName,
    organizationShortName: application.organizationShortName,
    ...(model.studioHref === undefined ? {} : { studioHref: model.studioHref }),
    signOut: async () => {
      if (!(await leaveIfConfirmed())) return;
      await signOut();
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
    organizationName: application.organizationDisplayName,
    organizationShortName: application.organizationShortName,
    pageName:
      pageState.page !== undefined && sameId(pageState.page.pageId, currentPage?.pageId ?? "")
        ? pageState.page.name
        : (currentPage?.name ?? pageState.page?.name ?? application.name),
    ...(pageState.webMcp === undefined ? {} : { webMcp: pageState.webMcp }),
  };

  const navigation = pageState.navigation ?? model.navigation;
  const frameState = useMemo<ApplicationFrameStateValue>(
    () => ({
      controlDraftsRef,
      navigation,
      setPageState,
      clearPageState,
      applicationSearch,
      applicationSearchPageSubject,
      locale: model.locale,
      timeZone: model.timeZone,
    }),
    [
      model.locale,
      model.timeZone,
      applicationSearch,
      applicationSearchPageSubject,
      clearPageState,
      setPageState,
      navigation,
    ],
  );

  return (
    <NavigatorProvider navigator={navigator}>
      <ApplicationFrameStateProvider value={frameState}>
        <ApplicationAccountActionsProvider actions={accountActions}>
          <PageNavigationBusyContext.Provider value={pageTransitionPending}>
            {model.releaseOffer === undefined ? null : (
              <ReleaseOfferNotice applicationName={application.name} offer={model.releaseOffer} />
            )}
            <PagePuckRenderer
              readSettings={readCompiledItemSettings}
              applicationSurface
              composition={frame}
              registry={registry}
              fieldInputControlReleases={model.fieldInputControlReleases}
              platformThemeTokens={model.platformThemeTokens}
              {...(shell === undefined ? {} : { shell })}
              theme={model.theme}
              locale={model.locale}
              timeZone={model.timeZone}
              applicationShellRuntime={applicationShellRuntime}
              applicationSwitcherSource={Object.assign(
                () =>
                  readApplicationSwitcherAction(
                    application.tenantShortName,
                    application.organizationShortName,
                  ),
                {
                  search: (expression: string, groupKey?: string, cursor?: string) =>
                    searchLauncherAction(
                      application.tenantShortName,
                      application.organizationShortName,
                      expression,
                      groupKey,
                      cursor,
                    ),
                },
              )}
              applicationSearch={applicationSearch}
              applicationSearchPageSubject={applicationSearchPageSubject}
              projectedNavigation={navigation}
              {...(frameRuntimeInputs === undefined ? {} : { runtimeInputs: frameRuntimeInputs })}
              resolvePageHref={resolvePageHref}
              {...(currentPage === undefined ? {} : { currentPageId: currentPage.pageId })}
              outlet={{
                location: frame.outlet,
                content: (
                  <ContentTransition transitionKey={pathname} busy={pageTransitionPending}>
                    <FrozenRouter>{children}</FrozenRouter>
                  </ContentTransition>
                ),
              }}
            />
          </PageNavigationBusyContext.Provider>
        </ApplicationAccountActionsProvider>
      </ApplicationFrameStateProvider>
    </NavigatorProvider>
  );
}
