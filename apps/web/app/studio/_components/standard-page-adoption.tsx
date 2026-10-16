"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@vortex/ui/components/button";
import type { ComparisonChoice, StudioStandardPageAdoptionLoadResult } from "../../_lib/studio-standard-page-adoption";
import { readStandardPageAdoption, submitStandardPageAdoption,
} from "../[organizationId]/[applicationRootId]/page-adoption/actions";

const statusMessage = (result: string | undefined): string | undefined => {
  switch (result) {
    case "saved": return "Your choice was saved to the draft. The published version is not changed.";
    case "no_change": return "The draft already matches your choice.";
    case "conflict": return "The draft or the published version changed. The comparison was reloaded; choose again.";
    case "refused": return "You cannot make this choice with your current access.";
    case "temporarily_unavailable": return "This is temporarily unavailable. No change was confirmed.";
    default: return undefined;
  }
};

const choiceForm = (
  choice: ComparisonChoice,
  input: Extract<StudioStandardPageAdoptionLoadResult, { kind: "available" }>,
  decision: "keep_replacement" | "adopt_original",
  submit: (formData: FormData) => void,
  disabled: boolean,
) => (
  <form action={submit} className="inline-flex">
    <input type="hidden" name="organizationId" value={input.organizationId} />
    <input type="hidden" name="rootId" value={input.rootId} />
    <input type="hidden" name="expectedDraftRevision" value={input.draftRevision} />
    <input type="hidden" name="expectedPublicationAnchor" value={choice.candidate.releaseRevision} />
    <input type="hidden" name="candidateReleaseRevision" value={choice.candidate.releaseRevision} />
    <input type="hidden" name="originalPageId" value={choice.original.pageId} />
    <input type="hidden" name="replacementPageId" value={choice.replacement.pageId} />
    <input type="hidden" name="comparisonFingerprint" value={decision === "keep_replacement" ? choice.keepFingerprint : choice.adoptFingerprint} />
    <input type="hidden" name="decision" value={decision} />
    <input type="hidden" name="targetKind" value={choice.target.target.kind} />
    <input type="hidden" name="targetId" value={choice.target.target.id} />
    <Button className="underline" type="submit" disabled={disabled}>
      {decision === "keep_replacement" ? "Keep my page" : "Use the standard page"}
    </Button>
  </form>
);

type Loaded = StudioStandardPageAdoptionLoadResult | null;

/** Page adoption (in the Releases tab): compares each local page with the standard page it replaces. */
export function StandardPageAdoption({ organizationId, rootId, disabledReason, onSaved }: Readonly<{
  organizationId: string;
  rootId: string;
  /** Why choices cannot be made right now (unsaved edits); the comparison itself still shows. */
  disabledReason?: string | undefined;
  /** The choice changed the saved draft, so the workspace must read it again. */
  onSaved: () => void;
}>) {
  const [result, setResult] = useState<Loaded>(null);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [pending, startTransition] = useTransition();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    try {
      const loaded = await readStandardPageAdoption(organizationId, rootId);
      if (mounted.current) setResult(loaded);
    } catch (error) {
      console.error("[studio] page adoption comparison failed to load", error);
      if (mounted.current) setResult({ kind: "temporarily_unavailable" });
    }
  }, [organizationId, rootId]);
  useEffect(() => { void load(); }, [load]);
  const submit = (formData: FormData) => startTransition(async () => {
    let code = "temporarily_unavailable";
    try { code = await submitStandardPageAdoption(formData); }
    catch (error) { console.error("[studio] page adoption choice failed", error); }
    if (!mounted.current) return;
    setMessage(code);
    await load();
    if (code === "saved") onSaved();
  });
  const notice = statusMessage(message);
  const blocked = pending || disabledReason !== undefined;
  return (
    <section aria-label="Page adoption" className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-xl font-semibold">Standard pages</h2>
        <p>Compare the latest published standard page with your replacement. A choice updates this draft only; publishing and installing stay separate.</p>
        {disabledReason !== undefined && <p role="status" className="text-sm text-muted-foreground">{disabledReason}</p>}
      </header>
      {notice !== undefined && <p role="status" className="rounded-xl border bg-card text-card-foreground p-3">{notice}</p>}
      {result === null && <p role="status">Loading the comparison…</p>}
      {result?.kind === "temporarily_unavailable" && <p role="status">The comparison is temporarily unavailable.</p>}
      {result?.kind === "refused" && <p role="status">The page comparison is unavailable for this application.</p>}
      {result?.kind === "available" && result.choices.length === 0 && (
        <p>No standard page in this application has a replacement to compare.</p>
      )}
      {result?.kind === "available" && result.choices.length > 0 && (
        <div aria-label="Page replacement comparisons" className="space-y-5">
          {result.choices.map((choice) => (
            <article key={`${choice.original.pageId}:${choice.replacement.pageId}:${choice.target.target.kind}:${choice.target.target.id}`} className="space-y-4 rounded-xl border bg-card text-card-foreground p-5">
              <div>
                <h3 className="text-lg font-medium">{choice.original.name} and {choice.replacement.name}</h3>
                <p>Latest published version {choice.candidate.releaseVersion}.</p>
                <p>Your replacement: {choice.replacement.name}. Standard page: {choice.original.name}.</p>
                {choice.candidate.impactReasons.length > 0 && (
                  <ul aria-label="Published version impact" className="list-disc pl-6">
                    {choice.candidate.impactReasons.slice(0, 8).map((reason, index) => (
                      <li key={`${reason.code}:${index}`}>{reason.impact}: {reason.code.replaceAll("_", " ")}</li>
                    ))}
                  </ul>
                )}
              </div>
              <section aria-label="Page structure and content differences" className="space-y-2">
                <h4 className="font-medium">What differs</h4>
                <p className="text-sm">Sensitive references and free-form values are summarized. Only changed items are listed.</p>
                {choice.differences.entries.length === 0 ? (
                  <p>No differences were found in the safe page summary.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-sm">
                      <caption className="sr-only">Differences between your replacement and the standard page</caption>
                      <thead>
                        <tr>
                          <th scope="col" className="border-b p-2">Part of the page</th>
                          <th scope="col" className="border-b p-2">Change</th>
                          <th scope="col" className="border-b p-2">Your page</th>
                          <th scope="col" className="border-b p-2">Standard page</th>
                        </tr>
                      </thead>
                      <tbody>
                        {choice.differences.entries.map((difference, index) => (
                          <tr key={`${difference.path}:${index}`}>
                            <th scope="row" className="border-b p-2 font-medium">{difference.path}</th>
                            <td className="border-b p-2">{difference.change}</td>
                            <td className="border-b p-2">{difference.currentReplacement}</td>
                            <td className="border-b p-2">{difference.suppliedPage}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {choice.differences.omittedCount > 0 && (
                  <p>{choice.differences.omittedCount} more differences are not listed in this summary.</p>
                )}
                {choice.differences.summaryTruncated && (
                  <p>Further page details are not shown to keep this comparison short.</p>
                )}
              </section>
              <div className="flex flex-wrap items-center gap-3">
                <p className="font-medium">Applies to: {choice.target.label}</p>
                {choiceForm(choice, result, "keep_replacement", submit, blocked)}
                {choiceForm(choice, result, "adopt_original", submit, blocked)}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
