import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "../../../auth/_components/auth-shell";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../_lib/application-address";

export const dynamic = "force-dynamic";

type ApplicationAddressPageProps = Readonly<{
  params: Promise<{
    tenantShortName: string;
    organizationShortName: string;
    applicationAddress?: string[];
  }>;
}>;

const addressPath = (
  tenantShortName: string,
  organizationShortName: string,
  applicationKey: string,
  pageKey: string,
) =>
  `/${encodeURIComponent(tenantShortName)}/${encodeURIComponent(organizationShortName)}/${encodeURIComponent(applicationKey)}/${encodeURIComponent(pageKey)}`;

export default async function ApplicationAddressPage({ params }: ApplicationAddressPageProps) {
  const identity = await resolveIdentitySession();
  if (identity.kind === "invalid_session_state" || identity.kind === "expired_or_revoked")
    redirect("/auth/session-ended");
  if (identity.kind === "missing" || identity.kind === "cluster_identity_inactive")
    redirect("/auth/sign-in?status=session-ended");

  const { tenantShortName, organizationShortName, applicationAddress } = await params;
  const addressSegments = applicationAddress ?? [];
  if (identity.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Application access"
        title="This address is temporarily unavailable"
        description="Your sign-in is still active. Try loading this address again."
      >
        <Link href={`/${encodeURIComponent(tenantShortName)}/${encodeURIComponent(organizationShortName)}`}>
          Try again
        </Link>
      </AuthShell>
    );

  if (addressSegments.length > 2)
    return (
      <AuthShell
        eyebrow="Application access"
        title="Application unavailable"
        description="This application address cannot be opened from your current sign-in."
      >
        <Link href="/signed-in">Choose an organisation</Link>
      </AuthShell>
    );

  const resolved = await resolveApplicationAddress(
    identity.session,
    tenantShortName,
    organizationShortName,
    addressSegments[0],
    addressSegments[1],
  );
  if (resolved.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Application access"
        title="This address is temporarily unavailable"
        description="Your sign-in is still active. Try loading this address again."
      >
        <Link href={`/${encodeURIComponent(tenantShortName)}/${encodeURIComponent(organizationShortName)}`}>
          Try again
        </Link>
      </AuthShell>
    );

  if (resolved.kind === "unavailable")
    return (
      <AuthShell
        eyebrow="Application access"
        title="Application unavailable"
        description="This application address cannot be opened from your current sign-in."
      >
        <Link href="/signed-in">Choose an organisation</Link>
      </AuthShell>
    );

  if (resolved.kind === "organization_launcher") {
    const defaultApplication = resolved.read.applications.find(
      (application) => application.applicationRootId === resolved.read.defaultApplicationRootId,
    );
    if (defaultApplication)
      redirect(
        addressPath(
          tenantShortName,
          organizationShortName,
          defaultApplication.key,
          defaultApplication.homePageKey,
        ),
      );

    return (
      <AuthShell
        eyebrow={resolved.read.tenantShortName}
        title={resolved.read.organizationShortName}
        description="Choose an application you can open."
      >
        {resolved.read.applications.length === 0 ? (
          <p>No applications are available for this organisation.</p>
        ) : (
          <ul>
            {resolved.read.applications.map((application) => (
              <li key={application.applicationRootId}>
                <Link
                  href={addressPath(
                    tenantShortName,
                    organizationShortName,
                    application.key,
                    application.homePageKey,
                  )}
                >
                  {application.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link href="/signed-in">Choose another organisation</Link>
      </AuthShell>
    );
  }

  if (addressSegments.length === 1)
    redirect(
      addressPath(
        tenantShortName,
        organizationShortName,
        resolved.application.key,
        resolved.pageKey,
      ),
    );

  return (
    <AuthShell
      eyebrow={resolved.read.organizationShortName}
      title={resolved.application.name}
      description="This application page is available to your current organisation account."
    >
      <Link
        href={addressPath(
          tenantShortName,
          organizationShortName,
          resolved.application.key,
          resolved.application.homePageKey,
        )}
      >
        Open application start page
      </Link>
      <Link href={`/${encodeURIComponent(tenantShortName)}/${encodeURIComponent(organizationShortName)}`}>
        Application launcher
      </Link>
    </AuthShell>
  );
}
