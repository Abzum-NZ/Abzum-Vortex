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
/** The signed-in person as shown to them; an organisation account may have no display name. */
export type ApplicationAccount = Readonly<{ email: string; displayName?: string }>;

/** Current account facts and platform actions, supplied by the signed-in route. */
export type ApplicationAccountActions = Readonly<{
  account: ApplicationAccount;
  organizationName: string;
  releaseAdoption?: Readonly<{ version: string; adopt: () => void | Promise<void> }>;
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
  const account = actions?.account;
  const avatarInitial = (account?.displayName ?? account?.email ?? organizationName)
    .slice(0, 1)
    .toUpperCase();
  const releaseAdoption = actions?.releaseAdoption;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={actions === null}
        aria-label="Account menu"
        className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
      >
        <Avatar>
          <AvatarFallback>{avatarInitial}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-1">
            {account === undefined ? (
              <span>{organizationName}</span>
            ) : (
              <>
                <span>{account.displayName ?? account.email}</span>
                {account.displayName === undefined ? null : (
                  <span className="font-normal text-muted-foreground">{account.email}</span>
                )}
                <span className="font-normal text-muted-foreground">{organizationName}</span>
              </>
            )}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {releaseAdoption === undefined ? null : (
          <DropdownMenuItem onClick={() => void releaseAdoption.adopt()}>
            Adopt release {releaseAdoption.version}
          </DropdownMenuItem>
        )}
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
