-- #1090: the event dispatcher's system actor comes from an active system actor grant.
--
-- The dispatcher previously took its actor and its authority from environment
-- configuration alone. It now carries only the credential digest in server
-- configuration: the actor is read from the one Access-owned registry of system
-- actor grants (#1089) for the fixed dispatch_event_occurrences operation, and
-- dispatch refuses closed when no active grant exists, when more than one
-- active grant exists, or when the grant names an organisation that is not
-- active. The identity is never taken from the request.
--
-- The function below is its complete body, identical to its canonical file
-- supabase/schemas/vortex_event/resolve_event_dispatcher_actor.sql.

begin;

create or replace function vortex_event.resolve_event_dispatcher_actor()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  active_grant_count bigint;
  dispatcher_actor_id uuid;
  dispatcher_organization_id uuid;
  organization_state text;
begin
  select pg_catalog.count(*)
    into active_grant_count
  from vortex_access.system_actor_grants as actor_grant
  where actor_grant.operation_key = 'dispatch_event_occurrences'
    and actor_grant.state = 'active'
    and actor_grant.flow_id is null
    and actor_grant.scope_key is null;

  if active_grant_count = 0 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reason', 'dispatcher_grant_missing'
    );
  end if;
  if active_grant_count > 1 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reason', 'dispatcher_grant_ambiguous'
    );
  end if;

  select actor_grant.system_actor_id, actor_grant.organization_id
    into dispatcher_actor_id, dispatcher_organization_id
  from vortex_access.system_actor_grants as actor_grant
  where actor_grant.operation_key = 'dispatch_event_occurrences'
    and actor_grant.state = 'active'
    and actor_grant.flow_id is null
    and actor_grant.scope_key is null
  for share;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reason', 'dispatcher_grant_missing'
    );
  end if;

  if dispatcher_organization_id is not null then
    select organization.state
      into organization_state
    from vortex_identity.organizations as organization
    where organization.organization_id = dispatcher_organization_id
    for share;

    if organization_state is distinct from 'active' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reason', 'dispatcher_grant_organisation_inactive'
      );
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'authorised', 'systemActorId', dispatcher_actor_id
  );
end
$function$;

revoke all on function vortex_event.resolve_event_dispatcher_actor()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_event.resolve_event_dispatcher_actor()
  to vortex_runtime;

comment on function vortex_event.resolve_event_dispatcher_actor() is
  'Resolves the event dispatcher''s system actor from the single active system actor grant for the dispatch_event_occurrences operation; refuses when no active grant exists, more than one active grant exists, or the grant names an organisation that is not active. Runtime-only; the actor is never taken from the caller.';

commit;
