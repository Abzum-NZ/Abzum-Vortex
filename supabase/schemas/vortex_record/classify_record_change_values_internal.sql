create or replace function vortex_record.classify_record_change_values_internal(
  p_record_type_id uuid,
  final_values jsonb,
  meta jsonb,
  p_submitted_values jsonb,
  organization_id_value uuid,
  application_root_id_value uuid,
  receipt_kind text,
  effective_command_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  field_value jsonb;
  relationship_value jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  entry_key text;
  entry_value jsonb;
  submitted_field_id uuid;
begin
  -- Classify every final value against the exact installed Record definition.
  -- Link values remain relationship changes; only ordinary value fields reach
  -- the fixed column writer on update. Each supported link has exactly one
  -- declared fixed to-one relationship owned by this source Record type.
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(final_values) as entry(key, value)
  loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where pg_catalog.lower(item.value ->> 'fieldId') = entry_key;
    if not found then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromRecordTypeId')::uuid = p_record_type_id
        and pg_catalog.lower(item.value ->> 'fromFieldId') = entry_key;
      if not found
        or not (relationship_value ? case field_value ->> 'type'
          when 'link' then 'toRecordType' else 'toRecordTypes' end)
        or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_shape_unsupported'
        );
      end if;
      relationship_changes := relationship_changes || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'fieldId', entry_key,
          'relationshipId', relationship_value -> 'relationshipId',
          'relationship', relationship_value,
          'value', entry_value
        )
      );
    else
      value_final_values := value_final_values
        || pg_catalog.jsonb_build_object(entry_key, entry_value);
    end if;
  end loop;

  foreach submitted_field_id in array array(
    select key::uuid
    from pg_catalog.jsonb_object_keys(p_submitted_values) as key
    order by key::uuid
  ) loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where (item.value ->> 'fieldId')::uuid = submitted_field_id;
    if not found then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
      value_submitted_field_ids := pg_catalog.array_append(
        value_submitted_field_ids, submitted_field_id
      );
    elsif not exists (
      select 1
      from pg_catalog.jsonb_array_elements(relationship_changes) as change(value)
      where (change.value ->> 'fieldId')::uuid = submitted_field_id
    ) then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_value_unavailable'
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'classified',
    'relationshipChanges', relationship_changes,
    'valueFinalValues', value_final_values,
    'valueSubmittedFieldIds', pg_catalog.to_jsonb(value_submitted_field_ids)
  );
end
$function$;

alter function vortex_record.classify_record_change_values_internal(uuid,jsonb,jsonb,jsonb,uuid,uuid,text,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.classify_record_change_values_internal(uuid,jsonb,jsonb,jsonb,uuid,uuid,text,uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.classify_record_change_values_internal(uuid,jsonb,jsonb,jsonb,uuid,uuid,text,uuid)
  to vortex_record_adapter;

comment on function vortex_record.classify_record_change_values_internal(uuid,jsonb,jsonb,jsonb,uuid,uuid,text,uuid) is
  'Private field classification step of apply_record_changes: validates installed fields, separates relationship mutations from fixed values, and preserves refusal receipt release before the subject write.';
