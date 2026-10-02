import {
  blockPropertyValueV2Schema,
  NOTICE_BLOCK_RELEASE,
  validateComponentSettings,
  type BlockPropertyValueV2Contract,
} from "@vortex/contracts";
import type { ReactElement } from "react";
import { Notice, type NoticeContentPart, type NoticeSeverity } from "../components/notice";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import type { DisplayRenderProps } from "./context";

const NOTICE_SEVERITIES =
  ["info", "success", "warning", "critical"] as const satisfies readonly NoticeSeverity[];
const NOTICE_CONTENT_KINDS = ["text", "link"] as const;

type NoticeSettings = Readonly<Record<string, BlockPropertyValueV2Contract>>;

const noticeLocation = (props: DisplayRenderProps<never>): DefinitionRenderErrorLocation => ({
  placementId: props.placementId,
  blockId: props.metadata.blockId,
  releaseVersion: props.metadata.releaseVersion,
});

const refuse = (
  location: DefinitionRenderErrorLocation,
  message: string,
  propertyPath?: readonly (string | number)[],
): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, {
    ...location,
    ...(propertyPath === undefined ? {} : { propertyPath: propertyPath.map(String) }),
  });
};

const readTextSetting = (
  settings: NoticeSettings,
  key: string,
  location: DefinitionRenderErrorLocation,
  required: boolean,
  path: readonly (string | number)[] = [key],
): string | undefined => {
  const setting = settings[key];
  if (setting === undefined && !required) return undefined;
  if (setting === undefined || setting.kind !== "text")
    return refuse(location, "Notice settings must match the declared Notice release", path);
  return setting.value;
};

const readChoiceSetting = <const Choices extends readonly string[]>(
  settings: NoticeSettings,
  key: string,
  choices: Choices,
  location: DefinitionRenderErrorLocation,
  path: readonly (string | number)[] = [key],
): Choices[number] => {
  const setting = settings[key];
  if (
    setting === undefined ||
    setting.kind !== "choice" ||
    !choices.includes(setting.value as Choices[number])
  )
    return refuse(location, "Notice settings must match the declared Notice release", path);
  return setting.value as Choices[number];
};

const parseCanonicalSettings = (
  input: unknown,
  location: DefinitionRenderErrorLocation,
): NoticeSettings => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return refuse(location, "Notice settings must be an object");

  const settings: Record<string, BlockPropertyValueV2Contract> = Object.create(null);
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const parsed = blockPropertyValueV2Schema.safeParse(value);
    if (!parsed.success)
      return refuse(location, "Notice settings must match the declared Notice release", [key]);
    settings[key] = parsed.data;
  }

  const failures = validateComponentSettings(settings, NOTICE_BLOCK_RELEASE.properties);
  const failure = failures[0];
  if (failure !== undefined) {
    return refuse(
      location,
      "Notice settings must match the declared Notice release",
      failure.path,
    );
  }
  return Object.freeze(settings);
};

function readDismissible(
  settings: NoticeSettings,
  location: DefinitionRenderErrorLocation,
): boolean {
  const setting = settings.dismissible;
  if (setting !== undefined) {
    if (setting.kind !== "boolean")
      return refuse(
        location,
        "Notice settings must match the declared Notice release",
        ["dismissible"],
      );
    return setting.value;
  }

  const declaration = NOTICE_BLOCK_RELEASE.properties.find(
    (property) => property.key === "dismissible",
  );
  if (declaration?.kind !== "boolean" || declaration.defaultValue?.kind !== "boolean")
    return refuse(
      location,
      "Notice release must declare a boolean dismissal default",
      ["dismissible"],
    );
  return declaration.defaultValue.value;
}

/** Thin browser-safe adapter from this exact authored release to the unchanged Notice primitive. */
export function NoticeBlock(props: DisplayRenderProps<never>): ReactElement {
  const location = noticeLocation(props);
  const metadata = props.metadata;
  if (
    metadata.blockId !== NOTICE_BLOCK_RELEASE.blockId ||
    metadata.key !== NOTICE_BLOCK_RELEASE.key ||
    metadata.releaseVersion !== NOTICE_BLOCK_RELEASE.releaseVersion ||
    metadata.rendererKey !== NOTICE_BLOCK_RELEASE.rendererKey ||
    metadata.contentFingerprint !== NOTICE_BLOCK_RELEASE.contentFingerprint ||
    metadata.catalogueFingerprint !== NOTICE_BLOCK_RELEASE.catalogueFingerprint
  )
    throw new DefinitionRenderError(
      "MISMATCHED_RELEASE",
      "Notice renderer received metadata for a different immutable release",
      location,
    );

  const settings = parseCanonicalSettings(props.settings, location);
  const severity = readChoiceSetting(settings, "severity", NOTICE_SEVERITIES, location);
  const contentSetting = settings.content;
  if (contentSetting === undefined || contentSetting.kind !== "list")
    return refuse(location, "Notice settings must match the declared Notice release", ["content"]);

  const content: readonly NoticeContentPart[] = Object.freeze(
    contentSetting.items.map((item, index): NoticeContentPart => {
      const itemPath = ["content", index] as const;
      if (item.kind !== "group")
        return refuse(location, "Notice settings must match the declared Notice release", itemPath);

      const kind = readChoiceSetting(item.properties, "kind", NOTICE_CONTENT_KINDS, location, [
        ...itemPath,
        "kind",
      ]);
      const value = readTextSetting(item.properties, "value", location, true, [
        ...itemPath,
        "value",
      ]);
      if (value === undefined)
        return refuse(location, "Notice settings must match the declared Notice release", [
          ...itemPath,
          "value",
        ]);
      if (kind === "text") return Object.freeze({ kind, value });

      const href = readTextSetting(item.properties, "href", location, false, [
        ...itemPath,
        "href",
      ]);
      return Object.freeze({ kind, label: value, href: href ?? "" });
    }),
  );

  const title = readTextSetting(settings, "title", location, false);
  return (
    <Notice
      severity={severity}
      content={content}
      dismissible={readDismissible(settings, location)}
      {...(title === undefined ? {} : { title })}
    />
  );
}
