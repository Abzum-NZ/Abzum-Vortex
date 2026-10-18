import type { ReactElement } from "react";
import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  attachmentListPayloadSchema,
  validateComponentSettings,
  type AttachmentListPayload,
} from "@vortex/platform/schema";
import { Card, CardContent, CardHeader } from "./components/card";
import { Separator } from "./components/separator";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "./definition-error";
import { DisplayStateContainer } from "./display/display-state-container";
import { DisplayHeader } from "./display/controls";
import { resolveDisplayContext, type DisplayRenderProps } from "./display/context";
import { formatLocaleNumber } from "./display/date-format";
import { parseDisplayData, parseDisplayEventHandlers } from "./display/projected-data";
import { createPayloadParser, type PlatformComponentRegistration } from "./registry";

const ATTACHMENT_LIST_RELEASE = PLATFORM_BLOCK_RELEASE_IDENTITIES.ATTACHMENT_LIST_BLOCK_RELEASE;

type ReadonlyAttachmentListPayload = Readonly<{
  kind: AttachmentListPayload["kind"];
  files: readonly Readonly<AttachmentListPayload["files"][number]>[];
}>;

function refuse(location: DefinitionRenderErrorLocation): never {
  throw new DefinitionRenderError(
    "INVALID_COMPOSITION",
    "Attachment-list runtime input must match its closed protected projection",
    location,
  );
}

/** The per-release parser admits only sanitized metadata and the fixed same-origin File route. */
function parseAttachmentListPayload(
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ReadonlyAttachmentListPayload {
  const parsed = attachmentListPayloadSchema.safeParse(value);
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

const formatBytes = (bytes: number): string => `${formatLocaleNumber(bytes)} bytes`;

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
    metadata.key !== ATTACHMENT_LIST_RELEASE.key ||
    metadata.releaseVersion !== ATTACHMENT_LIST_RELEASE.releaseVersion ||
    metadata.rendererKey !== "platform.renderer.attachment_list"
  )
    throw new DefinitionRenderError(
      "MISMATCHED_RELEASE",
      "Attachment list received a different immutable release",
      location,
    );
  if (validateComponentSettings(props.settings, metadata.properties).length !== 0)
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
      releaseIdentity: ATTACHMENT_LIST_RELEASE,
      parsePayload: ATTACHMENT_PAYLOAD_PARSER,
    }),
  ]);
