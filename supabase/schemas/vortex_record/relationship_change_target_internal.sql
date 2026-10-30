create or replace function vortex_record.relationship_change_target_internal(
  p_change jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  -- The exact target a submitted link names, or null when the value is not a well-formed target
  -- the relationship declares. A link cleared to null names no target and is not asked here.
  if pg_catalog.jsonb_typeof(p_change -> 'value') <> 'object'
    or not ((p_change -> 'value') ?& array['recordTypeId', 'recordId'])
    or (p_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
    or not pg_catalog.pg_input_is_valid(p_change -> 'value' ->> 'recordTypeId', 'uuid')
    or not pg_catalog.pg_input_is_valid(p_change -> 'value' ->> 'recordId', 'uuid')
    or (p_change -> 'value' ->> 'recordTypeId')::uuid = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_change -> 'value' ->> 'recordId')::uuid = '00000000-0000-0000-0000-000000000000'::uuid then
    return null;
  end if;
  if not vortex_record.relationship_declares_target_internal(
    p_change -> 'relationship', (p_change -> 'value' ->> 'recordTypeId')::uuid
  ) then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'recordTypeId', (p_change -> 'value' ->> 'recordTypeId')::uuid,
    'recordId', (p_change -> 'value' ->> 'recordId')::uuid
  );
end
$function$;
alter function vortex_record.relationship_change_target_internal(jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.relationship_change_target_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.relationship_change_target_internal(jsonb) is
  'Private pure step of record update preparation: the exact target record a submitted link names when the value is well formed and the relationship declares that record type; one definition for the set-wide target load and the per-record link checks.';
