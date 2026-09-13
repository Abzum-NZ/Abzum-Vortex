begin;

select plan(9);

-- One foreign-organisation edge is intentionally present.  The private helper
-- must not treat it as a contributor to the current organisation's total.
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values (
  '90000000-0000-4000-8000-0000000000f1', 'total_disclosure', 'Total disclosure', 'active',
  pg_catalog.clock_timestamp(), '90000000-0000-4000-8000-0000000000f2', pg_catalog.clock_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  ('90000000-0000-4000-8000-0000000000f3', '90000000-0000-4000-8000-0000000000f1', null, 'current', 'Current', 'active', pg_catalog.clock_timestamp(), '90000000-0000-4000-8000-0000000000f2', pg_catalog.clock_timestamp(), 1),
  ('90000000-0000-4000-8000-0000000000f4', '90000000-0000-4000-8000-0000000000f1', null, 'foreign', 'Foreign', 'active', pg_catalog.clock_timestamp(), '90000000-0000-4000-8000-0000000000f2', pg_catalog.clock_timestamp(), 1);

set local role vortex_record_owner;
insert into vortex_record.storage_catalogue (
  storage_contract_id, physical_schema_token, physical_table_token, module_root_id, record_type_id,
  storage_scope, first_compatible_release_revision, last_compatible_release_revision, state,
  generator_contract_version, content_fingerprint, record_type_definition
) values
  ('90000000-0000-4000-8000-0000000000c1', 'record_data', 'rt_900000000000400080000000000000c1', '90000000-0000-4000-8000-0000000000d1', '90000000-0000-4000-8000-000000000002', 'organization_shared', 1, null, 'active', '1.0.0', 'sha256:' || pg_catalog.repeat('a', 64), '{}'::jsonb),
  ('90000000-0000-4000-8000-0000000000c2', 'record_data', 'rt_900000000000400080000000000000c2', '90000000-0000-4000-8000-0000000000d1', '90000000-0000-4000-8000-000000000001', 'organization_shared', 1, null, 'active', '1.0.0', 'sha256:' || pg_catalog.repeat('b', 64), '{}'::jsonb);
insert into vortex_record.field_storage_mappings (
  storage_contract_id, field_id, physical_column_token, database_value_type, field_definition,
  introduced_by_module_root_id, introduced_at_release_revision, retired_by_module_root_id,
  retired_at_release_revision, state
) values (
  '90000000-0000-4000-8000-0000000000c1', '90000000-0000-4000-8000-000000000021',
  'f_90000000000040008000000000000021', 'decimal', '{}'::jsonb,
  '90000000-0000-4000-8000-0000000000d1', 1, null, null, 'active'
);
insert into vortex_record.relationship_storage_mappings (
  relationship_id, module_root_id, release_revision, source_storage_contract_id, source_field_id,
  target_record_type_ids, cardinality, on_parent_delete, definition
) values (
  '90000000-0000-4000-8000-000000000101', '90000000-0000-4000-8000-0000000000d1', 1,
  '90000000-0000-4000-8000-0000000000c1', '90000000-0000-4000-8000-000000000021',
  array['90000000-0000-4000-8000-000000000001'::uuid], 'many_to_one', 'refuse', '{}'::jsonb
);
insert into vortex_record.relationship_edges (
  relationship_id, from_organisation_id, to_organisation_id, from_application_root_id,
  to_application_root_id, from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
) values (
  '90000000-0000-4000-8000-000000000101', '90000000-0000-4000-8000-0000000000f4', '90000000-0000-4000-8000-0000000000f4', null, null,
  '90000000-0000-4000-8000-0000000000c1', '90000000-0000-4000-8000-0000000000e1',
  '90000000-0000-4000-8000-0000000000c2', '90000000-0000-4000-8000-0000000000e2'
);
reset role;

grant usage on schema extensions to vortex_record_adapter;
grant execute on all functions in schema extensions to vortex_record_adapter;
set local role vortex_record_adapter;
set local search_path = extensions, public, pg_catalog;

-- A compact installed-definition fact set.  The parent has one total sourced
-- from the child through child -> parent.  The total aggregates `amount` and
-- filters on `visible_flag`; its display calculation is transitive.
create function pg_temp.related_total_record_types()
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'recordTypeId', '90000000-0000-4000-8000-000000000001',
      'fields', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000011', 'type', 'text'),
        pg_catalog.jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000012', 'type', 'total',
          'settings', pg_catalog.jsonb_build_object(
            'relationshipId', '90000000-0000-4000-8000-000000000101',
            'operation', 'sum', 'resultType', 'decimal_number',
            'fieldId', '90000000-0000-4000-8000-000000000021',
            'filter', pg_catalog.jsonb_build_object('kind', 'comparison',
              'left', pg_catalog.jsonb_build_object('source', 'field', 'fieldId', '90000000-0000-4000-8000-000000000022'),
              'operator', 'equals', 'right', pg_catalog.jsonb_build_object('source', 'literal', 'value', true)
            )
          )
        ),
        pg_catalog.jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000013', 'type', 'calculation',
          'settings', pg_catalog.jsonb_build_object('dependencyFieldIds', pg_catalog.jsonb_build_array('90000000-0000-4000-8000-000000000012')))
      ),
      'relationships', pg_catalog.jsonb_build_array()
    ),
    pg_catalog.jsonb_build_object(
      'recordTypeId', '90000000-0000-4000-8000-000000000002',
      'fields', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000021', 'type', 'decimal_number'),
        pg_catalog.jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000022', 'type', 'yes_no')
      ),
      'relationships', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('relationshipId', '90000000-0000-4000-8000-000000000101',
          'fromRecordTypeId', '90000000-0000-4000-8000-000000000002',
          'toRecordType', pg_catalog.jsonb_build_object('recordTypeId', '90000000-0000-4000-8000-000000000001'))
      )
    )
  )
