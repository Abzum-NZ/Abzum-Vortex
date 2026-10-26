"use client";

import type { ReactElement } from "react";
import { useRouter } from "next/navigation";
import {
  ApplicationAccountActionsBlock,
  ApplicationAccountActionsProvider,
  type ApplicationAccount,
} from "@vortex/ui";
import { signOut } from "../../auth/actions";

/** The organisation name and account menu of the application header, for Studio's own pages. */
export function StudioAccount({
  account,
  organizationName,
}: Readonly<{ account: ApplicationAccount; organizationName: string }>): ReactElement {
  const router = useRouter();
  return (
    <ApplicationAccountActionsProvider
      actions={{
        account,
        organizationName,
        chooseOrganization: () => router.push("/signed-in"),
        signOut,
        openApplication: (href) => router.push(href),
      }}
    >
      <ApplicationAccountActionsBlock />
    </ApplicationAccountActionsProvider>
  );
}
