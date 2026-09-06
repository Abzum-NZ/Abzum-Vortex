\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_function(
  'vortex_access', 'evaluate_permission_saved_condition',
  array['jsonb', 'jsonb', 'jsonb', 'jsonb', 'uuid'],
  'Access has one pure private saved-condition predicate'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname,
      'securityDefiner', routine.prosecdef,
      'volatility', routine.provolatile,
      'configuration', routine.proconfig,
      'result', pg_catalog.pg_get_function_result(routine.oid)
    )
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_roles as owner_role on owner_role.oid = routine.proowner
    where routine.oid =
      'vortex_access.evaluate_permission_saved_condition(jsonb,jsonb,jsonb,jsonb,uuid)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres',
    'securityDefiner', false,
    'volatility', 'i',
    'configuration', array['search_path=""'],
    'result', 'boolean'
  ),
  'the saved-condition predicate is owner-held, immutable, invoker-rights and empty-search-path'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.evaluate_permission_saved_condition(jsonb,jsonb,jsonb,jsonb,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot call the private saved-condition predicate'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.typed_condition_temporal_value_internal(text,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.typed_condition_value_matches_internal(jsonb,text,boolean)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.evaluate_typed_condition_node_internal(jsonb,jsonb,jsonb,jsonb,jsonb,boolean)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot call private condition support functions'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

create temporary table typed_condition_corpus on commit drop as
select $typed_condition_vectors$
{
  "fields": [
    {"fieldId":"f3650000-0000-4000-8000-000000000001","type":"text"},
    {"fieldId":"f3650000-0000-4000-8000-000000000002","type":"decimal_number"},
    {"fieldId":"f3650000-0000-4000-8000-000000000003","type":"yes_no"},
    {"fieldId":"f3650000-0000-4000-8000-000000000004","type":"date"},
    {"fieldId":"f3650000-0000-4000-8000-000000000005","type":"date_time"},
    {"fieldId":"f3650000-0000-4000-8000-000000000006","type":"several_choices"},
    {"fieldId":"f3650000-0000-4000-8000-000000000007","type":"table"},
    {"fieldId":"f3650000-0000-4000-8000-000000000008","type":"link"},
    {"fieldId":"f3650000-0000-4000-8000-000000000009","type":"link_to_person"}
  ],
  "vectors": [
    {
      "name":"equals_null",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"value","value":null}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000001"],"fieldValues":{"f3650000-0000-4000-8000-000000000001":null},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"not_equals_boolean",
      "condition":{"kind":"comparison","operator":"not_equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000003"},"right":{"source":"value","value":false}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000003"],"fieldValues":{"f3650000-0000-4000-8000-000000000003":true},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"contains_text",
      "condition":{"kind":"comparison","operator":"contains","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"value","value":"pha"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000001"],"fieldValues":{"f3650000-0000-4000-8000-000000000001":"alpha"},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"not_contains_collection",
      "condition":{"kind":"comparison","operator":"not_contains","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000006"},"right":{"source":"value","value":"medium"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000006"],"fieldValues":{"f3650000-0000-4000-8000-000000000006":["high","low"]},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"in_number",
      "condition":{"kind":"comparison","operator":"in","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000002"},"right":{"source":"value","value":[1,2,3]}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000002"],"fieldValues":{"f3650000-0000-4000-8000-000000000002":2},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"not_in_text",
      "condition":{"kind":"comparison","operator":"not_in","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"value","value":["alpha","beta"]}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000001"],"fieldValues":{"f3650000-0000-4000-8000-000000000001":"gamma"},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"greater_than_number",
      "condition":{"kind":"comparison","operator":"greater_than","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000002"},"right":{"source":"value","value":1.5}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000002"],"fieldValues":{"f3650000-0000-4000-8000-000000000002":2.5},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"negative_zero_equals_zero",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000002"},"right":{"source":"value","value":0}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000002"],"fieldValues":{"f3650000-0000-4000-8000-000000000002":-0},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"greater_than_or_equal_datetime_offset",
      "condition":{"kind":"comparison","operator":"greater_than_or_equal","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000005"},"right":{"source":"value","value":"2026-09-07T00:00:00.123456Z"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000005"],"fieldValues":{"f3650000-0000-4000-8000-000000000005":"2026-09-07T12:00:00.123456+12:00"},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"less_than_year_zero_leap_date",
      "condition":{"kind":"comparison","operator":"less_than","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000004"},"right":{"source":"value","value":"0000-03-01"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000004"],"fieldValues":{"f3650000-0000-4000-8000-000000000004":"0000-02-29"},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"less_than_or_equal_code_point_text",
      "condition":{"kind":"comparison","operator":"less_than_or_equal","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"value","value":"😀"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000001"],"fieldValues":{"f3650000-0000-4000-8000-000000000001":"é"},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"is_empty_null",
      "condition":{"kind":"comparison","operator":"is_empty","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000007"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000007"],"fieldValues":{"f3650000-0000-4000-8000-000000000007":null},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"is_not_empty_array",
      "condition":{"kind":"comparison","operator":"is_not_empty","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000007"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000007"],"fieldValues":{"f3650000-0000-4000-8000-000000000007":[]},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"compound_all_any_not",
      "condition":{"kind":"all","conditions":[{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000003"},"right":{"source":"value","value":true}},{"kind":"any","conditions":[{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"value","value":"no"}},{"kind":"not","condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"value","value":"blocked"}}}]}]},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000001","f3650000-0000-4000-8000-000000000003"],"fieldValues":{"f3650000-0000-4000-8000-000000000001":"open","f3650000-0000-4000-8000-000000000003":true},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"datetime_sub_millisecond_inequality",
      "condition":{"kind":"comparison","operator":"not_equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000005"},"right":{"source":"value","value":"1969-12-31T23:59:59.999998Z"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000005"],"fieldValues":{"f3650000-0000-4000-8000-000000000005":"1969-12-31T23:59:59.999999Z"},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"datetime_extreme_offset_equality",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000005"},"right":{"source":"value","value":"0000-01-01T00:00:00.000001+23:59"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000005"],"fieldValues":{"f3650000-0000-4000-8000-000000000005":"0000-01-01T00:00:00.000001+23:59"},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"record_reference_case_fold",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000008"},"right":{"source":"value","value":"A3650000-0000-4000-8000-000000000001"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000008"],"fieldValues":{"f3650000-0000-4000-8000-000000000008":"a3650000-0000-4000-8000-000000000001"},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"uuid_looking_text_stays_case_sensitive",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"value","value":"A3650000-0000-4000-8000-000000000001"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000001"],"fieldValues":{"f3650000-0000-4000-8000-000000000001":"a3650000-0000-4000-8000-000000000001"},"parameters":[],"bindings":[],"expected":"false"
    },
    {
      "name":"structural_json_object_equality",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000007"},"right":{"source":"value","value":{"nested":{"a":1,"b":2}}}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000007"],"fieldValues":{"f3650000-0000-4000-8000-000000000007":{"nested":{"b":2,"a":1}}},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"json_array_order_matters",
      "condition":{"kind":"comparison","operator":"not_equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000007"},"right":{"source":"value","value":[2,1]}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000007"],"fieldValues":{"f3650000-0000-4000-8000-000000000007":[1,2]},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"verified_current_account_binding",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"parameter","key":"actor"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000001"],"fieldValues":{"f3650000-0000-4000-8000-000000000001":"53650000-0000-4000-8000-000000000001"},"parameters":[{"key":"actor","type":"text"}],"bindings":[{"key":"actor","source":"current_organization_account_id"}],"actorId":"53650000-0000-4000-8000-000000000001","expected":"true"
    },
    {
      "name":"current_account_text_does_not_coerce_reference",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000009"},"right":{"source":"parameter","key":"actor"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000009"],"fieldValues":{"f3650000-0000-4000-8000-000000000009":"53650000-0000-4000-8000-000000000001"},"parameters":[{"key":"actor","type":"text"}],"bindings":[{"key":"actor","source":"current_organization_account_id"}],"actorId":"53650000-0000-4000-8000-000000000001","expected":"error:22023"
    },
    {
      "name":"current_account_reference_matches_person",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000009"},"right":{"source":"parameter","key":"actor"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000009"],"fieldValues":{"f3650000-0000-4000-8000-000000000009":"53650000-0000-4000-8000-000000000001"},"parameters":[{"key":"actor","type":"organization_account_reference"}],"bindings":[{"key":"actor","source":"current_organization_account_id"}],"actorId":"53650000-0000-4000-8000-000000000001","expected":"true"
    },
    {
      "name":"invalid_account_reference_literal_refuses",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000009"},"right":{"source":"parameter","key":"actor"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000009"],"fieldValues":{"f3650000-0000-4000-8000-000000000009":"53650000-0000-4000-8000-000000000001"},"parameters":[{"key":"actor","type":"organization_account_reference"}],"bindings":[{"key":"actor","source":"literal","value":"not-an-account-id"}],"expected":"error:22023"
    },
    {
      "name":"nil_current_account_reference_refuses",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000009"},"right":{"source":"parameter","key":"actor"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000009"],"fieldValues":{"f3650000-0000-4000-8000-000000000009":"53650000-0000-4000-8000-000000000001"},"parameters":[{"key":"actor","type":"organization_account_reference"}],"bindings":[{"key":"actor","source":"current_organization_account_id"}],"actorId":"00000000-0000-0000-0000-000000000000","expected":"error:22023"
    },
    {
      "name":"hidden_invalid_any_branch_refuses",
      "condition":{"kind":"any","conditions":[{"kind":"comparison","operator":"equals","left":{"source":"value","value":1},"right":{"source":"value","value":1}},{"kind":"comparison","operator":"greater_than","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000003"},"right":{"source":"value","value":false}}]},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000003"],"fieldValues":{"f3650000-0000-4000-8000-000000000003":true},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"missing_node_kind_refuses",
      "condition":{"operator":"equals","left":{"source":"value","value":1},"right":{"source":"value","value":1}},
      "declaredFieldIds":[],"fieldValues":{},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"missing_comparison_operator_refuses",
      "condition":{"kind":"comparison","left":{"source":"value","value":1},"right":{"source":"value","value":1}},
      "declaredFieldIds":[],"fieldValues":{},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"missing_compound_children_refuses",
      "condition":{"kind":"all"},
      "declaredFieldIds":[],"fieldValues":{},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"missing_negated_child_refuses",
      "condition":{"kind":"not"},
      "declaredFieldIds":[],"fieldValues":{},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"hidden_invalid_all_branch_refuses",
      "condition":{"kind":"all","conditions":[{"kind":"comparison","operator":"equals","left":{"source":"value","value":1},"right":{"source":"value","value":2}},{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000099"},"right":{"source":"value","value":1}}]},
      "declaredFieldIds":[],"fieldValues":{},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"invalid_under_not_refuses",
      "condition":{"kind":"not","condition":{"kind":"comparison","operator":"mystery","left":{"source":"value","value":1},"right":{"source":"value","value":1}}},
      "declaredFieldIds":[],"fieldValues":{},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"incompatible_not_contains_refuses",
      "condition":{"kind":"comparison","operator":"not_contains","left":{"source":"value","value":1},"right":{"source":"value","value":false}},
      "declaredFieldIds":[],"fieldValues":{},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"missing_parameter_binding_refuses",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"parameter","key":"threshold"},"right":{"source":"value","value":2}},
      "declaredFieldIds":[],"fieldValues":{},"parameters":[{"key":"threshold","type":"number"}],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"duplicate_parameter_declaration_refuses",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"parameter","key":"threshold"},"right":{"source":"value","value":2}},
      "declaredFieldIds":[],"fieldValues":{},"parameters":[{"key":"threshold","type":"number"},{"key":"threshold","type":"number"}],"bindings":[{"key":"threshold","source":"literal","value":2}],"expected":"error:22023"
    },
    {
      "name":"extra_parameter_binding_refuses",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"value","value":1},"right":{"source":"value","value":1}},
      "declaredFieldIds":[],"fieldValues":{},"parameters":[],"bindings":[{"key":"extra","source":"literal","value":1}],"expected":"error:22023"
    },
    {
      "name":"missing_field_value_refuses",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"value","value":"alpha"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000001"],"fieldValues":{},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"extra_field_value_refuses",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"value","value":"alpha"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000001"],"fieldValues":{"f3650000-0000-4000-8000-000000000001":"alpha","f3650000-0000-4000-8000-000000000002":1},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"non_finite_double_refuses",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000002"},"right":{"source":"value","value":1}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000002"],"fieldValues":{"f3650000-0000-4000-8000-000000000002":1e400},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"invalid_fractional_precision_refuses",
      "condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000005"},"right":{"source":"value","value":"2026-09-07T00:00:00Z"}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000005"],"fieldValues":{"f3650000-0000-4000-8000-000000000005":"2026-09-07T00:00:00.1234567Z"},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"negative_membership_inverts_null",
      "condition":{"kind":"comparison","operator":"not_in","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"value","value":["alpha"]}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000001"],"fieldValues":{"f3650000-0000-4000-8000-000000000001":null},"parameters":[],"bindings":[],"expected":"true"
    },
    {
      "name":"context_free_empty_collection_refuses",
      "condition":{"kind":"comparison","operator":"in","left":{"source":"value","value":"alpha"},"right":{"source":"value","value":[]}},
      "declaredFieldIds":[],"fieldValues":{},"parameters":[],"bindings":[],"expected":"error:22023"
    },
    {
      "name":"opaque_collection_membership_refuses",
      "condition":{"kind":"comparison","operator":"in","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000007"},"right":{"source":"value","value":[]}},
      "declaredFieldIds":["f3650000-0000-4000-8000-000000000007"],"fieldValues":{"f3650000-0000-4000-8000-000000000007":[]},"parameters":[],"bindings":[],"expected":"error:22023"
    }
  ]
}
$typed_condition_vectors$::jsonb as payload;

