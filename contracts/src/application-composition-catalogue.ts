import {
  type PlatformBlockReleaseV2,
  platformBlockReleaseV2Schema,
  type ImmutablePlatformBlockCatalogueV2,
  immutablePlatformBlockCatalogueV2Schema,
} from "./application-composition-v2";

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

/**
 * The registered platform block releases: the one source of block metadata for server
 * validation and for the renderer registrations that pair each release with its component. Each release is parsed through the release contract at module load and
 * deep-frozen. Fingerprints are the canonical-JSON SHA-256 values the publication catalogue
 * derives from the same content.
 */
const release = (definition: unknown): PlatformBlockReleaseV2 =>
  deepFreeze(platformBlockReleaseV2Schema.parse(definition));

/** Exact immutable metadata release for the plain text display block. */
export const TEXT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "addfad00-1b11-4674-83fa-913667f87e79",
  key: "platform.display.text",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:a8964d4a351d02ed6b5b6c2a18960722c0f71ba7661e105e214f717edb9ac292",
  catalogueFingerprint: "sha256:57be52ee0755ca927565e5148f5393fc3fe57c72a4027b8bf55d0c40249b71a0",
  name: "Plain text",
  icon: "type",
  paletteGroup: "content",
  rendererKey: "platform.renderer.text",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "text",
      label: "Text",
      help: "Literal text shown when no projected value is supplied",
      required: false,
      minLength: 0,
      maxLength: 5000,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the structured rich text display block. */
export const RICH_TEXT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "148f420f-f7db-4145-80f4-3d3fa036096b",
  key: "platform.display.rich_text",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:85347b7eb5855b0565b3bd05d2e6d802d6909fee09b1ff4b09dda224d818993a",
  catalogueFingerprint: "sha256:c8566e88a84f229ab8acca5b780efb648c5965188bd4148a254dc90bfd187626",
  name: "Rich text",
  icon: "file-text",
  paletteGroup: "content",
  rendererKey: "platform.renderer.rich_text",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "rich_text",
      key: "document",
      label: "Content",
      help: "Structured content shown when no projected value is supplied",
      required: false,
      allowedElements: ["paragraph", "heading", "bulleted_list", "numbered_list", "emphasis", "link"],
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the list display block. */
export const LIST_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "4881c816-e4ce-4c39-b0b7-20958b947748",
  key: "platform.display.list",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:57de3de8146aff7b144287013212a56a1776931b0ccd64ec2dd33fbb2302410c",
  catalogueFingerprint: "sha256:1f85bfc0817bb2f01cc67dfe14d408f9305e12b892863e2ec8bc5b3f2d767837",
  name: "List",
  icon: "list",
  paletteGroup: "data",
  rendererKey: "platform.renderer.list",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the table display block. */
export const TABLE_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "39ab6f28-c166-47cf-91a7-f0b864ded4ff",
  key: "platform.display.table",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:ddf3237b66a623d0d9bab1c843395b3991b132d14e60275219b200911b82dd69",
  catalogueFingerprint: "sha256:d3ce60391d8610678e37474d649c7ec50afc67a8489ef999bab17a68379fd990",
  name: "Table",
  icon: "table",
  paletteGroup: "data",
  rendererKey: "platform.renderer.table",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the record detail display block. */
export const RECORD_DETAIL_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "e2569df0-2f10-4b20-b41d-177b66cd136c",
  key: "platform.display.record_detail",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:ed4b64a50a6aa5d1e42795ac073173b481e4e69be12ca959938ccb8aa079af5d",
  catalogueFingerprint: "sha256:8efdda07e305a445b29e4e0d69dcb513a61daaaf5840e591b54c9cc164f064ba",
  name: "Record detail",
  icon: "file",
  paletteGroup: "record",
  rendererKey: "platform.renderer.record_detail",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the grouped data display block. */
export const GROUPED_DATA_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "6c27a0c2-ad91-4a5a-ab1d-54d337bebe36",
  key: "platform.display.grouped_data",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:88a63161fb47527b9849d79c692a2cfb1a7d7ad0e8eefa6526c8b96b211c1e51",
  catalogueFingerprint: "sha256:c257f534817c1d175774ce78e1efd8e50cafe9caa8fc854818323f49025ead3f",
  name: "Grouped data",
  icon: "layers",
  paletteGroup: "data",
  rendererKey: "platform.renderer.grouped_data",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the summary values display block. */
