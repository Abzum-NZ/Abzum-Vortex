import { platformBlockReleaseV2Schema, type PlatformBlockReleaseV2 } from "@vortex/contracts";
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

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

const release = (definition: unknown): PlatformBlockReleaseV2 =>
  deepFreeze(platformBlockReleaseV2Schema.parse(definition));

/** Exact immutable metadata release for text input block. */
export const TEXT_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  "blockId": "b101c51a-7b56-4cf2-8321-c42a5ea79d01",
  "key": "platform.form.text_input",
  "releaseVersion": "1.0.0",
  "name": "Text input",
  "icon": "type",
  "paletteGroup": "input",
  "rendererKey": "platform.renderer.text_input",
  "properties": [
    {
      "kind": "text",
      "key": "name",
      "label": "Field name",
      "help": "Field key emitted in field_changed event",
      "required": true,
      "minLength": 1,
      "maxLength": 60
    },
    {
      "kind": "text",
      "key": "label",
      "label": "Label",
      "help": "Accessible name and visual field label",
      "required": true,
      "minLength": 1,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "placeholder",
      "label": "Placeholder",
      "help": "Placeholder hint text",
      "required": false,
      "minLength": 0,
      "maxLength": 200
    },
    {
      "kind": "text",
      "key": "help_text",
      "label": "Help text",
      "help": "Descriptive help text below the input",
      "required": false,
      "minLength": 0,
      "maxLength": 500
    },
    {
      "kind": "boolean",
      "key": "required",
      "label": "Required",
      "help": "Whether the field is required",
      "required": false
    },
    {
      "kind": "boolean",
      "key": "disabled",
      "label": "Disabled",
      "help": "Whether the field is disabled",
      "required": false
    },
    {
      "kind": "boolean",
      "key": "read_only",
      "label": "Read-only",
      "help": "Whether the field is read-only",
      "required": false
    },
    {
      "kind": "boolean",
      "key": "multiline",
      "label": "Multiline",
      "help": "Render as multi-line textarea",
      "required": false
    },
    {
      "kind": "choice",
      "key": "input_type",
      "label": "Input type",
      "help": "HTML input type",
      "required": false,
      "options": [
        {
          "key": "text",
          "label": "Text"
        },
        {
          "key": "email",
          "label": "Email"
        },
        {
          "key": "password",
          "label": "Password"
        },
        {
          "key": "tel",
          "label": "Telephone"
        },
        {
          "key": "url",
          "label": "URL"
        }
      ]
    }
  ],
  "slots": [],
  "capabilities": {
    "responsiveVisibility": true,
    "responsiveOrder": true,
    "gridWidth": true,
    "height": "content",
    "publicSurface": "allowed",
    "accessibleName": "required",
    "accessibleNamePropertyPath": [
      "label"
    ]
  },
  "contentFingerprint": "sha256:7d0853a537f210e752ae5b5ee783f9bb48d29476ff2c96eb400b696f512f7739",
  "catalogueFingerprint": "sha256:7751c811b36d5da5f8ce9e56671a0638799280c845688d896f5bf6adb00d095c"
});

