create or replace function vortex_access.platform_permission_owner_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  owner_ids uuid[];
begin
  select pg_catalog.array_agg(distinct declaration.owner_id) into owner_ids
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform';
  if owner_ids is null or pg_catalog.cardinality(owner_ids) <> 1 then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue has no single owner';
  end if;
  return owner_ids[1];
end
$function$;

alter function vortex_access.platform_permission_owner_id() owner to vortex_owner;
revoke all on function vortex_access.platform_permission_owner_id()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.platform_permission_owner_id() to vortex_owner;
comment on function vortex_access.platform_permission_owner_id() is
  'The owner identity of the platform permission catalogue, read from its declarations.';