export const SUMMARY_VALUES_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "b00f7a0f-9094-4186-b8c4-066b1df6c395",
  key: "platform.display.summary_values",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:9ab8233005907928f32818ae8e0b89107942498c003dc84c05833624885e81b8",
  catalogueFingerprint: "sha256:f477dd3f15ea3408a743f2fb30817bee4f897d7bb76481b86eac0537298b24c6",
  name: "Summary values",
  icon: "hash",
  paletteGroup: "figures",
  rendererKey: "platform.renderer.summary_values",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the text input block. */
export const TEXT_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "15b2d6f6-228d-4248-84be-1f8f45e204fc",
  key: "platform.form.text_input",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:68159a6d6135d509b70c5173afa6ad99e67323708029895ee5424d776268fd36",
  catalogueFingerprint: "sha256:3220a105a1bcb62c1193ddc458034d2615f628fd101369a13616bc9e64cb18a0",
  name: "Text input",
  icon: "type",
  paletteGroup: "input",
  rendererKey: "platform.renderer.text_input",
  properties: [
    {
      kind: "text",
      key: "name",
      label: "Field name",
      help: "Key of this field in form values and events: lowercase words separated by underscores",
      required: true,
      minLength: 1,
      maxLength: 40,
    },
    {
      kind: "text",
      key: "label",
      label: "Label",
      help: "Accessible name and visual field label",
      required: true,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "placeholder",
      label: "Placeholder",
      help: "Placeholder hint text",
      required: false,
      minLength: 0,
      maxLength: 200,
    },
    {
      kind: "text",
      key: "help_text",
      label: "Help text",
      help: "Descriptive help text below the input",
      required: false,
      minLength: 0,
      maxLength: 500,
    },
    {
      kind: "boolean",
      key: "required",
      label: "Required",
      help: "Whether the field is required",
      required: false,
    },
    {
      kind: "boolean",
      key: "disabled",
      label: "Disabled",
      help: "Whether the field is disabled",
      required: false,
    },
    {
      kind: "boolean",
      key: "read_only",
      label: "Read-only",
      help: "Whether the field is read-only",
      required: false,
    },
    {
      kind: "boolean",
      key: "multiline",
      label: "Multiline",
      help: "Render as multi-line textarea",
      required: false,
    },
    {
      kind: "choice",
      key: "input_type",
      label: "Input type",
      help: "HTML input type",
      required: false,
      options: [
        {
          key: "text",
          label: "Text",
        },
        {
          key: "email",
          label: "Email",
        },
        {
          key: "password",
          label: "Password",
        },
        {
          key: "tel",
          label: "Telephone",
        },
        {
          key: "url",
          label: "URL",
        },
      ],
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content",
    publicSurface: "allowed",
    accessibleName: "required",
    accessibleNamePropertyPath: ["label"],
  },
});

/** Exact immutable metadata release for the number input block. */
export const NUMBER_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "c8645b41-48b5-489c-bd2e-02283535a7c5",
  key: "platform.form.number_input",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:6b34dcb3871b368cf8005adc78437e3f8f9e246ecb87a0f41f4e4a1b30aaae7b",
  catalogueFingerprint: "sha256:ffece9be1ef2fbef66f64aaea5c61c21433bec2ee79257c357a374ea7d26a76e",
  name: "Number input",
  icon: "hash",
  paletteGroup: "input",
  rendererKey: "platform.renderer.number_input",
  properties: [
    {
      kind: "text",
      key: "name",
      label: "Field name",
      help: "Key of this field in form values and events: lowercase words separated by underscores",
      required: true,
      minLength: 1,
      maxLength: 40,
    },
    {
      kind: "text",
      key: "label",
      label: "Label",
      help: "Accessible name and visual field label",
      required: true,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "placeholder",
      label: "Placeholder",
      help: "Placeholder hint text",
      required: false,
      minLength: 0,
      maxLength: 200,
    },
    {
      kind: "text",
      key: "help_text",
      label: "Help text",
      help: "Descriptive help text below the input",
      required: false,
      minLength: 0,
      maxLength: 500,
    },
    {
      kind: "boolean",
      key: "required",
      label: "Required",
      help: "Whether the field is required",
      required: false,
    },
    {
      kind: "boolean",
      key: "disabled",
      label: "Disabled",
      help: "Whether the field is disabled",
      required: false,
    },
    {
      kind: "boolean",
      key: "read_only",
      label: "Read-only",
      help: "Whether the field is read-only",
      required: false,
    },
    {
      kind: "boolean",
      key: "integer",
      label: "Integer only",
      help: "Restrict input to whole numbers",
      required: false,
    },
    {
      kind: "number",
      key: "min_value",
      label: "Minimum value",
      help: "Minimum permitted numerical value",
      required: false,
      integer: false,
    },
    {
      kind: "number",
      key: "max_value",
      label: "Maximum value",
      help: "Maximum permitted numerical value",
      required: false,
      integer: false,
    },
    {
      kind: "number",
      key: "step_value",
      label: "Step interval",
      help: "Granularity of value changes",
      required: false,
      integer: false,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content",
    publicSurface: "allowed",
    accessibleName: "required",
    accessibleNamePropertyPath: ["label"],
  },
});

