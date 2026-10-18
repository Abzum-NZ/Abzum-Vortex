"use client";

import { useRef, useState, type ReactElement } from "react";
import {
  attachmentUploadAdmissionSchema as admittedSchema,
  attachmentUploadCompletionSchema as completedSchema,
  attachmentUploadRefusalSchema as refusedSchema,
} from "@vortex/platform/schema";
import { Field, FieldLabel } from "../components/field";
import { Input } from "../components/input";
import { Button } from "../components/button";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import {
  describedBy,
  FieldLabelText,
  FieldMessages,
  inactiveNote,
  useFieldFeedback,
  useFieldIds,
  useSeededState,
} from "./field-parts";
import { useFormField, useFormFieldError } from "./form-context";
import type { AttachmentInputPayload } from "./projected-data";

/** A Puck field publishes completed references to its enclosing form. */
export function AttachmentInput(props: ControlRenderProps<AttachmentInputPayload>): ReactElement {
  const context = resolveControlContext(props, ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const required = settings.boolean("required");
  const feedback = useFieldFeedback(fieldKey);
  const disabled = context.inactive || settings.boolean("disabled") || feedback?.disabled === true;
  const readOnly = settings.boolean("read_only");
  const maximum = settings.number("maximum_files")!;
  const maximumSize = settings.number("maximum_size_mb")!;
  const [serialized, setSerialized] = useSeededState(JSON.stringify(context.values?.files ?? []));
  const files = JSON.parse(serialized) as { fileId: string; name: string }[];
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failure, setFailure] = useState<string>();
  useFormField(
    fieldKey,
    props.placementId,
    files.map((file) => file.fileId),
    () =>
      busyRef.current
        ? "Wait for the upload to finish."
        : (failure ??
          (required && !disabled && !readOnly && files.length === 0
            ? `${label} is required.`
            : undefined)),
  );
  const formError = useFormFieldError(fieldKey);
  const help = settings.text("help_text");
  const error = failure ?? context.values?.error ?? formError;
  const note = inactiveNote(context);
  const change = (next: typeof files) => {
    setSerialized(JSON.stringify(next));
    context.events?.field_changed?.({
      event: "field_changed",
      fieldKey,
      value: next.map((file) => file.fileId),
    });
  };
  const upload = async (selected: FileList | null) => {
    if (selected === null || busyRef.current || disabled || readOnly) return;
    const chosen = Array.from(selected);
    const replacing = maximum === 1 && files.length === 1;
    if (chosen.length + (replacing ? 0 : files.length) > maximum) {
      setFailure(`Choose at most ${maximum} files.`);
      return;
    }
    if (chosen.some((file) => file.size === 0 || file.size > maximumSize * 1048576)) {
      setFailure(`Choose files between 1 byte and ${maximumSize} MiB.`);
      return;
    }
    const endpoint = context.values?.uploadUrl;
    if (endpoint === undefined) {
      setFailure("File uploads are unavailable on this page.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFailure(undefined);
    let next = replacing ? [] : [...files];
    const command = async (body: unknown) => {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result: unknown = await response.json();
      const refused = refusedSchema.safeParse(result);
      if (refused.success) throw new Error(refused.data.message);
      if (!response.ok) throw new Error("The upload could not finish. Try again.");
      return result;
    };
    try {
      for (const file of chosen) {
        const admitted = admittedSchema.parse(
          await command({
            operation: "admit",
            filename: file.name,
            mediaType: file.type,
            sizeBytes: file.size,
            ...(() => {
              const replaced = context.values?.files.find(
                (file) => replacing || !next.some((current) => current.fileId === file.fileId),
              );
              return replaced === undefined ? {} : { replacingFileId: replaced.fileId };
            })(),
          }),
        );
        const stored = await fetch(admitted.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${admitted.token}`,
            "Content-Type": file.type || "application/octet-stream",
            "x-upsert": "false",
          },
          body: file,
          credentials: "omit",
          redirect: "error",
        });
        if (!stored.ok) throw new Error("The file could not be stored. Choose it again to retry.");
        const completed = completedSchema.parse(
          await command({ operation: "complete", fileId: admitted.fileId }),
        );
        next = [...next, { fileId: completed.fileId, name: completed.name }];
        change(next);
      }
    } catch (cause) {
      setFailure(
        cause instanceof Error && cause.name !== "ZodError"
          ? cause.message
          : "The upload response was invalid. Refresh the page and try again.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Field
      data-vortex-control="attachment-input"
      data-vortex-field-key={fieldKey}
      hidden={feedback?.hidden === true}
    >
      <FieldLabel htmlFor={ids.control}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <ul>
        {files.map((file) => (
          <li key={file.fileId} className="flex items-center justify-between gap-2">
            <span>{file.name}</span>
            <Button
              type="button"
              variant="ghost"
              disabled={disabled || readOnly || busy}
              onClick={() => {
                setFailure(undefined);
                change(files.filter((item) => item.fileId !== file.fileId));
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <Input
        id={ids.control}
        type="file"
        multiple={settings.boolean("multiple")}
        accept={settings.text("accepted_extensions")}
        disabled={disabled || readOnly || busy || (files.length >= maximum && maximum !== 1)}
        aria-invalid={error !== undefined}
        {...describedBy(ids, help, error, note, feedback)}
        onChange={(event) => {
          void upload(event.target.files);
          event.target.value = "";
        }}
      />
      {busy ? <p role="status">Uploading…</p> : null}
      <FieldMessages ids={ids} help={help} error={error} note={note} draftFeedback={feedback} />
    </Field>
  );
}
