CREATE OR REPLACE FUNCTION vortex_identity.begin_identity_disablement(p_actor_identity_id uuid, p_subject_identity_id uuid, p_command_id uuid, p_command_fingerprint text, p_correlation_id uuid) RETURNS TABLE(outcome text, sessions_revoked integer, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  existing vortex_identity.identity_disablement_commands%rowtype;
begin
  if p_actor_identity_id is null
    or p_subject_identity_id is null
    or p_command_id is null
    or p_correlation_id is null
    or p_command_fingerprint is null
    or p_actor_identity_id = p_subject_identity_id
    or not vortex_platform.is_non_nil_uuid(p_actor_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_subject_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or not vortex_platform.is_non_nil_uuid(p_correlation_id::text)
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
  then
    raise exception 'invalid identity disablement command' using errcode = '22023';
  end if;

  insert into vortex_identity.identity_disablement_commands (
    command_id, actor_identity_id, subject_identity_id, command_fingerprint,
    correlation_id, outcome, requested_at
  ) values (
    p_command_id, p_actor_identity_id, p_subject_identity_id, p_command_fingerprint,
    p_correlation_id, 'started', operation_at
  )
  on conflict (command_id) do nothing;

  if found then
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event,
      recorded_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id, p_correlation_id,
      'started', operation_at
    );
    return query select 'started'::text, null::integer, p_correlation_id;
    return;
  end if;

  select * into strict existing
  from vortex_identity.identity_disablement_commands as recorded
  where recorded.command_id = p_command_id
  for update;

  if existing.command_fingerprint is distinct from p_command_fingerprint
    or existing.actor_identity_id is distinct from p_actor_identity_id
    or existing.subject_identity_id is distinct from p_subject_identity_id
  then
    -- The attempted (not the recorded) actor and subject are attributed.
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event,
      recorded_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id, p_correlation_id,
      'conflict', operation_at
    );
    return query select 'conflict'::text, null::integer, existing.correlation_id;
    return;
  end if;

  if existing.outcome = 'disabled' then
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event,
      recorded_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id, p_correlation_id,
      'replayed', operation_at
    );
    return query select 'replayed'::text, existing.sessions_revoked, existing.correlation_id;
    return;
  end if;

  update vortex_identity.identity_disablement_commands as recorded
  set outcome = 'started',
      completed_at = null,
      sessions_revoked = null,
      attempt_count = recorded.attempt_count + 1
  where recorded.command_id = p_command_id;

  insert into vortex_identity.identity_disablement_events (
    command_id, actor_identity_id, subject_identity_id, correlation_id, event,
    recorded_at
  ) values (
    p_command_id, p_actor_identity_id, p_subject_identity_id, p_correlation_id,
    'started', operation_at
  );
  return query select 'started'::text, null::integer, existing.correlation_id;
end
$_$;

ALTER FUNCTION vortex_identity.begin_identity_disablement(p_actor_identity_id uuid, p_subject_identity_id uuid, p_command_id uuid, p_command_fingerprint text, p_correlation_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_identity.begin_identity_disablement(p_actor_identity_id uuid, p_subject_identity_id uuid, p_command_id uuid, p_command_fingerprint text, p_correlation_id uuid) IS 'Server-only Identity Authority adapter step: records or re-opens one identity disablement command and replays a completed exact retry.';

REVOKE ALL ON FUNCTION vortex_identity.begin_identity_disablement(p_actor_identity_id uuid, p_subject_identity_id uuid, p_command_id uuid, p_command_fingerprint text, p_correlation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_identity.begin_identity_disablement(p_actor_identity_id uuid, p_subject_identity_id uuid, p_command_id uuid, p_command_fingerprint text, p_correlation_id uuid) TO vortex_runtime;
