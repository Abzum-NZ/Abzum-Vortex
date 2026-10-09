create or replace function vortex_context.request_context_is_established_internal()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return exists (
    select 1
    from vortex_context.request_contexts as established
    where established.backend_pid = pg_catalog.pg_backend_pid()
      and established.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
  );
end
$function$;

revoke all on function vortex_context.request_context_is_established_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner,
    vortex_context_owner, vortex_access_owner;
grant execute on function vortex_context.request_context_is_established_internal()
  to vortex_access_owner;
comment on function vortex_context.request_context_is_established_internal() is
  'Private: reports only whether this backend has an established row for the current transaction; reads no Context payload and grants no request authority.';
alter function vortex_context.request_context_is_established_internal() owner to postgres;
