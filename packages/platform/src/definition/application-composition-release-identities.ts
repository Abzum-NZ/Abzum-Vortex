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
    contentFingerprint: "sha256:632e0a37fbe3ca99f4e91ecd90033022622a37c41a917d49b12778dc023ce2df",
  },
  QUERY_NOTICE_BLOCK_RELEASE: {
    blockId: "69e284dd-e253-484a-8aad-676026eebf0e",
    key: "platform.display.query_notice",
    rendererKey: "platform.renderer.query_notice",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:1c773307f41633b262926a1f4c8660f7ae42a9e9b9c5c78d7fc7af34192feb9c",
  },
  TEXT_BLOCK_RELEASE: {
    blockId: "addfad00-1b11-4674-83fa-913667f87e79",
    key: "platform.display.text",
    rendererKey: "platform.renderer.text",
    releaseVersion: "1.1.0",
    contentFingerprint: "sha256:f2f6fab248162ebc17f5e30949d1f8b05ef761fd9e2656066cd2803e35dcf6dc",
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
    contentFingerprint: "sha256:c78ad61bd8e78e73b6f6d3391b993462bfa787211b67e245f5164cfc3bb2a59e",
  },
  TABLE_BLOCK_RELEASE: {
    blockId: "39ab6f28-c166-47cf-91a7-f0b864ded4ff",
    key: "platform.display.table",
    rendererKey: "platform.renderer.table",
    releaseVersion: "2.0.0",
    contentFingerprint: "sha256:28f525f014b89e7ffd69fcb0466efa910e6b364c26204d45d0db8ef852a607af",
  },
  RECORD_DETAIL_BLOCK_RELEASE: {
    blockId: "e2569df0-2f10-4b20-b41d-177b66cd136c",
    key: "platform.display.record_detail",
    rendererKey: "platform.renderer.record_detail",
    releaseVersion: "1.2.0",
    contentFingerprint: "sha256:5ae17299f723a50e16cd3b1665e578cc0a6f35e1c1b9349a2cfff89121818c07",
  },
  ATTACHMENT_INPUT_BLOCK_RELEASE: {
    blockId: "9cd96c38-95a1-4bd4-bfaa-0e20c4acb1b9",
    key: "platform.form.attachment_input",
    rendererKey: "platform.renderer.attachment_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:be7cdc91fbe56c059d412981d7a886eaf0af51169fb1781fd2eed34064e8564d",
  },
  TABLE_INPUT_BLOCK_RELEASE: {
    blockId: "f40dc797-ac89-4687-8aa2-157c639be233",
    key: "platform.form.table_input",
    rendererKey: "platform.renderer.table_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:4a57b96306fc9d2ed7980904047f41669eb42afe97420e5619ad468b9387f3de",
  },
  TEXT_INPUT_BLOCK_RELEASE: {
    blockId: "15b2d6f6-228d-4248-84be-1f8f45e204fc",
    key: "platform.form.text_input",
    rendererKey: "platform.renderer.text_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:c8973a7dd66578f446a6dc51e201a17b3f52bca7719ddb50344720a8a4d7d3a8",
  },
  NUMBER_INPUT_BLOCK_RELEASE: {
    blockId: "c8645b41-48b5-489c-bd2e-02283535a7c5",
    key: "platform.form.number_input",
    rendererKey: "platform.renderer.number_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:dc38ad6a15ca599ebc6745bef916f4bafab29e50cedd0b8fff1525c71da70117",
  },
  BOOLEAN_INPUT_BLOCK_RELEASE: {
    blockId: "e9418c36-3234-4806-a05a-0f259482238d",
    key: "platform.form.boolean_input",
    rendererKey: "platform.renderer.boolean_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:0767bf7658f447907cf3b5df0cdb3b6fa0f5eb3d08728291052ee18834a3c960",
  },
  DATE_INPUT_BLOCK_RELEASE: {
    blockId: "a5610880-05be-426b-a82b-7f3b645bf255",
    key: "platform.form.date_input",
    rendererKey: "platform.renderer.date_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:3eb79db8659e321dd1f6d3c63a10bd9919e2af86eb9247156fc209b9e49a1375",
  },
  CHOICE_INPUT_BLOCK_RELEASE: {
    blockId: "2bd013f9-48ad-43d3-a6eb-7fc3c130cf87",
    key: "platform.form.choice_input",
    rendererKey: "platform.renderer.choice_input",
    releaseVersion: "1.2.0",
    contentFingerprint: "sha256:79f9c8ab1539d251d5ec324343cb59941307cf3df620dd22eb28d30e9998d720",
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
    contentFingerprint: "sha256:91c38cb06dcd25b984e0ee9be8c74953a7797ef097b89916463cbcc11733a30e",
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
    contentFingerprint: "sha256:b7dfdf694f55270ce5b200c471432376d41e2f5a5f90d4e7bac142b27e590986",
  },
  LINK_INPUT_BLOCK_RELEASE: {
    blockId: "8d1b6a2f-4c3e-4f0a-9c2b-6f1d2e7a5b94",
    key: "platform.form.link_input",
    rendererKey: "platform.renderer.link_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:002dc4af413bfbd6ca1d8e5d814be9c25d8c151789453efa86f55c3b79e4646d",
  },
  RICH_TEXT_INPUT_BLOCK_RELEASE: {
    blockId: "6f2c8d94-1a7b-4e53-8d90-3c5e7b1a4f28",
    key: "platform.form.rich_text_input",
    rendererKey: "platform.renderer.rich_text_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:1791a0ca5822b4fbee6c3522e6b091e65e6fcd31b88ba5ee75b84cb99537046e",
  },
  FIELD_INPUT_BLOCK_RELEASE: {
    blockId: "9c4e7a52-6b18-4d3f-8e21-5a7c0d9f2b64",
    key: "platform.form.field_input",
    rendererKey: "platform.renderer.field_input",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:2caeac7404979528f2417ba174a39298805347e00b92e0b7f24ffa9c60d82af4",
  },
  APPLICATION_LAUNCHER_BLOCK_RELEASE: {
    blockId: "b1a7c2e4-5d3f-4a91-8c26-0e7f4b9a1d33",
    key: "platform.launcher.application_launcher",
    rendererKey: "platform.renderer.application_launcher",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:29c7aa6c1e1584504d7855d1b86f160b1430aabf22e2da73eb6a59ad3ce6ccdc",
  },
  LINK_TILES_BLOCK_RELEASE: {
    blockId: "c4d9e1f2-7a68-4c05-9b3d-5f2a8e6c0b47",
    key: "platform.launcher.link_tiles",
    rendererKey: "platform.renderer.link_tiles",
    releaseVersion: "1.2.0",
    contentFingerprint: "sha256:dacfce95b0c44888edfe7af9e6015a1b61fb28967a1eb829c0e56d866a52dcd2",
  },
  CALENDAR_BLOCK_RELEASE: {
    blockId: "d1125b70-e83b-4fc6-bf60-7a6e36f5f56a",
    key: "platform.display.calendar",
    rendererKey: "platform.renderer.calendar",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:9744ab9430d250a0a70df387813ebcbbfcb6b09ecae11b53d93c1bf467263b19",
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
    contentFingerprint: "sha256:2f97cfb8af695d9636da5ff91883bb9cf8b95647645796e0f9f34f9f90b7d2e6",
  },
} as const);
