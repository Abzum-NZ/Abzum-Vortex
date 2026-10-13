"use client";

import { useState } from "react";
import {
  canonicalJson,
  prepareDefinitionPublicationResultSchema,
  publishDefinitionResultSchema,
  sameId,
} from "@vortex/platform/schema";
import type {
  HumanDefinitionPublicationPreparationResult,
  HumanDefinitionPublicationResult,
  StoredModuleDefinitionDraft,
} from "@web/platform-server";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";

type PublicationConfirmation = ReturnType<
  typeof prepareDefinitionPublicationResultSchema.parse
>["confirmation"];
type PublishedRelease = ReturnType<typeof publishDefinitionResultSchema.parse>;

const reasonMessages: Record<string, string> = {
  release_permission_missing:
    "You do not have the release permission (manage definition releases) for this organisation.",
  release_permission_not_eligible:
    "You do not have the release permission (manage definition releases) for this organisation.",
  recent_authentication_required: "Sign in again to confirm it is you, then retry.",
  draft_stale_or_missing:
    "The Module draft is missing or has changed since this page loaded. Reload and prepare the current saved draft.",
  confirmation_mismatch:
    "The prepared release no longer matches the draft. Reload and prepare again.",
  no_change:
    "The draft is unchanged since the last release, so there is nothing to publish. Save a change first.",
  dependency_missing: "A Module this one depends on has no published release.",
  dependency_prerelease_only: "A Module this one depends on has only a pre-release published.",
  dependency_incompatible:
    "A Module this one depends on is published at an incompatible version.",
  dependency_ambiguous: "A dependency of this Module matches more than one published release.",
  dependency_substituted: "A dependency of this Module resolves to a different Module than declared.",
  dependency_cycle: "This Module's dependencies form a cycle.",
  version_impact_refused:
    "The change needs a version that this release cannot assign. Review the Module changes.",
};

const failureMessage = (result: { kind: string; reason?: string }, action: string): string => {
  const reason = result.reason ?? "";
  const specific =
    reasonMessages[reason] ??
    (reason.startsWith("compilation_")
      ? `The Module draft does not compile (${reason.slice("compilation_".length)}).`
      : undefined);
  const outcome = `No release was ${action}.`;
  if (specific !== undefined) return `${specific} ${outcome}`;
  return result.kind === "temporarily_unavailable"
    ? `Publication is temporarily unavailable (${reason || "unknown"}). ${outcome} Try again shortly.`
    : `Publication was refused (${reason || "unknown"}). ${outcome}`;
};