/** Exact immutable metadata release for the boolean input block. */
export const BOOLEAN_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "e9418c36-3234-4806-a05a-0f259482238d",
  key: "platform.form.boolean_input",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:6b58bea792aa6ccbc9459cd930508f1bcbd955c8387a6d7c65ef8fb373a8ac30",
  catalogueFingerprint: "sha256:b8f4165e5314a0d9dffe2b2eafb43d5939f195ee1cb29e384b57210769fd21d0",
  name: "Boolean input",
  icon: "check-square",
  paletteGroup: "input",
  rendererKey: "platform.renderer.boolean_input",
  properties: [
    {
      kind: "text",
      key: "name",
      label: "Field name",
      help: "Key of this field in form values and events: lowercase words separated by underscores",
      required: true,
      minLength: 1,
      maxLength: 40,
    },
    {
      kind: "text",
      key: "label",
      label: "Label",
      help: "Accessible name and visual field label",
      required: true,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "help_text",
      label: "Help text",
      help: "Descriptive help text",
      required: false,
      minLength: 0,
      maxLength: 500,
    },
    {
      kind: "boolean",
      key: "required",
      label: "Required",
      help: "Whether the field is required",
      required: false,
    },
    {
      kind: "boolean",
      key: "disabled",
      label: "Disabled",
      help: "Whether the field is disabled",
      required: false,
    },
    {
      kind: "choice",
      key: "variant",
      label: "Variant",
      help: "Visual representation as checkbox or switch",
      required: false,
      options: [
        {
          key: "checkbox",
          label: "Checkbox",
        },
        {
          key: "switch",
          label: "Switch",
        },
      ],
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content",
    publicSurface: "allowed",
    accessibleName: "required",
    accessibleNamePropertyPath: ["label"],
  },
});

/** Exact immutable metadata release for the date input block. */
export const DATE_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "a5610880-05be-426b-a82b-7f3b645bf255",
  key: "platform.form.date_input",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:d3044e9a8b499eec5fb295e0709f6d49adcda5d2fe06a9e4c1ebf5c2ae853c06",
  catalogueFingerprint: "sha256:c2ae363f07720937fa4019f1bf973c855b9f82a2f15974dda22b11542975eb8a",
  name: "Date input",
  icon: "calendar",
  paletteGroup: "input",
  rendererKey: "platform.renderer.date_input",
  properties: [
    {
      kind: "text",
      key: "name",
      label: "Field name",
      help: "Key of this field in form values and events: lowercase words separated by underscores",
      required: true,
      minLength: 1,
      maxLength: 40,
    },
    {
      kind: "text",
      key: "label",
      label: "Label",
      help: "Accessible name and visual field label",
      required: true,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "help_text",
      label: "Help text",
      help: "Descriptive help text",
      required: false,
      minLength: 0,
      maxLength: 500,
    },
    {
      kind: "boolean",
      key: "required",
      label: "Required",
      help: "Whether the field is required",
      required: false,
    },
    {
      kind: "boolean",
      key: "disabled",
      label: "Disabled",
      help: "Whether the field is disabled",
      required: false,
    },
    {
      kind: "boolean",
      key: "read_only",
      label: "Read-only",
      help: "Whether the field is read-only",
      required: false,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content",
    publicSurface: "allowed",
    accessibleName: "required",
    accessibleNamePropertyPath: ["label"],
  },
});

