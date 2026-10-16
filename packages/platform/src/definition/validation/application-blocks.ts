import {
  type DefinitionRuleFailure,
  type ApplicationSourceDocument,
  type SourceItem,
  builderKeySchema,
  sourceItemChildSlots,
  sourceItemTree,
  sourcePageItems,
} from "../../schema";
import {
  type PreparedValidationContext,
  editSaveSources,
  parseEditSaveSource,
  isApplicationSource,
  registeredBlockReleases,
} from "./context";
import { object, array } from "./helpers";

type PlacedApplicationBlock = Readonly<{ item: SourceItem; pageType: string | undefined }>;

/**
 * Every block placed in an Application source by its application-unique alias: shell layouts,
 * page content and guided-form step content at any depth, with the type of the page that places
 * it (none for a shell).
 */
const placedApplicationBlocks = (
  body: ApplicationSourceDocument["body"],
): ReadonlyMap<string, PlacedApplicationBlock> => {
  const placed = new Map<string, PlacedApplicationBlock>();
  for (const shell of body.shells)
    for (const item of sourceItemTree(shell.layout.content))
      placed.set(item.props.id, { item, pageType: undefined });
  for (const page of body.pages)
    for (const item of sourcePageItems(page.composition))
      placed.set(item.props.id, { item, pageType: page.type });
  return placed;
};

/**
 * Refuses, at draft save and again before publication compiles, a flow binding whose event the
 * bound placement's registered release does not declare. An unknown placement or unregistered
 * release is refused by the reference and catalogue rules instead.
 */
export function applicationFlowBindingEventRule(
  context: PreparedValidationContext,
): DefinitionRuleFailure[] {
  return editSaveSources(context).flatMap((raw, index): DefinitionRuleFailure[] => {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(raw);
    if (!parsed.success || !isApplicationSource(parsed.data)) return [];
    const source = parsed.data as ApplicationSourceDocument;
    const body = object(source.body);
    const placedBlocks = placedApplicationBlocks(source.body);
    const failures: DefinitionRuleFailure[] = [];
    for (const binding of array(body.flow_bindings)) {
      const placed = placedBlocks.get(String(binding.control));
      const block = placed?.item.props.vortex.block;
      const release = block
        ? registeredBlockReleases.get(`${String(block.block_id)}:${String(block.release_version)}`)
        : undefined;
      if (release === undefined || release.supportedEvents.some((event) => event === binding.event))
        continue;
      const bindingKey = builderKeySchema.safeParse(binding.id);
      const bindingSegment = bindingKey.success
        ? [{ kind: "flow_binding" as const, key: bindingKey.data }]
        : [];
      failures.push({
        ruleCode: "vortex.definition.application_flow_binding_event",
        family: "unsupported_choice",
        location: {
          documentKind: "application",
          documentKey: source.key,
          segments: [{ kind: "application", key: source.key }, ...bindingSegment],
        },
      });
    }
    return failures;
  });
}

/** Block keys whose placements carry a control that submits or acts. */
const formContainerBlockKey = "platform.form.container";

const actionButtonBlockKey = "platform.action.button";

/**
 * One authored plain block setting of the given JSON type, read as the renderer reads it: a value
 * of any other type is not that setting, so a button's action kind falls back to its `action`
 * default.
 */
const sourceBlockSetting = (
  item: SourceItem,
  key: string,
  type: "string" | "boolean",
): unknown => {
  const setting: unknown = item.props[key];
  return typeof setting === type ? setting : undefined;
};

/** The registered key of an item's exact block release, or undefined for an unknown release. */
const sourceBlockKey = (item: SourceItem): string | undefined => {
  const block = item.props.vortex.block;
  return registeredBlockReleases.get(`${block.block_id}:${block.release_version}`)?.key;
};

/** A button's authored action kind, `action` when it declares none. */
const sourceButtonActionKind = (item: SourceItem): unknown =>
  sourceBlockSetting(item, "action_kind", "string") ?? "action";

/** Whether a form container holds, at any depth, a button that submits the enclosing form. */
const containsSubmitButton = (item: SourceItem): boolean =>
  sourceItemChildSlots(item).some(([, children]) =>
    children.some(
      (child) =>
        (sourceBlockKey(child) === actionButtonBlockKey &&
          sourceButtonActionKind(child) === "submit") ||
        containsSubmitButton(child),
    ),
  );

/**
 * Refuses, before an Application publishes, a control that would render enabled but run nothing.
 * A form container with a submit path needs a `form_submit` binding: it holds a Submit button at
 * any depth, or it sits on a form or guided-form page. An action button needs an `action` binding
 * unless its `disabled` setting is the literal `true`.
 *
 * Presentation-only is derived, never marked: a form container with no submit path only collects
 * the inputs an action button in it passes to that button's bound flow. Its one other submission,
 * Enter in a field, emits a `form_submit` with no binding, which runs nothing and commits nothing,
 * so it cannot carry an unbound commit. A submit or reset button outside a form container is
 * refused when it renders. A button without a choice-valued action kind is judged as an action
 * button, the renderer's default.
 */
export function applicationControlBindingRule(
  context: PreparedValidationContext,
): DefinitionRuleFailure[] {
  return editSaveSources(context).flatMap((raw, index): DefinitionRuleFailure[] => {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(raw);
    if (!parsed.success || !isApplicationSource(parsed.data)) return [];
    const source = parsed.data as ApplicationSourceDocument;
    const body = object(source.body);
    const boundEvents = new Map<string, Set<string>>();
    for (const binding of array(body.flow_bindings)) {
      const control = String(binding.control);
      const events = boundEvents.get(control) ?? new Set<string>();
      events.add(String(binding.event));
      boundEvents.set(control, events);
    }
    const failures: DefinitionRuleFailure[] = [];
    for (const [alias, { item: placement, pageType }] of placedApplicationBlocks(source.body)) {
      const blockKey = sourceBlockKey(placement);
      const bound = boundEvents.get(alias) ?? new Set<string>();
      const unbound =
        blockKey === formContainerBlockKey
          ? (containsSubmitButton(placement) ||
              pageType === "form" ||
              pageType === "guided_form") &&
            !bound.has("form_submit")
          : blockKey === actionButtonBlockKey &&
            sourceButtonActionKind(placement) !== "submit" &&
            sourceButtonActionKind(placement) !== "reset" &&
            sourceBlockSetting(placement, "disabled", "boolean") !== true &&
            !bound.has("action");
      if (!unbound) continue;
      const placementKey = builderKeySchema.safeParse(alias);
      failures.push({
        ruleCode: "vortex.definition.application_control_binding",
        family: "required_value",
        location: {
          documentKind: "application",
          documentKey: source.key,
          segments: [
            { kind: "application", key: source.key },
            ...(placementKey.success ? [{ kind: "block" as const, key: placementKey.data }] : []),
          ],
        },
      });
    }
    return failures;
  });
}
