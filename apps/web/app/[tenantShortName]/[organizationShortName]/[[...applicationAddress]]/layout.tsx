import { Suspense, type ReactNode } from "react";
import { applicationInstallAddressSchema } from "@vortex/app";
import { loadApplicationInstallMetadata } from "../../../_lib/application-install-metadata";
import { ApplicationInstallGuidance } from "./_components/application-install-guidance";

export const dynamic = "force-dynamic";
type Props = Readonly<{ children: ReactNode; params: Promise<{
  tenantShortName: string; organizationShortName: string; applicationAddress?: string[];
}> }>;

/** Adds one optional guide without rebuilding, keying or resetting the ordinary Page children. */
async function CurrentInstallGuidance({ route }: { route: Awaited<Props["params"]> }) {
  const segments = route.applicationAddress ?? [];
  const candidate = applicationInstallAddressSchema.safeParse({ tenantShortName: route.tenantShortName,
    organizationShortName: route.organizationShortName, applicationKey: segments[0] });
  const metadata = candidate.success && (segments.length === 1 || segments.length === 2)
    ? await loadApplicationInstallMetadata(candidate.data) : undefined;
  return metadata?.kind === "available" ? <ApplicationInstallGuidance
    applicationPath={metadata.manifest.id} manifestUrl={metadata.manifestUrl}
    snapshot={metadata.snapshot} validUntil={metadata.validUntil} /> : null;
}

export default async function InstalledApplicationLayout({ children, params }: Props) {
  const route = await params;
  return <><Suspense fallback={null}><CurrentInstallGuidance route={route} /></Suspense>{children}</>;
}
