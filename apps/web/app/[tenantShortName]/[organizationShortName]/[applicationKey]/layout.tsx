import { Suspense, type ReactNode } from "react";
import { DEFAULT_PLATFORM_THEME_RELEASE } from "@vortex/platform/server";
import { BrandLoader, createThemeRootProps } from "@vortex/ui";
import { loadApplicationFrame, loadApplicationStartTheme } from "../../../_lib/application-frame";
import { ApplicationFrame } from "./_components/application-frame";

export const dynamic = "force-dynamic";
type Route = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
}>;
type Props = Readonly<{ children: ReactNode; params: Promise<Route> }>;

/**
 * The loader drawn while the frame is composed: the application's own mark in its own theme, as
 * soon as the application is known. Before that the organisation's platform loader shows.
 */
async function ApplicationStartLoader({ route }: { route: Route }) {
  const theme = await loadApplicationStartTheme(
    route.tenantShortName,
    route.organizationShortName,
    route.applicationKey,
  );
  if (theme === undefined) return null;
  return (
    <div
      {...createThemeRootProps(theme, DEFAULT_PLATFORM_THEME_RELEASE.tokens, "system")}
      className="grid min-h-svh place-items-center"
      aria-busy="true"
    >
      <BrandLoader {...(theme.loaderMark === undefined ? {} : { mark: theme.loaderMark })} />
    </div>
  );
}

async function CurrentApplicationFrame({ route, children }: { route: Route; children: ReactNode }) {
  const frame = await loadApplicationFrame(
    route.tenantShortName,
    route.organizationShortName,
    route.applicationKey,
  );
  return frame === undefined ? children : <ApplicationFrame model={frame}>{children}</ApplicationFrame>;
}

/**
 * The application frame. It renders once per application and stays mounted while the pages inside
 * it change; only the page content below it is fetched and replaced. When the request addresses no
 * page the viewer may see, there is no frame and the page renders its own state.
 */
export default async function ApplicationLayout({ children, params }: Props) {
  const route = await params;
  return (
    <>
      <Suspense fallback={<ApplicationStartLoader route={route} />}>
        <CurrentApplicationFrame route={route}>{children}</CurrentApplicationFrame>
      </Suspense>
    </>
  );
}
