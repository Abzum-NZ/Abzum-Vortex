import type { ComparisonChoice, StudioStandardPageAdoptionLoadResult } from "../../_lib/studio-standard-page-adoption";
import { submitStandardPageAdoption } from "../[organizationId]/[applicationRootId]/page-adoption/actions";

const statusMessage = (result: string | undefined): string | undefined => {
  switch (result) {
    case "saved": return "The selected page adoption was saved as an Application draft. The active release was not changed.";
    case "no_change": return "The selected page adoption already matches this draft.";
    case "conflict": return "The draft or publication changed. Reload this comparison before choosing again.";
    case "refused": return "This page adoption could not be authorized.";
    case "temporarily_unavailable": return "Page adoption is temporarily unavailable. No change was confirmed.";
    default: return undefined;
  }
};

const choiceForm = (
  choice: ComparisonChoice,
  input: Extract<StudioStandardPageAdoptionLoadResult, { kind: "available" }>,
  decision: "keep_replacement" | "adopt_original",
) => (
  <form action={submitStandardPageAdoption} className="inline-flex">
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
    <button className="rounded border px-3 py-2 underline" type="submit">
      {decision === "keep_replacement" ? "Keep replacement" : "Adopt supplied page"}
    </button>
  </form>
);

export function StandardPageAdoption({
  result,
  message,
}: Readonly<{
  result: StudioStandardPageAdoptionLoadResult;
  message?: string;
}>) {
  const notice = statusMessage(message);
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Standard page adoption</h1>
        <p>Compare the latest published standard page with its local replacement. A choice updates this draft only; publication and installation stay separate.</p>
      </header>
      {notice !== undefined && <p role="status" className="rounded border p-3">{notice}</p>}
      {result.kind === "temporarily_unavailable" && <p role="status">The comparison is temporarily unavailable.</p>}
      {result.kind === "refused" && <p role="status">This Application page comparison is unavailable.</p>}
      {result.kind === "available" && result.choices.length === 0 && (
        <p>No compatible published page and local replacement pair is available in this draft.</p>
      )}
      {result.kind === "available" && result.choices.length > 0 && (
        <section aria-label="Page replacement comparisons" className="space-y-5">
          {result.choices.map((choice) => (
            <article key={`${choice.original.pageId}:${choice.replacement.pageId}:${choice.target.target.kind}:${choice.target.target.id}`} className="space-y-4 rounded border p-5">
              <div>
                <h2 className="text-lg font-medium">{choice.original.name} and {choice.replacement.name}</h2>
                <p>Latest published version {choice.candidate.releaseVersion}; revision {choice.candidate.releaseRevision}.</p>
                <p>Current replacement: {choice.replacement.key}. Supplied page: {choice.original.key}.</p>
                {choice.candidate.impactReasons.length > 0 && (
                  <ul aria-label="Published version impact" className="list-disc pl-6">
                    {choice.candidate.impactReasons.slice(0, 8).map((reason, index) => (
                      <li key={`${reason.code}:${index}`}>{reason.impact}: {reason.code}</li>
                    ))}
                  </ul>
                )}
              </div>
              <section aria-label="Page structure and content differences" className="space-y-2">
                <h3 className="font-medium">Page structure and content</h3>
                <p className="text-sm">Sensitive references and free-form values are summarized. The comparison is limited to changed items.</p>
                {choice.differences.entries.length === 0 ? (
                  <p>No differences were found in the safe page summary.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-sm">
                      <caption className="sr-only">Differences between the current replacement and supplied page</caption>
                      <thead>
                        <tr>
                          <th scope="col" className="border-b p-2">Page element</th>
                          <th scope="col" className="border-b p-2">Change</th>
                          <th scope="col" className="border-b p-2">Current replacement</th>
                          <th scope="col" className="border-b p-2">Supplied page</th>
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
                  <p>{choice.differences.omittedCount} additional differences are omitted from this bounded summary.</p>
                )}
                {choice.differences.summaryTruncated && (
                  <p>Additional page details were omitted to keep this comparison bounded.</p>
                )}
              </section>
              <div className="flex flex-wrap items-center gap-3">
                <p className="font-medium">Selected target: {choice.target.label}</p>
                {choiceForm(choice, result, "keep_replacement")}
                {choiceForm(choice, result, "adopt_original")}
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
