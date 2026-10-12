"use client";

import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import { Avatar, AvatarFallback } from "../components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
/** Current account facts and platform actions, supplied by the signed-in route. */
export type ApplicationAccountActions = Readonly<{
  organizationName: string;
  chooseOrganization: () => void | Promise<void>;
  signOut: () => void | Promise<void>;
  openApplication: (href: string) => void | Promise<void>;
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

export function useApplicationAccountActions(): ApplicationAccountActions | null {
  return useContext(AccountActionsContext);
}

/** Account actions placed in the application definition's configured top bar. */
export function ApplicationAccountMenu(): ReactElement {
  const actions = useApplicationAccountActions();
  const organizationName = actions?.organizationName ?? "Account";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={actions === null}
        aria-label="Account menu"
        className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
      >
        <Avatar>
          <AvatarFallback>{organizationName.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{organizationName}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={actions === null} onClick={() => void actions?.chooseOrganization()}>
          Choose organisation
        </DropdownMenuItem>
        <DropdownMenuItem disabled={actions === null} onClick={() => void actions?.signOut()}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The shell chooses this block's placement; the route supplies only current account data. */
export function ApplicationAccountActionsBlock(): ReactElement {
  const actions = useApplicationAccountActions();
  const organizationName = actions?.organizationName ?? "Organisation";

  return (
    <nav
      aria-label="Account and organisation"
      data-vortex-account-actions=""
      className="flex min-w-0 items-center gap-3"
    >
      <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
        {organizationName}
      </span>
      <ApplicationAccountMenu />
    </nav>
  );
}
