create or replace function vortex_identity.begin_identity_disablement(
  p_actor_identity_id uuid,
  p_subject_identity_id uuid,
  p_command_id uuid,
  p_correlation_id uuid
)
returns table(outcome text, sessions_revoked integer, correlation_id uuid, subject_identity_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  existing vortex_identity.identity_disablement_commands%rowtype;
  claimed jsonb;
  original_subject_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_actor_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_subject_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or not vortex_platform.is_non_nil_uuid(p_correlation_id::text)
    or p_actor_identity_id is null or p_subject_identity_id is null
    or p_command_id is null or p_correlation_id is null then
    raise exception 'invalid identity disablement command' using errcode = '22023';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'identity_disablement', p_command_id, null, null, p_actor_identity_id,
    'Identity disablement command conflicts'
  );
  if claimed is null then
    if p_actor_identity_id = p_subject_identity_id then
      raise exception 'identity cannot disable itself' using errcode = 'V3191';
    end if;
    perform vortex_record.complete_scoped_command_receipt_internal(
      p_command_id, pg_catalog.jsonb_build_object('subjectIdentityId', p_subject_identity_id)
    );
    insert into vortex_identity.identity_disablement_commands (
      command_id, actor_identity_id, subject_identity_id,
      correlation_id, outcome, requested_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id,
      p_correlation_id, 'started', operation_at
    );
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event, recorded_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id, p_correlation_id,
      'started', operation_at
    );
    return query select 'started'::text, null::integer, p_correlation_id, p_subject_identity_id;
    return;
  end if;

  original_subject_id := (claimed ->> 'subjectIdentityId')::uuid;
  select recorded.* into strict existing
  from vortex_identity.identity_disablement_commands as recorded
  where recorded.command_id = p_command_id
  for update;
  if original_subject_id is distinct from existing.subject_identity_id
    or existing.actor_identity_id is distinct from p_actor_identity_id then
    raise exception 'identity disablement workflow state is inconsistent' using errcode = '55000';
  end if;
  if existing.outcome = 'disabled' then
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event, recorded_at
    ) values (
      p_command_id, existing.actor_identity_id, original_subject_id, p_correlation_id,
      'replayed', operation_at
    );
    return query select 'replayed'::text, existing.sessions_revoked,
      existing.correlation_id, original_subject_id;
    return;
  end if;

  update vortex_identity.identity_disablement_commands as recorded
  set outcome = 'started', completed_at = null, sessions_revoked = null,
      attempt_count = recorded.attempt_count + 1
  where recorded.command_id = p_command_id;
  insert into vortex_identity.identity_disablement_events (
    command_id, actor_identity_id, subject_identity_id, correlation_id, event, recorded_at
  ) values (
    p_command_id, existing.actor_identity_id, original_subject_id, p_correlation_id,
    'started', operation_at
  );
  return query select 'started'::text, null::integer, existing.correlation_id, original_subject_id;
end
$function$;

alter function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) owner to vortex_owner;
comment on function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) is
  'Starts or resumes the stored Identity Authority disablement subject, or replays its completed outcome.';
revoke all on function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) from public;
grant execute on function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) to vortex_runtime, postgres;
