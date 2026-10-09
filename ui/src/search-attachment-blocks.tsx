import type { ReactElement } from "react";
import {
  ATTACHMENT_LIST_BLOCK_RELEASE,
  attachmentListPayloadV2Schema,
  validateComponentSettings,
  type AttachmentListPayloadV2,
} from "@vortex/contracts";
import { Card, CardContent, CardHeader } from "./components/card";
import { Separator } from "./components/separator";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "./definition-error";
import { DisplayStateContainer } from "./display/display-state-container";
import { DisplayHeader } from "./display/controls";
import { resolveDisplayContext, type DisplayRenderProps } from "./display/context";
import { parseDisplayData, parseDisplayEventHandlers } from "./display/projected-data";
import { createPayloadParser, type PlatformComponentRegistration } from "./registry";

type ReadonlyAttachmentListPayload = Readonly<{
  kind: AttachmentListPayloadV2["kind"];
  files: readonly Readonly<AttachmentListPayloadV2["files"][number]>[];
}>;

function refuse(location: DefinitionRenderErrorLocation): never {
  throw new DefinitionRenderError(
    "INVALID_COMPOSITION",
    "Attachment-list runtime input must match its closed protected projection",
    location,
  );
}

/** The per-release parser admits only sanitized metadata and the fixed same-origin File route. */
export function parseAttachmentListPayload(
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ReadonlyAttachmentListPayload {
  const parsed = attachmentListPayloadV2Schema.safeParse(value);
  if (!parsed.success) return refuse(location);
  return Object.freeze({
    kind: parsed.data.kind,
    files: Object.freeze(parsed.data.files.map((file) => Object.freeze({ ...file }))),
  });
}

const ATTACHMENT_PAYLOAD_PARSER = createPayloadParser({
  data: (value, location) => parseDisplayData(value, parseAttachmentListPayload, location),
  events: (value, location) => {
    const parsed = parseDisplayEventHandlers(value, location);
    if (Object.keys(parsed).some((event) => event !== "refresh")) return refuse(location);
    return parsed;
  },
});

const formatBytes = (bytes: number): string => `${new Intl.NumberFormat().format(bytes)} bytes`;

/** A read-only accessible list. Download clicks return to the existing protected File GET route. */
export function SearchAttachmentDisplay(
  props: DisplayRenderProps<ReadonlyAttachmentListPayload>,
): ReactElement {
  const metadata = props.metadata;
  const location = {
    placementId: props.placementId,
    blockId: metadata.blockId,
    releaseVersion: metadata.releaseVersion,
  };
  if (
    metadata.blockId !== ATTACHMENT_LIST_BLOCK_RELEASE.blockId ||
    metadata.key !== ATTACHMENT_LIST_BLOCK_RELEASE.key ||
    metadata.releaseVersion !== ATTACHMENT_LIST_BLOCK_RELEASE.releaseVersion ||
    metadata.rendererKey !== ATTACHMENT_LIST_BLOCK_RELEASE.rendererKey ||
    metadata.contentFingerprint !== ATTACHMENT_LIST_BLOCK_RELEASE.contentFingerprint ||
    metadata.catalogueFingerprint !== ATTACHMENT_LIST_BLOCK_RELEASE.catalogueFingerprint
  )
    throw new DefinitionRenderError(
      "MISMATCHED_RELEASE",
      "Attachment list received a different immutable release",
      location,
    );
  if (validateComponentSettings(props.settings, ATTACHMENT_LIST_BLOCK_RELEASE.properties).length !== 0)
    return refuse(location);

  const {
    title,
    accessibleName,
    values,
    state,
    emptyMessage,
    refusedMessage,
    errorMessage,
    events,
  } = resolveDisplayContext<ReadonlyAttachmentListPayload>(
    props,
    (payload) => payload.files.length === 0,
    "No attachments to show",
  );
  const hasHeader = title !== undefined || events?.refresh !== undefined;

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={props.availability}
      projectedData={state}
      emptyMessage={emptyMessage}
      refusedMessage={refusedMessage ?? "Attachments are not available."}
      {...(errorMessage === undefined ? {} : { errorMessage })}
    >
      {values === undefined ? null : (
        <Card
          role="region"
          aria-label={accessibleName}
          data-vortex-display="attachment_list"
          data-vortex-placement-id={props.placementId}
        >
          {hasHeader ? (
            <CardHeader className="*:mb-0">
              <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
            </CardHeader>
          ) : null}
          {hasHeader ? <Separator /> : null}
          <CardContent>
            <ul className="m-0 flex w-full list-none flex-col gap-3 p-0">
              {values.files.map((file) => (
                <li
                  key={file.downloadHref}
                  className="flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="break-words text-sm font-medium">{file.displayName}</span>
                    <span className="text-xs text-muted-foreground">
                      {file.mediaType} · {formatBytes(file.sizeBytes)}
                    </span>
                  </div>
                  <a
                    className="text-sm font-medium underline underline-offset-4"
                    href={file.downloadHref}
                    download
                    aria-label={`Download ${file.displayName}`}
                  >
                    Download
                  </a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </DisplayStateContainer>
  );
}

export const ATTACHMENT_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      metadata: ATTACHMENT_LIST_BLOCK_RELEASE,
      render: SearchAttachmentDisplay,
      parsePayload: ATTACHMENT_PAYLOAD_PARSER,
    }),
  ]);
