CREATE FUNCTION vortex_identity.complete_identity_disablement(p_command_id uuid, p_correlation_id uuid, p_outcome text) RETURNS TABLE(outcome text, sessions_revoked integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  existing vortex_identity.identity_disablement_commands%rowtype;
  revoked integer;
begin
  if p_command_id is null
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text)
    or p_outcome is null
    or p_outcome not in ('disabled', 'subject_not_found', 'provider_unavailable')
  then
    raise exception 'invalid identity disablement outcome' using errcode = '22023';
  end if;

  select * into existing
  from vortex_identity.identity_disablement_commands as recorded
  where recorded.command_id = p_command_id
  for update;

  if not found then
    raise exception 'unknown identity disablement command' using errcode = 'P0002';
  end if;

  if existing.outcome = 'disabled' then
    -- A concurrent attempt of the same command already completed it.
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event,
      recorded_at
    ) values (
      p_command_id, existing.actor_identity_id, existing.subject_identity_id,
      p_correlation_id, 'replayed', operation_at
    );
    return query select existing.outcome, existing.sessions_revoked;
    return;
  end if;

  if p_outcome = 'disabled' then
    delete from auth.sessions as provider_session
    where provider_session.user_id = existing.subject_identity_id;
    get diagnostics revoked = row_count;

    update vortex_identity.identity_disablement_commands as recorded
    set outcome = 'disabled', sessions_revoked = revoked, completed_at = operation_at
    where recorded.command_id = p_command_id;

    -- Publish to the cluster-local projection in the same transaction.
    perform vortex_identity.publish_identity_disablement(
      existing.subject_identity_id, existing.actor_identity_id,
      p_correlation_id, operation_at
    );
  else
    revoked := null;
    update vortex_identity.identity_disablement_commands as recorded
    set outcome = p_outcome, sessions_revoked = null, completed_at = operation_at
    where recorded.command_id = p_command_id;
  end if;

  insert into vortex_identity.identity_disablement_events (
    command_id, actor_identity_id, subject_identity_id, correlation_id, event,
    sessions_revoked, recorded_at
  ) values (
    p_command_id, existing.actor_identity_id, existing.subject_identity_id,
    p_correlation_id, p_outcome, revoked, operation_at
  );
  return query select p_outcome, revoked;
end
$$;


ALTER FUNCTION vortex_identity.complete_identity_disablement(p_command_id uuid, p_correlation_id uuid, p_outcome text) OWNER TO postgres;

COMMENT ON FUNCTION vortex_identity.complete_identity_disablement(p_command_id uuid, p_correlation_id uuid, p_outcome text) IS 'Server-only Identity Authority adapter step: records the provider outcome and revokes the subject''s provider sessions with the record.';

REVOKE ALL ON FUNCTION vortex_identity.complete_identity_disablement(p_command_id uuid, p_correlation_id uuid, p_outcome text) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_identity.complete_identity_disablement(p_command_id uuid, p_correlation_id uuid, p_outcome text) TO vortex_runtime;
