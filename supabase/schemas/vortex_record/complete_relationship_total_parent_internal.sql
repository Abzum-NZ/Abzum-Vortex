create or replace function vortex_record.complete_relationship_total_parent_internal(p_prepared jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  snapshot jsonb := p_prepared -> 'snapshot';
  saved_record_id uuid := (p_prepared ->> 'recordId')::uuid;
  new_revision bigint := (p_prepared ->> 'concurrencyNumber')::bigint;
  changed_field_ids uuid[];
  preview_installation jsonb;
  pending_exact_notice boolean := false;
  notice_sequence bigint;
  event_result jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  select pg_catalog.array_agg(value::uuid) into changed_field_ids
  from pg_catalog.jsonb_array_elements_text(p_prepared -> 'changedFieldIds') as field(value);
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation is null
    and snapshot #>> '{recordType,storageScope}' = 'application_contained' then
    pending_exact_notice := true;
  else
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (snapshot ->> 'storageContractId')::uuid,
      case when snapshot #>> '{recordType,storageScope}' = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
  end if;
  perform vortex_record.append_record_activity_internal(pg_catalog.gen_random_uuid(), 'update_record', array[saved_record_id]::uuid[], changed_field_ids, 'completed');
  event_result := vortex_platform.append_record_occurrences(
    (snapshot ->> 'storageContractId')::uuid, saved_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', pg_catalog.gen_random_uuid(),
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', (p_prepared ->> 'recordTypeId')::uuid
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Relationship total parent Event append failed';
  end if;
  if pending_exact_notice then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid,
        (p_prepared ->> 'recordTypeId')::uuid, saved_record_id, new_revision, 'changed',
        notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
      );
    exception
      when others then
        -- Invalidation is advisory; a lost notice must not refuse the parent write.
        raise warning 'Generated record notice failed: [%] %', sqlstate, sqlerrm;
    end;
  end if;
end
$function$;

alter function vortex_record.complete_relationship_total_parent_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_relationship_total_parent_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.complete_relationship_total_parent_internal(jsonb) is
  'Appends the Activity, standard Event and invalidation for a protected generated-field update after the shared record storage writer has applied it.';
