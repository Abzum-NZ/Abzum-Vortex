set local role vortex_owner;

create or replace function vortex_record.record_records_export_activity(
  p_activity_id uuid,
  p_record_type_id uuid,
  p_field_ids uuid[],
  p_action text,
  p_outcome text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  append_result text;
begin
  if p_activity_id is null
    or not vortex_platform.is_non_nil_uuid(p_activity_id::text)
    or p_record_type_id is null
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or p_field_ids is null
    or pg_catalog.array_position(p_field_ids, null::uuid) is not null
    or p_field_ids is distinct from (
      select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[])
      from (select distinct value from pg_catalog.unnest(p_field_ids) as item(value)) canonical
    )
    or p_action is null
    or p_outcome is null
    or not (
      (p_action = 'records_export_started' and p_outcome = 'completed')
      or (p_action = 'records_export_refused' and p_outcome = 'refused')
      or (p_action = 'records_export_finished' and p_outcome = 'completed')
      or (p_action = 'records_export_cancelled' and p_outcome = 'completed')
      or (p_action = 'records_export_incomplete' and p_outcome = 'failed')
    ) then
    raise exception using errcode = '22023', message = 'Records export Activity input is invalid';
  end if;

  -- The organisation, actor, correlation and channel come only from the validated request context;
  -- the entry names the record type exported and the columns written, never a value or a record.
  context_value := vortex_access.validated_human_request_context();
  if context_value ->> 'callerKind' is distinct from 'human'
    or not vortex_platform.is_non_nil_uuid(context_value ->> 'organizationId')
    or not vortex_platform.is_non_nil_uuid(context_value ->> 'organizationAccountId')
    or not vortex_platform.is_non_nil_uuid(context_value ->> 'correlationId') then
    raise exception using errcode = '42501', message = 'Records export Activity is unavailable';
  end if;

  append_result := vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid, p_activity_id,
    pg_catalog.statement_timestamp(), 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid, p_action,
    array[p_record_type_id]::uuid[], p_field_ids,
    vortex_platform.channel(), (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Records export Activity is stale';
  end if;
end
$function$;

revoke all on function vortex_record.record_records_export_activity(uuid, uuid, uuid[], text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_record.record_records_export_activity(uuid, uuid, uuid[], text, text)
  to vortex_request;

comment on function vortex_record.record_records_export_activity(uuid, uuid, uuid[], text, text) is
  'Records one content-free Activity entry of a records export attempt or outcome (started, refused, finished, cancelled or incomplete) for the validated human request: the exported record type and columns, never a value, a record or a file.';

alter function vortex_record.record_records_export_activity(uuid, uuid, uuid[], text, text)
  owner to vortex_owner;

reset role;
