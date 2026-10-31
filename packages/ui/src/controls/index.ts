// Per-Block Payload & Event Contracts
export {
  CONTROL_EVENT_NAMES,
  readControlData,
  parseControlEventHandlers,
  readRecordChoicePage,
  type BooleanInputPayload,
  type ButtonPayload,
  type ChoiceInputPayload,
  type ChoiceOption,
  type ControlDataState,
  type ControlEventHandler,
  type ControlEventHandlers,
  type ControlSemanticEvent,
  type ControlSemanticEventName,
  type DateInputPayload,
  type DialogPayload,
  type DrawerPayload,
  type FieldInputPayload,
  type FormPayload,
  type LinkInputPayload,
  type RecordChoiceOption,
  type RecordChoicePage,
  type NumberInputPayload,
  type RichTextInputPayload,
  type TabsPayload,
  type TextInputPayload,
  type TypedFieldValue,
  type TypedRecordReference,
  type TypedRichTextDocument,
  type ValidationPayload,
} from "./projected-data";
export { type ControlRenderProps } from "./control-context";

// Form & Action Control Components
export { TextInput, type TextInputProps } from "./text-input";
export { LinkInput, type LinkInputProps } from "./link-input";
export { RichTextInput, type RichTextInputProps } from "./rich-text-input";
export { NumberInput, type NumberInputProps } from "./number-input";
export { BooleanInput, type BooleanInputProps } from "./boolean-input";
export { DateInput, type DateInputProps } from "./date-input";
export { ChoiceInput, type ChoiceInputProps } from "./choice-input";
export { FieldInput, type FieldInputProps } from "./field-input";
export { ValidationMessage, type ValidationMessageProps } from "./validation-message";
export {
  FieldDraftFeedback,
  FormDraftFeedbackRegion,
  useFieldFeedback,
  type FormDraftFeedback,
  type FormDraftFeedbackFieldState,
  type FormDraftFeedbackMessage,
  type FormDraftFeedbackSummary,
  type FormDraftFeedbackSupply,
  type FormFieldDraftFeedback,
} from "./draft-feedback";
export { Button, type ButtonProps } from "./button";
export { Tabs, type TabsProps } from "./tabs";
export { Dialog, type DialogProps } from "./dialog";
export { Drawer, type DrawerProps } from "./drawer";
export { FormContainer, type FormContainerProps, type FormFlowFeedback } from "./form-container";
export { equalFormValue } from "./form-context";
export { UnsavedWorkProvider, useUnsavedWorkGuard, useUnsavedWorkRegistry } from "./unsaved-work";

// Control Registrations & Registry
export { CONTROL_COMPONENT_REGISTRATIONS } from "./registrations";
