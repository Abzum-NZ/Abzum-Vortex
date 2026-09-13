begin;

select plan(4);

grant usage on schema extensions to vortex_record_adapter;
grant execute on all functions in schema extensions to vortex_record_adapter;
set local role vortex_record_adapter;
set local search_path = extensions, public, pg_catalog;

select is(
  vortex_record.filter_calculated_readable_field_ids(
    jsonb_build_array(jsonb_build_object(
      'recordTypeId', '90000000-0000-4000-8000-000000000001',
      'fields', jsonb_build_array(
        jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000011', 'type', 'text'),
        jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000012', 'type', 'text'),
        jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000013', 'type', 'calculation', 'settings', jsonb_build_object('dependencyFieldIds', jsonb_build_array('90000000-0000-4000-8000-000000000012'))),
        jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000014', 'type', 'calculation', 'settings', jsonb_build_object('dependencyFieldIds', jsonb_build_array('90000000-0000-4000-8000-000000000013'))),
        jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000015', 'type', 'calculation', 'settings', jsonb_build_object('dependencyFieldIds', jsonb_build_array('90000000-0000-4000-8000-000000000011')))
      )
    )),
    '90000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      '90000000-0000-4000-8000-000000000011',
      '90000000-0000-4000-8000-000000000013',
      '90000000-0000-4000-8000-000000000014',
      '90000000-0000-4000-8000-000000000015'
    )
  ),
  jsonb_build_array(
    '90000000-0000-4000-8000-000000000011',
    '90000000-0000-4000-8000-000000000015'
  ),
  'hides calculated values with a directly hidden source while retaining independent values'
);

select is(
  vortex_record.filter_calculated_readable_field_ids(
    jsonb_build_array(jsonb_build_object(
      'recordTypeId', '90000000-0000-4000-8000-000000000001',
      'fields', jsonb_build_array(
        jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000011', 'type', 'text'),
        jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000012', 'type', 'text'),
        jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000013', 'type', 'calculation', 'settings', jsonb_build_object('dependencyFieldIds', jsonb_build_array('90000000-0000-4000-8000-000000000012'))),
        jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000014', 'type', 'calculation', 'settings', jsonb_build_object('dependencyFieldIds', jsonb_build_array('90000000-0000-4000-8000-000000000013')))
      )
    )),
    '90000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      '90000000-0000-4000-8000-000000000011',
      '90000000-0000-4000-8000-000000000012',
      '90000000-0000-4000-8000-000000000013',
      '90000000-0000-4000-8000-000000000014'
    )
  ),
  jsonb_build_array(
    '90000000-0000-4000-8000-000000000011',
    '90000000-0000-4000-8000-000000000012',
    '90000000-0000-4000-8000-000000000013',
    '90000000-0000-4000-8000-000000000014'
  ),
  'allows a transitive calculation only after every source is visible'
);

select is(
  vortex_record.filter_calculated_readable_field_ids(
    jsonb_build_array(jsonb_build_object(
      'recordTypeId', '90000000-0000-4000-8000-000000000001',
      'fields', jsonb_build_array(
        jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000011', 'type', 'text'),
        jsonb_build_object('fieldId', '90000000-0000-4000-8000-000000000013', 'type', 'calculation', 'settings', jsonb_build_object('dependencyFieldIds', jsonb_build_array('90000000-0000-4000-8000-000000000011')))
      )
    )),
    '90000000-0000-4000-8000-000000000001',
    jsonb_build_array('90000000-0000-4000-8000-000000000011')
  ),
  jsonb_build_array('90000000-0000-4000-8000-000000000011'),
  'does not disclose a calculated field unless that calculated field is itself authorized'
);

select is(
  vortex_record.filter_calculated_readable_field_ids(
    '[]'::jsonb,
    '90000000-0000-4000-8000-000000000001',
    jsonb_build_array('90000000-0000-4000-8000-000000000011')
  ),
  '[]'::jsonb,
  'fails closed for malformed record-type facts'
);

reset role;

select * from finish();

rollback;
