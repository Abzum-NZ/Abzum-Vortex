import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "../../auth/_components/auth-shell";
import { resolveIdentitySession } from "../../auth/_lib/session-server";
import { loadSelectedOrganization } from "../../_lib/organization-context";

export const dynamic = "force-dynamic";

type OrganizationPageProps = Readonly<{
  params: Promise<{ organizationId: string }>;
}>;

export default async function OrganizationPage({ params }: OrganizationPageProps) {
  const identity = await resolveIdentitySession();
  if (identity.kind === "invalid_session_state" || identity.kind === "expired_or_revoked")
    redirect("/auth/session-ended");
  if (identity.kind === "missing" || identity.kind === "cluster_identity_inactive")
    redirect("/auth/sign-in?status=session-ended");
  if (identity.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="This organisation is temporarily unavailable"
        description="Your sign-in is still active. Try loading this page again."
      >
        <Link href="/signed-in">Choose an organisation</Link>
      </AuthShell>
    );

  const { organizationId } = await params;
  const selected = await loadSelectedOrganization(identity.session, organizationId);
  if (selected.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="This organisation is temporarily unavailable"
        description="Your sign-in is still active. Try loading this page again."
      >
        <Link href={`/organizations/${organizationId}`}>Try again</Link>
        <Link href="/signed-in">Choose an organisation</Link>
      </AuthShell>
    );
  if (selected.kind === "unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="Organisation unavailable"
        description="This organisation cannot be opened from your current sign-in."
      >
        <Link href="/signed-in">Choose an organisation</Link>
      </AuthShell>
    );

  redirect(
    `/${encodeURIComponent(selected.entry.tenantShortName)}/${encodeURIComponent(selected.entry.organizationShortName)}`,
  );
}
