create or replace function vortex_record.record_type_permissions_internal(
  p_content jsonb,
  p_record_type_id uuid
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_agg(
      item.value
      order by item.value ->> 'permissionId', item.value ->> 'actionKind', item.value::text
    ),
    '[]'::jsonb
  )
  from pg_catalog.jsonb_array_elements(
    case when pg_catalog.jsonb_typeof(p_content -> 'permissions') = 'array'
      then p_content -> 'permissions' else '[]'::jsonb end
  ) as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = p_record_type_id::text
$function$;

alter function vortex_record.record_type_permissions_internal(jsonb, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.record_type_permissions_internal(jsonb, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.record_type_permissions_internal(jsonb, uuid)
  to vortex_record_adapter;

comment on function vortex_record.record_type_permissions_internal(jsonb, uuid) is
  'Private: the permissions a release content declares for one record type, in a canonical order, for comparing a preview with the installed release.';
