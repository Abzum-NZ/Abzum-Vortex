import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  sourcePageItems,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import { blockItem, blockRelease, uniqueKey, refuse } from "./application-structure-common";
import { placed, studioRecordDetailItem } from "./application-record-pages";
import { sourceNames } from "./composition-references";
import { studioQueryChoices } from "./contextual-palette";
import { syncStoredBlockDependencies } from "./stored-composition";

/** Writes the established record selection, Drawer and Record detail composition in one edit. */
export const ensureStudioRecordSheet = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  tableAlias: string,
): void => {
  const page = source.body.pages.find((page) =>
    sourcePageItems(page.composition).some((item) => item.props.id === tableAlias),
  );
  const target = placed(source, tableAlias);
  const query = studioQueryChoices(source, null).find(
    (query) => query.reference === target?.item.props.vortex.query,
  );
  if (page === undefined || target === undefined || query === undefined)
    return refuse("Choose the grid's data before adding its record side sheet.");
  if (
    typeof target.item.props.publishes_parameter !== "string" ||
    target.item.props.publishes_parameter.length === 0
  ) {
    const parameters = new Set([
      "record_id",
      ...sourcePageItems(page.composition).flatMap((item) =>
        typeof item.props.publishes_parameter === "string" ? [item.props.publishes_parameter] : [],
      ),
    ]);
    target.item.props.publishes_parameter = uniqueKey(`${tableAlias}_record`, "", parameters, 40);
  }
  source.body.flow_bindings = source.body.flow_bindings.filter(
    (binding) => binding.control !== tableAlias || binding.event !== "row_clicked",
  );
  if (
    sourcePageItems(page.composition).some(
      (item) => item.type === "platform.renderer.drawer" && item.props.open_with === tableAlias,
    )
  )
    return;
  const drawer = blockRelease(catalogue, PLATFORM_BLOCK_RELEASE_IDENTITIES.DRAWER_BLOCK_RELEASE);
  if (drawer === undefined) return refuse("The block catalogue has no Drawer block.");
  const taken = sourceNames(source);
  const alias = uniqueKey(`${tableAlias}_record_sheet`, "", taken, 140);
  taken.add(alias);
  const detailAlias = uniqueKey(`${alias}_detail`, "", taken, 160);
  target.siblings.splice(
    target.siblings.indexOf(target.item) + 1,
    0,
    blockItem(
      drawer,
      alias,
      {
        title: query.recordTypeLabel,
        open: false,
        placement: "right",
        size: "large",
        open_with: tableAlias,
      },
      {
        content: [
          studioRecordDetailItem(catalogue, source, query.recordType, detailAlias, tableAlias),
        ],
      },
    ),
  );
  syncStoredBlockDependencies(source);
};
