-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.restore_record_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  context_value jsonb;
  loaded jsonb;
  facts jsonb;
  record_fact jsonb;
  decision jsonb;
  field_item jsonb;
  relationship_value jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  target_catalogue vortex_record.storage_catalogue%rowtype;
  retained_value jsonb;
  retained_target_type_id uuid;
  retained_target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  field_required boolean;
  application_root_required boolean;
  changed_rows integer;
  app_scope uuid;
begin
  if p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'restore');
    context_value := meta -> 'context';
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'restore', p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
    if record_fact ->> 'lifecycleState' <> 'soft_deleted' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;

    -- Restore access is decided over the retained row projected as the active
    -- candidate it would become.  The retained values/owner are unchanged.
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding',
      'records', (
        select pg_catalog.jsonb_agg(
          case when (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
            then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
            else item.value end order by item.ordinality
        )
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
          with ordinality as item(value, ordinality)
      )
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', p_record_id, facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;

    -- A restore keeps the retained values. Validate the narrow invariants this
    -- primitive owns: every currently required non-link value is present,
    -- non-null and has its canonical storage shape; every required link agrees
    -- with exactly one retained edge to a locked, active, currently readable
    -- target. Full final-value settings validation remains owned by #47.
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
      where coalesce((item.value ->> 'required')::boolean, false)
        or (item.value ->> 'type' in ('link', 'link_to_one_of_several')
          and coalesce((item.value #>> '{settings,applicationRootIdRequired}')::boolean, false))
    loop
      field_required := coalesce((field_item ->> 'required')::boolean, false);
      application_root_required := coalesce(
        (field_item #>> '{settings,applicationRootIdRequired}')::boolean, false
      );
      retained_value := record_fact -> 'fieldValues'
        -> pg_catalog.lower(field_item ->> 'fieldId');
      if not ((record_fact -> 'fieldValues') ? pg_catalog.lower(field_item ->> 'fieldId'))
        or pg_catalog.jsonb_typeof(retained_value) = 'null' then
        if field_required then
          raise exception using errcode = '23514', message = 'Required retained value is unavailable';
        end if;
        continue;
      end if;

      if field_item ->> 'type' not in ('link', 'link_to_one_of_several') then
        if not vortex_record.canonical_record_value_matches(
          retained_value,
          field_item ->> 'type',
          meta -> 'columns' -> pg_catalog.lower(field_item ->> 'fieldId')
            ->> 'databaseValueType'
        ) then
          raise exception using errcode = '23514', message = 'Required retained value is invalid';
        end if;
        continue;
      end if;

      select item.value into strict relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromFieldId')::uuid = (field_item ->> 'fieldId')::uuid;

      -- The retained value names its concrete target type; it must be one of
      -- the relationship's declared targets and the retained edge's target.
      if pg_catalog.jsonb_typeof(retained_value) <> 'object'
        or not (retained_value ?& array['recordTypeId', 'recordId'])
        or retained_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      begin
        retained_target_type_id := (retained_value ->> 'recordTypeId')::uuid;
        retained_target_record_id := (retained_value ->> 'recordId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end;
      if retained_target_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      if not vortex_record.relationship_declares_target_internal(
        relationship_value, retained_target_type_id
      ) then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;

      select edge.* into strict edge_row
      from vortex_record.relationship_edges as edge
      where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
        and edge.from_organisation_id = (context_value ->> 'organizationId')::uuid
        and edge.from_storage_contract_id = (meta ->> 'storageContractId')::uuid
        and edge.from_record_id = p_record_id;
      if edge_row.to_organisation_id <> (context_value ->> 'organizationId')::uuid
        or edge_row.to_record_id <> retained_target_record_id then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      select catalogue.* into strict target_catalogue
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = edge_row.to_storage_contract_id
        and catalogue.record_type_id = retained_target_type_id
        and catalogue.physical_schema_token in ('record_data', 'system_projection')
        and catalogue.state = 'active';
      if application_root_required
        and (target_catalogue.physical_schema_token is distinct from 'system_projection'
          or target_catalogue.protected_read_model_key is distinct from 'organization_accounts') then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;

      perform vortex_record.lock_relationship_target_row_internal(
        retained_target_type_id, retained_target_record_id,
        (context_value ->> 'organizationId')::uuid
      );

      target_loaded := vortex_record.load_record_access_facts_internal(
        retained_target_type_id, 'read', retained_target_record_id, null
      );
      if target_loaded ->> 'outcome' <> 'loaded'
        or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      target_decision := vortex_access.evaluate_organization_record_access_internal(
        target_loaded -> 'declaration', retained_target_record_id, target_loaded -> 'facts'
      );
      if target_decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      select item.value into target_record
      from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
      where (item.value -> 'recordScope' ->> 'recordId')::uuid = retained_target_record_id;
      target_scope := target_record -> 'recordScope';
      if target_record is null or target_record ->> 'lifecycleState' <> 'active'
        or (target_scope ->> 'organizationId')::uuid <>
          (context_value ->> 'organizationId')::uuid
        or edge_row.to_application_root_id is distinct from (
          case when target_scope ->> 'storageScope' = 'application_contained'
            then (target_scope ->> 'applicationRootId')::uuid else null end
        ) then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      if application_root_required
        and not vortex_access.organization_account_has_current_application_access_internal(
          (context_value ->> 'organizationId')::uuid,
          retained_target_record_id,
          (context_value ->> 'applicationRootId')::uuid
        ) then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
    end loop;

    execute pg_catalog.format(
      'update record_data.%I as stored
       set lifecycle_state = ''active'', concurrency_number = concurrency_number + 1,
         updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
         deleted_at = null, deleted_by = null, removal_due_at = null,
         definition_revision = $4
       where organisation_id = $1 and record_id = $2
         and lifecycle_state = ''soft_deleted'' and concurrency_number = $5',
      meta ->> 'table'
    ) using (context_value ->> 'organizationId')::uuid, p_record_id,
      (context_value ->> 'organizationAccountId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record restore revision changed';
    end if;
    app_scope := case when meta ->> 'storageScope' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end;
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, app_scope
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1
    );
  exception
    when serialization_failure or deadlock_detected then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    when no_data_found or too_many_rows or insufficient_privilege or check_violation
      or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end;
end
$function$;

alter function vortex_record.restore_record_internal(uuid, uuid, bigint)
  owner to vortex_record_adapter;

revoke all on function vortex_record.restore_record_internal(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.restore_record_internal(uuid, uuid, bigint) is
  'Private revision-checked restore primitive over retained facts, current Access, current definition, required relationships and every non-null Person link with required application access; it locks record or protected projection targets through the canonical relationship lock and enforces no recovery window.';
