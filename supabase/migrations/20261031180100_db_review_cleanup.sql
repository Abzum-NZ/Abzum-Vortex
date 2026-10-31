-- Database review cleanup (FIX-DB-SECURITY, review findings DF-1 to DF-7, DF-11, DF-12 to DF-16,
-- DT-2, DT-17, P-2 and T-45). Privileges, drops and one function body; no data changes.
--
-- Functions nothing reaches: the unused readers and wrappers of DF-1 to DF-7, the SQL halves of the
-- TypeScript services review P-2 deletes (record share grants, Vortex super-administrator
-- administration, identity disablement, tenant-governance reads and administrator changes, record
-- lifecycle policy saves, the connection administration list), and the whole offboarding ownership
-- transfer and account-deletion path, which has no caller (DF-11: the record writers beside
-- apply_record_changes that remain are the derived-field backfill and the preview copy and reconcile).

-- DF-14 / DT-17: pgTAP is unused (no tests are written or run).
drop extension pgtap;

-- The one postgres-owned function on the list (it deleted GoTrue sessions for identity disablement).
-- guard-allow: migration-owner-role The integration function is owned by postgres and must be dropped by its owner.
drop function vortex_identity.complete_identity_disablement(p_command_id uuid, p_correlation_id uuid, p_outcome text);

-- The inventory role owns this reader but holds no USAGE on its schema, so it is lent USAGE for the
-- drop only (as the baseline lent it CREATE to create its functions).
set role vortex_owner;
grant usage on schema vortex_record to vortex_record_inventory;
set role vortex_record_inventory;
drop function vortex_record.account_retains_owned_records_internal(p_organization_account_id uuid);
set role vortex_owner;
revoke usage on schema vortex_record from vortex_record_inventory;

set role vortex_record_adapter;
drop function vortex_record.apply_lifecycle_record_changes_internal(p_operation text, p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_mutations jsonb, p_activity_id uuid, p_occurrence_id uuid);
drop function vortex_record.apply_lifecycle_record_changes(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_mutations jsonb, p_activity_id uuid, p_occurrence_id uuid);
drop function vortex_record.apply_record_mutations_internal(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_mutations jsonb, p_activity_id uuid, p_occurrence_id uuid);
drop function vortex_record.command_receipt_exists_internal(p_command_kind text, p_command_id uuid);
drop function vortex_record.finalize_account_deletion_fence(p_organization_account_id uuid);
drop function vortex_record.list_offboarding_owned_records_internal(p_source_organization_account_id uuid, p_target_kind text, p_target_id uuid, p_after_storage_contract_id uuid, p_after_record_id uuid, p_limit integer);
drop function vortex_record.list_offboarding_owned_records(p_source_organization_account_id uuid, p_target_kind text, p_target_id uuid, p_section_kind text, p_after_storage_contract_id uuid, p_after_record_id uuid, p_limit integer);
drop function vortex_record.list_offboarding_owned_shared_records_internal(p_source_organization_account_id uuid, p_target_kind text, p_target_id uuid, p_after_storage_contract_id uuid, p_after_record_id uuid, p_limit integer);
drop function vortex_record.load_offboarding_ownership_transfer_facts_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint);
drop function vortex_record.load_record_access_facts_for_transfer_installation_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_installation jsonb);
drop function vortex_record.read_command_receipt_by_receipt_id_internal(p_command_kind text, p_receipt_id uuid);
drop function vortex_record.transfer_offboarding_active_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_expected_access_version bigint);
drop function vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint);
drop function vortex_record.transfer_record_ownership_for_offboarding_internal(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid);
drop function vortex_record.write_relationship_value_internal(p_source_record_type_id uuid, p_source_record_id uuid, p_relationship_id uuid, p_target_value jsonb, p_increment_source_revision boolean);

-- DF-12: a policy whose roles all bypass row level security never applies.
drop policy installation_access_plans_module_bundle_cleanup on vortex_record.installation_access_plans;