select is(
  (select pg_catalog.jsonb_array_length(payload -> 'vectors') from typed_condition_corpus),
  43,
  'the shared parity corpus contains the intended bounded vector set'
);

create function pg_temp.evaluate_typed_condition_vector(p_vector jsonb)
returns text
language plpgsql
volatile
set search_path = ''
as $function$
declare
  corpus jsonb;
  result boolean;
begin
  select payload into strict corpus from pg_temp.typed_condition_corpus;
  result := vortex_access.evaluate_permission_saved_condition(
    pg_catalog.jsonb_build_object(
      'routes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind', 'all_records')),
      'savedCondition', pg_catalog.jsonb_build_object(
        'conditionId', 'c3650000-0000-4000-8000-000000000001',
        'publishedRevision', 1,
        'contractFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
        'parameterBindings', p_vector -> 'bindings'
      )
    ),
    pg_catalog.jsonb_build_object(
      'conditionId', 'c3650000-0000-4000-8000-000000000001',
      'sourceRecordTypeId', 'd3650000-0000-4000-8000-000000000001',
      'publishedRevision', 1,
      'contractFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
      'parameters', p_vector -> 'parameters',
      'condition', p_vector -> 'condition',
      'declaredFieldIds', p_vector -> 'declaredFieldIds'
    ),
    pg_catalog.jsonb_build_object(
      'recordTypeId', 'd3650000-0000-4000-8000-000000000001',
      'fields', corpus -> 'fields'
    ),
    p_vector -> 'fieldValues',
    coalesce((p_vector ->> 'actorId')::uuid, '53650000-0000-4000-8000-000000000001'::uuid)
  );
  return result::text;
