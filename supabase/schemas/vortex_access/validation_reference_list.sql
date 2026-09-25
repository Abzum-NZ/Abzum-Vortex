create or replace function vortex_access.validation_reference_list(p_list text)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  selected_values text[];
begin
  select pg_catalog.array_agg(
    reference.reference_value order by reference.reference_ordinal
  )
  into selected_values
  from vortex_access.validation_reference_values as reference
  where reference.reference_list = p_list;

  -- An unknown or empty list is an internal inconsistency. Refusing it keeps
  -- every check that reads a list closed instead of silently admitting values
  -- because the list it compares against came back empty.
  if selected_values is null then
    raise exception using errcode = '55000',
      message = 'Validation reference list is unavailable';
  end if;

  return selected_values;
end
$function$;

revoke all on function vortex_access.validation_reference_list(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.validation_reference_list(text)
  to vortex_request, vortex_runtime;

comment on function vortex_access.validation_reference_list(text) is
  'Returns the ordered values of one seeded validation reference list; refuses an unknown or empty list so no check can pass against a missing list.';