/** Exact immutable metadata release for the choice input block. */
export const CHOICE_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "2bd013f9-48ad-43d3-a6eb-7fc3c130cf87",
  key: "platform.form.choice_input",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:0eb9b4dc7a7196197b1e32144399fd904bdb29a183750e5f358deaf7bafa67e2",
  catalogueFingerprint: "sha256:757bdcb22e5afdca14df7994e9524a19bb68d79f437bbf14f1d90650fff7db1d",
  name: "Choice input",
  icon: "list",
  paletteGroup: "input",
  rendererKey: "platform.renderer.choice_input",
  properties: [
    {
      kind: "text",
      key: "name",
      label: "Field name",
      help: "Key of this field in form values and events: lowercase words separated by underscores",
      required: true,
      minLength: 1,
      maxLength: 40,
    },
    {
      kind: "text",
      key: "label",
      label: "Label",
      help: "Accessible name and visual field label",
      required: true,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "placeholder",
      label: "Placeholder",
      help: "Placeholder option label",
      required: false,
      minLength: 0,
      maxLength: 200,
    },
    {
      kind: "text",
      key: "help_text",
      label: "Help text",
      help: "Descriptive help text",
      required: false,
      minLength: 0,
      maxLength: 500,
    },
    {
      kind: "boolean",
      key: "required",
      label: "Required",
      help: "Whether the field is required",
      required: false,
    },
    {
      kind: "boolean",
      key: "disabled",
      label: "Disabled",
      help: "Whether the field is disabled",
      required: false,
    },
    {
      kind: "list",
      key: "options",
      label: "Options",
      help: "Choices offered when no projected options are supplied",
      required: false,
      minimumItems: 0,
      maximumItems: 100,
      item: {
        kind: "group",
        key: "option",
        label: "Option",
        required: true,
        properties: [
          {
            kind: "text",
            key: "key",
            label: "Key",
            help: "Stable option key: lowercase words separated by underscores",
            required: true,
            minLength: 1,
            maxLength: 40,
          },
          {
            kind: "text",
            key: "label",
            label: "Label",
            help: "Option text shown to people",
            required: true,
            minLength: 1,
            maxLength: 120,
          },
        ],
      },
    },
    {
      kind: "choice",
      key: "variant",
      label: "Variant",
      help: "Render as select dropdown or radio buttons",
      required: false,
      options: [
        {
          key: "select",
          label: "Select dropdown",
        },
        {
          key: "radio",
          label: "Radio buttons",
        },
      ],
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content",
    publicSurface: "allowed",
    accessibleName: "required",
    accessibleNamePropertyPath: ["label"],
  },
});

/** Exact immutable metadata release for the validation message block. */
export const VALIDATION_MESSAGE_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "78acc234-87bc-4e8f-986f-4857369b41f8",
  key: "platform.form.validation_message",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:a4338e66e8497ba5b79f96359cfbd94081a3b58a2c6f68ed5fb9e335a8a701da",
  catalogueFingerprint: "sha256:f04ba33e4c56d5c8664f369116413df3e9c7a68a1f473d4220eea71805799ff7",
  name: "Validation message",
  icon: "alert-circle",
  paletteGroup: "input",
  rendererKey: "platform.renderer.validation_message",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible title for validation message",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "for_field",
      label: "Target field",
      help: "Field name this message describes; absent for form-wide messages",
      required: false,
      minLength: 0,
      maxLength: 40,
    },
    {
      kind: "text",
      key: "message",
      label: "Message",
      help: "Static error message when no projected error is supplied",
      required: false,
      minLength: 0,
      maxLength: 1000,
    },
    {
      kind: "choice",
      key: "severity",
      label: "Severity",
      help: "Visual alert severity level",
      required: false,
      options: [
        {
          key: "error",
          label: "Error",
        },
        {
          key: "warning",
          label: "Warning",
        },
        {
          key: "info",
          label: "Info",
        },
      ],
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the button block. */
export const BUTTON_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "c6fb63eb-fdf4-4fdf-954d-7610aad7be1b",
  key: "platform.action.button",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:f222e8acd1a4857b20a41098adafc5346405872b56c00f108bd297ad9b92c7ec",
  catalogueFingerprint: "sha256:e2536549f3f9222d8c36f193a2addd18fda6be05d3b9033888ad3adeccdd3971",
  name: "Button",
  icon: "play",
  paletteGroup: "actions",
  rendererKey: "platform.renderer.button",
  properties: [
    {
      kind: "text",
      key: "label",
      label: "Label",
      help: "Accessible name shown as the button text",
      required: true,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "choice",
      key: "action_kind",
      label: "Action kind",
      help: "Action emits the action event; Submit and Reset use the enclosing form's one submit or reset event",
      required: false,
      options: [
        {
          key: "action",
          label: "Action",
        },
        {
          key: "submit",
          label: "Submit form",
        },
        {
          key: "reset",
          label: "Reset form",
        },
      ],
    },
    {
      kind: "choice",
      key: "variant",
      label: "Variant",
      help: "Visual appearance style",
      required: false,
      options: [
        {
          key: "primary",
          label: "Primary",
        },
        {
          key: "secondary",
          label: "Secondary",
        },
        {
          key: "danger",
          label: "Danger",
        },
        {
          key: "ghost",
          label: "Ghost",
        },
      ],
    },
    {
      kind: "boolean",
      key: "disabled",
      label: "Disabled",
      help: "Whether the button is disabled",
      required: false,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content",
    publicSurface: "allowed",
    accessibleName: "required",
    accessibleNamePropertyPath: ["label"],
  },
});

