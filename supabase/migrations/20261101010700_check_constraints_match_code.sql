-- DT-9: the CHECK constraints allow exactly the values the code emits. Source identity kinds equal
-- the compiler's sourceIdentityKindSchema (flow_node and flow_edge added; the workflow, rule-graph
-- and their node kinds, which nothing emits, removed). Activity sources lose durable_workflow,
-- release dependencies lose platform_flow, permission registration revisions lose
-- platform_metadata_revision, and the flow effect ledger loses the specified_account principal.
-- No stored row holds a removed value.

set role vortex_owner;

alter table vortex_definition.source_identities
  drop constraint source_identities_kind_valid,
  add constraint source_identities_kind_valid check (kind = any (array[
    'root', 'storage_contract', 'record_type', 'field', 'relationship', 'permission', 'action',
    'rule', 'event', 'extension_point', 'sharing_condition', 'role', 'navigation_item', 'query',
    'block', 'block_placement', 'page', 'guided_step', 'pipeline', 'connection_binding',
    'interface', 'interface_operation', 'public_address', 'shell', 'shell_content_slot', 'flow',
    'flow_node', 'flow_edge', 'flow_binding'
  ]));

alter table vortex_record.organization_activity_entries
  drop constraint organization_activity_entries_source_valid,
  add constraint organization_activity_entries_source_valid check (source = any (array[
    'web', 'webmcp', 'programmatic_interface', 'connection', 'federation', 'system'
  ]));

alter table vortex_definition.release_dependencies
  drop constraint release_dependencies_kind_valid,
  add constraint release_dependencies_kind_valid check (dependency_kind = any (array[
    'module', 'connection_type', 'platform_block', 'platform_theme', 'application_flow',
    'application_flow_node', 'application_query', 'module_query', 'protected_operation'
  ]));

alter table vortex_access.permission_registration_revisions
  drop constraint permission_registration_revisions_operation_valid,
  add constraint permission_registration_revisions_operation_valid check (operation = any (array[
    'platform_initialize', 'register', 'update', 'reactivate', 'withdraw'
  ])),
  drop constraint permission_registration_revisions_transition_shape,
  add constraint permission_registration_revisions_transition_shape check (
    (registration_kind = 'platform' and operation = 'platform_initialize' and state = 'active')
    or (registration_kind = 'application' and (
      (operation = any (array['register', 'update', 'reactivate']) and state = 'active')
      or (operation = 'withdraw' and state = 'withdrawn')
    ))
  );

alter table vortex_platform.flow_effect_ledger
  drop constraint flow_effect_ledger_actor_origin_valid,
  add constraint flow_effect_ledger_actor_origin_valid check (
    (principal_kind = 'person'
      and principal_id = identity_id
      and vortex_platform.is_non_nil_uuid(principal_id::text)
      and origin_kind = 'person'
      and origin_id = principal_id
      and vortex_platform.is_non_nil_uuid(origin_id::text))
    or (principal_kind = 'system'
      and vortex_platform.is_non_nil_uuid(principal_id::text)
      and identity_id is null
      and origin_kind = any (array['event', 'schedule'])
      and vortex_platform.is_non_nil_uuid(origin_id::text))
  );

reset role;
