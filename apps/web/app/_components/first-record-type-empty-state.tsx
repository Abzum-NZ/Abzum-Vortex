import type { ReactNode } from "react";
import { Icon } from "@vortex/ui";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vortex/ui/components/empty";

/**
 * The platform's guidance on the home page of an application that has no record types yet, shown
 * to its builder in Studio and in a draft preview. It is not part of the application: the page
 * itself stays as designed, and the installed application never shows it.
 */
export function FirstRecordTypeEmptyState({ action }: Readonly<{ action: ReactNode }>) {
  return (
    <Empty
      data-vortex-first-record-type=""
      className="rounded-xl border border-dashed border-border p-6"
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon name="database" />
        </EmptyMedia>
        <EmptyTitle>Add your first record type</EmptyTitle>
        <EmptyDescription>
          A record type is a kind of record people keep here, such as assets or companies. Add one
          in the Data tab, then show its records on this page.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{action}</EmptyContent>
    </Empty>
  );
}
