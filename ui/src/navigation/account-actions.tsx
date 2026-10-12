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
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={actions === null}
          aria-label="Account and organisation menu"
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
          <DropdownMenuItem onClick={() => void actions?.chooseOrganization()}>
            Choose organisation
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void actions?.signOut()}>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
