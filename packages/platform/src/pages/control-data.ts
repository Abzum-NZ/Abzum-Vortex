import "server-only";

import {
  attachmentInputPayloadSchema,
  booleanInputPayloadSchema,
  buttonPayloadSchema,
  choiceInputPayloadSchema,
  dateInputPayloadSchema,
  dateTimeInputPayloadSchema,
  dialogPayloadSchema,
  drawerPayloadSchema,
  formPayloadSchema,
  linkInputPayloadSchema,
  numberInputPayloadSchema,
  richTextInputPayloadSchema,
  severalChoicesInputPayloadSchema,
  tableInputPayloadSchema,
  tabsPayloadSchema,
  textInputPayloadSchema,
  validationPayloadSchema,
} from "./control-payload";
import { isRecord } from "../catalogue/runtime-primitives";

/** Each control payload's contract, by the `kind` the payload names. */
const CONTROL_PAYLOAD_CONTRACTS = Object.freeze({
  attachment_input: attachmentInputPayloadSchema,
  boolean_input: booleanInputPayloadSchema,
  button: buttonPayloadSchema,
  choice_input: choiceInputPayloadSchema,
  date_input: dateInputPayloadSchema,
  date_time_input: dateTimeInputPayloadSchema,
  dialog: dialogPayloadSchema,
  drawer: drawerPayloadSchema,
  form: formPayloadSchema,
  link_input: linkInputPayloadSchema,
  number_input: numberInputPayloadSchema,
  rich_text_input: richTextInputPayloadSchema,
  several_choices_input: severalChoicesInputPayloadSchema,
  table_input: tableInputPayloadSchema,
  tabs: tabsPayloadSchema,
  text_input: textInputPayloadSchema,
  validation: validationPayloadSchema,
});

/** Whether a ready payload is a control's: it names one of the control kinds. */
export const isControlPayload = (values: unknown): boolean =>
  isRecord(values) &&
  typeof values.kind === "string" &&
  Object.hasOwn(CONTROL_PAYLOAD_CONTRACTS, values.kind);

/** A control's ready state, or why its payload was not published. */
export type ControlDataPublication =
  Readonly<{ status: "ready"; values: unknown }> | Readonly<{ status: "disabled"; reason: string }>;

/**
 * A control's ready state as the server publishes it: its values checked once against the contract
 * of the control kind they name, where they are built, so the renderer renders them without parsing
 * them again. A payload that fails its contract is a defect: `log` receives the cause (the issue's
 * path and message, never a value) and the control shows as unavailable.
 */
export const readyControlData = (
  values: unknown,
  log: (cause: string) => void,
): ControlDataPublication => {
  const kind = isRecord(values) && typeof values.kind === "string" ? values.kind : undefined;
  const contract =
    kind !== undefined && Object.hasOwn(CONTROL_PAYLOAD_CONTRACTS, kind)
      ? CONTROL_PAYLOAD_CONTRACTS[kind as keyof typeof CONTROL_PAYLOAD_CONTRACTS]
      : undefined;
  if (contract === undefined) {
    log(`control payload kind unknown: ${kind ?? "none"}`);
    return { status: "disabled", reason: "This field is unavailable" };
  }
  const checked = contract.safeParse(values);
  if (checked.success) return { status: "ready", values: checked.data };
  const issue = checked.error.issues[0];
  log(`${kind} ${(issue?.path ?? []).map(String).join(".")}: ${issue?.message ?? "invalid"}`);
  return { status: "disabled", reason: "This field is unavailable" };
};
