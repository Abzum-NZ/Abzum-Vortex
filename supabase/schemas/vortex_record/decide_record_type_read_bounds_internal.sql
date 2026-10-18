create or replace function vortex_record.decide_record_type_read_bounds_internal(
  p_plan jsonb,
  p_record_type_id uuid,
  p_seen_record_type_ids jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  -- Nothing guaranteed and no exactness claim: the fail-closed answer.
  nothing constant jsonb := '{"readableFieldIds":[],"coversAllRecords":false,"conditionFree":false}'::jsonb;
  context_value jsonb;
  declaration jsonb;
  bounds jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_seen_record_type_ids) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Record type read bounds input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId')
    or (p_plan ->> 'organizationId')::uuid is distinct from (context_value ->> 'organizationId')::uuid
    or (p_plan ->> 'applicationRootId')::uuid is distinct from (context_value ->> 'applicationRootId')::uuid then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  declaration := vortex_record.record_type_read_declaration_internal(
    p_plan, p_record_type_id, (context_value ->> 'applicationRootId')::uuid
  );
  if declaration is null then
    return nothing;
  end if;

  -- The fields this reader is guaranteed to see on every record the read
  -- decision admits. A refused access context guarantees no field; any other
  -- failure propagates.
  begin
    bounds := vortex_access.resolve_record_read_field_bounds_internal(declaration);
  exception
    when sqlstate '42501' then
      get stacked diagnostics failure_sqlstate = returned_sqlstate,
        failure_message = message_text;
      raise warning 'Record read field bounds were refused: SQLSTATE %, %',
        failure_sqlstate, failure_message;
      return nothing;
  end;

  -- Produced fields are guaranteed only where the one field-read decision
  -- shows them.
  return bounds || pg_catalog.jsonb_build_object(
    'readableFieldIds', vortex_record.decide_produced_field_ids_internal(
      p_plan, p_record_type_id, bounds -> 'readableFieldIds', p_seen_record_type_ids
    )
  );
end
$function$;

alter function vortex_record.decide_record_type_read_bounds_internal(jsonb, uuid, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.decide_record_type_read_bounds_internal(jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.decide_record_type_read_bounds_internal(jsonb, uuid, jsonb) is
  'Private whole-record-type read bounds for the current reader: the fields every record the read decision admits is guaranteed to expose, after the field-read decision for produced fields, whether an unconditioned all-records alternative admits every active record, and whether no alternative carries a saved condition; a refused context or an undeclared read yields no fields.';
