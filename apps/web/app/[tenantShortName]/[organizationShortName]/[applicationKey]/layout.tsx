import { Suspense, type ReactNode } from "react";
import { withPageReadAttribution } from "../../../_lib/page-read-attribution";
import { DEFAULT_PLATFORM_THEME_RELEASE } from "@vortex/platform/server";
import { BrandLoader } from "@vortex/ui";
import { createLoaderThemeVariables } from "@vortex/ui/theme";
import { loadApplicationFrame, loadApplicationStartTheme } from "../../../_lib/application-frame";
import { ApplicationFrame } from "./_components/application-frame";
import { DraftPreviewNotice } from "./_components/draft-preview-notice";

export const dynamic = "force-dynamic";
type Route = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
}>;
type Props = Readonly<{ children: ReactNode; params: Promise<Route> }>;

/**
 * The loader drawn while the frame is composed: the application's own mark in its own theme, as
 * soon as the application is known. Before that the organisation's platform loader shows. It
 * carries only the variables the loader reads, and only those that differ from the platform rule:
 * after a client-side move from another application the document root has already returned to the
 * platform theme, and the frame that replaces the loader puts the application's whole theme back
 * on the root.
 */
function ApplicationStartLoader(props: { route: Route }) {
  return withPageReadAttribution(() => readApplicationStartLoader(props));
}

async function readApplicationStartLoader({ route }: { route: Route }) {
  const theme = await loadApplicationStartTheme(
    route.tenantShortName,
    route.organizationShortName,
    route.applicationKey,
  );
  if (theme === undefined) return null;
  return (
    <div
      data-vortex-theme=""
      style={createLoaderThemeVariables(theme, DEFAULT_PLATFORM_THEME_RELEASE.tokens)}
      className="grid min-h-svh place-items-center"
      aria-busy="true"
    >
      <BrandLoader mark={theme.loaderMark} />
    </div>
  );
}

function CurrentApplicationFrame(props: { route: Route; children: ReactNode }) {
  return withPageReadAttribution(() => readCurrentApplicationFrame(props));
}

async function readCurrentApplicationFrame({
  route,
  children,
}: {
  route: Route;
  children: ReactNode;
}) {
  const frame = await loadApplicationFrame(
    route.tenantShortName,
    route.organizationShortName,
    route.applicationKey,
  );
  if (frame === undefined) return children;
  return (
    <>
      {frame.preview === undefined ? null : <DraftPreviewNotice {...frame.preview} />}
      <ApplicationFrame model={frame}>{children}</ApplicationFrame>
    </>
  );
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
