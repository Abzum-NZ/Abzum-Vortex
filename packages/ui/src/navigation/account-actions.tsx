"use client";

import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import { Avatar, AvatarFallback } from "../components/avatar";
import { SIGNED_IN_LANDING_PATH } from "../routing/destination";
import { useNavigator } from "../routing/navigator";
import { Button } from "../components/button";
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
  /** The organisation's address segment, shown beside its display name. */
  organizationShortName?: string;
  /** Where the person opens Studio; present only for people who may change drafts. */
  studioHref?: string;
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

export function useApplicationAccountActions(): ApplicationAccountActions | null {
  return useContext(AccountActionsContext);
}

/**
 * The account actions placed in the application definition's configured top bar. It offers switching organisation only when the shell shows no organisation
 * menu, so there is one place to switch, labelled the same everywhere.
 */
export function ApplicationAccountMenu({
  offerOrganizationSwitch = false,
}: Readonly<{ offerOrganizationSwitch?: boolean }>): ReactElement {
  const actions = useApplicationAccountActions();
  const navigator = useNavigator();
  const organizationName = actions?.organizationName;
  const account = actions?.account;
  const avatarSource = account?.displayName ?? account?.email ?? organizationName;
  const avatarInitial = avatarSource?.slice(0, 1).toUpperCase();
  const studioHref = actions?.studioHref;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={actions === null}
        aria-label="Account menu"
        render={<Button variant="ghost" size="icon" className="max-sm:size-11" />}
      >
        <Avatar>
          <AvatarFallback>{avatarInitial}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-[var(--vortex-space-xs)]">
            {account === undefined ? (
              <span>{organizationName}</span>
            ) : (
              <>
                <span>{account.displayName ?? account.email}</span>
                {account.displayName === undefined ? null : (
                  <span className="font-normal text-muted-foreground">{account.email}</span>
                )}
                <span className="font-normal text-muted-foreground">{organizationName}</span>
                {actions?.organizationShortName === undefined ? null : (
                  <span className="font-normal text-muted-foreground">
                    {actions.organizationShortName}
                  </span>
                )}
              </>
            )}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {studioHref === undefined ? null : (
          <DropdownMenuItem onClick={() => navigator.navigate(studioHref)}>
            Open Studio
          </DropdownMenuItem>
        )}
        {offerOrganizationSwitch ? (
          <DropdownMenuItem
            disabled={actions === null}
            onClick={() => navigator.navigate(SIGNED_IN_LANDING_PATH)}
          >
            Switch organisation
          </DropdownMenuItem>
        ) : null}
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
  const organizationName = actions?.organizationName;

  return (
    <nav
      aria-label="Account and organisation"
      data-vortex-account-actions=""
      className="flex min-w-0 items-center gap-[var(--vortex-space-sm)]"
    >
      {organizationName === undefined ? null : (
        <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
          {organizationName}
        </span>
      )}
      <ApplicationAccountMenu />
    </nav>
  );
}