set role vortex_owner;
drop function vortex_access.check_record_share_grant_terms_internal(p_terms jsonb, p_context jsonb);
drop function vortex_access.get_record_share_grant_for_administration(p_grant_id uuid);
drop function vortex_access.list_organization_account_choices(p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid);
drop function vortex_access.lock_active_record_ownership_target_internal(p_kind text, p_target_id uuid);
drop function vortex_access.lock_human_request_access_version_internal();
drop function vortex_access.lock_record_lifecycle_policy_authority();
drop function vortex_access.organization_accounts_offboarding_inventory_scope_internal();
drop function vortex_access.propose_record_share_grant_for_administration(p_grant_id uuid, p_consent_request_id uuid, p_terms jsonb, p_activity_id uuid);
drop function vortex_access.read_available_permission(p_organization_id uuid, p_application_root_id uuid, p_owner_kind text, p_owner_id uuid, p_permission_id uuid);
drop function vortex_access.record_share_grant_consent_decision_for_administration(p_decision_id uuid, p_request_id uuid, p_expected_revision bigint, p_decision text, p_note text, p_activity_id uuid);
drop function vortex_access.record_share_grant_consent_role_path_internal(p_organization_id uuid, p_organization_account_id uuid, p_application_root_id uuid, p_authorized_role_ids uuid[], p_checked_at timestamp with time zone, p_context_expires_at timestamp with time zone);
drop function vortex_access.record_share_grant_json_internal(p_grant_id uuid);
drop function vortex_access.record_share_grant_source_authority_internal(p_context jsonb, p_module_root_id uuid, p_record_type_id uuid);
drop function vortex_access.record_share_grant_uuid_array_internal(p_value jsonb, p_minimum integer, p_maximum integer);
drop function vortex_access.resolve_system_actor_grant_internal(p_system_actor_id uuid, p_operation_key text, p_organization_id uuid, p_flow_id uuid, p_scope_key text);
drop function vortex_access.revise_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_terms jsonb, p_activity_id uuid);
drop function vortex_access.withdraw_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_reason text, p_activity_id uuid);
drop function vortex_definition.read_active_shared_record_consumers_internal(p_module_root_id uuid, p_record_type_id uuid, p_storage_contract_id uuid);
drop function vortex_definition.read_current_detached_installation_for_transfer_internal();
drop function vortex_definition.read_current_offboarding_inventory_installation_internal();
drop function vortex_definition.read_offboarding_inventory_contract_applications_internal(p_storage_contract_id uuid);
drop function vortex_definition.record_lifecycle_target_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid);
drop function vortex_identity.archive_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint);
drop function vortex_identity.begin_identity_disablement(p_actor_identity_id uuid, p_subject_identity_id uuid, p_command_id uuid, p_correlation_id uuid);
drop function vortex_identity.change_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone);
drop function vortex_identity.finalize_organization_account_deletion(p_organization_account_id uuid, p_expected_revision bigint);
drop function vortex_identity.grant_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_subject_identity_id uuid, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone);
drop function vortex_identity.grant_vortex_super_administrator(p_duplicate_key uuid, p_identity_id uuid);
drop function vortex_identity.list_organization_account_choices_internal(p_tenant_id uuid, p_organization_id uuid, p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid);
drop function vortex_identity.list_tenant_administrator_assignments(p_tenant_id uuid, p_limit integer, p_after uuid);
drop function vortex_identity.list_tenant_hierarchy(p_tenant_id uuid, p_limit integer, p_after uuid);
drop function vortex_identity.list_tenant_launcher(p_limit integer, p_after uuid);
drop function vortex_identity.list_vortex_super_administrator_assignments(p_limit integer, p_after uuid);
drop function vortex_identity.lock_organization_account_for_deletion_internal(p_organization_account_id uuid);
drop function vortex_identity.publish_identity_disablement(p_subject_identity_id uuid, p_actor_identity_id uuid, p_correlation_id uuid, p_published_at timestamp with time zone);
drop function vortex_identity.read_tenant_organization(p_tenant_id uuid, p_organization_id uuid);
drop function vortex_identity.revoke_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint);
drop function vortex_identity.revoke_vortex_super_administrator(p_duplicate_key uuid, p_assignment_id uuid, p_expected_revision bigint);
drop function vortex_identity.tenant_administrator_grant_expiry_cap(p_actor_identity_id uuid, p_tenant_id uuid, p_capabilities text[], p_evaluated_at timestamp with time zone);
drop function vortex_identity.tenant_capabilities_from_json(p_capabilities jsonb);
drop function vortex_platform.append_detached_offboarding_reassignment_internal(p_storage_contract_id uuid, p_record_id uuid, p_record_type_id uuid, p_occurrence_id uuid);
drop function vortex_platform.list_connection_instances_for_administration(p_organization_id uuid, p_after_connection_instance_id uuid, p_page_size integer);
drop function vortex_platform.read_versioned_file_metadata(p_file_id uuid);
drop function vortex_record.save_record_type_lifecycle_policy_for_administration(p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_expected_policy_revision bigint, p_activity_id uuid, p_policy jsonb);