/** Exact immutable metadata release for number input block. */
export const NUMBER_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  "blockId": "b102e73c-23c8-47a3-9562-f19b22e18b02",
  "key": "platform.form.number_input",
  "releaseVersion": "1.0.0",
  "name": "Number input",
  "icon": "hash",
  "paletteGroup": "input",
  "rendererKey": "platform.renderer.number_input",
  "properties": [
    {
      "kind": "text",
      "key": "name",
      "label": "Field name",
      "help": "Field key emitted in field_changed event",
      "required": true,
      "minLength": 1,
      "maxLength": 60
    },
    {
      "kind": "text",
      "key": "label",
      "label": "Label",
      "help": "Accessible name and visual field label",
      "required": true,
      "minLength": 1,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "placeholder",
      "label": "Placeholder",
      "help": "Placeholder hint text",
      "required": false,
      "minLength": 0,
      "maxLength": 200
    },
    {
      "kind": "text",
      "key": "help_text",
      "label": "Help text",
      "help": "Descriptive help text below the input",
      "required": false,
      "minLength": 0,
      "maxLength": 500
    },
    {
      "kind": "boolean",
      "key": "required",
      "label": "Required",
      "help": "Whether the field is required",
      "required": false
    },
    {
      "kind": "boolean",
      "key": "disabled",
      "label": "Disabled",
      "help": "Whether the field is disabled",
      "required": false
    },
    {
      "kind": "boolean",
      "key": "read_only",
      "label": "Read-only",
      "help": "Whether the field is read-only",
      "required": false
    },
    {
      "kind": "boolean",
      "key": "integer",
      "label": "Integer only",
      "help": "Restrict input to whole numbers",
      "required": false
    },
    {
      "kind": "number",
      "key": "min_value",
      "label": "Minimum value",
      "help": "Minimum permitted numerical value",
      "required": false,
      "integer": false
    },
    {
      "kind": "number",
      "key": "max_value",
      "label": "Maximum value",
      "help": "Maximum permitted numerical value",
      "required": false,
      "integer": false
    },
    {
      "kind": "number",
      "key": "step_value",
      "label": "Step interval",
      "help": "Granularity of value changes",
      "required": false,
      "integer": false
    }
  ],
  "slots": [],
  "capabilities": {
    "responsiveVisibility": true,
    "responsiveOrder": true,
    "gridWidth": true,
    "height": "content",
    "publicSurface": "allowed",
    "accessibleName": "required",
    "accessibleNamePropertyPath": [
      "label"
    ]
  },
  "contentFingerprint": "sha256:caf7eb455deea7d37cab5af45778a0969afd3e82d6657732e7a7c4b73dcb00bc",
  "catalogueFingerprint": "sha256:bc83913df54b4dc5d66e14fa78575ec0c01576d456df77f0d9964ef0fc926762"
});

/** Exact immutable metadata release for boolean input block. */
export const BOOLEAN_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  "blockId": "b103fb8e-0f31-482d-8e43-e6d7a4697c03",
  "key": "platform.form.boolean_input",
  "releaseVersion": "1.0.0",
  "name": "Boolean input",
  "icon": "check-square",
  "paletteGroup": "input",
  "rendererKey": "platform.renderer.boolean_input",
  "properties": [
    {
      "kind": "text",
      "key": "name",
      "label": "Field name",
      "help": "Field key emitted in field_changed event",
      "required": true,
      "minLength": 1,
      "maxLength": 60
    },
    {
      "kind": "text",
      "key": "label",
      "label": "Label",
      "help": "Accessible name and visual field label",
      "required": true,
      "minLength": 1,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "help_text",
      "label": "Help text",
      "help": "Descriptive help text",
      "required": false,
      "minLength": 0,
      "maxLength": 500
    },
    {
      "kind": "boolean",
      "key": "required",
      "label": "Required",
      "help": "Whether the field is required",
      "required": false
    },
    {
      "kind": "boolean",
      "key": "disabled",
      "label": "Disabled",
      "help": "Whether the field is disabled",
      "required": false
    },
    {
      "kind": "choice",
      "key": "variant",
      "label": "Variant",
      "help": "Visual representation as checkbox or switch",
      "required": false,
      "options": [
        {
          "key": "checkbox",
          "label": "Checkbox"
        },
        {
          "key": "switch",
          "label": "Switch"
        }
      ]
    }
  ],
  "slots": [],
  "capabilities": {
    "responsiveVisibility": true,
    "responsiveOrder": true,
    "gridWidth": true,
    "height": "content",
    "publicSurface": "allowed",
    "accessibleName": "required",
    "accessibleNamePropertyPath": [
      "label"
    ]
  },
  "contentFingerprint": "sha256:958733f158bb9ab862bab816563e992c90a744e4cba19b9bba9df2431f0b9fc7",
  "catalogueFingerprint": "sha256:775d4ac5f82382a77e71856dfb0677c230af4220c2d8cd5d639ac8b5c9abeacf"
});

