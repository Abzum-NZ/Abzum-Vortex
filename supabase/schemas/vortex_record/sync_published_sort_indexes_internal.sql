create or replace function vortex_record.sync_published_sort_indexes_internal()
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  candidate record;
  definition_value jsonb;
  selected_ids uuid[] := array[]::uuid[];
  skipped jsonb := '[]'::jsonb;
  current_storage uuid;
  shape_count integer := 0;
  index_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex_record.published_sort_indexes', 0));
  -- A Query can be installed by more than one application. Choose from the
  -- complete active binding set, not from one caller's release in isolation.
  for candidate in
    with requested as (
      select storage.storage_contract_id,
        query_item.value -> 'sort' as sort_shape,
        binding.module_root_id, query_item.value ->> 'queryId' as query_id
      from vortex_definition.installation_bindings as binding
      join vortex_definition.releases as release
        on release.root_id = binding.module_root_id
        and release.release_revision = binding.module_release_revision
      cross join lateral pg_catalog.jsonb_array_elements(
        release.compilation_output #> '{canonical,content,queries}') as query_item(value)
      join vortex_record.storage_catalogue as storage
        on storage.module_root_id = (query_item.value #>> '{recordType,moduleRootId}')::uuid
        and storage.record_type_id = (query_item.value #>> '{recordType,recordTypeId}')::uuid
        and storage.state = 'active' and storage.physical_schema_token = 'record_data'
      where binding.state = 'active'
        and query_item.value #>> '{recordType,state}' = 'resolved'
        and pg_catalog.jsonb_typeof(query_item.value -> 'sort') = 'array'
        and pg_catalog.jsonb_array_length(query_item.value -> 'sort') >= 2
    ), distinct_shapes as (
      select storage_contract_id, sort_shape,
        min(module_root_id::text || ':' || query_id) as first_query
      from requested group by storage_contract_id, sort_shape
    )
    select * from distinct_shapes
    order by storage_contract_id, first_query, sort_shape::text
  loop
    if current_storage is distinct from candidate.storage_contract_id then
      current_storage := candidate.storage_contract_id;
      shape_count := 0;
    end if;
    shape_count := shape_count + 1;
    if shape_count > 4 then
      skipped := skipped || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'storageContractId', candidate.storage_contract_id,
        'sort', candidate.sort_shape, 'firstQuery', candidate.first_query,
        'reasonCode', 'published_sort_index_budget_exceeded'));
      continue;
    end if;
    definition_value := vortex_record.published_sort_index_definition_internal(
      candidate.storage_contract_id, candidate.sort_shape);
    if definition_value ->> 'outcome' <> 'valid' then
      skipped := skipped || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'storageContractId', candidate.storage_contract_id,
        'sort', candidate.sort_shape, 'firstQuery', candidate.first_query,
        'reasonCode', definition_value ->> 'reasonCode'));
      continue;
    end if;
    index_id := pg_catalog.md5(
      candidate.storage_contract_id::text || ':' || candidate.sort_shape::text)::uuid;
    selected_ids := pg_catalog.array_append(selected_ids, index_id);
    insert into vortex_record.index_catalogue (
      index_contract_id, storage_contract_id, field_id, purpose, sort_shape,
      physical_index_token, desired_definition_fingerprint, observed_state, observed_revision
    ) values (
      index_id, candidate.storage_contract_id,
      (candidate.sort_shape -> 0 ->> 'fieldId')::uuid, 'published_sort',
      candidate.sort_shape, definition_value ->> 'indexToken',
      definition_value ->> 'fingerprint', definition_value ->> 'observedState', 1
    )
    on conflict (index_contract_id) do update
    set purpose = excluded.purpose,
      sort_shape = excluded.sort_shape,
      physical_index_token = excluded.physical_index_token,
      desired_definition_fingerprint = excluded.desired_definition_fingerprint,
      observed_state = excluded.observed_state,
      observed_revision = vortex_record.index_catalogue.observed_revision + 1,
      claim_id = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
      changed_at = pg_catalog.statement_timestamp()
    where vortex_record.index_catalogue.purpose is distinct from excluded.purpose
      or vortex_record.index_catalogue.sort_shape is distinct from excluded.sort_shape
      or vortex_record.index_catalogue.desired_definition_fingerprint
        is distinct from excluded.desired_definition_fingerprint
      or (vortex_record.index_catalogue.observed_state is distinct from excluded.observed_state
        and (vortex_record.index_catalogue.claim_id is null
          or vortex_record.index_catalogue.lease_expires_at <= pg_catalog.statement_timestamp()));
  end loop;

  update vortex_record.index_catalogue as catalogue
  set purpose = 'published_sort_drop', observed_state = 'missing',
    observed_revision = catalogue.observed_revision + 1,
    claim_id = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
    changed_at = pg_catalog.statement_timestamp()
  where catalogue.purpose = 'published_sort'
    and not (catalogue.index_contract_id = any (selected_ids));
  if skipped <> '[]'::jsonb then
    raise log 'Published Query sort indexes skipped: %', skipped;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'synchronized', 'skippedSorts', skipped,
    'selectedCount', pg_catalog.cardinality(selected_ids));
end
$function$;
alter function vortex_record.sync_published_sort_indexes_internal() owner to vortex_owner;
revoke all on function vortex_record.sync_published_sort_indexes_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.sync_published_sort_indexes_internal() to vortex_owner;