$function$;

select is(
  vortex_record.total_dependency_contract_internal(
    pg_temp.related_total_record_types(),
    '90000000-0000-4000-8000-000000000001',
    (pg_temp.related_total_record_types() -> 0 -> 'fields' -> 1)
  )::text,
  pg_catalog.jsonb_build_object(
    'relationshipId', '90000000-0000-4000-8000-000000000101',
    'sourceRecordTypeId', '90000000-0000-4000-8000-000000000002',
    'sourceFieldIds', pg_catalog.jsonb_build_array(
      '90000000-0000-4000-8000-000000000021',
      '90000000-0000-4000-8000-000000000022'
    )
  )::text,
  'discovers only this installed relationship and its aggregate and filter inputs'::text
);

select is(
  vortex_record.filter_derived_readable_field_ids(
    pg_temp.related_total_record_types(),
    '90000000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(
      '90000000-0000-4000-8000-000000000011',
      '90000000-0000-4000-8000-000000000012',
      '90000000-0000-4000-8000-000000000013'
    ),
    pg_catalog.jsonb_build_object('90000000-0000-4000-8000-000000000012', true)
  )::text,
  pg_catalog.jsonb_build_array(
    '90000000-0000-4000-8000-000000000011',
    '90000000-0000-4000-8000-000000000012',
    '90000000-0000-4000-8000-000000000013'
  )::text,
  'allows a finite total then its display calculation when every related input is readable'::text
);

select is(
  vortex_record.filter_derived_readable_field_ids(
    pg_temp.related_total_record_types(),
    '90000000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(
      '90000000-0000-4000-8000-000000000011',
      '90000000-0000-4000-8000-000000000012',
      '90000000-0000-4000-8000-000000000013'
    ),
    pg_catalog.jsonb_build_object('90000000-0000-4000-8000-000000000012', false)
  )::text,
  pg_catalog.jsonb_build_array('90000000-0000-4000-8000-000000000011')::text,
  'suppresses both total and transitive display calculation when a related input is hidden'::text
);

select is(
  vortex_record.filter_derived_readable_field_ids(
    pg_temp.related_total_record_types(),
    '90000000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array('90000000-0000-4000-8000-000000000011'),
    pg_catalog.jsonb_build_object('90000000-0000-4000-8000-000000000012', true)
  )::text,
  pg_catalog.jsonb_build_array('90000000-0000-4000-8000-000000000011')::text,
  'does not disclose a total that its own field policy did not authorize'::text
);

select is(
  vortex_record.total_dependency_contract_internal(
    pg_temp.related_total_record_types(),
    '90000000-0000-4000-8000-000000000002',
    (pg_temp.related_total_record_types() -> 0 -> 'fields' -> 1)
  )::text,
  null::text,
  'a total cannot discover a relationship aimed at another record type or organisation binding'::text
);

reset role;
set local role vortex_record_adapter;
grant execute on function vortex_record.total_dependency_contract_internal(jsonb, uuid, jsonb),
  vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb)
  to vortex_record_owner;
grant execute on function pg_temp.related_total_record_types() to vortex_record_owner;
reset role;
set local role vortex_record_owner;
select ok(
  vortex_record.total_inputs_readable_internal(
    pg_catalog.jsonb_build_object(
      'context', pg_catalog.jsonb_build_object('organizationId', '90000000-0000-4000-8000-0000000000f3'),
      'facts', pg_catalog.jsonb_build_object(
        'binding', pg_catalog.jsonb_build_object('storageContractId', '90000000-0000-4000-8000-0000000000c2'),
        'recordTypes', pg_temp.related_total_record_types()
      )
    ),
    '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-0000000000e2',
    pg_temp.related_total_record_types() -> 0 -> 'fields' -> 1, '[]'::jsonb
  ),
  'a foreign-organisation relationship edge is not discovered as a current organisation total input'
);
reset role;
set local role vortex_record_adapter;
revoke execute on function vortex_record.total_dependency_contract_internal(jsonb, uuid, jsonb),
  vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb)
  from vortex_record_owner;
reset role;
set local role vortex_record_adapter;

-- The cycle guard is checked before any source row is loaded.  It proves an
-- actual revisit refuses rather than recursively reading a second copy.
select is(
  vortex_record.read_derived_field_ids_for_exact_record_internal(
    '90000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-0000000000aa',
    pg_catalog.jsonb_build_array('90000000-0000-4000-8000-000000000001:90000000-0000-4000-8000-0000000000aa')
  )::text,
  null::text,
  'an actual related-total cycle fails closed before any additional row read'::text
);

select ok(
  not has_function_privilege(
    'vortex_request',
    'vortex_record.total_inputs_readable_internal(jsonb,uuid,uuid,jsonb,jsonb)'::regprocedure,
    'EXECUTE'
  ),
  'request role cannot invoke the private related-total source reader'
);

select ok(
  not has_table_privilege('vortex_request', 'vortex_record.relationship_edges', 'SELECT'),
  'request role cannot enumerate relationship edges across organisations'
);

reset role;
select * from finish();
rollback;
