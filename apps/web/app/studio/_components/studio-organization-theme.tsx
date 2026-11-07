"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SourceApplicationThemeSelection } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui/icons";
import { NavigationLink } from "@vortex/ui/routing";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@vortex/ui/components/card";
import { Input } from "@vortex/ui/components/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { saveStudioOrganizationTheme } from "../actions";
import type { StudioThemeOptions } from "../_lib/studio-theme-options";
import { studioNotice } from "./studio-save-state";
import { StudioThemePanel, type StudioThemeChangeOutcome } from "./studio-theme-panel";

type Outcome = StudioThemeChangeOutcome & Readonly<{ problems?: readonly string[] }>;

/** A small page in the organisation's theme: what a change comes to, drawn with the same components. */
function ThemePreview() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Quarterly review</CardTitle>
        <CardDescription>A card, a field, a badge and two buttons in this theme.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input placeholder="Search records" aria-label="Preview search" />
        <Badge>Active</Badge>
      </CardContent>
      <CardFooter className="gap-2">
        <Button type="button">Save</Button>
        <Button type="button" variant="outline">
          Cancel
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * The organisation theme editor: the Theme tab's panel over the organisation's selection, saved to
 * the organisation as the dimensions that differ from the platform default. Studio itself and every
 * application of the organisation that did not choose a dimension of its own draw with it, so the
 * page re-draws in the new theme as soon as a change is saved. The server remounts this editor
 * (by revision) with the stored theme after every save, so what shows is always what is stored.
 */
export function StudioOrganizationTheme({
  organizationId,
  organizationName,
  studioHref,
  options,
  selection,
  revision,
  canChange,
  unresolvable,
}: Readonly<{
  organizationId: string;
  organizationName: string;
  studioHref: string;
  options: StudioThemeOptions;
  selection: SourceApplicationThemeSelection;
  revision: number;
  canChange: boolean;
  /** The stored theme no longer passes the readability checks, so Studio draws in its own theme. */
  unresolvable: boolean;
}>) {
  const router = useRouter();
  const [current, setCurrent] = useState(selection);
  const [stored, setStored] = useState(revision);

  const change = async (next: SourceApplicationThemeSelection, what: string): Promise<Outcome> => {
    const result = await saveStudioOrganizationTheme(organizationId, {
      expectedRevision: stored,
      selection: next,
    });
    switch (result.kind) {
      case "saved":
        setCurrent(next);
        setStored(result.revision);
        router.refresh();
        return {
          kind: "applied",
          message: `${what}. Every application that has not chosen its own follows.`,
        };
      case "conflict": {
        // The page remounts with the stored theme, so the explanation goes to the toast region.
        const message =
          "The organisation theme was changed by someone else. This page now shows the current theme; make your change again.";
        studioNotice(message, "error");
        router.refresh();
        return { kind: "refused", message };
      }
      case "invalid":
        return {
          kind: "refused",
          message: "The readability checks refuse this combination, so nothing was changed.",
          problems: result.problems,
        };
      case "refused":
        return {
          kind: "refused",
          message: "You do not have permission to change the organisation theme.",
        };
      case "temporarily_unavailable":
        return {
          kind: "refused",
          message: "The organisation theme could not be saved just now. Try again shortly.",
        };
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                nativeButton={false}
                aria-label="Back to Studio"
                render={<NavigationLink href={studioHref} />}
              />
            }
          >
            <Icon name="chevron-left" />
          </TooltipTrigger>
          <TooltipContent>Back to Studio</TooltipContent>
        </Tooltip>
        <h1 className="min-w-0 truncate text-sm font-medium">{organizationName}</h1>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        {unresolvable && (
          <Alert variant="destructive" className="m-4 w-auto shrink-0">
            <AlertTitle>The saved organisation theme fails the readability checks</AlertTitle>
            <AlertDescription>
              Studio is drawn in its own theme, and applications that follow this theme cannot open.
              Choose values the checks accept.
            </AlertDescription>
          </Alert>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(20rem,28rem)_1fr]">
          <div className="flex min-h-0 flex-col border-b md:border-r md:border-b-0">
            <StudioThemePanel
              title="Organisation theme"
              description={
                canChange
                  ? "How Studio and every application of this organisation look; an application's own choices win."
                  : "Read only: changing the organisation theme needs the Manage organisation display settings permission."
              }
              shuffle={false}
              selection={current}
              options={options}
              disabled={!canChange}
              hidden={false}
              onChange={change}
            />
          </div>
          <div className="flex items-start justify-center overflow-y-auto p-6">
            <ThemePreview />
          </div>
        </div>
      </main>
    </div>
  );
}