exception when others then
  return 'error:' || sqlstate;
end
$function$;

select is(
  pg_temp.evaluate_typed_condition_vector(vector.value),
  vector.value ->> 'expected',
  'PostgreSQL matches shared Rule vector ' || (vector.value ->> 'name')
)
from typed_condition_corpus as corpus
cross join lateral pg_catalog.jsonb_array_elements(corpus.payload -> 'vectors') as vector(value)
order by vector.value ->> 'name' collate "C";

create function pg_temp.saved_condition_binding_outcome(p_mismatch text)
returns text
language plpgsql
volatile
set search_path = ''
as $function$
declare
  corpus jsonb;
  scope_condition_id text := 'c3650000-0000-4000-8000-000000000001';
  scope_revision integer := 1;
  scope_fingerprint text := 'sha256:' || pg_catalog.repeat('a', 64);
  source_record_type_id text := 'd3650000-0000-4000-8000-000000000001';
begin
  select payload into strict corpus from pg_temp.typed_condition_corpus;
  case p_mismatch
    when 'condition_id' then
      scope_condition_id := 'c3650000-0000-4000-8000-000000000002';
    when 'revision' then
      scope_revision := 2;
    when 'fingerprint' then
      scope_fingerprint := 'sha256:' || pg_catalog.repeat('b', 64);
    when 'source_record_type' then
      source_record_type_id := 'd3650000-0000-4000-8000-000000000002';
    else
      raise exception using errcode = '22023', message = 'Unknown test mismatch';
  end case;

  perform vortex_access.evaluate_permission_saved_condition(
    pg_catalog.jsonb_build_object(
      'routes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind', 'all_records')),
      'savedCondition', pg_catalog.jsonb_build_object(
        'conditionId', scope_condition_id,
        'publishedRevision', scope_revision,
        'contractFingerprint', scope_fingerprint,
        'parameterBindings', '[]'::jsonb
      )
    ),
    pg_catalog.jsonb_build_object(
      'conditionId', 'c3650000-0000-4000-8000-000000000001',
      'sourceRecordTypeId', 'd3650000-0000-4000-8000-000000000001',
      'publishedRevision', 1,
      'contractFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
      'parameters', '[]'::jsonb,
      'condition', '{"kind":"comparison","operator":"equals","left":{"source":"value","value":1},"right":{"source":"value","value":1}}'::jsonb,
      'declaredFieldIds', '[]'::jsonb
    ),
    pg_catalog.jsonb_build_object(
      'recordTypeId', source_record_type_id,
      'fields', corpus -> 'fields'
    ),
    '{}'::jsonb,
    '53650000-0000-4000-8000-000000000001'
  );
  return 'unexpected-success';
