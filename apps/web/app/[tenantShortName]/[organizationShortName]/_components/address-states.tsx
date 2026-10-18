import Link from "next/link";
import type { ReactElement } from "react";
import { Button } from "@vortex/ui/components/button";
import { AuthShell } from "../../../auth/_components/auth-shell";

/**
 * The one fixed neutral state for an address that is refused or missing. It never names the
 * application, a reason, or whether anything exists, so the two cases stay indistinguishable.
 */
export const unavailableAddress = (
  <AuthShell
    eyebrow="Application access"
    title="Application unavailable"
    description="This application address cannot be opened from your current sign-in."
  >
    <Link href="/signed-in">Choose an organisation</Link>
  </AuthShell>
);

/**
 * A page of an application the viewer may open, which their role cannot open or which does not
 * exist: the two stay indistinguishable, and the way back leads to the application's home page.
 */
export function PageNotOpenAddress({
  applicationName,
  homeHref,
}: Readonly<{ applicationName: string; homeHref: string }>): ReactElement {
  return (
    <AuthShell
      eyebrow={applicationName}
      title="You don't have access to this page"
      description="Your role can't open this page, or it no longer exists. Ask an administrator if you need it."
    >
      <Button variant="outline" nativeButton={false} render={<Link href={homeHref} />}>
        {`Back to ${applicationName}`}
      </Button>
    </AuthShell>
  );
}

/** The address could not be read right now; the sign-in itself is still active. */
export function TemporarilyUnavailableAddress({
  retryHref,
}: Readonly<{ retryHref: string }>): ReactElement {
  return (
    <AuthShell
      eyebrow="Application access"
      title="This address is temporarily unavailable"
      description="Your sign-in is still active. Try loading this address again."
    >
      <Button variant="outline" nativeButton={false} render={<Link href={retryHref} />}>
        Try again
      </Button>
    </AuthShell>
  );
}

export const suspendedOrganizationAccount = (
  <AuthShell
    eyebrow="Organisation access"
    title="Your organisation account is suspended"
    description="This account needs explicit reactivation before it can be used. Signing in will not reactivate it."
  >
    <Button variant="outline" nativeButton={false} render={<Link href="/signed-in" />}>
      Choose another organisation
    </Button>
  </AuthShell>
);
