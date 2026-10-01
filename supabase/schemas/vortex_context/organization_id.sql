create or replace function vortex_context.organization_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select (vortex_context.current_context() ->> 'organizationId')::uuid
$function$;
revoke execute on function vortex_context.organization_id()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_context.organization_id()
  to vortex_request, vortex_record_adapter, vortex_search_owner,
    vortex_record_inventory_owner, vortex_connection_owner;

comment on function vortex_context.organization_id() is
  'Returns the organisation identifier from the validated request context.';

alter function vortex_context.organization_id() owner to postgres;
