-- #1090: the event dispatcher's system actor comes from an active system actor grant.
--
-- The dispatcher previously took its actor from environment configuration. It
-- now carries only the credential digest in server configuration: the actor is
-- read by Access from the one registry of system actor grants (#1089) for the
-- fixed dispatch_event_occurrences operation. The dispatcher claims occurrences
-- of every organisation, so only a platform-wide grant (no organisation, flow or
-- scope subject) authorises it, and dispatch refuses closed when no such active
-- grant exists or more than one does. The identity is never taken from the
-- request.
--
-- The function below is its complete body, identical to its canonical file
-- supabase/schemas/vortex_access/resolve_event_dispatcher_actor.sql.

begin;

create or replace function vortex_access.resolve_event_dispatcher_actor()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  active_grant_count bigint;
  dispatcher_actor_id uuid;
begin
  -- The dispatcher claims occurrences of every organisation, so only a
  -- platform-wide grant (no organisation, flow or scope subject) authorises it.
  -- A grant confined to an organisation, flow or scope never does. One
  -- statement counts and reads under a single snapshot, so the actor returned
  -- is the only active grant that statement saw.
  select pg_catalog.count(*), (pg_catalog.array_agg(actor_grant.system_actor_id))[1]
    into active_grant_count, dispatcher_actor_id
  from vortex_access.system_actor_grants as actor_grant
  where actor_grant.operation_key = 'dispatch_event_occurrences'
    and actor_grant.state = 'active'
    and actor_grant.organization_id is null
    and actor_grant.flow_id is null
    and actor_grant.scope_key is null;

  if active_grant_count = 0 or dispatcher_actor_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reason', 'dispatcher_grant_missing'
    );
  end if;
  if active_grant_count > 1 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reason', 'dispatcher_grant_ambiguous'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'authorised', 'systemActorId', dispatcher_actor_id
  );
end
$function$;

revoke all on function vortex_access.resolve_event_dispatcher_actor()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.resolve_event_dispatcher_actor()
  to vortex_runtime;

comment on function vortex_access.resolve_event_dispatcher_actor() is
  'Resolves the event dispatcher''s system actor from the single active platform-wide system actor grant for the dispatch_event_occurrences operation; refuses when none or more than one exists. A grant confined to an organisation, flow or scope never authorises dispatch. Runtime-only; the actor is never taken from the caller.';

commit;
