create or replace function vortex_access.derived_backfill_context_internal()
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  scope record;
begin
  context_value := vortex_platform.current_context();
  if context_value ->> 'callerKind' is distinct from 'system'
    or not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Derived backfill requires a system Application context';
  end if;
  select resolved.* into strict scope
  from vortex_access.resolve_event_consumer_scope(
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid
  ) as resolved;
  if scope.system_actor_id is distinct from (context_value ->> 'systemActorId')::uuid
    or scope.tenant_id is distinct from (context_value ->> 'tenantId')::uuid
    or scope.access_version is distinct from (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '42501', message = 'Derived backfill system authority is stale or unavailable';
  end if;
  return context_value;
end
$function$;
alter function vortex_access.derived_backfill_context_internal() owner to vortex_owner;
revoke all on function vortex_access.derived_backfill_context_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.derived_backfill_context_internal()
  to vortex_record_adapter, vortex_owner, postgres;
