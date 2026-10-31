import {
  changeableByPeople,
  defaultSaveFlowSource,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  sourcePageItems,
  sourcePageZones,
  type DefaultFlowAfter,
} from "@vortex/platform/schema";
import {
  fieldsPerStep,
  inputTypes,
  listing,
  lowerFirst,
  type StudioRecordPageCommand,
} from "./application-record-page-kinds";
import { bindDefault, flowCreate, freshAlias, type Plan } from "./application-record-plan";
import {
  companions,
  field,
  openButton,
  opensAny,
  recordTables,
  release,
  type Field,
  type Resolved,
} from "./application-record-page-shared";
import {
  blockItem,
  judged,
  pageData,
  placeNewPage,
  quoted,
  refuse,
  uniqueKey,
  type Page,
  type StudioStructureContext,
} from "./application-structure-common";

const formFields = (
  resolved: Resolved,
  mode: "create" | "update",
): Readonly<{ fields: Field[]; left: string[] }> => {
  const changeable = resolved.fieldAccess(mode, "changeable_fields");
  const editable = resolved.record.fields.filter((entry) => changeableByPeople(entry));
  for (const entry of editable.filter((candidate) => candidate.required)) {
    if (!changeable.has(entry.key))
      refuse(
        `${quoted(entry.label)} is required, and the ${mode} permission of ${quoted(resolved.record.name)} does not let people change it, so a form cannot save ${resolved.record.plural_name.toLowerCase()}. Add it to that permission's changeable fields in Access first.`,
      );
    if (!inputTypes.has(entry.type))
      refuse(
        `${quoted(entry.label)} is required, and no form input exists for ${entry.type.replaceAll("_", " ")} fields, so a form cannot save ${resolved.record.plural_name.toLowerCase()}. Make it optional or change its type in Data first.`,
      );
  }
  const fields = editable.filter(
    (entry) => changeable.has(entry.key) && inputTypes.has(entry.type),
  );
  if (fields.length === 0)
    refuse(
      `${resolved.record.plural_name} have no field people can fill in under the ${mode} permission, so a form has nothing to ask.`,
    );
  const left = [
    ...editable
      .filter((entry) => !changeable.has(entry.key))
      .map((entry) => `${entry.label} (not changeable under the ${mode} permission)`),
    ...editable
      .filter((entry) => changeable.has(entry.key) && !inputTypes.has(entry.type))
      .map((entry) => `${entry.label} (no form input draws it)`),
  ];
  return { fields, left };
};

/** The Save flow of a form: the default Save, then opening the saved record's detail or the list. */
const saveFlow = (
  plan: Plan,
  resolved: Resolved,
  mode: "create" | "update",
  form: string,
  guidedDraft?: true,
) => {
  const found = companions(plan.source, resolved.qualified);
  const next = found.detail ?? found.list[0];
  const after: DefaultFlowAfter =
    next === undefined
      ? { kind: "none" }
      : { kind: "navigate", page: next.key, withRecord: next === found.detail };
  plan.details.push(
    next === undefined
      ? `After saving, the form stays open: ${resolved.record.plural_name.toLowerCase()} have no detail or list page yet.`
      : `After saving, it opens ${quoted(next.name)}${next === found.detail ? ` with the saved ${lowerFirst(resolved.record.name)}` : ""}.`,
  );
  return defaultSaveFlowSource({
    id: "save",
    key: "save",
    recordType: resolved.qualified,
    mode,
    ownershipMode: resolved.record.ownership_mode as
      "none" | "organization_account" | "group" | "inherited",
    form,
    after,
    ...(guidedDraft === undefined ? {} : { guidedDraft }),
  });
};

/** A readable-width frame holding one form of field inputs and its submit button. */
const formBlock = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  title: string,
  fields: readonly Field[],
  submit: string,
) => {
  const formAlias = freshAlias(plan, `form_${uniqueKey(title, "", new Set(), 40)}`);
  const inputs = fields.map((entry) =>
    blockItem(
      release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.FIELD_INPUT_BLOCK_RELEASE, "field input"),
      freshAlias(plan, `input_${resolved.record.key}_${entry.key}`),
      { field: field(resolved, entry) },
      {},
    ),
  );
  const button = blockItem(
    release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.BUTTON_BLOCK_RELEASE, "button"),
    freshAlias(plan, `submit_${formAlias}`),
    { label: submit, action_kind: "submit", variant: "primary" },
    {},
  );
  const form = blockItem(
    release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE, "form"),
    formAlias,
    { title },
    { content: [...inputs, button] },
  );
  const frame = blockItem(
    release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.CONTAINER_BLOCK_RELEASE, "container"),
    freshAlias(plan, `${formAlias}_frame`),
    { direction: "column", gap: "medium", padding: "medium", content_width: "readable" },
    { content: [form] },
  );
  return { frame, formAlias };
};

