create or replace function vortex_record.prepare_record_changes(
  p_command_id uuid,
  p_subjects jsonb,
  p_named jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt jsonb;
  preparation jsonb;
  effective_command_id uuid;
  named_roles jsonb;
begin
  if p_command_id is null or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or not vortex_record.record_change_set_is_valid_internal(p_subjects)
    or (p_named is null and pg_catalog.jsonb_array_length(p_subjects) = 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_unavailable');
  end if;
  receipt := vortex_record.claim_command_receipt_internal('record_changes', effective_command_id, true);
  if receipt ->> 'status' = 'completed' then
    return vortex_record.replay_record_changes_internal(effective_command_id, receipt -> 'result');
  elsif receipt ->> 'status' <> 'none' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- With a named action, its authority replaces ordinary authority for the
  -- subject and its declared creates, and every intent must be one of its effects.
  if p_named is not null then
    named_roles := vortex_record.prepare_named_record_change_roles_internal(p_subjects, p_named);
    if named_roles ->> 'outcome' is distinct from 'prepared' then
      return named_roles || pg_catalog.jsonb_build_object('correlationId', context_value -> 'correlationId');
    end if;
  end if;
  -- An action that only announces writes no record and has nothing to calculate.
  if pg_catalog.jsonb_array_length(p_subjects) = 0 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared', 'records', '[]'::jsonb, 'subjects', '[]'::jsonb,
      'lifecycleChanges', '[]'::jsonb, 'lifecycleProposals', '[]'::jsonb, 'recordCount', 0,
      'preview', vortex_record.read_current_preview_installation_internal() is not null,
      'correlationId', context_value -> 'correlationId', 'namedRoles', named_roles
    );
  end if;
  preparation := vortex_record.prepare_record_calculation_set_internal(p_subjects, named_roles);
  return preparation || pg_catalog.jsonb_build_object(
    'correlationId', context_value -> 'correlationId', 'namedRoles', named_roles
  );
end
$function$;
alter function vortex_record.prepare_record_changes(uuid,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_changes(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_record_changes(uuid,jsonb,jsonb) to vortex_request;
comment on function vortex_record.prepare_record_changes(uuid,jsonb,jsonb) is
  'Protected record-set calculation preflight and current-authority replay projection; one command identity, optionally one named action over its subjects, one locked dependency graph, no record writes.';