/** Exact immutable metadata release for the tabs block. */
export const TABS_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "a3b7065b-47ef-4c92-93d1-59300f8b059c",
  key: "platform.layout.tabs",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:f137fed1662b2adbd92ec908fd9372f651e0350dfc1656baac175fac616f7625",
  catalogueFingerprint: "sha256:2f3c3498ce27360add59d87b4f85e6be6c7a6a88a25968687dc3bf97f3b55016",
  name: "Tabs",
  icon: "folder",
  paletteGroup: "layout",
  rendererKey: "platform.renderer.tabs",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name for the tabs container",
      required: true,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "choice",
      key: "default_tab",
      label: "Default tab",
      help: "Tab selected first when no projected tab is supplied",
      required: false,
      options: [
        {
          key: "tab_one",
          label: "Tab 1",
        },
        {
          key: "tab_two",
          label: "Tab 2",
        },
        {
          key: "tab_three",
          label: "Tab 3",
        },
        {
          key: "tab_four",
          label: "Tab 4",
        },
      ],
    },
    {
      kind: "text",
      key: "tab_one_label",
      label: "Tab 1 label",
      help: "Label for the first tab button",
      required: false,
      minLength: 0,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "tab_two_label",
      label: "Tab 2 label",
      help: "Label for the second tab button",
      required: false,
      minLength: 0,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "tab_three_label",
      label: "Tab 3 label",
      help: "Label for the third tab button",
      required: false,
      minLength: 0,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "tab_four_label",
      label: "Tab 4 label",
      help: "Label for the fourth tab button",
      required: false,
      minLength: 0,
      maxLength: 120,
    },
  ],
  slots: [
    {
      key: "tab_one",
      label: "First tab",
      required: true,
      allowedChildCategories: ["data", "figures", "record", "input", "actions", "layout", "content"],
    },
    {
      key: "tab_two",
      label: "Second tab",
      required: false,
      allowedChildCategories: ["data", "figures", "record", "input", "actions", "layout", "content"],
    },
    {
      key: "tab_three",
      label: "Third tab",
      required: false,
      allowedChildCategories: ["data", "figures", "record", "input", "actions", "layout", "content"],
    },
    {
      key: "tab_four",
      label: "Fourth tab",
      required: false,
      allowedChildCategories: ["data", "figures", "record", "input", "actions", "layout", "content"],
    },
  ],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "required",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the dialog block. */
export const DIALOG_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "651460f1-5fce-4443-bc9d-4dd4b6ae8a8b",
  key: "platform.layout.dialog",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:112f752861a5251566943e6a4c256a891bdd5bda2410a378af77f7850608f377",
  catalogueFingerprint: "sha256:733c93f706fd6f4a9b5525f74418b824ea47710bf1930de0f09c4918c6b00dde",
  name: "Dialog",
  icon: "message-square",
  paletteGroup: "layout",
  rendererKey: "platform.renderer.dialog",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name and modal heading",
      required: true,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "boolean",
      key: "open",
      label: "Initially open",
      help: "Open when the page first renders, unless a projected open state is supplied",
      required: false,
    },
    {
      kind: "choice",
      key: "size",
      label: "Size",
      help: "Modal width size",
      required: false,
      options: [
        {
          key: "small",
          label: "Small",
        },
        {
          key: "medium",
          label: "Medium",
        },
        {
          key: "large",
          label: "Large",
        },
      ],
    },
  ],
  slots: [
    {
      key: "content",
      label: "Dialog content",
      required: true,
      allowedChildCategories: ["data", "figures", "record", "input", "actions", "layout", "content"],
    },
    {
      key: "actions",
      label: "Dialog actions",
      required: false,
      allowedChildCategories: ["actions"],
    },
  ],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "required",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the drawer block. */
