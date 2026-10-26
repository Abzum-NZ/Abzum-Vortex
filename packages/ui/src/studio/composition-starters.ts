import type {
  ApplicationSourceDocument,
  ImmutablePlatformBlockCatalogue,
  PlatformBlockRelease,
  SourceItem,
} from "@vortex/platform/schema";
import { freshBlockName } from "./stored-composition";
import { studioRecordDetailItem } from "./application-record-pages";
import { refuse } from "./application-structure-common";

/** Authoring templates fill required slots before the ordinary composition validation runs. */
const formChildren = (catalogue: ImmutablePlatformBlockCatalogue) => {
  const input = catalogue.releases.find((release) => release.key === "platform.form.text_input");
  const button = catalogue.releases.find((release) => release.key === "platform.action.button");
  return input === undefined || button === undefined ? undefined : { input, button };
};

export const studioHasSlotStarter = (
  catalogue: ImmutablePlatformBlockCatalogue,
  release: PlatformBlockRelease,
  slotKey: string,
): boolean =>
  slotKey === "content" &&
  ((release.key === "platform.form.container" && formChildren(catalogue) !== undefined) ||
    (release.key === "platform.layout.drawer" &&
      catalogue.releases.some((entry) => entry.key === "platform.display.record_detail")));

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
  if (release.key !== "platform.form.container") return {};
  const children = formChildren(catalogue);
  if (children === undefined) throw new Error("STUDIO_FORM_STARTER_RELEASE_MISSING");
  const item = (
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
  const answer = item(children.input, "answer", { name: "answer", label: "Answer" });
  // The surface a flow shows a form in supplies Submit and Cancel, so that form starts with its field only.
  if (shownByFlow) return { content: [answer] };
  return {
    content: [
      answer,
      item(children.button, "submit", {
        label: "Submit",
        action_kind: "submit",
        variant: "primary",
      }),
    ],
  };
};