exception when others then
  return 'error:' || sqlstate;
end
$function$;

select is(
  pg_temp.saved_condition_binding_outcome(candidate.mismatch),
  'error:22023',
  'sealed saved-condition ' || candidate.mismatch || ' mismatch refuses'
)
from (values
  ('condition_id'), ('revision'), ('fingerprint'), ('source_record_type')
) as candidate(mismatch)
order by candidate.mismatch collate "C";

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13650000-0000-4000-8000-000000000001', 'condition_parity',
  'Condition parity', 'active', pg_catalog.clock_timestamp(),
  '93650000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values (
  '23650000-0000-4000-8000-000000000001',
  '13650000-0000-4000-8000-000000000001', 'condition_parity',
  'Condition parity', 'active', pg_catalog.clock_timestamp(),
  '93650000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '43650000-0000-4000-8000-000000000001', 'active',
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  '93650000-0000-4000-8000-000000000001',
  'a3650000-0000-4000-8000-000000000001', 1
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '53650000-0000-4000-8000-000000000001',
  '23650000-0000-4000-8000-000000000001',
  '43650000-0000-4000-8000-000000000001', 'Condition reader', 'active',
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(), '93650000-0000-4000-8000-000000000001',
  'a3650000-0000-4000-8000-000000000002', 1
);

