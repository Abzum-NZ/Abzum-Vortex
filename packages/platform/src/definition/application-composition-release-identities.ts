/** Stable block identities used by renderers and shipped definitions. */
export type PlatformBlockReleaseIdentity = Readonly<{
  blockId: string;
  key: string;
  /** The renderer an authored item of this release names as its Puck `type`. */
  rendererKey: string;
  /**
   * Fixed for the life of the block: stored releases pin it. A content change keeps it and moves
   * only `contentFingerprint`, so stored releases read as superseded, never as unregistered.
   */
  releaseVersion: string;
  contentFingerprint: string;
}>;

export const PLATFORM_BLOCK_RELEASE_IDENTITIES = Object.freeze({
  CONNECTION_SECRET_INPUT_BLOCK_RELEASE: {
    blockId: "771b25f4-168b-443c-8e9d-b6a1c1673b91",
    key: "platform.form.connection_secret_input",
    rendererKey: "platform.renderer.connection_secret_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:c4e87d0cfda1cd2031bc1e9708f85beb9b5d8399b4a525a35380a348775cf098",
  },
  QUERY_NOTICE_BLOCK_RELEASE: {
    blockId: "69e284dd-e253-484a-8aad-676026eebf0e",
    key: "platform.display.query_notice",
    rendererKey: "platform.renderer.query_notice",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:9f302f38e6d64d6d96b35148e8eccd4f6fe7c4fc223c67038a01ac5a36524d88",
  },
  TEXT_BLOCK_RELEASE: {
    blockId: "addfad00-1b11-4674-83fa-913667f87e79",
    key: "platform.display.text",
    rendererKey: "platform.renderer.text",
    releaseVersion: "1.1.0",
    contentFingerprint: "sha256:94ddc14bc1cab392a0ebb390cf85d02f6b2590705ca5a3d9e2bf5e4f10090bb4",
  },
  RICH_TEXT_BLOCK_RELEASE: {
    blockId: "148f420f-f7db-4145-80f4-3d3fa036096b",
    key: "platform.display.rich_text",
    rendererKey: "platform.renderer.rich_text",
    releaseVersion: "1.1.0",
    contentFingerprint: "sha256:aa0674f73011bbac7d15e961d6e48849153c88050c78dae163a4e1b716d1729c",
  },
  SUMMARY_VALUES_BLOCK_RELEASE: {
    blockId: "b00f7a0f-9094-4186-b8c4-066b1df6c395",
    key: "platform.display.summary_values",
    rendererKey: "platform.renderer.summary_values",
    releaseVersion: "1.1.0",
    contentFingerprint: "sha256:494da7870df296633122af361ab80d61a385ae1cf353604abfbbbf1546c5a1b2",
  },
  TABLE_BLOCK_RELEASE: {
    blockId: "39ab6f28-c166-47cf-91a7-f0b864ded4ff",
    key: "platform.display.table",
    rendererKey: "platform.renderer.table",
    releaseVersion: "2.0.0",
    contentFingerprint: "sha256:6ee99280ae3caabd2f1c1aca1192e58adb90255154098918b2fb73ea49c0f2c8",
  },
  RECORD_DETAIL_BLOCK_RELEASE: {
    blockId: "e2569df0-2f10-4b20-b41d-177b66cd136c",
    key: "platform.display.record_detail",
    rendererKey: "platform.renderer.record_detail",
    releaseVersion: "1.2.0",
    contentFingerprint: "sha256:cbb857bbfd7e27f8d49a4d5dd3b917b54bcb778be992b179e3dd017163c9b743",
  },
  ATTACHMENT_INPUT_BLOCK_RELEASE: {
    blockId: "9cd96c38-95a1-4bd4-bfaa-0e20c4acb1b9",
    key: "platform.form.attachment_input",
    rendererKey: "platform.renderer.attachment_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:4f261ebb0ef8901d9038ad20d6d34af4e73fffd72c53573a91935cb72c60fc33",
  },
  TABLE_INPUT_BLOCK_RELEASE: {
    blockId: "f40dc797-ac89-4687-8aa2-157c639be233",
    key: "platform.form.table_input",
    rendererKey: "platform.renderer.table_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:5f90043d71edf461a76ad9777d4b0258be567cb08651d7e532a8d652785f6a1f",
  },
  TEXT_INPUT_BLOCK_RELEASE: {
    blockId: "15b2d6f6-228d-4248-84be-1f8f45e204fc",
    key: "platform.form.text_input",
    rendererKey: "platform.renderer.text_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:8467c5148c7d8a695617dc00945c280c5ef90081dacb50dbc3ad141602fe7b55",
  },
  NUMBER_INPUT_BLOCK_RELEASE: {
    blockId: "c8645b41-48b5-489c-bd2e-02283535a7c5",
    key: "platform.form.number_input",
    rendererKey: "platform.renderer.number_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:017849048f8017a678d489047c72e3db11916e340ad4c41d789711e8e1bf22bb",
  },
  BOOLEAN_INPUT_BLOCK_RELEASE: {
    blockId: "e9418c36-3234-4806-a05a-0f259482238d",
    key: "platform.form.boolean_input",
    rendererKey: "platform.renderer.boolean_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:f0214da620cec34b532c147ae0cdcac2e1250cdc4f211af7aeea37a755392b95",
  },
  DATE_INPUT_BLOCK_RELEASE: {
    blockId: "a5610880-05be-426b-a82b-7f3b645bf255",
    key: "platform.form.date_input",
    rendererKey: "platform.renderer.date_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:1e280d9713033f2287966a37447d5675f11b59aa9c3dfd548b674fb91750b8d6",
  },
  CHOICE_INPUT_BLOCK_RELEASE: {
    blockId: "2bd013f9-48ad-43d3-a6eb-7fc3c130cf87",
    key: "platform.form.choice_input",
    rendererKey: "platform.renderer.choice_input",
    releaseVersion: "1.2.0",
    contentFingerprint: "sha256:83af712aa238c98aba183bdb24f06569191a85fe71f201620fca953bac794004",
  },
  VALIDATION_MESSAGE_BLOCK_RELEASE: {
    blockId: "78acc234-87bc-4e8f-986f-4857369b41f8",
    key: "platform.form.validation_message",
    rendererKey: "platform.renderer.validation_message",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:106f3516680760726c68d87920daf15e89343e27a617d66663c6ed9ba8e25549",
  },
  BUTTON_BLOCK_RELEASE: {
    blockId: "c6fb63eb-fdf4-4fdf-954d-7610aad7be1b",
    key: "platform.action.button",
    rendererKey: "platform.renderer.button",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:358437ac2256835ad0e02af1078adf4f64537c5b74a47cb0a66792f49999cdac",
  },
  TABS_BLOCK_RELEASE: {
    blockId: "a3b7065b-47ef-4c92-93d1-59300f8b059c",
    key: "platform.layout.tabs",
    rendererKey: "platform.renderer.tabs",
    releaseVersion: "2.0.0",
    contentFingerprint: "sha256:4cefa70077be01c867c1e5d52324c677db4959be8b8de9bdbd87fe336511bff1",
  },
  DIALOG_BLOCK_RELEASE: {
    blockId: "651460f1-5fce-4443-bc9d-4dd4b6ae8a8b",
    key: "platform.layout.dialog",
    rendererKey: "platform.renderer.dialog",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:ffa6286afd9c966f94d528f362d932589c6b7b45f92a96f916b1603fa11e916a",
  },
  DRAWER_BLOCK_RELEASE: {
    blockId: "a399ff74-5716-4411-bca8-c5ab87ec2e7d",
    key: "platform.layout.drawer",
    rendererKey: "platform.renderer.drawer",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:a9172b92f6d7545895ad8014c18185c268a985b4a21f286f0b73d0ed295776ac",
  },
  APPLICATION_NAVIGATION_BLOCK_RELEASE: {
    blockId: "e2f4a1b7-3c58-4d09-9e62-1a7b5c8d0f24",
    key: "platform.layout.application_navigation",
    rendererKey: "platform.renderer.application_navigation",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:bd7889b1ce20ef2a50e5cc4635d5450569f30c158b602da236ae444306f1241d",
  },
  APPLICATION_ACCOUNT_ACTIONS_BLOCK_RELEASE: {
    blockId: "9f8eaf39-8d16-47ef-9ef6-f22b1c9a5421",
    key: "platform.navigation.account_actions",
    rendererKey: "platform.renderer.account_actions",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:1e4b88f3dd1ff831119958a301bae7a62bcafc5405110fbc08625492b1634457",
  },
  APPLICATION_SEARCH_BLOCK_RELEASE: {
    blockId: "d5ecf8af-a6c4-4f0a-93e1-2c6d0a56a726",
    key: "platform.navigation.application_search",
    rendererKey: "platform.renderer.application_search",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:4dc1c3bb6b8ec8e199080dc0dcbf70d78aaa1d8835456c67b178a977c42fefc6",
  },
  FORM_CONTAINER_BLOCK_RELEASE: {
    blockId: "476e2c35-07d6-40cc-bf01-6ddb22ccca44",
    key: "platform.form.container",
    rendererKey: "platform.renderer.form_container",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:9f616aed26e18ed7766b31fbeefaa536c6e33e76ade9a781833a976441b60e4d",
  },
  LINK_INPUT_BLOCK_RELEASE: {
    blockId: "8d1b6a2f-4c3e-4f0a-9c2b-6f1d2e7a5b94",
    key: "platform.form.link_input",
    rendererKey: "platform.renderer.link_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:0725583c2ff0558ef8569e0ca571ac43da2abfba3b5ca3f87022af1f979cc920",
  },
  RICH_TEXT_INPUT_BLOCK_RELEASE: {
    blockId: "6f2c8d94-1a7b-4e53-8d90-3c5e7b1a4f28",
    key: "platform.form.rich_text_input",
    rendererKey: "platform.renderer.rich_text_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:44f134de5c9eee7077a47a0b620ca9d3fbfde4e405a4ebf95e658d19ef599e8e",
  },
  FIELD_INPUT_BLOCK_RELEASE: {
    blockId: "9c4e7a52-6b18-4d3f-8e21-5a7c0d9f2b64",
    key: "platform.form.field_input",
    rendererKey: "platform.renderer.field_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:e194411957409f0055b80698fd850e9fd3d872f396f17707f29d8327bcf223e1",
  },
  APPLICATION_LAUNCHER_BLOCK_RELEASE: {
    blockId: "b1a7c2e4-5d3f-4a91-8c26-0e7f4b9a1d33",
    key: "platform.launcher.application_launcher",
    rendererKey: "platform.renderer.application_launcher",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:5188f037652aa608a34612eb98e02dbc4b890d938c619067015d564d97108ed4",
  },
  LINK_TILES_BLOCK_RELEASE: {
    blockId: "c4d9e1f2-7a68-4c05-9b3d-5f2a8e6c0b47",
    key: "platform.launcher.link_tiles",
    rendererKey: "platform.renderer.link_tiles",
    releaseVersion: "1.2.0",
    contentFingerprint: "sha256:0b82c03cd8bdd449ec5f774ce52cb557ddb7d8dcf39545081c3b90c774a9d252",
  },
  CALENDAR_BLOCK_RELEASE: {
    blockId: "d1125b70-e83b-4fc6-bf60-7a6e36f5f56a",
    key: "platform.display.calendar",
    rendererKey: "platform.renderer.calendar",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:7bf74fc10b85d5e3c2ce26590c2894b45fc7298bb70ac25d3589dc097de54b27",
  },
  CONTAINER_BLOCK_RELEASE: {
    blockId: "11d1a889-531f-4880-a1a4-5dda5289e5ff",
    key: "platform.layout.container",
    rendererKey: "platform.renderer.container",
    releaseVersion: "1.3.0",
    contentFingerprint: "sha256:0f631c71bd643955b8b106b881455baaaa314940ffd22cc1fddd84fef846e93c",
  },
  ATTACHMENT_LIST_BLOCK_RELEASE: {
    blockId: "39217bcc-8fd1-4825-afca-e97598a13f0a",
    key: "platform.display.attachment_list",
    rendererKey: "platform.renderer.attachment_list",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:83dae523c3fd917cfd69152feabd8383a9c81585dacbb5ef5e0dfbc7ca6eb7a3",
  },
  NOTICE_BLOCK_RELEASE: {
    blockId: "a7c95d9b-3fc2-4e6c-bebb-7a62fa912d84",
    key: "platform.display.notice",
    rendererKey: "platform.renderer.notice",
    releaseVersion: "1.1.0",
    contentFingerprint: "sha256:c75f8b610036e9934daa8d149ef08ff366b188e9084124200bfb1b406f912e7e",
  },
  HEADING_BLOCK_RELEASE: {
    blockId: "78bfeead-a38d-424a-81b9-7cd553b92bcc",
    key: "platform.layout.heading",
    rendererKey: "platform.renderer.heading",
    releaseVersion: "1.1.0",
    contentFingerprint: "sha256:cf7d8986653b4bea5ac56cb533c4eb67084907a2904e6e4c8a29fb74384f2bcc",
  },
  CHART_BLOCK_RELEASE: {
    blockId: "5e7d5839-04fe-4b33-93c7-a382521a74b8",
    key: "platform.display.chart",
    rendererKey: "platform.renderer.chart",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:fc1165677482f080f2205d7dc0605efdb4a1778543ff1efdcba158f9bf487b0f",
  },
} as const);
