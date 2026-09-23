import {
  BOOLEAN_INPUT_BLOCK_RELEASE,
  BUTTON_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  CONTROL_BLOCK_RELEASES,
  DATE_INPUT_BLOCK_RELEASE,
  DIALOG_BLOCK_RELEASE,
  DRAWER_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  VALIDATION_MESSAGE_BLOCK_RELEASE,
} from "@vortex/contracts";
import {
  createPlatformComponentRegistry,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";
import { TextInput } from "./text-input";
import { NumberInput } from "./number-input";
import { BooleanInput } from "./boolean-input";
import { DateInput } from "./date-input";
import { ChoiceInput } from "./choice-input";
import { ValidationMessage } from "./validation-message";
import { Button } from "./button";
import { Tabs } from "./tabs";
import { Dialog } from "./dialog";
import { Drawer } from "./drawer";
import { FormContainer } from "./form-container";

/**
 * Release metadata is owned by the server-side platform block catalogue in @vortex/contracts;
 * these registrations only pair each registered release with its renderer, so a renderer
 * change cannot redefine or extend what authors may place.
 */
export {
  BOOLEAN_INPUT_BLOCK_RELEASE,
  BUTTON_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  CONTROL_BLOCK_RELEASES,
  DATE_INPUT_BLOCK_RELEASE,
  DIALOG_BLOCK_RELEASE,
  DRAWER_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  VALIDATION_MESSAGE_BLOCK_RELEASE,
};

/** Exact registrations pairing each control block release with its React renderer. */
export const CONTROL_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({ metadata: TEXT_INPUT_BLOCK_RELEASE, render: TextInput }),
    Object.freeze({ metadata: NUMBER_INPUT_BLOCK_RELEASE, render: NumberInput }),
    Object.freeze({ metadata: BOOLEAN_INPUT_BLOCK_RELEASE, render: BooleanInput }),
    Object.freeze({ metadata: DATE_INPUT_BLOCK_RELEASE, render: DateInput }),
    Object.freeze({ metadata: CHOICE_INPUT_BLOCK_RELEASE, render: ChoiceInput }),
    Object.freeze({ metadata: VALIDATION_MESSAGE_BLOCK_RELEASE, render: ValidationMessage }),
    Object.freeze({ metadata: BUTTON_BLOCK_RELEASE, render: Button }),
    Object.freeze({ metadata: TABS_BLOCK_RELEASE, render: Tabs }),
    Object.freeze({ metadata: DIALOG_BLOCK_RELEASE, render: Dialog }),
    Object.freeze({ metadata: DRAWER_BLOCK_RELEASE, render: Drawer }),
    Object.freeze({ metadata: FORM_CONTAINER_BLOCK_RELEASE, render: FormContainer }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with all control components. */
export function createControlComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(CONTROL_COMPONENT_REGISTRATIONS);
}
