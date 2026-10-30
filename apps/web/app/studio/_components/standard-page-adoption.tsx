"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Badge } from "@vortex/ui/components/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vortex/ui/components/collapsible";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@vortex/ui/components/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vortex/ui/components/table";
import { ToggleGroup, ToggleGroupItem } from "@vortex/ui/components/toggle-group";
import type {
  ComparisonChoice,
  StudioStandardPageAdoptionLoadResult,
} from "../../_lib/studio-standard-page-adoption";
import { readStandardPageAdoption, submitStandardPageAdoption } from "../releases-actions";
import { studioNotice } from "./studio-save-state";

const statusMessage = (result: string): string => {
  switch (result) {
    case "saved":
      return "Your choice was saved to the draft.";
    case "no_change":
      return "The draft already matches your choice.";
    case "conflict":
      return "The draft or published version changed. The comparison was reloaded; choose again.";
    case "refused":
      return "You cannot make this choice with your current access.";
    default:
      return "This is temporarily unavailable. No change was confirmed.";
  }
};

type Loaded = StudioStandardPageAdoptionLoadResult | null;
type Decision = "keep_replacement" | "adopt_original";

/** Per-page choices use the comparison's exact draft revision and publication anchor. */
export function StandardPageAdoption({
  organizationId,
  rootId,
  disabledReason,
  hold,
  onSaved,
}: Readonly<{
  organizationId: string;
  rootId: string;
  disabledReason?: string | undefined;
  hold: (on: boolean) => void;
  onSaved: () => void;
}>) {
  const [result, setResult] = useState<Loaded>(null);
  const [pending, startTransition] = useTransition();
  const mounted = useRef(true);
  const submitting = useRef(false);
  const generation = useRef(0);
  const currentDisabledReason = useRef(disabledReason);
  currentDisabledReason.current = disabledReason;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  const load = useCallback(async () => {
    const token = ++generation.current;
    try {
      const loaded = await readStandardPageAdoption(organizationId, rootId);
      if (mounted.current && generation.current === token) setResult(loaded);
    } catch (error) {
      console.error("[studio] page adoption comparison failed to load", error);
      if (mounted.current && generation.current === token)
        setResult({ kind: "temporarily_unavailable" });
    }
  }, [organizationId, rootId]);
  useEffect(() => {
    setResult(null);
    void load();
  }, [load]);
  const submit = (choice: ComparisonChoice, decision: Decision) => {
    if (
      result?.kind !== "available" ||
      submitting.current ||
      currentDisabledReason.current !== undefined
    )
      return;
    const fields = {
      organizationId: result.organizationId,
      rootId: result.rootId,
      expectedDraftRevision: String(result.draftRevision),
      expectedPublicationAnchor: String(choice.candidate.releaseRevision),
      candidateReleaseRevision: String(choice.candidate.releaseRevision),
      originalPageId: choice.original.pageId,
      replacementPageId: choice.replacement.pageId,
      decision,
      targetKind: choice.target.target.kind,
      targetId: choice.target.target.id,
    };
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    submitting.current = true;
    hold(true);
    startTransition(async () => {
      let code = "temporarily_unavailable";
      try {
        code = await submitStandardPageAdoption(form);
      } catch (error) {
        console.error("[studio] page adoption choice failed", error);
      } finally {
        hold(false);
        submitting.current = false;
      }
      if (!mounted.current) return;
      studioNotice(
        statusMessage(code),
        code === "saved" ? "success" : code === "no_change" ? "info" : "error",
      );
      await load();
      if (code === "saved") onSaved();
    });
  };
  const blocked = pending || disabledReason !== undefined;
  return (
    <section aria-label="Page adoption" className="min-w-0 space-y-6 text-sm">
      <header className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">Page adoption</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Compare your replacement with the latest standard page. Each choice updates this draft.
        </p>
        {disabledReason !== undefined && (
          <p role="status" className="text-sm text-muted-foreground">
            {disabledReason}
          </p>
        )}
      </header>
      {result === null && <p role="status">Loading the comparison…</p>}
      {result?.kind === "temporarily_unavailable" && (
        <p role="status">
          The comparison is temporarily unavailable.{" "}
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </p>
      )}
      {result?.kind === "refused" && (
        <p role="status">The page comparison is unavailable for this application.</p>
      )}
      {result?.kind === "available" &&
        (result.choices.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="check" />
              </EmptyMedia>
              <EmptyTitle>No pages to compare</EmptyTitle>
              <EmptyDescription>
                Standard pages with a local replacement appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <Table aria-label="Page replacement comparisons">
              <TableHeader className="bg-muted/50 text-xs">
                <TableRow>
                  <TableHead className="text-foreground normal-case">Your page</TableHead>
                  <TableHead className="text-foreground normal-case">Standard page</TableHead>
                  <TableHead className="text-foreground normal-case">Choice</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.choices.map((choice) => (
                  <TableRow
                    key={`${choice.original.pageId}:${choice.replacement.pageId}:${choice.target.target.kind}:${choice.target.target.id}`}
                    className="hover:bg-muted/40"
                  >
                    <TableCell className="align-top whitespace-normal">
                      <p className="font-medium">{choice.replacement.name}</p>
                      <p className="text-sm text-muted-foreground">{choice.target.label}</p>
                      <Collapsible>
                        <CollapsibleTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Compare ${choice.replacement.name} with ${choice.original.name}`}
                            />
                          }
                        >
                          <Icon name="chevron-down" />
                          What differs
                        </CollapsibleTrigger>
                        <CollapsibleContent className="space-y-3 pt-3">
                          {choice.differences.entries.length === 0 ? (
                            <p>No differences in the page summary.</p>
                          ) : (
                            <ul className="space-y-3">
                              {choice.differences.entries.map((difference, index) => (
                                <li key={`${difference.path}:${index}`} className="space-y-1">
                                  <p className="font-medium">
                                    {difference.path} · {difference.change}
                                  </p>
                                  <p>Your page: {difference.currentReplacement}</p>
                                  <p>Standard: {difference.suppliedPage}</p>
                                </li>
                              ))}
                            </ul>
                          )}
                          {choice.differences.omittedCount > 0 && (
                            <p>{choice.differences.omittedCount} more differences.</p>
                          )}
                          {choice.differences.summaryTruncated && (
                            <p>Further page details are omitted from this summary.</p>
                          )}
                        </CollapsibleContent>
                      </Collapsible>
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <p className="mb-2 font-medium">{choice.original.name}</p>
                      <Badge variant="outline">Version {choice.candidate.releaseVersion}</Badge>
                    </TableCell>
                    <TableCell className="align-top">
                      <ToggleGroup
                        value={[]}
                        disabled={blocked}
                        variant="outline"
                        aria-label={`Page choice for ${choice.replacement.name}, ${choice.target.label}`}
                        onValueChange={(values) => {
                          const decision = values[0];
                          if (decision === "keep_replacement" || decision === "adopt_original")
                            submit(choice, decision);
                        }}
                      >
                        <ToggleGroupItem
                          value="keep_replacement"
                          aria-label={`Keep mine: ${choice.replacement.name}`}
                        >
                          Keep mine
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          value="adopt_original"
                          aria-label={`Use standard: ${choice.original.name}`}
                        >
                          Use standard
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
    </section>
  );
}
