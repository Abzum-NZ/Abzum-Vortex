"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Avatar, AvatarFallback } from "../components/avatar";
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

type ReleaseAdoptionData =
  | Readonly<{
      state: "available";
      offer?: Readonly<{ version: string; adopt: () => void | Promise<void> }>;
    }>
  | Readonly<{ state: "unavailable" | "temporarily_unavailable" }>;

/** Current account facts and platform actions, supplied by the signed-in route. */
export type ApplicationAccountActions = Readonly<{
  account: ApplicationAccount;
  organizationName: string;
  readReleaseAdoption?: () => Promise<ReleaseAdoptionData>;
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

/**
 * The account actions placed in the application definition's configured top bar. It offers switching organisation only when the shell shows no organisation
 * menu, so there is one place to switch, labelled the same everywhere.
 */
export function ApplicationAccountMenu({
  offerOrganizationSwitch = false,
}: Readonly<{ offerOrganizationSwitch?: boolean }>): ReactElement {
  const actions = useApplicationAccountActions();
  const organizationName = actions?.organizationName;
  const account = actions?.account;
  const avatarSource = account?.displayName ?? account?.email ?? organizationName;
  const avatarInitial = avatarSource?.slice(0, 1).toUpperCase();
  const source = actions?.readReleaseAdoption;
  const [adoption, setAdoption] =
    useState<Readonly<{ source: typeof source; data: ReleaseAdoptionData }>>();
  const requestToken = useRef(0);
  useEffect(
    () => () => {
      requestToken.current += 1;
    },
    [source],
  );
  const read = async () => {
    if (source === undefined) return;
    const token = ++requestToken.current;
    setAdoption(undefined);
    try {
      const data = await source();
      if (token === requestToken.current) setAdoption({ source, data });
    } catch (error) {
      console.error("[application-account] adoption read failed", error);
      if (token === requestToken.current)
        setAdoption({ source, data: { state: "temporarily_unavailable" } });
    }
  };
  const releaseAdoption = adoption?.source === source ? adoption?.data : undefined;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void read();
        else {
          requestToken.current += 1;
          setAdoption(undefined);
        }
      }}
    >
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
        {source === undefined ? null : releaseAdoption === undefined ? (
          <div role="status" aria-busy="true" className="px-2 py-1.5 text-sm text-muted-foreground">
            Loading release adoption…
          </div>
        ) : releaseAdoption.state !== "available" ? (
          <>
            <div role="status" className="px-2 py-1.5 text-sm text-muted-foreground">
              {releaseAdoption.state === "temporarily_unavailable"
                ? "Release adoption temporarily unavailable"
                : "Release adoption unavailable"}
            </div>
            <DropdownMenuItem closeOnClick={false} onClick={() => void read()}>
              Retry
            </DropdownMenuItem>
          </>
        ) : releaseAdoption.offer === undefined ? null : (
          <DropdownMenuItem onClick={() => void releaseAdoption.offer?.adopt()}>
            Adopt release {releaseAdoption.offer.version}
          </DropdownMenuItem>
        )}
        {offerOrganizationSwitch ? (
          <DropdownMenuItem
            disabled={actions === null}
            onClick={() => void actions?.chooseOrganization()}
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
      className="flex min-w-0 items-center gap-3"
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
