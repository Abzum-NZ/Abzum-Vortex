import {
  sourceItemChildSlots,
  sourceItemTree,
  type SourceItem,
} from "../application-composition/source-composition";
import type { ApplicationSourceDocument } from "../application-source-contracts";
import type { ImmutablePlatformBlockCatalogue } from "../application-composition/platform-block-release";
import { studioFlowLabel } from "./semantic-selection";
import type { StudioPlacementReference } from "./composition-references";
import { releaseFor } from "./application-composition-regions";

/**
 * What a form needs from every edit of the content around it, whichever command makes the edit
 * (Inspector Remove and Move, canvas Delete and drag, Add, Wrap):
 * - forms never nest;
 * - an input, and a Submit or Reset button, keeps the form that encloses it; one outside any
 *   form (just added at the page's top level) may join a form;
 * - a form that stays keeps its inputs for required fields without a default value, inputs marked
 *   Required, and inputs whose answers its submit binding maps by name into a flow. A required
 *   field with a default is filled by it when its input is left out.
 */
export const FORM_CONTAINER_KEY = "platform.form.container";
export const NESTED_FORM_REASON = "A form can't go inside another form.";
const FORM_CONTEXT_REASON =
  "An input, a Submit button or a Reset button stays inside the form it belongs to.";

type FormShapeRefusal = Readonly<{ reason: "nested_form" | "form_context" }>;
type StudioFormChangeRefusal = StudioPlacementReference | FormShapeRefusal;

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
      // The slots are read from the props alone, as `holdsForm` reads them: nothing here needs
      // the block's settings checked, and checking them for every block made a move or a delete
      // cost a validation of the whole content area.
      for (const [, children] of sourceItemChildSlots(item))
        visit(children, isForm ? item.props.id : form);
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
          field.required &&
          !("default" in field && field.default !== undefined) &&
          item.props.field === `${module.key}:${record.key}.${field.key}`,
      ),
    ),
  );

/**
 * Caller names a form submission fills from the whole form, never from the answer of that name
 * (the private form submit adapter): `values` takes every answer, the owner group its own choice.
 */
const wholeFormCallerNames: ReadonlySet<unknown> = new Set(["values", "selected_owner_group_id"]);

/** The flow a form's submit binding feeds with this answer, by name, if one does. */
const mappingFlow = (
  source: ApplicationSourceDocument,
  form: string,
  name: unknown,
): StudioPlacementReference | undefined => {
  if (wholeFormCallerNames.has(name)) return undefined;
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
    const left = lostInputRefusal(catalogue, source, was, alias, now.blocks.has(form ?? ""));
    if (left !== undefined) return left;
  }
  return undefined;
};

/**
 * The field keys the inputs of the form that holds `alias` already show, other than `alias` itself:
 * one form holds one input per field (the platform's `definition_form_field_duplicate`). A guided
 * form page is one form, so every input of the page counts. Outside any form nothing is in use.
 */
export const studioFormFieldsInUse = (
  catalogue: ImmutablePlatformBlockCatalogue,
  items: readonly SourceItem[],
  alias: string,
  guidedFormPage: boolean,
): ReadonlySet<string> => {
  const { enclosing, blocks } = formsOf(catalogue, items);
  const form = enclosing.get(alias);
  const used = new Set<string>();
  if (form === undefined && !guidedFormPage) return used;
  for (const [other, item] of blocks) {
    if (other === alias || enclosing.get(other) !== form || !isFormInput(keyOf(catalogue, item)))
      continue;
    const name = answerName(item);
    if (typeof name === "string") used.add(name);
  }
  return used;
};

/** The forms of one content area's blocks, read once for every block's removal check. */
export const studioRegionForms = formsOf;

/**
 * What leaving `alias` out takes from a form that stays: an input for a required field, or one
 * the form's submit binding maps into a flow. A form that leaves takes its inputs and its own
 * bindings with it. `formStays` says whether the enclosing form is still in the content area.
 */
const lostInputRefusal = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  was: ReturnType<typeof formsOf>,
  alias: string,
  formStays: boolean,
): StudioPlacementReference | undefined => {
  const form = was.enclosing.get(alias);
  const item = was.blocks.get(alias)!;
  if (form === undefined || !formStays || !isFormInput(keyOf(catalogue, item))) return undefined;
  if (requiredInput(source, item)) return { reason: "required_field" };
  return mappingFlow(source, form, answerName(item));
};

/**
 * Why removing `item` and everything inside it breaks a form of the content area `was` describes,
 * or undefined: the same check as `studioFormChangeRefusal` for one removal, without building the
 * content area that is left.
 */
export const studioRemovalFormRefusal = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  was: ReturnType<typeof formsOf>,
  removed: ReadonlySet<string>,
): StudioFormChangeRefusal | undefined => {
  for (const alias of was.blocks.keys()) {
    if (!removed.has(alias)) continue;
    const form = was.enclosing.get(alias);
    const left = lostInputRefusal(
      catalogue,
      source,
      was,
      alias,
      form !== undefined && !removed.has(form),
    );
    if (left !== undefined) return left;
  }
  return undefined;
};
