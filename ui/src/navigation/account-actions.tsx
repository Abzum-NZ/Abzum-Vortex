"use client";

import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import { Button } from "../components/button";
import type { PlatformBlockRenderProps } from "../registry";

/** Current account facts and platform actions, supplied by the signed-in route. */
export type ApplicationAccountActions = Readonly<{
  organizationName: string;
  chooseOrganization: () => void | Promise<void>;
  signOut: () => void | Promise<void>;
}>;

const AccountActionsContext = createContext<ApplicationAccountActions | null>(null);

export function ApplicationAccountActionsProvider({
  actions,
  children,
}: Readonly<{ actions: ApplicationAccountActions; children: ReactNode }>): ReactElement {
  return (
    <AccountActionsContext.Provider value={actions}>{children}</AccountActionsContext.Provider>
  );
}

/** The shell chooses this block's placement; the route supplies only current account data. */
export function ApplicationAccountActionsBlock(_props: PlatformBlockRenderProps): ReactElement {
  const actions = useContext(AccountActionsContext);

  return (
    <nav
      aria-label="Account and organisation"
      data-vortex-account-actions=""
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
    >
      <span className="min-w-0 truncate text-sm font-medium">
        {actions?.organizationName ?? "Organisation"}
      </span>
      <Button
        type="button"
        variant="link"
        size="sm"
        disabled={actions === null}
        onClick={() => void actions?.chooseOrganization()}
      >
        Choose organisation
      </Button>
      <Button
        type="button"
        variant="link"
        size="sm"
        disabled={actions === null}
        onClick={() => void actions?.signOut()}
      >
        Sign out
      </Button>
    </nav>
  );
}