/** Exact immutable metadata release for date input block. */
export const DATE_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  "blockId": "b104a91d-5517-48f0-b851-7f893d56a204",
  "key": "platform.form.date_input",
  "releaseVersion": "1.0.0",
  "name": "Date input",
  "icon": "calendar",
  "paletteGroup": "input",
  "rendererKey": "platform.renderer.date_input",
  "properties": [
    {
      "kind": "text",
      "key": "name",
      "label": "Field name",
      "help": "Field key emitted in field_changed event",
      "required": true,
      "minLength": 1,
      "maxLength": 60
    },
    {
      "kind": "text",
      "key": "label",
      "label": "Label",
      "help": "Accessible name and visual field label",
      "required": true,
      "minLength": 1,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "help_text",
      "label": "Help text",
      "help": "Descriptive help text",
      "required": false,
      "minLength": 0,
      "maxLength": 500
    },
    {
      "kind": "boolean",
      "key": "required",
      "label": "Required",
      "help": "Whether the field is required",
      "required": false
    },
    {
      "kind": "boolean",
      "key": "disabled",
      "label": "Disabled",
      "help": "Whether the field is disabled",
      "required": false
    },
    {
      "kind": "boolean",
      "key": "read_only",
      "label": "Read-only",
      "help": "Whether the field is read-only",
      "required": false
    }
  ],
  "slots": [],
  "capabilities": {
    "responsiveVisibility": true,
    "responsiveOrder": true,
    "gridWidth": true,
    "height": "content",
    "publicSurface": "allowed",
    "accessibleName": "required",
    "accessibleNamePropertyPath": [
      "label"
    ]
  },
  "contentFingerprint": "sha256:196760e596b7cf7c0fd9b5b2dbf2c85ffe67bb4947f1d458d3e89370432bbdf1",
  "catalogueFingerprint": "sha256:5d7ddaa52d18add57481a43fb7ac7233c44ba70619b3f8d7224d98f15af0b0d4"
});

/** Exact immutable metadata release for choice input block. */
export const CHOICE_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  "blockId": "b105d15c-3f24-4a25-8321-987a4efb3105",
  "key": "platform.form.choice_input",
  "releaseVersion": "1.0.0",
  "name": "Choice input",
  "icon": "list",
  "paletteGroup": "input",
  "rendererKey": "platform.renderer.choice_input",
  "properties": [
    {
      "kind": "text",
      "key": "name",
      "label": "Field name",
      "help": "Field key emitted in field_changed event",
      "required": true,
      "minLength": 1,
      "maxLength": 60
    },
    {
      "kind": "text",
      "key": "label",
      "label": "Label",
      "help": "Accessible name and visual field label",
      "required": true,
      "minLength": 1,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "placeholder",
      "label": "Placeholder",
      "help": "Placeholder option label",
      "required": false,
      "minLength": 0,
      "maxLength": 200
    },
    {
      "kind": "text",
      "key": "help_text",
      "label": "Help text",
      "help": "Descriptive help text",
      "required": false,
      "minLength": 0,
      "maxLength": 500
    },
    {
      "kind": "boolean",
      "key": "required",
      "label": "Required",
      "help": "Whether the field is required",
      "required": false
    },
    {
      "kind": "boolean",
      "key": "disabled",
      "label": "Disabled",
      "help": "Whether the field is disabled",
      "required": false
    },
    {
      "kind": "text",
      "key": "options_json",
      "label": "Options JSON",
      "help": "Authored choices formatted as JSON array of key and label objects",
      "required": false,
      "minLength": 0,
      "maxLength": 5000
    },
    {
      "kind": "choice",
      "key": "variant",
      "label": "Variant",
      "help": "Render as select dropdown or radio buttons",
      "required": false,
      "options": [
        {
          "key": "select",
          "label": "Select dropdown"
        },
        {
          "key": "radio",
          "label": "Radio buttons"
        }
      ]
    }
  ],
  "slots": [],
  "capabilities": {
    "responsiveVisibility": true,
    "responsiveOrder": true,
    "gridWidth": true,
    "height": "content",
    "publicSurface": "allowed",
    "accessibleName": "required",
    "accessibleNamePropertyPath": [
      "label"
    ]
  },
  "contentFingerprint": "sha256:025c0639bc0df54f21f447286c2f4e479c8b96cde8087bf3ba774f6a8790387a",
  "catalogueFingerprint": "sha256:97e14354799f30018da28477392fcc902005f22eaf7e425c55fe07c60edf9206"
});

