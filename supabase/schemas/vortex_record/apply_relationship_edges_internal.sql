create or replace function vortex_record.apply_relationship_edges_internal(p_changes jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  organization_id_value uuid;
  changed_parent record;
begin
  organization_id_value := (vortex_access.validated_human_request_context() ->> 'organizationId')::uuid;
  if pg_catalog.jsonb_typeof(p_changes) is distinct from 'array' or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Relationship changes are invalid';
  end if;

  -- Every source is one declared fixed link. The shared participant locks and
  -- target eligibility checks have already run in relationship preparation.
  merge into vortex_record.relationship_edges as edge
  using (
    select (item.value ->> 'relationshipId')::uuid as relationship_id,
      (item.value ->> 'sourceStorageContractId')::uuid as source_storage_contract_id,
      (item.value ->> 'sourceRecordId')::uuid as source_record_id,
      (item.value ->> 'sourceApplicationRootId')::uuid as source_application_root_id,
      (item.value ->> 'targetStorageContractId')::uuid as target_storage_contract_id,
      (item.value ->> 'targetRecordId')::uuid as target_record_id,
      (item.value ->> 'targetApplicationRootId')::uuid as target_application_root_id
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
  ) as change
  on edge.relationship_id = change.relationship_id
    and edge.from_organisation_id = organization_id_value
    and edge.from_storage_contract_id = change.source_storage_contract_id
    and edge.from_record_id = change.source_record_id
  when matched and change.target_record_id is null then delete
  when matched then update set
    to_storage_contract_id = change.target_storage_contract_id,
    to_record_id = change.target_record_id,
    from_application_root_id = change.source_application_root_id,
    to_application_root_id = change.target_application_root_id
  when not matched and change.target_record_id is not null then insert (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    change.relationship_id, organization_id_value, organization_id_value,
    change.source_application_root_id, change.target_application_root_id,
    change.source_storage_contract_id, change.source_record_id,
    change.target_storage_contract_id, change.target_record_id
  );

  -- Check the final set too: two newly supplied links must not each pass a
  -- check against the old graph and claim the same one-to-one target.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    join vortex_record.relationship_edges as edge
      on edge.relationship_id = (item.value ->> 'relationshipId')::uuid
      and edge.to_organisation_id = organization_id_value
      and edge.to_storage_contract_id = (item.value ->> 'targetStorageContractId')::uuid
      and edge.to_record_id = (item.value ->> 'targetRecordId')::uuid
      and edge.from_storage_contract_id = (item.value ->> 'sourceStorageContractId')::uuid
    where item.value ->> 'cardinality' = 'one_to_one'
    group by item.value
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
  end if;

  -- Checking each proposal against the old graph cannot detect a cycle formed
  -- by several proposals together. Reuse the parent checker on the final graph;
  -- preparation already holds its relationship-wide transaction lock.
  for changed_parent in
    select distinct (item.value ->> 'relationshipId')::uuid as relationship_id,
      (item.value ->> 'sourceStorageContractId')::uuid as storage_contract_id,
      (item.value ->> 'sourceRecordId')::uuid as source_record_id,
      (item.value ->> 'targetRecordId')::uuid as target_record_id,
      (relationship.value ->> 'fromFieldId')::uuid as field_id
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    join vortex_record.storage_catalogue as storage
      on storage.storage_contract_id = (item.value ->> 'sourceStorageContractId')::uuid
    cross join lateral pg_catalog.jsonb_array_elements(
      storage.record_type_definition -> 'relationships'
    ) as relationship(value)
    where relationship.value ->> 'relationshipId' = item.value ->> 'relationshipId'
      and relationship.value ->> 'cardinality' = 'many_to_one'
      and item.value -> 'sourceStorageContractId' = item.value -> 'targetStorageContractId'
      and item.value ->> 'targetRecordId' is not null
    order by relationship_id, storage_contract_id, source_record_id
  loop
    perform vortex_record.assert_relationship_acyclic_internal(
      changed_parent.relationship_id, organization_id_value,
      changed_parent.storage_contract_id, changed_parent.field_id,
      changed_parent.source_record_id, changed_parent.target_record_id
    );
  end loop;
end
$function$;

alter function vortex_record.apply_relationship_edges_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.apply_relationship_edges_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.apply_relationship_edges_internal(jsonb) is
  'Private set-based edge writer: applies prepared fixed-link replacements in one MERGE and checks cardinality and parent cycles on the final graph.';
