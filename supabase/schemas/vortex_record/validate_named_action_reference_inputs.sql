CREATE OR REPLACE FUNCTION vortex_record.validate_named_action_reference_inputs(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_inputs jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  action_context jsonb;
  input_definition jsonb;
  input_candidate jsonb;
  catalogue jsonb;
  reference_record_type_id uuid;
  reference_record_id uuid;
  resolved_target_count integer;
begin
  if pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object' then
    return false;
  end if;
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  for input_definition in
    select item.value
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'inputs') item(value)
    where item.value ->> 'type' = 'record_reference'
  loop
    if not p_inputs ? (input_definition ->> 'key') then
      continue;
    end if;
    input_candidate := p_inputs -> (input_definition ->> 'key');
    reference_record_type_id := null;
    reference_record_id := null;
    if pg_catalog.jsonb_typeof(input_candidate) = 'object'
      and input_candidate ?& array['recordTypeId', 'recordId']
      and input_candidate - array['recordTypeId', 'recordId'] = '{}'::jsonb
      and pg_catalog.pg_input_is_valid(input_candidate ->> 'recordTypeId', 'uuid')
      and pg_catalog.pg_input_is_valid(input_candidate ->> 'recordId', 'uuid') then
      reference_record_type_id := (input_candidate ->> 'recordTypeId')::uuid;
      reference_record_id := (input_candidate ->> 'recordId')::uuid;
    elsif pg_catalog.jsonb_typeof(input_candidate) = 'string'
      and pg_catalog.pg_input_is_valid(input_candidate #>> '{}', 'uuid') then
      select pg_catalog.count(*),
        (pg_catalog.array_agg(
          (target.value ->> 'recordTypeId')::uuid
          order by (target.value ->> 'recordTypeId')::uuid
        ))[1]
      into resolved_target_count, reference_record_type_id
      from pg_catalog.jsonb_array_elements(input_definition -> 'recordTypes') target(value)
      where target.value ->> 'state' = 'resolved';
      if resolved_target_count = 1 then
        reference_record_id := (input_candidate #>> '{}')::uuid;
      end if;
    end if;
    if reference_record_type_id is null or reference_record_id is null
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(input_definition -> 'recordTypes') target(value)
        where target.value ->> 'state' = 'resolved'
          and (target.value ->> 'recordTypeId')::uuid = reference_record_type_id
      ) then
      return false;
    end if;
    catalogue := coalesce(catalogue,
      vortex_record.relationship_total_catalogue_internal());
    if vortex_record.relationship_total_record_snapshot_internal(
      catalogue, reference_record_type_id, reference_record_id, false
    ) is null then
      return false;
    end if;
  end loop;
  return true;
exception
  when no_data_found or too_many_rows or invalid_text_representation
    or insufficient_privilege or object_not_in_prerequisite_state
    or check_violation then
    return false;
end
$$;
alter function vortex_record.validate_named_action_reference_inputs(text,uuid,bigint,uuid,uuid,jsonb) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.validate_named_action_reference_inputs(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_inputs jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION vortex_record.validate_named_action_reference_inputs(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_inputs jsonb) FROM vortex_record_adapter;
GRANT ALL ON FUNCTION vortex_record.validate_named_action_reference_inputs(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_inputs jsonb) TO vortex_runtime;