export const addForm = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  command: StudioRecordPageCommand,
  mode: "create" | "update",
) => {
  const { record } = resolved;
  const { fields, left } = formFields(resolved, mode);
  const name = `${mode === "create" ? "New" : "Edit"} ${lowerFirst(record.name)}`.slice(0, 60);
  const { frame, formAlias } = formBlock(context, plan, resolved, name, fields, "Save");
  const placedPage = placeNewPage(
    plan.source,
    name,
    {
      type: "form",
      record_type: resolved.qualified,
      permission: resolved.permission(
        plan.source,
        mode === "create" ? "create" : "update",
        plan.details,
      ),
    },
    pageData(context, plan.source, command.shellAlias, [frame], name),
    command.addToMenu,
  );
  plan.source = judged(placedPage.source);
  plan.details.unshift(
    `A page ${quoted(name)}, for people who can ${mode === "create" ? "create" : "change"} ${record.plural_name.toLowerCase()}${command.addToMenu ? ", with a menu entry" : ""}.`,
  );
  plan.details.push(
    `A form asks for ${listing(fields.map((entry) => entry.label))}, with a Save button.`,
  );
  if (left.length > 0) plan.details.push(`Left out: ${listing(left)}.`);
  const flowName =
    mode === "create"
      ? `Save new ${lowerFirst(record.name)}`
      : `Save ${lowerFirst(record.name)} changes`;
  const save = saveFlow(plan, resolved, mode, formAlias);
  bindDefault(
    plan,
    formAlias,
    "form_submit",
    {
      ...save,
      description:
        mode === "create"
          ? `Saves a new ${lowerFirst(record.name)} from ${quoted(name)}.`
          : `Saves the changes to one ${lowerFirst(record.name)} from ${quoted(name)}.`,
    },
    flowName,
  );
  plan.details.push(
    `Submitting the form runs the flow ${quoted(flowName)}: it checks the form, saves the ${lowerFirst(record.name)}, says "Saved" and opens the next page.`,
  );
  linkFormBack(context, plan, resolved, placedPage.page, mode);
  return placedPage.page;
};

/** A new create form gets a New button on each list of the record type; a new edit form an Edit button on its detail page. */
const linkFormBack = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  page: Page,
  mode: "create" | "update",
) => {
  const found = companions(plan.source, resolved.qualified);
  if (mode === "create") {
    for (const listId of found.list.map((entry) => entry.id)) {
      // Each button's flow-create replaces the draft, so the list page is read again from the current one.
      const list = plan.source.body.pages.find((entry) => entry.id === listId)!;
      if (
        opensAny(
          plan.source,
          list,
          plan.source.body.pages
            .filter(
              (entry) =>
                entry.id !== page.id &&
                (entry.type === "form" || entry.type === "guided_form") &&
                "record_type" in entry &&
                entry.record_type === resolved.qualified,
            )
            .map((entry) => entry.key),
        )
      )
        continue;
      const table = recordTables(plan.source, list, resolved)[0];
      const label = `New ${lowerFirst(resolved.record.name)}`;
      const data = list.composition as unknown as Parameters<typeof sourcePageZones>[0];
      const zone =
        sourcePageZones(data).find(([, items]) => items.length > 0)?.[1] ??
        sourcePageZones(data).at(-1)![1];
      openButton(
        context,
        plan,
        label,
        resolved.permission(plan.source, "create", plan.details),
        page,
        undefined,
        table === undefined ? { items: zone } : { beside: table.props.id },
      );
      plan.details.push(`A ${quoted(label)} button on ${quoted(list.name)} opens this form.`);
    }
    return;
  }
  const detail = found.detail;
  if (detail === undefined) {
    plan.details.push(
      `Nothing opens this form yet: ${resolved.record.plural_name.toLowerCase()} have no detail page. Adding one puts an Edit button there.`,
    );
    return;
  }
  if (opensAny(plan.source, detail, [page.key])) return;
  const shown = sourcePageItems(detail.composition).find(
    (item) => String(item.type) === "platform.renderer.record_detail",
  );
  const data = detail.composition as unknown as Parameters<typeof sourcePageZones>[0];
  openButton(
    context,
    plan,
    "Edit",
    resolved.permission(plan.source, "update", plan.details),
    page,
    resolved,
    shown === undefined
      ? {
          items:
            sourcePageZones(data).find(([, items]) => items.length > 0)?.[1] ??
            sourcePageZones(data).at(-1)![1],
        }
      : { beside: shown.props.id },
  );
  plan.details.push(
    `An ${quoted("Edit")} button on ${quoted(detail.name)} opens this form with the shown ${lowerFirst(resolved.record.name)}.`,
  );
};

