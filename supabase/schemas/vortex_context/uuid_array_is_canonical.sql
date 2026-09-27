create or replace function vortex_context.uuid_array_is_canonical(p_values uuid[])
returns boolean
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $function$
declare
  current_value uuid;
  previous_value uuid;
begin
  if coalesce(pg_catalog.array_ndims(p_values), 1) <> 1
    or coalesce(pg_catalog.array_lower(p_values, 1), 1) <> 1 then
    return false;
  end if;

  foreach current_value in array p_values loop
    if current_value is null
      or not vortex_context.is_non_nil_uuid(current_value::text)
      or (previous_value is not null and previous_value >= current_value) then
      return false;
    end if;
    previous_value := current_value;
  end loop;

  return true;
end
$function$;

revoke execute on function vortex_context.uuid_array_is_canonical(uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_context.uuid_array_is_canonical(uuid[])
  to vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_context.uuid_array_is_canonical(uuid[]) is
  'Accepts only a one-dimensional array of strict non-nil UUIDs in ascending unique order.';
