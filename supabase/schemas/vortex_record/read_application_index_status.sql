CREATE OR REPLACE FUNCTION vortex_record.read_application_index_status(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  authority jsonb;
  target_storage_contract_ids uuid[];
  target record;
  mapping record;
  purpose text;
  scope_columns text;
  index_token text;
  definition_fingerprint text;
  observed text;
  catalogue_row vortex_record.index_catalogue%rowtype;
  index_state text;
  ready boolean;
  lease_active boolean;
  conflict_outcome jsonb;
  conflict_value jsonb;
  target_count integer := 0;
  index_count integer := 0;
  ready_count integer := 0;
  pending_count integer := 0;
  running_count integer := 0;
  interrupted_count integer := 0;
  conflicting_count integer := 0;
  indexes jsonb := '[]'::jsonb;
  uniqueness_ready boolean := true;
begin
  if p_organization_id is null
    or p_organization_id = nil_uuid
    or p_application_root_id is null
    or p_application_root_id = nil_uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Index status command is invalid';
  end if;

  authority := vortex_record.authorize_index_status_internal(
    p_organization_id, p_application_root_id
  );

  -- The same protected active-installation target fact `read_index_readiness`
  -- uses; the organisation is re-derived from the validated request context
  -- inside it and the supplied value must match it.
  select pg_catalog.array_agg(distinct targets.storage_contract_id)
    into target_storage_contract_ids
  from vortex_definition.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  if target_storage_contract_ids is null
    or pg_catalog.cardinality(target_storage_contract_ids) = 0 then
    raise exception using errcode = '23514',
      message = 'Index status activation targets are incomplete';
  end if;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope,
      catalogue.physical_table_token, catalogue.record_type_id
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (target_storage_contract_ids)
      and catalogue.state = 'active'
    order by catalogue.storage_contract_id
  loop
    target_count := target_count + 1;

    for mapping in
      select stored.field_id, stored.physical_column_token, stored.field_definition
      from vortex_record.field_storage_mappings as stored
      where stored.storage_contract_id = target.storage_contract_id
        and stored.state = 'active'
        and (
          coalesce((stored.field_definition ->> 'unique')::boolean, false)
          or coalesce((stored.field_definition ->> 'filterable')::boolean, false)
          or coalesce((stored.field_definition ->> 'sortable')::boolean, false)
        )
      order by stored.field_id
    loop
      index_count := index_count + 1;

      purpose := case
        when coalesce((mapping.field_definition ->> 'unique')::boolean, false)
          then 'uniqueness'
        else 'performance'
      end;
      scope_columns := vortex_record.index_scope_columns(target.storage_scope);
      index_token := case purpose when 'uniqueness' then 'ux_' else 'ix_' end
        || pg_catalog.substr(mapping.physical_column_token, 3);
      definition_fingerprint := vortex_record.index_definition_fingerprint(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );
      observed := vortex_record.observe_field_index_internal(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );

      select stored_index.* into catalogue_row
      from vortex_record.index_catalogue as stored_index
      where stored_index.storage_contract_id = target.storage_contract_id
        and stored_index.field_id = mapping.field_id
      for share;

      ready := observed = 'present'
        and catalogue_row.index_contract_id is not null
        and catalogue_row.purpose = purpose
        and catalogue_row.physical_index_token = index_token
        and catalogue_row.desired_definition_fingerprint = definition_fingerprint;

      -- A lease that has not expired is an active build. An expired lease or
      -- an invalid physical index is an interrupted build awaiting a later
      -- claim. Neither is ever projected as ready.
      lease_active := catalogue_row.index_contract_id is not null
        and catalogue_row.claim_id is not null
        and catalogue_row.lease_expires_at > pg_catalog.statement_timestamp();

      -- Only a uniqueness index that is neither ready nor actively building
      -- can be blocked by its own data. The conflict search is only attempted
      -- then, and its exact outcome decides the state.
      conflict_outcome := null;
      conflict_value := null;
      if not ready and not lease_active and purpose = 'uniqueness' then
        conflict_outcome := vortex_record.read_index_conflict_references_internal(
          target.record_type_id, target.physical_table_token, scope_columns,
          mapping.physical_column_token
        );
      end if;

      if ready then
        index_state := 'ready';
        ready_count := ready_count + 1;
      elsif lease_active then
        index_state := 'running';
        running_count := running_count + 1;
      elsif conflict_outcome is not null and conflict_outcome ->> 'outcome' <> 'none' then
        index_state := 'conflicting';
        conflicting_count := conflicting_count + 1;
        conflict_value := case conflict_outcome ->> 'outcome'
          when 'unreadable' then pg_catalog.jsonb_build_object('state', 'unreadable')
          else pg_catalog.jsonb_build_object(
            'state', 'readable',
            'records', coalesce(conflict_outcome -> 'records', '[]'::jsonb)
          )
        end;
      elsif observed = 'invalid' or catalogue_row.claim_id is not null then
        index_state := 'interrupted';
        interrupted_count := interrupted_count + 1;
      else
        index_state := 'pending';
        pending_count := pending_count + 1;
      end if;

      if purpose = 'uniqueness' and not ready then
        uniqueness_ready := false;
      end if;

      indexes := indexes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'indexContractId', coalesce(
          catalogue_row.index_contract_id,
          vortex_record.index_contract_identity(
            target.storage_contract_id, mapping.field_id
          )
        ),
        'storageContractId', target.storage_contract_id,
        'fieldId', mapping.field_id,
        'purpose', purpose,
        'desiredDefinitionFingerprint', definition_fingerprint,
        'state', index_state,
        'observedState', observed,
        'recordedObservedState', catalogue_row.observed_state,
        'observedRevision', catalogue_row.observed_revision,
        'ready', ready,
        'failureCode', case index_state
          when 'interrupted' then 'build_interrupted'
          when 'conflicting' then 'uniqueness_conflict'
          else null
        end,
        'conflict', conflict_value
      ));
    end loop;
  end loop;

  -- Every installation storage contract must be an active catalogue entry; a
  -- target this read cannot account for is an incomplete installation, never
  -- an implicitly unindexed record type.
  if target_count <> pg_catalog.cardinality(target_storage_contract_ids) then
    raise exception using errcode = '23514',
      message = 'Index status activation targets are incomplete';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', authority ->> 'organizationId',
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'indexes', indexes,
    'progress', pg_catalog.jsonb_build_object(
      'total', index_count,
      'ready', ready_count,
      'pending', pending_count,
      'running', running_count,
      'interrupted', interrupted_count,
      'conflicting', conflicting_count
    ),
    'uniquenessReady', uniqueness_ready,
    'performanceAdvisory', true
  );
end
$$;
alter function vortex_record.read_application_index_status(uuid,uuid,bigint,jsonb) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.read_application_index_status(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) IS 'Protected live status of every exact field index one active Application installation owns: pending, running, ready, interrupted or conflicting, with bounded progress and no physical detail.';

REVOKE ALL ON FUNCTION vortex_record.read_application_index_status(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.read_application_index_status(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) TO vortex_request;
