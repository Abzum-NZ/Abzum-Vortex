set local role vortex_owner;

-- Transferring existing postgres-owned objects requires the current postgres owner.
reset role;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.application_role_template_continuities owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.capability_limit_changes owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.capability_policy_assignments owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.capability_policy_definitions owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.capability_reservation_balances owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.capability_reservations owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.flow_execution_bindings owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.flow_run_as_principals owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.metering_events owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.organization_access_versions owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.organization_delegation_authorities owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.organization_direct_record_shares owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.organization_group_memberships owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.organization_groups owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.organization_role_activation_policy_revisions owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.organization_role_activations owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.organization_role_assignments owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.organization_role_permission_entries owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.organization_roles owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.organization_stewardship_requirements owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.permission_catalogue_entries owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.permission_continuities owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.record_share_grant_consent_decisions owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.record_share_grant_consent_requests owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.record_share_grants owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.system_actor_grants owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.usage_projection_reconciliation owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.usage_projection_rollups owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_access.validation_reference_values owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_definition.drafts owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_definition.form_drafts owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_definition.organization_setup_source_manifests owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_definition.release_dependencies owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_definition.releases owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_definition.roots owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_definition.source_identities owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_definition.source_identity_aliases owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_identity.identity_disablement_commands owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_identity.identity_disablement_events owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_identity.identity_projections owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_identity.organization_accounts owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_identity.organization_invitations owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_identity.organization_runtime_settings owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_identity.organizations owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_identity.tenant_administrator_assignments owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_identity.tenants owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_identity.vortex_super_administrator_assignments owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.alert_signals owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.connection_application_grants owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.connection_instances owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.consumer_occurrence_progress owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.download_grants owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.event_outbox owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.file_records owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.flow_continuations owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.flow_effect_ledger owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.flow_registrations owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.flow_start_intents owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.protected_workflow_runs owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.request_contexts owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.upload_grants owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_platform.upload_reservations owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_record.documents owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_record.organization_activity_entries owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter table vortex_record.organization_activity_super_administrator_authority owner to vortex_owner;
-- identity_disablement_events_event_id_seq follows its table ownership automatically.
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.accept_organization_invitation(p_token_fingerprint text, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.add_organization_group_membership_for_administration(p_membership_id uuid, p_group_id uuid, p_organization_account_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.adopt_builder_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.adopt_connection_administration_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.adopt_security_and_support_operator_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.adopt_shipped_platform_permission_catalogue(p_organization_id uuid, p_expected_registration_revision bigint, p_target_catalogue_version text, p_target_catalogue_fingerprint text, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.application_access_current_state_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_prepared_templates jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.appoint_organization_steward_for_administration(p_organization_account_id uuid, p_expected_account_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.assert_organization_has_permanent_steward(p_organization_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.assign_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.begin_organization_account_closing_for_administration(p_organization_account_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.begin_protected_node_effect(p_run_id uuid, p_organization_id uuid, p_identity_id uuid, p_task_path text, p_iteration text, p_operation_key text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.capability_limit_bounds_internal(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_evaluated_at timestamp with time zone, p_lock boolean) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.capability_policy_key_is_valid(p_key text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.capability_policy_quantity_is_valid(p_quantity numeric) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.capability_policy_unit_is_valid(p_unit text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.capability_reservation_request_context(p_tenant_id uuid, p_organization_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.change_account_state_without_stewardship_v1_internal(p_organization_account_id uuid, p_expected_revision bigint, p_state text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.change_application_installation_access(p_activity_id uuid, p_application_root_id uuid, p_change text, p_prepared_templates jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.change_organization_role_authority_for_administration(p_prepared_evidence jsonb, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.check_record_lifecycle_preview_authority() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.check_record_share_grant_terms_internal(p_terms jsonb, p_context jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.close_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.complete_protected_node_effect(p_run_id uuid, p_organization_id uuid, p_identity_id uuid, p_task_path text, p_iteration text, p_outcome text, p_outputs jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_application_access_without_stewardship_v1_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_assignment_change_without_stewardship_v1_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_organization_group_change(p_operation text, p_organization_id uuid, p_group_id uuid, p_expected_group_revision bigint, p_group_key text, p_label text, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_organization_group_membership_change(p_operation text, p_organization_id uuid, p_membership_id uuid, p_expected_membership_revision bigint, p_group_id uuid, p_organization_account_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_replacement_membership_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_organization_role_activation_change(p_operation text, p_organization_id uuid, p_role_activation_id uuid, p_expected_activation_revision bigint, p_organization_account_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_requested_duration_seconds bigint, p_eligibility_source_kind text, p_role_assignment_id uuid, p_expected_role_assignment_revision bigint, p_membership_id uuid, p_expected_membership_revision bigint, p_changed_by uuid, p_correlation_id uuid, p_invoking_execution_binding_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_private_organization_group_membership_change(p_operation text, p_membership_id uuid, p_expected_membership_revision bigint, p_group_id uuid, p_organization_account_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_replacement_membership_id uuid, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_private_organization_role_assignment_grant(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.coordinate_private_organization_role_authority_change(p_prepared_evidence jsonb, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.create_organization_group_for_administration(p_group_id uuid, p_group_key text, p_label text, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.current_organization_access_version(p_tenant_id uuid, p_organization_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.deactivate_organization_role_activation_for_administration(p_role_activation_id uuid, p_expected_activation_revision bigint, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.derive_usage_projection(p_tenant_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.evaluate_current_record_ownership_visibility(p_permission_record_scope jsonb, p_ownership_mode text, p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_scope jsonb, p_owner_organization_account_id uuid, p_owner_group_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.evaluate_organization_record_access_internal(p_declaration jsonb, p_target_record_id uuid, p_facts jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.evaluate_query_condition_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.evaluate_record_permission_row_scope_internal(p_context jsonb, p_checked_at timestamp with time zone, p_auth_deadline timestamp with time zone, p_application_root_id uuid, p_action jsonb, p_candidate jsonb, p_record_id uuid, p_facts jsonb, p_path uuid[]) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.evaluate_typed_condition_node_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.expire_stale_capability_reservations(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.fence_record_owner_account_target_internal() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.flow_execution_binding_authority_internal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_organization_id uuid, p_mode text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.flow_execution_binding_to_json_internal(b vortex_access.flow_execution_bindings) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.flow_run_as_principal_to_json_internal(p_principal vortex_access.flow_run_as_principals) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.get_record_share_grant_for_administration(p_grant_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.grant_organization_direct_record_share(p_organization_id uuid, p_direct_share_id uuid, p_storage_scope text, p_application_root_id uuid, p_module_root_id uuid, p_record_type_id uuid, p_storage_contract_id uuid, p_record_id uuid, p_recipient_kind text, p_organization_account_id uuid, p_group_id uuid, p_readable_field_ids uuid[], p_changeable_field_ids uuid[], p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_reason text, p_changed_by uuid, p_correlation_id uuid, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.grant_record_share_for_administration(p_direct_share_id uuid, p_record_id uuid, p_recipient_kind text, p_organization_account_id uuid, p_group_id uuid, p_readable_field_ids uuid[], p_changeable_field_ids uuid[], p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_reason text, p_activity_id uuid, p_facts jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.initialize_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.initialize_platform_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.initialize_platform_permission_catalogue_v1(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.initialize_platform_permission_catalogue_v1_4_0(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_application_role_templates_for_administration(p_after_application_root_id uuid, p_after_source_role_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_application_role_templates_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_current_record_owner_groups() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_installed_applications_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_landing_zone_applications_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_account_choices(p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_accounts_for_administration(p_after_organization_account_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_accounts_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_delegation_authorities_for_administration(p_after_delegation_authority_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_delegations_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_group_memberships_for_administration(p_group_id uuid, p_after_membership_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_group_memberships_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_groups_for_administration(p_after_group_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_groups_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_invitations_for_administration(p_after_invitation_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_invitations_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_role_activations_for_administration(p_after_role_activation_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_role_activations_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_role_assignments_for_administration(p_after_role_assignment_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_role_assignments_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_roles_for_administration(p_after_role_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_roles_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.list_organization_runtime_settings_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.lock_active_record_ownership_target_internal(p_kind text, p_target_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.lock_application_installation_authority() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.lock_current_record_owner_group_internal(p_group_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.lock_effective_capability_policy(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_evaluated_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.lock_human_request_access_version_internal() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.lock_organization_runtime_settings_record_for_event_internal(p_record_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.lock_record_lifecycle_policy_authority() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.lock_role_and_refuse_sealed_permission_append() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.lock_role_before_revision_seal() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.lock_system_projection_link_target_internal(p_protected_read_model_key text, p_target_record_id uuid, p_organization_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.metering_event_dimensions_are_valid(p_dimensions jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.organization_accounts_administration_change_scope() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.organization_accounts_administration_scope() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.organization_accounts_offboarding_inventory_scope_internal() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.organization_assignment_ledger_administration_scope() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.organization_group_reduction_authority(p_organization_id uuid, p_group_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.organization_has_permanent_steward(p_organization_id uuid, p_checked_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.organization_invitations_administration_change_scope() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.organization_invitations_administration_scope() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.organization_roles_administration_scope() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.organization_runtime_settings_administration_read_scope() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.organization_runtime_settings_manage_is_current() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.permission_field_policy_is_valid(p_policy jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.permission_record_scope_is_valid(p_record_scope jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.platform_permission_catalogue_revision_is_exact(p_organization_id uuid, p_registration_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(p_organization_id uuid, p_registration_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.platform_permission_catalogue_revision_is_exact_v1_2_0(p_organization_id uuid, p_registration_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.platform_permission_catalogue_revision_is_exact_v1_3_0(p_organization_id uuid, p_registration_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.platform_permission_catalogue_revision_is_exact_v1_4_0(p_organization_id uuid, p_registration_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.private_current_role_management_scope(p_organization_id uuid, p_role_id uuid, p_role_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.private_management_scope_from_permission_evidence(p_permissions jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.project_organization_delegation_summary(p_organization_id uuid, p_delegation_authority_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.project_organization_role_activation_summary(p_organization_id uuid, p_role_activation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.project_organization_role_change_summary(p_organization_id uuid, p_role_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.propose_record_share_grant_for_administration(p_grant_id uuid, p_consent_request_id uuid, p_terms jsonb, p_proposal_fingerprint text, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_application_role_template_continuity() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_organization_access_version() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_organization_delegation_authority() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_organization_direct_record_share() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_organization_group() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_organization_group_membership() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_organization_role_activation() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_organization_role_assignment() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_organization_role_identity() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_organization_stewardship_requirement() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_permission_continuity() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.protect_permission_registration() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.publish_capability_policy_definition(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_policy_id uuid, p_capability_key text, p_unit text, p_quantity_limit numeric, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.reactivate_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_application_address_candidates(p_identity_id uuid, p_tenant_short_name text, p_organization_short_name text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_application_role_template_for_administration(p_application_root_id uuid, p_source_role_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_current_direct_record_share_contributions(p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_current_organization_default_application_for_application() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_current_organization_runtime_settings_for_application() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_flow_execution_binding(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_node_id uuid, p_operation_owner_kind text, p_operation_owner_id uuid, p_operation_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_flow_execution_binding_for_run(p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_node_id uuid, p_operation_owner_kind text, p_operation_owner_id uuid, p_operation_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_flow_run_as_principal_for_run(p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_account_for_administration(p_organization_account_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_delegation_authority(p_organization_id uuid, p_delegation_authority_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_delegation_authority_for_administration(p_delegation_authority_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_group(p_organization_id uuid, p_group_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_group_for_administration(p_group_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_group_membership(p_organization_id uuid, p_membership_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_group_membership_for_administration(p_membership_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_invitation_for_administration(p_invitation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_role_activation_for_administration(p_role_activation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_role_assignment(p_organization_id uuid, p_role_assignment_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_role_assignment_for_administration(p_role_assignment_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_role_change_evidence_for_administration(p_preparation jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_role_for_administration(p_role_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_organization_runtime_settings_for_administration() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_own_profile() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.read_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_scope text, p_organization_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_grouping text, p_page_size integer, p_cursor text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.rebuild_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.recent_authentication_deadline_internal(p_context jsonb, p_checked_at timestamp with time zone, p_requirement jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.record_metering_event(p_tenant_id uuid, p_organization_id uuid, p_allocation_owner text, p_operation_id uuid, p_capability_key text, p_quantity numeric, p_unit text, p_source text, p_dimensions jsonb, p_occurred_at timestamp with time zone, p_source_event_id uuid, p_duplicate_protection_key text, p_correlation_id uuid, p_corrects_metering_event_id uuid, p_correction_direction text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.record_relationship_witness_matches(p_declared_relationship_id uuid, p_declared_from_module_root_id uuid, p_declared_from_record_type_id uuid, p_declared_to_module_root_id uuid, p_declared_to_record_type_id uuid, p_edge_relationship_id uuid, p_edge_from_record_id uuid, p_edge_to_record_id uuid, p_from_record_scope jsonb, p_to_record_scope jsonb, p_current_organization_id uuid, p_current_application_root_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.record_share_grant_consent_decision_for_administration(p_decision_id uuid, p_request_id uuid, p_expected_revision bigint, p_expected_proposal_fingerprint text, p_decision text, p_note text, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.record_share_grant_consent_role_path_internal(p_organization_id uuid, p_organization_account_id uuid, p_application_root_id uuid, p_authorized_role_ids uuid[], p_checked_at timestamp with time zone, p_context_expires_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.record_share_grant_json_internal(p_grant_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.record_share_grant_source_authority_internal(p_context jsonb, p_module_root_id uuid, p_record_type_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.record_share_grant_uuid_array_internal(p_value jsonb, p_minimum integer, p_maximum integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.record_share_grantor_authority_until_internal(p_declaration jsonb, p_record_id uuid, p_facts jsonb, p_context jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.refresh_capability_reservation_balance(p_tenant_id uuid, p_request_organization_id uuid, p_capability_key text, p_unit text, p_applied_scope text, p_assignment_organization_id uuid, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_quantity_limit numeric, p_evaluated_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.refuse_capability_limit_change_edit() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.refuse_metering_event_change() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.refuse_organization_role_history_mutation() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.refuse_permission_registration_history_mutation() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.register_flow_execution_binding(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_duplicate_key uuid, p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_node_id uuid, p_operation_owner_kind text, p_operation_owner_id uuid, p_operation_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid, p_permitted_invokers jsonb, p_permitted_surfaces jsonb, p_permitted_inputs jsonb, p_expires_at timestamp with time zone, p_expected_revision bigint, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.register_flow_run_as_principal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_duplicate_key uuid, p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid, p_expires_at timestamp with time zone, p_expected_revision bigint, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.release_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_duplicate_key uuid, p_quantity numeric) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.remove_organization_group_membership_for_administration(p_membership_id uuid, p_expected_membership_revision bigint, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.rename_organization_group_for_administration(p_group_id uuid, p_expected_group_revision bigint, p_label text, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.require_platform_operator_internal(p_operator_actor_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.reserve_capability_quantity(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_claim jsonb, p_requested_quantity numeric, p_duplicate_key uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.resolve_durable_system_actor_scope(p_organization_id uuid, p_application_root_id uuid, p_flow_id uuid, p_operation_key text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.resolve_effective_capability_policy(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.resolve_event_dispatcher_actor() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.resolve_human_application_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.resolve_human_organization_change_scope(p_identity_id uuid, p_organization_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.resolve_human_organization_scope(p_identity_id uuid, p_organization_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.resolve_search_index_scope(p_organization_id uuid, p_application_root_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.resolve_system_actor_grant_internal(p_system_actor_id uuid, p_operation_key text, p_organization_id uuid, p_flow_id uuid, p_scope_key text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.retire_organization_group_for_administration(p_group_id uuid, p_expected_group_revision bigint, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.retire_organization_role_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_prepared_role_change jsonb, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revise_organization_role_metadata_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_label text, p_description text, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revise_platform_permission_catalogue_metadata(p_organization_id uuid, p_expected_registration_revision bigint, p_source_catalogue_version text, p_target_catalogue_version text, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revise_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_terms jsonb, p_proposal_fingerprint text, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revoke_capability_limit_allocation(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_assignment_id uuid, p_expected_revision bigint, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revoke_capability_policy_ceiling(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revoke_flow_execution_binding(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_duplicate_key uuid, p_execution_binding_id uuid, p_organization_id uuid, p_expected_revision bigint, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revoke_flow_run_as_principal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_duplicate_key uuid, p_execution_binding_id uuid, p_organization_id uuid, p_expected_revision bigint, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revoke_organization_delegation_authority_for_administration(p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revoke_organization_direct_record_share(p_organization_id uuid, p_direct_share_id uuid, p_expected_revision bigint, p_reason text, p_changed_by uuid, p_correlation_id uuid, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revoke_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.revoke_record_share_for_administration(p_direct_share_id uuid, p_expected_revision bigint, p_reason text, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.save_organization_settings_record_for_administration(p_record_id uuid, p_expected_revision bigint, p_core_values jsonb, p_extension_values jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.set_capability_limit_allocation(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_assignment_id uuid, p_capability_key text, p_unit text, p_quantity_limit numeric, p_expires_at timestamp with time zone, p_expected_revision bigint, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.set_capability_policy_ceiling(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_policy_id uuid, p_policy_revision bigint, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.suspend_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.typed_condition_temporal_value_internal(p_value text, p_kind text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.typed_condition_value_matches_internal(p_value jsonb, p_semantic_type text, p_nullable boolean) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.update_own_profile(p_organization_account_id uuid, p_expected_revision bigint, p_display_name text, p_language text, p_time_zone text, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.validate_organization_delegation_authority() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.validate_organization_delegation_bounded_permissions(p_organization_id uuid, p_permissions jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.validate_organization_direct_record_share_insert() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.validate_organization_group_membership_insert() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.validate_organization_role_activation_insert() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.validate_organization_role_assignment_insert() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.validated_durable_system_request_context(p_operation_key text, p_flow_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.validated_human_request_context() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.withdraw_application_permission_registration_v1_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_access.withdraw_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_reason text, p_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.accepted_contract_version(p_kind text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.append_application_installation_activity_internal(p_activity_id uuid, p_application_root_id uuid, p_action text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.append_release(p_root_id uuid, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_release jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.claim_organization_setup_source_manifest(p_tenant_id uuid, p_organization_id uuid, p_organization_account_id uuid, p_identity_id uuid, p_operation text, p_receipt_id uuid, p_command_fingerprint text, p_expected_setup_revision integer, p_manifest_canonical_text text, p_manifest_fingerprint text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.create_root(p_kind text, p_key text, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb, p_application_origin_kind text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.flow_target_dependency_reference(p_dependency jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.is_current_application_address_release(p_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.list_release_history(p_kind text, p_root_id uuid, p_page_size integer, p_before_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.lock_application_page_adoption_draft_internal(p_root_id uuid, p_expected_draft_revision bigint, p_expected_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.private_form_draft_expiry_internal(p_touched_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.private_form_draft_key_is_valid(p_key text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.private_form_draft_purge_internal(p_organization_id uuid, p_limit integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.private_form_draft_to_json_internal(d vortex_definition.form_drafts, p_state text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.private_form_draft_validation_is_valid(p_validation jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.private_form_draft_values_are_valid(p_values jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.project_consumer_release_evidence(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.protect_root_identity() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_application_bound_release_set(p_application_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_builder_application_root_classification(p_root_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_builder_application_root_key(p_root_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_consumer_release(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_first_install_application_release_set(p_application_root_id uuid, p_application_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_module_release(p_root_id uuid, p_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_module_release_page(p_key text, p_anchor_release_revision bigint, p_after_release_revision bigint, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_publication_history_page(p_root_id uuid, p_anchor_release_revision bigint, p_after_release_revision bigint, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_publication_state(p_root_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_release_history_entry(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_restore_release_evidence(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_saved_condition_history(p_root_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.read_system_application_bound_release_set(p_application_root_id uuid, p_application_release_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.record_source_identities(p_root_id uuid, p_requirements jsonb, p_actor_id uuid, p_operation_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.refuse_release_mutation() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.refuse_source_identity_mutation() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.restore_release_draft(p_kind text, p_root_id uuid, p_target_release_revision bigint, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_identity_requirements jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.save_draft(p_root_id uuid, p_expected_revision bigint, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.validate_draft_write() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.validate_release_insert() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.validated_builder_evidence_read_context_internal() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_definition.validated_system_context() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.adopt_organization(p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_steward_identity_id uuid, p_organization_account_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.adopt_tenant(p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_tenant_steward_identity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.apply_configured_cluster_identity_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_identity_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.apply_configured_tenant_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.archive_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.assert_organization_runtime_settings_values(p_language text, p_time_zone text, p_currency text, p_date_format text, p_number_format text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.begin_identity_disablement(p_actor_identity_id uuid, p_subject_identity_id uuid, p_command_id uuid, p_command_fingerprint text, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.bootstrap_vortex_super_administrator(p_operator_actor_id uuid, p_duplicate_key uuid, p_identity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.change_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.grant_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_subject_identity_id uuid, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.grant_vortex_super_administrator(p_duplicate_key uuid, p_identity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.list_organization_launcher(p_identity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.list_organizations_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.list_tenant_administrator_assignments(p_tenant_id uuid, p_limit integer, p_after uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.list_tenant_administrators_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.list_tenant_hierarchy(p_tenant_id uuid, p_limit integer, p_after uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.list_tenant_launcher(p_limit integer, p_after uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.list_tenants_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.list_vortex_super_administrator_assignments(p_limit integer, p_after uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.lock_organization_tenant() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.protect_identity_disablement_command() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.protect_identity_projection() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.protect_organization_account() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.protect_organization_identity() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.protect_organization_invitation() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.protect_super_administrator_account_provenance() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.protect_tenant_identity() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.protect_vortex_super_administrator_assignment() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.provision_tenant(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_tenant_short_name text, p_tenant_display_name text, p_organization_short_name text, p_organization_display_name text, p_tenant_steward_identity_id uuid, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.reactivate_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.read_organization_setup_receipt(p_receipt_id uuid, p_expected_operation text, p_expected_organization_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.read_tenant_organization(p_tenant_id uuid, p_organization_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.refuse_identity_disablement_record_change() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.refuse_organization_cycle() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.rename_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_display_name text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.reparent_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_parent_organization_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.require_current_tenant_capability(p_identity_id uuid, p_tenant_id uuid, p_capability_key text, p_evaluated_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.require_identity_not_disabled(p_identity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.require_request_identity_not_disabled() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.resolve_active_organization_account(p_identity_id uuid, p_organization_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(p_identity_id uuid, p_checked_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.revoke_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.revoke_vortex_super_administrator(p_duplicate_key uuid, p_assignment_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.start_disabled_identity_projection_suspended() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.subject_revisions_are_valid(p_subject_ids uuid[], p_subject_revisions bigint[]) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.suspend_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.tenant_capabilities_from_json(p_capabilities jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.tenant_request_actor_id() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.tenant_structural_capability_set_is_canonical(p_capability_keys text[]) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_identity.validated_human_account_context() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.accept_flow_start_intent(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_application_release_version text, p_flow_owner_kind text, p_flow_owner_root_id uuid, p_flow_release_revision bigint, p_flow_release_version text, p_flow_id uuid, p_source_kind text, p_source_id uuid, p_trigger_type text, p_trigger_id text, p_inputs jsonb, p_trigger_values jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.advance_file_metadata_revision() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.alert_signal_builder_key_is_valid(p_key text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.alert_signal_namespaced_key_is_valid(p_key text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.append_application_grant_activity_internal(p_context jsonb, p_activity_id uuid, p_connection_instance_id uuid, p_application_root_id uuid, p_action text, p_occurred_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.append_connection_instance_activity_internal(p_context jsonb, p_activity_id uuid, p_connection_instance_id uuid, p_action text, p_occurred_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.append_file_activity_internal(p_action text, p_subject_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.application_root_id(required boolean) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.change_topic(p_organization_id uuid, p_application_root_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.channel() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.current_context() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.decide_file_read(p_file_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.enforce_file_application_root() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.enforce_grant_application_root() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.file_activity_id(p_action text, p_organization_id uuid, p_correlation_id uuid, p_subject_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.flow_registration_to_json_internal(r vortex_platform.flow_registrations) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.format_timestamp_utc(p_value timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.grant_connection_application_internal(p_connection_instance_id uuid, p_application_root_id uuid, p_administrator_activity_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.identity_authority_id(required boolean) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.initialize(candidate jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.is_non_nil_uuid(candidate text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.list_connection_instances_for_administration(p_organization_id uuid, p_after_connection_instance_id uuid, p_page_size integer) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.organization_id() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.publish_change_notice(p_organization_id uuid, p_application_root_id uuid, p_record_type_id uuid, p_record_id uuid, p_record_version bigint, p_change_kind text, p_data_version bigint, p_sequence bigint, p_correlation_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.read_active_connection_evidence(p_connection_instance_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.read_connection_instance_for_administration(p_organization_id uuid, p_connection_instance_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.read_file_application(p_file_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.read_protected_node_effect(p_run_id uuid, p_organization_id uuid, p_identity_id uuid, p_task_path text, p_iteration text, p_operation_key text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.read_protected_workflow_run(p_run_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.read_protected_workflow_run_registration(p_run_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.refresh_protected_workflow_run_state(p_run_id uuid, p_state text, p_refreshed_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.refuse_event_outbox_change() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.register_workflow_flow_candidate(p_environment text, p_organization_id uuid, p_application_root_id uuid, p_application_version text, p_installation_revision bigint, p_workflow_revision bigint, p_candidate jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.reserve_file_upload(p_file_id uuid, p_organization_id uuid, p_application_root_id uuid, p_owner_record_type_id uuid, p_owner_record_id uuid, p_owner_field_id uuid, p_original_safe_display_name text, p_extension text, p_storage_key text, p_uploaded_by jsonb, p_maximum_bytes bigint, p_max_files integer, p_existing_attachment_count integer, p_replacing_file_id uuid, p_capability_reservation_id uuid, p_one_time_id uuid, p_policy_fingerprint text, p_grant_expires_at timestamp with time zone, p_upload_expires_at timestamp with time zone) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.resolve_connection_instance_readiness(p_organization_id uuid, p_application_root_id uuid, p_connection_instance_id uuid, p_destination_key text, p_expected_revision bigint, p_expected_fingerprint text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.start_value_matches_type_internal(p_type text, p_value jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.topic_application_root_id(p_topic text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.topic_organization_id(p_topic text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.upload_file_record(p_file vortex_platform.file_records) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.upload_maximum_bytes_limit() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.upload_refusal(p_reason text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.upload_request_actor(p_context jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.uuid_array_is_canonical(p_values uuid[]) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.validated(candidate jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.validated_service_context() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_platform.write_protected_workflow_run(p_run_id uuid, p_organization_id uuid, p_identity_id uuid, p_run_record jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_record.append_base_save_activity_internal(p_activity_id uuid, p_operation text, p_subject_id uuid, p_changed_field_ids uuid[], p_outcome text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_record.append_lifecycle_policy_activity_internal(p_activity_id uuid, p_policy_id uuid) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_record.append_named_action_activity_internal(p_activity_id uuid, p_subject_id uuid, p_changed_field_ids uuid[], p_outcome text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_record.append_organization_activity_entry(p_organization_id uuid, p_activity_id uuid, p_occurred_at timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_subject_ids uuid[], p_changed_field_ids uuid[], p_source text, p_correlation_id uuid, p_outcome text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_record.append_ownership_transfer_activity_internal(p_activity_id uuid, p_subject_id uuid, p_outcome text) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_record.append_record_lifecycle_activity_internal(p_activity_id uuid, p_operation text, p_subject_ids uuid[]) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_record.document_entries_are_valid(p_entries jsonb) owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_record.enforce_document_application_root() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_record.record_super_administrator_authority_internal() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_record.refuse_activity_entry_change() owner to vortex_owner;
-- guard-allow: migration-owner-role Existing postgres ownership requires the postgres owner to transfer this object.
alter function vortex_record.refuse_super_administrator_authority_change() owner to vortex_owner;

set local role vortex_owner;

-- FORCE ROW LEVEL SECURITY applies to the new owner; retain the access
-- formerly exercised by postgres-owned security-definer functions.
create policy vortex_owner_all on vortex_access.application_role_template_continuities
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.capability_limit_changes
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.capability_policy_assignments
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.capability_policy_definitions
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.capability_reservation_balances
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.capability_reservations
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.flow_execution_bindings
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.flow_run_as_principals
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.metering_events
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_access_versions
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_delegation_authorities
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_direct_record_shares
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_group_memberships
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_groups
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_role_activation_policy_revisions
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_role_activations
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_role_assignments
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_role_permission_entries
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_role_revisions
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_roles
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.organization_stewardship_requirements
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.permission_catalogue_entries
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.permission_continuities
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.permission_registration_revisions
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.permission_registrations
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.record_share_grant_consent_decisions
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.record_share_grant_consent_requests
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.record_share_grants
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.system_actor_grants
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.usage_projection_reconciliation
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_access.usage_projection_rollups
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.drafts
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.form_drafts
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.installation_bindings
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.installation_runtime_bundle_parts
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.installation_runtime_bundles
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.organization_setup_source_manifests
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.preview_installations
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.release_dependencies
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.releases
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.roots
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.source_identities
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_definition.source_identity_aliases
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_identity.identity_disablement_commands
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_identity.identity_disablement_events
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_identity.identity_projections
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_identity.organization_accounts
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_identity.organization_invitations
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_identity.organization_runtime_settings
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_identity.organizations
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_identity.tenant_administrator_assignments
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_identity.tenants
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_identity.vortex_super_administrator_assignments
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.alert_signals
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.connection_application_grants
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.connection_instances
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.consumer_occurrence_progress
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.download_grants
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.event_outbox
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.file_records
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.flow_registrations
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.flow_start_intents
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.request_contexts
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.upload_grants
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_platform.upload_reservations
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.documents
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.field_storage_mappings
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.index_catalogue
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.legal_hold_versions
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.organization_activity_entries
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.organization_activity_super_administrator_authority
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.organization_lifecycle_limits
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.preview_storage_bindings
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.protected_read_model_views
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.record_reference_counters
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.record_type_lifecycle_policies
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.relationship_edges
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.relationship_storage_mappings
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.release_provisions
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.storage_catalogue
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.storage_conversion_catalogue
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.storage_conversion_plans
  for all to vortex_owner using (true) with check (true);
create policy vortex_owner_all on vortex_record.storage_conversion_progress
  for all to vortex_owner using (true) with check (true);

-- Preserve the operational postgres role access used by the seed,
-- controlled migrations and the three Supabase integrations.
grant all on table vortex_access.application_role_template_continuities to postgres;
grant all on table vortex_access.capability_limit_changes to postgres;
grant all on table vortex_access.capability_policy_assignments to postgres;
grant all on table vortex_access.capability_policy_definitions to postgres;
grant all on table vortex_access.capability_reservation_balances to postgres;
grant all on table vortex_access.capability_reservations to postgres;
grant all on table vortex_access.flow_execution_bindings to postgres;
grant all on table vortex_access.flow_run_as_principals to postgres;
grant all on table vortex_access.metering_events to postgres;
grant all on table vortex_access.organization_access_versions to postgres;
grant all on table vortex_access.organization_delegation_authorities to postgres;
grant all on table vortex_access.organization_direct_record_shares to postgres;
grant all on table vortex_access.organization_group_memberships to postgres;
grant all on table vortex_access.organization_groups to postgres;
grant all on table vortex_access.organization_role_activation_policy_revisions to postgres;
grant all on table vortex_access.organization_role_activations to postgres;
grant all on table vortex_access.organization_role_assignments to postgres;
grant all on table vortex_access.organization_role_permission_entries to postgres;
grant all on table vortex_access.organization_roles to postgres;
grant all on table vortex_access.organization_stewardship_requirements to postgres;
grant all on table vortex_access.permission_catalogue_entries to postgres;
grant all on table vortex_access.permission_continuities to postgres;
grant all on table vortex_access.record_share_grant_consent_decisions to postgres;
grant all on table vortex_access.record_share_grant_consent_requests to postgres;
grant all on table vortex_access.record_share_grants to postgres;
grant all on table vortex_access.system_actor_grants to postgres;
grant all on table vortex_access.usage_projection_reconciliation to postgres;
grant all on table vortex_access.usage_projection_rollups to postgres;
grant all on table vortex_access.validation_reference_values to postgres;
grant all on table vortex_definition.drafts to postgres;
grant all on table vortex_definition.form_drafts to postgres;
grant all on table vortex_definition.organization_setup_source_manifests to postgres;
grant all on table vortex_definition.release_dependencies to postgres;
grant all on table vortex_definition.releases to postgres;
grant all on table vortex_definition.roots to postgres;
grant all on table vortex_definition.source_identities to postgres;
grant all on table vortex_definition.source_identity_aliases to postgres;
grant all on table vortex_identity.identity_disablement_commands to postgres;
grant all on table vortex_identity.identity_disablement_events to postgres;
grant all on table vortex_identity.identity_projections to postgres;
grant all on table vortex_identity.organization_accounts to postgres;
grant all on table vortex_identity.organization_invitations to postgres;
grant all on table vortex_identity.organization_runtime_settings to postgres;
grant all on table vortex_identity.organizations to postgres;
grant all on table vortex_identity.tenant_administrator_assignments to postgres;
grant all on table vortex_identity.tenants to postgres;
grant all on table vortex_identity.vortex_super_administrator_assignments to postgres;
grant all on table vortex_platform.alert_signals to postgres;
grant all on table vortex_platform.connection_application_grants to postgres;
grant all on table vortex_platform.connection_instances to postgres;
grant all on table vortex_platform.consumer_occurrence_progress to postgres;
grant all on table vortex_platform.download_grants to postgres;
grant all on table vortex_platform.event_outbox to postgres;
grant all on table vortex_platform.file_records to postgres;
grant all on table vortex_platform.flow_continuations to postgres;
grant all on table vortex_platform.flow_effect_ledger to postgres;
grant all on table vortex_platform.flow_registrations to postgres;
grant all on table vortex_platform.flow_start_intents to postgres;
grant all on table vortex_platform.protected_workflow_runs to postgres;
grant all on table vortex_platform.request_contexts to postgres;
grant all on table vortex_platform.upload_grants to postgres;
grant all on table vortex_platform.upload_reservations to postgres;
grant all on table vortex_record.documents to postgres;
grant all on table vortex_record.organization_activity_entries to postgres;
grant all on table vortex_record.organization_activity_super_administrator_authority to postgres;
grant all on sequence vortex_identity.identity_disablement_events_event_id_seq to postgres;
grant execute on function vortex_access.accept_organization_invitation(p_token_fingerprint text, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.add_organization_group_membership_for_administration(p_membership_id uuid, p_group_id uuid, p_organization_account_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) to postgres;
grant execute on function vortex_access.adopt_builder_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.adopt_connection_administration_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.adopt_security_and_support_operator_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.adopt_shipped_platform_permission_catalogue(p_organization_id uuid, p_expected_registration_revision bigint, p_target_catalogue_version text, p_target_catalogue_fingerprint text, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.application_access_current_state_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_prepared_templates jsonb) to postgres;
grant execute on function vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) to postgres;
grant execute on function vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.appoint_organization_steward_for_administration(p_organization_account_id uuid, p_expected_account_revision bigint) to postgres;
grant execute on function vortex_access.assert_organization_has_permanent_steward(p_organization_id uuid) to postgres;
grant execute on function vortex_access.assign_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) to postgres;
grant execute on function vortex_access.begin_organization_account_closing_for_administration(p_organization_account_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_access.begin_protected_node_effect(p_run_id uuid, p_organization_id uuid, p_identity_id uuid, p_task_path text, p_iteration text, p_operation_key text) to postgres;
grant execute on function vortex_access.capability_limit_bounds_internal(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_evaluated_at timestamp with time zone, p_lock boolean) to postgres;
grant execute on function vortex_access.capability_policy_key_is_valid(p_key text) to postgres;
grant execute on function vortex_access.capability_policy_quantity_is_valid(p_quantity numeric) to postgres;
grant execute on function vortex_access.capability_policy_unit_is_valid(p_unit text) to postgres;
grant execute on function vortex_access.capability_reservation_request_context(p_tenant_id uuid, p_organization_id uuid) to postgres;
grant execute on function vortex_access.change_account_state_without_stewardship_v1_internal(p_organization_account_id uuid, p_expected_revision bigint, p_state text) to postgres;
grant execute on function vortex_access.change_application_installation_access(p_activity_id uuid, p_application_root_id uuid, p_change text, p_prepared_templates jsonb) to postgres;
grant execute on function vortex_access.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) to postgres;
grant execute on function vortex_access.change_organization_role_authority_for_administration(p_prepared_evidence jsonb, p_activity_id uuid) to postgres;
grant execute on function vortex_access.check_record_lifecycle_preview_authority() to postgres;
grant execute on function vortex_access.check_record_share_grant_terms_internal(p_terms jsonb, p_context jsonb) to postgres;
grant execute on function vortex_access.close_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_access.complete_protected_node_effect(p_run_id uuid, p_organization_id uuid, p_identity_id uuid, p_task_path text, p_iteration text, p_outcome text, p_outputs jsonb) to postgres;
grant execute on function vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) to postgres;
grant execute on function vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.coordinate_application_access_without_stewardship_v1_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.coordinate_assignment_change_without_stewardship_v1_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.coordinate_organization_group_change(p_operation text, p_organization_id uuid, p_group_id uuid, p_expected_group_revision bigint, p_group_key text, p_label text, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.coordinate_organization_group_membership_change(p_operation text, p_organization_id uuid, p_membership_id uuid, p_expected_membership_revision bigint, p_group_id uuid, p_organization_account_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_replacement_membership_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.coordinate_organization_role_activation_change(p_operation text, p_organization_id uuid, p_role_activation_id uuid, p_expected_activation_revision bigint, p_organization_account_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_requested_duration_seconds bigint, p_eligibility_source_kind text, p_role_assignment_id uuid, p_expected_role_assignment_revision bigint, p_membership_id uuid, p_expected_membership_revision bigint, p_changed_by uuid, p_correlation_id uuid, p_invoking_execution_binding_id uuid) to postgres;
grant execute on function vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.coordinate_private_organization_group_membership_change(p_operation text, p_membership_id uuid, p_expected_membership_revision bigint, p_group_id uuid, p_organization_account_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_replacement_membership_id uuid, p_activity_id uuid) to postgres;
grant execute on function vortex_access.coordinate_private_organization_role_assignment_grant(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) to postgres;
grant execute on function vortex_access.coordinate_private_organization_role_authority_change(p_prepared_evidence jsonb, p_activity_id uuid) to postgres;
grant execute on function vortex_access.create_organization_group_for_administration(p_group_id uuid, p_group_key text, p_label text, p_activity_id uuid) to postgres;
grant execute on function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) to postgres;
grant execute on function vortex_access.current_organization_access_version(p_tenant_id uuid, p_organization_id uuid) to postgres;
grant execute on function vortex_access.deactivate_organization_role_activation_for_administration(p_role_activation_id uuid, p_expected_activation_revision bigint, p_activity_id uuid) to postgres;
grant execute on function vortex_access.derive_usage_projection(p_tenant_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) to postgres;
grant execute on function vortex_access.evaluate_current_record_ownership_visibility(p_permission_record_scope jsonb, p_ownership_mode text, p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_scope jsonb, p_owner_organization_account_id uuid, p_owner_group_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) to postgres;
grant execute on function vortex_access.evaluate_organization_record_access_internal(p_declaration jsonb, p_target_record_id uuid, p_facts jsonb) to postgres;
grant execute on function vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) to postgres;
grant execute on function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) to postgres;
grant execute on function vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) to postgres;
grant execute on function vortex_access.evaluate_query_condition_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) to postgres;
grant execute on function vortex_access.evaluate_record_permission_row_scope_internal(p_context jsonb, p_checked_at timestamp with time zone, p_auth_deadline timestamp with time zone, p_application_root_id uuid, p_action jsonb, p_candidate jsonb, p_record_id uuid, p_facts jsonb, p_path uuid[]) to postgres;
grant execute on function vortex_access.evaluate_typed_condition_node_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) to postgres;
grant execute on function vortex_access.expire_stale_capability_reservations(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text) to postgres;
grant execute on function vortex_access.fence_record_owner_account_target_internal() to postgres;
grant execute on function vortex_access.flow_execution_binding_authority_internal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_organization_id uuid, p_mode text) to postgres;
grant execute on function vortex_access.flow_execution_binding_to_json_internal(b vortex_access.flow_execution_bindings) to postgres;
grant execute on function vortex_access.flow_run_as_principal_to_json_internal(p_principal vortex_access.flow_run_as_principals) to postgres;
grant execute on function vortex_access.get_record_share_grant_for_administration(p_grant_id uuid) to postgres;
grant execute on function vortex_access.grant_organization_direct_record_share(p_organization_id uuid, p_direct_share_id uuid, p_storage_scope text, p_application_root_id uuid, p_module_root_id uuid, p_record_type_id uuid, p_storage_contract_id uuid, p_record_id uuid, p_recipient_kind text, p_organization_account_id uuid, p_group_id uuid, p_readable_field_ids uuid[], p_changeable_field_ids uuid[], p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_reason text, p_changed_by uuid, p_correlation_id uuid, p_activity_id uuid) to postgres;
grant execute on function vortex_access.grant_record_share_for_administration(p_direct_share_id uuid, p_record_id uuid, p_recipient_kind text, p_organization_account_id uuid, p_group_id uuid, p_readable_field_ids uuid[], p_changeable_field_ids uuid[], p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_reason text, p_activity_id uuid, p_facts jsonb) to postgres;
grant execute on function vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) to postgres;
grant execute on function vortex_access.initialize_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.initialize_platform_permission_catalogue(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.initialize_platform_permission_catalogue_v1(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.initialize_platform_permission_catalogue_v1_4_0(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.list_application_role_templates_for_administration(p_after_application_root_id uuid, p_after_source_role_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_application_role_templates_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_current_record_owner_groups() to postgres;
grant execute on function vortex_access.list_installed_applications_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_landing_zone_applications_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_account_choices(p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid) to postgres;
grant execute on function vortex_access.list_organization_accounts_for_administration(p_after_organization_account_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_accounts_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_delegation_authorities_for_administration(p_after_delegation_authority_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_delegations_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_group_memberships_for_administration(p_group_id uuid, p_after_membership_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_group_memberships_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_groups_for_administration(p_after_group_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_groups_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_invitations_for_administration(p_after_invitation_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_invitations_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_role_activations_for_administration(p_after_role_activation_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_role_activations_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_role_assignments_for_administration(p_after_role_assignment_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_role_assignments_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_roles_for_administration(p_after_role_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_roles_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.list_organization_runtime_settings_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_access.lock_active_record_ownership_target_internal(p_kind text, p_target_id uuid) to postgres;
grant execute on function vortex_access.lock_application_installation_authority() to postgres;
grant execute on function vortex_access.lock_current_record_owner_group_internal(p_group_id uuid) to postgres;
grant execute on function vortex_access.lock_effective_capability_policy(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_evaluated_at timestamp with time zone) to postgres;
grant execute on function vortex_access.lock_human_request_access_version_internal() to postgres;
grant execute on function vortex_access.lock_organization_runtime_settings_record_for_event_internal(p_record_id uuid) to postgres;
grant execute on function vortex_access.lock_record_lifecycle_policy_authority() to postgres;
grant execute on function vortex_access.lock_role_and_refuse_sealed_permission_append() to postgres;
grant execute on function vortex_access.lock_role_before_revision_seal() to postgres;
grant execute on function vortex_access.lock_system_projection_link_target_internal(p_protected_read_model_key text, p_target_record_id uuid, p_organization_id uuid) to postgres;
grant execute on function vortex_access.metering_event_dimensions_are_valid(p_dimensions jsonb) to postgres;
grant execute on function vortex_access.organization_accounts_administration_change_scope() to postgres;
grant execute on function vortex_access.organization_accounts_administration_scope() to postgres;
grant execute on function vortex_access.organization_accounts_offboarding_inventory_scope_internal() to postgres;
grant execute on function vortex_access.organization_assignment_ledger_administration_scope() to postgres;
grant execute on function vortex_access.organization_group_reduction_authority(p_organization_id uuid, p_group_id uuid) to postgres;
grant execute on function vortex_access.organization_has_permanent_steward(p_organization_id uuid, p_checked_at timestamp with time zone) to postgres;
grant execute on function vortex_access.organization_invitations_administration_change_scope() to postgres;
grant execute on function vortex_access.organization_invitations_administration_scope() to postgres;
grant execute on function vortex_access.organization_roles_administration_scope() to postgres;
grant execute on function vortex_access.organization_runtime_settings_administration_read_scope() to postgres;
grant execute on function vortex_access.organization_runtime_settings_manage_is_current() to postgres;
grant execute on function vortex_access.permission_field_policy_is_valid(p_policy jsonb) to postgres;
grant execute on function vortex_access.permission_record_scope_is_valid(p_record_scope jsonb) to postgres;
grant execute on function vortex_access.platform_permission_catalogue_revision_is_exact(p_organization_id uuid, p_registration_revision bigint) to postgres;
grant execute on function vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(p_organization_id uuid, p_registration_revision bigint) to postgres;
grant execute on function vortex_access.platform_permission_catalogue_revision_is_exact_v1_2_0(p_organization_id uuid, p_registration_revision bigint) to postgres;
grant execute on function vortex_access.platform_permission_catalogue_revision_is_exact_v1_3_0(p_organization_id uuid, p_registration_revision bigint) to postgres;
grant execute on function vortex_access.platform_permission_catalogue_revision_is_exact_v1_4_0(p_organization_id uuid, p_registration_revision bigint) to postgres;
grant execute on function vortex_access.private_current_role_management_scope(p_organization_id uuid, p_role_id uuid, p_role_revision bigint) to postgres;
grant execute on function vortex_access.private_management_scope_from_permission_evidence(p_permissions jsonb) to postgres;
grant execute on function vortex_access.project_organization_delegation_summary(p_organization_id uuid, p_delegation_authority_id uuid) to postgres;
grant execute on function vortex_access.project_organization_role_activation_summary(p_organization_id uuid, p_role_activation_id uuid) to postgres;
grant execute on function vortex_access.project_organization_role_change_summary(p_organization_id uuid, p_role_id uuid) to postgres;
grant execute on function vortex_access.propose_record_share_grant_for_administration(p_grant_id uuid, p_consent_request_id uuid, p_terms jsonb, p_proposal_fingerprint text, p_activity_id uuid) to postgres;
grant execute on function vortex_access.protect_application_role_template_continuity() to postgres;
grant execute on function vortex_access.protect_organization_access_version() to postgres;
grant execute on function vortex_access.protect_organization_delegation_authority() to postgres;
grant execute on function vortex_access.protect_organization_direct_record_share() to postgres;
grant execute on function vortex_access.protect_organization_group() to postgres;
grant execute on function vortex_access.protect_organization_group_membership() to postgres;
grant execute on function vortex_access.protect_organization_role_activation() to postgres;
grant execute on function vortex_access.protect_organization_role_assignment() to postgres;
grant execute on function vortex_access.protect_organization_role_identity() to postgres;
grant execute on function vortex_access.protect_organization_stewardship_requirement() to postgres;
grant execute on function vortex_access.protect_permission_continuity() to postgres;
grant execute on function vortex_access.protect_permission_registration() to postgres;
grant execute on function vortex_access.publish_capability_policy_definition(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_policy_id uuid, p_capability_key text, p_unit text, p_quantity_limit numeric, p_expected_revision bigint) to postgres;
grant execute on function vortex_access.reactivate_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_access.read_application_address_candidates(p_identity_id uuid, p_tenant_short_name text, p_organization_short_name text) to postgres;
grant execute on function vortex_access.read_application_role_template_for_administration(p_application_root_id uuid, p_source_role_id uuid) to postgres;
grant execute on function vortex_access.read_current_direct_record_share_contributions(p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) to postgres;
grant execute on function vortex_access.read_current_organization_default_application_for_application() to postgres;
grant execute on function vortex_access.read_current_organization_runtime_settings_for_application() to postgres;
grant execute on function vortex_access.read_flow_execution_binding(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_node_id uuid, p_operation_owner_kind text, p_operation_owner_id uuid, p_operation_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid) to postgres;
grant execute on function vortex_access.read_flow_execution_binding_for_run(p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_node_id uuid, p_operation_owner_kind text, p_operation_owner_id uuid, p_operation_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid) to postgres;
grant execute on function vortex_access.read_flow_run_as_principal_for_run(p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid) to postgres;
grant execute on function vortex_access.read_organization_account_for_administration(p_organization_account_id uuid) to postgres;
grant execute on function vortex_access.read_organization_delegation_authority(p_organization_id uuid, p_delegation_authority_id uuid) to postgres;
grant execute on function vortex_access.read_organization_delegation_authority_for_administration(p_delegation_authority_id uuid) to postgres;
grant execute on function vortex_access.read_organization_group(p_organization_id uuid, p_group_id uuid) to postgres;
grant execute on function vortex_access.read_organization_group_for_administration(p_group_id uuid) to postgres;
grant execute on function vortex_access.read_organization_group_membership(p_organization_id uuid, p_membership_id uuid) to postgres;
grant execute on function vortex_access.read_organization_group_membership_for_administration(p_membership_id uuid) to postgres;
grant execute on function vortex_access.read_organization_invitation_for_administration(p_invitation_id uuid) to postgres;
grant execute on function vortex_access.read_organization_role_activation_for_administration(p_role_activation_id uuid) to postgres;
grant execute on function vortex_access.read_organization_role_assignment(p_organization_id uuid, p_role_assignment_id uuid) to postgres;
grant execute on function vortex_access.read_organization_role_assignment_for_administration(p_role_assignment_id uuid) to postgres;
grant execute on function vortex_access.read_organization_role_change_evidence_for_administration(p_preparation jsonb) to postgres;
grant execute on function vortex_access.read_organization_role_for_administration(p_role_id uuid) to postgres;
grant execute on function vortex_access.read_organization_runtime_settings_for_administration() to postgres;
grant execute on function vortex_access.read_own_profile() to postgres;
grant execute on function vortex_access.read_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_scope text, p_organization_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_grouping text, p_page_size integer, p_cursor text) to postgres;
grant execute on function vortex_access.rebuild_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) to postgres;
grant execute on function vortex_access.recent_authentication_deadline_internal(p_context jsonb, p_checked_at timestamp with time zone, p_requirement jsonb) to postgres;
grant execute on function vortex_access.record_metering_event(p_tenant_id uuid, p_organization_id uuid, p_allocation_owner text, p_operation_id uuid, p_capability_key text, p_quantity numeric, p_unit text, p_source text, p_dimensions jsonb, p_occurred_at timestamp with time zone, p_source_event_id uuid, p_duplicate_protection_key text, p_correlation_id uuid, p_corrects_metering_event_id uuid, p_correction_direction text) to postgres;
grant execute on function vortex_access.record_relationship_witness_matches(p_declared_relationship_id uuid, p_declared_from_module_root_id uuid, p_declared_from_record_type_id uuid, p_declared_to_module_root_id uuid, p_declared_to_record_type_id uuid, p_edge_relationship_id uuid, p_edge_from_record_id uuid, p_edge_to_record_id uuid, p_from_record_scope jsonb, p_to_record_scope jsonb, p_current_organization_id uuid, p_current_application_root_id uuid) to postgres;
grant execute on function vortex_access.record_share_grant_consent_decision_for_administration(p_decision_id uuid, p_request_id uuid, p_expected_revision bigint, p_expected_proposal_fingerprint text, p_decision text, p_note text, p_activity_id uuid) to postgres;
grant execute on function vortex_access.record_share_grant_consent_role_path_internal(p_organization_id uuid, p_organization_account_id uuid, p_application_root_id uuid, p_authorized_role_ids uuid[], p_checked_at timestamp with time zone, p_context_expires_at timestamp with time zone) to postgres;
grant execute on function vortex_access.record_share_grant_json_internal(p_grant_id uuid) to postgres;
grant execute on function vortex_access.record_share_grant_source_authority_internal(p_context jsonb, p_module_root_id uuid, p_record_type_id uuid) to postgres;
grant execute on function vortex_access.record_share_grant_uuid_array_internal(p_value jsonb, p_minimum integer, p_maximum integer) to postgres;
grant execute on function vortex_access.record_share_grantor_authority_until_internal(p_declaration jsonb, p_record_id uuid, p_facts jsonb, p_context jsonb) to postgres;
grant execute on function vortex_access.refresh_capability_reservation_balance(p_tenant_id uuid, p_request_organization_id uuid, p_capability_key text, p_unit text, p_applied_scope text, p_assignment_organization_id uuid, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_quantity_limit numeric, p_evaluated_at timestamp with time zone) to postgres;
grant execute on function vortex_access.refuse_capability_limit_change_edit() to postgres;
grant execute on function vortex_access.refuse_metering_event_change() to postgres;
grant execute on function vortex_access.refuse_organization_role_history_mutation() to postgres;
grant execute on function vortex_access.refuse_permission_registration_history_mutation() to postgres;
grant execute on function vortex_access.register_flow_execution_binding(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_duplicate_key uuid, p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_node_id uuid, p_operation_owner_kind text, p_operation_owner_id uuid, p_operation_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid, p_permitted_invokers jsonb, p_permitted_surfaces jsonb, p_permitted_inputs jsonb, p_expires_at timestamp with time zone, p_expected_revision bigint, p_activity_id uuid) to postgres;
grant execute on function vortex_access.register_flow_run_as_principal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_duplicate_key uuid, p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid, p_expires_at timestamp with time zone, p_expected_revision bigint, p_activity_id uuid) to postgres;
grant execute on function vortex_access.release_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_duplicate_key uuid, p_quantity numeric) to postgres;
grant execute on function vortex_access.remove_organization_group_membership_for_administration(p_membership_id uuid, p_expected_membership_revision bigint, p_activity_id uuid) to postgres;
grant execute on function vortex_access.rename_organization_group_for_administration(p_group_id uuid, p_expected_group_revision bigint, p_label text, p_activity_id uuid) to postgres;
grant execute on function vortex_access.require_platform_operator_internal(p_operator_actor_id uuid) to postgres;
grant execute on function vortex_access.reserve_capability_quantity(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_claim jsonb, p_requested_quantity numeric, p_duplicate_key uuid) to postgres;
grant execute on function vortex_access.resolve_durable_system_actor_scope(p_organization_id uuid, p_application_root_id uuid, p_flow_id uuid, p_operation_key text) to postgres;
grant execute on function vortex_access.resolve_effective_capability_policy(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text) to postgres;
grant execute on function vortex_access.resolve_event_dispatcher_actor() to postgres;
grant execute on function vortex_access.resolve_human_application_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) to postgres;
grant execute on function vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) to postgres;
grant execute on function vortex_access.resolve_human_organization_change_scope(p_identity_id uuid, p_organization_id uuid) to postgres;
grant execute on function vortex_access.resolve_human_organization_scope(p_identity_id uuid, p_organization_id uuid) to postgres;
grant execute on function vortex_access.resolve_search_index_scope(p_organization_id uuid, p_application_root_id uuid) to postgres;
grant execute on function vortex_access.resolve_system_actor_grant_internal(p_system_actor_id uuid, p_operation_key text, p_organization_id uuid, p_flow_id uuid, p_scope_key text) to postgres;
grant execute on function vortex_access.retire_organization_group_for_administration(p_group_id uuid, p_expected_group_revision bigint, p_activity_id uuid) to postgres;
grant execute on function vortex_access.retire_organization_role_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_prepared_role_change jsonb, p_activity_id uuid) to postgres;
grant execute on function vortex_access.revise_organization_role_metadata_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_label text, p_description text, p_activity_id uuid) to postgres;
grant execute on function vortex_access.revise_platform_permission_catalogue_metadata(p_organization_id uuid, p_expected_registration_revision bigint, p_source_catalogue_version text, p_target_catalogue_version text, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.revise_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_terms jsonb, p_proposal_fingerprint text, p_activity_id uuid) to postgres;
grant execute on function vortex_access.revoke_capability_limit_allocation(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_assignment_id uuid, p_expected_revision bigint, p_activity_id uuid) to postgres;
grant execute on function vortex_access.revoke_capability_policy_ceiling(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_access.revoke_flow_execution_binding(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_duplicate_key uuid, p_execution_binding_id uuid, p_organization_id uuid, p_expected_revision bigint, p_activity_id uuid) to postgres;
grant execute on function vortex_access.revoke_flow_run_as_principal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_duplicate_key uuid, p_execution_binding_id uuid, p_organization_id uuid, p_expected_revision bigint, p_activity_id uuid) to postgres;
grant execute on function vortex_access.revoke_organization_delegation_authority_for_administration(p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_activity_id uuid) to postgres;
grant execute on function vortex_access.revoke_organization_direct_record_share(p_organization_id uuid, p_direct_share_id uuid, p_expected_revision bigint, p_reason text, p_changed_by uuid, p_correlation_id uuid, p_activity_id uuid) to postgres;
grant execute on function vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_access.revoke_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_activity_id uuid) to postgres;
grant execute on function vortex_access.revoke_record_share_for_administration(p_direct_share_id uuid, p_expected_revision bigint, p_reason text, p_activity_id uuid) to postgres;
grant execute on function vortex_access.save_organization_settings_record_for_administration(p_record_id uuid, p_expected_revision bigint, p_core_values jsonb, p_extension_values jsonb) to postgres;
grant execute on function vortex_access.set_capability_limit_allocation(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_assignment_id uuid, p_capability_key text, p_unit text, p_quantity_limit numeric, p_expires_at timestamp with time zone, p_expected_revision bigint, p_activity_id uuid) to postgres;
grant execute on function vortex_access.set_capability_policy_ceiling(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_policy_id uuid, p_policy_revision bigint, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_expected_revision bigint) to postgres;
grant execute on function vortex_access.suspend_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_access.typed_condition_temporal_value_internal(p_value text, p_kind text) to postgres;
grant execute on function vortex_access.typed_condition_value_matches_internal(p_value jsonb, p_semantic_type text, p_nullable boolean) to postgres;
grant execute on function vortex_access.update_own_profile(p_organization_account_id uuid, p_expected_revision bigint, p_display_name text, p_language text, p_time_zone text, p_activity_id uuid) to postgres;
grant execute on function vortex_access.validate_organization_delegation_authority() to postgres;
grant execute on function vortex_access.validate_organization_delegation_bounded_permissions(p_organization_id uuid, p_permissions jsonb) to postgres;
grant execute on function vortex_access.validate_organization_direct_record_share_insert() to postgres;
grant execute on function vortex_access.validate_organization_group_membership_insert() to postgres;
grant execute on function vortex_access.validate_organization_role_activation_insert() to postgres;
grant execute on function vortex_access.validate_organization_role_assignment_insert() to postgres;
grant execute on function vortex_access.validated_durable_system_request_context(p_operation_key text, p_flow_id uuid) to postgres;
grant execute on function vortex_access.validated_human_request_context() to postgres;
grant execute on function vortex_access.withdraw_application_permission_registration_v1_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) to postgres;
grant execute on function vortex_access.withdraw_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_reason text, p_activity_id uuid) to postgres;
grant execute on function vortex_definition.accepted_contract_version(p_kind text) to postgres;
grant execute on function vortex_definition.append_application_installation_activity_internal(p_activity_id uuid, p_application_root_id uuid, p_action text) to postgres;
grant execute on function vortex_definition.append_release(p_root_id uuid, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_release jsonb) to postgres;
grant execute on function vortex_definition.claim_organization_setup_source_manifest(p_tenant_id uuid, p_organization_id uuid, p_organization_account_id uuid, p_identity_id uuid, p_operation text, p_receipt_id uuid, p_command_fingerprint text, p_expected_setup_revision integer, p_manifest_canonical_text text, p_manifest_fingerprint text) to postgres;
grant execute on function vortex_definition.create_root(p_kind text, p_key text, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb, p_application_origin_kind text) to postgres;
grant execute on function vortex_definition.flow_target_dependency_reference(p_dependency jsonb) to postgres;
grant execute on function vortex_definition.is_current_application_address_release(p_release_revision bigint) to postgres;
grant execute on function vortex_definition.list_release_history(p_kind text, p_root_id uuid, p_page_size integer, p_before_release_revision bigint) to postgres;
grant execute on function vortex_definition.lock_application_page_adoption_draft_internal(p_root_id uuid, p_expected_draft_revision bigint, p_expected_release_revision bigint) to postgres;
grant execute on function vortex_definition.private_form_draft_expiry_internal(p_touched_at timestamp with time zone) to postgres;
grant execute on function vortex_definition.private_form_draft_key_is_valid(p_key text) to postgres;
grant execute on function vortex_definition.private_form_draft_purge_internal(p_organization_id uuid, p_limit integer) to postgres;
grant execute on function vortex_definition.private_form_draft_to_json_internal(d vortex_definition.form_drafts, p_state text) to postgres;
grant execute on function vortex_definition.private_form_draft_validation_is_valid(p_validation jsonb) to postgres;
grant execute on function vortex_definition.private_form_draft_values_are_valid(p_values jsonb) to postgres;
grant execute on function vortex_definition.project_consumer_release_evidence(p_kind text, p_root_id uuid, p_release_revision bigint) to postgres;
grant execute on function vortex_definition.protect_root_identity() to postgres;
grant execute on function vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) to postgres;
grant execute on function vortex_definition.read_application_bound_release_set(p_application_release_revision bigint) to postgres;
grant execute on function vortex_definition.read_builder_application_root_classification(p_root_id uuid) to postgres;
grant execute on function vortex_definition.read_builder_application_root_key(p_root_id uuid) to postgres;
grant execute on function vortex_definition.read_consumer_release(p_kind text, p_root_id uuid, p_release_revision bigint) to postgres;
grant execute on function vortex_definition.read_first_install_application_release_set(p_application_root_id uuid, p_application_release_revision bigint) to postgres;
grant execute on function vortex_definition.read_module_release(p_root_id uuid, p_release_revision bigint) to postgres;
grant execute on function vortex_definition.read_module_release_page(p_key text, p_anchor_release_revision bigint, p_after_release_revision bigint, p_page_size integer) to postgres;
grant execute on function vortex_definition.read_publication_history_page(p_root_id uuid, p_anchor_release_revision bigint, p_after_release_revision bigint, p_page_size integer) to postgres;
grant execute on function vortex_definition.read_publication_state(p_root_id uuid) to postgres;
grant execute on function vortex_definition.read_release_history_entry(p_kind text, p_root_id uuid, p_release_revision bigint) to postgres;
grant execute on function vortex_definition.read_restore_release_evidence(p_kind text, p_root_id uuid, p_release_revision bigint) to postgres;
grant execute on function vortex_definition.read_saved_condition_history(p_root_id uuid) to postgres;
grant execute on function vortex_definition.read_system_application_bound_release_set(p_application_root_id uuid, p_application_release_revision bigint) to postgres;
grant execute on function vortex_definition.record_source_identities(p_root_id uuid, p_requirements jsonb, p_actor_id uuid, p_operation_at timestamp with time zone) to postgres;
grant execute on function vortex_definition.refuse_release_mutation() to postgres;
grant execute on function vortex_definition.refuse_source_identity_mutation() to postgres;
grant execute on function vortex_definition.restore_release_draft(p_kind text, p_root_id uuid, p_target_release_revision bigint, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_identity_requirements jsonb) to postgres;
grant execute on function vortex_definition.save_draft(p_root_id uuid, p_expected_revision bigint, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb) to postgres;
grant execute on function vortex_definition.validate_draft_write() to postgres;
grant execute on function vortex_definition.validate_release_insert() to postgres;
grant execute on function vortex_definition.validated_builder_evidence_read_context_internal() to postgres;
grant execute on function vortex_definition.validated_system_context() to postgres;
grant execute on function vortex_identity.adopt_organization(p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_steward_identity_id uuid, p_organization_account_id uuid) to postgres;
grant execute on function vortex_identity.adopt_tenant(p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_tenant_steward_identity_id uuid) to postgres;
grant execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_identity_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_identity.apply_configured_tenant_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_identity.archive_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_identity.assert_organization_runtime_settings_values(p_language text, p_time_zone text, p_currency text, p_date_format text, p_number_format text) to postgres;
grant execute on function vortex_identity.begin_identity_disablement(p_actor_identity_id uuid, p_subject_identity_id uuid, p_command_id uuid, p_command_fingerprint text, p_correlation_id uuid) to postgres;
grant execute on function vortex_identity.bootstrap_vortex_super_administrator(p_operator_actor_id uuid, p_duplicate_key uuid, p_identity_id uuid) to postgres;
grant execute on function vortex_identity.change_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) to postgres;
grant execute on function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) to postgres;
grant execute on function vortex_identity.grant_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_subject_identity_id uuid, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) to postgres;
grant execute on function vortex_identity.grant_vortex_super_administrator(p_duplicate_key uuid, p_identity_id uuid) to postgres;
grant execute on function vortex_identity.list_organization_launcher(p_identity_id uuid) to postgres;
grant execute on function vortex_identity.list_organizations_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_identity.list_tenant_administrator_assignments(p_tenant_id uuid, p_limit integer, p_after uuid) to postgres;
grant execute on function vortex_identity.list_tenant_administrators_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_identity.list_tenant_hierarchy(p_tenant_id uuid, p_limit integer, p_after uuid) to postgres;
grant execute on function vortex_identity.list_tenant_launcher(p_limit integer, p_after uuid) to postgres;
grant execute on function vortex_identity.list_tenants_projection(p_record_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_identity.list_vortex_super_administrator_assignments(p_limit integer, p_after uuid) to postgres;
grant execute on function vortex_identity.lock_organization_tenant() to postgres;
grant execute on function vortex_identity.protect_identity_disablement_command() to postgres;
grant execute on function vortex_identity.protect_identity_projection() to postgres;
grant execute on function vortex_identity.protect_organization_account() to postgres;
grant execute on function vortex_identity.protect_organization_identity() to postgres;
grant execute on function vortex_identity.protect_organization_invitation() to postgres;
grant execute on function vortex_identity.protect_super_administrator_account_provenance() to postgres;
grant execute on function vortex_identity.protect_tenant_identity() to postgres;
grant execute on function vortex_identity.protect_vortex_super_administrator_assignment() to postgres;
grant execute on function vortex_identity.provision_tenant(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_tenant_short_name text, p_tenant_display_name text, p_organization_short_name text, p_organization_display_name text, p_tenant_steward_identity_id uuid, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) to postgres;
grant execute on function vortex_identity.reactivate_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_identity.read_organization_setup_receipt(p_receipt_id uuid, p_expected_operation text, p_expected_organization_id uuid) to postgres;
grant execute on function vortex_identity.read_tenant_organization(p_tenant_id uuid, p_organization_id uuid) to postgres;
grant execute on function vortex_identity.refuse_identity_disablement_record_change() to postgres;
grant execute on function vortex_identity.refuse_organization_cycle() to postgres;
grant execute on function vortex_identity.rename_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_display_name text) to postgres;
grant execute on function vortex_identity.reparent_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_parent_organization_id uuid) to postgres;
grant execute on function vortex_identity.require_current_tenant_capability(p_identity_id uuid, p_tenant_id uuid, p_capability_key text, p_evaluated_at timestamp with time zone) to postgres;
grant execute on function vortex_identity.require_identity_not_disabled(p_identity_id uuid) to postgres;
grant execute on function vortex_identity.require_request_identity_not_disabled() to postgres;
grant execute on function vortex_identity.resolve_active_organization_account(p_identity_id uuid, p_organization_id uuid) to postgres;
grant execute on function vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(p_identity_id uuid, p_checked_at timestamp with time zone) to postgres;
grant execute on function vortex_identity.revoke_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_identity.revoke_vortex_super_administrator(p_duplicate_key uuid, p_assignment_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_identity.start_disabled_identity_projection_suspended() to postgres;
grant execute on function vortex_identity.subject_revisions_are_valid(p_subject_ids uuid[], p_subject_revisions bigint[]) to postgres;
grant execute on function vortex_identity.suspend_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;
grant execute on function vortex_identity.tenant_capabilities_from_json(p_capabilities jsonb) to postgres;
grant execute on function vortex_identity.tenant_request_actor_id() to postgres;
grant execute on function vortex_identity.tenant_structural_capability_set_is_canonical(p_capability_keys text[]) to postgres;
grant execute on function vortex_identity.validated_human_account_context() to postgres;
grant execute on function vortex_platform.accept_flow_start_intent(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_application_release_version text, p_flow_owner_kind text, p_flow_owner_root_id uuid, p_flow_release_revision bigint, p_flow_release_version text, p_flow_id uuid, p_source_kind text, p_source_id uuid, p_trigger_type text, p_trigger_id text, p_inputs jsonb, p_trigger_values jsonb) to postgres;
grant execute on function vortex_platform.advance_file_metadata_revision() to postgres;
grant execute on function vortex_platform.alert_signal_builder_key_is_valid(p_key text) to postgres;
grant execute on function vortex_platform.alert_signal_namespaced_key_is_valid(p_key text) to postgres;
grant execute on function vortex_platform.append_application_grant_activity_internal(p_context jsonb, p_activity_id uuid, p_connection_instance_id uuid, p_application_root_id uuid, p_action text, p_occurred_at timestamp with time zone) to postgres;
grant execute on function vortex_platform.append_connection_instance_activity_internal(p_context jsonb, p_activity_id uuid, p_connection_instance_id uuid, p_action text, p_occurred_at timestamp with time zone) to postgres;
grant execute on function vortex_platform.append_file_activity_internal(p_action text, p_subject_id uuid) to postgres;
grant execute on function vortex_platform.application_root_id(required boolean) to postgres;
grant execute on function vortex_platform.change_topic(p_organization_id uuid, p_application_root_id uuid) to postgres;
grant execute on function vortex_platform.channel() to postgres;
grant execute on function vortex_platform.current_context() to postgres;
grant execute on function vortex_platform.decide_file_read(p_file_id uuid) to postgres;
grant execute on function vortex_platform.enforce_file_application_root() to postgres;
grant execute on function vortex_platform.enforce_grant_application_root() to postgres;
grant execute on function vortex_platform.file_activity_id(p_action text, p_organization_id uuid, p_correlation_id uuid, p_subject_id uuid) to postgres;
grant execute on function vortex_platform.flow_registration_to_json_internal(r vortex_platform.flow_registrations) to postgres;
grant execute on function vortex_platform.format_timestamp_utc(p_value timestamp with time zone) to postgres;
grant execute on function vortex_platform.grant_connection_application_internal(p_connection_instance_id uuid, p_application_root_id uuid, p_administrator_activity_id uuid) to postgres;
grant execute on function vortex_platform.identity_authority_id(required boolean) to postgres;
grant execute on function vortex_platform.initialize(candidate jsonb) to postgres;
grant execute on function vortex_platform.is_non_nil_uuid(candidate text) to postgres;
grant execute on function vortex_platform.list_connection_instances_for_administration(p_organization_id uuid, p_after_connection_instance_id uuid, p_page_size integer) to postgres;
grant execute on function vortex_platform.organization_id() to postgres;
grant execute on function vortex_platform.publish_change_notice(p_organization_id uuid, p_application_root_id uuid, p_record_type_id uuid, p_record_id uuid, p_record_version bigint, p_change_kind text, p_data_version bigint, p_sequence bigint, p_correlation_id uuid) to postgres;
grant execute on function vortex_platform.read_active_connection_evidence(p_connection_instance_id uuid) to postgres;
grant execute on function vortex_platform.read_connection_instance_for_administration(p_organization_id uuid, p_connection_instance_id uuid) to postgres;
grant execute on function vortex_platform.read_file_application(p_file_id uuid) to postgres;
grant execute on function vortex_platform.read_protected_node_effect(p_run_id uuid, p_organization_id uuid, p_identity_id uuid, p_task_path text, p_iteration text, p_operation_key text) to postgres;
grant execute on function vortex_platform.read_protected_workflow_run(p_run_id uuid) to postgres;
grant execute on function vortex_platform.read_protected_workflow_run_registration(p_run_id uuid) to postgres;
grant execute on function vortex_platform.refresh_protected_workflow_run_state(p_run_id uuid, p_state text, p_refreshed_at timestamp with time zone) to postgres;
grant execute on function vortex_platform.refuse_event_outbox_change() to postgres;
grant execute on function vortex_platform.register_workflow_flow_candidate(p_environment text, p_organization_id uuid, p_application_root_id uuid, p_application_version text, p_installation_revision bigint, p_workflow_revision bigint, p_candidate jsonb) to postgres;
grant execute on function vortex_platform.reserve_file_upload(p_file_id uuid, p_organization_id uuid, p_application_root_id uuid, p_owner_record_type_id uuid, p_owner_record_id uuid, p_owner_field_id uuid, p_original_safe_display_name text, p_extension text, p_storage_key text, p_uploaded_by jsonb, p_maximum_bytes bigint, p_max_files integer, p_existing_attachment_count integer, p_replacing_file_id uuid, p_capability_reservation_id uuid, p_one_time_id uuid, p_policy_fingerprint text, p_grant_expires_at timestamp with time zone, p_upload_expires_at timestamp with time zone) to postgres;
grant execute on function vortex_platform.resolve_connection_instance_readiness(p_organization_id uuid, p_application_root_id uuid, p_connection_instance_id uuid, p_destination_key text, p_expected_revision bigint, p_expected_fingerprint text) to postgres;
grant execute on function vortex_platform.start_value_matches_type_internal(p_type text, p_value jsonb) to postgres;
grant execute on function vortex_platform.topic_application_root_id(p_topic text) to postgres;
grant execute on function vortex_platform.topic_organization_id(p_topic text) to postgres;
grant execute on function vortex_platform.upload_file_record(p_file vortex_platform.file_records) to postgres;
grant execute on function vortex_platform.upload_maximum_bytes_limit() to postgres;
grant execute on function vortex_platform.upload_refusal(p_reason text) to postgres;
grant execute on function vortex_platform.upload_request_actor(p_context jsonb) to postgres;
grant execute on function vortex_platform.uuid_array_is_canonical(p_values uuid[]) to postgres;
grant execute on function vortex_platform.validated(candidate jsonb) to postgres;
grant execute on function vortex_platform.validated_service_context() to postgres;
grant execute on function vortex_platform.write_protected_workflow_run(p_run_id uuid, p_organization_id uuid, p_identity_id uuid, p_run_record jsonb) to postgres;
grant execute on function vortex_record.append_base_save_activity_internal(p_activity_id uuid, p_operation text, p_subject_id uuid, p_changed_field_ids uuid[], p_outcome text) to postgres;
grant execute on function vortex_record.append_lifecycle_policy_activity_internal(p_activity_id uuid, p_policy_id uuid) to postgres;
grant execute on function vortex_record.append_named_action_activity_internal(p_activity_id uuid, p_subject_id uuid, p_changed_field_ids uuid[], p_outcome text) to postgres;
grant execute on function vortex_record.append_organization_activity_entry(p_organization_id uuid, p_activity_id uuid, p_occurred_at timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_subject_ids uuid[], p_changed_field_ids uuid[], p_source text, p_correlation_id uuid, p_outcome text) to postgres;
grant execute on function vortex_record.append_ownership_transfer_activity_internal(p_activity_id uuid, p_subject_id uuid, p_outcome text) to postgres;
grant execute on function vortex_record.append_record_lifecycle_activity_internal(p_activity_id uuid, p_operation text, p_subject_ids uuid[]) to postgres;
grant execute on function vortex_record.document_entries_are_valid(p_entries jsonb) to postgres;
grant execute on function vortex_record.enforce_document_application_root() to postgres;
grant execute on function vortex_record.record_super_administrator_authority_internal() to postgres;
grant execute on function vortex_record.refuse_activity_entry_change() to postgres;
grant execute on function vortex_record.refuse_super_administrator_authority_change() to postgres;
grant execute on function vortex_platform.is_non_nil_uuid(text) to postgres;
grant execute on function vortex_platform.topic_organization_id(text) to postgres;
grant execute on function vortex_platform.topic_application_root_id(text) to postgres;

reset role;
