create or replace function vortex_record.lock_record_change_targets_internal(
  p_record_type_id uuid,
  p_operation text,
  p_final_values jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  record_type_value jsonb;
  relationship_value jsonb;
  field_id_value uuid;
  input_value jsonb;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object' then
    raise exception using errcode = '22023',
      message = 'Record change target lock input is invalid';
  end if;
  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object' then
    raise exception using errcode = '55000',
      message = 'Record change target lock context is unavailable';
  end if;
  record_type_value := meta -> 'recordType';

  -- The one canonical link-target share-lock prelude. Every declared to-one link
  -- whose submitted value names a valid declared target takes that target's row
  -- share lock here, in relationship identity order, before the caller writes a
  -- source data version or takes any relationship edge identity (L5 before L6).
  -- A malformed or undeclared link is left to the caller's own validation.
  for relationship_value in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
    order by (item.value ->> 'relationshipId')::uuid
  loop
    field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
    if p_final_values ? pg_catalog.lower(field_id_value::text) then
      input_value := p_final_values -> pg_catalog.lower(field_id_value::text);
      if pg_catalog.jsonb_typeof(input_value) = 'object'
        and input_value - array['recordTypeId', 'recordId']::text[] = '{}'::jsonb
        and pg_catalog.jsonb_typeof(input_value -> 'recordTypeId') = 'string'
        and pg_catalog.jsonb_typeof(input_value -> 'recordId') = 'string'
        and pg_catalog.pg_input_is_valid(input_value ->> 'recordTypeId', 'uuid')
        and pg_catalog.pg_input_is_valid(input_value ->> 'recordId', 'uuid')
        and pg_catalog.lower(input_value ->> 'recordTypeId') <>
          '00000000-0000-0000-0000-000000000000'
        and pg_catalog.lower(input_value ->> 'recordId') <>
          '00000000-0000-0000-0000-000000000000'
        and vortex_record.relationship_declares_target_internal(
          relationship_value, (input_value ->> 'recordTypeId')::uuid
        ) then
        perform vortex_record.lock_relationship_target_row_internal(
          (input_value ->> 'recordTypeId')::uuid,
          (input_value ->> 'recordId')::uuid,
          (meta -> 'context' ->> 'organizationId')::uuid
        );
      end if;
    end if;
  end loop;
end
$function$;

revoke all on function vortex_record.lock_record_change_targets_internal(uuid, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.lock_record_change_targets_internal(uuid, text, jsonb)
  to vortex_record_adapter;

comment on function vortex_record.lock_record_change_targets_internal(uuid, text, jsonb) is
  'The one canonical link-target share-lock prelude for a record change: share-locks every declared to-one target named by the submitted final values, in relationship identity order, before any source data version or relationship edge identity.';
