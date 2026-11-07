import type { ApplicationSourceDocument } from "../application-source-contracts";
import type {
  ImmutablePlatformBlockCatalogue,
  PlatformBlockRelease,
} from "../application-composition/platform-block-release";
import type { SourceItem } from "../application-composition/source-composition";
import { freshBlockName } from "./stored-composition";
import { studioRecordDetailItem } from "./application-record-page-detail";
import { refuse } from "./application-structure";

/** Authoring templates fill required slots before the ordinary composition validation runs. */
const formChildren = (catalogue: ImmutablePlatformBlockCatalogue) => {
  const input = catalogue.releases.find((release) => release.key === "platform.form.text_input");
  const button = catalogue.releases.find((release) => release.key === "platform.action.button");
  return input === undefined || button === undefined ? undefined : { input, button };
};

const starterItem = (
  taken: Set<string>,
  child: PlatformBlockRelease,
  name: string,
  settings: Record<string, unknown>,
): SourceItem => {
  const id = freshBlockName(name, taken);
  taken.add(id);
  return {
    type: child.rendererKey,
    props: {
      id,
      ...settings,
      vortex: {
        block: { block_id: child.blockId, release_version: child.releaseVersion },
        responsive: {
          desktop: { visible: true, width: { kind: "fill" }, height: { kind: "content" } },
        },
      },
    },
  } as SourceItem;
};

const textRelease = (catalogue: ImmutablePlatformBlockCatalogue) =>
  catalogue.releases.find((release) => release.key === "platform.display.text");

export const studioHasSlotStarter = (
  catalogue: ImmutablePlatformBlockCatalogue,
  release: PlatformBlockRelease,
  slotKey: string,
): boolean =>
  slotKey === "content" &&
  ((release.key === "platform.form.container" && formChildren(catalogue) !== undefined) ||
    (release.key === "platform.layout.drawer" &&
      catalogue.releases.some((entry) => entry.key === "platform.display.record_detail")) ||
    (release.key === "platform.layout.dialog" && textRelease(catalogue) !== undefined));

export const studioStarterSlots = (
  catalogue: ImmutablePlatformBlockCatalogue,
  release: PlatformBlockRelease,
  taken: Set<string>,
  shownByFlow: boolean,
  source: ApplicationSourceDocument,
): Record<string, SourceItem[]> => {
  if (release.key === "platform.layout.drawer") {
    const module = source.body.modules.find((entry) => entry.record_types.length > 0);
    const record = module?.record_types[0];
    if (module === undefined || record === undefined)
      return refuse("Add a record type before adding a Drawer with record details.");
    const alias = freshBlockName("record_detail", taken);
    taken.add(alias);
    return {
      content: [studioRecordDetailItem(catalogue, source, `${module.key}:${record.key}`, alias)],
    };
  }
  if (release.key === "platform.layout.dialog") {
    const text = textRelease(catalogue);
    if (text === undefined) throw new Error("STUDIO_DIALOG_STARTER_RELEASE_MISSING");
    return { content: [starterItem(taken, text, "text", { text: "Dialog content" })] };
  }
  if (release.key !== "platform.form.container") return {};
  const children = formChildren(catalogue);
  if (children === undefined) throw new Error("STUDIO_FORM_STARTER_RELEASE_MISSING");
  const answer = starterItem(taken, children.input, "answer", { name: "answer", label: "Answer" });
  // The surface a flow shows a form in supplies Submit and Cancel, so that form starts with its field only.
  if (shownByFlow) return { content: [answer] };
  return {
    content: [
      answer,
      starterItem(taken, children.button, "submit", {
        label: "Submit",
        action_kind: "submit",
        variant: "primary",
      }),
    ],
  };
};
