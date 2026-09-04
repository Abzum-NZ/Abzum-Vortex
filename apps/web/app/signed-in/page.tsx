import { redirect } from "next/navigation";
import { signOut } from "../auth/actions";
import { AuthShell } from "../auth/_components/auth-shell";
import { resolveIdentitySession } from "../auth/_lib/session-server";

export const dynamic = "force-dynamic";

export default async function SignedInPage() {
  const result = await resolveIdentitySession();
  if (result.kind === "temporarily_unavailable") redirect("/auth/sign-in?status=unavailable");
  if (result.kind === "invalid_session_state" || result.kind === "expired_or_revoked")
    redirect("/auth/session-ended");
  if (result.kind !== "active") redirect("/auth/sign-in?status=session-ended");

  return (
    <AuthShell
      eyebrow="Secure session"
      title="You are signed in"
      description="Your identity is verified. Choose sign out to end only this browser session."
    >
      <form action={signOut} className="auth-form">
        <button type="submit">Sign out</button>
      </form>
    </AuthShell>
  );
}
