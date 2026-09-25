-- #692: request-callable entry points for connection administration.
--
-- A human administration request runs as `vortex_request`, but the six
-- `vortex_connection.*_internal` writers are executable only by
-- `vortex_runtime`, so no human request could configure, check, disable,
-- grant or reauthorise a connection. Each writer gets one
-- `*_for_administration` entry point executable only by `vortex_request`. An
-- entry point accepts only a human request context and delegates to its
-- writer, which re-checks the organisation, the
-- `platform.organization.connections.manage` authority, the expected revision
-- and application ownership from that context and appends the Activity entry.
-- Registration takes its organisation from the request context rather than
-- from an argument, and returns the new revision.
--
-- These are new functions with complete bodies. The `*_internal` writers,
-- their grants and every existing function are unchanged.

begin;

set local role postgres;

create or replace function vortex_connection.assert_human_administration_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if pg_catalog.coalesce(vortex_context.current_context() ->> 'callerKind', '') <> 'human' then
    raise exception using
      errcode = '42501',
      message = 'Connection administration requires a human request context';
  end if;
end
$function$;

revoke all on function vortex_connection.assert_human_administration_request()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_connection.assert_human_administration_request() is
  'Refuses any caller whose request context is not a human request; used by the connection administration entry points.';

create or replace function vortex_connection.register_connection_instance_for_administration(
  p_connection_instance_id uuid,
  p_connection_type_id uuid,
  p_connection_type_version text,
  p_destination_key text,
  p_destination_fingerprint text,
  p_administrator_activity_id uuid,
  p_token_expires_at timestamptz
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  perform vortex_connection.register_connection_instance_internal(
    p_connection_instance_id,
    vortex_context.organization_id(),
    p_connection_type_id,
    p_connection_type_version,
    p_destination_key,
    p_destination_fingerprint,
    p_administrator_activity_id,
    p_token_expires_at
  );

  return 1;
end
$function$;

revoke all on function vortex_connection.register_connection_instance_for_administration(uuid, uuid, text, text, text, uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_connection.register_connection_instance_for_administration(uuid, uuid, text, text, text, uuid, timestamptz)
  to vortex_request;
comment on function vortex_connection.register_connection_instance_for_administration(uuid, uuid, text, text, text, uuid, timestamptz) is
  'Human request entry point for registering a connection instance in the request context organisation; delegates to register_connection_instance_internal and returns the new revision.';

create or replace function vortex_connection.grant_connection_application_for_administration(
  p_connection_instance_id uuid,
  p_application_root_id uuid,
  p_administrator_activity_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  perform vortex_connection.grant_connection_application_internal(
    p_connection_instance_id,
    p_application_root_id,
    p_administrator_activity_id
  );
end
$function$;

revoke all on function vortex_connection.grant_connection_application_for_administration(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_connection.grant_connection_application_for_administration(uuid, uuid, uuid)
  to vortex_request;
comment on function vortex_connection.grant_connection_application_for_administration(uuid, uuid, uuid) is
  'Human request entry point for granting an application use of a connection instance; delegates to grant_connection_application_internal.';

create or replace function vortex_connection.revoke_connection_application_for_administration(
  p_connection_instance_id uuid,
  p_application_root_id uuid,
  p_administrator_activity_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  perform vortex_connection.revoke_connection_application_internal(
    p_connection_instance_id,
    p_application_root_id,
    p_administrator_activity_id
  );
end
$function$;

revoke all on function vortex_connection.revoke_connection_application_for_administration(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_connection.revoke_connection_application_for_administration(uuid, uuid, uuid)
  to vortex_request;
comment on function vortex_connection.revoke_connection_application_for_administration(uuid, uuid, uuid) is
  'Human request entry point for revoking an application grant on a connection instance; delegates to revoke_connection_application_internal.';

create or replace function vortex_connection.record_connection_health_check_for_administration(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_new_health_outcome text,
  p_administrator_activity_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  return vortex_connection.record_connection_health_check_internal(
    p_connection_instance_id,
    p_expected_revision,
    p_new_health_outcome,
    p_administrator_activity_id
  );
end
$function$;

revoke all on function vortex_connection.record_connection_health_check_for_administration(uuid, bigint, text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_connection.record_connection_health_check_for_administration(uuid, bigint, text, uuid)
  to vortex_request;
comment on function vortex_connection.record_connection_health_check_for_administration(uuid, bigint, text, uuid) is
  'Human request entry point for recording a revision-checked connection health outcome; delegates to record_connection_health_check_internal.';

create or replace function vortex_connection.revoke_connection_instance_for_administration(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_administrator_activity_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  return vortex_connection.revoke_connection_instance_internal(
    p_connection_instance_id,
    p_expected_revision,
    p_administrator_activity_id
  );
end
$function$;

revoke all on function vortex_connection.revoke_connection_instance_for_administration(uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_connection.revoke_connection_instance_for_administration(uuid, bigint, uuid)
  to vortex_request;
comment on function vortex_connection.revoke_connection_instance_for_administration(uuid, bigint, uuid) is
  'Human request entry point for disabling a connection instance at an expected revision; delegates to revoke_connection_instance_internal.';

create or replace function vortex_connection.reauthorize_connection_instance_for_administration(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_administrator_activity_id uuid,
  p_destination_fingerprint text,
  p_token_expires_at timestamptz
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  return vortex_connection.reauthorize_connection_instance_internal(
    p_connection_instance_id,
    p_expected_revision,
    p_administrator_activity_id,
    p_destination_fingerprint,
    p_token_expires_at
  );
end
$function$;

revoke all on function vortex_connection.reauthorize_connection_instance_for_administration(uuid, bigint, uuid, text, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_connection.reauthorize_connection_instance_for_administration(uuid, bigint, uuid, text, timestamptz)
  to vortex_request;
comment on function vortex_connection.reauthorize_connection_instance_for_administration(uuid, bigint, uuid, text, timestamptz) is
  'Human request entry point for a revision-checked credential rotation or reauthorisation; delegates to reauthorize_connection_instance_internal.';

reset role;

commit;
