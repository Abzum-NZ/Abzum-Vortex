CREATE OR REPLACE FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  target_storage_contract_ids uuid[];
  target record;
  mapping record;
  purpose text;
  scope_columns text;
  index_token text;
  definition_fingerprint text;
  observed text;
  catalogue_id uuid;
  catalogue_purpose text;
  catalogue_token text;
  catalogue_fingerprint text;
  catalogue_observed text;
  catalogue_revision bigint;
  ready boolean;
  target_count integer := 0;
  indexes jsonb := '[]'::jsonb;
  uniqueness_ready boolean := true;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Index readiness command is invalid';
  end if;

  -- The same protected activation target fact the lifecycle-policy readiness
  -- read uses; the organisation is re-derived from the validated human request
  -- context inside it and is never taken from the caller.
  -- An installation whose Modules hold no record types yet has no targets and no indexes.
  select coalesce(pg_catalog.array_agg(distinct targets.storage_contract_id), array[]::uuid[])
    into target_storage_contract_ids
  from vortex_definition.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope,
      catalogue.physical_table_token
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

      select stored_index.index_contract_id, stored_index.purpose,
        stored_index.physical_index_token, stored_index.desired_definition_fingerprint,
        stored_index.observed_state, stored_index.observed_revision
      into catalogue_id, catalogue_purpose, catalogue_token, catalogue_fingerprint,
        catalogue_observed, catalogue_revision
      from vortex_record.index_catalogue as stored_index
      where stored_index.storage_contract_id = target.storage_contract_id
        and stored_index.field_id = mapping.field_id
        and stored_index.purpose in ('uniqueness', 'performance')
      for share;

      ready := observed = 'present'
        and catalogue_id is not null
        and catalogue_purpose = purpose
        and catalogue_token = index_token
        and catalogue_fingerprint = definition_fingerprint;

      if purpose = 'uniqueness' and not ready then
        uniqueness_ready := false;
      end if;

      indexes := indexes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'indexContractId', coalesce(
          catalogue_id,
          vortex_record.index_contract_identity(
            target.storage_contract_id, mapping.field_id
          )
        ),
        'storageContractId', target.storage_contract_id,
        'fieldId', mapping.field_id,
        'purpose', purpose,
        'desiredDefinitionFingerprint', definition_fingerprint,
        'observedState', observed,
        'recordedObservedState', catalogue_observed,
        'observedRevision', catalogue_revision,
        'ready', ready
      ));
    end loop;
  end loop;

  -- Every installation storage contract must be an active catalogue entry; a
  -- target this read cannot account for is an incomplete installation, never an
  -- implicitly unindexed record type.
  if target_count <> pg_catalog.cardinality(target_storage_contract_ids) then
    raise exception using errcode = '23514',
      message = 'Index activation targets are incomplete';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'indexes', indexes,
    'uniquenessReady', uniqueness_ready,
    'performanceAdvisory', true
  );
end
$$;
alter function vortex_record.read_index_readiness(uuid,uuid,bigint,jsonb) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) IS 'Live readiness of every exact field index an activating Application installation owns: uniqueness indexes are activation requirements, performance indexes are advisory.';

REVOKE ALL ON FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) TO vortex_request;
