import {
  sourceItemTree,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
} from "@vortex/platform/schema";
import { studioFlowLabel } from "./semantic-selection";
import type { StudioPlacementReference } from "./composition-references";
import { releaseFor, itemSlots } from "./application-composition-regions";

/**
 * What a form needs from every edit of the content around it, whichever command makes the edit
 * (Inspector Remove and Move, canvas Delete and drag, Add, Wrap):
 * - forms never nest;
 * - an input, and a Submit or Reset button, keeps the form that encloses it; one outside any
 *   form (just added at the page's top level) may join a form;
 * - a form that stays keeps its inputs for required fields, inputs marked Required, and inputs
 *   whose answers its submit binding maps by name into a flow.
 */
export const FORM_CONTAINER_KEY = "platform.form.container";
export const NESTED_FORM_REASON = "A form can't go inside another form.";
const FORM_CONTEXT_REASON =
  "An input, a Submit button or a Reset button stays inside the form it belongs to.";

type FormShapeRefusal = Readonly<{ reason: "nested_form" | "form_context" }>;
export type StudioFormChangeRefusal = StudioPlacementReference | FormShapeRefusal;

/** A refusal about where blocks sit, not about what removing them leaves behind. */
export const studioFormShapeRefusal = (
  refusal: StudioFormChangeRefusal,
): refusal is FormShapeRefusal =>
  refusal.reason === "nested_form" || refusal.reason === "form_context";

/** Why an edit breaks a form, as a sentence a person can act on. */
export const studioFormChangeRefusalSentence = (
  refusal: StudioFormChangeRefusal,
  sentence: (reference: StudioPlacementReference) => string,
): string =>
  !studioFormShapeRefusal(refusal)
    ? sentence(refusal)
    : refusal.reason === "nested_form"
      ? NESTED_FORM_REASON
      : FORM_CONTEXT_REASON;

const keyOf = (catalogue: ImmutablePlatformBlockCatalogue, item: SourceItem) =>
  releaseFor(catalogue, item)?.key;

const isFormInput = (key: string | undefined): boolean =>
  key?.startsWith("platform.form.") === true && key.endsWith("_input");

/** Whether any of these items, or anything inside them, is a form. */
export const holdsForm = (
  catalogue: ImmutablePlatformBlockCatalogue,
  items: readonly SourceItem[],
): boolean => sourceItemTree(items).some((item) => keyOf(catalogue, item) === FORM_CONTAINER_KEY);

/** An input, or a Submit or Reset button: a block that only works inside its form. */
const belongsToForm = (catalogue: ImmutablePlatformBlockCatalogue, item: SourceItem): boolean => {
  const key = keyOf(catalogue, item);
  return (
    isFormInput(key) ||
    (key === "platform.action.button" &&
      (item.props.action_kind === "submit" || item.props.action_kind === "reset"))
  );
};

/** Each block's enclosing form, and whether any form sits inside another. */
const formsOf = (catalogue: ImmutablePlatformBlockCatalogue, items: readonly SourceItem[]) => {
  const enclosing = new Map<string, string | undefined>();
  const blocks = new Map<string, SourceItem>();
  let nested = false;
  const visit = (zone: readonly SourceItem[], form: string | undefined): void => {
    for (const item of zone) {
      const isForm = keyOf(catalogue, item) === FORM_CONTAINER_KEY;
      if (isForm && form !== undefined) nested = true;
      enclosing.set(item.props.id, form);
      blocks.set(item.props.id, item);
      for (const slot of itemSlots(catalogue, item).values())
        visit(slot.items, isForm ? item.props.id : form);
    }
  };
  visit(items, undefined);
  return { enclosing, blocks, nested };
};

/** The answer name an input submits: an automatic input answers under its field key. */
const answerName = (item: SourceItem): unknown => {
  const field = item.props.field;
  return typeof field === "string" ? field.slice(field.lastIndexOf(".") + 1) : item.props.name;
};

const requiredInput = (source: ApplicationSourceDocument, item: SourceItem): boolean =>
  item.props.required === true ||
  source.body.modules.some((module) =>
    module.record_types.some((record) =>
      record.fields.some(
        (field) =>
          field.required && item.props.field === `${module.key}:${record.key}.${field.key}`,
      ),
    ),
  );

/** The flow a form's submit binding feeds with this answer, by name, if one does. */
const mappingFlow = (
  source: ApplicationSourceDocument,
  form: string,
  name: unknown,
): StudioPlacementReference | undefined => {
  const binding = source.body.flow_bindings.find(
    (candidate) =>
      candidate.control === form &&
      Object.values(candidate.inputs).some(
        (input) =>
          typeof input === "object" &&
          input !== null &&
          "kind" in input &&
          input.kind === "caller" &&
          input.name === name,
      ),
  );
  if (binding === undefined) return undefined;
  const flow = [
    ...source.body.flows,
    ...source.body.modules.flatMap((module) => module.flows),
  ].find((candidate) => candidate.id === binding.flow || candidate.key === binding.flow);
  return flow === undefined
    ? { reason: "flow_input" }
    : { reason: "flow_input", flow: studioFlowLabel(flow) };
};

/**
 * Why replacing one content area's blocks `before` with `after` breaks a form, or undefined when
 * every form keeps what it needs. `source` is the draft the edit starts from.
 */
export const studioFormChangeRefusal = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  before: readonly SourceItem[],
  after: readonly SourceItem[],
): StudioFormChangeRefusal | undefined => {
  const was = formsOf(catalogue, before);
  const now = formsOf(catalogue, after);
  if (now.nested) return { reason: "nested_form" };
  for (const [alias, item] of was.blocks) {
    const form = was.enclosing.get(alias);
    if (now.blocks.has(alias)) {
      if (form !== undefined && belongsToForm(catalogue, item) && now.enclosing.get(alias) !== form)
        return { reason: "form_context" };
      continue;
    }
    // A form that leaves takes its inputs and its own bindings with it.
    if (form === undefined || !now.blocks.has(form) || !isFormInput(keyOf(catalogue, item)))
      continue;
    if (requiredInput(source, item)) return { reason: "required_field" };
    const mapped = mappingFlow(source, form, answerName(item));
    if (mapped !== undefined) return mapped;
  }
  return undefined;
};
