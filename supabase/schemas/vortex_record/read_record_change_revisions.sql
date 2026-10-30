create or replace function vortex_record.read_record_change_revisions(p_targets jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type_id uuid;
  meta jsonb;
  found_rows jsonb;
  revisions jsonb := '[]'::jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) > 200
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_targets) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordTypeId')
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
    ) then
    raise exception using errcode = '22023', message = 'Record change targets are invalid';
  end if;
  -- One locking read per record type of the installed application: revisions only. The record
  -- writer decides every target's authority; no value or capability leaves here.
  for record_type_id in
    select distinct (item.value ->> 'recordTypeId')::uuid
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
    order by 1
  loop
    meta := vortex_record.resolve_record_action_context_internal(record_type_id, 'read');
    if meta -> 'recordType' ? 'systemProjection' then
      continue;
    end if;
    execute pg_catalog.format(
      'select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          ''recordTypeId'', $4, ''recordId'', stored.record_id, ''revision'', stored.concurrency_number)
          order by stored.record_id), ''[]''::jsonb)
       from (select record_id, concurrency_number from record_data.%I
         where organisation_id = $1 and %s and lifecycle_state = ''active''
           and record_id = any ($2) order by record_id for update) as stored',
      meta ->> 'table',
      case when meta ->> 'storageScope' = 'application_contained'
        then 'application_root_id = $3' else 'application_root_id is null' end
    )
    into found_rows
    using (context_value ->> 'organizationId')::uuid,
      (select pg_catalog.array_agg((item.value ->> 'recordId')::uuid)
        from pg_catalog.jsonb_array_elements(p_targets) as item(value)
        where (item.value ->> 'recordTypeId')::uuid = record_type_id),
      (context_value ->> 'applicationRootId')::uuid, record_type_id;
    revisions := revisions || found_rows;
  end loop;
  return revisions;
end
$function$;
alter function vortex_record.read_record_change_revisions(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.read_record_change_revisions(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_change_revisions(jsonb) to vortex_request;
comment on function vortex_record.read_record_change_revisions(jsonb) is
  'Locks and returns the current revisions of up to 200 active records of the installed application for one set-based change, one read per record type; the record writer still decides each target''s authority, and no value or capability is returned.';
