-- #2069: publish exact saved derived-parent Record notices.
begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create or replace function vortex_record.apply_relationship_total_parent_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  catalogue jsonb;
  snapshot jsonb;
  context_value jsonb;
  field_value jsonb;
  column_value jsonb;
  entry record;
  assignments text[] := array[]::text[];
  changed_field_ids uuid[] := array[]::uuid[];
  update_sql text;
  saved_record_id uuid;
  new_revision bigint;
  preview_installation jsonb;
  notice_sequence bigint;
  event_result jsonb;
begin
  if pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Relationship total parent mutation is invalid';
  end if;
  if p_final_values = '{}'::jsonb then return; end if;
  catalogue := vortex_record.relationship_total_catalogue_internal();
  snapshot := vortex_record.relationship_total_record_snapshot_internal(
    catalogue, p_record_type_id, p_record_id, true
  );
  if snapshot is null or (snapshot ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    raise exception using errcode = '40001', message = 'Relationship total parent revision changed';
  end if;
  context_value := vortex_access.validated_human_request_context();
  for entry in select pg_catalog.lower(key) as key, value from pg_catalog.jsonb_each(p_final_values)
  loop
    select field.value into field_value
    from pg_catalog.jsonb_array_elements(snapshot -> 'recordType' -> 'fields') field(value)
    where pg_catalog.lower(field.value ->> 'fieldId') = entry.key;
    if field_value is null or field_value ->> 'type' not in ('total', 'calculation') then
      raise exception using errcode = '42501', message = 'Relationship total parent field is unavailable';
    end if;
    select pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type
    ) into column_value
    from vortex_record.field_storage_mappings mapping
    where mapping.storage_contract_id = (snapshot ->> 'storageContractId')::uuid
      and mapping.field_id = entry.key::uuid and mapping.state = 'active';
    if column_value is null or not vortex_record.canonical_record_value_matches(
      entry.value, field_value ->> 'type', column_value ->> 'databaseValueType'
    ) then
      raise exception using errcode = '23514', message = 'Relationship total parent value is invalid';
    end if;
    assignments := pg_catalog.array_append(assignments, pg_catalog.format(
      '%I = %s', column_value ->> 'token',
      case when pg_catalog.jsonb_typeof(entry.value) = 'null' then 'null'
      else case column_value ->> 'databaseValueType'
        when 'decimal' then pg_catalog.format('%L::numeric', entry.value #>> '{}')
        when 'timestamp_with_time_zone' then pg_catalog.format('%L::timestamptz', entry.value #>> '{}')
        when 'date' then pg_catalog.format('%L::date', entry.value #>> '{}')
        when 'integer' then pg_catalog.format('%L::bigint', entry.value #>> '{}')
        when 'boolean' then pg_catalog.format('%L::boolean', entry.value #>> '{}')
        when 'json' then pg_catalog.format('%L::jsonb', entry.value::text)
        else pg_catalog.format('%L::text', entry.value #>> '{}') end end
    ));
    changed_field_ids := pg_catalog.array_append(changed_field_ids, entry.key::uuid);
  end loop;
  select pg_catalog.array_agg(distinct value order by value) into changed_field_ids
  from pg_catalog.unnest(changed_field_ids) item(value);
  update_sql := pg_catalog.format(
    'update record_data.%I stored set %s,
       concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $5
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $4
     returning stored.record_id, stored.concurrency_number',
    (select stored.physical_table_token from vortex_record.storage_catalogue stored
     where stored.storage_contract_id = (snapshot ->> 'storageContractId')::uuid),
    pg_catalog.array_to_string(assignments, ', ')
  );
  execute update_sql into saved_record_id, new_revision using
    (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid, p_expected_concurrency_number,
    (snapshot ->> 'definitionRevision')::bigint;
  if new_revision is null then
    raise exception using errcode = '40001', message = 'Relationship total parent write is stale';
  end if;
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation is null
    and snapshot #>> '{recordType,storageScope}' = 'application_contained' then
    notice_sequence := pg_catalog.nextval(
      'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
    );
    begin
      perform vortex_invalidation.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid,
        p_record_type_id, saved_record_id, new_revision, 'changed',
        notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
      );
    exception
      when others then
        -- Invalidation is advisory; a lost notice must not refuse the parent write.
        null;
    end;
  else
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (snapshot ->> 'storageContractId')::uuid,
      case when snapshot #>> '{recordType,storageScope}' = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
  end if;
  perform vortex_record.append_base_save_activity_internal(
    pg_catalog.gen_random_uuid(), 'update', p_record_id, changed_field_ids, 'completed'
  );
  event_result := vortex_event.append_record_occurrences(
    (snapshot ->> 'storageContractId')::uuid, p_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', pg_catalog.gen_random_uuid(),
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', p_record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Relationship total parent Event append failed';
  end if;
end
$function$;

alter function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb) is
  'Applies protected generated parent totals and calculations with the actual saved revision, Activity and standard Events in the original transaction. Live application-contained writes publish an advisory content-free notice for the actual saved Record; other scopes and previews retain their existing invalidation behavior.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
