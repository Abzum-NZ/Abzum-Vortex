create or replace function vortex_record.discover_relationship_total_closure_internal(
  p_catalogue jsonb,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_submitted_values jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  root_type jsonb;
  root_snapshot jsonb;
  records jsonb := '[]'::jsonb;
  signatures jsonb := '[]'::jsonb;
  queued_keys text[] := array[]::text[];
  queue_index integer := 0;
  current_record jsonb;
  current_key text;
  relationship jsonb;
  field_id text;
  old_target jsonb;
  proposed_target jsonb;
  target jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_type jsonb;
  target_key text;
  target_snapshot jsonb;
begin
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then return null; end if;
  if p_operation = 'update' then
    root_snapshot := vortex_record.relationship_total_record_snapshot_internal(
      p_catalogue, p_record_type_id, p_record_id, false
    );
    if root_snapshot is null then return null; end if;
  else
    root_snapshot := pg_catalog.jsonb_build_object(
      'recordType', root_type - 'moduleReleaseRevision',
      'recordTypeId', p_record_type_id,
      'storageContractId', (root_type ->> 'storageContractId')::uuid,
      'existingValues', '{}'::jsonb
    );
  end if;
  root_snapshot := root_snapshot || pg_catalog.jsonb_build_object('recordKey', 'root');
  records := pg_catalog.jsonb_build_array(root_snapshot);
  queued_keys := array['root'];

  while queue_index < pg_catalog.cardinality(queued_keys) loop
    if queue_index >= 256 then
      raise exception using errcode = '54001', message = 'Relationship total dependency closure is too large';
    end if;
    current_key := queued_keys[queue_index + 1];
    queue_index := queue_index + 1;
    select item.value into strict current_record
    from pg_catalog.jsonb_array_elements(records) item(value)
    where item.value ->> 'recordKey' = current_key;

    for relationship in
      select item.value
      from pg_catalog.jsonb_array_elements(current_record -> 'recordType' -> 'relationships') item(value)
      where item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
      order by item.value ->> 'relationshipId'
    loop
      field_id := pg_catalog.lower(relationship ->> 'fromFieldId');
      old_target := current_record -> 'existingValues' -> field_id;
      proposed_target := old_target;
      if current_key = 'root' and p_submitted_values ? field_id then
        proposed_target := p_submitted_values -> field_id;
      end if;
      for target in
        select distinct_candidate.value
        from (
          select distinct candidate.value
          from pg_catalog.jsonb_array_elements(
            pg_catalog.jsonb_build_array(old_target, proposed_target)
          ) candidate(value)
          where pg_catalog.jsonb_typeof(candidate.value) = 'object'
        ) distinct_candidate
        order by distinct_candidate.value::text collate "C"
      loop
        if not pg_catalog.pg_input_is_valid(target ->> 'recordTypeId', 'uuid')
          or not pg_catalog.pg_input_is_valid(target ->> 'recordId', 'uuid') then
          return null;
        end if;
        target_type_id := (target ->> 'recordTypeId')::uuid;
        target_record_id := (target ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(relationship, target_type_id) then
          return null;
        end if;
        select item.value into target_type
        from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
        where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(target_type_id::text);
        if target_type is null or not exists (
          select 1 from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
          where field.value ->> 'type' = 'total'
            and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
              pg_catalog.lower(relationship ->> 'relationshipId')
        ) then
          continue;
        end if;
        target_key := case
          when p_operation = 'update' and target_type_id = p_record_type_id
            and target_record_id = p_record_id then 'root'
          else pg_catalog.lower(target_type_id::text) || ':' || pg_catalog.lower(target_record_id::text)
        end;
        signatures := signatures || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'from', current_key,
          'relationshipId', relationship -> 'relationshipId',
          'to', target_key
        ));
        if not (target_key = any(queued_keys)) then
          target_snapshot := vortex_record.relationship_total_record_snapshot_internal(
            p_catalogue, target_type_id, target_record_id, false
          );
          if target_snapshot is null then return null; end if;
          records := records || pg_catalog.jsonb_build_array(
            target_snapshot || pg_catalog.jsonb_build_object('recordKey', target_key)
          );
          queued_keys := pg_catalog.array_append(queued_keys, target_key);
        end if;
      end loop;
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'records', records,
    'signatures', coalesce((
      select pg_catalog.jsonb_agg(distinct item.value order by item.value)
      from pg_catalog.jsonb_array_elements(signatures) item(value)
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.discover_relationship_total_closure_internal(jsonb,text,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.discover_relationship_total_closure_internal(jsonb,text,uuid,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.discover_relationship_total_closure_internal(jsonb,text,uuid,uuid,jsonb) to vortex_record_adapter;
comment on function vortex_record.discover_relationship_total_closure_internal(jsonb,text,uuid,uuid,jsonb) is null;
