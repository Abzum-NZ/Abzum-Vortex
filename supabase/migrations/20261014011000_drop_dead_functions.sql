-- Remove unwired APIs and their private state. File and connection read paths remain.
set local role vortex_owner;

drop policy download_grants_file_owner_delete on vortex_platform.download_grants;
drop policy download_grants_file_owner_insert on vortex_platform.download_grants;
drop policy download_grants_file_owner_read on vortex_platform.download_grants;
drop policy download_grants_file_owner_update on vortex_platform.download_grants;
drop policy file_records_file_owner_read on vortex_platform.file_records;
drop policy file_records_file_owner_update on vortex_platform.file_records;
drop policy upload_grants_file_owner_insert on vortex_platform.upload_grants;
drop policy upload_grants_file_owner_read on vortex_platform.upload_grants;
drop policy upload_grants_file_owner_update on vortex_platform.upload_grants;
drop policy upload_reservations_file_owner_read on vortex_platform.upload_reservations;
drop policy upload_reservations_file_owner_update on vortex_platform.upload_reservations;

-- Remove public entries before their private helpers.
drop function vortex_access.grant_record_share_for_administration(p_direct_share_id uuid, p_record_id uuid, p_recipient_kind text, p_organization_account_id uuid, p_group_id uuid, p_readable_field_ids uuid[], p_changeable_field_ids uuid[], p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_reason text, p_activity_id uuid, p_facts jsonb);
drop function vortex_access.revoke_record_share_for_administration(p_direct_share_id uuid, p_expected_revision bigint, p_reason text, p_activity_id uuid);
drop function vortex_platform.activate_uploaded_file(p_file_id uuid, p_expected_revision bigint, p_owner_record_type_id uuid, p_owner_record_id uuid, p_owner_field_id uuid, p_attachment_reference_id uuid, p_replacing_file_id uuid);
drop function vortex_platform.claim_file_upload_grant(p_one_time_id uuid);
drop function vortex_platform.grant_connection_application_for_administration(p_connection_instance_id uuid, p_application_root_id uuid, p_administrator_activity_id uuid);
drop function vortex_platform.read_file_upload(p_file_id uuid);
drop function vortex_platform.reauthorize_connection_instance_for_administration(p_connection_instance_id uuid, p_expected_revision bigint, p_administrator_activity_id uuid, p_destination_fingerprint text, p_token_expires_at timestamp with time zone);
drop function vortex_platform.record_connection_health_check_for_administration(p_connection_instance_id uuid, p_expected_revision bigint, p_new_health_outcome text, p_administrator_activity_id uuid);
drop function vortex_platform.record_file_upload_outcome(p_file_id uuid, p_expected_revision bigint, p_detected_media_type text, p_size_bytes bigint, p_checksum text, p_scanner_name text, p_scanner_version text, p_scanner_result text);
drop function vortex_platform.register_connection_instance_for_administration(p_connection_instance_id uuid, p_connection_type_id uuid, p_connection_type_version text, p_destination_key text, p_destination_fingerprint text, p_administrator_activity_id uuid, p_token_expires_at timestamp with time zone);
drop function vortex_platform.renew_file_upload(p_file_id uuid, p_expected_revision bigint, p_previous_one_time_id uuid, p_new_one_time_id uuid, p_policy_fingerprint text, p_grant_expires_at timestamp with time zone);
drop function vortex_platform.reserve_file_upload(p_file_id uuid, p_organization_id uuid, p_application_root_id uuid, p_owner_record_type_id uuid, p_owner_record_id uuid, p_owner_field_id uuid, p_original_safe_display_name text, p_extension text, p_storage_key text, p_uploaded_by jsonb, p_maximum_bytes bigint, p_max_files integer, p_existing_attachment_count integer, p_replacing_file_id uuid, p_capability_reservation_id uuid, p_one_time_id uuid, p_policy_fingerprint text, p_grant_expires_at timestamp with time zone, p_upload_expires_at timestamp with time zone);
drop function vortex_platform.revoke_connection_application_for_administration(p_connection_instance_id uuid, p_application_root_id uuid, p_administrator_activity_id uuid);
drop function vortex_platform.revoke_connection_instance_for_administration(p_connection_instance_id uuid, p_expected_revision bigint, p_administrator_activity_id uuid);
drop function vortex_record.claim_record_index_build(p_lease_seconds integer);
drop function vortex_record.read_application_index_status(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb);
drop function vortex_record.record_index_build_result(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_expected_definition_fingerprint text);
drop function vortex_record.renew_record_index_build_lease(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_lease_seconds integer);

