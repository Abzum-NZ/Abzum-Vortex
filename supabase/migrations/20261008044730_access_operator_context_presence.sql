begin;

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

alter function vortex_access.require_platform_operator_internal(uuid) owner to vortex_access_owner;
set local role vortex_access_owner;

create or replace function vortex_access.require_platform_operator_internal(
  p_operator_actor_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_operator_actor_id is null
    or not vortex_context.is_non_nil_uuid(p_operator_actor_id::text) then
    raise exception using errcode = '22023', message = 'Platform operator is invalid';
  end if;
  -- The platform operator is the configured system operator: trusted server
  -- configuration reached only through the runtime role, never a person's
  -- request. A transaction that carries a request context is a customer path,
  -- so no tenant or organisation role, delegation or session can reach here.
  if vortex_context.request_context_is_established_internal() then
    raise exception using errcode = '42501', message = 'Platform operator authority is unavailable';
  end if;
end
$function$;

revoke all on function vortex_access.require_platform_operator_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.require_platform_operator_internal(uuid) is
  'Private: refuses unless the caller is the configured platform operator in a transaction that carries no request context, so no customer role or request can act as the operator.';

alter function vortex_access.require_platform_operator_internal(uuid) owner to vortex_access_owner;
grant execute on function vortex_access.require_platform_operator_internal(uuid) to postgres;

reset role;
commit;