-- DF-12: policies for vortex_owner and postgres, which both have BYPASSRLS, never apply. Every
-- table keeps row level security enabled and forced, so a grant to any other role is denied unless
-- a policy for that role says otherwise; isolation for vortex_owner code lives in function bodies.
drop policy permission_catalogue_entries_access_owner_select on vortex_access.permission_catalogue_entries;
drop policy form_drafts_page_owner_delete on vortex_definition.form_drafts;
drop policy form_drafts_page_owner_insert on vortex_definition.form_drafts;
drop policy form_drafts_page_owner_select on vortex_definition.form_drafts;
drop policy form_drafts_page_owner_update on vortex_definition.form_drafts;
drop policy organization_delegation_authorities_access_owner_select on vortex_access.organization_delegation_authorities;
drop policy organization_direct_record_shares_access_owner_select on vortex_access.organization_direct_record_shares;
drop policy organization_group_memberships_access_owner_select on vortex_access.organization_group_memberships;
drop policy organization_groups_access_owner_select on vortex_access.organization_groups;
drop policy organization_role_activations_access_owner_select on vortex_access.organization_role_activations;
drop policy organization_role_assignments_access_owner_select on vortex_access.organization_role_assignments;
drop policy organization_role_permission_entries_access_owner_select on vortex_access.organization_role_permission_entries;
drop policy organization_role_revisions_access_owner_select on vortex_access.organization_role_revisions;
drop policy organization_roles_access_owner_select on vortex_access.organization_roles;
drop policy permission_continuities_access_owner_select on vortex_access.permission_continuities;
drop policy permission_registration_revisions_access_owner_select on vortex_access.permission_registration_revisions;
drop policy permission_registrations_access_owner_select on vortex_access.permission_registrations;
drop policy validation_reference_values_access_owner_select on vortex_access.validation_reference_values;
drop policy organization_activity_entries_activity_owner_select on vortex_record.organization_activity_entries;
drop policy organization_activity_super_administrator_authority_activity_ow on vortex_record.organization_activity_super_administrator_authority;
drop policy connection_application_grants_owner_delete on vortex_platform.connection_application_grants;
drop policy connection_application_grants_owner_select on vortex_platform.connection_application_grants;
drop policy connection_application_grants_owner_update on vortex_platform.connection_application_grants;
drop policy connection_instances_owner_insert on vortex_platform.connection_instances;
drop policy connection_instances_owner_select on vortex_platform.connection_instances;
drop policy connection_instances_owner_update on vortex_platform.connection_instances;
drop policy module_preview_draft_revision_lock on vortex_definition.drafts;
drop policy module_preview_draft_revision_read on vortex_definition.drafts;
drop policy module_installation_definition_dependencies_read on vortex_definition.release_dependencies;
drop policy record_storage_definition_dependencies_read on vortex_definition.release_dependencies;
drop policy module_installation_definition_releases_read on vortex_definition.releases;
drop policy record_storage_definition_releases_read on vortex_definition.releases;
drop policy releases_owner_select on vortex_definition.releases;
drop policy module_installation_definition_roots_read on vortex_definition.roots;
drop policy record_storage_definition_roots_read on vortex_definition.roots;
drop policy roots_owner_select on vortex_definition.roots;
drop policy source_identities_human_application_role_select on vortex_definition.source_identities;
drop policy consumer_occurrence_progress_event_owner_insert on vortex_platform.consumer_occurrence_progress;
drop policy consumer_occurrence_progress_event_owner_select on vortex_platform.consumer_occurrence_progress;
drop policy consumer_occurrence_progress_event_owner_update on vortex_platform.consumer_occurrence_progress;
drop policy event_outbox_event_owner_select on vortex_platform.event_outbox;
drop policy identity_owner_disablement_commands_select on vortex_identity.identity_disablement_commands;
drop policy identity_owner_1461_identity_projections_select on vortex_identity.identity_projections;
drop policy identity_owner_projections_insert on vortex_identity.identity_projections;
drop policy identity_owner_projections_select on vortex_identity.identity_projections;
drop policy identity_owner_projections_update on vortex_identity.identity_projections;
drop policy identity_owner_accounts_insert on vortex_identity.organization_accounts;
drop policy identity_owner_accounts_select on vortex_identity.organization_accounts;
drop policy identity_owner_accounts_update on vortex_identity.organization_accounts;
drop policy identity_owner_invitations_insert on vortex_identity.organization_invitations;
drop policy identity_owner_invitations_select on vortex_identity.organization_invitations;
drop policy identity_owner_invitations_update on vortex_identity.organization_invitations;
drop policy identity_owner_runtime_settings_insert on vortex_identity.organization_runtime_settings;
drop policy identity_owner_runtime_settings_select on vortex_identity.organization_runtime_settings;
drop policy identity_owner_runtime_settings_update on vortex_identity.organization_runtime_settings;
drop policy identity_owner_1461_organizations_select on vortex_identity.organizations;
drop policy identity_owner_organizations_select on vortex_identity.organizations;
drop policy identity_owner_organizations_update on vortex_identity.organizations;
drop policy identity_owner_1461_tenant_administrator_assignments_select on vortex_identity.tenant_administrator_assignments;
drop policy identity_owner_1461_tenants_select on vortex_identity.tenants;
drop policy identity_owner_tenants_select on vortex_identity.tenants;
drop policy installation_bindings_owner on vortex_definition.installation_bindings;
drop policy installation_runtime_bundle_parts_owner on vortex_definition.installation_runtime_bundle_parts;
drop policy installation_runtime_bundles_owner on vortex_definition.installation_runtime_bundles;
drop policy preview_installations_owner on vortex_definition.preview_installations;
drop policy alert_signals_operations_owner_insert on vortex_platform.alert_signals;
drop policy alert_signals_operations_owner_select on vortex_platform.alert_signals;
drop policy alert_signals_operations_owner_update on vortex_platform.alert_signals;
drop policy field_storage_mappings_owner on vortex_record.field_storage_mappings;
drop policy index_catalogue_owner on vortex_record.index_catalogue;
drop policy organization_lifecycle_limits_owner on vortex_record.organization_lifecycle_limits;
drop policy preview_storage_bindings_owner on vortex_record.preview_storage_bindings;
drop policy protected_read_model_views_owner on vortex_record.protected_read_model_views;
drop policy protected_read_model_views_projection_lock_postgres_select on vortex_record.protected_read_model_views;
drop policy record_reference_counters_owner on vortex_record.record_reference_counters;
drop policy record_type_lifecycle_policies_owner on vortex_record.record_type_lifecycle_policies;
drop policy relationship_edges_owner on vortex_record.relationship_edges;
drop policy relationship_storage_mappings_owner on vortex_record.relationship_storage_mappings;
drop policy release_provisions_owner on vortex_record.release_provisions;
drop policy storage_catalogue_owner on vortex_record.storage_catalogue;
drop policy documents_search_owner_insert on vortex_record.documents;
drop policy documents_search_owner_select on vortex_record.documents;
drop policy documents_search_owner_update on vortex_record.documents;
drop policy flow_effect_ledger_vortex_workflow_owner_insert on vortex_platform.flow_effect_ledger;
drop policy flow_effect_ledger_vortex_workflow_owner_select on vortex_platform.flow_effect_ledger;
drop policy flow_effect_ledger_vortex_workflow_owner_update on vortex_platform.flow_effect_ledger;
drop policy preview_releases_owner on vortex_definition.preview_releases;
drop policy preview_permission_registrations_owner on vortex_access.preview_permission_registrations;
drop policy preview_permission_entries_owner on vortex_access.preview_permission_entries;
drop policy storage_destination_operations on vortex_platform.storage_destination;
drop policy file_uploads_operations on vortex_platform.file_uploads;
drop policy grid_views_owner_operations on vortex_platform.grid_views;
drop policy preview_installation_seeds_owner on vortex_definition.preview_installation_seeds;