-- Remove the remaining unused owner functions.
drop function vortex_access.coordinate_private_organization_group_membership_change(p_operation text, p_membership_id uuid, p_expected_membership_revision bigint, p_group_id uuid, p_organization_account_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_replacement_membership_id uuid, p_activity_id uuid);
drop function vortex_access.coordinate_private_organization_role_assignment_grant(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid);
drop function vortex_access.current_organization_access_version(p_tenant_id uuid, p_organization_id uuid);
drop function vortex_access.platform_permission_catalogue_revision_is_exact_v1_2_0(p_organization_id uuid, p_registration_revision bigint);
drop function vortex_access.platform_permission_catalogue_revision_is_exact_v1_3_0(p_organization_id uuid, p_registration_revision bigint);
drop function vortex_access.platform_permission_catalogue_revision_is_exact_v1_4_0(p_organization_id uuid, p_registration_revision bigint);
drop function vortex_access.read_organization_delegation_authority(p_organization_id uuid, p_delegation_authority_id uuid);
drop function vortex_access.read_organization_group(p_organization_id uuid, p_group_id uuid);
drop function vortex_access.read_organization_group_membership(p_organization_id uuid, p_membership_id uuid);
drop function vortex_access.read_organization_role_assignment(p_organization_id uuid, p_role_assignment_id uuid);
drop function vortex_access.validated_durable_system_request_context(p_operation_key text, p_flow_id uuid);
drop function vortex_definition.claim_organization_setup_source_manifest(p_tenant_id uuid, p_organization_id uuid, p_organization_account_id uuid, p_identity_id uuid, p_operation text, p_receipt_id uuid, p_command_fingerprint text, p_expected_setup_revision integer, p_manifest_canonical_text text, p_manifest_fingerprint text);
drop function vortex_definition.expire_private_form_drafts(p_limit integer);
drop function vortex_definition.read_consumer_release(p_kind text, p_root_id uuid, p_release_revision bigint);
drop function vortex_definition.repair_active_installation_runtime_bundle_internal(p_expected_identity jsonb, p_parts jsonb);
drop function vortex_identity.has_active_identity_organization_account_internal(p_identity_id uuid, p_organization_id uuid);
drop function vortex_identity.list_organization_accounts(p_identity_id uuid);
drop function vortex_identity.organization_and_tenant_are_active_internal(p_organization_id uuid);
drop function vortex_platform.append_connection_instance_activity_internal(p_context jsonb, p_activity_id uuid, p_connection_instance_id uuid, p_action text, p_occurred_at timestamp with time zone);
drop function vortex_platform.append_file_activity_internal(p_action text, p_subject_id uuid);
drop function vortex_platform.file_activity_id(p_action text, p_organization_id uuid, p_correlation_id uuid, p_subject_id uuid);
drop function vortex_platform.grant_connection_application_internal(p_connection_instance_id uuid, p_application_root_id uuid, p_administrator_activity_id uuid);
drop function vortex_platform.identity_authority_id(required boolean);
drop function vortex_platform.read_open_alert_signals(p_limit integer);
drop function vortex_platform.read_protected_workflow_run(p_run_id uuid);
drop function vortex_platform.reauthorize_connection_instance_internal(p_connection_instance_id uuid, p_expected_revision bigint, p_administrator_activity_id uuid, p_destination_fingerprint text, p_token_expires_at timestamp with time zone);
drop function vortex_platform.record_connection_health_check_internal(p_connection_instance_id uuid, p_expected_revision bigint, p_new_health_outcome text, p_administrator_activity_id uuid);
drop function vortex_platform.register_connection_instance_internal(p_connection_instance_id uuid, p_organization_id uuid, p_connection_type_id uuid, p_connection_type_version text, p_destination_key text, p_destination_fingerprint text, p_administrator_activity_id uuid, p_token_expires_at timestamp with time zone);
drop function vortex_platform.revoke_connection_application_internal(p_connection_instance_id uuid, p_application_root_id uuid, p_administrator_activity_id uuid);
drop function vortex_platform.revoke_connection_instance_internal(p_connection_instance_id uuid, p_expected_revision bigint, p_administrator_activity_id uuid);
drop function vortex_record.index_build_statements_internal(p_index_contract_id uuid);
drop function vortex_record.preview_record_lifecycle_candidates(p_storage_contract_id uuid, p_application_root_id uuid, p_after_created_at timestamp with time zone, p_after_record_id uuid, p_limit integer);

drop table vortex_platform.upload_grants;
drop table vortex_platform.upload_reservations;

alter table vortex_record.index_catalogue
  drop column claim_id,
  drop column claimed_by,
  drop column claimed_at,
  drop column lease_expires_at;

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
      changed_at = pg_catalog.statement_timestamp()
    where vortex_record.index_catalogue.purpose is distinct from excluded.purpose
      or vortex_record.index_catalogue.sort_shape is distinct from excluded.sort_shape
      or vortex_record.index_catalogue.desired_definition_fingerprint
        is distinct from excluded.desired_definition_fingerprint
      or vortex_record.index_catalogue.observed_state is distinct from excluded.observed_state;
  end loop;

  update vortex_record.index_catalogue as catalogue
  set purpose = 'published_sort_drop', observed_state = 'missing',
    observed_revision = catalogue.observed_revision + 1,
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

-- Restricted record functions retain their original owner.
set local role vortex_record_adapter;
drop function vortex_record.prepare_protected_record_restore(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_activity_id uuid);
drop function vortex_record.read_import_update_targets(p_record_type_id uuid, p_mapped_field_ids jsonb, p_targets jsonb);

reset role;
