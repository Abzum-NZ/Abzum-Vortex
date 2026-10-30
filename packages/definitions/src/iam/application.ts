import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  defaultOpenFlowSource,
  defaultOperationFlowSource,
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
    {
      ...defaultOperationFlowSource({
        id: "flow_retire_role",
        key: "retire_role",
        operation: "platform.retire_role",
        inputs: {
          role_id: {
            type: "record_reference",
            required: true,
            recordTypeIds: ["vortex.system_directory:role"],
          },
          expected_role_revision: { type: "whole_number", required: true },
        },
        returnsResult: true,
        done: "Role retired.",
      }),
      labels: { name: "Retire role" },
    },
    {
      ...defaultOperationFlowSource({
        id: "flow_create_group",
        key: "create_group",
        operation: "platform.create_group",
        inputs: {
          group_key: { type: "text", required: true },
          label: { type: "text", required: true },
        },
        returnsResult: true,
        done: "Group created.",
      }),
      labels: { name: "Create group" },
    },
    {
      ...defaultOperationFlowSource({
        id: "flow_retire_group",
        key: "retire_group",
        operation: "platform.retire_group",
        inputs: {
          group_id: {
            type: "record_reference",
            required: true,
            recordTypeIds: ["vortex.system_directory:group"],
          },
          expected_group_revision: { type: "whole_number", required: true },
        },
        returnsResult: true,
        done: "Group retired.",
      }),
      labels: { name: "Retire group" },
    },
    {
      ...defaultOperationFlowSource({
        id: "flow_remove_group_membership",
        key: "remove_group_membership",
        operation: "platform.remove_group_membership",
        inputs: {
          membership_id: {
            type: "record_reference",
            required: true,
            recordTypeIds: ["vortex.system_directory:group_membership"],
          },
          expected_membership_revision: { type: "whole_number", required: true },
        },
        returnsResult: true,
        done: "Membership removed.",
      }),
      labels: { name: "Remove group membership" },
    },
    {
      ...defaultOperationFlowSource({
        id: "flow_revoke_role_assignment",
        key: "revoke_role_assignment",
        operation: "platform.revoke_role_assignment",
        inputs: {
          role_assignment_id: {
            type: "record_reference",
            required: true,
            recordTypeIds: ["vortex.system_directory:role_assignment"],
          },
          expected_assignment_revision: { type: "whole_number", required: true },
        },
        returnsResult: true,
        done: "Role assignment revoked.",
      }),
      labels: { name: "Revoke role assignment" },
    },
    {
      ...defaultOperationFlowSource({
        id: "flow_deactivate_role_activation",
        key: "deactivate_role_activation",
        operation: "platform.deactivate_role_activation",
        inputs: {
          role_activation_id: {
            type: "record_reference",
            required: true,
            recordTypeIds: ["vortex.system_directory:role_activation"],
          },
          expected_activation_revision: { type: "whole_number", required: true },
        },
        returnsResult: true,
        done: "Role activation deactivated.",
      }),
      labels: { name: "Deactivate role activation" },
    },
    {
      ...defaultOperationFlowSource({
        id: "flow_revoke_delegation_authority",
        key: "revoke_delegation_authority",
        operation: "platform.revoke_delegation_authority",
        inputs: {
          delegation_authority_id: {
            type: "record_reference",
            required: true,
            recordTypeIds: ["vortex.system_directory:delegation"],
          },
          expected_delegation_revision: { type: "whole_number", required: true },
        },
        returnsResult: true,
        done: "Delegation authority revoked.",
      }),
      labels: { name: "Revoke delegation authority" },
    },
  ],
);