/** Exact immutable metadata release for validation message block. */
export const VALIDATION_MESSAGE_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  "blockId": "b106c82e-9d41-47fb-b132-8495a639b706",
  "key": "platform.form.validation_message",
  "releaseVersion": "1.0.0",
  "name": "Validation message",
  "icon": "alert-circle",
  "paletteGroup": "input",
  "rendererKey": "platform.renderer.validation_message",
  "properties": [
    {
      "kind": "text",
      "key": "title",
      "label": "Title",
      "help": "Accessible title for validation message",
      "required": false,
      "minLength": 1,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "for_field",
      "label": "Target field",
      "help": "Specific field key to show errors for, or empty for form-wide errors",
      "required": false,
      "minLength": 0,
      "maxLength": 60
    },
    {
      "kind": "text",
      "key": "message",
      "label": "Message",
      "help": "Static error message when no projected error is supplied",
      "required": false,
      "minLength": 0,
      "maxLength": 1000
    },
    {
      "kind": "choice",
      "key": "severity",
      "label": "Severity",
      "help": "Visual alert severity level",
      "required": false,
      "options": [
        {
          "key": "error",
          "label": "Error"
        },
        {
          "key": "warning",
          "label": "Warning"
        },
        {
          "key": "info",
          "label": "Info"
        }
      ]
    }
  ],
  "slots": [],
  "capabilities": {
    "responsiveVisibility": true,
    "responsiveOrder": true,
    "gridWidth": true,
    "height": "content",
    "publicSurface": "allowed",
    "accessibleName": "optional",
    "accessibleNamePropertyPath": [
      "title"
    ]
  },
  "contentFingerprint": "sha256:27712810fbf61d42fa2ec522120aec75163f2eb74ea812d14c9b2786671497f1",
  "catalogueFingerprint": "sha256:bbb23c1d1de8b8d0bdef7bd07a7f25019bec8c6b762d5495acc01f4fb396f57f"
});

/** Exact immutable metadata release for button block. */
export const BUTTON_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  "blockId": "b107e34a-6a19-4822-9cb5-2a819c4d5e07",
  "key": "platform.action.button",
  "releaseVersion": "1.0.0",
  "name": "Button",
  "icon": "play",
  "paletteGroup": "actions",
  "rendererKey": "platform.renderer.button",
  "properties": [
    {
      "kind": "text",
      "key": "label",
      "label": "Label",
      "help": "Accessible name shown as the button text",
      "required": true,
      "minLength": 1,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "action_key",
      "label": "Action key",
      "help": "Semantic action key emitted when clicked",
      "required": false,
      "minLength": 0,
      "maxLength": 120
    },
    {
      "kind": "choice",
      "key": "action_kind",
      "label": "Action kind",
      "help": "Event type emitted on click",
      "required": false,
      "options": [
        {
          "key": "action",
          "label": "Action"
        },
        {
          "key": "submit",
          "label": "Submit form"
        },
        {
          "key": "reset",
          "label": "Reset form"
        }
      ]
    },
    {
      "kind": "choice",
      "key": "variant",
      "label": "Variant",
      "help": "Visual appearance style",
      "required": false,
      "options": [
        {
          "key": "primary",
          "label": "Primary"
        },
        {
          "key": "secondary",
          "label": "Secondary"
        },
        {
          "key": "danger",
          "label": "Danger"
        },
        {
          "key": "ghost",
          "label": "Ghost"
        }
      ]
    },
    {
      "kind": "boolean",
      "key": "disabled",
      "label": "Disabled",
      "help": "Whether the button is disabled",
      "required": false
    }
  ],
  "slots": [],
  "capabilities": {
    "responsiveVisibility": true,
    "responsiveOrder": true,
    "gridWidth": true,
    "height": "content",
    "publicSurface": "allowed",
    "accessibleName": "required",
    "accessibleNamePropertyPath": [
      "label"
    ]
  },
  "contentFingerprint": "sha256:d4a12f4c637a48df9e9bdb7eb895aa8f2f3be4e345064872bd0db3a40c6cef97",
  "catalogueFingerprint": "sha256:ce601277baf89b7643f3e6ae17534a49f8d84db03215fb02c1fe5bbf51215851"
});

