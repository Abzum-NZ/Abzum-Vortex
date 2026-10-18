create or replace function vortex_record.read_derived_field_backfill(
  p_record_type_id uuid,
  p_after_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- One page of existing records; the caller asks for the next page after the last record.
  page_size constant integer := 100;
  scope jsonb;
  record_type_key text;
  type_meta jsonb;
  definition jsonb;
  field_ids jsonb;
  application_scope uuid;
  records jsonb;
  page_ids uuid[];
  relationship_id_value text;
  relationship_value jsonb;
  source_key text;
  source_meta jsonb;
  source_definition jsonb;
  link_token text;
  source_scope uuid;
  related jsonb;
  sources jsonb := '[]'::jsonb;
  related_by_relationship jsonb := '{}'::jsonb;
begin
  scope := vortex_record.derived_field_backfill_scope_internal();
  -- Without a record type: the record types whose existing records a backfill works out.
  if p_record_type_id is null then
    return pg_catalog.jsonb_build_object('recordTypeIds', coalesce((
      select pg_catalog.jsonb_agg(target.key order by target.key collate "C")
      from pg_catalog.jsonb_object_keys(scope -> 'targets') as target(key)
    ), '[]'::jsonb));
  end if;
  record_type_key := pg_catalog.lower(p_record_type_id::text);
  field_ids := scope -> 'targets' -> record_type_key;
  if field_ids is null then
    return pg_catalog.jsonb_build_object('records', '[]'::jsonb);
  end if;
  type_meta := scope -> 'plan' -> 'recordTypes' -> record_type_key;
  definition := scope -> 'definitions' -> record_type_key;
  application_scope := case when type_meta ->> 'storageScope' = 'application_contained'
    then (scope ->> 'applicationRootId')::uuid else null end;

  -- The page is locked, so no save changes a record between this read and its backfill write.
  execute pg_catalog.format(
    'select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         ''recordId'', page.record_id,
         ''concurrencyNumber'', page.concurrency_number,
         ''values'', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
       ) order by page.record_id), ''[]''::jsonb),
       coalesce(pg_catalog.array_agg(page.record_id order by page.record_id), array[]::uuid[])
     from (
       select stored.* from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.application_root_id is not distinct from $2
         and stored.lifecycle_state = ''active''
         and ($3::uuid is null or stored.record_id > $3)
       order by stored.record_id
       limit %s
       for update
     ) as page',
    type_meta ->> 'valueExpression', type_meta ->> 'table', page_size
  ) into records, page_ids
  using (scope ->> 'organizationId')::uuid, application_scope, p_after_record_id;

  -- Each total's related records: the active records whose link names one of the page's records.
  for relationship_id_value in
    select distinct pg_catalog.lower(field.value #>> '{settings,relationshipId}')
    from pg_catalog.jsonb_array_elements(definition -> 'fields') as field(value)
    where field.value ->> 'type' = 'total'
  loop
    relationship_value := scope -> 'plan' -> 'relationships' -> relationship_id_value;
    source_key := pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
    source_meta := scope -> 'plan' -> 'recordTypes' -> source_key;
    source_definition := scope -> 'definitions' -> source_key;
    if relationship_value is null or source_meta is null or source_definition is null then
      raise exception using errcode = '55000',
        message = 'Derived field backfill relationship is not installed';
    end if;
    select source_meta -> 'columns' -> pg_catalog.lower(declared.value ->> 'fromFieldId') ->> 'token'
    into link_token
    from pg_catalog.jsonb_array_elements(source_definition -> 'relationships') as declared(value)
    where pg_catalog.lower(declared.value ->> 'relationshipId') = relationship_id_value;
    if link_token is null then
      raise exception using errcode = '55000',
        message = 'Derived field backfill relationship is not installed';
    end if;
    source_scope := case when source_meta ->> 'storageScope' = 'application_contained'
      then (scope ->> 'applicationRootId')::uuid else null end;
    execute pg_catalog.format(
      'select coalesce(pg_catalog.jsonb_object_agg(grouped.parent_id, grouped.records), ''{}''::jsonb)
       from (
         select pg_catalog.lower(stored.%1$I ->> ''recordId'') as parent_id,
           pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             ''fieldValues'', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%2$s))
           ) order by stored.record_id) as records
         from record_data.%3$I as stored
         where stored.organisation_id = $1
           and stored.application_root_id is not distinct from $2
           and stored.lifecycle_state = ''active''
           and pg_catalog.lower(stored.%1$I ->> ''recordTypeId'') = $3
           and pg_catalog.lower(stored.%1$I ->> ''recordId'') = any ($4)
         group by 1
       ) as grouped',
      link_token, source_meta ->> 'valueExpression', source_meta ->> 'table'
    ) into related
    using (scope ->> 'organizationId')::uuid, source_scope, record_type_key,
      (select coalesce(pg_catalog.array_agg(pg_catalog.lower(id::text)), array[]::text[])
       from pg_catalog.unnest(page_ids) as id);
    sources := sources || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'relationshipId', relationship_value -> 'relationshipId',
      'sourceRecordType', source_definition
    ));
    related_by_relationship := related_by_relationship
      || pg_catalog.jsonb_build_object(relationship_id_value, related);
  end loop;

  return pg_catalog.jsonb_build_object(
    'recordType', definition,
    'fieldIds', field_ids,
    'sources', sources,
    'records', records,
    'related', related_by_relationship
  );
end
$function$;

alter function vortex_record.read_derived_field_backfill(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_derived_field_backfill(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_derived_field_backfill(uuid, uuid)
  to vortex_runtime;
comment on function vortex_record.read_derived_field_backfill(uuid, uuid) is
  'Server-only derived-field backfill read: one locked page of a record type''s existing records in the request''s live or preview installation, with every value and each total''s related records, for the platform to work out the totals and stored calculations it has just provisioned.';
