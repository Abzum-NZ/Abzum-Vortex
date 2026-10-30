create or replace function vortex_record.read_record_change_targets(
  p_targets jsonb,
  p_lock boolean
)
returns table (ordinal integer, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target record;
  read_row record;
  reads jsonb := '[]'::jsonb;
  loaded jsonb;
begin
  perform vortex_access.validated_human_request_context();
  if p_lock is null or pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) > 400
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_targets) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'recordTypeId', 'uuid'), false)
        or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'recordId', 'uuid'), false)
    ) then
    raise exception using errcode = '22023', message = 'Record change targets are invalid';
  end if;

  -- Authorize every projection before taking locks; no field beyond that read decision leaves.
  for target in select item.value, item.ordinality::integer as ordinal
    from pg_catalog.jsonb_array_elements(p_targets) with ordinality as item(value, ordinality)
  loop
    select row_read.* into read_row
    from vortex_record.read_record_projection_internal(
      (target.value ->> 'recordTypeId')::uuid, (target.value ->> 'recordId')::uuid
    ) as row_read;
    reads := reads || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'target', target.value, 'ordinal', target.ordinal,
      'projection', read_row.projection, 'facts', read_row.read_facts, 'bounds', read_row.read_bounds
    ));
  end loop;

  -- Copy sources are not themselves updated, so retain their observed revision until commit.
  -- The shared loader also handles preview storage; never introduce another access decision.
  for target in select item.value from pg_catalog.jsonb_array_elements(reads) as item(value)
    order by item.value #>> '{facts,recordTypeMeta,storageContractId}',
      item.value #>> '{target,recordId}'
  loop
    ordinal := (target.value ->> 'ordinal')::integer;
    if p_lock and target.value #>> '{projection,outcome}' = 'allowed' then
      if (target.value #>> '{facts,isSystemProjection}')::boolean then
        result := pg_catalog.jsonb_build_object('record', pg_catalog.jsonb_build_object('outcome', 'refused'), 'capabilities', null);
        return next;
        continue;
      end if;
      loaded := (vortex_record.load_record_access_facts_internal('read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', (target.value #>> '{target,recordTypeId}')::uuid, 'recordId', (target.value #>> '{target,recordId}')::uuid, 'expectedConcurrencyNumber', (target.value #>> '{projection,concurrencyNumber}')::bigint))) -> 0);
      if loaded ->> 'outcome' is distinct from 'loaded' then
        raise exception using errcode = '40001', message = 'Record copy source changed';
      end if;
      result := vortex_record.read_record(
        (target.value #>> '{target,recordTypeId}')::uuid,
        (target.value #>> '{target,recordId}')::uuid
      );
    else
      result := pg_catalog.jsonb_build_object(
        'record', target.value -> 'projection',
        'capabilities', case when target.value #>> '{projection,outcome}' = 'allowed'
          then vortex_record.read_record_capabilities_internal(
            (target.value #>> '{target,recordTypeId}')::uuid,
            (target.value #>> '{target,recordId}')::uuid,
            target.value -> 'facts', target.value -> 'bounds', null
          ) end
      );
    end if;
    return next;
  end loop;
end
$function$;

alter function vortex_record.read_record_change_targets(jsonb,boolean) owner to vortex_record_adapter;
revoke all on function vortex_record.read_record_change_targets(jsonb,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_change_targets(jsonb,boolean) to vortex_request, vortex_owner;
comment on function vortex_record.read_record_change_targets(jsonb,boolean) is
  'Bounded current record projections and capabilities for a composed change; relationship copies lock ordinary source and destination revisions through the shared access loader.';