/** Exact immutable metadata release for tabs block. */
export const TABS_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  "blockId": "b108f92b-813c-4977-8fa2-3c4850912d08",
  "key": "platform.layout.tabs",
  "releaseVersion": "1.0.0",
  "name": "Tabs",
  "icon": "folder",
  "paletteGroup": "layout",
  "rendererKey": "platform.renderer.tabs",
  "properties": [
    {
      "kind": "text",
      "key": "title",
      "label": "Title",
      "help": "Accessible name for the tabs container",
      "required": true,
      "minLength": 1,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "default_tab",
      "label": "Default tab",
      "help": "Key of the default active tab slot",
      "required": false,
      "minLength": 0,
      "maxLength": 40
    },
    {
      "kind": "text",
      "key": "tab_one_label",
      "label": "Tab 1 label",
      "help": "Label for the first tab button",
      "required": false,
      "minLength": 0,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "tab_two_label",
      "label": "Tab 2 label",
      "help": "Label for the second tab button",
      "required": false,
      "minLength": 0,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "tab_three_label",
      "label": "Tab 3 label",
      "help": "Label for the third tab button",
      "required": false,
      "minLength": 0,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "tab_four_label",
      "label": "Tab 4 label",
      "help": "Label for the fourth tab button",
      "required": false,
      "minLength": 0,
      "maxLength": 120
    }
  ],
  "slots": [
    {
      "key": "tab_one",
      "label": "First tab",
      "required": true,
      "allowedChildCategories": [
        "data",
        "figures",
        "record",
        "input",
        "actions",
        "layout",
        "content"
      ]
    },
    {
      "key": "tab_two",
      "label": "Second tab",
      "required": false,
      "allowedChildCategories": [
        "data",
        "figures",
        "record",
        "input",
        "actions",
        "layout",
        "content"
      ]
    },
    {
      "key": "tab_three",
      "label": "Third tab",
      "required": false,
      "allowedChildCategories": [
        "data",
        "figures",
        "record",
        "input",
        "actions",
        "layout",
        "content"
      ]
    },
    {
      "key": "tab_four",
      "label": "Fourth tab",
      "required": false,
      "allowedChildCategories": [
        "data",
        "figures",
        "record",
        "input",
        "actions",
        "layout",
        "content"
      ]
    }
  ],
  "capabilities": {
    "responsiveVisibility": true,
    "responsiveOrder": true,
    "gridWidth": true,
    "height": "content_or_bounded",
    "publicSurface": "allowed",
    "accessibleName": "required",
    "accessibleNamePropertyPath": [
      "title"
    ]
  },
  "contentFingerprint": "sha256:6f18ec712266186aa2a9000641db2e28ddec95b47b57802bdd0e3b1354a24030",
  "catalogueFingerprint": "sha256:8cd130c4e3405d2f92244cf9b700e51c3b127ca266b079f4fc77171944fd9e2e"
});

/** Exact immutable metadata release for dialog block. */
export const DIALOG_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  "blockId": "b109e25d-4a73-4b68-a472-5b9671f28e09",
  "key": "platform.layout.dialog",
  "releaseVersion": "1.0.0",
  "name": "Dialog",
  "icon": "message-square",
  "paletteGroup": "layout",
  "rendererKey": "platform.renderer.dialog",
  "properties": [
    {
      "kind": "text",
      "key": "title",
      "label": "Title",
      "help": "Accessible name and modal heading",
      "required": true,
      "minLength": 1,
      "maxLength": 120
    },
    {
      "kind": "boolean",
      "key": "open",
      "label": "Initially open",
      "help": "Whether dialog is open by default",
      "required": false
    },
    {
      "kind": "boolean",
      "key": "modal",
      "label": "Modal",
      "help": "Trap focus and prevent background interactions",
      "required": false
    },
    {
      "kind": "choice",
      "key": "size",
      "label": "Size",
      "help": "Modal width size",
      "required": false,
      "options": [
        {
          "key": "small",
          "label": "Small"
        },
        {
          "key": "medium",
          "label": "Medium"
        },
        {
          "key": "large",
          "label": "Large"
        }
      ]
    }
  ],
  "slots": [
    {
      "key": "content",
      "label": "Dialog content",
      "required": true,
      "allowedChildCategories": [
        "data",
        "figures",
        "record",
        "input",
        "actions",
        "layout",
        "content"
      ]
    },
    {
      "key": "actions",
      "label": "Dialog actions",
      "required": false,
      "allowedChildCategories": [
        "actions"
      ]
    }
  ],
  "capabilities": {
    "responsiveVisibility": true,
    "responsiveOrder": true,
    "gridWidth": true,
    "height": "content_or_bounded",
    "publicSurface": "allowed",
    "accessibleName": "required",
    "accessibleNamePropertyPath": [
      "title"
    ]
  },
  "contentFingerprint": "sha256:3cdaa3adb7b5bb93786d8e4c9d348fe7e1aa15b6c3108be06b94b014eb2ded3a",
  "catalogueFingerprint": "sha256:b8894bf09cab6e240541d6cea29c65136adfc00805973a7155c0658fd0bf8505"
});