-- DF-13: the nine tables that had row level security off or not forced.
alter table vortex_access.flow_run_evidence enable row level security, force row level security;
alter table vortex_access.flow_segment_rate_buckets enable row level security, force row level security;
alter table vortex_access.flow_segment_rate_defaults enable row level security, force row level security;
alter table vortex_access.platform_permission_declarations enable row level security, force row level security;
alter table vortex_access.validation_reference_values enable row level security, force row level security;
alter table vortex_platform.backend_runs enable row level security, force row level security;
alter table vortex_platform.connection_execution_tickets enable row level security, force row level security;
alter table vortex_platform.connection_secret_references enable row level security, force row level security;
alter table vortex_platform.flow_effect_ledger enable row level security, force row level security;

-- DF-15: these functions are reached only through security-definer callers, so the login roles do
-- not need EXECUTE. (vortex_platform.validated is revoked by its full definition below.)
revoke execute on function vortex_record.complete_flow_segment_receipt(uuid, jsonb) from vortex_request;
revoke execute on function vortex_platform.record_flow_segment_effect(uuid, text, text, text, jsonb) from vortex_request;
revoke execute on function vortex_platform.change_topic(uuid, uuid) from vortex_request, vortex_runtime;
revoke execute on function vortex_platform.topic_organization_id(text) from vortex_request, vortex_runtime;
revoke execute on function vortex_platform.topic_application_root_id(text) from vortex_request, vortex_runtime;

