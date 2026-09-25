-- Issue #986: Module and Application behaviour is authored as flows. Each flow
-- and each Application flow binding has a permanent source identity, and a
-- Module's before-save rule now keeps the identity of the BeforeSave flow it is
-- the executable form of. Extend the existing permanent source-identity
-- allocator with the 'flow' and 'flow_binding' kinds. Every existing kind stays
-- valid, so every existing row still satisfies the constraint; no function
-- changes.
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
      'shell_content_slot',
      'rule_node',
      'rule_input',
      'rule_variable',
      'flow',
      'flow_binding'
    )
  );
