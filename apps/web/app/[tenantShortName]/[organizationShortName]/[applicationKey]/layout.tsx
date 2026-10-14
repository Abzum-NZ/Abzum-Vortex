import { Suspense, type ReactNode } from "react";
import { applicationInstallAddressSchema } from "@vortex/platform/server";
import { loadApplicationInstallMetadata } from "../../../_lib/application-install-metadata";
import { loadApplicationFrame } from "../../../_lib/application-frame";
import { ApplicationInstallGuidance } from "./_components/application-install-guidance";
import { ApplicationFrame } from "./_components/application-frame";

export const dynamic = "force-dynamic";
type Route = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
}>;
type Props = Readonly<{ children: ReactNode; params: Promise<Route> }>;

/** Adds one optional guide without rebuilding, keying or resetting the ordinary Page children. */
async function CurrentInstallGuidance({ route }: { route: Route }) {
  const candidate = applicationInstallAddressSchema.safeParse(route);
  const metadata = candidate.success
    ? await loadApplicationInstallMetadata(candidate.data)
    : undefined;
  return metadata?.kind === "available" ? (
    <ApplicationInstallGuidance
      applicationPath={metadata.manifest.id}
      manifestUrl={metadata.manifestUrl}
      initialManifest={JSON.stringify(metadata.manifest)}
      snapshot={metadata.snapshot}
      validUntil={metadata.validUntil}
    />
  ) : null;
}

/**
 * The application frame. It renders once per application and stays mounted while the pages inside
 * it change; only the page content below it is fetched and replaced. When the request addresses no
 * page the viewer may see, there is no frame and the page renders its own state.
 */
export default async function ApplicationLayout({ children, params }: Props) {
  const route = await params;
  const frame = await loadApplicationFrame(
    route.tenantShortName,
    route.organizationShortName,
    route.applicationKey,
  );
  return (
    <>
      <Suspense fallback={null}>
        <CurrentInstallGuidance route={route} />
      </Suspense>
      {frame === undefined ? children : <ApplicationFrame model={frame}>{children}</ApplicationFrame>}
    </>
  );
}
