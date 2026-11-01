"use client";

import type { ReactElement } from "react";
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
  return (
    <ApplicationAccountActionsProvider
      actions={{
        account,
        organizationName,
        signOut,
      }}
    >
      <ApplicationAccountActionsBlock />
    </ApplicationAccountActionsProvider>
  );
}
