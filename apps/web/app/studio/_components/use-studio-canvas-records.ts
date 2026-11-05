import { useCallback, useMemo } from "react";
import type { ApplicationRootId, ApplicationSourceDocument } from "@vortex/platform/schema";
import {
  studioDraftChoices,
  useStudioSameByKey,
  type StudioCanvasGridRead,
  type StudioRecordReader,
} from "@vortex/ui/studio";
import { readStudioCanvasRecords, readStudioDataRecords } from "../_lib/studio-preview-reader";
import { readWhenPreviewReady } from "../_lib/studio-preview-gate";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";
import type { StudioDraft } from "./use-studio-draft";

/**
 * What the canvas tab reads for the blocks: the choices their settings offer (queries, fields,
 * pages, records) and the records of the canvas's data blocks.
 */
export function useStudioCanvasRecords({
  draft,
  organizationId,
  rootId,
  applications,
  canvasPage,
  canvasPageRef,
}: Readonly<{
  draft: StudioDraft;
  organizationId: string;
  rootId: ApplicationRootId;
  /** The organisation's applications, which name the owner of a choice from a used Module. */
  applications: readonly StudioModuleOwnerApplication[];
  canvasPage: ApplicationSourceDocument["body"]["pages"][number] | undefined;
  canvasPageRef: Readonly<{ current: string | undefined }>;
}>) {
  const { source, view } = draft;
  // What reference settings and the query picker offer: queries that already exist (own, then borrowed), fields and pages.
  // A record reference picks a record of the builder's preview of the saved draft, read 40 at a
  // time with their preview access through the same reader as the Data tab's results, once the
  // preview runs the saved revision's data shape.
  const readRecordChoices = useCallback<StudioRecordReader>(
    async ({ recordType, after }, signal) => {
      const separator = recordType.indexOf(":");
      const result = await readWhenPreviewReady(
        draft.preview,
        view.draftRevision,
        view.previewShape,
        signal,
        () =>
          readStudioDataRecords(
            organizationId,
            {
              rootId,
              draftRevision: view.draftRevision,
              moduleKey: recordType.slice(0, separator),
              recordKey: recordType.slice(separator + 1),
              pageSize: 40,
              ...(after === undefined ? {} : { continuationToken: after }),
            },
            signal,
          ),
      );
      switch (result.kind) {
        case "available": {
          const title = result.titleColumn;
          return {
            kind: "available",
            records: result.rows.map((row) => ({
              recordId: row.id,
              label: (title === undefined ? undefined : row.cells[title]) || "Untitled record",
            })),
            ...(result.next === undefined ? {} : { next: result.next }),
          };
        }
        case "not_saved":
          return { kind: "not_saved" };
        // The preview did not reach the saved revision; the picker reads again when opened again.
        case "following":
          return { kind: "temporarily_unavailable" };
        // The saved draft moved on; the next save's revision reads again.
        case "conflict":
          return { kind: "temporarily_unavailable" };
        case "no_query":
          return { kind: "no_list" };
        // A record type is read through a plain query, never a summary.
        case "summary":
          return { kind: "no_list" };
        case "query_refused":
          console.error(
            `[studio] record choices were refused: STUDIO_RECORD_CHOICES_REFUSED reason=${result.reason}`,
          );
          return { kind: "refused" };
        case "refused":
          return { kind: "refused" };
        // The draft cannot run yet; the picker reads again once it can.
        case "not_runnable":
        case "temporarily_unavailable":
          return { kind: "temporarily_unavailable" };
      }
    },
    [organizationId, rootId, view.draftRevision, view.previewShape, draft.preview],
  );
  const applicationName = useCallback(
    (application: string) =>
      applications.find((candidate) => candidate.key === application)?.name ??
      "another application",
    [applications],
  );
  const draftChoicesNow = useMemo(
    () => studioDraftChoices(source, view.borrowedChoices, readRecordChoices, applicationName),
    [source, view.borrowedChoices, readRecordChoices, applicationName],
  );
  // The choices are made again for each draft change but hold the same content for nearly all of
  // them (a typed label changes none): they keep their identity, so the settings do not draw.
  const draftChoices = useStudioSameByKey(draftChoicesNow, JSON.stringify(draftChoicesNow), [
    readRecordChoices,
    applicationName,
    view.borrowedChoices,
  ]);
  // The values the selected block's page declares, which a display can show.
  const blockChoicesNow = useMemo(
    () => ({
      ...draftChoices,
      pageValues: Object.entries(canvasPage?.values ?? {}).map(([key, declaration]) => ({
        key,
        label: declaration.label,
        ...(declaration.currency === undefined ? {} : { currency: declaration.currency }),
      })),
    }),
    [draftChoices, canvasPage],
  );
  const blockChoices = useStudioSameByKey(
    blockChoicesNow,
    JSON.stringify(blockChoicesNow.pageValues),
    [draftChoices],
  );
  // The records of the canvas's data blocks, read once per area for the compiled saved revision,
  // when the builder's preview runs that revision's data shape.
  const readCanvasRecords = useCallback(
    async (
      area: string,
      signal: AbortSignal,
      controlValues: Readonly<Record<string, string>>,
      tableStates: Readonly<Record<string, StudioCanvasGridRead>>,
    ) => {
      const pageAlias = canvasPageRef.current;
      if (pageAlias === undefined) return { state: "unavailable" as const, records: {} };
      const result = await readWhenPreviewReady(
        draft.preview,
        view.draftRevision,
        view.previewShape,
        signal,
        () =>
          readStudioCanvasRecords(
            organizationId,
            {
              rootId,
              draftRevision: view.draftRevision,
              sourceFingerprint: view.sourceFingerprint,
              pageAlias,
              area,
              controlValues,
              tableStates,
            },
            signal,
          ),
      );
      if (
        result.kind === "available" &&
        result.draftRevision === view.draftRevision &&
        result.sourceFingerprint === view.sourceFingerprint &&
        result.pageAlias === pageAlias &&
        result.area === area
      )
        return {
          state: "ready" as const,
          records: result.records,
          ...(result.sample === undefined ? {} : { sample: result.sample }),
        };
      if (result.kind === "refused") return { state: "refused" as const, records: {} };
      if (result.kind === "not_runnable")
        return {
          state: "not_runnable" as const,
          sentence: result.sentence,
          refusal: result.refusal,
          records: {},
        };
      // A conflict means a newer save replaced this revision: its compile reads again, and what is shown stays meanwhile.
      if (result.kind === "conflict") return { state: "superseded" as const, records: {} };
      // A read that is temporarily unavailable is an expected race (logged as information); any other cause is a platform fault.
      (result.kind === "temporarily_unavailable" ? console.info : console.error)(
        `[studio] the canvas records were not read: STUDIO_CANVAS_RECORDS_${result.kind.toUpperCase()}`,
      );
      return { state: "unavailable" as const, records: {} };
    },
    [
      organizationId,
      rootId,
      view.draftRevision,
      view.sourceFingerprint,
      view.previewShape,
      draft.preview,
    ],
  );

  return { readRecordChoices, applicationName, draftChoices, blockChoices, readCanvasRecords };
}
