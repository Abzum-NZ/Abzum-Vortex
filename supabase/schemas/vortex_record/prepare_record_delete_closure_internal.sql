create or replace function vortex_record.prepare_record_delete_closure_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_visited text[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  context_value jsonb;
  record_fact jsonb;
  identity_value text;
  incoming record;
  relationship_value jsonb;
  source_field_id uuid;
  on_parent_delete text;
  source_catalogue vortex_record.storage_catalogue%rowtype;
  source_meta jsonb;
  source_loaded jsonb;
  source_decision jsonb;
  source_record_type jsonb;
  source_concurrency bigint;
  source_link_column text;
  source_link_value jsonb;
  source_identity text;
  source_action_kind text;
  storage_changes jsonb := '[]'::jsonb;
  edge_changes jsonb := '[]'::jsonb;
  effects jsonb := '[]'::jsonb;
  dependent_plan jsonb;
  edge_change jsonb;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'delete');
  context_value := meta -> 'context';
  identity_value := pg_catalog.lower((meta ->> 'storageContractId')) || ':'
    || pg_catalog.lower(p_record_id::text);
  if identity_value = any (p_visited) then
    raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
  end if;
  p_visited := pg_catalog.array_append(p_visited, identity_value);

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'delete', p_record_id, p_expected_concurrency_number, null::jsonb
  );
  if loaded ->> 'outcome' = 'conflict' then
    raise exception using errcode = '40001', message = 'Record delete revision is stale';
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  if record_fact ->> 'lifecycleState' <> 'active' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'binding', meta -> 'declaration' -> 'recordBinding'
  );
  decision := vortex_access.evaluate_organization_record_access_internal(
    meta -> 'declaration', p_record_id, facts
  );
  if decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;

  -- Incoming edges are canonicalised before any child lock.  Every affected
  -- child is then reloaded and locked by the fixed record loader.
  for incoming in
    select edge.*
    from vortex_record.relationship_edges as edge
    where edge.to_organisation_id = (context_value ->> 'organizationId')::uuid
      and edge.to_storage_contract_id = (meta ->> 'storageContractId')::uuid
      and edge.to_record_id = p_record_id
    order by edge.from_storage_contract_id, edge.from_record_id, edge.relationship_id
  loop
    select catalogue.* into strict source_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = incoming.from_storage_contract_id;
    -- Preview-only relationships have no installed mapping. The edge's exact source
    -- storage declares the field and deletion policy, just as it declares edge integrity.
    select relationship.value into strict relationship_value
    from pg_catalog.jsonb_array_elements(
      source_catalogue.record_type_definition -> 'relationships'
    ) as relationship(value)
    where (relationship.value ->> 'relationshipId')::uuid = incoming.relationship_id;
    source_field_id := (relationship_value ->> 'fromFieldId')::uuid;
    on_parent_delete := relationship_value ->> 'onParentDelete';
    source_identity := pg_catalog.lower(incoming.from_storage_contract_id::text) || ':'
      || pg_catalog.lower(incoming.from_record_id::text);
    if source_identity = any (p_visited) then
      raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
    end if;

    -- A child retained by another Application cannot be silently modified
    -- under this Application's request context.  It is therefore a safe
    -- blocking relationship, not an authority bypass.
    source_action_kind := case
      when on_parent_delete = 'empty_optional' then 'update'
      when on_parent_delete = 'soft_delete_dependent' then 'delete'
      else 'read'
    end;
    begin
      source_meta := vortex_record.resolve_record_action_context_internal(
        source_catalogue.record_type_id, source_action_kind
      );
    exception when others then
      raise warning 'Delete relationship declaration unavailable: [%] %', sqlstate, sqlerrm;
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end;
    if (source_meta ->> 'storageContractId')::uuid is distinct from
      incoming.from_storage_contract_id then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;

    select field_mapping.physical_column_token into strict source_link_column
    from vortex_record.field_storage_mappings as field_mapping
    where field_mapping.storage_contract_id = incoming.from_storage_contract_id
      and field_mapping.field_id = source_field_id
      and field_mapping.state = 'active'
      and field_mapping.introduced_at_release_revision <=
        (source_meta ->> 'moduleReleaseRevision')::bigint;

    execute pg_catalog.format(
      'select concurrency_number, %I from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      source_link_column, source_meta ->> 'table'
    ) into source_concurrency, source_link_value using
      (context_value ->> 'organizationId')::uuid, incoming.from_record_id;
    if source_concurrency is null then
      continue;
    end if;
    -- The incoming-edge cursor may have been opened before a concurrent link
    -- change committed. The source row lock returns the current tuple, so
    -- re-check its exact field before applying parent-delete behaviour. This
    -- prevents a stale edge snapshot from clearing or revising the source a
    -- second time after that link was already removed or redirected.
    if pg_catalog.jsonb_typeof(source_link_value) <> 'object'
      or source_link_value ->> 'recordId' is distinct from p_record_id::text then
      continue;
    end if;
    source_loaded := vortex_record.load_record_access_facts_internal(
      source_catalogue.record_type_id, source_action_kind, incoming.from_record_id,
      source_concurrency, null::jsonb
    );
    if source_loaded ->> 'outcome' <> 'loaded' then
      continue;
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(source_loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = incoming.from_record_id;
    if record_fact ->> 'lifecycleState' <> 'active' then
      continue;
    end if;
    if on_parent_delete = 'refuse' then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;
    if pg_catalog.jsonb_typeof(source_meta -> 'declaration') <> 'object' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;
    source_decision := vortex_access.evaluate_organization_record_access_internal(
      source_meta -> 'declaration', incoming.from_record_id,
      (source_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', source_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if source_decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;

    if on_parent_delete = 'empty_optional' then
      effects := effects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'effectKind', 'optional_cleared', 'storageContractId', incoming.from_storage_contract_id,
        'recordTypeId', source_catalogue.record_type_id, 'recordId', incoming.from_record_id,
        'preConcurrencyNumber', source_concurrency, 'relationshipId', incoming.relationship_id,
        'previousValue', source_link_value
      ));
      edge_change := vortex_record.prepare_relationship_value_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        incoming.relationship_id, 'null'::jsonb, false
      );
      edge_changes := edge_changes || pg_catalog.jsonb_build_array(edge_change);
      storage_changes := storage_changes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'storageContractId', incoming.from_storage_contract_id, 'recordId', incoming.from_record_id,
        'expectedConcurrencyNumber', source_concurrency,
        'values', pg_catalog.jsonb_build_object(
          source_link_column, null, 'definition_revision', source_meta -> 'moduleReleaseRevision'
        )
      ));
    elsif on_parent_delete = 'soft_delete_dependent' then
      source_record_type := source_meta -> 'recordType';
      if source_record_type ->> 'ownershipMode' <> 'inherited'
        or not source_record_type ? 'ownershipRelationshipId'
        or (source_record_type ->> 'ownershipRelationshipId')::uuid <>
          incoming.relationship_id then
        raise exception using errcode = '23514', message = 'Dependent deletion is not declared';
      end if;
      dependent_plan := vortex_record.prepare_record_delete_closure_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, p_visited
      );
      storage_changes := storage_changes || (dependent_plan -> 'storageChanges');
      edge_changes := edge_changes || (dependent_plan -> 'edgeChanges');
      effects := effects || (dependent_plan -> 'effects');
    else
      raise exception using errcode = '23514', message = 'Parent deletion behavior is invalid';
    end if;
  end loop;

  storage_changes := storage_changes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'storageContractId', meta -> 'storageContractId', 'recordId', p_record_id,
    'expectedConcurrencyNumber', p_expected_concurrency_number,
    'values', pg_catalog.jsonb_build_object(
      'lifecycle_state', 'soft_deleted',
      'deleted_at', pg_catalog.statement_timestamp(), 'deleted_by', context_value -> 'organizationAccountId',
      'removal_due_at', null, 'definition_revision', meta -> 'moduleReleaseRevision'
    )
  ));
  effects := effects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'effectKind', 'soft_deleted', 'storageContractId', meta -> 'storageContractId',
    'recordTypeId', p_record_type_id, 'recordId', p_record_id,
    'preConcurrencyNumber', p_expected_concurrency_number, 'relationshipId', null, 'previousValue', null
  ));
  return pg_catalog.jsonb_build_object(
    'storageChanges', storage_changes, 'edgeChanges', edge_changes, 'effects', effects
  );
end
$function$;

alter function vortex_record.prepare_record_delete_closure_internal(uuid,uuid,bigint,text[]) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_delete_closure_internal(uuid,uuid,bigint,text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_record_delete_closure_internal(uuid,uuid,bigint,text[]) is
  'Private delete closure preparation: locks and authorizes the root, dependent records and cleared optional links, returning their complete storage, edge and journal changes without writing records.';
