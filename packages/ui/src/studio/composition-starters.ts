import type {
  ImmutablePlatformBlockCatalogue,
  PlatformBlockRelease,
  SourceItem,
} from "@vortex/platform/schema";
import { freshBlockName } from "./stored-composition";

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
  release.key === "platform.form.container" &&
  slotKey === "content" &&
  formChildren(catalogue) !== undefined;

export const studioStarterSlots = (
  catalogue: ImmutablePlatformBlockCatalogue,
  release: PlatformBlockRelease,
  taken: Set<string>,
): Record<string, SourceItem[]> => {
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
  return {
    content: [
      item(children.input, "answer", { name: "answer", label: "Answer" }),
      item(children.button, "submit", {
        label: "Submit",
        action_kind: "submit",
        variant: "primary",
      }),
    ],
  };
};
