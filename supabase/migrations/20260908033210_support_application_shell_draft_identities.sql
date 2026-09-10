-- Reuse the existing atomic draft/identity allocator for native application
-- shells and named content slots. Existing identities and privileges do not change.
alter table vortex_definition.source_identities
  drop constraint source_identities_kind_valid,
  add constraint source_identities_kind_valid check (
    kind in (
      'root',
      'storage_contract',
      'record_type',
      'field',
      'relationship',
      'permission',
      'action',
      'rule',
      'event',
      'extension_point',
      'sharing_condition',
      'role',
      'navigation_item',
      'query',
      'block',
      'block_placement',
      'page',
      'guided_step',
      'workflow',
      'workflow_node',
      'pipeline',
      'connection_binding',
      'interface',
      'interface_operation',
      'public_address',
      'shell',
      'shell_content_slot'
    )
  );
