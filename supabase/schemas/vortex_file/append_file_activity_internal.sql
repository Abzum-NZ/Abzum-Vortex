create or replace function vortex_file.append_file_activity_internal(
  p_action text,
  p_subject_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_context.current_context();
  request_actor jsonb;
  organization_id_value uuid;
  correlation_id_value uuid;
  outcome_value text;
  actor_kind text;
  actor_identifier uuid;
  source_value text;
  activity_id_value uuid;
begin
  outcome_value := case p_action
    when 'file_upload_admitted' then 'completed'
    when 'file_upload_refused' then 'refused'
    when 'file_activated' then 'completed'
    when 'file_activation_refused' then 'refused'
    when 'file_download_granted' then 'completed'
  end;
  if outcome_value is null
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'File Activity input is invalid';
  end if;

  request_actor := vortex_file.upload_request_actor(established);
  if request_actor is null then
    return;
  end if;

  if request_actor ->> 'kind' = 'human' then
    actor_kind := 'organization_account';
    actor_identifier := (request_actor ->> 'organizationAccountId')::uuid;
    source_value := 'web';
  else
    actor_kind := 'system';
    actor_identifier := (request_actor ->> 'systemActorId')::uuid;
    source_value := 'system';
  end if;

  organization_id_value := (established ->> 'organizationId')::uuid;
  correlation_id_value := (established ->> 'correlationId')::uuid;
  activity_id_value := vortex_file.file_activity_id(
    p_action, organization_id_value, correlation_id_value, p_subject_id
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f',
      'vortex_file.activity', organization_id_value::text, activity_id_value::text), 744)
  );

  if exists (
    select 1
    from vortex_activity.organization_activity_entries as existing
    where existing.organization_id = organization_id_value
      and existing.activity_id = activity_id_value
  ) then
    return;
  end if;

  perform vortex_activity.append_organization_activity_entry(
    organization_id_value,
    activity_id_value,
    pg_catalog.statement_timestamp(),
    actor_kind,
    actor_identifier,
    p_action,
    array[p_subject_id]::uuid[],
    array[]::uuid[],
    source_value,
    correlation_id_value,
    outcome_value
  );
end
$function$;

revoke execute on function vortex_file.append_file_activity_internal(text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.append_file_activity_internal(text, uuid)
  to vortex_file_owner;

comment on function vortex_file.append_file_activity_internal(text, uuid) is
  'Appends one content-free File Activity entry for the verified request actor; used by the admission, activation and download-grant owners.';

alter function vortex_file.append_file_activity_internal(text, uuid) owner to postgres;
