import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  defaultOpenFlowSource,
  defaultSaveFlowSource,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";
import { iamModule } from "./module";

const accessRequest = "vortex.iam.core:access_request";

/** IAM's current Application source; all placements use the shared registered block catalogue. */
export const iamApplication: ApplicationSourceDocument = loadApplicationSource(
  authoredSource,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  [iamModule],
  [
    {
      ...defaultSaveFlowSource({
        id: "flow_access_request_create",
        key: "access_request_create",
        recordType: accessRequest,
        mode: "create",
        ownershipMode: "none",
        form: "iam_access_request_new_form",
        after: { kind: "navigate", page: "iam_access_request_detail", withRecord: true },
      }),
      labels: { name: "Submit access request" },
    },
    {
      ...defaultSaveFlowSource({
        id: "flow_access_request_update",
        key: "access_request_update",
        recordType: accessRequest,
        mode: "update",
        ownershipMode: "none",
        form: "iam_access_request_edit_form",
        after: { kind: "navigate", page: "iam_access_request_detail", withRecord: true },
      }),
      labels: { name: "Save access request" },
    },
    {
      ...defaultOpenFlowSource({
        id: "iam_open_access_request",
        key: "iam_open_access_request",
        description:
          "Opens the clicked access request's own detail page with the record identity the clicked row carries.",
        page: "iam_access_request_detail",
        recordType: accessRequest,
      }),
      labels: { name: "Open access request" },
    },
    {
      ...defaultOpenFlowSource({
        id: "iam_open_person",
        key: "iam_open_person",
        description:
          "Opens the clicked person's own detail page with the record identity the clicked row carries.",
        page: "iam_person_detail",
        recordType: "vortex.system_directory:person",
      }),
      labels: { name: "Open person" },
    },
    {
      ...defaultOpenFlowSource({
        id: "navigate_new_access_request",
        key: "navigate_new_access_request",
        description: "Opens the access request creation form.",
        page: "iam_access_request_new",
      }),
      labels: { name: "New access request" },
    },
    {
      ...defaultOpenFlowSource({
        id: "navigate_edit_access_request",
        key: "navigate_edit_access_request",
        description: "Opens the current access request in the edit form.",
        page: "iam_access_request_edit",
        recordType: accessRequest,
      }),
      labels: { name: "Edit" },
    },
  ],
);