export const DRAWER_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "a399ff74-5716-4411-bca8-c5ab87ec2e7d",
  key: "platform.layout.drawer",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:76d19ff37abb70a756e98e2ab21c70f38e3d848366677c7a6714868e1b443d5e",
  catalogueFingerprint: "sha256:b9fd6eb7146426ca5ddc119895822beeafa6f7d087b1cf697895a4d8ff67ef6e",
  name: "Drawer",
  icon: "sidebar",
  paletteGroup: "layout",
  rendererKey: "platform.renderer.drawer",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name and drawer heading",
      required: true,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "boolean",
      key: "open",
      label: "Initially open",
      help: "Open when the page first renders, unless a projected open state is supplied",
      required: false,
    },
    {
      kind: "choice",
      key: "placement",
      label: "Placement",
      help: "Drawer slide-in direction",
      required: false,
      options: [
        {
          key: "left",
          label: "Left",
        },
        {
          key: "right",
          label: "Right",
        },
        {
          key: "top",
          label: "Top",
        },
        {
          key: "bottom",
          label: "Bottom",
        },
      ],
    },
    {
      kind: "choice",
      key: "size",
      label: "Size",
      help: "Drawer width or height size",
      required: false,
      options: [
        {
          key: "small",
          label: "Small",
        },
        {
          key: "medium",
          label: "Medium",
        },
        {
          key: "large",
          label: "Large",
        },
      ],
    },
  ],
  slots: [
    {
      key: "content",
      label: "Drawer content",
      required: true,
      allowedChildCategories: ["data", "figures", "record", "input", "actions", "layout", "content"],
    },
    {
      key: "actions",
      label: "Drawer actions",
      required: false,
      allowedChildCategories: ["actions"],
    },
  ],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "required",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the form container block. */
export const FORM_CONTAINER_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "476e2c35-07d6-40cc-bf01-6ddb22ccca44",
  key: "platform.form.container",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:d79dbf59d2fb9d39b170a376ce2858d776375499173c589746a754172b5c8c2f",
  catalogueFingerprint: "sha256:f92038e5ca4f37c2d48f57b090d7242d44d2b3cec66579d03636ac89f8156ccc",
  name: "Form container",
  icon: "edit-3",
  paletteGroup: "input",
  rendererKey: "platform.renderer.form_container",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name for the form",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [
    {
      key: "content",
      label: "Form content",
      required: true,
      allowedChildCategories: ["input", "actions", "content", "data", "figures", "record", "layout"],
    },
  ],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** All seven immutable display block releases. */
export const DISPLAY_BLOCK_RELEASES: readonly PlatformBlockReleaseV2[] = Object.freeze([
  TEXT_BLOCK_RELEASE,
  RICH_TEXT_BLOCK_RELEASE,
  LIST_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  GROUPED_DATA_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE,
]);

/** All eleven immutable form, layout and action block releases. */
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

/** All eighteen immutable platform block releases registered for the page builder. */
export const PLATFORM_BLOCK_RELEASES: readonly PlatformBlockReleaseV2[] = Object.freeze([
  ...DISPLAY_BLOCK_RELEASES,
  ...CONTROL_BLOCK_RELEASES,
]);

/**
 * Closed immutable platform block catalogue for pure V2 composition validation and materialisation.
 * Server-owned; client-side renderer changes cannot alter or expand this allowlist.
 */
export const IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2: ImmutablePlatformBlockCatalogueV2 =
  deepFreeze(
    immutablePlatformBlockCatalogueV2Schema.parse({
      compositionPolicy: {
        maximumDepth: 32,
        maximumPlacements: 512,
      },
      releases: PLATFORM_BLOCK_RELEASES,
    }),
  );
