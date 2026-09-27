create or replace function vortex_access.direct_share_field_ids_are_canonical(
  p_field_ids uuid[]
)
returns boolean
language sql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $function$
  select vortex_context.uuid_array_is_canonical(p_field_ids)
$function$;

revoke execute on function vortex_access.direct_share_field_ids_are_canonical(uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.direct_share_field_ids_are_canonical(uuid[]) is
  'Private adapter to the shared canonical UUID-array validator.';
