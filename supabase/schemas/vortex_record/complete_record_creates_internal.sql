create or replace function vortex_record.complete_record_creates_internal(p_prepared jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  prepared_value jsonb;
  prepared_position integer;
  type_id uuid;
  record_id_value uuid;
  metas jsonb := '{}'::jsonb;
  meta jsonb;
  context_value jsonb;
  targets jsonb;
  loaded_set jsonb;
  decision_set jsonb;
  decision jsonb;
  facts jsonb;
  bounds jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  changeable text[];
  submitted_id uuid;
  refusal_reason text;
  notice_sequence bigint;
  results jsonb := '[]'::jsonb;
begin
  preview_installation := vortex_record.read_current_preview_installation_internal();
  -- One context per record type, one facts load and one decision for every created record.
  for type_id in
    select distinct (item.value ->> 'recordTypeId')::uuid
    from pg_catalog.jsonb_array_elements(p_prepared) as item(value)
  loop
    metas := metas || pg_catalog.jsonb_build_object(
      type_id::text, vortex_record.resolve_record_action_context_internal(type_id, 'create')
    );
  end loop;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'recordTypeId', item.value -> 'recordTypeId', 'recordId', item.value -> 'recordId'
  ) order by item.ordinality)
  into targets
  from pg_catalog.jsonb_array_elements(p_prepared) with ordinality as item(value, ordinality);
  if targets is null then return results; end if;
  loaded_set := vortex_record.load_record_access_facts_internal('create', targets);
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(loaded_set) as item(value)
    where item.value ->> 'outcome' <> 'loaded'
  ) then
    refusal_reason := 'record_unavailable';
    raise exception using errcode = 'P4020', message = refusal_reason;
  end if;
  if preview_installation is null then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'declaration', metas -> (targets -> (loaded.ordinality - 1)::integer ->> 'recordTypeId') -> 'declaration',
      'recordId', targets -> (loaded.ordinality - 1)::integer -> 'recordId',
      'facts', (loaded.value -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', metas -> (targets -> (loaded.ordinality - 1)::integer ->> 'recordTypeId') -> 'declaration' -> 'recordBinding'
      )
    ) order by loaded.ordinality)
    into decision_set
    from pg_catalog.jsonb_array_elements(loaded_set) with ordinality as loaded(value, ordinality);
    decision_set := vortex_access.evaluate_organization_record_access_internal(decision_set);
  end if;
  prepared_position := 0;
  for prepared_value in select item.value from pg_catalog.jsonb_array_elements(p_prepared) as item(value)
  loop
    type_id := (prepared_value ->> 'recordTypeId')::uuid;
    record_id_value := (prepared_value ->> 'recordId')::uuid;
    meta := metas -> type_id::text;
    context_value := meta -> 'context';
    if preview_installation is null then
      decision := decision_set -> prepared_position;
      if decision ->> 'outcome' <> 'allowed' then
        refusal_reason := 'access_refused';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        type_id, (meta ->> 'storageContractId')::uuid, meta -> 'recordType'
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
    for submitted_id in
      select item.value::uuid from pg_catalog.jsonb_array_elements_text(prepared_value -> 'submittedFieldIds') as item(value)
    loop
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
          (context_value ->> 'applicationRootId')::uuid, type_id,
          record_id_value, 1, 'created', notice_sequence, notice_sequence,
          (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        raise warning 'Record create notice failed: [%] %', sqlstate, sqlerrm;
      end;
    end if;
    results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', record_id_value,
      'concurrencyNumber', 1, 'values', prepared_value -> 'values'
    ));
    prepared_position := prepared_position + 1;
  end loop;
  return results;
end
$function$;
alter function vortex_record.complete_record_creates_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_record_creates_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.complete_record_creates_internal(jsonb) is
  'Private create finalisation for every created record of one command: evaluates create authority with one facts load and one decision for the set, checks submitted field bounds over the persisted proposed graph, raises a refusal to roll back the set, and publishes each advisory invalidation.';
