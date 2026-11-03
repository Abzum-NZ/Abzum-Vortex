"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SourceApplicationThemeSelection } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui/icons";
import { NavigationLink } from "@vortex/ui/routing";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
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
}: Readonly<{
  organizationId: string;
  organizationName: string;
  studioHref: string;
  options: StudioThemeOptions;
  selection: SourceApplicationThemeSelection;
  revision: number;
  canChange: boolean;
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
      case "conflict":
        router.refresh();
        return {
          kind: "refused",
          message:
            "The organisation theme was changed by someone else. This page now shows the current theme; make your change again.",
        };
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
        <span className="min-w-0 truncate text-sm font-medium">{organizationName}</span>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(20rem,28rem)_1fr]">
        <div className="flex min-h-0 flex-col border-b md:border-r md:border-b-0">
          {!canChange && (
            <div className="shrink-0 px-4 pt-4">
              <Alert>
                <AlertDescription>
                  You can see the organisation theme. Changing it needs permission to manage the
                  organisation&apos;s settings.
                </AlertDescription>
              </Alert>
            </div>
          )}
          <StudioThemePanel
            title="Organisation theme"
            description="How Studio and every application of this organisation look. An application that chose its own setting keeps it; changes save automatically."
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
    </div>
  );
}
