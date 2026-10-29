"use client";

import { readCompiledItemSettings } from "@vortex/platform/schema";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  ApplicationShell,
  PageDefinition,
  PlatformBlockRelease,
} from "@vortex/platform/schema";
import {
  ApplicationAccountActionsProvider,
  type ApplicationAccount,
  createPlatformComponentRegistryForReleases,
  PagePuckRenderer,
  renderedPageOf,
  type FieldInputControlReleaseMap,
  type PlatformThemeTokens,
  type DisplaySemanticEvent,
  type PagePuckRendererProps,
} from "@vortex/ui";
import type { permittedApplicationsToListValues } from "@vortex/ui";
import { signOut } from "../../../auth/actions";
import { searchLauncherAction } from "../[applicationKey]/frame-actions";

type OrganizationShellPageProps = Readonly<{
  page: PageDefinition;
  shell: ApplicationShell;
  /** The organisation's display name; its short name is the address segment shown beside it. */
  organizationName: string;
  organizationShortName: string;
  account: ApplicationAccount;
  launcherHref: string;
  platformBlockReleases: readonly PlatformBlockRelease[];
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
  applicationSearch?: PagePuckRendererProps["applicationSearch"];
}>;

/**
 * A platform page in the organisation shell: the header with the organisation switcher, the
 * account menu (with sign out) and the appearance toggle, around the page's own blocks.
 */
function OrganizationShellPage({
  page,
  shell,
  organizationName,
  organizationShortName,
  account,
  launcherHref,
  platformBlockReleases,
  fieldInputControlReleases,
  platformThemeTokens,
  applicationSearch,
  runtimeInputs,
}: OrganizationShellPageProps &
  Readonly<{
    runtimeInputs: (router: ReturnType<typeof useRouter>) => Readonly<Record<string, unknown>>;
  }>): ReactElement {
  const router = useRouter();
  const registry = useMemo(
    () => createPlatformComponentRegistryForReleases(platformBlockReleases),
    [platformBlockReleases],
  );
  const rendered = useMemo(() => renderedPageOf(page, [shell]), [page, shell]);
  return (
    <ApplicationAccountActionsProvider
      actions={{
        account,
        organizationName,
        organizationShortName,
        chooseOrganization: () => router.push("/signed-in"),
        signOut,
        openApplication: (href) => router.push(href),
      }}
    >
      <PagePuckRenderer
        readSettings={readCompiledItemSettings}
        composition={rendered.page}
        {...(rendered.shell === undefined ? {} : { shell: rendered.shell })}
        registry={registry}
        fieldInputControlReleases={fieldInputControlReleases}
        platformThemeTokens={platformThemeTokens}
        pageId={page.pageId}
        applicationSurface
        applicationShellRuntime={{
          applicationName: shell.name,
          applicationHref: launcherHref,
          organizationName,
          organizationShortName,
          pageName: page.name,
        }}
        runtimeInputs={runtimeInputs(router)}
        {...(applicationSearch === undefined ? {} : { applicationSearch })}
      />
    </ApplicationAccountActionsProvider>
  );
}

/** The organisation launcher: one tile per application the signed-in person may open. */
export function OrganizationLauncherPage({
  placementId,
  values,
  openApplication,
  openEventId,
  studio,
  ...shellPage
}: OrganizationShellPageProps &
  Readonly<{
    placementId: string;
    values: ReturnType<typeof permittedApplicationsToListValues>;
    openApplication: (event: DisplaySemanticEvent) => Promise<void>;
    openEventId: string;
    studio?: Readonly<{ href: string; tileId: string }>;
  }>): ReactElement {
  const params = useSearchParams();
  const expression = params.get("q") ?? "";
  const [searched, setSearched] = useState<{
    expression: string;
    result: Awaited<ReturnType<typeof searchLauncherAction>>;
  }>({ expression: "", result: { kind: "available", groups: [] } });
  useEffect(() => {
    if (expression === "") return;
    let active = true;
    void searchLauncherAction(
      shellPage.organizationShortName === ""
        ? ""
        : decodeURIComponent(shellPage.launcherHref.split("/")[1] ?? ""),
      shellPage.organizationShortName,
      expression,
    )
      .then((result) => {
        if (active) setSearched({ expression, result });
      })
      .catch((error: unknown) => {
        console.error("[launcher] search failed", error);
        if (active) setSearched({ expression, result: { kind: "unavailable" } });
      });
    return () => {
      active = false;
    };
  }, [expression, shellPage.launcherHref, shellPage.organizationShortName]);
  const tenant = decodeURIComponent(shellPage.launcherHref.split("/")[1] ?? "");
  const search = searched.result;
  const applicationSearch: PagePuckRendererProps["applicationSearch"] =
    expression === ""
      ? { kind: "available", expression: "", results: [], more: false, groups: [] }
      : searched.expression !== expression
        ? { kind: "loading", expression }
        : search.kind === "available"
          ? {
              kind: "available",
              expression,
              results: [],
              more: false,
              groups: search.groups.map((group) => ({
                ...group,
                ...(group.cursor === undefined
                  ? {}
                  : {
                      showMore: () => {
                        void searchLauncherAction(
                          tenant,
                          shellPage.organizationShortName,
                          expression,
                          group.key,
                          group.cursor,
                        )
                          .then((next) => {
                            if (next.kind !== "available") return;
                            const addition = next.groups[0];
                            if (addition === undefined) return;
                            setSearched((previous) =>
                              previous.expression !== expression ||
                              previous.result.kind !== "available"
                                ? previous
                                : {
                                    expression,
                                    result: {
                                      kind: "available",
                                      groups: previous.result.groups.map((old) =>
                                        old.key === group.key && old.cursor === group.cursor
                                          ? {
                                              ...addition,
                                              results: [...old.results, ...addition.results],
                                            }
                                          : old,
                                      ),
                                    },
                                  },
                            );
                          })
                          .catch((error: unknown) =>
                            console.error("[launcher] continuation failed", error),
                          );
                      },
                    }),
              })),
            }
          : search.kind === "refused"
            ? { kind: "refused", expression, reason: search.reason }
            : { kind: "unavailable" };
  return (
    <OrganizationShellPage
      {...shellPage}
      applicationSearch={applicationSearch}
      runtimeInputs={(router) => ({
        [placementId]: {
          data: { status: "ready", values },
          events: {
            row_action: (event: DisplaySemanticEvent) => {
              if (event.event !== "row_action" || event.eventId !== openEventId) {
                console.error("[launcher] open refused: ROW_ACTION_EVENT_UNKNOWN");
                return;
              }
              if (studio !== undefined && event.recordId === studio.tileId) {
                router.push(studio.href);
                return;
              }
              return openApplication(event);
            },
          },
        },
      })}
    />
  );
}

/** An address that shows no application page: what happened and its one way forward. */
export function OrganizationAddressStatePage({
  actionPlacementId,
  actionHref,
  addressState,
  ...shellPage
}: OrganizationShellPageProps &
  Readonly<{ actionPlacementId: string; actionHref: string; addressState: string }>): ReactElement {
  return (
    <div className="contents" data-vortex-address-state={addressState}>
      <OrganizationShellPage
        {...shellPage}
        runtimeInputs={(router) => ({
          [actionPlacementId]: { events: { action: () => router.push(actionHref) } },
        })}
      />
    </div>
  );
}
