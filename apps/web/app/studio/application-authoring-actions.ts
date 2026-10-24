"use server";

import {
  applicationRootIdSchema,
  applicationSourceDocumentSchema,
  changeInlineModuleField,
  fingerprintSchema,
  logRefusal,
} from "@vortex/platform/schema";
import { z } from "zod";
import { loadStudioApplicationDraft } from "../_lib/studio-application-draft";
import { mapWebError } from "../_lib/web-error-mapper";
import { reviewStudioApplicationSource } from "./actions";
import {
  applicationAuthoringTools,
  type ApplicationAuthoringToolName,
} from "./_lib/application-authoring-tools";

const requestSchema = z
  .object({
    rootId: applicationRootIdSchema,
    expectedSavedSourceFingerprint: fingerprintSchema,
    tool: z.enum(
      Object.keys(applicationAuthoringTools) as [
        ApplicationAuthoringToolName,
        ...ApplicationAuthoringToolName[],
      ],
    ),
    input: z.unknown(),
  })
  .strict();

/** Advisory review over Studio's protected source service; the workspace's one save writes it. */
export async function reviewStudioApplicationAuthoring(organizationId: string, candidate: unknown) {
  try {
    const request = requestSchema.safeParse(candidate);
    if (!request.success) {
      logRefusal("studio/application-authoring-actions", "review", "invalid_input", request.error);
      return { kind: "invalid" } as const;
    }
    const input = applicationAuthoringTools[request.data.tool].input.safeParse(request.data.input);
    if (!input.success) {
      logRefusal(
        "studio/application-authoring-actions",
        request.data.tool,
        "invalid_input",
        input.error,
      );
      return {
        kind: "invalid_input",
        issues: input.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      } as const;
    }
    const fieldEdit = "field" in input.data;
    const loaded = await loadStudioApplicationDraft(organizationId, request.data.rootId, [
      { kind: fieldEdit ? "data" : "source" },
    ]);
    if (loaded.kind !== "available") return loaded;
    if (
      loaded.draft.draftRevision !== input.data.draftRevision ||
      loaded.draft.sourceFingerprint !== request.data.expectedSavedSourceFingerprint
    )
      return { kind: "conflict" } as const;
    let source: unknown = loaded.draft.source;
    if ("field" in input.data) {
      const view = loaded.views[0];
      if (view?.published === null || view === undefined)
        throw new Error("STUDIO_AUTHORING_PUBLICATION_CONTEXT_MISSING");
      const changed = changeInlineModuleField(
        loaded.draft.source,
        {
          ...input.data.field,
          defaultValue: input.data.field.defaultValue,
          cardinality: input.data.field.cardinality,
        },
        {
          publication: {
            fields: new Set(view.published.fields),
            recordTypes: new Set(view.published.recordTypes),
          },
          peopleDirectory: view.peopleDirectory,
        },
      );
      if (changed.kind !== "changed") {
        logRefusal(
          "studio/application-authoring-actions",
          request.data.tool,
          "field_change_invalid",
          changed.issues,
        );
        return {
          kind: "invalid_input",
          issues: changed.issues.map((message) => ({ path: "field", message })),
        } as const;
      }
      source = changed.source;
    } else
      source = {
        ...loaded.draft.source,
        body: { ...loaded.draft.source.body, ...input.data.changes },
      };
    const parsedSource = applicationSourceDocumentSchema.safeParse(source);
    if (!parsedSource.success) {
      logRefusal(
        "studio/application-authoring-actions",
        request.data.tool,
        "source_invalid",
        parsedSource.error,
      );
      return {
        kind: "invalid_input",
        issues: parsedSource.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      } as const;
    }
    return await reviewStudioApplicationSource(organizationId, {
      rootId: loaded.draft.rootId,
      expectedDraftRevision: input.data.draftRevision,
      expectedSavedSourceFingerprint: request.data.expectedSavedSourceFingerprint,
      source: parsedSource.data,
    });
  } catch (error) {
    return mapWebError(error, {
      route: "studio/application-authoring-actions",
      operation: "review",
      code: "STUDIO_AUTHORING_REVIEW_FAILED",
      fallback: { kind: "temporarily_unavailable" } as const,
    });
  }
}