export const addGuided = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  command: StudioRecordPageCommand,
) => {
  const { record } = resolved;
  const { fields, left } = formFields(resolved, "create");
  if (left.length > 0) plan.details.push(`Left out: ${listing(left)}.`);
  const name = `New ${lowerFirst(record.name)} step by step`.slice(0, 60);
  const chunks: Field[][] = [];
  for (let index = 0; index < fields.length; index += fieldsPerStep)
    chunks.push(fields.slice(index, index + fieldsPerStep));
  if (chunks.length + 1 > 20)
    refuse(`${record.plural_name} have too many fields for a guided form of at most 20 steps.`);
  const steps = [
    ...chunks.map((chunk, index) => ({
      id: freshAlias(plan, `step_${record.key}_${index + 1}`),
      name: `Step ${index + 1} of ${chunks.length + 1}`,
      summary: false,
      chunk,
    })),
    {
      id: freshAlias(plan, `step_${record.key}_check`),
      name: "Check and save",
      summary: true,
      chunk: [] as Field[],
    },
  ];
  const forms = steps.map((step) =>
    step.summary
      ? (() => {
          const formAlias = freshAlias(plan, `form_${record.key}_check`);
          const button = blockItem(
            release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.BUTTON_BLOCK_RELEASE, "button"),
            freshAlias(plan, `submit_${formAlias}`),
            { label: "Save", action_kind: "submit", variant: "primary" },
            {},
          );
          const form = blockItem(
            release(
              context,
              PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE,
              "form",
            ),
            formAlias,
            { title: `Check and save the ${lowerFirst(record.name)}` },
            { content: [button] },
          );
          return { frame: form, formAlias };
        })()
      : formBlock(
          context,
          plan,
          resolved,
          `${name}: ${step.name.toLowerCase()}`.slice(0, 120),
          step.chunk,
          "Continue",
        ),
  );
  const composition = {
    step_content: Object.fromEntries(
      steps.map((step, index) => [
        step.id,
        pageData(context, plan.source, command.shellAlias, [forms[index]!.frame], name),
      ]),
    ),
  };
  const placedPage = placeNewPage(
    plan.source,
    name,
    {
      type: "guided_form",
      record_type: resolved.qualified,
      permission: resolved.permission(plan.source, "create", plan.details),
      steps: steps.map(({ id, name: stepName, summary }) => ({ id, name: stepName, summary })),
    },
    composition,
    command.addToMenu,
  );
  plan.source = judged(placedPage.source);
  plan.details.unshift(
    `A guided page ${quoted(name)}, for people who can create ${record.plural_name.toLowerCase()}${command.addToMenu ? ", with a menu entry" : ""}.`,
  );
  for (const step of steps.filter((entry) => !entry.summary))
    plan.details.push(
      `${step.name} asks for ${listing(step.chunk.map((entry) => entry.label))}, with a Continue button.`,
    );
  plan.details.push("The last step, Check and save, shows the answers with a Save button.");
  const flowName = `Save new ${lowerFirst(record.name)}`;
  const summary = forms.at(-1)!.formAlias;
  const save = saveFlow(plan, resolved, "create", summary, true);
  bindDefault(
    plan,
    summary,
    "form_submit",
    {
      ...save,
      description: `Saves a new ${lowerFirst(record.name)} from ${quoted(name)}, once, then removes the draft.`,
    },
    flowName,
  );
  for (const [index, form] of forms.slice(0, -1).entries())
    flowCreate(
      plan,
      {
        kind: "action",
        controlAlias: form.formAlias,
        name: `${name}: ${steps[index]!.name.toLowerCase()}`.slice(0, 100),
        recordType: null,
        event: "guided_step_changed",
      },
      `The step change of ${quoted(steps[index]!.name)}`,
    );
  const cancel = flowCreate(
    plan,
    {
      kind: "action",
      controlAlias: forms[0]!.formAlias,
      name: `Cancel ${name}`.slice(0, 100),
      recordType: null,
      event: "form_cancel",
    },
    `The cancel of ${quoted(name)}`,
  );
  for (const form of forms.slice(1))
    flowCreate(
      plan,
      {
        kind: "bind",
        controlAlias: form.formAlias,
        event: "form_cancel",
        flowKey: cancel.flowKey,
        bindingInputs: {
          draft_id: { kind: "caller", name: "draft_id" },
          revision: { kind: "caller", name: "revision" },
        },
      },
      `The cancel of ${quoted(name)}`,
    );
  plan.details.push(
    `Each step saves its answers to the person's own draft and opens the next step; Check and save runs ${quoted(flowName)}, which saves once and removes the draft. Cancel removes the draft.`,
  );
  linkFormBack(context, plan, resolved, placedPage.page, "create");
  return placedPage.page;
};

/** Adds the page of one kind for a record type, with everything it needs, as one draft edit. */
