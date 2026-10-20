create or replace function vortex_record.query_tree_selector_internal(
  p_tree jsonb, p_record_type jsonb, p_readable_fields text[]
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  field_id text;
  relationship_id uuid;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if pg_catalog.jsonb_typeof(p_tree) is distinct from 'object'
    or p_tree - array['fieldId', 'parentRecordId']::text[] <> '{}'::jsonb
    or not (p_tree ? 'fieldId') or not (p_tree ? 'parentRecordId')
    or pg_catalog.jsonb_typeof(p_tree -> 'fieldId') is distinct from 'string'
    or pg_catalog.lower(p_tree ->> 'fieldId') !~ uuid_pattern
    or pg_catalog.jsonb_typeof(p_tree -> 'parentRecordId') not in ('string', 'null')
    or (pg_catalog.jsonb_typeof(p_tree -> 'parentRecordId') = 'string'
      and (pg_catalog.lower(p_tree ->> 'parentRecordId') !~ uuid_pattern
        or p_tree ->> 'parentRecordId' = '00000000-0000-0000-0000-000000000000')) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  field_id := pg_catalog.lower(p_tree ->> 'fieldId');
  if not (field_id = any (p_readable_fields)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  select (relationship.value ->> 'relationshipId')::uuid into relationship_id
  from pg_catalog.jsonb_array_elements(coalesce(p_record_type -> 'relationships', '[]'::jsonb))
    as relationship(value)
  where pg_catalog.lower(relationship.value ->> 'fromFieldId') = field_id
    and relationship.value ->> 'cardinality' = 'many_to_one'
    and pg_catalog.lower(relationship.value #>> '{toRecordType,recordTypeId}')
      = pg_catalog.lower(p_record_type ->> 'recordTypeId');
  if relationship_id is null or not exists (
    select 1 from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as field(value)
    where pg_catalog.lower(field.value ->> 'fieldId') = field_id and field.value ->> 'type' = 'link'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'fieldId', field_id,
    'parentRecordId', p_tree -> 'parentRecordId', 'relationshipId', relationship_id);
end
$function$;

alter function vortex_record.query_tree_selector_internal(jsonb,jsonb,text[]) owner to vortex_record_adapter;
revoke all on function vortex_record.query_tree_selector_internal(jsonb,jsonb,text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
