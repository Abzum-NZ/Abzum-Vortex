import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  sourcePageItems,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import { blockItem, blockRelease, uniqueKey, refuse } from "./application-structure-common";
import { applyStudioFlowCreate } from "./application-flow-create";
import { placed, studioRecordDetailItem } from "./application-record-pages";
import { sourceNames } from "./composition-references";
import { studioQueryChoices } from "./contextual-palette";
import { syncStoredBlockDependencies } from "./stored-composition";

/** Writes a row-click flow that opens the ordinary Drawer and Record detail composition. */
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
  const existing = sourcePageItems(page.composition).find(
    (item) => item.type === "platform.renderer.drawer" && item.props.open_with === tableAlias,
  );
  let alias = existing?.props.id;
  if (alias === undefined) {
    const drawer = blockRelease(catalogue, PLATFORM_BLOCK_RELEASE_IDENTITIES.DRAWER_BLOCK_RELEASE);
    if (drawer === undefined) return refuse("The block catalogue has no Drawer block.");
    const taken = sourceNames(source);
    alias = uniqueKey(`${tableAlias}_record_sheet`, "", taken, 140);
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
  }
  syncStoredBlockDependencies(source);
  const binding = source.body.flow_bindings.find(
    (entry) => entry.control === tableAlias && entry.event === "row_clicked",
  );
  const boundFlow = source.body.flows.find((flow) => flow.key === binding?.flow);
  if (
    boundFlow?.tasks.some(
      (task) =>
        task.type === "interface.set_panel" &&
        task.properties.panel?.kind === "literal" &&
        task.properties.panel.literal.value === alias &&
        task.properties.state?.kind === "literal" &&
        task.properties.state.literal.value === "open",
    )
  )
    return;
  source.body.flow_bindings = source.body.flow_bindings.filter((entry) => entry !== binding);
  const result = applyStudioFlowCreate(
    source,
    {
      kind: "control",
      controlAlias: tableAlias,
      event: "row_clicked",
      name: `Open ${query.recordTypeLabel} side sheet`.slice(0, 100),
      description: `Opens the record side sheet for the clicked ${query.recordTypeLabel}.`,
      inputs: {},
      outputs: {},
      bindingInputs: {},
      tasks: [
        {
          id: "open_panel",
          type: "interface.set_panel",
          version: "1.0.0",
          properties: {
            panel: { kind: "literal", literal: { type: "text", value: alias } },
            state: { kind: "literal", literal: { type: "text", value: "open" } },
          },
        },
      ],
    },
    null,
  );
  if (result.kind === "refused")
    return refuse(`The side sheet's Open panel flow could not be made: ${result.reason}`);
  source.body = result.source.body;
};