/** Exact immutable metadata release for drawer block. */
export const DRAWER_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  "blockId": "b110a74f-9b25-4c81-8173-6c8491a35f10",
  "key": "platform.layout.drawer",
  "releaseVersion": "1.0.0",
  "name": "Drawer",
  "icon": "sidebar",
  "paletteGroup": "layout",
  "rendererKey": "platform.renderer.drawer",
  "properties": [
    {
      "kind": "text",
      "key": "title",
      "label": "Title",
      "help": "Accessible name and drawer heading",
      "required": true,
      "minLength": 1,
      "maxLength": 120
    },
    {
      "kind": "boolean",
      "key": "open",
      "label": "Initially open",
      "help": "Whether drawer is open by default",
      "required": false
    },
    {
      "kind": "choice",
      "key": "placement",
      "label": "Placement",
      "help": "Drawer slide-in direction",
      "required": false,
      "options": [
        {
          "key": "left",
          "label": "Left"
        },
        {
          "key": "right",
          "label": "Right"
        },
        {
          "key": "top",
          "label": "Top"
        },
        {
          "key": "bottom",
          "label": "Bottom"
        }
      ]
    },
    {
      "kind": "choice",
      "key": "size",
      "label": "Size",
      "help": "Drawer width or height size",
      "required": false,
      "options": [
        {
          "key": "small",
          "label": "Small"
        },
        {
          "key": "medium",
          "label": "Medium"
        },
        {
          "key": "large",
          "label": "Large"
        }
      ]
    }
  ],
  "slots": [
    {
      "key": "content",
      "label": "Drawer content",
      "required": true,
      "allowedChildCategories": [
        "data",
        "figures",
        "record",
        "input",
        "actions",
        "layout",
        "content"
      ]
    },
    {
      "key": "actions",
      "label": "Drawer actions",
      "required": false,
      "allowedChildCategories": [
        "actions"
      ]
    }
  ],
  "capabilities": {
    "responsiveVisibility": true,
    "responsiveOrder": true,
    "gridWidth": true,
    "height": "content_or_bounded",
    "publicSurface": "allowed",
    "accessibleName": "required",
    "accessibleNamePropertyPath": [
      "title"
    ]
  },
  "contentFingerprint": "sha256:f549efc393535864389aad0e14b0227ffbd27bf249a54bca568833450c266b2f",
  "catalogueFingerprint": "sha256:8395207fffcb2f4e7978de34ef9c3d92330de233fad75b351dca0a684f626844"
});

/** Exact immutable metadata release for form container block. */
export const FORM_CONTAINER_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  "blockId": "b111c63b-18a4-4df2-a935-7d05e2b46a11",
  "key": "platform.form.container",
  "releaseVersion": "1.0.0",
  "name": "Form container",
  "icon": "edit-3",
  "paletteGroup": "input",
  "rendererKey": "platform.renderer.form_container",
  "properties": [
    {
      "kind": "text",
      "key": "title",
      "label": "Title",
      "help": "Accessible name for the form",
      "required": false,
      "minLength": 1,
      "maxLength": 120
    },
    {
      "kind": "text",
      "key": "form_id",
      "label": "Form ID",
      "help": "Identifier emitted with form submit and reset events",
      "required": false,
      "minLength": 0,
      "maxLength": 60
    }
  ],
  "slots": [
    {
      "key": "content",
      "label": "Form content",
      "required": true,
      "allowedChildCategories": [
        "input",
        "actions",
        "content",
        "data",
        "figures",
        "record",
        "layout"
      ]
    }
  ],
  "capabilities": {
    "responsiveVisibility": true,
    "responsiveOrder": true,
    "gridWidth": true,
    "height": "content_or_bounded",
    "publicSurface": "allowed",
    "accessibleName": "optional",
    "accessibleNamePropertyPath": [
      "title"
    ]
  },
  "contentFingerprint": "sha256:853df2645f77842b9db1d1ae527659503d8c8baaa3a98d0dc63f8510c06335e7",
  "catalogueFingerprint": "sha256:88311c4d4760042477b5019cdd7ccb8bfb640c336f8d88bb54274d8fe9737f02"
});

/** All eleven immutable form and action control block releases. */
export const CONTROL_BLOCK_RELEASES: readonly PlatformBlockReleaseV2[] = Object.freeze([
  TEXT_INPUT_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  BOOLEAN_INPUT_BLOCK_RELEASE,
  DATE_INPUT_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  VALIDATION_MESSAGE_BLOCK_RELEASE,
  BUTTON_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
  DIALOG_BLOCK_RELEASE,
  DRAWER_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
]);

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