select * from vortex_access.initialize_organization_access_version(
  '23650000-0000-4000-8000-000000000001',
  '93650000-0000-4000-8000-000000000001',
  'a3650000-0000-4000-8000-000000000003'
);

create table vortex_access.test_typed_condition_rows (
  record_id uuid primary key,
  field_values jsonb not null
);
revoke all on table vortex_access.test_typed_condition_rows
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

insert into vortex_access.test_typed_condition_rows (record_id, field_values) values
  (
    'e3650000-0000-4000-8000-000000000001',
    '{"f3650000-0000-4000-8000-000000000001":"53650000-0000-4000-8000-000000000001"}'::jsonb
  ),
  (
    'e3650000-0000-4000-8000-000000000002',
    '{"f3650000-0000-4000-8000-000000000001":"53650000-0000-4000-8000-000000000002"}'::jsonb
  );

create function vortex_access.test_visible_typed_condition_rows()
returns table (record_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  checked := vortex_access.validated_human_request_context();
  return query
  select candidate.record_id
  from vortex_access.test_typed_condition_rows as candidate
  where vortex_access.evaluate_permission_saved_condition(
    '{"routes":[{"kind":"all_records"}],"savedCondition":{"conditionId":"c3650000-0000-4000-8000-000000000001","publishedRevision":1,"contractFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parameterBindings":[{"key":"actor","source":"current_organization_account_id"}]}}'::jsonb,
    '{"conditionId":"c3650000-0000-4000-8000-000000000001","sourceRecordTypeId":"d3650000-0000-4000-8000-000000000001","publishedRevision":1,"contractFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parameters":[{"key":"actor","type":"text"}],"condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3650000-0000-4000-8000-000000000001"},"right":{"source":"parameter","key":"actor"}},"declaredFieldIds":["f3650000-0000-4000-8000-000000000001"]}'::jsonb,
    '{"recordTypeId":"d3650000-0000-4000-8000-000000000001","fields":[{"fieldId":"f3650000-0000-4000-8000-000000000001","type":"text"}]}'::jsonb,
    candidate.field_values,
    (checked ->> 'organizationAccountId')::uuid
  )
  order by candidate.record_id;
end
$function$;

revoke execute on function vortex_access.test_visible_typed_condition_rows()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_visible_typed_condition_rows()
  to vortex_request;

select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '83650000-0000-4000-8000-000000000001',
  'tenantId', '13650000-0000-4000-8000-000000000001',
  'organizationId', '23650000-0000-4000-8000-000000000001',
  'organizationAccountId', '53650000-0000-4000-8000-000000000001',
  'identityId', '43650000-0000-4000-8000-000000000001',
  'sessionId', '63650000-0000-4000-8000-000000000001',
  'authenticationStrength', 'multi_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '1 hour',
  'accessVersion', (
    select current_version from vortex_access.organization_access_versions
    where organization_id = '23650000-0000-4000-8000-000000000001'
  ),
  'correlationId', 'a3650000-0000-4000-8000-000000000004'
));

grant usage on schema extensions to vortex_request;
set local role vortex_request;
select results_eq(
  $$select record_id from vortex_access.test_visible_typed_condition_rows()$$,
  $$values ('e3650000-0000-4000-8000-000000000001'::uuid)$$,
  'a protected request-role query injects the verified current account and filters rows in PostgreSQL'
);
select is(
  (select pg_catalog.count(*) from vortex_access.test_visible_typed_condition_rows()),
  1::bigint,
  'the protected request-role count is narrowed before results leave PostgreSQL'
);
reset role;

set constraints all immediate;

select * from finish();

rollback;
