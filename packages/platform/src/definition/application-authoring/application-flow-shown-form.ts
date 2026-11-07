import { sourceItemTree } from "../application-composition/source-composition";
import type { ApplicationSourceDocument } from "../application-source-contracts";
import type { ImmutablePlatformBlockCatalogue } from "../application-composition/platform-block-release";
import type { SourceFlow } from "../../workflows/flow-source-contracts";
import { addPlaces, newBlockItem, placeItem } from "./application-composition-add";
import { PUBLISHED_PAGE_ADD_REASON, regions } from "./application-composition-regions";
import { sourceNames } from "./composition-references";
import {
  freshBlockName,
  StoredCompositionRefusal,
  syncStoredBlockDependencies,
} from "./stored-composition";

type StudioFlowShownFormResult =
  Readonly<{ ok: true; alias: string }> | Readonly<{ ok: false; reason: string }>;

const noPage =
  "Put the button that starts this flow on a page first. The form needs a page to belong to.";

/** The page that holds a control of this flow, with the content area it sits in. */
const invokingRegion = (source: ApplicationSourceDocument, flow: SourceFlow) => {
  const controls = new Set(
    source.body.flow_bindings
      .filter((binding) => binding.flow === flow.id || binding.flow === flow.key)
      .map((binding) => binding.control),
  );
  return regions(source).find(
    (region) =>
      region.page !== undefined &&
      sourceItemTree(region.zone.items).some((item) => controls.has(item.props.id)),
  );
};

/** Whether a flow has a page a form it shows can be created on. */
export const studioFlowCanCreateShownForm = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  flow: SourceFlow,
): boolean => {
  const found = flowFormPlace(catalogue, source, flow);
  return found !== undefined && !("published" in found);
};

/** Whether the page the flow's button sits on is published, so its form cannot be created there. */
export const studioFlowShownFormPublished = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  flow: SourceFlow,
): boolean => {
  const found = flowFormPlace(catalogue, source, flow);
  return found !== undefined && "published" in found;
};

const flowFormPlace = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  flow: SourceFlow,
) => {
  const region = invokingRegion(source, flow);
  if (region?.page === undefined) return undefined;
  const places = addPlaces(catalogue, source, { kind: "page", pageAlias: region.page.id });
  // A page published outside the application takes no new block: the form cannot be made there.
  if (places === "published") return { published: true } as const;
  if (typeof places === "string") return undefined;
  const place = places.find(
    (candidate) =>
      candidate.steps.length === 0 &&
      candidate.region.page === region.page &&
      candidate.region.address?.key === region.address?.key,
  );
  const release = catalogue.releases.find((entry) => entry.key === "platform.form.container");
  return place !== undefined &&
    release !== undefined &&
    place.target.choices.some(
      (choice) =>
        choice.blockId === release.blockId &&
        choice.releaseVersion === release.releaseVersion &&
        choice.unavailable === undefined,
    )
    ? { place, release }
    : undefined;
};

/**
 * Adds the form a flow shows: an ordinary form container with one field at the end of the content
 * of the page its button sits on, hidden on the page so only the flow shows it. The source is
 * edited in place.
 */
export const addStudioFlowShownForm = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  flow: SourceFlow,
  title: string,
): StudioFlowShownFormResult => {
  const found = flowFormPlace(catalogue, source, flow);
  if (found === undefined) return { ok: false, reason: noPage };
  if ("published" in found) return { ok: false, reason: PUBLISHED_PAGE_ADD_REASON };
  const { item } = newBlockItem(catalogue, source, found.release, {}, null, true);
  // The form is named for its flow, so the outline and the step picker show whose form it is.
  const alias = freshBlockName(`${flow.key}_form`, sourceNames(source));
  item.props.id = alias;
  item.props.title = title;
  item.props.vortex.responsive.desktop.visible = false;
  try {
    placeItem(catalogue, source, found.place, found.place.region.zone.items.length, item);
  } catch (error) {
    if (!(error instanceof StoredCompositionRefusal)) throw error;
    console.error(
      `[studio] the form for a flow step could not be added part=${error.location.join(".")}: ${error.reason}`,
    );
    return { ok: false, reason: `The form can't go on that page. ${error.message}.` };
  }
  syncStoredBlockDependencies(source);
  return { ok: true, alias };
};
