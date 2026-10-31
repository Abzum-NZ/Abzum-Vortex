-- DT-7: two dormant subsystems leave. Record sharing across organisations and identity
-- disablement have no entry point in the application: their writers went in
-- 20261101010100 and every one of their tables is empty. What remains is the tables, their
-- protection triggers and the identity read path that could only ever answer "not disabled":
-- the request checks, the insert trigger that started a disabled identity suspended, and the
-- reactivation check in the identity projection guard.

set role vortex_owner;

drop table
  vortex_access.record_share_grant_consent_decisions,
  vortex_access.record_share_grant_consent_requests,
  vortex_access.record_share_grants;

drop trigger identity_projections_start_disabled_suspended on vortex_identity.identity_projections;
drop function vortex_identity.start_disabled_identity_projection_suspended();

create or replace function vortex_identity.protect_identity_projection()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.identity_id is distinct from old.identity_id
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514', message = 'Identity projection identity is permanent';
  end if;

  if old.state = 'closed' and new.state <> 'closed' then
    raise exception using errcode = '23514', message = 'A closed identity projection cannot be reactivated';
  end if;

  if new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.state_changed_at < old.state_changed_at then
    raise exception using errcode = '40001', message = 'Identity projection revision is stale or invalid';
  end if;

  return new;
end
$function$;

alter function vortex_identity.protect_identity_projection() owner to vortex_owner;

revoke all on function vortex_identity.protect_identity_projection() from public;

grant execute on function vortex_identity.protect_identity_projection() to postgres;

create or replace function vortex_identity.tenant_request_actor_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  checked := vortex_platform.current_context();
  if checked ->> 'callerKind' is null
    or checked ->> 'callerKind' not in ('human', 'federated')
    or not vortex_platform.is_non_nil_uuid(checked ->> 'identityId') then
    raise exception using errcode = '42501', message = 'Tenant request actor is unavailable';
  end if;
  return (checked ->> 'identityId')::uuid;
end
$function$;

revoke execute on function vortex_identity.tenant_request_actor_id()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_identity.tenant_request_actor_id() is
  'Returns the acting person from the verified request context for tenant governance, or refuses when the bound context names no human or federated person.';

alter function vortex_identity.tenant_request_actor_id() owner to vortex_owner;

grant execute on function vortex_identity.tenant_request_actor_id() to postgres;

drop function vortex_identity.require_request_identity_not_disabled();
drop function vortex_identity.require_identity_not_disabled(uuid);
drop function vortex_identity.identity_is_disabled(uuid);

drop table
  vortex_identity.identity_disablement_events,
  vortex_identity.identity_disablement_commands;
drop function vortex_identity.protect_identity_disablement_command();
drop function vortex_identity.refuse_identity_disablement_record_change();

reset role;
