"use client";

import { Button } from "@vortex/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vortex/ui/components/collapsible";
import { Icon } from "@vortex/ui/icons";

type AccountDetailsProps = Readonly<{
  /** The read-only account identifiers, or undefined when the account read is unavailable. */
  account:
    | Readonly<{ organizationId: string; organizationAccountId: string; revision: number | string }>
    | undefined;
}>;

/** The signed-in account's read-only identifiers, disclosed on request. */
export function AccountDetails({ account }: AccountDetailsProps) {
  return (
    <Collapsible className="min-w-0">
      <CollapsibleTrigger
        render={<Button type="button" variant="ghost" size="sm" className="group/details" />}
      >
        Current signed-in account details
        <Icon
          name="chevron-down"
          className="size-4 transition-transform group-data-panel-open/details:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 max-w-2xl rounded-lg border bg-card p-4 text-sm text-card-foreground">
        <p className="mb-3 text-muted-foreground">
          When available, these read-only identifiers describe the account read for this request.
          They do not select a recipient or authorize a grant.
        </p>
        {account === undefined ? (
          <p>Current signed-in account details are unavailable right now.</p>
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
            <dt className="text-muted-foreground">Organization ID</dt>
            <dd className="font-mono text-xs break-all">{account.organizationId}</dd>
            <dt className="text-muted-foreground">Organization account ID</dt>
            <dd className="font-mono text-xs break-all">{account.organizationAccountId}</dd>
            <dt className="text-muted-foreground">Profile revision</dt>
            <dd className="font-mono text-xs">{account.revision}</dd>
          </dl>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
