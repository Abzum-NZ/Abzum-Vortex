create or replace function vortex_record.complete_record_create_internal(p_prepared jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  p_record_type_id uuid := (p_prepared ->> 'recordTypeId')::uuid;
  record_id_value uuid := (p_prepared ->> 'recordId')::uuid;
  p_submitted_field_ids uuid[];
  meta jsonb;
  context_value jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  bounds jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  changeable text[];
  submitted_id uuid;
  refusal_reason text;
  notice_sequence bigint;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
  context_value := meta -> 'context';
  preview_installation := vortex_record.read_current_preview_installation_internal();
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into p_submitted_field_ids
  from pg_catalog.jsonb_array_elements_text(p_prepared -> 'submittedFieldIds') item(value);
  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'create', record_id_value, null, null::jsonb
  );
  if loaded ->> 'outcome' <> 'loaded' then
    refusal_reason := 'record_unavailable';
    raise exception using errcode = 'P4020', message = refusal_reason;
  end if;
  facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'binding', meta -> 'declaration' -> 'recordBinding'
  );
  if preview_installation is null then
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', record_id_value, facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      refusal_reason := 'access_refused';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  else
    preview_bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if preview_bounds is null then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    bounds := preview_bounds;
  end if;
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);
  foreach submitted_id in array p_submitted_field_ids loop
    if not (meta -> 'columns' ? pg_catalog.lower(submitted_id::text)) then
      refusal_reason := 'unknown_field';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      refusal_reason := 'field_not_changeable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
  end loop;

  if preview_installation is null and meta ->> 'storageScope' = 'application_contained' then
    begin
      notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::pg_catalog.regclass);
      perform vortex_platform.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid, p_record_type_id,
        record_id_value, 1, 'created', notice_sequence, notice_sequence,
        (context_value ->> 'correlationId')::uuid
      );
    exception when others then
      raise warning 'Record create notice failed: [%] %', sqlstate, sqlerrm;
    end;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed', 'recordId', record_id_value,
    'concurrencyNumber', 1, 'values', p_prepared -> 'values'
  );
end
$function$;
alter function vortex_record.complete_record_create_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_record_create_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.complete_record_create_internal(jsonb) is
  'Private create finalisation: evaluates create authority and submitted field bounds over the persisted proposed graph, raises a refusal to roll back the set, and publishes its advisory invalidation.';
