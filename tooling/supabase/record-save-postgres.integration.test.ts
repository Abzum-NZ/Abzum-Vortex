import {
  applicationDefinitionConsumerReadResultV1Schema,
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  definitionSourceDocumentSchema,
  moduleDefinitionConsumerReadResultV2Schema,
  moduleSourceDocumentV2Schema,
  sessionContextSchema,
  type DefinitionResolutionSnapshot,
  type IdentitySession,
  type ModuleSourceDocumentV2,
  type SessionContext,
} from "../../contracts/src/index";
import type { DatabaseRow, DatabaseValue } from "../../db/src/index";
import { createResolvedRequestTransactionRunner } from "../../db/src/request-transaction";
import {
  createStoredApplicationPermissionSource,
  prepareOrganizationRoleChangeEvidence,
  type StoredApplicationPermissionSourceDependencies,
} from "../../runtime/access/src/index";
import {
  compileDefinition,
  extractSourceIdentityRequirements,
  fingerprintCanonicalValue,
} from "../../runtime/definition/src/index";
import { createNamedActionService, createRecordSaveService } from "../../runtime/record/src/index";
import postgres, { type Row, type Sql, type TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.VORTEX_TEST_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const id = (value: number) => `a4470000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const tenantId = id(1);
const organizationId = id(2);
const actorId = id(3);
const identityAuthorityId = id(4);
const identityId = id(5);
const organizationAccountId = id(6);
const otherIdentityId = id(172);
const otherOrganizationAccountId = id(173);
const foreignTenantId = id(174);
const foreignOrganizationId = id(175);
const foreignOrganizationAccountId = id(176);
const wrongApplicationRootId = id(177);
const moduleRootId = id(7);
const applicationRootId = id(8);
const roleId = id(9);
const roleAssignmentId = id(10);
const fixtureCorrelationId = id(11);
const commandCreateId = id(12);
const commandUpdateId = id(13);
const activityCreateId = id(14);
const activityUpdateId = id(15);
const occurrenceCreateId = id(16);
const occurrenceUpdateId = id(17);
const commandRevokedWriteId = id(29);
const activityReplayId = id(30);
const activityConflictId = id(31);
const activityRevokedReplayId = id(32);
const activityRevokedWriteId = id(33);
const commandFreshId = id(34);
const activityFreshId = id(35);
const activityFreshReplayId = id(36);
const occurrenceFreshId = id(37);
const commandMissingSettingsId = id(38);
const activityMissingSettingsId = id(39);
const commandExplicitMoneyId = id(40);
const activityExplicitMoneyId = id(41);
const occurrenceExplicitMoneyId = id(42);
const commandGeneratedInputId = id(43);
const activityGeneratedInputId = id(44);
const commandParentOneId = id(45);
const commandParentTwoId = id(46);
const commandChildCreateId = id(47);
const commandChildUpdateId = id(48);
const commandChildFilterId = id(49);
const commandChildMoveId = id(50);
const activityParentOneId = id(51);
const activityParentTwoId = id(52);
const activityChildCreateId = id(53);
const activityChildUpdateId = id(54);
const activityChildFilterId = id(55);
const activityChildMoveId = id(56);
const occurrenceParentOneId = id(57);
const occurrenceParentTwoId = id(58);
const occurrenceChildCreateId = id(59);
const occurrenceChildUpdateId = id(60);
const occurrenceChildFilterId = id(61);
const occurrenceChildMoveId = id(62);
const commandChildReincludeId = id(63);
const activityChildReincludeId = id(64);
const occurrenceChildReincludeId = id(65);
const activityChildMoveReplayId = id(66);
const activityChildMoveConflictId = id(67);
const commandSecondChildCreateId = id(68);
const activitySecondChildCreateId = id(69);
const occurrenceSecondChildCreateId = id(70);
const commandFirstChildConcurrentId = id(71);
const commandSecondChildConcurrentId = id(72);
const activityFirstChildConcurrentId = id(73);
const activitySecondChildConcurrentId = id(74);
const occurrenceFirstChildConcurrentId = id(75);
const occurrenceSecondChildConcurrentId = id(76);
const commandStaleTotalParentId = id(77);
const activityStaleTotalParentId = id(78);
const commandParentActivityFailureId = id(79);
const activityParentActivityFailureId = id(80);
const occurrenceParentActivityFailureId = id(81);
const commandRuledRelationshipId = id(82);
const activityRuledRelationshipId = id(83);
const commandOverlappingReplayId = id(85);
const activityOverlappingReplayOneId = id(86);
const activityOverlappingReplayTwoId = id(87);
const occurrenceOverlappingReplayId = id(88);
const commandUnjoinedWriterId = id(89);
const activityUnjoinedWriterId = id(90);
const occurrenceUnjoinedWriterId = id(91);
const commandRecursiveGrandId = id(92);
const activityRecursiveGrandId = id(93);
const occurrenceRecursiveGrandId = id(94);
const commandRecursiveParentId = id(95);
const activityRecursiveParentId = id(96);
const occurrenceRecursiveParentId = id(97);
const commandRecursiveLeafId = id(98);
const activityRecursiveLeafId = id(99);
const occurrenceRecursiveLeafId = id(100);
const commandRecursiveCycleId = id(101);
const activityRecursiveCycleId = id(102);
const commandMoneySourceId = id(103);
const activityMoneySourceId = id(104);
const occurrenceMoneySourceId = id(105);
const commandMixedCurrencyId = id(106);
const activityMixedCurrencyId = id(107);
const commandChangedClosureId = id(108);
const activityChangedClosureId = id(109);
const occurrenceChangedClosureId = id(110);
const commandChangedClosureSetupId = id(111);
const activityChangedClosureSetupId = id(112);
const occurrenceChangedClosureSetupId = id(113);
const commandRuleDeferredTotalId = id(114);
const activityRuleDeferredTotalId = id(115);
const occurrenceRuleDeferredTotalId = id(116);
const commandRuleDeferredFilterId = id(117);
const activityRuleDeferredFilterId = id(118);
const occurrenceRuleDeferredFilterId = id(119);
const commandRuleUnrelatedTitleId = id(120);
const activityRuleUnrelatedTitleId = id(121);
const occurrenceRuleUnrelatedTitleId = id(122);
const commandRuleStableOperandId = id(123);
const activityRuleStableOperandId = id(124);
const occurrenceRuleStableOperandId = id(125);
const activityRuleStableOperandReplayId = id(126);
const activityRuleStableOperandConflictId = id(127);
const commandStaleAccessScopeId = id(128);
const activityStaleAccessScopeId = id(129);
const occurrenceStaleAccessScopeId = id(130);
const commandNamedEventId = id(131);
const commandNamedSetId = id(132);
const commandNamedMixedId = id(133);
const commandNamedRefusalId = id(134);
const commandNamedRollbackId = id(135);
const activityNamedEventId = id(136);
const activityNamedSetId = id(137);
const activityNamedMixedId = id(138);
const activityNamedRefusalId = id(139);
const activityNamedRollbackId = id(140);
const occurrenceNamedSetId = id(141);
const occurrenceNamedMixedStandardId = id(142);
const occurrenceNamedEventId = id(143);
const occurrenceNamedMixedDeclaredId = id(144);
const commandNamedRecordCreateId = id(150);
const activityNamedRecordCreateId = id(151);
const occurrenceNamedRecordCreateId = id(152);
const activityNamedReferenceCreateId = id(208);
const occurrenceNamedReferenceCreateId = id(209);
const commandNamedRaceOneId = id(153);
const commandNamedRaceTwoId = id(154);
const activityNamedRaceOneId = id(155);
const activityNamedRaceTwoId = id(156);
const occurrenceNamedRaceOneId = id(157);
const occurrenceNamedRaceTwoId = id(158);
const publishedAt = "2026-09-13T00:00:00.000Z";

const moduleSource: ModuleSourceDocumentV2 = moduleSourceDocumentV2Schema.parse({
  source_contract_version: "2.0.0",
  kind: "module",
  root_alias: "module_record_save_proof",
  key: "example.record_save_proof",
  body: {
    name: "Record save proof Module",
    description: "Neutral compiled Module for the real Record save service proof.",
    dependencies: [],
    record_types: [
      {
        id: "record_item",
        storage_contract_id: "storage_item",
        key: "item",
        name: "Item",
        plural_name: "Items",
        storage_scope: "application_contained",
        ownership_mode: "none",
        title_field: "title",
        standard_actions: ["create", "read", "update"],
        custom_actions: [
          "action_note",
          "action_set_title",
          "action_set_title_and_note",
          "action_validate_references",
          "action_create_note",
          "action_create_note_for",
          "action_create_restricted_note",
          "action_create_ruled_child",
          "action_note_and_create",
        ],
        fields: [
          {
            id: "field_title",
            key: "title",
            type: "text",
            label: "Title",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { max_length: 120 },
          },
          {
            id: "field_amount",
            key: "amount",
            type: "money",
            label: "Amount",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { currency_mode: "organisation_default", minimum: "0" },
            default: "12.34",
          },
          {
            id: "field_title_copy",
            key: "title_copy",
            type: "calculation",
            label: "Title copy",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: {
              result_type: "text",
              expression: { operation: "join_text", fields: ["title"], separator: "" },
            },
          },
          {
            id: "field_private_source",
            key: "private_source",
            type: "text",
            label: "Private source",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { max_length: 120 },
            default: "private generated source",
          },
          {
            id: "field_private_direct",
            key: "private_direct",
            type: "calculation",
            label: "Private direct",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: {
              result_type: "text",
              expression: { operation: "join_text", fields: ["private_source"], separator: "" },
            },
          },
          {
            id: "field_private_transitive",
            key: "private_transitive",
            type: "calculation",
            label: "Private transitive",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: {
              result_type: "text",
              expression: { operation: "join_text", fields: ["private_direct"], separator: "" },
            },
          },
        ],
        relationships: [],
      },
      {
        id: "record_total_parent",
        storage_contract_id: "storage_total_parent",
        key: "total_parent",
        name: "Total parent",
        plural_name: "Total parents",
        storage_scope: "application_contained",
        ownership_mode: "none",
        title_field: "title",
        standard_actions: ["create", "read", "update"],
        custom_actions: [
          "action_set_total_child_amount",
          "action_add_child",
          "action_set_amount_and_add_sibling",
          "action_create_anchored_note",
        ],
        fields: [
          {
            id: "field_total_parent_title",
            key: "title",
            type: "text",
            label: "Title",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { max_length: 120 },
          },
          {
            id: "field_total_parent_sum",
            key: "included_total",
            type: "total",
            label: "Included total",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: {
              relationship: "example.record_save_proof:total_child.parent",
              operation: "sum",
              result_type: "decimal_number",
              field: "aggregate_amount",
              filter: { field: "included_for_total", operator: "equals", value: true },
            },
          },
          {
            id: "field_total_parent_display",
            key: "display_total",
            type: "calculation",
            label: "Display total",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: {
              result_type: "decimal_number",
              decimal_places: 2,
              expression: {
                operation: "numeric",
                numeric_operation: "add",
                operands: [
                  { source: "field", field: "included_total" },
                  { source: "literal", value: "1" },
                ],
              },
            },
          },
          {
            id: "field_total_parent_money",
            key: "money_total",
            type: "total",
            label: "Money total",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: {
              relationship: "example.record_save_proof:total_child.parent",
              operation: "sum",
              result_type: "money",
              field: "money_amount",
            },
          },
        ],
        relationships: [],
      },
      {
        id: "record_total_child",
        storage_contract_id: "storage_total_child",
        key: "total_child",
        name: "Total child",
        plural_name: "Total children",
        storage_scope: "application_contained",
        ownership_mode: "none",
        title_field: "title",
        standard_actions: ["create", "read", "update"],
        custom_actions: [],
        fields: [
          {
            id: "field_total_child_title",
            key: "title",
            type: "text",
            label: "Title",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { max_length: 120 },
          },
          {
            id: "field_total_child_amount",
            key: "amount",
            type: "decimal_number",
            label: "Amount",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { digits_before_decimal: 20, decimal_places: 6 },
          },
          {
            id: "field_total_child_included",
            key: "included",
            type: "yes_no",
            label: "Included",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: {},
          },
          {
            id: "field_total_child_filter_operand",
            key: "filter_operand",
            type: "decimal_number",
            label: "Filter operand",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: { digits_before_decimal: 20, decimal_places: 6 },
          },
          {
            id: "field_total_child_amount_step_one",
            key: "amount_step_one",
            type: "calculation",
            label: "Amount step one",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: {
              result_type: "decimal_number",
              decimal_places: 6,
              expression: {
                operation: "numeric",
                numeric_operation: "add",
                operands: [
                  { source: "field", field: "amount" },
                  { source: "literal", value: "0" },
                ],
              },
            },
          },
          {
            id: "field_total_child_aggregate_amount",
            key: "aggregate_amount",
            type: "calculation",
            label: "Aggregate amount",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: {
              result_type: "decimal_number",
              decimal_places: 6,
              expression: {
                operation: "numeric",
                numeric_operation: "add",
                operands: [
                  { source: "field", field: "amount_step_one" },
                  { source: "literal", value: "0" },
                ],
              },
            },
          },
          {
            id: "field_total_child_included_for_total",
            key: "included_for_total",
            type: "calculation",
            label: "Included for total",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: {
              result_type: "yes_no",
              expression: {
                operation: "condition",
                condition: {
                  field: "filter_operand",
                  operator: "greater_than",
                  value: "0",
                },
              },
            },
          },
          {
            id: "field_total_child_money",
            key: "money_amount",
            type: "money",
            label: "Money amount",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { currency_mode: "organisation_default", minimum: "0" },
          },
          {
            id: "field_total_child_parent",
            key: "parent",
            type: "link",
            label: "Parent",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: {
              target: "example.record_save_proof:total_parent",
              reverse_key: "children",
              on_parent_delete: "empty_optional",
            },
          },
        ],
        relationships: [
          {
            id: "relationship_total_parent",
            key: "parent",
            from_field: "parent",
            to_record_type: "example.record_save_proof:total_parent",
            cardinality: "many_to_one",
            on_parent_delete: "empty_optional",
          },
        ],
      },
      {
        id: "record_ruled_child",
        storage_contract_id: "storage_ruled_child",
        key: "ruled_child",
        name: "Ruled child",
        plural_name: "Ruled children",
        storage_scope: "application_contained",
        ownership_mode: "none",
        title_field: "title",
        standard_actions: ["create", "read", "update"],
        custom_actions: [],
        fields: [
          {
            id: "field_ruled_child_title",
            key: "title",
            type: "text",
            label: "Title",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { max_length: 120 },
          },
          {
            id: "field_ruled_child_parent",
            key: "parent",
            type: "link",
            label: "Unrelated parent",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: {
              target: "example.record_save_proof:total_parent",
              reverse_key: "ruled_children",
              on_parent_delete: "empty_optional",
            },
          },
        ],
        relationships: [
          {
            id: "relationship_ruled_parent",
            key: "parent",
            from_field: "parent",
            to_record_type: "example.record_save_proof:total_parent",
            cardinality: "many_to_one",
            on_parent_delete: "empty_optional",
          },
        ],
      },
      {
        id: "record_recursive_total",
        storage_contract_id: "storage_recursive_total",
        key: "recursive_total",
        name: "Recursive total",
        plural_name: "Recursive totals",
        storage_scope: "application_contained",
        ownership_mode: "none",
        title_field: "title",
        standard_actions: ["create", "read", "update"],
        custom_actions: [],
        fields: [
          {
            id: "field_recursive_title",
            key: "title",
            type: "text",
            label: "Title",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { max_length: 120 },
          },
          {
            id: "field_recursive_children_total",
            key: "children_total",
            type: "total",
            label: "Children total",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: {
              relationship: "example.record_save_proof:recursive_total.parent",
              operation: "sum",
              result_type: "decimal_number",
              field: "children_total",
            },
          },
          {
            id: "field_recursive_parent",
            key: "parent",
            type: "link",
            label: "Parent",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: {
              target: "example.record_save_proof:recursive_total",
              reverse_key: "children",
              on_parent_delete: "empty_optional",
            },
          },
        ],
        relationships: [
          {
            id: "relationship_recursive_parent",
            key: "parent",
            from_field: "parent",
            to_record_type: "example.record_save_proof:recursive_total",
            cardinality: "many_to_one",
            on_parent_delete: "empty_optional",
          },
        ],
      },
      {
        id: "record_created_note",
        storage_contract_id: "storage_created_note",
        key: "created_note",
        name: "Created note",
        plural_name: "Created notes",
        storage_scope: "application_contained",
        ownership_mode: "none",
        title_field: "title",
        standard_actions: ["create", "read", "update"],
        custom_actions: [],
        fields: [
          {
            id: "field_created_note_title",
            key: "title",
            type: "text",
            label: "Title",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { max_length: 120 },
          },
          {
            id: "field_created_note_body",
            key: "body",
            type: "text",
            label: "Body",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { max_length: 120 },
          },
          {
            id: "field_created_note_reference",
            key: "reference",
            type: "reference_number",
            label: "Reference",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { prefix: "NOTE-", digits: 5 },
          },
          {
            id: "field_created_note_person",
            key: "person",
            type: "link_to_person",
            label: "Person",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: {
              audience: "organisation_accounts",
              application_root_required: false,
              on_person_deactivation: "retain_reference",
            },
          },
          {
            id: "field_created_note_at",
            key: "at",
            type: "date_time",
            label: "At",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: { display_time_zone: "organisation" },
          },
          {
            id: "field_created_note_amount",
            key: "amount",
            type: "money",
            label: "Amount",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { currency_mode: "organisation_default", minimum: "0" },
          },
          {
            id: "field_created_note_restricted",
            key: "restricted",
            type: "text",
            label: "Restricted",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { max_length: 120 },
          },
          {
            id: "field_created_note_anchor",
            key: "anchor",
            type: "link",
            label: "Anchor",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: {
              target: "example.record_save_proof:total_parent",
              reverse_key: "anchored_notes",
              on_parent_delete: "empty_optional",
            },
          },
          {
            id: "field_created_note_source",
            key: "source",
            type: "link",
            label: "Source",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            settings: {
              target: "example.record_save_proof:item",
              reverse_key: "created_notes",
              on_parent_delete: "empty_optional",
            },
          },
        ],
        relationships: [
          {
            id: "relationship_created_note_anchor",
            key: "anchor",
            from_field: "anchor",
            to_record_type: "example.record_save_proof:total_parent",
            cardinality: "many_to_one",
            on_parent_delete: "empty_optional",
          },
          {
            id: "relationship_created_note_source",
            key: "source",
            from_field: "source",
            to_record_type: "example.record_save_proof:item",
            cardinality: "many_to_one",
            on_parent_delete: "empty_optional",
          },
        ],
      },
    ],
    permissions: [
      {
        id: "permission_create",
        key: "example.record_save_proof.item.create",
        label: "Create item",
        description: "Create a neutral proof item.",
        record_type: "item",
        action_kind: "create",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: {
          readable_fields: [
            "title",
            "amount",
            "title_copy",
            "private_direct",
            "private_transitive",
          ],
          changeable_fields: ["title", "amount"],
        },
      },
      {
        id: "permission_read",
        key: "example.record_save_proof.item.read",
        label: "Read item",
        description: "Read a neutral proof item.",
        record_type: "item",
        action_kind: "read",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: {
          readable_fields: [
            "title",
            "amount",
            "title_copy",
            "private_direct",
            "private_transitive",
          ],
          changeable_fields: [],
        },
      },
      {
        id: "permission_update",
        key: "example.record_save_proof.item.update",
        label: "Update item",
        description: "Update a neutral proof item.",
        record_type: "item",
        action_kind: "update",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: {
          readable_fields: [
            "title",
            "amount",
            "title_copy",
            "private_direct",
            "private_transitive",
          ],
          changeable_fields: ["title", "amount"],
        },
      },
      {
        id: "permission_note",
        key: "example.record_save_proof.item.note",
        label: "Note item",
        description: "Run the unused named proof action.",
        record_type: "item",
        action_kind: "named",
        named_action: "note",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title", "amount"], changeable_fields: [] },
      },
      {
        id: "permission_set_title",
        key: "example.record_save_proof.item.set_title",
        label: "Set item title",
        description: "Run the named title update proof action.",
        record_type: "item",
        action_kind: "named",
        named_action: "set_title",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title", "title_copy"], changeable_fields: ["title"] },
      },
      {
        id: "permission_set_title_and_note",
        key: "example.record_save_proof.item.set_title_and_note",
        label: "Set and note item",
        description: "Run the mixed named action proof.",
        record_type: "item",
        action_kind: "named",
        named_action: "set_title_and_note",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title", "title_copy"], changeable_fields: ["title"] },
      },
      {
        id: "permission_validate_references",
        key: "example.record_save_proof.item.validate_references",
        label: "Validate item references",
        description: "Run the named reference-validation proof action.",
        record_type: "item",
        action_kind: "named",
        named_action: "validate_references",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title"], changeable_fields: [] },
      },
      {
        id: "permission_set_total_child_amount",
        key: "example.record_save_proof.total_child.set_amount",
        label: "Set total child amount",
        description: "Run the named parent-total proof action.",
        record_type: "total_child",
        action_kind: "named",
        named_action: "set_amount",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: {
          readable_fields: [
            "title",
            "amount",
            "included",
            "filter_operand",
            "amount_step_one",
            "aggregate_amount",
            "included_for_total",
            "money_amount",
            "parent",
          ],
          changeable_fields: ["amount"],
        },
      },
      {
        id: "permission_create_note",
        key: "example.record_save_proof.item.create_note",
        label: "Create a note for an item",
        description: "Run the named create_record proof action.",
        record_type: "item",
        action_kind: "named",
        named_action: "create_note",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title", "amount"], changeable_fields: [] },
      },
      {
        id: "permission_create_note_for",
        key: "example.record_save_proof.item.create_note_for",
        label: "Create a note for a chosen item",
        description: "Run the named create_record proof action over a declared link input.",
        record_type: "item",
        action_kind: "named",
        named_action: "create_note_for",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title"], changeable_fields: [] },
      },
      {
        id: "permission_note_and_create",
        key: "example.record_save_proof.item.note_and_create",
        label: "Set, create and note an item",
        description: "Run the mixed set_field, create_record and announce_event proof action.",
        record_type: "item",
        action_kind: "named",
        named_action: "note_and_create",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title", "title_copy"], changeable_fields: ["title"] },
      },
      {
        id: "permission_create_restricted_note",
        key: "example.record_save_proof.item.create_restricted_note",
        label: "Create a restricted note",
        description: "Run the named create_record proof action outside the create field bounds.",
        record_type: "item",
        action_kind: "named",
        named_action: "create_restricted_note",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title"], changeable_fields: [] },
      },
      {
        id: "permission_create_ruled_child",
        key: "example.record_save_proof.item.create_ruled_child",
        label: "Create a ruled child",
        description: "Run the named create_record proof action without target create authority.",
        record_type: "item",
        action_kind: "named",
        named_action: "create_ruled_child",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title"], changeable_fields: [] },
      },
      {
        id: "permission_create_anchored_note",
        key: "example.record_save_proof.total_parent.create_anchored_note",
        label: "Create an anchored note",
        description: "Run the create_record proof action used by the mixed-path race.",
        record_type: "total_parent",
        action_kind: "named",
        named_action: "create_anchored_note",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: {
          readable_fields: ["title", "included_total", "display_total", "money_total"],
          changeable_fields: [],
        },
      },
      {
        id: "permission_add_child",
        key: "example.record_save_proof.total_parent.add_child",
        label: "Add a child to a total parent",
        description: "Run the create-only named proof action whose creation links to its subject.",
        record_type: "total_parent",
        action_kind: "named",
        named_action: "add_child",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: {
          readable_fields: ["title", "included_total", "display_total", "money_total"],
          changeable_fields: [],
        },
      },
      {
        id: "permission_set_amount_and_add_sibling",
        key: "example.record_save_proof.total_child.set_amount_and_add_sibling",
        label: "Set amount and add a sibling",
        description: "Run the mixed set_field plus create_record proof action under one parent.",
        record_type: "total_child",
        action_kind: "named",
        named_action: "set_amount_and_add_sibling",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: {
          readable_fields: [
            "title",
            "amount",
            "included",
            "filter_operand",
            "amount_step_one",
            "aggregate_amount",
            "included_for_total",
            "money_amount",
            "parent",
          ],
          changeable_fields: ["amount"],
        },
      },
      ...(
        ["total_parent", "total_child", "ruled_child", "recursive_total", "created_note"] as const
      ).flatMap((recordType) =>
        (["create", "read", "update"] as const).map((action) => ({
          id: `permission_${recordType}_${action}`,
          key: `example.record_save_proof.${recordType}.${action}`,
          label: `${action} ${recordType}`,
          description: `${action} the transactional total proof ${recordType}.`,
          record_type: recordType,
          action_kind: action,
          administrative: false,
          record_scope: { routes: [{ kind: "all_records" as const }] },
          field_policy: {
            readable_fields:
              recordType === "total_parent"
                ? ["title", "included_total", "display_total", "money_total"]
                : recordType === "total_child"
                  ? [
                      "title",
                      "amount",
                      "included",
                      "filter_operand",
                      "amount_step_one",
                      "aggregate_amount",
                      "included_for_total",
                      "money_amount",
                      "parent",
                    ]
                  : recordType === "ruled_child"
                    ? ["title", "parent"]
                    : recordType === "created_note"
                      ? [
                          "title",
                          "body",
                          "reference",
                          "restricted",
                          "person",
                          "at",
                          "amount",
                          "anchor",
                          "source",
                        ]
                      : ["title", "children_total", "parent"],
            changeable_fields:
              action === "read"
                ? []
                : recordType === "total_parent"
                  ? ["title"]
                  : recordType === "total_child"
                    ? ["title", "amount", "included", "filter_operand", "money_amount", "parent"]
                    : recordType === "ruled_child"
                      ? ["title", "parent"]
                      : recordType === "created_note"
                        ? ["title", "body", "person", "at", "amount", "anchor", "source"]
                        : ["title", "parent"],
          },
        })),
      ),
    ],
    actions: [
      {
        id: "action_note",
        key: "example.record_save_proof.item.note",
        label: "Note item",
        record_type: "item",
        permission: "example.record_save_proof.item.note",
        shareable: false,
        inputs: [],
        effects: [
          {
            kind: "announce_event",
            event: "example.record_save_proof.item.noted",
          },
        ],
      },
      {
        id: "action_set_title",
        key: "example.record_save_proof.item.set_title",
        label: "Set item title",
        record_type: "item",
        permission: "example.record_save_proof.item.set_title",
        shareable: false,
        inputs: [{ key: "title", label: "Title", required: true, type: "text" }],
        effects: [
          { kind: "set_field", field: "title", value: { source: "input", input: "title" } },
        ],
      },
      {
        id: "action_set_title_and_note",
        key: "example.record_save_proof.item.set_title_and_note",
        label: "Set and note item",
        record_type: "item",
        permission: "example.record_save_proof.item.set_title_and_note",
        shareable: false,
        inputs: [{ key: "title", label: "Title", required: true, type: "text" }],
        effects: [
          { kind: "set_field", field: "title", value: { source: "input", input: "title" } },
          { kind: "announce_event", event: "example.record_save_proof.item.noted" },
        ],
      },
      {
        id: "action_validate_references",
        key: "example.record_save_proof.item.validate_references",
        label: "Validate item references",
        record_type: "item",
        permission: "example.record_save_proof.item.validate_references",
        shareable: false,
        inputs: [
          {
            key: "account",
            label: "Account",
            required: true,
            type: "organisation_account_reference",
          },
          {
            key: "record",
            label: "Record",
            required: true,
            type: "record_reference",
            record_types: ["example.record_save_proof:item"],
          },
        ],
        effects: [{ kind: "announce_event", event: "example.record_save_proof.item.noted" }],
      },
      {
        id: "action_create_note",
        key: "example.record_save_proof.item.create_note",
        label: "Create a note for an item",
        record_type: "item",
        permission: "example.record_save_proof.item.create_note",
        shareable: false,
        inputs: [{ key: "body", label: "Body", required: true, type: "text" }],
        effects: [
          {
            kind: "create_record",
            record_type: "example.record_save_proof:created_note",
            values: {
              title: { source: "literal", value: "Created by action" },
              body: { source: "input", input: "body" },
              amount: { source: "subject_field", field: "amount" },
              person: { source: "current_actor" },
              at: { source: "current_time" },
              source: { source: "subject_record" },
            },
          },
        ],
      },
      {
        id: "action_create_note_for",
        key: "example.record_save_proof.item.create_note_for",
        label: "Create a note for a chosen item",
        record_type: "item",
        permission: "example.record_save_proof.item.create_note_for",
        shareable: false,
        inputs: [
          {
            key: "target",
            label: "Target",
            required: true,
            type: "record_reference",
            record_types: ["example.record_save_proof:item"],
          },
        ],
        effects: [
          {
            kind: "create_record",
            record_type: "example.record_save_proof:created_note",
            values: {
              title: { source: "literal", value: "Created for a chosen item" },
              source: { source: "input", input: "target" },
            },
          },
        ],
      },
      {
        id: "action_create_restricted_note",
        key: "example.record_save_proof.item.create_restricted_note",
        label: "Create a restricted note",
        record_type: "item",
        permission: "example.record_save_proof.item.create_restricted_note",
        shareable: false,
        inputs: [],
        effects: [
          {
            kind: "create_record",
            record_type: "example.record_save_proof:created_note",
            values: {
              title: { source: "literal", value: "Outside the create field bounds" },
              restricted: { source: "literal", value: "Not changeable on create" },
            },
          },
        ],
      },
      {
        id: "action_create_ruled_child",
        key: "example.record_save_proof.item.create_ruled_child",
        label: "Create a ruled child",
        record_type: "item",
        permission: "example.record_save_proof.item.create_ruled_child",
        shareable: false,
        inputs: [],
        effects: [
          {
            kind: "create_record",
            record_type: "example.record_save_proof:ruled_child",
            values: { title: { source: "literal", value: "Without create authority" } },
          },
        ],
      },
      {
        id: "action_note_and_create",
        key: "example.record_save_proof.item.note_and_create",
        label: "Set, create and note an item",
        record_type: "item",
        permission: "example.record_save_proof.item.note_and_create",
        shareable: false,
        inputs: [{ key: "title", label: "Title", required: true, type: "text" }],
        effects: [
          { kind: "set_field", field: "title", value: { source: "input", input: "title" } },
          {
            kind: "create_record",
            record_type: "example.record_save_proof:created_note",
            values: {
              title: { source: "literal", value: "Created beside a set field" },
              source: { source: "subject_record" },
            },
          },
          { kind: "announce_event", event: "example.record_save_proof.item.noted" },
        ],
      },
      {
        id: "action_create_anchored_note",
        key: "example.record_save_proof.total_parent.create_anchored_note",
        label: "Create an anchored note",
        record_type: "total_parent",
        permission: "example.record_save_proof.total_parent.create_anchored_note",
        shareable: false,
        inputs: [{ key: "body", label: "Body", required: true, type: "text" }],
        effects: [
          {
            kind: "create_record",
            record_type: "example.record_save_proof:created_note",
            values: {
              title: { source: "literal", value: "Anchored note" },
              body: { source: "input", input: "body" },
              anchor: { source: "subject_record" },
            },
          },
        ],
      },
      {
        id: "action_add_child",
        key: "example.record_save_proof.total_parent.add_child",
        label: "Add a child to a total parent",
        record_type: "total_parent",
        permission: "example.record_save_proof.total_parent.add_child",
        shareable: false,
        inputs: [{ key: "amount", label: "Amount", required: true, type: "decimal_number" }],
        effects: [
          {
            kind: "create_record",
            record_type: "example.record_save_proof:total_child",
            values: {
              title: { source: "literal", value: "Added child" },
              amount: { source: "input", input: "amount" },
              included: { source: "literal", value: true },
              filter_operand: { source: "literal", value: "1" },
              parent: { source: "subject_record" },
            },
          },
        ],
      },
      {
        id: "action_set_amount_and_add_sibling",
        key: "example.record_save_proof.total_child.set_amount_and_add_sibling",
        label: "Set amount and add a sibling",
        record_type: "total_child",
        permission: "example.record_save_proof.total_child.set_amount_and_add_sibling",
        shareable: false,
        inputs: [
          { key: "amount", label: "Amount", required: true, type: "decimal_number" },
          { key: "sibling", label: "Sibling amount", required: true, type: "decimal_number" },
        ],
        effects: [
          { kind: "set_field", field: "amount", value: { source: "input", input: "amount" } },
          {
            kind: "create_record",
            record_type: "example.record_save_proof:total_child",
            values: {
              title: { source: "literal", value: "Added sibling" },
              amount: { source: "input", input: "sibling" },
              included: { source: "literal", value: true },
              filter_operand: { source: "literal", value: "1" },
              parent: { source: "subject_field", field: "parent" },
            },
          },
        ],
      },
      {
        id: "action_set_total_child_amount",
        key: "example.record_save_proof.total_child.set_amount",
        label: "Set total child amount",
        record_type: "total_child",
        permission: "example.record_save_proof.total_child.set_amount",
        shareable: false,
        inputs: [{ key: "amount", label: "Amount", required: true, type: "decimal_number" }],
        effects: [
          {
            kind: "set_field",
            field: "amount",
            value: { source: "input", input: "amount" },
          },
        ],
      },
    ],
    events: [
      {
        id: "event_noted",
        key: "example.record_save_proof.item.noted",
        record_type: "item",
        carries: ["title"],
        personal_or_sensitive_values_allowed: false,
      },
    ],
    rules: [],
    sharing_conditions: [],
    extension_points: [],
  },
});

const applicationSource = definitionSourceDocumentSchema.parse({
  source_contract_version: "1.0.0",
  kind: "application",
  root_alias: "application_record_save_proof",
  key: "example.record_save_application",
  body: {
    name: "Record save proof",
    description: "Neutral Application for the real Record save service proof.",
    icon: "application",
    home_page: "home",
    module_bindings: [
      {
        module: moduleSource.key,
        version: { selection: "exact", version: "2.0.0" },
        purpose: "primary",
      },
    ],
    theme: {
      mode: "application",
      light_and_dark: true,
      tokens: {
        brand: "blue",
        density: "comfortable",
        corners: "medium",
        focus: "high_contrast",
      },
    },
    permissions: [
      {
        id: "permission_open",
        key: "example.record_save_application.open",
        label: "Open application",
        description: "Open the neutral proof Application.",
        action_kind: "named",
        named_action: "open",
        administrative: false,
      },
    ],
    roles: [
      {
        id: "role_user",
        key: "user",
        name: "User",
        home_page: "home",
        permissions: ["example.record_save_application.open"],
      },
    ],
    navigation: [],
    queries: [],
    block_registrations: [
      {
        id: "block_content",
        release_version: "1.0.0",
        name: "Content",
        icon: "content",
        palette_group: "content",
        settings: [],
        allowed_child_blocks: [],
        phone_behaviour: "full_width",
        resizable_height: true,
        live_update: false,
        public_page: false,
      },
    ],
    pages: [
      {
        id: "page_home",
        key: "home",
        name: "Home",
        type: "dashboard",
        permission: "example.record_save_application.open",
        states: ["normal"],
        blocks: [
          {
            id: "placement_content",
            block: "block_content",
            block_release_version: "1.0.0",
            settings: {},
            desktop: { start_column: 1, span: 12, height: 4 },
            phone: { order: 0, behaviour: "full_width" },
            view_permission: "example.record_save_application.open",
          },
        ],
        layout: {
          desktop: { columns: 12, component_order: ["placement_content"] },
          phone: { component_order: ["placement_content"] },
        },
      },
    ],
    workflows: [],
    pipelines: [],
    connection_bindings: [],
    interfaces: [],
    actions: [],
    rules: [],
    events: [],
    public_addresses: [],
  },
});

const sources = [moduleSource, applicationSource] as const;
const rootByKey = new Map([
  [moduleSource.key, moduleRootId],
  [applicationSource.key, applicationRootId],
]);
let nextIdentity = 100;
const identityEntries = new Map<string, DefinitionResolutionSnapshot["identities"][number]>();
for (const source of sources)
  for (const requirement of extractSourceIdentityRequirements(source)) {
    const identifier =
      requirement.kind === "root" ? rootByKey.get(requirement.definitionKey)! : id(nextIdentity++);
    for (const alias of requirement.aliases) {
      const subject = [
        requirement.definitionKey,
        requirement.scope,
        requirement.kind,
        requirement.componentOwner ?? "",
        alias,
      ].join(":");
      if (!identityEntries.has(subject))
        identityEntries.set(subject, {
          definitionKey: requirement.definitionKey,
          scope: requirement.scope,
          kind: requirement.kind,
          componentOwner: requirement.componentOwner,
          alias,
          identifier,
        });
    }
  }

const componentId = (kind: string, owner: string): string => {
  const entry = [...identityEntries.values()].find(
    (candidate) => candidate.kind === kind && candidate.componentOwner === owner,
  );
  if (entry === undefined) throw new Error(`Compiled identity missing for ${kind}:${owner}`);
  return entry.identifier;
};

const recordTypeId = componentId("record_type", "record_item");
const storageContractId = componentId("storage_contract", "storage_item");
const fieldId = componentId("field", "field_title");
const amountFieldId = componentId("field", "field_amount");
const calculatedFieldId = componentId("field", "field_title_copy");
const privateSourceFieldId = componentId("field", "field_private_source");
const privateDirectFieldId = componentId("field", "field_private_direct");
const privateTransitiveFieldId = componentId("field", "field_private_transitive");
const totalParentRecordTypeId = componentId("record_type", "record_total_parent");
const totalParentStorageId = componentId("storage_contract", "storage_total_parent");
const totalParentTitleFieldId = componentId("field", "field_total_parent_title");
const totalParentSumFieldId = componentId("field", "field_total_parent_sum");
const totalParentDisplayFieldId = componentId("field", "field_total_parent_display");
const totalParentMoneyFieldId = componentId("field", "field_total_parent_money");
const totalChildRecordTypeId = componentId("record_type", "record_total_child");
const totalChildStorageId = componentId("storage_contract", "storage_total_child");
const totalChildTitleFieldId = componentId("field", "field_total_child_title");
const totalChildAmountFieldId = componentId("field", "field_total_child_amount");
const totalChildIncludedFieldId = componentId("field", "field_total_child_included");
const totalChildFilterOperandFieldId = componentId("field", "field_total_child_filter_operand");
const totalChildAmountStepOneFieldId = componentId("field", "field_total_child_amount_step_one");
const totalChildAggregateAmountFieldId = componentId("field", "field_total_child_aggregate_amount");
const totalChildIncludedForTotalFieldId = componentId(
  "field",
  "field_total_child_included_for_total",
);
const totalChildMoneyFieldId = componentId("field", "field_total_child_money");
const totalChildParentFieldId = componentId("field", "field_total_child_parent");
const totalRelationshipId = componentId("relationship", "relationship_total_parent");
const ruledChildRecordTypeId = componentId("record_type", "record_ruled_child");
const ruledChildStorageId = componentId("storage_contract", "storage_ruled_child");
const ruledChildTitleFieldId = componentId("field", "field_ruled_child_title");
const ruledChildParentFieldId = componentId("field", "field_ruled_child_parent");
const recursiveRecordTypeId = componentId("record_type", "record_recursive_total");
const recursiveStorageId = componentId("storage_contract", "storage_recursive_total");
const recursiveTitleFieldId = componentId("field", "field_recursive_title");
const recursiveChildrenTotalFieldId = componentId("field", "field_recursive_children_total");
const recursiveParentFieldId = componentId("field", "field_recursive_parent");
const applicationRoleId = componentId("role", "role_user");
const homePageId = componentId("page", "page_home");
const noteActionId = componentId("action", "action_note");
const setTitleActionId = componentId("action", "action_set_title");
const setTitleAndNoteActionId = componentId("action", "action_set_title_and_note");
const validateReferencesActionId = componentId("action", "action_validate_references");
const setTotalChildAmountActionId = componentId("action", "action_set_total_child_amount");
const notePermissionId = componentId("permission", "permission_note");
const setTitlePermissionId = componentId("permission", "permission_set_title");
const setTitleAndNotePermissionId = componentId("permission", "permission_set_title_and_note");
const validateReferencesPermissionId = componentId("permission", "permission_validate_references");
const setTotalChildAmountPermissionId = componentId(
  "permission",
  "permission_set_total_child_amount",
);
const openPermissionId = componentId("permission", "permission_open");
const createdNoteRecordTypeId = componentId("record_type", "record_created_note");
const createdNoteStorageId = componentId("storage_contract", "storage_created_note");
const createdNoteTitleFieldId = componentId("field", "field_created_note_title");
const createdNoteBodyFieldId = componentId("field", "field_created_note_body");
const createdNoteReferenceFieldId = componentId("field", "field_created_note_reference");
const createdNotePersonFieldId = componentId("field", "field_created_note_person");
const createdNoteAtFieldId = componentId("field", "field_created_note_at");
const createdNoteAmountFieldId = componentId("field", "field_created_note_amount");
const createdNoteSourceFieldId = componentId("field", "field_created_note_source");
const createdNoteSourceRelationshipId = componentId(
  "relationship",
  "relationship_created_note_source",
);
const createNoteActionId = componentId("action", "action_create_note");
const createNoteForActionId = componentId("action", "action_create_note_for");
const noteAndCreateActionId = componentId("action", "action_note_and_create");
const createdNoteAnchorFieldId = componentId("field", "field_created_note_anchor");
const createAnchoredNoteActionId = componentId("action", "action_create_anchored_note");
const createAnchoredNotePermissionId = componentId("permission", "permission_create_anchored_note");
const addChildActionId = componentId("action", "action_add_child");
const setAmountAndAddSiblingActionId = componentId("action", "action_set_amount_and_add_sibling");
const createdNoteRestrictedFieldId = componentId("field", "field_created_note_restricted");
const createRestrictedNoteActionId = componentId("action", "action_create_restricted_note");
const createRuledChildActionId = componentId("action", "action_create_ruled_child");
const createRestrictedNotePermissionId = componentId(
  "permission",
  "permission_create_restricted_note",
);
const createRuledChildPermissionId = componentId("permission", "permission_create_ruled_child");
const createNotePermissionId = componentId("permission", "permission_create_note");
const createNoteForPermissionId = componentId("permission", "permission_create_note_for");
const noteAndCreatePermissionId = componentId("permission", "permission_note_and_create");
const addChildPermissionId = componentId("permission", "permission_add_child");
const setAmountAndAddSiblingPermissionId = componentId(
  "permission",
  "permission_set_amount_and_add_sibling",
);
const createdNoteCreatePermissionId = componentId("permission", "permission_created_note_create");
const createdNoteReadPermissionId = componentId("permission", "permission_created_note_read");
const totalParentReadPermissionId = componentId("permission", "permission_total_parent_read");
const totalChildCreatePermissionId = componentId("permission", "permission_total_child_create");

const resolutionDefinitions = [
  { kind: "module" as const, key: moduleSource.key, rootId: moduleRootId, exactVersion: "2.0.0" },
  {
    kind: "application" as const,
    key: applicationSource.key,
    rootId: applicationRootId,
    exactVersion: "1.0.0",
  },
];
const resolutionEvidence = {
  contractVersion: "1.0.0" as const,
  definitions: resolutionDefinitions,
  identities: [...identityEntries.values()],
};
const resolutionSnapshot = definitionResolutionSnapshotSchema.parse({
  ...resolutionEvidence,
  fingerprint: fingerprintCanonicalValue(resolutionEvidence),
});
const resolutionEvidenceV2 = { ...resolutionEvidence, contractVersion: "2.0.0" as const };
const resolutionSnapshotV2 = definitionResolutionSnapshotV2Schema.parse({
  ...resolutionEvidenceV2,
  fingerprint: fingerprintCanonicalValue(resolutionEvidenceV2),
});
const draftMetadata = {
  organizationId,
  draftRevision: 1,
  createdAt: publishedAt,
  createdBy: actorId,
  updatedAt: publishedAt,
  updatedBy: actorId,
};
const moduleOutput = compileDefinition({
  sourceContractVersion: "2.0.0",
  validationContractVersion: "2.0.0",
  source: moduleSource,
  resolution: resolutionSnapshotV2,
  draftMetadata,
  savedConditionRevisions: [],
});
const applicationOutput = compileDefinition({
  source: applicationSource,
  resolution: resolutionSnapshot,
  draftMetadata,
  savedConditionRevisions: [],
});
if (moduleOutput.kind !== "module" || applicationOutput.kind !== "application")
  throw new Error("Record save compiler output kind mismatch");

const moduleRelease = moduleDefinitionConsumerReadResultV2Schema.parse({
  kind: "module",
  organizationId,
  definitionKey: moduleOutput.artifact.definitionKey,
  rootId: moduleOutput.artifact.rootId,
  releaseRevision: 1,
  releaseVersion: "2.0.0",
  validationContractVersion: "2.0.0",
  contentFingerprint: moduleOutput.artifact.contentFingerprint,
  resolutionFingerprint: moduleOutput.resolutionFingerprint,
  content: moduleOutput.canonical.content,
  dependencyManifest: [],
  correlationId: fixtureCorrelationId,
});
const moduleDependency = {
  kind: "module" as const,
  key: moduleRelease.definitionKey,
  rootId: moduleRelease.rootId,
  releaseRevision: 1,
  releaseVersion: moduleRelease.releaseVersion,
  contentFingerprint: moduleRelease.contentFingerprint,
  resolutionFingerprint: moduleRelease.resolutionFingerprint,
};
const applicationRelease = applicationDefinitionConsumerReadResultV1Schema.parse({
  kind: "application",
  organizationId,
  definitionKey: applicationOutput.artifact.definitionKey,
  rootId: applicationOutput.artifact.rootId,
  releaseRevision: 1,
  releaseVersion: "1.0.0",
  validationContractVersion: "1.0.0",
  contentFingerprint: applicationOutput.artifact.contentFingerprint,
  resolutionFingerprint: applicationOutput.resolutionFingerprint,
  content: applicationOutput.canonical.content,
  dependencyManifest: [moduleDependency],
  correlationId: fixtureCorrelationId,
});

const requestTransaction = (transaction: TransactionSql) => ({
  query: async <ResultRow extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => (await transaction<ResultRow[] & Row[]>(strings, ...values)) as readonly ResultRow[],
});

type ResolvedRequestTransaction = NonNullable<
  StoredApplicationPermissionSourceDependencies["resolvedRequestTransaction"]
>;

const resolvedRequestRunner = (transaction: TransactionSql): ResolvedRequestTransaction => {
  return async (resolve, operation) =>
    transaction.savepoint(async (savepoint) => {
      const request = requestTransaction(savepoint);
      const resolved = await resolve(request);
      await request.query`select vortex_context.initialize(
        ${JSON.stringify(resolved.context)}::text::jsonb
      )`;
      await request.query`set local role vortex_request`;
      const result = await operation(request, resolved.scope);
      await request.query`reset role`;
      await request.query`delete from vortex_context.request_contexts
        where backend_pid = pg_catalog.pg_backend_pid()`;
      return result;
    });
};

// Fixture-owned recovery for this one proof's exact identifiers. The proof's
// tenant, organisation, identity, account, both Definition roots, its Access
// and Module state, and the Record/queue effects of its own saves may only be
// removed after the organisation still names the proof's tenant and creator and
// both roots are present. An absent fixture is a no-op so this can run before
// setup; a partial or foreign fixture fails loudly instead of being deleted.
const fixtureStorageTables = [
  storageContractId,
  totalParentStorageId,
  totalChildStorageId,
  ruledChildStorageId,
  recursiveStorageId,
].map((storageId) => `record_data.rt_${storageId.replaceAll("-", "")}`);

const cleanRecordSaveFixture = async (admin: Sql): Promise<void> => {
  const [state] = await admin.unsafe<
    { present: string; tenant: string; owned: string; roots: string }[]
  >(
    `select
      (select pg_catalog.count(*)::text from vortex_identity.organizations
        where organization_id = $1) as present,
      (select pg_catalog.count(*)::text from vortex_identity.tenants
        where tenant_id = $2) as tenant,
      (select pg_catalog.count(*)::text from vortex_identity.organizations
        where organization_id = $1 and tenant_id = $2 and created_by = $3) as owned,
      (select pg_catalog.count(*)::text from vortex_definition.roots
        where organization_id = $1 and created_by = $3
          and root_id in ($4, $5)) as roots`,
    [organizationId, tenantId, actorId, moduleRootId, applicationRootId],
  );
  if (state === undefined)
    throw new Error("Record save integration fixture verification returned no result");
  if (state.present === "0" && state.tenant === "0" && state.owned === "0" && state.roots === "0")
    return;
  if (state.present !== "1" || state.tenant !== "1" || state.owned !== "1" || state.roots !== "2")
    throw new Error("Record save integration fixture ownership mismatch");

  await admin.unsafe(`
    begin;
    set local session_replication_role = replica;
    set local role vortex_record_owner;
    drop table if exists ${fixtureStorageTables.join(", ")};
    delete from vortex_record.record_reference_counters
      where organization_id = '${organizationId}';
    delete from vortex_record.record_data_versions
      where organization_id = '${organizationId}';
    delete from vortex_record.relationship_edges
      where from_storage_contract_id in ('${storageContractId}', '${totalParentStorageId}', '${totalChildStorageId}', '${ruledChildStorageId}', '${recursiveStorageId}')
         or to_storage_contract_id in ('${storageContractId}', '${totalParentStorageId}', '${totalChildStorageId}', '${ruledChildStorageId}', '${recursiveStorageId}');
    delete from vortex_record.relationship_storage_mappings
      where module_root_id = '${moduleRootId}';
    delete from vortex_record.field_storage_mappings
      where storage_contract_id in ('${storageContractId}', '${totalParentStorageId}', '${totalChildStorageId}', '${ruledChildStorageId}', '${recursiveStorageId}');
    delete from vortex_record.storage_catalogue
      where storage_contract_id in ('${storageContractId}', '${totalParentStorageId}', '${totalChildStorageId}', '${ruledChildStorageId}', '${recursiveStorageId}');
    delete from vortex_record.release_provisions
      where module_root_id = '${moduleRootId}';
    reset role;
    set local role vortex_record_adapter;
    delete from vortex_record.save_command_receipts
      where organization_id = '${organizationId}';
    delete from vortex_record.named_action_command_receipts
      where organization_id = '${organizationId}';
    reset role;
    delete from pgmq.q_vortex_event_occurrences queued
      using vortex_event.event_outbox event
      where queued.message ->> 'occurrenceId' = event.occurrence_id::text
        and event.organization_id = '${organizationId}';
    delete from vortex_event.event_outbox
      where organization_id = '${organizationId}';
    set local role vortex_module_owner;
    delete from vortex_module.installation_bindings
      where organization_id = '${organizationId}';
    reset role;
    do $cleanup$
    declare
      target record;
    begin
      for target in
        select column_row.table_schema, column_row.table_name
        from information_schema.columns as column_row
        join information_schema.tables as table_row
          on table_row.table_schema = column_row.table_schema
          and table_row.table_name = column_row.table_name
          and table_row.table_type = 'BASE TABLE'
        where column_row.table_schema in ('vortex_access', 'vortex_activity', 'vortex_identity')
          and column_row.column_name = 'organization_id'
          and column_row.table_name <> 'organizations'
      loop
        execute pg_catalog.format('delete from %I.%I where organization_id = %L',
          target.table_schema, target.table_name, '${organizationId}');
      end loop;
    end
    $cleanup$;
    delete from vortex_definition.release_dependencies
      where root_id in ('${moduleRootId}', '${applicationRootId}');
    delete from vortex_definition.releases
      where root_id in ('${moduleRootId}', '${applicationRootId}');
    delete from vortex_definition.drafts
      where root_id in ('${moduleRootId}', '${applicationRootId}');
    delete from vortex_definition.roots
      where root_id in ('${moduleRootId}', '${applicationRootId}');
    delete from vortex_identity.organization_accounts
      where organization_id in ('${organizationId}', '${foreignOrganizationId}');
    delete from vortex_identity.identity_projections
      where identity_id in ('${identityId}', '${otherIdentityId}');
    delete from vortex_identity.organizations
      where organization_id in ('${organizationId}', '${foreignOrganizationId}');
    delete from vortex_identity.tenants
      where tenant_id in ('${tenantId}', '${foreignTenantId}');
    commit;
  `);
};

describeDatabase("compiled public Record save service PostgreSQL proof", () => {
  it("saves once, replays safely and applies current permission withdrawal", async () => {
    const admin = postgres(databaseUrl!, { max: 1, prepare: false });
    const raceAdmin = postgres(databaseUrl!, { max: 1, prepare: false });
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = "vortex_runtime";
    runtimeUrl.password = "vortex-runtime-local-only";
    const runtime = postgres(runtimeUrl.toString(), { max: 2, prepare: false });
    const operationAt = new Date();
    const session: IdentitySession = {
      identityId,
      sessionId: id(18),
      authenticationStrength: "single_factor",
      accessTokenIssuedAt: new Date(operationAt.valueOf() - 60_000).toISOString(),
      accessTokenExpiresAt: new Date(operationAt.valueOf() + 3_600_000).toISOString(),
      primaryAuthenticatedAt: new Date(operationAt.valueOf() - 60_000).toISOString(),
    };

    let failure: unknown;
    let allRolePermissions: unknown[] = [];
    try {
      await cleanRecordSaveFixture(admin);
      await admin.begin(async (transaction) => {
        // This fixture writes tenant identity rows and then provisions record
        // storage in one transaction. `vortex_record.provision_exact_module_storage`
        // creates each `record_data` table with foreign keys to
        // `vortex_identity.organizations`, `vortex_identity.organization_accounts`
        // and `vortex_access.organization_groups`, so the CREATE TABLE needs
        // ShareRowExclusiveLock on all three. The inserts below already hold the
        // weaker RowExclusiveLock on them, so two fixtures running at once (this
        // proof and the Event append proof share one verification cluster) each
        // held RowExclusiveLock and each waited for the other's
        // ShareRowExclusiveLock: a deadlock inside provisioning (#512). Taking
        // the stronger lock first, in the same relation order the generated
        // DDL uses, removes the escalation; concurrent fixtures now serialize
        // here instead. The provisioning concurrency proof
        // (supabase/tests/module-storage-provisioning-concurrency.test.sh)
        // never hit this because it commits its identity fixture first.
        await transaction`lock table
          vortex_identity.organizations,
          vortex_identity.organization_accounts,
          vortex_access.organization_groups
          in share row exclusive mode`;
        await transaction`insert into vortex_identity.tenants (
          tenant_id, short_name, display_name, state, created_at, created_by,
          state_changed_at, revision
        ) values (
          ${tenantId}, 'record_save_service', 'Record save service', 'active',
          pg_catalog.statement_timestamp(), ${actorId}, pg_catalog.statement_timestamp(), 1
        )`;
        await transaction`insert into vortex_identity.organizations (
          organization_id, tenant_id, short_name, display_name, state, created_at,
          created_by, state_changed_at, revision
        ) values (
          ${organizationId}, ${tenantId}, 'record_save_service', 'Record save service', 'active',
          pg_catalog.statement_timestamp(), ${actorId}, pg_catalog.statement_timestamp(), 1
        )`;
        await transaction`set local role vortex_runtime`;
        await transaction`select * from vortex_identity.initialize_organization_runtime_settings(
          ${organizationId}::uuid, 'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
        )`;
        await transaction`reset role`;
        await transaction`select * from vortex_identity.ensure_identity_projection(
          ${identityId}::uuid, ${id(19)}::uuid
        )`;
        await transaction`insert into vortex_identity.organization_accounts (
          organization_account_id, organization_id, identity_id, display_name, state,
          activated_at, changed_at, state_changed_at, state_changed_by,
          state_change_correlation_id, revision
        ) values (
          ${organizationAccountId}, ${organizationId}, ${identityId}, 'Record save actor', 'active',
          pg_catalog.statement_timestamp() - interval '1 minute',
          pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), ${actorId},
          ${id(20)}, 1
        )`;
        await transaction`select * from vortex_identity.ensure_identity_projection(
          ${otherIdentityId}::uuid, ${id(178)}::uuid
        )`;
        await transaction`insert into vortex_identity.organization_accounts (
          organization_account_id, organization_id, identity_id, display_name, state,
          activated_at, changed_at, state_changed_at, state_changed_by,
          state_change_correlation_id, revision
        ) values (
          ${otherOrganizationAccountId}, ${organizationId}, ${otherIdentityId},
          'Other active account', 'active', pg_catalog.statement_timestamp() - interval '1 minute',
          pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), ${actorId},
          ${id(179)}, 1
        )`;
        await transaction`insert into vortex_identity.tenants (
          tenant_id, short_name, display_name, state, created_at, created_by,
          state_changed_at, revision
        ) values (
          ${foreignTenantId}, 'record_save_foreign', 'Record save foreign', 'active',
          pg_catalog.statement_timestamp(), ${actorId}, pg_catalog.statement_timestamp(), 1
        )`;
        await transaction`insert into vortex_identity.organizations (
          organization_id, tenant_id, short_name, display_name, state, created_at,
          created_by, state_changed_at, revision
        ) values (
          ${foreignOrganizationId}, ${foreignTenantId}, 'record_save_foreign',
          'Record save foreign', 'active', pg_catalog.statement_timestamp(), ${actorId},
          pg_catalog.statement_timestamp(), 1
        )`;
        await transaction`insert into vortex_identity.organization_accounts (
          organization_account_id, organization_id, identity_id, display_name, state,
          activated_at, changed_at, state_changed_at, state_changed_by,
          state_change_correlation_id, revision
        ) values (
          ${foreignOrganizationAccountId}, ${foreignOrganizationId}, ${identityId},
          'Foreign active account', 'active', pg_catalog.statement_timestamp() - interval '1 minute',
          pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), ${actorId},
          ${id(180)}, 1
        )`;
        await transaction`select * from vortex_access.initialize_organization_access_version(
          ${organizationId}::uuid, ${actorId}::uuid, ${id(21)}::uuid
        )`;

        for (const release of [moduleRelease, applicationRelease]) {
          const source = release.kind === "module" ? moduleSource : applicationSource;
          const output = release.kind === "module" ? moduleOutput : applicationOutput;
          const sourceFingerprint = fingerprintCanonicalValue(source);
          await transaction`insert into vortex_definition.roots (
            root_id, organization_id, kind, key, created_at, created_by
          ) values (
            ${release.rootId}, ${organizationId}, ${release.kind}, ${release.definitionKey},
            pg_catalog.statement_timestamp(), ${actorId}
          )`;
          await transaction`insert into vortex_definition.drafts (
            root_id, draft_revision, draft_source, identity_requirements,
            source_contract_version, source_fingerprint, updated_at, updated_by
          ) values (
            ${release.rootId}, 1, ${JSON.stringify(source)}::text::jsonb,
            ${JSON.stringify(extractSourceIdentityRequirements(source))}::text::jsonb,
            ${release.validationContractVersion}, ${sourceFingerprint},
            pg_catalog.statement_timestamp(), ${actorId}
          )`;
          await transaction`delete from vortex_context.request_contexts
            where backend_pid = pg_catalog.pg_backend_pid()`;
          await transaction`select vortex_context.initialize(${JSON.stringify({
            callerKind: "system",
            tenantId,
            organizationId,
            systemActorId: actorId,
            sessionId: id(22),
            authenticationStrength: "service",
            issuedAt: new Date(operationAt.valueOf() - 60_000).toISOString(),
            expiresAt: new Date(operationAt.valueOf() + 3_600_000).toISOString(),
            accessVersion: 1,
            correlationId: fixtureCorrelationId,
          })}::text::jsonb)`;
          await transaction`select * from vortex_definition.append_release(
            ${release.rootId}, 1, ${sourceFingerprint},
            ${JSON.stringify({
              releaseVersion: release.releaseVersion,
              compilationOutput: output,
              resolutionSnapshot:
                release.kind === "module" ? resolutionSnapshotV2 : resolutionSnapshot,
              contentFingerprint: release.contentFingerprint,
              resolutionFingerprint: release.resolutionFingerprint,
              validationContractVersion: release.validationContractVersion,
              comparisonFingerprint: release.contentFingerprint,
              impactReasons: [],
              releaseNote: `Compiled Record save proof ${release.definitionKey}.`,
              dependencies: release.dependencyManifest,
            })}::text::jsonb
          )`;
        }
        await transaction`delete from vortex_context.request_contexts
          where backend_pid = pg_catalog.pg_backend_pid()`;

        const systemContext = sessionContextSchema.parse({
          callerKind: "system",
          tenantId,
          organizationId,
          applicationRootId,
          systemActorId: actorId,
          sessionId: id(23),
          authenticationStrength: "service",
          issuedAt: new Date(operationAt.valueOf() - 60_000).toISOString(),
          expiresAt: new Date(operationAt.valueOf() + 3_600_000).toISOString(),
          accessVersion: 1,
          correlationId: fixtureCorrelationId,
        } satisfies SessionContext);
        const registration = await createStoredApplicationPermissionSource({
          systemContext,
          applicationRootId,
          releaseRevision: 1,
          definitionCatalogue: { connectionTypeReleases: [], platformThemeReleases: [] },
          resolvedRequestTransaction: resolvedRequestRunner(transaction),
        }).readExact();
        expect(registration.permissionRegistration.entries).toHaveLength(32);
        const registeredPermissionKeys = registration.permissionRegistration.entries.map(
          (entry) => entry.permission.key,
        );
        await transaction`select * from vortex_access.coordinate_application_access_change(
          'register', null::bigint,
          ${JSON.stringify({
            contractVersion: "1.0.0",
            preparationBasis: { kind: "registration_candidate" },
            permissionRegistration: registration.permissionRegistration,
            templates: [
              {
                template: {
                  roleId: applicationRoleId,
                  key: "user",
                  name: "User",
                  homePageId,
                  permissionKeys: registeredPermissionKeys,
                  permissionSelection: { kind: "exact" },
                },
                sourceTemplateFingerprint: fingerprintCanonicalValue({
                  applicationRoleId,
                  registeredPermissionKeys,
                }),
                sourcePermissions: registration.permissionRegistration.entries,
                livePermissions: registration.permissionRegistration.entries,
              },
            ],
            candidateFingerprint: fingerprintCanonicalValue(registration.permissionRegistration),
          })}::text::jsonb,
          ${organizationId}::uuid, ${applicationRootId}::uuid,
          ${actorId}::uuid, ${id(24)}::uuid
        )`;

        const [permissionRow] = await transaction<{ permissions: unknown }[]>`
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind', 'exact',
            'applicationRootId', entry.application_root_id,
            'ownerKind', entry.owner_kind,
            'ownerId', entry.owner_id,
            'permissionId', entry.permission_id,
            'acceptedRegistrationRevision', registration.revision,
            'catalogueFingerprint', registration.permission_catalogue_fingerprint,
            'continuityRevision', continuity.continuity_revision,
            'meaningFingerprint', entry.meaning_fingerprint
          ) order by entry.owner_kind collate "C", entry.owner_id::text collate "C",
            entry.permission_id::text collate "C") as permissions
          from vortex_access.permission_registrations as registration
          join vortex_access.permission_catalogue_entries as entry
            on entry.organization_id = registration.organization_id
            and entry.registration_kind = registration.registration_kind
            and entry.registration_owner_id = registration.registration_owner_id
            and entry.registration_revision = registration.revision
          join vortex_access.permission_continuities as continuity
            on continuity.organization_id = entry.organization_id
            and continuity.application_root_id is not distinct from entry.application_root_id
            and continuity.owner_kind = entry.owner_kind
            and continuity.owner_id = entry.owner_id
            and continuity.permission_id = entry.permission_id
          where registration.organization_id = ${organizationId}::uuid
            and registration.registration_kind = 'application'
            and registration.registration_owner_id = ${applicationRootId}::uuid
            and registration.state = 'active'
        `;
        if (!Array.isArray(permissionRow?.permissions))
          throw new Error("Compiled Record permission references are missing");
        allRolePermissions = permissionRow.permissions;
        await transaction`select * from vortex_access.coordinate_organization_role_change(
          ${JSON.stringify({
            contractVersion: "1.0.0",
            candidate: {
              operation: "create_custom",
              organizationId,
              roleId,
              key: "record_save_operator",
              label: "Record save operator",
              description: "Standing access for the neutral real-service proof.",
              privilegeClassification: "standard",
              assignmentPolicy: { kind: "standing" },
              permissions: permissionRow.permissions,
            },
            roleCandidateFingerprint: fingerprintCanonicalValue({ roleId, revision: 1 }),
          })}::text::jsonb,
          ${actorId}::uuid, ${id(25)}::uuid
        )`;
        await transaction`select * from vortex_access.coordinate_organization_role_assignment_change(
          'grant', ${organizationId}::uuid, ${roleAssignmentId}::uuid, null::bigint,
          ${roleId}::uuid, 1::bigint, 'organization_account',
          ${organizationAccountId}::uuid, null::uuid, 'standing',
          pg_catalog.statement_timestamp() - interval '1 minute', null::timestamptz,
          ${actorId}::uuid, ${id(26)}::uuid
        )`;

        await transaction`set local role vortex_module_owner`;
        await transaction`select * from vortex_record.provision_exact_module_storage(
          ${moduleRootId}::uuid, 1
        )`;
        await transaction`insert into vortex_module.installation_bindings (
          organization_id, application_root_id, module_root_id, binding_revision,
          application_release_revision, module_release_revision, state,
          content_fingerprint, resolution_fingerprint, generator_contract_version,
          storage_contract_ids
        ) values (
          ${organizationId}, ${applicationRootId}, ${moduleRootId}, 1, 1, 1, 'active',
          ${moduleRelease.contentFingerprint}, ${moduleRelease.resolutionFingerprint},
          '1.0.0', array[
            ${storageContractId}::uuid,
            ${totalParentStorageId}::uuid,
            ${totalChildStorageId}::uuid,
            ${ruledChildStorageId}::uuid,
            ${recursiveStorageId}::uuid
          ]
        )`;
        await transaction`reset role`;
      });

      let requestTransactionAttempts = 0;
      const resolvedRequestTransaction = createResolvedRequestTransactionRunner({
        transaction: async <Result>(
          operation: (transaction: {
            query<ResultRow extends DatabaseRow = DatabaseRow>(
              strings: TemplateStringsArray,
              ...values: readonly DatabaseValue[]
            ): Promise<readonly ResultRow[]>;
          }) => Promise<Result>,
        ) => {
          requestTransactionAttempts += 1;
          return runtime.begin(async (transaction) =>
            operation(requestTransaction(transaction)),
          ) as Promise<Result>;
        },
      });
      const activityIds = [
        activityCreateId,
        activityGeneratedInputId,
        activityUpdateId,
        activityReplayId,
        activityConflictId,
        activityNamedRecordCreateId,
        activityNamedReferenceCreateId,
        id(403),
        id(404),
        id(405),
        id(800),
        id(801),
        id(802),
        id(803),
        id(804),
        id(805),
        id(806),
        id(807),
        id(808),
        id(809),
        id(810),
        id(811),
        id(812),
        id(813),
        id(814),
        id(815),
        id(816),
        id(817),
        id(818),
        id(819),
        activityFreshId,
        activityFreshReplayId,
        activityMissingSettingsId,
        activityExplicitMoneyId,
        activityParentOneId,
        activityParentTwoId,
        activityChildCreateId,
        activityChildUpdateId,
        activityChildFilterId,
        activityChildReincludeId,
        activityChildMoveId,
        activityChildMoveReplayId,
        activityChildMoveConflictId,
        activitySecondChildCreateId,
        activityFirstChildConcurrentId,
        activitySecondChildConcurrentId,
        activityStaleTotalParentId,
        activityOverlappingReplayOneId,
        activityOverlappingReplayTwoId,
        activityParentActivityFailureId,
        activityRecursiveGrandId,
        activityRecursiveParentId,
        activityRecursiveLeafId,
        activityRecursiveCycleId,
        activityMoneySourceId,
        activityMixedCurrencyId,
        activityChangedClosureSetupId,
        activityChangedClosureId,
        activityRuleDeferredTotalId,
        activityRuleDeferredFilterId,
        activityRuleUnrelatedTitleId,
        activityRuleStableOperandId,
        activityRuleStableOperandReplayId,
        activityRuleStableOperandConflictId,
        activityRevokedReplayId,
        activityRevokedWriteId,
      ];
      const occurrenceIds = [
        occurrenceCreateId,
        occurrenceUpdateId,
        occurrenceNamedRecordCreateId,
        occurrenceNamedReferenceCreateId,
        id(406),
        id(407),
        id(408),
        id(830),
        id(831),
        id(832),
        id(833),
        id(834),
        id(835),
        id(836),
        id(837),
        id(838),
        id(839),
        id(840),
        id(841),
        id(842),
        id(843),
        id(844),
        id(845),
        id(846),
        id(847),
        id(848),
        id(849),
        occurrenceFreshId,
        occurrenceExplicitMoneyId,
        occurrenceParentOneId,
        occurrenceParentTwoId,
        occurrenceChildCreateId,
        occurrenceChildUpdateId,
        occurrenceChildFilterId,
        occurrenceChildReincludeId,
        occurrenceChildMoveId,
        occurrenceSecondChildCreateId,
        occurrenceFirstChildConcurrentId,
        occurrenceSecondChildConcurrentId,
        occurrenceOverlappingReplayId,
        occurrenceParentActivityFailureId,
        occurrenceRecursiveGrandId,
        occurrenceRecursiveParentId,
        occurrenceRecursiveLeafId,
        occurrenceMoneySourceId,
        occurrenceChangedClosureSetupId,
        occurrenceChangedClosureId,
        occurrenceRuleDeferredTotalId,
        occurrenceRuleDeferredFilterId,
        occurrenceRuleUnrelatedTitleId,
        occurrenceRuleStableOperandId,
      ];
      const service = createRecordSaveService({
        identityAuthorityId,
        clock: () => operationAt,
        correlationId: () => id(27),
        activityId: () => {
          const value = activityIds.shift();
          if (value === undefined) throw new Error("Unexpected extra Activity allocation");
          return value;
        },
        occurrenceId: () => {
          const value = occurrenceIds.shift();
          if (value === undefined) throw new Error("Unexpected extra Event allocation");
          return value;
        },
        resolvedRequestTransaction,
      });
      const selection = { organizationId, applicationRootId };
      const createCommand = {
        contractVersion: "2.0.0",
        commandId: commandCreateId,
        operation: "create",
        recordTypeId,
        submittedValues: { [fieldId]: "Created once" },
      };
      const created = await service.save(session, selection, createCommand);
      expect(created).toMatchObject({
        kind: "available",
        value: {
          outcome: "saved",
          concurrencyNumber: 1,
          readableValues: {
            [fieldId]: "Created once",
            [calculatedFieldId]: "Created once",
          },
        },
      });
      if (created.kind !== "available" || created.value.outcome !== "saved")
        throw new Error("Real service create did not return its Record");
      const recordId = created.value.recordId;
      expect(created.value.readableValues).not.toHaveProperty(privateDirectFieldId);
      expect(created.value.readableValues).not.toHaveProperty(privateTransitiveFieldId);

      const generatedInput = await service.save(session, selection, {
        commandId: commandGeneratedInputId,
        contractVersion: "2.0.0",
        operation: "update",
        recordTypeId,
        recordId,
        expectedConcurrencyNumber: 1,
        submittedValues: {
          [fieldId]: "Visible input remains safe",
          [privateDirectFieldId]: "caller value",
        },
      });
      expect(generatedInput).toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "operation_refused" } },
      });
      expect(JSON.stringify(generatedInput)).not.toContain(privateDirectFieldId);
      expect(JSON.stringify(generatedInput)).not.toContain("private_direct");
      expect(JSON.stringify(generatedInput)).not.toContain("caller value");

      // #430 owns the protected settings update path. This direct fixture
      // change lets this save proof demonstrate the reader's fresh-read rule.
      await admin`update vortex_identity.organization_runtime_settings
        set currency = 'AUD', changed_at = pg_catalog.statement_timestamp(), revision = revision + 1
        where organization_id = ${organizationId}::uuid`;

      const updateCommand = {
        contractVersion: "2.0.0",
        commandId: commandUpdateId,
        operation: "update",
        recordTypeId,
        recordId,
        expectedConcurrencyNumber: 1,
        submittedValues: { [fieldId]: "Updated once" },
      };
      const updated = await service.save(session, selection, updateCommand);
      expect(updated).toMatchObject({
        kind: "available",
        value: {
          outcome: "saved",
          recordId,
          concurrencyNumber: 2,
          readableValues: {
            [fieldId]: "Updated once",
            [calculatedFieldId]: "Updated once",
          },
        },
      });
      if (updated.kind !== "available" || updated.value.outcome !== "saved")
        throw new Error("Real service update did not return its Record");
      expect(updated.value.readableValues).not.toHaveProperty(privateDirectFieldId);
      expect(updated.value.readableValues).not.toHaveProperty(privateTransitiveFieldId);

      const replayedUpdate = await service.save(session, selection, updateCommand);
      expect(replayedUpdate).toMatchObject({
        kind: "available",
        value: {
          outcome: "saved",
          recordId,
          concurrencyNumber: 2,
          readableValues: { [fieldId]: "Updated once" },
        },
      });
      if (replayedUpdate.kind !== "available" || replayedUpdate.value.outcome !== "saved")
        throw new Error("Real service replay did not return its Record");
      expect(replayedUpdate.value.readableValues).not.toHaveProperty(privateDirectFieldId);
      expect(replayedUpdate.value.readableValues).not.toHaveProperty(privateTransitiveFieldId);
      await expect(
        service.save(session, selection, {
          ...updateCommand,
          submittedValues: { [fieldId]: "Conflicting content" },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "conflict" } },
      });

      const namedRecord = await service.save(session, selection, {
        contractVersion: "2.0.0",
        commandId: commandNamedRecordCreateId,
        operation: "create",
        recordTypeId,
        submittedValues: { [fieldId]: "Named action subject" },
      });
      if (namedRecord.kind !== "available" || namedRecord.value.outcome !== "saved")
        throw new Error("Named action subject was not created");
      const namedRecordId = namedRecord.value.recordId;
      const referencedRecord = await service.save(session, selection, {
        contractVersion: "2.0.0",
        commandId: id(181),
        operation: "create",
        recordTypeId,
        submittedValues: { [fieldId]: "Named action reference" },
      });
      if (referencedRecord.kind !== "available" || referencedRecord.value.outcome !== "saved")
        throw new Error("Named action reference was not created");
      const referencedRecordId = referencedRecord.value.recordId;

      // Subjects for the create_record effect proof, made while the actor still
      // holds ordinary authority. Every create_record assertion below then runs
      // under the named-only role, which deliberately has no ordinary `item`
      // read.
      const createSubject = await service.save(session, selection, {
        contractVersion: "2.0.0",
        commandId: id(400),
        operation: "create",
        recordTypeId,
        submittedValues: { [fieldId]: "Create effect subject" },
      });
      if (createSubject.kind !== "available" || createSubject.value.outcome !== "saved")
        throw new Error("Create effect subject was not created");
      const createSubjectId = createSubject.value.recordId;
      const namedParent = await service.save(session, selection, {
        contractVersion: "2.0.0",
        commandId: id(401),
        operation: "create",
        recordTypeId: totalParentRecordTypeId,
        submittedValues: { [totalParentTitleFieldId]: "Named action total parent" },
      });
      if (namedParent.kind !== "available" || namedParent.value.outcome !== "saved")
        throw new Error("Named action total parent was not created");
      const namedParentId = namedParent.value.recordId;
      const namedChild = await service.save(session, selection, {
        contractVersion: "2.0.0",
        commandId: id(402),
        operation: "create",
        recordTypeId: totalChildRecordTypeId,
        submittedValues: {
          [totalChildTitleFieldId]: "Named action child",
          [totalChildAmountFieldId]: "4",
          [totalChildIncludedFieldId]: true,
          [totalChildFilterOperandFieldId]: "1",
          [totalChildParentFieldId]: {
            recordTypeId: totalParentRecordTypeId,
            recordId: namedParentId,
          },
        },
      });
      if (namedChild.kind !== "available" || namedChild.value.outcome !== "saved")
        throw new Error("Named action total child was not created");
      const namedChildId = namedChild.value.recordId;

      await expect(
        admin<{ application_version: string; module_version: string }[]>`
          select
            (select validation_contract_version from vortex_definition.releases
             where root_id = ${applicationRootId}::uuid and release_revision = 1)
              as application_version,
            (select validation_contract_version from vortex_definition.releases
             where root_id = ${moduleRootId}::uuid and release_revision = 1)
              as module_version
        `,
      ).resolves.toEqual([{ application_version: "1.0.0", module_version: "2.0.0" }]);

      const namedPermissionIds = new Set([
        notePermissionId,
        setTitlePermissionId,
        setTitleAndNotePermissionId,
        validateReferencesPermissionId,
        openPermissionId,
        createNotePermissionId,
        createNoteForPermissionId,
        createRestrictedNotePermissionId,
        createRuledChildPermissionId,
        noteAndCreatePermissionId,
        addChildPermissionId,
        setAmountAndAddSiblingPermissionId,
        createAnchoredNotePermissionId,
        // Ordinary create authority on the creation targets, and ordinary read
        // on the one link target that is not the command's subject. Ordinary
        // `item` read is deliberately absent, so a creation that links to its
        // own subject can only succeed through the named-action authority.
        createdNoteCreatePermissionId,
        createdNoteReadPermissionId,
        totalChildCreatePermissionId,
        totalParentReadPermissionId,
      ]);
      const namedOnlyPermissions = allRolePermissions.filter((candidate) => {
        if (typeof candidate !== "object" || candidate === null) return false;
        return namedPermissionIds.has(
          String((candidate as { permissionId?: unknown }).permissionId),
        );
      });
      expect(namedOnlyPermissions).toHaveLength(17);
      await admin`select * from vortex_access.coordinate_organization_role_change(
        ${JSON.stringify({
          contractVersion: "1.0.0",
          candidate: {
            operation: "revise_custom_permissions",
            organizationId,
            roleId,
            expectedRoleRevision: 1,
            key: "record_save_operator",
            label: "Record save operator",
            description: "Standing access for the neutral real-service proof.",
            privilegeClassification: "standard",
            assignmentPolicy: { kind: "standing" },
            permissions: namedOnlyPermissions,
          },
          roleCandidateFingerprint: fingerprintCanonicalValue({ roleId, revision: 2 }),
        })}::text::jsonb,
        ${actorId}::uuid, ${id(159)}::uuid
      )`;

      const runNamedAction = async (candidate: {
        commandId: string;
        actionId: string;
        expectedConcurrencyNumber: number;
        inputs: Record<string, unknown>;
        activityId: string;
        standardOccurrenceId: string;
        declaredOccurrenceIds: readonly string[];
        creationOccurrenceIds?: readonly string[];
        ownerId?: string;
        releaseRevision?: number;
        targetRecordTypeId?: string;
        targetRecordId?: string;
      }) => {
        // The service mints the subject's standard occurrence first, then one
        // per declared Event, then one per created record.
        const occurrences = [
          candidate.standardOccurrenceId,
          ...candidate.declaredOccurrenceIds,
          ...(candidate.creationOccurrenceIds ?? []),
        ];
        const namedActions = createNamedActionService({
          identityAuthorityId,
          clock: () => operationAt,
          correlationId: () => id(27),
          activityId: () => candidate.activityId,
          occurrenceId: () => {
            const value = occurrences.shift();
            if (value === undefined) throw new Error("Unexpected named Event allocation");
            return value;
          },
          resolvedRequestTransaction,
        });
        return namedActions.execute(session, selection, {
          contractVersion: "2.0.0",
          commandId: candidate.commandId,
          action: {
            ownerKind: "module",
            ownerId: candidate.ownerId ?? moduleRootId,
            releaseRevision: candidate.releaseRevision ?? 1,
            actionId: candidate.actionId,
          },
          recordTypeId: candidate.targetRecordTypeId ?? recordTypeId,
          recordId: candidate.targetRecordId ?? namedRecordId,
          expectedConcurrencyNumber: candidate.expectedConcurrencyNumber,
          inputs: candidate.inputs,
        });
      };
      const namedEffects = async () => {
        const [value] = await admin<
          { receipts: string; activities: string; outbox: string; queue: string }[]
        >`
          select
            (select count(*)::text from vortex_record.named_action_command_receipts
             where organization_id = ${organizationId}::uuid) receipts,
            (select count(*)::text from vortex_activity.organization_activity_entries
             where organization_id = ${organizationId}::uuid
               and action = 'execute_named_action') activities,
            (select count(*)::text from vortex_event.event_outbox
             where organization_id = ${organizationId}::uuid
               and envelope #>> '{descriptor,kind}' = 'declared') outbox,
            (select count(*)::text from pgmq.q_vortex_event_occurrences queued
             join vortex_event.event_outbox event
               on queued.message ->> 'occurrenceId' = event.occurrence_id::text
             where event.organization_id = ${organizationId}::uuid
               and event.envelope #>> '{descriptor,kind}' = 'declared') queue
        `;
        if (value === undefined) throw new Error("Named action effects are unavailable");
        return value;
      };
      expect(await namedEffects()).toEqual({
        receipts: "0",
        activities: "0",
        outbox: "0",
        queue: "0",
      });

      const eventOnly = {
        commandId: commandNamedEventId,
        actionId: noteActionId,
        expectedConcurrencyNumber: 1,
        inputs: {},
        activityId: activityNamedEventId,
        standardOccurrenceId: occurrenceNamedSetId,
        declaredOccurrenceIds: [occurrenceNamedEventId],
      };
      const eventOnlyResult = await runNamedAction(eventOnly);
      expect(await namedEffects()).toEqual({
        receipts: "1",
        activities: "1",
        outbox: "1",
        queue: "1",
      });
      expect(eventOnlyResult).toEqual({
        kind: "available",
        value: expect.objectContaining({
          outcome: "completed",
          recordId: namedRecordId,
          concurrencyNumber: 1,
        }),
      });
      await expect(runNamedAction(eventOnly)).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "completed", recordId: namedRecordId, concurrencyNumber: 1 },
      });
      expect(await namedEffects()).toEqual({
        receipts: "1",
        activities: "1",
        outbox: "1",
        queue: "1",
      });

      await expect(
        runNamedAction({
          commandId: commandNamedSetId,
          actionId: setTitleActionId,
          expectedConcurrencyNumber: 1,
          inputs: { title: "Named set" },
          activityId: activityNamedSetId,
          standardOccurrenceId: occurrenceNamedSetId,
          declaredOccurrenceIds: [],
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "completed", recordId: namedRecordId, concurrencyNumber: 2 },
      });
      expect(await namedEffects()).toEqual({
        receipts: "2",
        activities: "2",
        outbox: "1",
        queue: "1",
      });
      await expect(
        admin<
          { action: string; subject_ids: string[]; changed_field_ids: string[]; outcome: string }[]
        >`select action, subject_ids, changed_field_ids, outcome
          from vortex_activity.organization_activity_entries
          where activity_id = ${activityNamedSetId}::uuid`,
      ).resolves.toEqual([
        {
          action: "execute_named_action",
          subject_ids: [namedRecordId],
          changed_field_ids: [fieldId, calculatedFieldId],
          outcome: "completed",
        },
      ]);

      await expect(
        runNamedAction({
          commandId: commandNamedMixedId,
          actionId: setTitleAndNoteActionId,
          expectedConcurrencyNumber: 2,
          inputs: { title: "Named mixed" },
          activityId: activityNamedMixedId,
          standardOccurrenceId: occurrenceNamedMixedStandardId,
          declaredOccurrenceIds: [occurrenceNamedMixedDeclaredId],
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "completed", recordId: namedRecordId, concurrencyNumber: 3 },
      });
      expect(await namedEffects()).toEqual({
        receipts: "3",
        activities: "3",
        outbox: "2",
        queue: "2",
      });
      await expect(
        admin<{ payload: unknown; descriptor: unknown }[]>`
          select envelope -> 'payload' as payload,
            envelope -> 'descriptor' as descriptor from vortex_event.event_outbox
          where occurrence_id = ${occurrenceNamedMixedDeclaredId}::uuid
        `,
      ).resolves.toEqual([
        {
          payload: { kind: "declared", carriedValues: { [fieldId]: "Named mixed" } },
          descriptor: expect.objectContaining({
            kind: "declared",
            owner: { kind: "module", moduleRootId },
          }),
        },
      ]);

      const beforeWrongOwner = await namedEffects();
      await expect(
        runNamedAction({
          commandId: id(166),
          actionId: setTitleActionId,
          ownerId: applicationRootId,
          expectedConcurrencyNumber: 3,
          inputs: { title: "Wrong owner must not run" },
          activityId: id(167),
          standardOccurrenceId: id(168),
          declaredOccurrenceIds: [],
        }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(await namedEffects()).toEqual(beforeWrongOwner);

      const beforeRefusal = await namedEffects();
      await expect(
        runNamedAction({
          commandId: commandNamedRefusalId,
          actionId: setTitleActionId,
          expectedConcurrencyNumber: 3,
          inputs: { title: "x".repeat(121) },
          activityId: activityNamedRefusalId,
          standardOccurrenceId: id(145),
          declaredOccurrenceIds: [],
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "operation_refused" } },
      });
      expect(await namedEffects()).toEqual(beforeRefusal);

      await expect(
        runNamedAction({
          commandId: commandNamedRollbackId,
          actionId: setTitleAndNoteActionId,
          expectedConcurrencyNumber: 3,
          inputs: { title: "Must roll back" },
          activityId: activityNamedRollbackId,
          standardOccurrenceId: id(146),
          declaredOccurrenceIds: [occurrenceNamedMixedDeclaredId],
        }),
      ).resolves.toEqual({ kind: "temporarily_unavailable" });
      expect(await namedEffects()).toEqual(beforeRefusal);
      await expect(
        runNamedAction({
          commandId: id(147),
          actionId: setTitleActionId,
          expectedConcurrencyNumber: 2,
          inputs: { title: "Stale mutation" },
          activityId: id(148),
          standardOccurrenceId: id(149),
          declaredOccurrenceIds: [],
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "conflict" } },
      });
      expect(await namedEffects()).toEqual(beforeRefusal);

      const competingResults = await Promise.all([
        runNamedAction({
          commandId: commandNamedRaceOneId,
          actionId: setTitleActionId,
          expectedConcurrencyNumber: 3,
          inputs: { title: "Race one" },
          activityId: activityNamedRaceOneId,
          standardOccurrenceId: occurrenceNamedRaceOneId,
          declaredOccurrenceIds: [],
        }),
        runNamedAction({
          commandId: commandNamedRaceTwoId,
          actionId: setTitleActionId,
          expectedConcurrencyNumber: 3,
          inputs: { title: "Race two" },
          activityId: activityNamedRaceTwoId,
          standardOccurrenceId: occurrenceNamedRaceTwoId,
          declaredOccurrenceIds: [],
        }),
      ]);
      expect(
        competingResults.filter(
          (result) => result.kind === "available" && result.value.outcome === "completed",
        ),
      ).toHaveLength(1);
      expect(
        competingResults.filter(
          (result) =>
            result.kind === "available" &&
            result.value.outcome === "refused" &&
            result.value.error.code === "conflict",
        ),
      ).toHaveLength(1);
      expect(await namedEffects()).toEqual({
        receipts: "4",
        activities: "4",
        outbox: "2",
        queue: "2",
      });

      const [namedRecordState] = await admin.unsafe<{ title: string; revision: string }[]>(
        `select f_${fieldId.replaceAll("-", "")} as title, concurrency_number::text as revision
         from record_data.rt_${storageContractId.replaceAll("-", "")}
         where organisation_id = $1 and record_id = $2`,
        [organizationId, namedRecordId],
      );
      expect(namedRecordState).toEqual({
        title: expect.stringMatching(/^Race (one|two)$/),
        revision: "4",
      });

      // ---------------------------------------------------------------------
      // #50 slice 2: the create_record effect. Every assertion below runs under
      // the named-only role, which holds no ordinary `item` read.
      // ---------------------------------------------------------------------
      const createdNoteTable = `record_data.rt_${createdNoteStorageId.replaceAll("-", "")}`;
      const ruledChildTable = `record_data.rt_${ruledChildStorageId.replaceAll("-", "")}`;
      const namedParentTable = `record_data.rt_${totalParentStorageId.replaceAll("-", "")}`;
      const namedChildTable = `record_data.rt_${totalChildStorageId.replaceAll("-", "")}`;
      const namedSubjectTable = `record_data.rt_${storageContractId.replaceAll("-", "")}`;
      const column = (value: string) => `f_${value.replaceAll("-", "")}`;
      const readCreatedNotes = async () =>
        admin.unsafe<
          {
            record_id: string;
            title: string;
            body: string | null;
            reference: string | null;
            restricted: string | null;
            person: string | null;
            at: string | null;
            amount: string | null;
            source: string | null;
          }[]
        >(
          `select record_id::text as record_id,
             ${column(createdNoteTitleFieldId)} as title,
             ${column(createdNoteBodyFieldId)} as body,
             ${column(createdNoteReferenceFieldId)} as reference,
             ${column(createdNoteRestrictedFieldId)} as restricted,
             ${column(createdNotePersonFieldId)}::text as person,
             ${column(createdNoteAtFieldId)}::text as at,
             ${column(createdNoteAmountFieldId)}::text as amount,
             ${column(createdNoteSourceFieldId)}::text as source
           from ${createdNoteTable}
           where organisation_id = $1
           order by ${column(createdNoteReferenceFieldId)}`,
          [organizationId],
        );
      const readCreateEffectState = async () => {
        const [state] = await admin.unsafe<
          {
            notes: string;
            ruled: string;
            edges: string;
            counter: string;
            receipts: string;
            activities: string;
            subject_title: string;
            subject_revision: string;
          }[]
        >(
          `select
             (select pg_catalog.count(*)::text from ${createdNoteTable}
              where organisation_id = $1) as notes,
             (select pg_catalog.count(*)::text from ${ruledChildTable}
              where organisation_id = $1) as ruled,
             (select pg_catalog.count(*)::text from vortex_record.relationship_edges
              where relationship_id = $3 and from_organisation_id = $1) as edges,
             (select coalesce(pg_catalog.max(next_number)::text, 'none')
              from vortex_record.record_reference_counters
              where organization_id = $1 and storage_contract_id = $4) as counter,
             (select pg_catalog.count(*)::text
              from vortex_record.named_action_command_receipts
              where organization_id = $1) as receipts,
             (select pg_catalog.count(*)::text
              from vortex_activity.organization_activity_entries
              where organization_id = $1 and action = 'execute_named_action') as activities,
             (select ${column(fieldId)} from ${namedSubjectTable}
              where organisation_id = $1 and record_id = $2) as subject_title,
             (select concurrency_number::text from ${namedSubjectTable}
              where organisation_id = $1 and record_id = $2) as subject_revision`,
          [organizationId, createSubjectId, createdNoteSourceRelationshipId, createdNoteStorageId],
        );
        if (state === undefined) throw new Error("create_record effect state is unavailable");
        return state;
      };

      const beforeCreate = await readCreateEffectState();
      const createNoteCommand = {
        commandId: id(410),
        actionId: createNoteActionId,
        expectedConcurrencyNumber: 1,
        inputs: { body: "Composed body" },
        activityId: id(411),
        standardOccurrenceId: id(412),
        declaredOccurrenceIds: [] as readonly string[],
        creationOccurrenceIds: [id(413)],
        targetRecordId: createSubjectId,
      };
      const createNoteResult = await runNamedAction(createNoteCommand);
      expect(createNoteResult).toMatchObject({
        kind: "available",
        // A create-only action whose created record is not one of the subject's
        // own totals leaves the subject's revision exactly where it was.
        value: { outcome: "completed", recordId: createSubjectId, concurrencyNumber: 1 },
      });
      const [composedNote] = await readCreatedNotes();
      if (composedNote === undefined) throw new Error("The created Record is missing");
      expect(composedNote).toMatchObject({
        title: "Created by action",
        body: "Composed body",
        reference: "NOTE-00001",
        restricted: null,
      });
      expect(composedNote.person).toContain(organizationAccountId);
      expect(composedNote.amount).toContain("12.34");
      expect(composedNote.at).not.toBeNull();
      expect(composedNote.source).toContain(createSubjectId);
      const afterCreate = await readCreateEffectState();
      expect(afterCreate).toMatchObject({
        notes: "1",
        // The created record's link names the command's own subject, which this
        // actor cannot read through any ordinary permission.
        edges: "1",
        counter: "2",
        subject_revision: "1",
        receipts: String(Number(beforeCreate.receipts) + 1),
        // Exactly two: the subject's content-free entry and the created
        // record's own completed entry.
        activities: String(Number(beforeCreate.activities) + 2),
      });
      await expect(
        admin`select envelope #>> '{descriptor,kind}' as descriptor_kind,
            envelope #>> '{descriptor,eventKind}' as event_kind
          from vortex_event.event_outbox
          where organization_id = ${organizationId}::uuid
            and occurrence_id = ${id(413)}::uuid`,
      ).resolves.toEqual([{ descriptor_kind: "standard", event_kind: "created" }]);

      // Exact replay creates nothing and burns no reference number.
      await expect(runNamedAction(createNoteCommand)).resolves.toEqual(createNoteResult);
      expect(await readCreateEffectState()).toEqual(afterCreate);
      // A conflicting reuse of the same command identity refuses.
      await expect(
        runNamedAction({ ...createNoteCommand, inputs: { body: "Different body" } }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "operation_refused" } },
      });
      expect(await readCreateEffectState()).toEqual(afterCreate);

      // A link target that is not the command's subject keeps the ordinary read
      // requirement, which this actor does not hold.
      await expect(
        runNamedAction({
          commandId: id(414),
          actionId: createNoteForActionId,
          expectedConcurrencyNumber: 1,
          inputs: { target: { recordTypeId, recordId: referencedRecordId } },
          activityId: id(415),
          standardOccurrenceId: id(416),
          declaredOccurrenceIds: [],
          creationOccurrenceIds: [id(417)],
          targetRecordId: createSubjectId,
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "operation_refused" } },
      });
      expect(await readCreateEffectState()).toEqual(afterCreate);
      // The same action, the same field, the command's own subject as the
      // target: allowed by the installed named authority alone.
      await expect(
        runNamedAction({
          commandId: id(418),
          actionId: createNoteForActionId,
          expectedConcurrencyNumber: 1,
          inputs: { target: { recordTypeId, recordId: createSubjectId } },
          activityId: id(419),
          standardOccurrenceId: id(420),
          declaredOccurrenceIds: [],
          creationOccurrenceIds: [id(421)],
          targetRecordId: createSubjectId,
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "completed", concurrencyNumber: 1 },
      });
      const afterSubjectLink = await readCreateEffectState();
      expect(afterSubjectLink).toMatchObject({ notes: "2", edges: "2", counter: "3" });

      // Mixed set_field, create_record and announce_event in one commit.
      await expect(
        runNamedAction({
          commandId: id(422),
          actionId: noteAndCreateActionId,
          expectedConcurrencyNumber: 1,
          inputs: { title: "Mixed effects" },
          activityId: id(423),
          standardOccurrenceId: id(424),
          declaredOccurrenceIds: [id(425)],
          creationOccurrenceIds: [id(426)],
          targetRecordId: createSubjectId,
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "completed", concurrencyNumber: 2 },
      });
      const afterMixed = await readCreateEffectState();
      expect(afterMixed).toMatchObject({
        notes: "3",
        subject_title: "Mixed effects",
        subject_revision: "2",
      });
      await expect(
        admin`select pg_catalog.count(*)::text as declared
          from vortex_event.event_outbox
          where organization_id = ${organizationId}::uuid
            and occurrence_id = ${id(425)}::uuid
            and envelope #>> '{descriptor,kind}' = 'declared'`,
      ).resolves.toEqual([{ declared: "1" }]);

      const readNamedTotalState = async () => {
        const [state] = await admin.unsafe<
          {
            parent_total: string;
            parent_revision: string;
            children: string;
            child_revision: string;
            parent_changed: string;
          }[]
        >(
          `select
             (select ${column(totalParentSumFieldId)}::text from ${namedParentTable}
              where organisation_id = $1 and record_id = $2) as parent_total,
             (select concurrency_number::text from ${namedParentTable}
              where organisation_id = $1 and record_id = $2) as parent_revision,
             (select pg_catalog.count(*)::text from ${namedChildTable}
              where organisation_id = $1) as children,
             (select concurrency_number::text from ${namedChildTable}
              where organisation_id = $1 and record_id = $3) as child_revision,
             (select pg_catalog.count(*)::text from vortex_event.event_outbox
              where organization_id = $1
                and (envelope ->> 'recordId')::uuid = $2
                and envelope #>> '{descriptor,eventKind}' = 'changed') as parent_changed`,
          [organizationId, namedParentId, namedChildId],
        );
        if (state === undefined) throw new Error("Named total state is unavailable");
        return state;
      };
      const beforeAddChild = await readNamedTotalState();
      expect(beforeAddChild).toMatchObject({ parent_total: "4", parent_revision: "2" });
      // Create-only where the created record links to the subject and the
      // subject declares the total over that relationship: the subject advances
      // by exactly one revision and carries exactly one changed occurrence,
      // without any fabricated field change.
      await expect(
        runNamedAction({
          commandId: id(427),
          actionId: addChildActionId,
          expectedConcurrencyNumber: 2,
          inputs: { amount: "7" },
          activityId: id(428),
          standardOccurrenceId: id(429),
          declaredOccurrenceIds: [],
          creationOccurrenceIds: [id(430)],
          targetRecordTypeId: totalParentRecordTypeId,
          targetRecordId: namedParentId,
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "completed", recordId: namedParentId, concurrencyNumber: 3 },
      });
      const afterAddChild = await readNamedTotalState();
      expect(afterAddChild).toMatchObject({
        parent_total: "11",
        parent_revision: "3",
        children: String(Number(beforeAddChild.children) + 1),
        parent_changed: String(Number(beforeAddChild.parent_changed) + 1),
      });

      // One merged closure: the subject's own change and the created sibling
      // both reach the shared parent, which advances by exactly one revision.
      await expect(
        runNamedAction({
          commandId: id(431),
          actionId: setAmountAndAddSiblingActionId,
          expectedConcurrencyNumber: 1,
          inputs: { amount: "6", sibling: "3" },
          activityId: id(432),
          standardOccurrenceId: id(433),
          declaredOccurrenceIds: [],
          creationOccurrenceIds: [id(434)],
          targetRecordTypeId: totalChildRecordTypeId,
          targetRecordId: namedChildId,
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "completed", recordId: namedChildId, concurrencyNumber: 2 },
      });
      expect(await readNamedTotalState()).toMatchObject({
        parent_total: "16",
        parent_revision: "4",
        child_revision: "2",
        children: String(Number(beforeAddChild.children) + 2),
        parent_changed: String(Number(beforeAddChild.parent_changed) + 2),
      });

      // A target field outside the create field bounds is only decidable after
      // the insert, so the whole command rolls back: no created record, no
      // reference number, no edge, no Activity, no receipt.
      const beforeLateDenial = await readCreateEffectState();
      await expect(
        runNamedAction({
          commandId: id(435),
          actionId: createRestrictedNoteActionId,
          expectedConcurrencyNumber: 2,
          inputs: {},
          activityId: id(436),
          standardOccurrenceId: id(437),
          declaredOccurrenceIds: [],
          creationOccurrenceIds: [id(438)],
          targetRecordId: createSubjectId,
        }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(await readCreateEffectState()).toEqual(beforeLateDenial);
      // The same rollback for a target record type the actor cannot create.
      await expect(
        runNamedAction({
          commandId: id(439),
          actionId: createRuledChildActionId,
          expectedConcurrencyNumber: 2,
          inputs: {},
          activityId: id(440),
          standardOccurrenceId: id(441),
          declaredOccurrenceIds: [],
          creationOccurrenceIds: [id(442)],
          targetRecordId: createSubjectId,
        }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(await readCreateEffectState()).toEqual(beforeLateDenial);

      // Mixed-path concurrency. Each iteration races the new create-bearing
      // named action against an ordinary create of the same target record type
      // linked to the same record, so both transactions contend for the same
      // reference-number counter, the same link-target row and the same
      // relationship advisory key, in each path's own acquisition order. The
      // ordinary path allocates its counter before locking the link target;
      // the named path locks its closure first. Any inversion between the two
      // surfaces here as `40P01`, which the request runner reports as
      // `temporarily_unavailable`.
      const raceIterations = 20;
      for (let iteration = 0; iteration < raceIterations; iteration += 1) {
        const [namedRace, ordinaryRace] = await Promise.all([
          runNamedAction({
            commandId: id(600 + iteration * 4),
            actionId: createAnchoredNoteActionId,
            // The anchored note contributes to no total on its link target, so
            // the raced parent revision stays where the earlier assertions left
            // it.
            expectedConcurrencyNumber: 4,
            inputs: { body: `Race ${iteration}` },
            activityId: id(601 + iteration * 4),
            standardOccurrenceId: id(602 + iteration * 4),
            declaredOccurrenceIds: [],
            creationOccurrenceIds: [id(603 + iteration * 4)],
            targetRecordTypeId: totalParentRecordTypeId,
            targetRecordId: namedParentId,
          }),
          service.save(session, selection, {
            contractVersion: "2.0.0",
            commandId: id(700 + iteration),
            operation: "create",
            recordTypeId: createdNoteRecordTypeId,
            submittedValues: {
              [createdNoteTitleFieldId]: `Ordinary race ${iteration}`,
              [createdNoteAnchorFieldId]: {
                recordTypeId: totalParentRecordTypeId,
                recordId: namedParentId,
              },
            },
          }),
        ]);
        expect(namedRace).toMatchObject({
          kind: "available",
          value: { outcome: "completed" },
        });
        expect(ordinaryRace).toMatchObject({
          kind: "available",
          value: { outcome: "saved" },
        });
      }
      const afterRace = await readCreateEffectState();
      expect(afterRace).toMatchObject({
        notes: String(Number(beforeLateDenial.notes) + raceIterations * 2),
        receipts: String(Number(beforeLateDenial.receipts) + raceIterations),
      });

      // A stale expected revision and a forged action owner both refuse before
      // any creation.
      await expect(
        runNamedAction({
          commandId: id(443),
          actionId: createNoteActionId,
          expectedConcurrencyNumber: 1,
          inputs: { body: "Stale" },
          activityId: id(444),
          standardOccurrenceId: id(445),
          declaredOccurrenceIds: [],
          creationOccurrenceIds: [id(446)],
          targetRecordId: createSubjectId,
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "conflict" } },
      });
      await expect(
        runNamedAction({
          commandId: id(447),
          actionId: createNoteActionId,
          expectedConcurrencyNumber: 2,
          inputs: { body: "Forged owner" },
          activityId: id(448),
          standardOccurrenceId: id(449),
          declaredOccurrenceIds: [],
          creationOccurrenceIds: [id(450)],
          ownerId: applicationRootId,
          targetRecordId: createSubjectId,
        }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(await readCreateEffectState()).toEqual(afterRace);

      await admin`select * from vortex_access.coordinate_organization_role_change(
        ${JSON.stringify({
          contractVersion: "1.0.0",
          candidate: {
            operation: "revise_custom_permissions",
            organizationId,
            roleId,
            expectedRoleRevision: 2,
            key: "record_save_operator",
            label: "Record save operator",
            description: "Standing access for the neutral real-service proof.",
            privilegeClassification: "standard",
            assignmentPolicy: { kind: "standing" },
            permissions: namedOnlyPermissions.filter(
              (candidate) =>
                typeof candidate === "object" &&
                candidate !== null &&
                String((candidate as { permissionId?: unknown }).permissionId) === openPermissionId,
            ),
          },
          roleCandidateFingerprint: fingerprintCanonicalValue({ roleId, revision: 3 }),
        })}::text::jsonb,
        ${actorId}::uuid, ${id(161)}::uuid
      )`;
      const deniedWriterResult = await admin.begin(async (transaction) => {
        const [scope] = await transaction<
          { tenant_id: string; organization_account_id: string; access_version: string }[]
        >`select * from vortex_access.resolve_human_application_change_scope(
          ${identityId}::uuid, ${organizationId}::uuid, ${applicationRootId}::uuid
        )`;
        if (scope === undefined) throw new Error("Named writer refusal scope is unavailable");
        await transaction`select vortex_context.initialize(${JSON.stringify({
          callerKind: "human",
          identityAuthorityId,
          tenantId: scope.tenant_id,
          organizationId,
          organizationAccountId: scope.organization_account_id,
          applicationRootId,
          identityId,
          sessionId: session.sessionId,
          authenticationStrength: session.authenticationStrength,
          accessTokenIssuedAt: session.accessTokenIssuedAt,
          primaryAuthenticatedAt: session.primaryAuthenticatedAt,
          issuedAt: operationAt.toISOString(),
          expiresAt: session.accessTokenExpiresAt,
          accessVersion: Number(scope.access_version),
          correlationId: id(27),
        })}::text::jsonb)`;
        await transaction`set local role vortex_record_adapter`;
        const [row] = await transaction<{ result: unknown }[]>`
          select vortex_record.save_named_action_set_fields_internal(
            ${id(210)}::uuid, 'update', ${recordTypeId}::uuid,
            ${namedRecordId}::uuid, 4,
            ${JSON.stringify({ [fieldId]: "Denied writer" })}::text::jsonb,
            ${JSON.stringify({ [fieldId]: "Denied writer" })}::text::jsonb,
            null::uuid, ${id(211)}::uuid, ${id(212)}::uuid,
            'module', ${moduleRootId}::uuid, 1, ${setTitleActionId}::uuid,
            ${JSON.stringify({ title: "Denied writer" })}::text::jsonb
          ) as result`;
        return row?.result;
      });
      expect(deniedWriterResult).toEqual({
        outcome: "refused_recorded",
        reasonCode: "record_unavailable",
      });
      await expect(
        admin<
          { action: string; subject_ids: string[]; changed_field_ids: string[]; outcome: string }[]
        >`select action, subject_ids, changed_field_ids, outcome
          from vortex_activity.organization_activity_entries
          where activity_id = ${id(211)}::uuid`,
      ).resolves.toEqual([
        {
          action: "execute_named_action",
          subject_ids: [namedRecordId],
          changed_field_ids: [],
          outcome: "refused",
        },
      ]);
      const beforeWithdrawnReplay = await namedEffects();
      await expect(runNamedAction(eventOnly)).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "operation_refused" } },
      });
      expect(await namedEffects()).toEqual(beforeWithdrawnReplay);
      await expect(
        runNamedAction({
          ...eventOnly,
          commandId: id(162),
          activityId: id(163),
          standardOccurrenceId: id(164),
          declaredOccurrenceIds: [id(165)],
          expectedConcurrencyNumber: 4,
        }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(await namedEffects()).toEqual({
        receipts: "29",
        activities: "56",
        outbox: "3",
        queue: "3",
      });

      const restoreRoleEvidence = prepareOrganizationRoleChangeEvidence({
        candidate: {
          operation: "revise_custom_permissions",
          organizationId,
          roleId,
          expectedRoleRevision: 3,
          key: "record_save_operator",
          label: "Record save operator",
          description: "Standing access for the neutral real-service proof.",
          privilegeClassification: "standard",
          assignmentPolicy: { kind: "standing" },
          permissions: allRolePermissions,
        },
        affectedAssignments: [
          {
            roleAssignmentId,
            expectedRevision: 1,
            assignee: { kind: "organization_account", organizationAccountId },
          },
        ],
      });
      await admin`select * from vortex_access.coordinate_organization_role_change(
        ${JSON.stringify(restoreRoleEvidence)}::text::jsonb,
        ${actorId}::uuid, ${id(160)}::uuid
      )`;

      // Exercise legacy V1 string references through the public named-action
      // service while retaining the installed V2 catalogue's exact target.
      await admin.begin(async (transaction) => {
        await transaction`set local session_replication_role = replica`;
        await transaction`update vortex_definition.releases
          set validation_contract_version = '1.0.0'
          where root_id = ${moduleRootId}::uuid and release_revision = 1`;
      });
      const referenceInputs = (account: string, record: string) => ({ account, record });
      const runReferenceAction = async (
        commandId: string,
        account: string,
        record: string,
        activityId: string,
        occurrenceId: string,
      ) =>
        runNamedAction({
          commandId,
          actionId: validateReferencesActionId,
          expectedConcurrencyNumber: 4,
          inputs: referenceInputs(account, record),
          activityId,
          standardOccurrenceId: occurrenceId,
          declaredOccurrenceIds: [occurrenceId],
        });

      await expect(
        runReferenceAction(
          id(182),
          otherOrganizationAccountId,
          referencedRecordId,
          id(183),
          id(184),
        ),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "completed", recordId: namedRecordId, concurrencyNumber: 4 },
      });
      await expect(
        runReferenceAction(id(185), organizationAccountId, referencedRecordId, id(186), id(187)),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "completed", recordId: namedRecordId, concurrencyNumber: 4 },
      });

      const expectReferenceRefusal = async (
        commandId: string,
        account: string,
        record: string,
        activityId: string,
        occurrenceId: string,
      ) => {
        const before = await namedEffects();
        await expect(
          runReferenceAction(commandId, account, record, activityId, occurrenceId),
        ).resolves.toMatchObject({
          kind: "available",
          value: { outcome: "refused", error: { code: "operation_refused" } },
        });
        expect(await namedEffects()).toEqual(before);
      };

      await expectReferenceRefusal(
        id(188),
        foreignOrganizationAccountId,
        referencedRecordId,
        id(189),
        id(190),
      );
      await expectReferenceRefusal(id(191), id(192), referencedRecordId, id(193), id(194));
      await expectReferenceRefusal(id(195), organizationAccountId, id(196), id(197), id(198));

      const referenceTable = `record_data.rt_${storageContractId.replaceAll("-", "")}`;
      await admin.begin(async (transaction) => {
        await transaction`set local session_replication_role = replica`;
        await transaction.unsafe(
          `update ${referenceTable} set organisation_id = $1 where record_id = $2`,
          [foreignOrganizationId, referencedRecordId],
        );
      });
      await expectReferenceRefusal(
        id(199),
        organizationAccountId,
        referencedRecordId,
        id(200),
        id(201),
      );
      await admin.begin(async (transaction) => {
        await transaction`set local session_replication_role = replica`;
        await transaction.unsafe(
          `update ${referenceTable} set organisation_id = $1 where record_id = $2`,
          [organizationId, referencedRecordId],
        );
      });

      await admin.begin(async (transaction) => {
        await transaction`set local session_replication_role = replica`;
        await transaction.unsafe(
          `update ${referenceTable}
             set lifecycle_state = 'soft_deleted', deleted_at = pg_catalog.statement_timestamp(),
                 deleted_by = $1
           where organisation_id = $2 and record_id = $3`,
          [organizationAccountId, organizationId, referencedRecordId],
        );
      });
      await expectReferenceRefusal(
        id(202),
        organizationAccountId,
        referencedRecordId,
        id(203),
        id(204),
      );
      await admin.begin(async (transaction) => {
        await transaction`set local session_replication_role = replica`;
        await transaction.unsafe(
          `update ${referenceTable}
             set lifecycle_state = 'active', deleted_at = null, deleted_by = null
           where organisation_id = $1 and record_id = $2`,
          [organizationId, referencedRecordId],
        );
      });

      await admin.begin(async (transaction) => {
        await transaction`set local session_replication_role = replica`;
        await transaction.unsafe(
          `update ${referenceTable} set application_root_id = $1
           where organisation_id = $2 and record_id = $3`,
          [wrongApplicationRootId, organizationId, referencedRecordId],
        );
      });
      await expectReferenceRefusal(
        id(205),
        organizationAccountId,
        referencedRecordId,
        id(206),
        id(207),
      );
      await admin.begin(async (transaction) => {
        await transaction`set local session_replication_role = replica`;
        await transaction.unsafe(
          `update ${referenceTable} set application_root_id = $1
           where organisation_id = $2 and record_id = $3`,
          [applicationRootId, organizationId, referencedRecordId],
        );
      });
      await admin.begin(async (transaction) => {
        await transaction`set local session_replication_role = replica`;
        await transaction`update vortex_definition.releases
          set validation_contract_version = '2.0.0'
          where root_id = ${moduleRootId}::uuid and release_revision = 1`;
      });

      const fresh = await service.save(session, selection, {
        contractVersion: "2.0.0",
        commandId: commandFreshId,
        operation: "create",
        recordTypeId,
        submittedValues: { [fieldId]: "Fresh settings" },
      });
      expect(fresh).toMatchObject({
        kind: "available",
        value: {
          outcome: "saved",
          concurrencyNumber: 1,
          readableValues: {
            [fieldId]: "Fresh settings",
            [amountFieldId]: { amount: "12.34", currency: "AUD" },
          },
        },
      });
      if (fresh.kind !== "available" || fresh.value.outcome !== "saved")
        throw new Error("Fresh settings save did not return its Record");
      const freshRecordId = fresh.value.recordId;
      await expect(
        service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId: commandFreshId,
          operation: "create",
          recordTypeId,
          submittedValues: { [fieldId]: "Fresh settings" },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: {
          outcome: "saved",
          recordId: freshRecordId,
          concurrencyNumber: 1,
          readableValues: {
            [amountFieldId]: { amount: "12.34", currency: "AUD" },
          },
        },
      });

      const storageTable = `record_data.rt_${storageContractId.replaceAll("-", "")}`;
      const fieldColumn = `f_${fieldId.replaceAll("-", "")}`;
      const amountColumn = `f_${amountFieldId.replaceAll("-", "")}`;
      const calculatedFieldColumn = `f_${calculatedFieldId.replaceAll("-", "")}`;
      const privateSourceFieldColumn = `f_${privateSourceFieldId.replaceAll("-", "")}`;
      const privateDirectFieldColumn = `f_${privateDirectFieldId.replaceAll("-", "")}`;
      const privateTransitiveFieldColumn = `f_${privateTransitiveFieldId.replaceAll("-", "")}`;
      const countTerminalEffects = async () => {
        const [counts] = await admin.unsafe<
          {
            receipt_count: string;
            activity_count: string;
            outbox_count: string;
            queue_count: string;
          }[]
        >(
          `select
            (select pg_catalog.count(*)::text from vortex_record.save_command_receipts
             where organization_id = $1) as receipt_count,
            (select pg_catalog.count(*)::text from vortex_activity.organization_activity_entries
             where organization_id = $1) as activity_count,
            (select pg_catalog.count(*)::text from vortex_event.event_outbox
             where organization_id = $1) as outbox_count,
            (select pg_catalog.count(*)::text from pgmq.q_vortex_event_occurrences as queued
             join vortex_event.event_outbox as event
               on queued.message ->> 'occurrenceId' = event.occurrence_id::text
             where event.organization_id = $1) as queue_count`,
          [organizationId],
        );
        if (counts === undefined) throw new Error("Record save effects are missing");
        return counts;
      };
      const beforeMissingSettings = await countTerminalEffects();
      await admin`delete from vortex_identity.organization_runtime_settings
        where organization_id = ${organizationId}::uuid`;
      await expect(
        service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId: commandMissingSettingsId,
          operation: "create",
          recordTypeId,
          submittedValues: { [fieldId]: "Missing settings" },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "operation_refused" } },
      });
      expect(await countTerminalEffects()).toEqual(beforeMissingSettings);
      await expect(
        service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId: commandExplicitMoneyId,
          operation: "create",
          recordTypeId,
          submittedValues: {
            [fieldId]: "Explicit money without settings",
            [amountFieldId]: { amount: "5.00", currency: "USD" },
          },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: {
          outcome: "saved",
          readableValues: { [amountFieldId]: { amount: "5", currency: "USD" } },
        },
      });
      const [evidence] = await admin.unsafe<
        {
          title: string;
          amount: unknown;
          title_copy: string;
          private_source: string;
          private_direct: string;
          private_transitive: string;
          concurrency_number: string;
          receipt_count: string;
          activity_count: string;
          outbox_count: string;
          queue_count: string;
        }[]
      >(
        `select record.${fieldColumn} as title, record.${amountColumn} as amount,
          record.${calculatedFieldColumn} as title_copy,
          record.${privateSourceFieldColumn} as private_source,
          record.${privateDirectFieldColumn} as private_direct,
          record.${privateTransitiveFieldColumn} as private_transitive,
          record.concurrency_number::text,
          (select pg_catalog.count(*)::text from vortex_record.save_command_receipts
           where organization_id = $1) as receipt_count,
          (select pg_catalog.count(*)::text from vortex_activity.organization_activity_entries
           where organization_id = $1 and activity_id in ($3, $4)) as activity_count,
          (select pg_catalog.count(*)::text from vortex_event.event_outbox
           where organization_id = $1) as outbox_count,
          (select pg_catalog.count(*)::text from pgmq.q_vortex_event_occurrences as queued
           join vortex_event.event_outbox as event
             on queued.message ->> 'occurrenceId' = event.occurrence_id::text
           where event.organization_id = $1) as queue_count
         from ${storageTable} as record
         where record.organisation_id = $1 and record.record_id = $2`,
        [organizationId, recordId, activityCreateId, activityUpdateId],
      );
      expect(evidence).toEqual({
        title: "Updated once",
        amount: { amount: "12.34", currency: "NZD" },
        title_copy: "Updated once",
        private_source: "private generated source",
        private_direct: "private generated source",
        private_transitive: "private generated source",
        concurrency_number: "2",
        receipt_count: "29",
        activity_count: "2",
        outbox_count: "67",
        queue_count: "67",
      });
      await expect(
        admin.unsafe(
          `select ${amountColumn} as amount from ${storageTable}
           where organisation_id = $1 and record_id = $2`,
          [organizationId, freshRecordId],
        ),
      ).resolves.toEqual([{ amount: { amount: "12.34", currency: "AUD" } }]);
      expect(moduleRelease.content.recordTypes[0]?.customActionIds).toHaveLength(9);
      expect(moduleRelease.content.events).toHaveLength(1);

      const createTotalParent = async (commandId: string, title: string) => {
        const saved = await service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId,
          operation: "create",
          recordTypeId: totalParentRecordTypeId,
          submittedValues: { [totalParentTitleFieldId]: title },
        });
        expect(saved).toMatchObject({
          kind: "available",
          value: {
            outcome: "saved",
            concurrencyNumber: 1,
            readableValues: {
              [totalParentSumFieldId]: "0",
              [totalParentDisplayFieldId]: "1",
            },
          },
        });
        if (saved.kind !== "available" || saved.value.outcome !== "saved")
          throw new Error("Transactional total parent was not created");
        return saved.value.recordId;
      };
      const parentOneId = await createTotalParent(commandParentOneId, "Parent one");
      const parentTwoId = await createTotalParent(commandParentTwoId, "Parent two");
      const childCreated = await service.save(session, selection, {
        contractVersion: "2.0.0",
        commandId: commandChildCreateId,
        operation: "create",
        recordTypeId: totalChildRecordTypeId,
        submittedValues: {
          [totalChildTitleFieldId]: "Contributing child",
          [totalChildAmountFieldId]: "10.25",
          [totalChildIncludedFieldId]: true,
          [totalChildFilterOperandFieldId]: "1",
          [totalChildParentFieldId]: {
            recordTypeId: totalParentRecordTypeId,
            recordId: parentOneId,
          },
        },
      });
      expect(childCreated).toMatchObject({
        kind: "available",
        value: { outcome: "saved", concurrencyNumber: 1 },
      });
      if (childCreated.kind !== "available" || childCreated.value.outcome !== "saved")
        throw new Error("Transactional total child was not created");
      const childId = childCreated.value.recordId;

      const updateTotalChild = async (
        commandId: string,
        expectedConcurrencyNumber: number,
        submittedValues: Record<string, unknown>,
        targetChildId = childId,
      ) => {
        const result = await service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId,
          operation: "update",
          recordTypeId: totalChildRecordTypeId,
          recordId: targetChildId,
          expectedConcurrencyNumber,
          submittedValues,
        });
        expect(result).toMatchObject({
          kind: "available",
          value: { outcome: "saved", concurrencyNumber: expectedConcurrencyNumber + 1 },
        });
        return result;
      };
      await updateTotalChild(commandChildUpdateId, 1, {
        [totalChildAmountFieldId]: "12.5",
      });
      await updateTotalChild(commandChildFilterId, 2, {
        [totalChildFilterOperandFieldId]: "-1",
      });
      await updateTotalChild(commandChildReincludeId, 3, {
        [totalChildFilterOperandFieldId]: "1",
      });
      const moveCommand = {
        contractVersion: "2.0.0" as const,
        commandId: commandChildMoveId,
        operation: "update" as const,
        recordTypeId: totalChildRecordTypeId,
        recordId: childId,
        expectedConcurrencyNumber: 4,
        submittedValues: {
          [totalChildParentFieldId]: {
            recordTypeId: totalParentRecordTypeId,
            recordId: parentTwoId,
          },
        },
      };
      await expect(service.save(session, selection, moveCommand)).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "saved", concurrencyNumber: 5 },
      });

      const totalParentTable = `record_data.rt_${totalParentStorageId.replaceAll("-", "")}`;
      const totalColumn = `f_${totalParentSumFieldId.replaceAll("-", "")}`;
      const displayColumn = `f_${totalParentDisplayFieldId.replaceAll("-", "")}`;
      await expect(
        admin.unsafe(
          `select record_id::text as record_id, ${totalColumn}::text as total,
             ${displayColumn}::text as display, concurrency_number::text as revision
           from ${totalParentTable}
           where organisation_id = $1 and record_id in ($2, $3)
           order by record_id`,
          [organizationId, parentOneId, parentTwoId],
        ),
      ).resolves.toEqual(
        [
          { record_id: parentOneId, total: "0", display: "1", revision: "6" },
          { record_id: parentTwoId, total: "12.5", display: "13.5", revision: "2" },
        ].sort((left, right) => left.record_id.localeCompare(right.record_id)),
      );
      const beforeMoveReplay = await countTerminalEffects();
      await expect(service.save(session, selection, moveCommand)).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "saved", concurrencyNumber: 5 },
      });
      expect(await countTerminalEffects()).toEqual(beforeMoveReplay);
      await expect(
        service.save(session, selection, {
          ...moveCommand,
          submittedValues: {
            [totalChildParentFieldId]: {
              recordTypeId: totalParentRecordTypeId,
              recordId: parentOneId,
            },
          },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "conflict" } },
      });

      const secondChildCreated = await service.save(session, selection, {
        contractVersion: "2.0.0",
        commandId: commandSecondChildCreateId,
        operation: "create",
        recordTypeId: totalChildRecordTypeId,
        submittedValues: {
          [totalChildTitleFieldId]: "Concurrent child",
          [totalChildAmountFieldId]: "1",
          [totalChildIncludedFieldId]: true,
          [totalChildFilterOperandFieldId]: "1",
          [totalChildParentFieldId]: {
            recordTypeId: totalParentRecordTypeId,
            recordId: parentTwoId,
          },
        },
      });
      expect(secondChildCreated).toMatchObject({
        kind: "available",
        value: { outcome: "saved", concurrencyNumber: 1 },
      });
      if (secondChildCreated.kind !== "available" || secondChildCreated.value.outcome !== "saved")
        throw new Error("Second transactional total child was not created");
      await expect(
        Promise.all([
          updateTotalChild(commandFirstChildConcurrentId, 5, {
            [totalChildAmountFieldId]: "20",
          }),
          updateTotalChild(
            commandSecondChildConcurrentId,
            1,
            { [totalChildAmountFieldId]: "3" },
            secondChildCreated.value.recordId,
          ),
        ]),
      ).resolves.toHaveLength(2);
      await expect(
        admin.unsafe(
          `select ${totalColumn}::text as total, ${displayColumn}::text as display,
             concurrency_number::text as revision
           from ${totalParentTable}
           where organisation_id = $1 and record_id = $2`,
          [organizationId, parentTwoId],
        ),
      ).resolves.toEqual([{ total: "23", display: "24", revision: "5" }]);
      await expect(
        service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId: commandStaleTotalParentId,
          operation: "update",
          recordTypeId: totalParentRecordTypeId,
          recordId: parentTwoId,
          expectedConcurrencyNumber: 1,
          submittedValues: { [totalParentTitleFieldId]: "Stale title" },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "conflict" } },
      });

      await admin.unsafe(`
        set role vortex_record_adapter;
        create or replace function pg_temp.delay_exact_total_receipt()
        returns trigger language plpgsql as $function$
        begin
          if new.command_id = '${commandOverlappingReplayId}'::uuid
            and old.state = 'pending' and new.state = 'completed' then
            perform pg_catalog.pg_sleep(0.25);
          end if;
          return new;
        end
        $function$;
        create trigger delay_exact_total_receipt
          before update on vortex_record.save_command_receipts
          for each row execute function pg_temp.delay_exact_total_receipt();
        reset role;
      `);
      const overlappingCommand = {
        contractVersion: "2.0.0" as const,
        commandId: commandOverlappingReplayId,
        operation: "update" as const,
        recordTypeId: totalChildRecordTypeId,
        recordId: childId,
        expectedConcurrencyNumber: 6,
        submittedValues: { [totalChildAmountFieldId]: "21" },
      };
      const beforeOverlappingReplay = await countTerminalEffects();
      const overlappingResults = await Promise.all([
        service.save(session, selection, overlappingCommand),
        service.save(session, selection, overlappingCommand),
      ]);
      expect(overlappingResults).toEqual([
        expect.objectContaining({
          kind: "available",
          value: expect.objectContaining({ outcome: "saved", concurrencyNumber: 7 }),
        }),
        expect.objectContaining({
          kind: "available",
          value: expect.objectContaining({ outcome: "saved", concurrencyNumber: 7 }),
        }),
      ]);
      await admin.unsafe(`
        set role vortex_record_adapter;
        drop trigger delay_exact_total_receipt on vortex_record.save_command_receipts;
        drop function pg_temp.delay_exact_total_receipt();
        reset role;
      `);
      const afterOverlappingReplay = await countTerminalEffects();
      expect({
        receipts:
          Number(afterOverlappingReplay.receipt_count) -
          Number(beforeOverlappingReplay.receipt_count),
        activities:
          Number(afterOverlappingReplay.activity_count) -
          Number(beforeOverlappingReplay.activity_count),
        outbox:
          Number(afterOverlappingReplay.outbox_count) -
          Number(beforeOverlappingReplay.outbox_count),
        queue:
          Number(afterOverlappingReplay.queue_count) - Number(beforeOverlappingReplay.queue_count),
      }).toEqual({ receipts: 1, activities: 2, outbox: 2, queue: 2 });

      // A context is only accepted while its Access version is current. This
      // reaches the composed total writer with an otherwise valid child update
      // and confirms stale authority cannot acquire its locked save path.
      const beforeStaleAccessScope = await countTerminalEffects();
      await expect(
        runtime.begin(async (transaction) => {
          const [scope] = await transaction<
            { tenant_id: string; organization_account_id: string; access_version: string }[]
          >`select * from vortex_access.resolve_human_application_change_scope(
            ${identityId}::uuid, ${organizationId}::uuid, ${applicationRootId}::uuid
          )`;
          if (scope === undefined || Number(scope.access_version) <= 1)
            throw new Error("Stale access-scope proof is unavailable");
          await transaction`select vortex_context.initialize(${JSON.stringify({
            callerKind: "human",
            identityAuthorityId,
            tenantId: scope.tenant_id,
            organizationId,
            organizationAccountId: scope.organization_account_id,
            applicationRootId,
            identityId,
            sessionId: session.sessionId,
            authenticationStrength: session.authenticationStrength,
            accessTokenIssuedAt: session.accessTokenIssuedAt,
            primaryAuthenticatedAt: session.primaryAuthenticatedAt,
            issuedAt: operationAt.toISOString(),
            expiresAt: session.accessTokenExpiresAt,
            accessVersion: Number(scope.access_version) - 1,
            correlationId: id(27),
          })}::text::jsonb)`;
          await transaction`set local role vortex_runtime`;
          await transaction`
            select vortex_record.save_base_record_with_relationship_totals(
              ${commandStaleAccessScopeId}::uuid, 'update',
              ${totalChildRecordTypeId}::uuid, ${childId}::uuid, 7,
              ${JSON.stringify({ [totalChildAmountFieldId]: "22" })}::text::jsonb,
              ${JSON.stringify({ [totalChildAmountFieldId]: "22" })}::text::jsonb,
              null::uuid, ${activityStaleAccessScopeId}::uuid,
              ${occurrenceStaleAccessScopeId}::uuid, '[]'::jsonb
            )`;
        }),
      ).rejects.toMatchObject({
        code: "42501",
        message: "Request access version is stale or unavailable",
      });
      expect(await countTerminalEffects()).toEqual(beforeStaleAccessScope);

      const beforeUnjoinedWriter = await countTerminalEffects();
      const unjoinedWriterResult = await runtime.begin(async (transaction) => {
        const [scope] = await transaction<
          { tenant_id: string; organization_account_id: string; access_version: string }[]
        >`select * from vortex_access.resolve_human_application_change_scope(
          ${identityId}::uuid, ${organizationId}::uuid, ${applicationRootId}::uuid
        )`;
        if (scope === undefined) throw new Error("Unjoined writer scope is unavailable");
        await transaction`select vortex_context.initialize(${JSON.stringify({
          callerKind: "human",
          identityAuthorityId,
          tenantId: scope.tenant_id,
          organizationId,
          organizationAccountId: scope.organization_account_id,
          applicationRootId,
          identityId,
          sessionId: session.sessionId,
          authenticationStrength: session.authenticationStrength,
          accessTokenIssuedAt: session.accessTokenIssuedAt,
          primaryAuthenticatedAt: session.primaryAuthenticatedAt,
          issuedAt: operationAt.toISOString(),
          expiresAt: session.accessTokenExpiresAt,
          accessVersion: Number(scope.access_version),
          correlationId: id(27),
        })}::text::jsonb)`;
        await transaction`set local role vortex_runtime`;
        const [row] = await transaction<{ result: unknown }[]>`
          select vortex_record.save_base_record_with_relationship_totals(
            ${commandUnjoinedWriterId}::uuid, 'update',
            ${totalChildRecordTypeId}::uuid, ${childId}::uuid, 7,
            ${JSON.stringify({ [totalChildAmountFieldId]: "22" })}::text::jsonb,
            ${JSON.stringify({ [totalChildAmountFieldId]: "22" })}::text::jsonb,
            null::uuid, ${activityUnjoinedWriterId}::uuid,
            ${occurrenceUnjoinedWriterId}::uuid,
            ${JSON.stringify([
              {
                recordTypeId: totalParentRecordTypeId,
                recordId: parentTwoId,
                expectedConcurrencyNumber: 6,
                finalValues: {},
              },
            ])}::text::jsonb
          ) as result`;
        return row?.result;
      });
      expect(unjoinedWriterResult).toEqual({
        outcome: "refused",
        reasonCode: "unsupported_relationship_total_save",
      });
      expect(await countTerminalEffects()).toEqual(beforeUnjoinedWriter);
      await expect(
        admin.unsafe(
          `select child.concurrency_number::text as child_revision,
             child.f_${totalChildAmountFieldId.replaceAll("-", "")}::text as child_amount,
             parent.concurrency_number::text as parent_revision,
             parent.${totalColumn}::text as parent_total
           from record_data.rt_${totalChildStorageId.replaceAll("-", "")} child
           join ${totalParentTable} parent
             on parent.organisation_id = child.organisation_id and parent.record_id = $3
           where child.organisation_id = $1 and child.record_id = $2`,
          [organizationId, childId, parentTwoId],
        ),
      ).resolves.toEqual([
        {
          child_revision: "7",
          child_amount: "21",
          parent_revision: "6",
          parent_total: "24",
        },
      ]);

      const beforeParentActivityFailure = await countTerminalEffects();
      await admin.unsafe(`
        create or replace function pg_temp.fail_total_parent_activity()
        returns trigger language plpgsql as $function$
        begin
          if '${parentTwoId}'::uuid = any (new.subject_ids) then
            raise exception using errcode = '55000', message = 'injected total parent Activity failure';
          end if;
          return new;
        end
        $function$;
        create trigger fail_total_parent_activity
          before insert on vortex_activity.organization_activity_entries
          for each row execute function pg_temp.fail_total_parent_activity();
      `);
      await expect(
        service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId: commandParentActivityFailureId,
          operation: "update",
          recordTypeId: totalChildRecordTypeId,
          recordId: childId,
          expectedConcurrencyNumber: 7,
          submittedValues: { [totalChildAmountFieldId]: "99" },
        }),
      ).resolves.toEqual({ kind: "temporarily_unavailable" });
      await admin.unsafe(`
        drop trigger fail_total_parent_activity on vortex_activity.organization_activity_entries;
        drop function pg_temp.fail_total_parent_activity();
      `);
      expect(await countTerminalEffects()).toEqual(beforeParentActivityFailure);
      await expect(
        admin.unsafe(
          `select ${totalColumn}::text as total, ${displayColumn}::text as display,
             concurrency_number::text as revision
           from ${totalParentTable}
           where organisation_id = $1 and record_id = $2`,
          [organizationId, parentTwoId],
        ),
      ).resolves.toEqual([{ total: "24", display: "25", revision: "6" }]);
      await expect(
        admin.unsafe(
          `select concurrency_number::text as revision,
             f_${totalChildAmountFieldId.replaceAll("-", "")}::text as amount
           from record_data.rt_${totalChildStorageId.replaceAll("-", "")}
           where organisation_id = $1 and record_id = $2`,
          [organizationId, childId],
        ),
      ).resolves.toEqual([{ revision: "7", amount: "21" }]);

      const createRecursiveRecord = async (commandId: string, title: string, parentId?: string) => {
        const saved = await service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId,
          operation: "create",
          recordTypeId: recursiveRecordTypeId,
          submittedValues: {
            [recursiveTitleFieldId]: title,
            ...(parentId === undefined
              ? {}
              : {
                  [recursiveParentFieldId]: {
                    recordTypeId: recursiveRecordTypeId,
                    recordId: parentId,
                  },
                }),
          },
        });
        expect(saved).toMatchObject({
          kind: "available",
          value: { outcome: "saved", concurrencyNumber: 1 },
        });
        if (saved.kind !== "available" || saved.value.outcome !== "saved")
          throw new Error("Recursive total Record was not created");
        return saved.value.recordId;
      };
      const recursiveGrandId = await createRecursiveRecord(
        commandRecursiveGrandId,
        "Recursive grand",
      );
      const recursiveParentId = await createRecursiveRecord(
        commandRecursiveParentId,
        "Recursive parent",
        recursiveGrandId,
      );
      const recursiveLeafId = await createRecursiveRecord(
        commandRecursiveLeafId,
        "Recursive leaf",
        recursiveParentId,
      );
      const recursiveTable = `record_data.rt_${recursiveStorageId.replaceAll("-", "")}`;
      const recursiveTotalColumn = `f_${recursiveChildrenTotalFieldId.replaceAll("-", "")}`;
      await expect(
        admin.unsafe(
          `select record_id::text as record_id, concurrency_number::text as revision,
             ${recursiveTotalColumn}::text as children_total
           from ${recursiveTable}
           where organisation_id = $1 and record_id in ($2, $3, $4)
           order by record_id`,
          [organizationId, recursiveGrandId, recursiveParentId, recursiveLeafId],
        ),
      ).resolves.toEqual(
        [
          { record_id: recursiveGrandId, revision: "1", children_total: "0" },
          { record_id: recursiveParentId, revision: "1", children_total: "0" },
          { record_id: recursiveLeafId, revision: "1", children_total: "0" },
        ].sort((left, right) => left.record_id.localeCompare(right.record_id)),
      );
      const beforeRecursiveCycle = await countTerminalEffects();
      await expect(
        service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId: commandRecursiveCycleId,
          operation: "update",
          recordTypeId: recursiveRecordTypeId,
          recordId: recursiveGrandId,
          expectedConcurrencyNumber: 1,
          submittedValues: {
            [recursiveParentFieldId]: {
              recordTypeId: recursiveRecordTypeId,
              recordId: recursiveLeafId,
            },
          },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "operation_refused" } },
      });
      expect(await countTerminalEffects()).toEqual(beforeRecursiveCycle);
      await expect(
        admin.unsafe(
          `select concurrency_number::text as revision,
             f_${recursiveParentFieldId.replaceAll("-", "")} as parent
           from ${recursiveTable}
           where organisation_id = $1 and record_id = $2`,
          [organizationId, recursiveGrandId],
        ),
      ).resolves.toEqual([{ revision: "1", parent: null }]);

      await updateTotalChild(commandMoneySourceId, 7, {
        [totalChildMoneyFieldId]: { amount: "5.25", currency: "NZD" },
      });
      const totalMoneyColumn = `f_${totalParentMoneyFieldId.replaceAll("-", "")}`;
      const childMoneyColumn = `f_${totalChildMoneyFieldId.replaceAll("-", "")}`;
      await expect(
        admin.unsafe(
          `select ${totalMoneyColumn} as money_total
           from ${totalParentTable}
           where organisation_id = $1 and record_id = $2`,
          [organizationId, parentTwoId],
        ),
      ).resolves.toEqual([{ money_total: { amount: "5.25", currency: "NZD" } }]);
      await admin.unsafe(
        `update record_data.rt_${totalChildStorageId.replaceAll("-", "")}
         set ${childMoneyColumn} = $3::jsonb
         where organisation_id = $1 and record_id = $2`,
        [
          organizationId,
          secondChildCreated.value.recordId,
          JSON.stringify({ amount: "1", currency: "AUD" }),
        ],
      );
      const beforeMixedCurrency = await countTerminalEffects();
      await expect(
        service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId: commandMixedCurrencyId,
          operation: "update",
          recordTypeId: totalChildRecordTypeId,
          recordId: childId,
          expectedConcurrencyNumber: 8,
          submittedValues: { [totalChildAmountFieldId]: "22" },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "operation_refused" } },
      });
      expect(await countTerminalEffects()).toEqual(beforeMixedCurrency);
      await expect(
        admin.unsafe(
          `select concurrency_number::text as revision,
             f_${totalChildAmountFieldId.replaceAll("-", "")}::text as amount
           from record_data.rt_${totalChildStorageId.replaceAll("-", "")}
           where organisation_id = $1 and record_id = $2`,
          [organizationId, childId],
        ),
      ).resolves.toEqual([{ revision: "8", amount: "21" }]);
      await admin.unsafe(
        `update record_data.rt_${totalChildStorageId.replaceAll("-", "")}
         set ${childMoneyColumn} = null
         where organisation_id = $1 and record_id = $2`,
        [organizationId, secondChildCreated.value.recordId],
      );

      expect(totalParentStorageId.localeCompare(totalChildStorageId)).toBeLessThan(0);
      const [lowerParentId, higherParentId] = [parentOneId, parentTwoId].sort();
      if (lowerParentId === undefined || higherParentId === undefined)
        throw new Error("Changed-closure parent order is unavailable");
      await expect(
        service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId: commandChangedClosureSetupId,
          operation: "update",
          recordTypeId: totalChildRecordTypeId,
          recordId: childId,
          expectedConcurrencyNumber: 8,
          submittedValues: {
            [totalChildParentFieldId]: {
              recordTypeId: totalParentRecordTypeId,
              recordId: higherParentId,
            },
          },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "saved", concurrencyNumber: 9 },
      });
      let releaseClosureLock!: () => void;
      let reportClosureLock!: () => void;
      const closureLockReleased = new Promise<void>((resolve) => {
        releaseClosureLock = resolve;
      });
      const closureLockAcquired = new Promise<void>((resolve) => {
        reportClosureLock = resolve;
      });
      const beforeChangedClosure = await countTerminalEffects();
      const beforeChangedClosureAttempts = requestTransactionAttempts;
      const closureBlocker = admin.begin(async (transaction) => {
        await transaction.unsafe(
          `select 1 from ${totalParentTable}
           where organisation_id = $1 and record_id = $2 for update`,
          [organizationId, lowerParentId],
        );
        reportClosureLock();
        await closureLockReleased;
      });
      await closureLockAcquired;
      const changedClosureSave = service.save(session, selection, {
        contractVersion: "2.0.0",
        commandId: commandChangedClosureId,
        operation: "update",
        recordTypeId: totalChildRecordTypeId,
        recordId: childId,
        expectedConcurrencyNumber: 9,
        submittedValues: {
          [totalChildParentFieldId]: {
            recordTypeId: totalParentRecordTypeId,
            recordId: lowerParentId,
          },
        },
      });
      let observedClosureWait = false;
      for (let attempt = 0; attempt < 50 && !observedClosureWait; attempt += 1) {
        const [state] = await raceAdmin<{ waiting: boolean }[]>`
          select exists (
            select 1 from pg_catalog.pg_stat_activity
            where state = 'active' and wait_event is not null
              and query like '%prepare_relationship_total_save%'
          ) as waiting`;
        observedClosureWait = state?.waiting ?? false;
        if (!observedClosureWait) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedClosureWait).toBe(true);
      await raceAdmin.begin(async (transaction) => {
        await transaction`set local session_replication_role = replica`;
        await transaction.unsafe(
          `update record_data.rt_${totalChildStorageId.replaceAll("-", "")}
           set f_${totalChildParentFieldId.replaceAll("-", "")} = $3::jsonb
           where organisation_id = $1 and record_id = $2`,
          [
            organizationId,
            childId,
            JSON.stringify({ recordTypeId: totalParentRecordTypeId, recordId: lowerParentId }),
          ],
        );
        await transaction`set local role vortex_record_owner`;
        await transaction`update vortex_record.relationship_edges
          set to_record_id = ${lowerParentId}::uuid
          where relationship_id = ${totalRelationshipId}::uuid
            and from_organisation_id = ${organizationId}::uuid
            and from_record_id = ${childId}::uuid`;
        await transaction`reset role`;
        await transaction.unsafe(
          `update ${totalParentTable}
           set ${totalColumn} = $3::numeric, ${displayColumn} = $4::numeric,
             ${totalMoneyColumn} = null,
             concurrency_number = concurrency_number + 1
           where organisation_id = $1 and record_id = $2`,
          [
            organizationId,
            higherParentId,
            higherParentId === parentTwoId ? "3" : "0",
            higherParentId === parentTwoId ? "4" : "1",
          ],
        );
      });
      releaseClosureLock();
      await closureBlocker;
      await expect(changedClosureSave).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "saved", concurrencyNumber: 10 },
      });
      expect(requestTransactionAttempts - beforeChangedClosureAttempts).toBe(2);
      const afterChangedClosure = await countTerminalEffects();
      expect(
        Number(afterChangedClosure.receipt_count) - Number(beforeChangedClosure.receipt_count),
      ).toBe(1);
      expect({
        activities:
          Number(afterChangedClosure.activity_count) - Number(beforeChangedClosure.activity_count),
        outbox:
          Number(afterChangedClosure.outbox_count) - Number(beforeChangedClosure.outbox_count),
        queue: Number(afterChangedClosure.queue_count) - Number(beforeChangedClosure.queue_count),
      }).toEqual({ activities: 2, outbox: 2, queue: 2 });
      await expect(
        admin.unsafe(
          `select record_id::text as record_id, ${totalColumn}::text as total,
             ${displayColumn}::text as display, ${totalMoneyColumn} as money
           from ${totalParentTable}
           where organisation_id = $1 and record_id in ($2, $3)
           order by record_id`,
          [organizationId, parentOneId, parentTwoId],
        ),
      ).resolves.toEqual(
        [
          {
            record_id: lowerParentId,
            total: lowerParentId === parentTwoId ? "24" : "21",
            display: lowerParentId === parentTwoId ? "25" : "22",
            money: { amount: "5.25", currency: "NZD" },
          },
          {
            record_id: higherParentId,
            total: higherParentId === parentTwoId ? "3" : "0",
            display: higherParentId === parentTwoId ? "4" : "1",
            money: null,
          },
        ].sort((left, right) => left.record_id.localeCompare(right.record_id)),
      );

      await admin.begin(async (transaction) => {
        await transaction`set local session_replication_role = replica`;
        await transaction`update vortex_definition.releases
          set compilation_output = pg_catalog.jsonb_set(
            compilation_output,
            '{canonical,content,rules}',
            ${JSON.stringify([
              {
                ruleId: id(84),
                key: "installed_rule_proof",
                subjectRecordTypeId: ruledChildRecordTypeId,
                trigger: "change",
                priority: 100,
                condition: {
                  kind: "comparison",
                  left: { source: "field", fieldId: ruledChildTitleFieldId },
                  operator: "is_not_empty",
                },
                effect: {
                  kind: "set_value",
                  fieldId: ruledChildTitleFieldId,
                  value: "Rule-owned value",
                },
              },
            ])}::text::jsonb
          )
          where root_id = ${moduleRootId}::uuid and release_revision = 1`;
      });
      const beforeRuledRelationship = await countTerminalEffects();
      const ruledPreparation = await runtime.begin(async (transaction) => {
        const [scope] = await transaction<
          { tenant_id: string; organization_account_id: string; access_version: string }[]
        >`select * from vortex_access.resolve_human_application_change_scope(
          ${identityId}::uuid, ${organizationId}::uuid, ${applicationRootId}::uuid
        )`;
        if (scope === undefined) throw new Error("Rule proof scope is unavailable");
        await transaction`select vortex_context.initialize(${JSON.stringify({
          callerKind: "human",
          identityAuthorityId,
          tenantId: scope.tenant_id,
          organizationId,
          organizationAccountId: scope.organization_account_id,
          applicationRootId,
          identityId,
          sessionId: session.sessionId,
          authenticationStrength: session.authenticationStrength,
          accessTokenIssuedAt: session.accessTokenIssuedAt,
          primaryAuthenticatedAt: session.primaryAuthenticatedAt,
          issuedAt: operationAt.toISOString(),
          expiresAt: session.accessTokenExpiresAt,
          accessVersion: Number(scope.access_version),
          correlationId: id(27),
        })}::text::jsonb)`;
        await transaction`set local role vortex_runtime`;
        const [row] = await transaction<{ preparation: unknown }[]>`
          select vortex_record.prepare_relationship_total_save(
            ${commandRuledRelationshipId}::uuid, 'create',
            ${ruledChildRecordTypeId}::uuid, null::uuid, null::bigint,
            ${JSON.stringify({
              [ruledChildTitleFieldId]: "Must remain Rule-owned",
              [ruledChildParentFieldId]: {
                recordTypeId: totalParentRecordTypeId,
                recordId: parentOneId,
              },
            })}::text::jsonb,
            null::uuid, ${activityRuledRelationshipId}::uuid
          ) as preparation`;
        return row?.preparation;
      });
      expect(ruledPreparation).toEqual({ outcome: "defer" });
      expect(await countTerminalEffects()).toEqual(beforeRuledRelationship);
      await expect(
        admin.unsafe(
          `select pg_catalog.count(*)::text as count
           from record_data.rt_${ruledChildStorageId.replaceAll("-", "")}
           where organisation_id = $1`,
          [organizationId],
        ),
      ).resolves.toEqual([{ count: "0" }]);
      const readRuleDeferredTotalState = async () => ({
        effects: await countTerminalEffects(),
        child: await admin.unsafe(
          `select concurrency_number::text as revision,
             f_${totalChildTitleFieldId.replaceAll("-", "")} as title,
             f_${totalChildAmountFieldId.replaceAll("-", "")}::text as amount,
             f_${totalChildFilterOperandFieldId.replaceAll("-", "")}::text as filter_operand,
             f_${totalChildAmountStepOneFieldId.replaceAll("-", "")}::text as amount_step_one,
             f_${totalChildAggregateAmountFieldId.replaceAll("-", "")}::text as aggregate_amount,
             f_${totalChildIncludedForTotalFieldId.replaceAll("-", "")} as included_for_total
           from record_data.rt_${totalChildStorageId.replaceAll("-", "")}
           where organisation_id = $1 and record_id = $2`,
          [organizationId, childId],
        ),
        parents: await admin.unsafe(
          `select record_id::text as record_id, concurrency_number::text as revision,
             ${totalColumn}::text as total, ${displayColumn}::text as display,
             ${totalMoneyColumn} as money
           from ${totalParentTable}
           where organisation_id = $1 and record_id in ($2, $3)
           order by record_id`,
          [organizationId, parentOneId, parentTwoId],
        ),
      });
      const beforeRuleDeferredTotal = await readRuleDeferredTotalState();
      await expect(
        service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId: commandRuleDeferredTotalId,
          operation: "update",
          recordTypeId: totalChildRecordTypeId,
          recordId: childId,
          expectedConcurrencyNumber: 10,
          submittedValues: { [totalChildAmountFieldId]: "22" },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "operation_refused" } },
      });
      expect(await readRuleDeferredTotalState()).toEqual(beforeRuleDeferredTotal);
      await expect(
        service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId: commandRuleDeferredFilterId,
          operation: "update",
          recordTypeId: totalChildRecordTypeId,
          recordId: childId,
          expectedConcurrencyNumber: 10,
          submittedValues: { [totalChildFilterOperandFieldId]: "-1" },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "operation_refused" } },
      });
      expect(await readRuleDeferredTotalState()).toEqual(beforeRuleDeferredTotal);

      const beforeRuleTitle = await readRuleDeferredTotalState();
      await expect(
        service.save(session, selection, {
          contractVersion: "2.0.0",
          commandId: commandRuleUnrelatedTitleId,
          operation: "update",
          recordTypeId: totalChildRecordTypeId,
          recordId: childId,
          expectedConcurrencyNumber: 10,
          submittedValues: { [totalChildTitleFieldId]: "Rule-safe title" },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "saved", concurrencyNumber: 11 },
      });
      const afterRuleTitle = await readRuleDeferredTotalState();
      expect(afterRuleTitle.parents).toEqual(beforeRuleTitle.parents);
      expect(afterRuleTitle.child).toEqual([
        expect.objectContaining({ revision: "11", title: "Rule-safe title" }),
      ]);

      const stableOperandCommand = {
        contractVersion: "2.0.0" as const,
        commandId: commandRuleStableOperandId,
        operation: "update" as const,
        recordTypeId: totalChildRecordTypeId,
        recordId: childId,
        expectedConcurrencyNumber: 11,
        submittedValues: { [totalChildFilterOperandFieldId]: "2" },
      };
      const beforeStableOperand = await readRuleDeferredTotalState();
      await expect(service.save(session, selection, stableOperandCommand)).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "saved", concurrencyNumber: 12 },
      });
      const afterStableOperand = await readRuleDeferredTotalState();
      expect(afterStableOperand.parents).toEqual(beforeStableOperand.parents);
      expect(afterStableOperand.child).toEqual([
        expect.objectContaining({
          revision: "12",
          filter_operand: "2",
          aggregate_amount: "21",
          included_for_total: true,
        }),
      ]);
      const beforeStableReplay = await readRuleDeferredTotalState();
      await expect(service.save(session, selection, stableOperandCommand)).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "saved", concurrencyNumber: 12 },
      });
      expect(await readRuleDeferredTotalState()).toEqual(beforeStableReplay);
      await expect(
        service.save(session, selection, {
          ...stableOperandCommand,
          submittedValues: { [totalChildFilterOperandFieldId]: "3" },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "conflict" } },
      });
      expect(await readRuleDeferredTotalState()).toEqual(beforeStableReplay);

      await admin.begin(async (transaction) => {
        await transaction`set local session_replication_role = replica`;
        await transaction`update vortex_definition.releases
          set compilation_output = pg_catalog.jsonb_set(
            compilation_output, '{canonical,content,rules}', '[]'::jsonb
          )
          where root_id = ${moduleRootId}::uuid and release_revision = 1`;
      });

      expect(
        allRolePermissions.some(
          (permission) =>
            typeof permission === "object" &&
            permission !== null &&
            String((permission as { permissionId?: unknown }).permissionId) ===
              setTotalChildAmountPermissionId,
        ),
      ).toBe(true);
      const [beforeNamedTotal] = await admin.unsafe<
        {
          child_revision: string;
          child_amount: string;
          parent_revision: string;
          parent_total: string;
        }[]
      >(
        `select child.concurrency_number::text as child_revision,
           child.f_${totalChildAmountFieldId.replaceAll("-", "")}::text as child_amount,
           parent.concurrency_number::text as parent_revision,
           parent.${totalColumn}::text as parent_total
         from record_data.rt_${totalChildStorageId.replaceAll("-", "")} child
         join ${totalParentTable} parent
           on parent.organisation_id = child.organisation_id and parent.record_id = $3
         where child.organisation_id = $1 and child.record_id = $2`,
        [organizationId, childId, lowerParentId],
      );
      if (beforeNamedTotal === undefined)
        throw new Error("Named parent-total proof is unavailable");
      await expect(
        runNamedAction({
          commandId: id(169),
          actionId: setTotalChildAmountActionId,
          expectedConcurrencyNumber: 12,
          inputs: { amount: "23" },
          activityId: id(170),
          standardOccurrenceId: id(171),
          declaredOccurrenceIds: [],
          targetRecordTypeId: totalChildRecordTypeId,
          targetRecordId: childId,
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "completed", recordId: childId, concurrencyNumber: 13 },
      });
      await expect(
        admin.unsafe(
          `select child.concurrency_number::text as child_revision,
             child.f_${totalChildAmountFieldId.replaceAll("-", "")}::text as child_amount,
             parent.concurrency_number::text as parent_revision,
             parent.${totalColumn}::text as parent_total
           from record_data.rt_${totalChildStorageId.replaceAll("-", "")} child
           join ${totalParentTable} parent
             on parent.organisation_id = child.organisation_id and parent.record_id = $3
           where child.organisation_id = $1 and child.record_id = $2`,
          [organizationId, childId, lowerParentId],
        ),
      ).resolves.toEqual([
        {
          child_revision: "13",
          child_amount: "23",
          parent_revision: String(Number(beforeNamedTotal.parent_revision) + 1),
          parent_total: String(Number(beforeNamedTotal.parent_total) + 2),
        },
      ]);

      const readPersistedState = async () => {
        const [state] = await admin.unsafe<
          {
            title: string;
            amount: unknown;
            concurrency_number: string;
            receipt_count: string;
            outbox_count: string;
            queue_count: string;
          }[]
        >(
          `select record.${fieldColumn} as title, record.${amountColumn} as amount,
            record.concurrency_number::text,
            (select pg_catalog.count(*)::text from vortex_record.save_command_receipts
             where organization_id = $1) as receipt_count,
            (select pg_catalog.count(*)::text from vortex_event.event_outbox
             where organization_id = $1) as outbox_count,
            (select pg_catalog.count(*)::text from pgmq.q_vortex_event_occurrences as queued
             join vortex_event.event_outbox as event
               on queued.message ->> 'occurrenceId' = event.occurrence_id::text
             where event.organization_id = $1) as queue_count
           from ${storageTable} as record
           where record.organisation_id = $1 and record.record_id = $2`,
          [organizationId, recordId],
        );
        if (state === undefined) throw new Error("Persisted Record save state is missing");
        return state;
      };

      await admin`select * from vortex_access.coordinate_organization_role_assignment_change(
        'revoke', ${organizationId}::uuid, ${roleAssignmentId}::uuid, 1::bigint,
        null::uuid, null::bigint, null::text, null::uuid, null::uuid, null::text,
        null::timestamptz, null::timestamptz, ${actorId}::uuid, ${id(28)}::uuid
      )`;
      await expect(service.save(session, selection, updateCommand)).resolves.toEqual({
        kind: "available",
        value: {
          contractVersion: "2.0.0",
          outcome: "refused",
          error: {
            code: "operation_refused",
            messageKey: "errors.operation_refused",
            correlationId: id(27),
          },
        },
      });

      const beforeRevokedWrite = await readPersistedState();
      await expect(
        service.save(session, selection, {
          ...updateCommand,
          commandId: commandRevokedWriteId,
          expectedConcurrencyNumber: 2,
          submittedValues: { [fieldId]: "Changed after revocation" },
        }),
      ).resolves.toEqual({ kind: "unavailable" });
      const afterRevokedWrite = await readPersistedState();
      expect(afterRevokedWrite).toEqual(beforeRevokedWrite);

      expect(activityIds).toEqual([]);
      expect(occurrenceIds).toEqual([]);
    } catch (error) {
      failure = error;
    } finally {
      try {
        await runtime.end({ timeout: 1 });
      } catch (error) {
        if (failure === undefined) failure = error;
      }
      try {
        await raceAdmin.end({ timeout: 1 });
      } catch (error) {
        if (failure === undefined) failure = error;
      }
      try {
        await cleanRecordSaveFixture(admin);
      } catch (error) {
        if (failure === undefined) failure = error;
      }
      try {
        await admin.end({ timeout: 1 });
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
    if (failure !== undefined) throw failure;
  }, 45_000);
});