-- DF-16: EXECUTE for postgres left from the former owner; postgres reaches them through its
-- vortex_owner membership, and no canonical file grants it.
revoke execute on function vortex_definition.is_current_application_address_release(bigint) from postgres;
revoke execute on function vortex_definition.read_first_install_application_release_set(uuid, bigint) from postgres;
revoke execute on function vortex_definition.read_release_for_restore(text, uuid, bigint) from postgres;
revoke execute on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) from postgres;
revoke execute on function vortex_definition.append_application_installation_activity_internal(uuid, uuid, text) from postgres;
revoke execute on function vortex_access.organization_has_permanent_steward(uuid, timestamptz) from postgres;
revoke execute on function vortex_access.lock_organization_runtime_settings_record_for_event_internal(uuid) from postgres;
revoke execute on function vortex_identity.assert_organization_runtime_settings_values(text, text, text, text, text) from postgres;
revoke execute on function vortex_platform.alert_signal_namespaced_key_is_valid(text) from postgres;
revoke execute on function vortex_platform.alert_signal_builder_key_is_valid(text) from postgres;
revoke execute on function vortex_record.enforce_document_application_root() from postgres;

-- T-45: the authentication strength is single_factor or multi_factor; recent_multi_factor is gone.
create or replace function vortex_platform.validated(candidate jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  caller_kind text;
  authentication_strength text;
  issued_at timestamptz;
  expires_at timestamptz;
  access_token_issued_at timestamptz;
  primary_authenticated_at timestamptz;
  multi_factor_authenticated_at timestamptz;
  allowed_keys text[];
  nested jsonb;
begin
  if candidate is null or pg_catalog.jsonb_typeof(candidate) <> 'object' then
    raise exception using errcode = '22023', message = 'Vortex request context must be an object';
  end if;

  if not candidate ?& array[
    'callerKind', 'tenantId', 'organizationId', 'sessionId', 'issuedAt',
    'expiresAt', 'accessVersion', 'correlationId', 'authenticationStrength'
  ] then
    raise exception using errcode = '22023', message = 'Vortex request context is incomplete';
  end if;

  caller_kind := candidate ->> 'callerKind';
  authentication_strength := candidate ->> 'authenticationStrength';

  case caller_kind
    when 'human' then
      allowed_keys := array[
        'callerKind', 'identityAuthorityId', 'tenantId', 'organizationId',
        'applicationRootId', 'sessionId', 'issuedAt', 'expiresAt',
        'accessVersion', 'correlationId', 'identityId', 'organizationAccountId',
        'authenticationStrength', 'accessTokenIssuedAt', 'primaryAuthenticatedAt',
        'multiFactorAuthenticatedAt', 'delegatedContext', 'supportContext',
        'channel'
      ];
      if not candidate ? 'identityAuthorityId'
        or not vortex_platform.is_non_nil_uuid(candidate ->> 'identityAuthorityId') then
        raise exception using errcode = '22023', message = 'Authenticated request context requires an Identity Authority';
      end if;
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex human context has an invalid actor';
      end if;
    when 'federated' then
      allowed_keys := array[
        'callerKind', 'identityAuthorityId', 'tenantId', 'organizationId',
        'applicationRootId', 'sessionId', 'issuedAt', 'expiresAt',
        'accessVersion', 'correlationId', 'identityId', 'organizationAccountId',
        'authenticationStrength', 'channel'
      ];
      if not candidate ? 'identityAuthorityId'
        or not vortex_platform.is_non_nil_uuid(candidate ->> 'identityAuthorityId') then
        raise exception using errcode = '22023', message = 'Authenticated request context requires an Identity Authority';
      end if;
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex federated context has an invalid actor';
      end if;
    when 'system' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId',
        'sessionId', 'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'systemActorId', 'authenticationStrength', 'supportContext', 'channel'
      ];
      if not candidate ? 'systemActorId' or authentication_strength is distinct from 'service' then
        raise exception using errcode = '22023', message = 'Vortex system context has an invalid actor';
      end if;
    when 'public' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId',
        'sessionId', 'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'authenticationStrength', 'channel'
      ];
      if authentication_strength is distinct from 'anonymous' then
        raise exception using errcode = '22023', message = 'Vortex public context has an invalid actor';
      end if;
    else
      raise exception using errcode = '22023', message = 'Vortex request context has an unsupported caller kind';
  end case;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(candidate) as supplied(key)
    where not supplied.key = any (allowed_keys)
  ) then
    raise exception using errcode = '22023', message = 'Vortex request context has an unknown field';
  end if;

  if candidate ? 'channel'
    and (
      pg_catalog.jsonb_typeof(candidate -> 'channel') <> 'string'
      or (candidate ->> 'channel') <> all (array[
        'web', 'webmcp', 'programmatic_interface', 'connection', 'federation',
        'system'
      ])
    ) then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid channel';
  end if;

  if not vortex_platform.is_non_nil_uuid(candidate ->> 'tenantId')
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'organizationId')
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'sessionId')
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'correlationId')
    or (candidate ? 'applicationRootId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'applicationRootId'))
    or (candidate ? 'identityId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'identityId'))
    or (candidate ? 'organizationAccountId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'organizationAccountId'))
    or (candidate ? 'systemActorId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'systemActorId')) then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid identifier';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'accessVersion') <> 'number'
    or (candidate ->> 'accessVersion') !~ '^[1-9][0-9]*$'
    or (candidate ->> 'accessVersion')::numeric > 9007199254740991 then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid access version';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'issuedAt') <> 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'expiresAt') <> 'string'
    or (candidate ->> 'issuedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
    or (candidate ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid time';
  end if;

  begin
    issued_at := (candidate ->> 'issuedAt')::timestamptz;
    expires_at := (candidate ->> 'expiresAt')::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid time';
  end;

  if not pg_catalog.isfinite(issued_at)
    or not pg_catalog.isfinite(expires_at)
    or expires_at <= issued_at
    or expires_at <= pg_catalog.statement_timestamp() then
    raise exception using errcode = '22023', message = 'Vortex request context is expired or inconsistent';
  end if;

  if caller_kind = 'human' then
    if (candidate ? 'accessTokenIssuedAt')
      <> (candidate ? 'primaryAuthenticatedAt' or candidate ? 'multiFactorAuthenticatedAt') then
      raise exception using errcode = '22023', message = 'Vortex human authentication evidence is incomplete';
    end if;

    if candidate ? 'accessTokenIssuedAt' then
      if pg_catalog.jsonb_typeof(candidate -> 'accessTokenIssuedAt') <> 'string'
        or (candidate ->> 'accessTokenIssuedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        access_token_issued_at := (candidate ->> 'accessTokenIssuedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(access_token_issued_at)
        or access_token_issued_at >= expires_at
        or access_token_issued_at > issued_at + interval '60 seconds' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;

    if candidate ? 'primaryAuthenticatedAt' then
      if pg_catalog.jsonb_typeof(candidate -> 'primaryAuthenticatedAt') <> 'string'
        or (candidate ->> 'primaryAuthenticatedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        primary_authenticated_at := (candidate ->> 'primaryAuthenticatedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(primary_authenticated_at)
        or primary_authenticated_at > access_token_issued_at
        or primary_authenticated_at > pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;

    if candidate ? 'multiFactorAuthenticatedAt' then
      if authentication_strength <> 'multi_factor' then
        raise exception using errcode = '22023', message = 'Vortex human multi-factor evidence conflicts with authentication strength';
      end if;
      if pg_catalog.jsonb_typeof(candidate -> 'multiFactorAuthenticatedAt') <> 'string'
        or (candidate ->> 'multiFactorAuthenticatedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        multi_factor_authenticated_at := (candidate ->> 'multiFactorAuthenticatedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(multi_factor_authenticated_at)
        or multi_factor_authenticated_at > access_token_issued_at
        or multi_factor_authenticated_at > pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;
  end if;

  if candidate ? 'delegatedContext' then
    nested := candidate -> 'delegatedContext';
    if pg_catalog.jsonb_typeof(nested) <> 'object'
      or not nested ?& array['delegatedByOrganizationAccountId', 'reason', 'expiresAt']
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(nested) as supplied(key)
        where supplied.key <> all (array['delegatedByOrganizationAccountId', 'reason', 'expiresAt'])
      )
      or not vortex_platform.is_non_nil_uuid(nested ->> 'delegatedByOrganizationAccountId')
      or pg_catalog.jsonb_typeof(nested -> 'reason') <> 'string'
      or pg_catalog.length(nested ->> 'reason') not between 1 and 500 then
      raise exception using errcode = '22023', message = 'Vortex delegated context is invalid';
    end if;
    if pg_catalog.jsonb_typeof(nested -> 'expiresAt') <> 'string'
      or (nested ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
      raise exception using errcode = '22023', message = 'Vortex delegated context has an invalid time';
    end if;
    begin
      if not pg_catalog.isfinite((nested ->> 'expiresAt')::timestamptz)
        or (nested ->> 'expiresAt')::timestamptz > expires_at
        or (nested ->> 'expiresAt')::timestamptz <= pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex delegated context is expired or inconsistent';
      end if;
    exception when invalid_datetime_format then
      raise exception using errcode = '22023', message = 'Vortex delegated context has an invalid time';
    end;
  end if;

  if candidate ? 'supportContext' then
    nested := candidate -> 'supportContext';
    if pg_catalog.jsonb_typeof(nested) <> 'object'
      or not nested ?& array['supportActorId', 'approvedByOrganizationAccountId', 'reason', 'expiresAt']
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(nested) as supplied(key)
        where supplied.key <> all (array['supportActorId', 'approvedByOrganizationAccountId', 'reason', 'expiresAt'])
      )
      or not vortex_platform.is_non_nil_uuid(nested ->> 'supportActorId')
      or not vortex_platform.is_non_nil_uuid(nested ->> 'approvedByOrganizationAccountId')
      or pg_catalog.jsonb_typeof(nested -> 'reason') <> 'string'
      or pg_catalog.length(nested ->> 'reason') not between 1 and 500 then
      raise exception using errcode = '22023', message = 'Vortex support context is invalid';
    end if;
    if pg_catalog.jsonb_typeof(nested -> 'expiresAt') <> 'string'
      or (nested ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
      raise exception using errcode = '22023', message = 'Vortex support context has an invalid time';
    end if;
    begin
      if not pg_catalog.isfinite((nested ->> 'expiresAt')::timestamptz)
        or (nested ->> 'expiresAt')::timestamptz > expires_at
        or (nested ->> 'expiresAt')::timestamptz <= pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex support context is expired or inconsistent';
      end if;
    exception when invalid_datetime_format then
      raise exception using errcode = '22023', message = 'Vortex support context has an invalid time';
    end;
  end if;

  return candidate;
end
$function$;

revoke execute on function vortex_platform.validated(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_platform.validated(jsonb) is
  'Validates one trusted request context, including its optional trusted channel, or fails closed.';

alter function vortex_platform.validated(candidate jsonb) owner to vortex_owner;

grant execute on function vortex_platform.validated(candidate jsonb) to postgres;

reset role;
