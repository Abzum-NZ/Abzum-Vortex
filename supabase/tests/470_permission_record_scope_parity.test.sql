\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select has_function(
  'vortex_access', 'permission_record_scope_is_valid', array['jsonb'],
  'Access has one private record-scope shape validator'
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
      'vortex_access.permission_record_scope_is_valid(jsonb)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres',
    'securityDefiner', false,
    'volatility', 'i',
    'configuration', array['search_path=""'],
    'result', 'boolean'
  ),
  'the record-scope validator is owner-held, immutable, invoker-rights and empty-search-path'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.permission_record_scope_is_valid(jsonb)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot call the private record-scope validator'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

create temporary table record_scope_corpus on commit drop as
select $record_scope_vectors$
{
  "vectors": [
    {
      "name": "all_records_route_alone",
      "scope": {"routes": [{"kind": "all_records"}]},
      "valid": true
    },
    {
      "name": "ownership_route_alone",
      "scope": {"routes": [{"kind": "ownership"}]},
      "valid": true
    },
    {
      "name": "direct_share_route_alone",
      "scope": {"routes": [{"kind": "direct_share"}]},
      "valid": true
    },
    {
      "name": "relationship_route_alone",
      "scope": {"routes": [{"kind": "relationship", "relationshipId": "14700000-0000-4000-8000-000000000001", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}]},
      "valid": true
    },
    {
      "name": "ownership_direct_share_relationship_canonical",
      "scope": {"routes": [{"kind": "ownership"}, {"kind": "direct_share"}, {"kind": "relationship", "relationshipId": "14700000-0000-4000-8000-000000000001", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}]},
      "valid": true
    },
    {
      "name": "two_relationship_routes_canonical_order",
      "scope": {"routes": [{"kind": "relationship", "relationshipId": "14700000-0000-4000-8000-000000000001", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}, {"kind": "relationship", "relationshipId": "14700000-0000-4000-8000-000000000002", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}]},
      "valid": true
    },
    {
      "name": "all_records_with_another_route_refuses",
      "scope": {"routes": [{"kind": "all_records"}, {"kind": "ownership"}]},
      "valid": false
    },
    {
      "name": "duplicate_ownership_routes_refuse",
      "scope": {"routes": [{"kind": "ownership"}, {"kind": "ownership"}]},
      "valid": false
    },
    {
      "name": "duplicate_relationship_routes_refuse",
      "scope": {"routes": [{"kind": "relationship", "relationshipId": "14700000-0000-4000-8000-000000000001", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}, {"kind": "relationship", "relationshipId": "14700000-0000-4000-8000-000000000001", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}]},
      "valid": false
    },
    {
      "name": "noncanonical_route_order_refuses",
      "scope": {"routes": [{"kind": "direct_share"}, {"kind": "ownership"}]},
      "valid": false
    },
    {
      "name": "noncanonical_relationship_order_refuses",
      "scope": {"routes": [{"kind": "relationship", "relationshipId": "14700000-0000-4000-8000-000000000002", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}, {"kind": "relationship", "relationshipId": "14700000-0000-4000-8000-000000000001", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}]},
      "valid": false
    },
    {
      "name": "empty_routes_array_refuses",
      "scope": {"routes": []},
      "valid": false
    },
    {
      "name": "unknown_top_level_key_refuses",
      "scope": {"routes": [{"kind": "ownership"}], "unexpected": true},
      "valid": false
    },
    {
      "name": "unknown_route_kind_refuses",
      "scope": {"routes": [{"kind": "group_ownership"}]},
      "valid": false
    },
    {
      "name": "relationship_missing_relationship_id_refuses",
      "scope": {"routes": [{"kind": "relationship", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}]},
      "valid": false
    },
    {
      "name": "relationship_missing_source_permission_id_refuses",
      "scope": {"routes": [{"kind": "relationship", "relationshipId": "14700000-0000-4000-8000-000000000001"}]},
      "valid": false
    },
    {
      "name": "relationship_extra_key_refuses",
      "scope": {"routes": [{"kind": "relationship", "relationshipId": "14700000-0000-4000-8000-000000000001", "sourcePermissionId": "24700000-0000-4000-8000-000000000001", "extra": 1}]},
      "valid": false
    },
    {
      "name": "all_records_extra_key_refuses",
      "scope": {"routes": [{"kind": "all_records", "extra": 1}]},
      "valid": false
    },
    {
      "name": "relationship_non_uuid_identity_refuses",
      "scope": {"routes": [{"kind": "relationship", "relationshipId": "not-a-uuid", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}]},
      "valid": false
    },
    {
      "name": "relationship_case_insensitive_duplicate_refuses",
      "scope": {"routes": [{"kind": "relationship", "relationshipId": "1470000a-0000-4000-8000-00000000000b", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}, {"kind": "relationship", "relationshipId": "1470000A-0000-4000-8000-00000000000B", "sourcePermissionId": "24700000-0000-4000-8000-000000000001"}]},
      "valid": false
    },
    {
      "name": "saved_condition_valid",
      "scope": {"routes": [{"kind": "all_records"}], "savedCondition": {"conditionId": "34700000-0000-4000-8000-000000000001", "publishedRevision": 1, "contractFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "parameterBindings": [{"key": "actor", "source": "current_organization_account_id"}]}},
      "valid": true
    },
    {
      "name": "saved_condition_missing_key_refuses",
      "scope": {"routes": [{"kind": "all_records"}], "savedCondition": {"conditionId": "34700000-0000-4000-8000-000000000001", "publishedRevision": 1, "parameterBindings": []}},
      "valid": false
    },
    {
      "name": "saved_condition_bad_fingerprint_refuses",
      "scope": {"routes": [{"kind": "all_records"}], "savedCondition": {"conditionId": "34700000-0000-4000-8000-000000000001", "publishedRevision": 1, "contractFingerprint": "sha256:xyz", "parameterBindings": []}},
      "valid": false
    },
    {
      "name": "saved_condition_zero_revision_refuses",
      "scope": {"routes": [{"kind": "all_records"}], "savedCondition": {"conditionId": "34700000-0000-4000-8000-000000000001", "publishedRevision": 0, "contractFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "parameterBindings": []}},
      "valid": false
    },
    {
      "name": "saved_condition_duplicate_binding_key_refuses",
      "scope": {"routes": [{"kind": "all_records"}], "savedCondition": {"conditionId": "34700000-0000-4000-8000-000000000001", "publishedRevision": 1, "contractFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "parameterBindings": [{"key": "actor", "source": "current_organization_account_id"}, {"key": "actor", "source": "literal", "value": 1}]}},
      "valid": false
    },
    {
      "name": "saved_condition_noncanonical_binding_order_refuses",
      "scope": {"routes": [{"kind": "all_records"}], "savedCondition": {"conditionId": "34700000-0000-4000-8000-000000000001", "publishedRevision": 1, "contractFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "parameterBindings": [{"key": "region", "source": "literal", "value": "north"}, {"key": "actor", "source": "current_organization_account_id"}]}},
      "valid": false
    },
    {
      "name": "saved_condition_literal_binding_valid",
      "scope": {"routes": [{"kind": "all_records"}], "savedCondition": {"conditionId": "34700000-0000-4000-8000-000000000001", "publishedRevision": 1, "contractFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "parameterBindings": [{"key": "actor", "source": "current_organization_account_id"}, {"key": "region", "source": "literal", "value": "north"}]}},
      "valid": true
    },
    {
      "name": "saved_condition_unknown_source_refuses",
      "scope": {"routes": [{"kind": "all_records"}], "savedCondition": {"conditionId": "34700000-0000-4000-8000-000000000001", "publishedRevision": 1, "contractFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "parameterBindings": [{"key": "actor", "source": "mystery"}]}},
      "valid": false
    },
    {
      "name": "non_object_array_refuses",
      "scope": [],
      "valid": false
    },
    {
      "name": "non_object_string_refuses",
      "scope": "ownership",
      "valid": false
    },
    {
      "name": "non_object_null_refuses",
      "scope": null,
      "valid": false
    },
    {
      "name": "missing_routes_key_refuses",
      "scope": {"savedCondition": {"conditionId": "34700000-0000-4000-8000-000000000001", "publishedRevision": 1, "contractFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "parameterBindings": []}},
      "valid": false
    },
    {
      "name": "routes_not_array_refuses",
      "scope": {"routes": {}},
      "valid": false
    },
    {
      "name": "saved_condition_not_object_refuses",
      "scope": {"routes": [{"kind": "all_records"}], "savedCondition": []},
      "valid": false
    },
    {
      "name": "saved_condition_binding_extra_key_for_current_account_refuses",
      "scope": {"routes": [{"kind": "all_records"}], "savedCondition": {"conditionId": "34700000-0000-4000-8000-000000000001", "publishedRevision": 1, "contractFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "parameterBindings": [{"key": "actor", "source": "current_organization_account_id", "value": 1}]}},
      "valid": false
    },
    {
      "name": "saved_condition_binding_missing_value_for_literal_refuses",
      "scope": {"routes": [{"kind": "all_records"}], "savedCondition": {"conditionId": "34700000-0000-4000-8000-000000000001", "publishedRevision": 1, "contractFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "parameterBindings": [{"key": "actor", "source": "literal"}]}},
      "valid": false
    }
  ]
}
$record_scope_vectors$::jsonb as payload;

select is(
  (select pg_catalog.jsonb_array_length(payload -> 'vectors') from record_scope_corpus),
  36,
  'the shared record-scope parity corpus contains the intended bounded vector set'
);

select is(
  vortex_access.permission_record_scope_is_valid(vector.value -> 'scope'),
  (vector.value ->> 'valid')::boolean,
  'PostgreSQL matches shared Zod vector ' || (vector.value ->> 'name')
)
from record_scope_corpus as corpus
cross join lateral pg_catalog.jsonb_array_elements(corpus.payload -> 'vectors') as vector(value)
order by vector.value ->> 'name' collate "C";

select * from finish();

rollback;