export function ModulePublicationEditor({
  draft,
  prepare,
  publish,
}: {
  draft: StoredModuleDefinitionDraft;
  prepare: (
    organizationId: string,
    candidate: unknown,
  ) => Promise<HumanDefinitionPublicationPreparationResult>;
  publish: (
    organizationId: string,
    candidate: unknown,
  ) => Promise<HumanDefinitionPublicationResult>;
}) {
  const [confirmation, setConfirmation] = useState<PublicationConfirmation | null>(null);
  const [release, setRelease] = useState<PublishedRelease | null>(null);
  const [releaseNote, setReleaseNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const prepareRelease = async () => {
    if (busy) return;
    setBusy(true);
    setConfirmation(null);
    setRelease(null);
    setMessage("Preparing the saved Module draft…");
    try {
      const result = await prepare(draft.organizationId, {
        rootId: draft.rootId,
        expectedDraftRevision: draft.draftRevision,
      });
      const parsed =
        result.kind === "available"
          ? prepareDefinitionPublicationResultSchema.safeParse(result.preparation)
          : null;
      if (
        parsed?.success &&
        sameId(parsed.data.confirmation.rootId, draft.rootId) &&
        parsed.data.confirmation.expectedDraftRevision === draft.draftRevision
      ) {
        setConfirmation(parsed.data.confirmation);
        setMessage(
          "Preparation verified. Review the release identity and dependencies, then publish explicitly.",
        );
      } else {
        setMessage(
          result.kind === "available"
            ? "The prepared release did not match the saved draft. No release was published. Reload and prepare again."
            : failureMessage(result, "published"),
        );
      }
    } catch {
      setMessage("Preparation could not be verified. Reload the page before trying again.");
    } finally {
      setBusy(false);
    }
  };

  const publishRelease = async () => {
    if (busy || confirmation === null) return;
    const note = releaseNote.trim();
    if (note.length < 1 || note.length > 2_000) {
      setMessage("Enter a release note of 1 to 2,000 characters before publishing.");
      return;
    }
    const prepared = confirmation;
    setBusy(true);
    setConfirmation(null);
    setRelease(null);
    setMessage("Publishing the confirmed Module release…");
    try {
      const result = await publish(draft.organizationId, {
        confirmation: prepared,
        releaseNote: note,
      });
      const parsed =
        result.kind === "available"
          ? publishDefinitionResultSchema.safeParse(result.publication)
          : null;
      if (
        parsed?.success &&
        sameId(parsed.data.rootId, prepared.rootId) &&
        parsed.data.releaseRevision === prepared.expectedDraftRevision &&
        parsed.data.releaseVersion === prepared.assignedVersion &&
        parsed.data.contentFingerprint === prepared.contentFingerprint &&
        parsed.data.resolutionFingerprint === prepared.resolutionFingerprint &&
        canonicalJson(parsed.data.dependencyManifest) === canonicalJson(prepared.dependencyManifest)
      ) {
        setRelease(parsed.data);
        setMessage(
          "Published the verified Module release. Application bindings and installations were not changed.",
        );
      } else {
        setMessage(
          result.kind === "available"
            ? "The publication result could not be verified. Reload and inspect the current release before trying again."
            : failureMessage(result, "published"),
        );
      }
    } catch {
      setMessage(
        "The publication result could not be verified. Reload and inspect the current release before trying again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6" aria-busy={busy}>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Publish Module: {draft.source.body.name}</h1>
        <p>
          Preparation reviews the current saved draft. Publishing creates its exact immutable
          release.
        </p>
        <p>
          A rejected publication rolls back, leaving the previous Module release current. Publishing
          does not change an Application binding or install or adopt anything.
        </p>
        <dl className="break-all text-sm">
          <div>
            <dt className="inline font-medium">Module root: </dt>
            <dd className="inline">{draft.rootId}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Draft revision: </dt>
            <dd className="inline">{draft.draftRevision}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Current published revision: </dt>
            <dd className="inline">{draft.publishedRevision ?? "No release"}</dd>
          </div>
        </dl>
      </header>

      <div className="flex flex-wrap gap-3">
        <Button type="button" disabled={busy} onClick={prepareRelease}>
          Prepare saved draft
        </Button>
      </div>

      {confirmation !== null ? (
        <section className="space-y-4 rounded-lg border p-4" aria-label="Prepared Module release">
          <h2 className="text-lg font-semibold">Prepared release for review</h2>
          <dl className="break-all text-sm">
            <div>
              <dt className="inline font-medium">Outcome: </dt>
              <dd className="inline">{confirmation.outcome}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Assigned release version: </dt>
              <dd className="inline">{confirmation.assignedVersion}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Module revision: </dt>
              <dd className="inline">{confirmation.expectedDraftRevision}</dd>
            </div>
          </dl>
          <details>
            <summary className="cursor-pointer font-medium">Exact dependency manifest</summary>
            <pre className="mt-2 overflow-auto rounded bg-muted p-3 text-xs">
              {JSON.stringify(confirmation.dependencyManifest, null, 2)}
            </pre>
          </details>
          <label className="block space-y-1 text-sm font-medium">
            Release note
            <Input
              maxLength={2_000}
              value={releaseNote}
              onChange={(event) => setReleaseNote(event.target.value)}
            />
          </label>
          <Button
            type="button"
            disabled={busy || releaseNote.trim().length === 0}
            onClick={publishRelease}
          >
            Publish reviewed release
          </Button>
        </section>
      ) : null}

      {release !== null ? (
        <section className="space-y-2 rounded-lg border p-4" aria-label="Published Module release">
          <h2 className="text-lg font-semibold">Published release identity</h2>
          <dl className="break-all text-sm">
            <div>
              <dt className="inline font-medium">Module root: </dt>
              <dd className="inline">{release.rootId}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Release version: </dt>
              <dd className="inline">{release.releaseVersion}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Release revision: </dt>
              <dd className="inline">{release.releaseRevision}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Published at: </dt>
              <dd className="inline">{release.publishedAt}</dd>
            </div>
          </dl>
          <details>
            <summary className="cursor-pointer font-medium">
              Exact published dependency manifest
            </summary>
            <pre className="mt-2 overflow-auto rounded bg-muted p-3 text-xs">
              {JSON.stringify(release.dependencyManifest, null, 2)}
            </pre>
          </details>
          <p>
            Application draft binding changes, Application publication, and adoption or installation
            remain separate deliberate actions.
          </p>
        </section>
      ) : null}

      <p role="status" aria-live="polite">
        {message}
      </p>
    </main>
  );
}
