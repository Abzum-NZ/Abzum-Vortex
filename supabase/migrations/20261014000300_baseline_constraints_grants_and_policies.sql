--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- Primary keys create indexes, so the migration role needs CREATE until replay ends.
GRANT CREATE ON SCHEMA vortex_definition TO postgres;

SET default_tablespace = '';

--
-- Name: application_role_template_continuities application_role_template_continuities_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.application_role_template_continuities
    ADD CONSTRAINT application_role_template_continuities_pk PRIMARY KEY (organization_id, application_root_id, source_role_id);


--
-- Name: capability_limit_changes capability_limit_changes_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_limit_changes
    ADD CONSTRAINT capability_limit_changes_pkey PRIMARY KEY (change_id);


--
-- Name: capability_policy_assignments capability_policy_assignments_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_policy_assignments
    ADD CONSTRAINT capability_policy_assignments_pkey PRIMARY KEY (assignment_id);


--
-- Name: capability_policy_definitions capability_policy_definitions_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_policy_definitions
    ADD CONSTRAINT capability_policy_definitions_pkey PRIMARY KEY (policy_id, revision);


--
-- Name: capability_policy_definitions capability_policy_definitions_tenant_id_policy_id_revision_key; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_policy_definitions
    ADD CONSTRAINT capability_policy_definitions_tenant_id_policy_id_revision_key UNIQUE (tenant_id, policy_id, revision);


--
-- Name: capability_reservation_balances capability_reservation_balances_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservation_balances
    ADD CONSTRAINT capability_reservation_balances_pkey PRIMARY KEY (balance_id);


--
-- Name: capability_reservations capability_reservations_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservations
    ADD CONSTRAINT capability_reservations_pkey PRIMARY KEY (reservation_id);


--
-- Name: flow_execution_bindings flow_execution_bindings_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.flow_execution_bindings
    ADD CONSTRAINT flow_execution_bindings_pkey PRIMARY KEY (execution_binding_id, revision);


--
-- Name: flow_run_as_principals flow_run_as_principals_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.flow_run_as_principals
    ADD CONSTRAINT flow_run_as_principals_pkey PRIMARY KEY (execution_binding_id, revision);


--
-- Name: metering_events metering_events_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.metering_events
    ADD CONSTRAINT metering_events_pkey PRIMARY KEY (metering_event_id);


--
-- Name: metering_events metering_events_tenant_identity_unique; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.metering_events
    ADD CONSTRAINT metering_events_tenant_identity_unique UNIQUE (tenant_id, metering_event_id);


--
-- Name: organization_access_versions organization_access_versions_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_access_versions
    ADD CONSTRAINT organization_access_versions_pk PRIMARY KEY (organization_id);


--
-- Name: organization_delegation_authorities organization_delegation_authorities_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_delegation_authorities
    ADD CONSTRAINT organization_delegation_authorities_pk PRIMARY KEY (organization_id, delegation_authority_id);


--
-- Name: organization_direct_record_shares organization_direct_record_shares_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_direct_record_shares
    ADD CONSTRAINT organization_direct_record_shares_pk PRIMARY KEY (organization_id, direct_share_id);


--
-- Name: organization_group_memberships organization_group_memberships_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_group_memberships
    ADD CONSTRAINT organization_group_memberships_pk PRIMARY KEY (organization_id, membership_id);


--
-- Name: organization_groups organization_groups_key_unique; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_groups
    ADD CONSTRAINT organization_groups_key_unique UNIQUE (organization_id, group_key);


--
-- Name: organization_groups organization_groups_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_groups
    ADD CONSTRAINT organization_groups_pk PRIMARY KEY (organization_id, group_id);


--
-- Name: organization_role_activation_policy_revisions organization_role_activation_policy_revisions_exact_unique; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_activation_policy_revisions
    ADD CONSTRAINT organization_role_activation_policy_revisions_exact_unique UNIQUE (organization_id, role_id, activation_policy_id, revision, policy_fingerprint);


--
-- Name: organization_role_activation_policy_revisions organization_role_activation_policy_revisions_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_activation_policy_revisions
    ADD CONSTRAINT organization_role_activation_policy_revisions_pk PRIMARY KEY (organization_id, role_id, activation_policy_id, revision);


--
-- Name: organization_role_activations organization_role_activations_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_activations
    ADD CONSTRAINT organization_role_activations_pk PRIMARY KEY (organization_id, role_activation_id);


--
-- Name: organization_role_assignments organization_role_assignments_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_assignments
    ADD CONSTRAINT organization_role_assignments_pk PRIMARY KEY (organization_id, role_assignment_id);


--
-- Name: organization_role_permission_entries organization_role_permission_entries_identity_unique; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_permission_entries
    ADD CONSTRAINT organization_role_permission_entries_identity_unique UNIQUE NULLS NOT DISTINCT (organization_id, role_id, role_revision, application_root_id, owner_kind, owner_id, permission_id);


--
-- Name: organization_role_permission_entries organization_role_permission_entries_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_permission_entries
    ADD CONSTRAINT organization_role_permission_entries_pk PRIMARY KEY (organization_id, role_id, role_revision, entry_ordinal);


--
-- Name: organization_role_revisions organization_role_revisions_current_key_unique; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_revisions
    ADD CONSTRAINT organization_role_revisions_current_key_unique UNIQUE (organization_id, role_id, revision, role_key);


--
-- Name: organization_role_revisions organization_role_revisions_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_revisions
    ADD CONSTRAINT organization_role_revisions_pk PRIMARY KEY (organization_id, role_id, revision);


--
-- Name: organization_role_revisions organization_role_revisions_scope_identity_unique; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_revisions
    ADD CONSTRAINT organization_role_revisions_scope_identity_unique UNIQUE (organization_id, role_id, revision, role_kind, application_scope_id);


--
-- Name: organization_roles organization_roles_key_unique; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_roles
    ADD CONSTRAINT organization_roles_key_unique UNIQUE (organization_id, role_key);


--
-- Name: organization_roles organization_roles_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_roles
    ADD CONSTRAINT organization_roles_pk PRIMARY KEY (organization_id, role_id);


--
-- Name: organization_roles organization_roles_scope_identity_unique; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_roles
    ADD CONSTRAINT organization_roles_scope_identity_unique UNIQUE (organization_id, role_id, role_kind, application_scope_id);


--
-- Name: organization_stewardship_requirements organization_stewardship_requirements_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_stewardship_requirements
    ADD CONSTRAINT organization_stewardship_requirements_pkey PRIMARY KEY (organization_id);


--
-- Name: permission_catalogue_entries permission_catalogue_entries_owner_key_unique; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.permission_catalogue_entries
    ADD CONSTRAINT permission_catalogue_entries_owner_key_unique UNIQUE (organization_id, registration_kind, registration_owner_id, registration_revision, owner_kind, owner_id, permission_key);


--
-- Name: permission_catalogue_entries permission_catalogue_entries_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.permission_catalogue_entries
    ADD CONSTRAINT permission_catalogue_entries_pk PRIMARY KEY (organization_id, registration_kind, registration_owner_id, registration_revision, owner_kind, owner_id, permission_id);


--
-- Name: permission_continuities permission_continuities_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.permission_continuities
    ADD CONSTRAINT permission_continuities_pk PRIMARY KEY (organization_id, application_scope_id, owner_kind, owner_id, permission_id);


--
-- Name: permission_registration_revisions permission_registration_revisions_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.permission_registration_revisions
    ADD CONSTRAINT permission_registration_revisions_pk PRIMARY KEY (organization_id, registration_kind, registration_owner_id, revision);


--
-- Name: permission_registrations permission_registrations_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.permission_registrations
    ADD CONSTRAINT permission_registrations_pk PRIMARY KEY (organization_id, registration_kind, registration_owner_id);


--
-- Name: platform_permission_declarations platform_permission_declarations_key_unique; Type: CONSTRAINT; Schema: vortex_access; Owner: vortex_access_owner
--

ALTER TABLE ONLY vortex_access.platform_permission_declarations
    ADD CONSTRAINT platform_permission_declarations_key_unique UNIQUE (permission_key);


--
-- Name: platform_permission_declarations platform_permission_declarations_pk; Type: CONSTRAINT; Schema: vortex_access; Owner: vortex_access_owner
--

ALTER TABLE ONLY vortex_access.platform_permission_declarations
    ADD CONSTRAINT platform_permission_declarations_pk PRIMARY KEY (permission_id);


--
-- Name: record_share_grant_consent_decisions record_share_grant_consent_decisions_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_decisions
    ADD CONSTRAINT record_share_grant_consent_decisions_pkey PRIMARY KEY (decision_id);


--
-- Name: record_share_grant_consent_decisions record_share_grant_consent_decisions_request_revision_side_uniq; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_decisions
    ADD CONSTRAINT record_share_grant_consent_decisions_request_revision_side_uniq UNIQUE (request_id, proposal_revision, side);


--
-- Name: record_share_grant_consent_requests record_share_grant_consent_requests_grant_id_key; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_requests
    ADD CONSTRAINT record_share_grant_consent_requests_grant_id_key UNIQUE (grant_id);


--
-- Name: record_share_grant_consent_requests record_share_grant_consent_requests_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_requests
    ADD CONSTRAINT record_share_grant_consent_requests_pkey PRIMARY KEY (request_id);


--
-- Name: record_share_grants record_share_grants_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grants
    ADD CONSTRAINT record_share_grants_pkey PRIMARY KEY (grant_id);


--
-- Name: system_actor_grants system_actor_grants_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.system_actor_grants
    ADD CONSTRAINT system_actor_grants_pkey PRIMARY KEY (system_actor_grant_id);


--
-- Name: usage_projection_reconciliation usage_projection_reconciliation_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.usage_projection_reconciliation
    ADD CONSTRAINT usage_projection_reconciliation_pkey PRIMARY KEY (tenant_id, period_start, period_end);


--
-- Name: usage_projection_rollups usage_projection_rollups_pkey; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.usage_projection_rollups
    ADD CONSTRAINT usage_projection_rollups_pkey PRIMARY KEY (tenant_id, rollup_scope, scope_id, bucket_start, capability_key, unit);


--
-- Name: validation_reference_values validation_reference_values_key; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.validation_reference_values
    ADD CONSTRAINT validation_reference_values_key PRIMARY KEY (reference_list, reference_value);


--
-- Name: validation_reference_values validation_reference_values_ordinal_unique; Type: CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.validation_reference_values
    ADD CONSTRAINT validation_reference_values_ordinal_unique UNIQUE (reference_list, reference_ordinal);


--
-- Name: organization_activity_entries organization_activity_entries_pk; Type: CONSTRAINT; Schema: vortex_activity; Owner: postgres
--

ALTER TABLE ONLY vortex_activity.organization_activity_entries
    ADD CONSTRAINT organization_activity_entries_pk PRIMARY KEY (organization_id, activity_id);


--
-- Name: organization_activity_super_administrator_authority organization_activity_super_administrator_authority_pk; Type: CONSTRAINT; Schema: vortex_activity; Owner: postgres
--

ALTER TABLE ONLY vortex_activity.organization_activity_super_administrator_authority
    ADD CONSTRAINT organization_activity_super_administrator_authority_pk PRIMARY KEY (organization_id, activity_id);


--
-- Name: connection_application_grants connection_application_grants_pkey; Type: CONSTRAINT; Schema: vortex_connection; Owner: postgres
--

ALTER TABLE ONLY vortex_connection.connection_application_grants
    ADD CONSTRAINT connection_application_grants_pkey PRIMARY KEY (connection_instance_id, application_root_id);


--
-- Name: connection_instances connection_instances_id_org_unique; Type: CONSTRAINT; Schema: vortex_connection; Owner: postgres
--

ALTER TABLE ONLY vortex_connection.connection_instances
    ADD CONSTRAINT connection_instances_id_org_unique UNIQUE (connection_instance_id, organization_id);


--
-- Name: connection_instances connection_instances_org_destination_unique; Type: CONSTRAINT; Schema: vortex_connection; Owner: postgres
--

ALTER TABLE ONLY vortex_connection.connection_instances
    ADD CONSTRAINT connection_instances_org_destination_unique UNIQUE (organization_id, destination_key);


--
-- Name: connection_instances connection_instances_pkey; Type: CONSTRAINT; Schema: vortex_connection; Owner: postgres
--

ALTER TABLE ONLY vortex_connection.connection_instances
    ADD CONSTRAINT connection_instances_pkey PRIMARY KEY (connection_instance_id);


--
-- Name: request_contexts request_contexts_pk; Type: CONSTRAINT; Schema: vortex_context; Owner: postgres
--

ALTER TABLE ONLY vortex_context.request_contexts
    ADD CONSTRAINT request_contexts_pk PRIMARY KEY (backend_pid);


--
-- Name: drafts drafts_pk; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.drafts
    ADD CONSTRAINT drafts_pk PRIMARY KEY (root_id);


--
-- Name: release_dependencies release_dependencies_pk; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.release_dependencies
    ADD CONSTRAINT release_dependencies_pk PRIMARY KEY (root_id, release_revision, dependency_kind, dependency_reference, dependency_version);


--
-- Name: releases releases_pk; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.releases
    ADD CONSTRAINT releases_pk PRIMARY KEY (root_id, release_revision);


--
-- Name: releases releases_root_revision_source_fingerprint_unique; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.releases
    ADD CONSTRAINT releases_root_revision_source_fingerprint_unique UNIQUE (root_id, release_revision, authored_source_fingerprint);


--
-- Name: releases releases_root_revision_version_fingerprint_unique; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.releases
    ADD CONSTRAINT releases_root_revision_version_fingerprint_unique UNIQUE (root_id, release_revision, release_version, content_fingerprint);


--
-- Name: releases releases_root_version_unique; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.releases
    ADD CONSTRAINT releases_root_version_unique UNIQUE (root_id, release_version);


--
-- Name: roots roots_organization_kind_key_unique; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.roots
    ADD CONSTRAINT roots_organization_kind_key_unique UNIQUE (organization_id, kind, key);


--
-- Name: roots roots_organization_root_id_unique; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.roots
    ADD CONSTRAINT roots_organization_root_id_unique UNIQUE (organization_id, root_id);


--
-- Name: roots roots_pk; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.roots
    ADD CONSTRAINT roots_pk PRIMARY KEY (root_id);


--
-- Name: source_identities source_identities_owner_identity_unique; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.source_identities
    ADD CONSTRAINT source_identities_owner_identity_unique UNIQUE (root_id, owner_scope, kind, component_owner, identity_id);


--
-- Name: source_identities source_identities_owner_unique; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.source_identities
    ADD CONSTRAINT source_identities_owner_unique UNIQUE (root_id, owner_scope, kind, component_owner);


--
-- Name: source_identities source_identities_pk; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.source_identities
    ADD CONSTRAINT source_identities_pk PRIMARY KEY (identity_id);


--
-- Name: source_identity_aliases source_identity_aliases_pk; Type: CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.source_identity_aliases
    ADD CONSTRAINT source_identity_aliases_pk PRIMARY KEY (root_id, scope, kind, alias);


--
-- Name: consumer_occurrence_progress consumer_occurrence_progress_pkey; Type: CONSTRAINT; Schema: vortex_event; Owner: postgres
--

ALTER TABLE ONLY vortex_event.consumer_occurrence_progress
    ADD CONSTRAINT consumer_occurrence_progress_pkey PRIMARY KEY (consumer_key, occurrence_id);


--
-- Name: event_outbox event_outbox_pkey; Type: CONSTRAINT; Schema: vortex_event; Owner: postgres
--

ALTER TABLE ONLY vortex_event.event_outbox
    ADD CONSTRAINT event_outbox_pkey PRIMARY KEY (occurrence_id);


--
-- Name: download_grants download_grants_pkey; Type: CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.download_grants
    ADD CONSTRAINT download_grants_pkey PRIMARY KEY (one_time_id);


--
-- Name: file_records file_records_pkey; Type: CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.file_records
    ADD CONSTRAINT file_records_pkey PRIMARY KEY (file_id);


--
-- Name: upload_grants upload_grants_pkey; Type: CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.upload_grants
    ADD CONSTRAINT upload_grants_pkey PRIMARY KEY (one_time_id);


--
-- Name: upload_reservations upload_reservations_pkey; Type: CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.upload_reservations
    ADD CONSTRAINT upload_reservations_pkey PRIMARY KEY (file_id);


--
-- Name: accepted_administration_receipts accepted_administration_receipts_pkey; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.accepted_administration_receipts
    ADD CONSTRAINT accepted_administration_receipts_pkey PRIMARY KEY (receipt_id);


--
-- Name: identity_disablement_commands identity_disablement_commands_pkey; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.identity_disablement_commands
    ADD CONSTRAINT identity_disablement_commands_pkey PRIMARY KEY (command_id);


--
-- Name: identity_disablement_events identity_disablement_events_pkey; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.identity_disablement_events
    ADD CONSTRAINT identity_disablement_events_pkey PRIMARY KEY (event_id);


--
-- Name: identity_projections identity_projections_pk; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.identity_projections
    ADD CONSTRAINT identity_projections_pk PRIMARY KEY (identity_id);


--
-- Name: organization_accounts organization_accounts_organization_account_unique; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_accounts
    ADD CONSTRAINT organization_accounts_organization_account_unique UNIQUE (organization_id, organization_account_id);


--
-- Name: organization_accounts organization_accounts_organization_identity_unique; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_accounts
    ADD CONSTRAINT organization_accounts_organization_identity_unique UNIQUE (organization_id, identity_id);


--
-- Name: organization_accounts organization_accounts_pk; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_accounts
    ADD CONSTRAINT organization_accounts_pk PRIMARY KEY (organization_account_id);


--
-- Name: organization_invitations organization_invitations_organization_invitation_unique; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_invitations
    ADD CONSTRAINT organization_invitations_organization_invitation_unique UNIQUE (organization_id, invitation_id);


--
-- Name: organization_invitations organization_invitations_pk; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_invitations
    ADD CONSTRAINT organization_invitations_pk PRIMARY KEY (invitation_id);


--
-- Name: organization_invitations organization_invitations_token_fingerprint_unique; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_invitations
    ADD CONSTRAINT organization_invitations_token_fingerprint_unique UNIQUE (token_fingerprint);


--
-- Name: organization_runtime_settings organization_runtime_settings_pkey; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_runtime_settings
    ADD CONSTRAINT organization_runtime_settings_pkey PRIMARY KEY (organization_id);


--
-- Name: organizations organizations_pk; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organizations
    ADD CONSTRAINT organizations_pk PRIMARY KEY (organization_id);


--
-- Name: organizations organizations_short_name_per_tenant_unique; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organizations
    ADD CONSTRAINT organizations_short_name_per_tenant_unique UNIQUE (tenant_id, short_name);


--
-- Name: organizations organizations_tenant_identity_unique; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organizations
    ADD CONSTRAINT organizations_tenant_identity_unique UNIQUE (tenant_id, organization_id);


--
-- Name: tenant_administrator_assignments tenant_administrator_assignments_pkey; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.tenant_administrator_assignments
    ADD CONSTRAINT tenant_administrator_assignments_pkey PRIMARY KEY (assignment_id);


--
-- Name: tenants tenants_pk; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.tenants
    ADD CONSTRAINT tenants_pk PRIMARY KEY (tenant_id);


--
-- Name: tenants tenants_short_name_unique; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.tenants
    ADD CONSTRAINT tenants_short_name_unique UNIQUE (short_name);


--
-- Name: vortex_super_administrator_assignment_receipts vortex_super_administrator_assignment_receipts_pk; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.vortex_super_administrator_assignment_receipts
    ADD CONSTRAINT vortex_super_administrator_assignment_receipts_pk PRIMARY KEY (actor_kind, actor_id, operation_key, duplicate_key);


--
-- Name: vortex_super_administrator_assignments vortex_super_administrator_assignments_id_identity_unique; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.vortex_super_administrator_assignments
    ADD CONSTRAINT vortex_super_administrator_assignments_id_identity_unique UNIQUE (assignment_id, identity_id);


--
-- Name: vortex_super_administrator_assignments vortex_super_administrator_assignments_pk; Type: CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.vortex_super_administrator_assignments
    ADD CONSTRAINT vortex_super_administrator_assignments_pk PRIMARY KEY (assignment_id);


--
-- Name: installation_bindings installation_bindings_pkey; Type: CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.installation_bindings
    ADD CONSTRAINT installation_bindings_pkey PRIMARY KEY (organization_id, application_root_id, module_root_id);


--
-- Name: installation_runtime_bundle_parts installation_runtime_bundle_parts_pk; Type: CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.installation_runtime_bundle_parts
    ADD CONSTRAINT installation_runtime_bundle_parts_pk PRIMARY KEY (organization_id, application_root_id, application_release_revision, bundle_format_version, section, ordinal);


--
-- Name: installation_runtime_bundles installation_runtime_bundles_pk; Type: CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.installation_runtime_bundles
    ADD CONSTRAINT installation_runtime_bundles_pk PRIMARY KEY (organization_id, application_root_id, application_release_revision, bundle_format_version);


--
-- Name: organization_setup_source_manifests organization_setup_source_manifests_organization_id_key; Type: CONSTRAINT; Schema: vortex_module; Owner: postgres
--

ALTER TABLE ONLY vortex_module.organization_setup_source_manifests
    ADD CONSTRAINT organization_setup_source_manifests_organization_id_key UNIQUE (organization_id);


--
-- Name: organization_setup_source_manifests organization_setup_source_manifests_pkey; Type: CONSTRAINT; Schema: vortex_module; Owner: postgres
--

ALTER TABLE ONLY vortex_module.organization_setup_source_manifests
    ADD CONSTRAINT organization_setup_source_manifests_pkey PRIMARY KEY (checkpoint_id);


--
-- Name: organization_setup_source_manifests organization_setup_source_manifests_receipt_id_key; Type: CONSTRAINT; Schema: vortex_module; Owner: postgres
--

ALTER TABLE ONLY vortex_module.organization_setup_source_manifests
    ADD CONSTRAINT organization_setup_source_manifests_receipt_id_key UNIQUE (receipt_id);


--
-- Name: preview_installations preview_installations_pkey; Type: CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.preview_installations
    ADD CONSTRAINT preview_installations_pkey PRIMARY KEY (preview_installation_id);


--
-- Name: alert_signals alert_signals_deduplication_key_unique; Type: CONSTRAINT; Schema: vortex_operations; Owner: postgres
--

ALTER TABLE ONLY vortex_operations.alert_signals
    ADD CONSTRAINT alert_signals_deduplication_key_unique UNIQUE (deduplication_key);


--
-- Name: alert_signals alert_signals_pkey; Type: CONSTRAINT; Schema: vortex_operations; Owner: postgres
--

ALTER TABLE ONLY vortex_operations.alert_signals
    ADD CONSTRAINT alert_signals_pkey PRIMARY KEY (signal_id);


--
-- Name: form_drafts form_drafts_pkey; Type: CONSTRAINT; Schema: vortex_page; Owner: postgres
--

ALTER TABLE ONLY vortex_page.form_drafts
    ADD CONSTRAINT form_drafts_pkey PRIMARY KEY (draft_id);


--
-- Name: command_receipts command_receipts_pk; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE ONLY vortex_record.command_receipts
    ADD CONSTRAINT command_receipts_pk PRIMARY KEY (organization_id, application_root_id, actor_organization_account_id, command_kind, command_id);


--
-- Name: field_storage_mappings field_storage_mappings_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.field_storage_mappings
    ADD CONSTRAINT field_storage_mappings_pkey PRIMARY KEY (storage_contract_id, field_id);


--
-- Name: field_storage_mappings field_storage_mappings_storage_contract_id_physical_column__key; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.field_storage_mappings
    ADD CONSTRAINT field_storage_mappings_storage_contract_id_physical_column__key UNIQUE (storage_contract_id, physical_column_token);


--
-- Name: index_catalogue index_catalogue_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.index_catalogue
    ADD CONSTRAINT index_catalogue_pkey PRIMARY KEY (index_contract_id);


--
-- Name: index_catalogue index_catalogue_storage_contract_id_field_id_key; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.index_catalogue
    ADD CONSTRAINT index_catalogue_storage_contract_id_field_id_key UNIQUE (storage_contract_id, field_id);


--
-- Name: installation_access_plans installation_access_plans_pk; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE ONLY vortex_record.installation_access_plans
    ADD CONSTRAINT installation_access_plans_pk PRIMARY KEY (plan_key);


--
-- Name: legal_hold_versions legal_hold_versions_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.legal_hold_versions
    ADD CONSTRAINT legal_hold_versions_pkey PRIMARY KEY (tenant_id, organization_id, hold_id, hold_revision);


--
-- Name: organization_lifecycle_limits organization_lifecycle_limits_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.organization_lifecycle_limits
    ADD CONSTRAINT organization_lifecycle_limits_pkey PRIMARY KEY (organization_id);


--
-- Name: preview_command_receipts preview_command_receipts_pk; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE ONLY vortex_record.preview_command_receipts
    ADD CONSTRAINT preview_command_receipts_pk PRIMARY KEY (preview_installation_id, command_kind, command_id);


--
-- Name: preview_reference_counters preview_reference_counters_pk; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE ONLY vortex_record.preview_reference_counters
    ADD CONSTRAINT preview_reference_counters_pk PRIMARY KEY (preview_installation_id, storage_contract_id, field_id);


--
-- Name: preview_storage_bindings preview_storage_bindings_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.preview_storage_bindings
    ADD CONSTRAINT preview_storage_bindings_pkey PRIMARY KEY (preview_installation_id, record_type_id);


--
-- Name: preview_storage_bindings preview_storage_bindings_preview_installation_id_release_st_key; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.preview_storage_bindings
    ADD CONSTRAINT preview_storage_bindings_preview_installation_id_release_st_key UNIQUE (preview_installation_id, release_storage_contract_id);


--
-- Name: preview_storage_bindings preview_storage_bindings_storage_contract_id_key; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.preview_storage_bindings
    ADD CONSTRAINT preview_storage_bindings_storage_contract_id_key UNIQUE (storage_contract_id);


--
-- Name: protected_read_model_views protected_read_model_views_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.protected_read_model_views
    ADD CONSTRAINT protected_read_model_views_pkey PRIMARY KEY (protected_read_model_key);


--
-- Name: record_lifecycle_command_effects record_lifecycle_command_effects_pk; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE ONLY vortex_record.record_lifecycle_command_effects
    ADD CONSTRAINT record_lifecycle_command_effects_pk PRIMARY KEY (organization_id, application_root_id, actor_organization_account_id, command_id, effect_sequence);


--
-- Name: record_reference_counters record_reference_counters_organization_id_storage_contract__key; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.record_reference_counters
    ADD CONSTRAINT record_reference_counters_organization_id_storage_contract__key UNIQUE NULLS NOT DISTINCT (organization_id, storage_contract_id, field_id, application_root_id);


--
-- Name: record_reference_counters record_reference_counters_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.record_reference_counters
    ADD CONSTRAINT record_reference_counters_pkey PRIMARY KEY (counter_id);


--
-- Name: record_type_lifecycle_policies record_type_lifecycle_policies_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.record_type_lifecycle_policies
    ADD CONSTRAINT record_type_lifecycle_policies_pkey PRIMARY KEY (policy_id);


--
-- Name: record_type_lifecycle_policies record_type_lifecycle_policies_scope_unique; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.record_type_lifecycle_policies
    ADD CONSTRAINT record_type_lifecycle_policies_scope_unique UNIQUE NULLS NOT DISTINCT (organization_id, storage_contract_id, application_root_id);


--
-- Name: relationship_edges relationship_edges_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.relationship_edges
    ADD CONSTRAINT relationship_edges_pkey PRIMARY KEY (relationship_id, from_organisation_id, from_record_id, to_storage_contract_id, to_record_id);


--
-- Name: relationship_storage_mappings relationship_storage_mappings_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.relationship_storage_mappings
    ADD CONSTRAINT relationship_storage_mappings_pkey PRIMARY KEY (relationship_id);


--
-- Name: release_provisions release_provisions_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.release_provisions
    ADD CONSTRAINT release_provisions_pkey PRIMARY KEY (module_root_id, release_revision);


--
-- Name: storage_catalogue storage_catalogue_physical_table_token_key; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_catalogue
    ADD CONSTRAINT storage_catalogue_physical_table_token_key UNIQUE (physical_table_token);


--
-- Name: storage_catalogue storage_catalogue_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_catalogue
    ADD CONSTRAINT storage_catalogue_pkey PRIMARY KEY (storage_contract_id);


--
-- Name: storage_conversion_catalogue storage_conversion_catalogue_pkey; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_conversion_catalogue
    ADD CONSTRAINT storage_conversion_catalogue_pkey PRIMARY KEY (conversion_contract_id);


--
-- Name: storage_conversion_catalogue storage_conversion_catalogue_source_storage_contract_id_sou_key; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_conversion_catalogue
    ADD CONSTRAINT storage_conversion_catalogue_source_storage_contract_id_sou_key UNIQUE (source_storage_contract_id, source_field_id, target_field_id);


--
-- Name: storage_conversion_plans storage_conversion_plans_conversion_contract_id_organisatio_key; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_conversion_plans
    ADD CONSTRAINT storage_conversion_plans_conversion_contract_id_organisatio_key UNIQUE NULLS NOT DISTINCT (conversion_contract_id, organisation_id, application_root_id);


--
-- Name: storage_conversion_progress storage_conversion_progress_conversion_contract_id_organisa_key; Type: CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_conversion_progress
    ADD CONSTRAINT storage_conversion_progress_conversion_contract_id_organisa_key UNIQUE NULLS NOT DISTINCT (conversion_contract_id, organisation_id, application_root_id, record_id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: vortex_search; Owner: postgres
--

ALTER TABLE ONLY vortex_search.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (organization_id, record_type_id, record_id);


--
-- Name: flow_continuations flow_continuations_pk; Type: CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.flow_continuations
    ADD CONSTRAINT flow_continuations_pk PRIMARY KEY (token_hash);


--
-- Name: flow_effect_ledger flow_effect_ledger_pk; Type: CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.flow_effect_ledger
    ADD CONSTRAINT flow_effect_ledger_pk PRIMARY KEY (run_id, task_path, iteration);


--
-- Name: flow_registrations flow_registrations_pk; Type: CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.flow_registrations
    ADD CONSTRAINT flow_registrations_pk PRIMARY KEY (environment, organization_id, application_root_id, application_version, installation_revision, workflow_revision, flow_id);


--
-- Name: flow_start_intents flow_start_intents_duplicate; Type: CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.flow_start_intents
    ADD CONSTRAINT flow_start_intents_duplicate UNIQUE (organization_id, source_kind, source_id, application_root_id, application_release_revision, flow_owner_root_id, flow_release_revision, flow_id, trigger_type, trigger_id);


--
-- Name: flow_start_intents flow_start_intents_pkey; Type: CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.flow_start_intents
    ADD CONSTRAINT flow_start_intents_pkey PRIMARY KEY (intent_id);


--
-- Name: protected_workflow_runs protected_workflow_runs_pk; Type: CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.protected_workflow_runs
    ADD CONSTRAINT protected_workflow_runs_pk PRIMARY KEY (run_id);


--
-- Name: application_role_template_continuities_registration_revision_id; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX application_role_template_continuities_registration_revision_id ON vortex_access.application_role_template_continuities USING btree (organization_id, registration_kind, application_root_id, last_processed_registration_revision);


--
-- Name: capability_limit_changes_assignment_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX capability_limit_changes_assignment_idx ON vortex_access.capability_limit_changes USING btree (assignment_id) WHERE (assignment_id IS NOT NULL);


--
-- Name: capability_limit_changes_scope_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX capability_limit_changes_scope_idx ON vortex_access.capability_limit_changes USING btree (tenant_id, capability_key, unit, occurred_at);


--
-- Name: capability_policy_assignments_effective_scope_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX capability_policy_assignments_effective_scope_idx ON vortex_access.capability_policy_assignments USING btree (tenant_id, organization_id, capability_key, unit, starts_at, expires_at) WHERE (revoked_at IS NULL);


--
-- Name: capability_policy_assignments_live_scope_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX capability_policy_assignments_live_scope_unique ON vortex_access.capability_policy_assignments USING btree (tenant_id, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), capability_key, unit, assignment_kind) WHERE (revoked_at IS NULL);


--
-- Name: capability_policy_definitions_tenant_scope_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX capability_policy_definitions_tenant_scope_idx ON vortex_access.capability_policy_definitions USING btree (tenant_id, capability_key, unit, policy_id, revision);


--
-- Name: capability_reservation_balances_scope_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX capability_reservation_balances_scope_unique ON vortex_access.capability_reservation_balances USING btree (tenant_id, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), capability_key, unit);


--
-- Name: capability_reservation_commands_reservation_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX capability_reservation_commands_reservation_idx ON vortex_access.capability_reservation_commands USING btree (reservation_id, operation_kind);


--
-- Name: capability_reservation_commands_scope_key_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX capability_reservation_commands_scope_key_unique ON vortex_access.capability_reservation_commands USING btree (tenant_id, COALESCE(request_organization_id, '00000000-0000-0000-0000-000000000000'::uuid), duplicate_key);


--
-- Name: capability_reservations_assignment_state_expires_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX capability_reservations_assignment_state_expires_idx ON vortex_access.capability_reservations USING btree (assignment_id, state, expires_at);


--
-- Name: capability_reservations_request_scope_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX capability_reservations_request_scope_idx ON vortex_access.capability_reservations USING btree (tenant_id, COALESCE(request_organization_id, '00000000-0000-0000-0000-000000000000'::uuid), capability_key, unit, applied_scope, state);


--
-- Name: flow_execution_bindings_active_scope_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX flow_execution_bindings_active_scope_unique ON vortex_access.flow_execution_bindings USING btree (organization_id, application_root_id, release_version, flow_id, node_id, operation_owner_kind, operation_owner_id, operation_id, actor_kind, COALESCE(actor_organization_account_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(actor_system_actor_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (is_current AND (state = 'active'::text));


--
-- Name: flow_execution_bindings_current_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX flow_execution_bindings_current_unique ON vortex_access.flow_execution_bindings USING btree (execution_binding_id) WHERE is_current;


--
-- Name: flow_run_as_principals_current_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX flow_run_as_principals_current_unique ON vortex_access.flow_run_as_principals USING btree (execution_binding_id) WHERE is_current;


--
-- Name: metering_events_correction_identity_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX metering_events_correction_identity_unique ON vortex_access.metering_events USING btree (tenant_id, corrects_metering_event_id, operation_id) WHERE (corrects_metering_event_id IS NOT NULL);


--
-- Name: metering_events_correlation_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX metering_events_correlation_idx ON vortex_access.metering_events USING btree (tenant_id, correlation_id);


--
-- Name: metering_events_duplicate_scope_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX metering_events_duplicate_scope_unique ON vortex_access.metering_events USING btree (tenant_id, duplicate_protection_key);


--
-- Name: metering_events_operation_identity_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX metering_events_operation_identity_unique ON vortex_access.metering_events USING btree (tenant_id, operation_id, capability_key, unit) WHERE (corrects_metering_event_id IS NULL);


--
-- Name: metering_events_scope_occurred_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX metering_events_scope_occurred_idx ON vortex_access.metering_events USING btree (tenant_id, organization_id, capability_key, unit, occurred_at);


--
-- Name: organization_delegation_authorities_account_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_delegation_authorities_account_idx ON vortex_access.organization_delegation_authorities USING btree (organization_id, organization_account_id, state, starts_at, expires_at) WHERE (organization_account_id IS NOT NULL);


--
-- Name: organization_delegation_authorities_group_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_delegation_authorities_group_idx ON vortex_access.organization_delegation_authorities USING btree (organization_id, group_id, state, starts_at, expires_at) WHERE (group_id IS NOT NULL);


--
-- Name: organization_direct_record_shares_active_record_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_direct_record_shares_active_record_idx ON vortex_access.organization_direct_record_shares USING btree (organization_id, storage_scope, application_root_id, module_root_id, record_type_id, storage_contract_id, record_id) WHERE (state = 'active'::text);


--
-- Name: INDEX organization_direct_record_shares_active_record_idx; Type: COMMENT; Schema: vortex_access; Owner: postgres
--

COMMENT ON INDEX vortex_access.organization_direct_record_shares_active_record_idx IS 'Supports exact-record current-share contribution lookup; recipient and time remain residual predicates.';


--
-- Name: organization_group_memberships_account_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_group_memberships_account_idx ON vortex_access.organization_group_memberships USING btree (organization_id, organization_account_id, state, starts_at, expires_at);


--
-- Name: organization_group_memberships_group_page_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_group_memberships_group_page_idx ON vortex_access.organization_group_memberships USING btree (organization_id, group_id, membership_id);


--
-- Name: organization_group_memberships_one_live_pair; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX organization_group_memberships_one_live_pair ON vortex_access.organization_group_memberships USING btree (organization_id, group_id, organization_account_id) WHERE (state = 'live'::text);


--
-- Name: INDEX organization_group_memberships_one_live_pair; Type: COMMENT; Schema: vortex_access; Owner: postgres
--

COMMENT ON INDEX vortex_access.organization_group_memberships_one_live_pair IS 'The live-pair index also serves current Group traversal; historical membership reads use the exact-ID primary key.';


--
-- Name: organization_role_activations_account_role_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_role_activations_account_role_idx ON vortex_access.organization_role_activations USING btree (organization_id, organization_account_id, role_id, state, expires_at);


--
-- Name: organization_role_activations_assignment_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_role_activations_assignment_idx ON vortex_access.organization_role_activations USING btree (organization_id, role_assignment_id);


--
-- Name: organization_role_activations_membership_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_role_activations_membership_idx ON vortex_access.organization_role_activations USING btree (organization_id, membership_id) WHERE (membership_id IS NOT NULL);


--
-- Name: organization_role_activations_policy_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_role_activations_policy_idx ON vortex_access.organization_role_activations USING btree (organization_id, role_id, activation_policy_id, activation_policy_revision, activation_policy_fingerprint);


--
-- Name: organization_role_activations_role_revision_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_role_activations_role_revision_idx ON vortex_access.organization_role_activations USING btree (organization_id, role_id, historical_role_revision);


--
-- Name: organization_role_assignments_account_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_role_assignments_account_idx ON vortex_access.organization_role_assignments USING btree (organization_id, organization_account_id, state, starts_at, expires_at) WHERE (organization_account_id IS NOT NULL);


--
-- Name: organization_role_assignments_group_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_role_assignments_group_idx ON vortex_access.organization_role_assignments USING btree (organization_id, group_id, state, starts_at, expires_at) WHERE (group_id IS NOT NULL);


--
-- Name: organization_role_assignments_role_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_role_assignments_role_idx ON vortex_access.organization_role_assignments USING btree (organization_id, role_id, state, starts_at, expires_at);


--
-- Name: organization_role_permission_entries_catalogue_entry_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_role_permission_entries_catalogue_entry_idx ON vortex_access.organization_role_permission_entries USING btree (organization_id, registration_kind, registration_owner_id, accepted_registration_revision, owner_kind, owner_id, permission_id);


--
-- Name: organization_role_revisions_activation_policy_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_role_revisions_activation_policy_idx ON vortex_access.organization_role_revisions USING btree (organization_id, role_id, activation_policy_id, activation_policy_revision, activation_policy_fingerprint) WHERE (activation_policy_id IS NOT NULL);


--
-- Name: organization_role_revisions_source_registration_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX organization_role_revisions_source_registration_idx ON vortex_access.organization_role_revisions USING btree (organization_id, source_registration_kind, application_root_id, accepted_registration_revision) WHERE (role_kind = 'application'::text);


--
-- Name: organization_roles_application_source_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX organization_roles_application_source_unique ON vortex_access.organization_roles USING btree (organization_id, application_root_id, source_role_id) WHERE (role_kind = 'application'::text);


--
-- Name: permission_catalogue_entries_current_lookup_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX permission_catalogue_entries_current_lookup_idx ON vortex_access.permission_catalogue_entries USING btree (organization_id, application_root_id, owner_kind, owner_id, permission_id, registration_kind, registration_owner_id, registration_revision);


--
-- Name: permission_continuities_registration_revision_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX permission_continuities_registration_revision_idx ON vortex_access.permission_continuities USING btree (organization_id, registration_kind, registration_owner_id, last_processed_registration_revision);


--
-- Name: record_share_grant_consent_decisions_grant_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX record_share_grant_consent_decisions_grant_idx ON vortex_access.record_share_grant_consent_decisions USING btree (grant_id, side);


--
-- Name: record_share_grants_consent_request_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX record_share_grants_consent_request_unique ON vortex_access.record_share_grants USING btree (consent_request_id) WHERE (consent_request_id IS NOT NULL);


--
-- Name: record_share_grants_recipient_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX record_share_grants_recipient_idx ON vortex_access.record_share_grants USING btree (recipient_organization_id, changed_at DESC);


--
-- Name: record_share_grants_source_idx; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE INDEX record_share_grants_source_idx ON vortex_access.record_share_grants USING btree (source_organization_id, changed_at DESC);


--
-- Name: system_actor_grants_scope_unique; Type: INDEX; Schema: vortex_access; Owner: postgres
--

CREATE UNIQUE INDEX system_actor_grants_scope_unique ON vortex_access.system_actor_grants USING btree (system_actor_id, operation_key, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(flow_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(scope_key, ''::text));


--
-- Name: organization_activity_entries_actor_recent_idx; Type: INDEX; Schema: vortex_activity; Owner: postgres
--

CREATE INDEX organization_activity_entries_actor_recent_idx ON vortex_activity.organization_activity_entries USING btree (organization_id, actor_kind, actor_id, occurred_at DESC, activity_id DESC);


--
-- Name: organization_activity_entries_recent_idx; Type: INDEX; Schema: vortex_activity; Owner: postgres
--

CREATE INDEX organization_activity_entries_recent_idx ON vortex_activity.organization_activity_entries USING btree (organization_id, occurred_at DESC, activity_id DESC);


--
-- Name: drafts_restored_release_source_idx; Type: INDEX; Schema: vortex_definition; Owner: postgres
--

CREATE INDEX drafts_restored_release_source_idx ON vortex_definition.drafts USING btree (root_id, restored_from_release_revision, restored_from_source_fingerprint) WHERE (restored_from_release_revision IS NOT NULL);


--
-- Name: release_dependencies_single_release_subject_key; Type: INDEX; Schema: vortex_definition; Owner: postgres
--

CREATE UNIQUE INDEX release_dependencies_single_release_subject_key ON vortex_definition.release_dependencies USING btree (root_id, release_revision, dependency_kind, dependency_reference) WHERE (dependency_kind <> 'platform_block'::text);


--
-- Name: INDEX release_dependencies_single_release_subject_key; Type: COMMENT; Schema: vortex_definition; Owner: postgres
--

COMMENT ON INDEX vortex_definition.release_dependencies_single_release_subject_key IS 'Every dependency kind except platform_block pins exactly one release per subject in one release.';


--
-- Name: release_dependencies_target_release_idx; Type: INDEX; Schema: vortex_definition; Owner: postgres
--

CREATE INDEX release_dependencies_target_release_idx ON vortex_definition.release_dependencies USING btree (target_root_id, target_release_revision, dependency_version, dependency_content_fingerprint) WHERE (target_root_id IS NOT NULL);


--
-- Name: roots_current_release_idx; Type: INDEX; Schema: vortex_definition; Owner: postgres
--

CREATE INDEX roots_current_release_idx ON vortex_definition.roots USING btree (root_id, current_release_revision);


--
-- Name: source_identity_aliases_owner_idx; Type: INDEX; Schema: vortex_definition; Owner: postgres
--

CREATE INDEX source_identity_aliases_owner_idx ON vortex_definition.source_identity_aliases USING btree (root_id, owner_scope, kind, component_owner, identity_id);


--
-- Name: consumer_occurrence_progress_claimable; Type: INDEX; Schema: vortex_event; Owner: postgres
--

CREATE INDEX consumer_occurrence_progress_claimable ON vortex_event.consumer_occurrence_progress USING btree (consumer_key, lease_expires_at) WHERE (acknowledged_at IS NULL);


--
-- Name: consumer_occurrence_progress_terminal; Type: INDEX; Schema: vortex_event; Owner: postgres
--

CREATE INDEX consumer_occurrence_progress_terminal ON vortex_event.consumer_occurrence_progress USING btree (consumer_key, terminally_failed_at) WHERE (terminally_failed_at IS NOT NULL);


--
-- Name: event_outbox_record_sequence_lookup; Type: INDEX; Schema: vortex_event; Owner: postgres
--

CREATE INDEX event_outbox_record_sequence_lookup ON vortex_event.event_outbox USING btree (organization_id, storage_contract_id, sequence_application_root_id, record_id, record_sequence DESC);


--
-- Name: event_outbox_record_sequence_unique; Type: INDEX; Schema: vortex_event; Owner: postgres
--

CREATE UNIQUE INDEX event_outbox_record_sequence_unique ON vortex_event.event_outbox USING btree (organization_id, storage_contract_id, sequence_application_root_id, record_id, record_sequence) NULLS NOT DISTINCT;


--
-- Name: download_grants_file_idx; Type: INDEX; Schema: vortex_file; Owner: postgres
--

CREATE INDEX download_grants_file_idx ON vortex_file.download_grants USING btree (file_id);


--
-- Name: download_grants_org_expiry_idx; Type: INDEX; Schema: vortex_file; Owner: postgres
--

CREATE INDEX download_grants_org_expiry_idx ON vortex_file.download_grants USING btree (organization_id, expires_at);


--
-- Name: idx_file_records_org_lifecycle; Type: INDEX; Schema: vortex_file; Owner: postgres
--

CREATE INDEX idx_file_records_org_lifecycle ON vortex_file.file_records USING btree (organization_id, lifecycle_state);


--
-- Name: idx_file_records_org_owner; Type: INDEX; Schema: vortex_file; Owner: postgres
--

CREATE INDEX idx_file_records_org_owner ON vortex_file.file_records USING btree (organization_id, owner_record_id, owner_field_id) WHERE (owner_record_id IS NOT NULL);


--
-- Name: idx_file_records_storage_key; Type: INDEX; Schema: vortex_file; Owner: postgres
--

CREATE UNIQUE INDEX idx_file_records_storage_key ON vortex_file.file_records USING btree (storage_key);


--
-- Name: upload_grants_one_current_per_file; Type: INDEX; Schema: vortex_file; Owner: postgres
--

CREATE UNIQUE INDEX upload_grants_one_current_per_file ON vortex_file.upload_grants USING btree (file_id) WHERE (superseded_at IS NULL);


--
-- Name: upload_reservations_capability_reservation_unique; Type: INDEX; Schema: vortex_file; Owner: postgres
--

CREATE UNIQUE INDEX upload_reservations_capability_reservation_unique ON vortex_file.upload_reservations USING btree (capability_reservation_id);


--
-- Name: upload_reservations_owner_idx; Type: INDEX; Schema: vortex_file; Owner: postgres
--

CREATE INDEX upload_reservations_owner_idx ON vortex_file.upload_reservations USING btree (organization_id, owner_record_type_id, owner_record_id, owner_field_id, upload_expires_at);


--
-- Name: accepted_administration_receipts_cluster_replay_unique; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE UNIQUE INDEX accepted_administration_receipts_cluster_replay_unique ON vortex_identity.accepted_administration_receipts USING btree (actor_id, cluster_id, operation_key, duplicate_key) WHERE (cluster_id IS NOT NULL);


--
-- Name: accepted_administration_receipts_tenant_replay_unique; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE UNIQUE INDEX accepted_administration_receipts_tenant_replay_unique ON vortex_identity.accepted_administration_receipts USING btree (actor_id, tenant_id, operation_key, duplicate_key) WHERE (tenant_id IS NOT NULL);


--
-- Name: identity_disablement_commands_subject_idx; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE INDEX identity_disablement_commands_subject_idx ON vortex_identity.identity_disablement_commands USING btree (subject_identity_id, requested_at);


--
-- Name: identity_disablement_events_command_idx; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE INDEX identity_disablement_events_command_idx ON vortex_identity.identity_disablement_events USING btree (command_id, event_id);


--
-- Name: identity_disablement_events_subject_idx; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE INDEX identity_disablement_events_subject_idx ON vortex_identity.identity_disablement_events USING btree (subject_identity_id, recorded_at);


--
-- Name: organization_accounts_identity_lookup_idx; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE INDEX organization_accounts_identity_lookup_idx ON vortex_identity.organization_accounts USING btree (identity_id, organization_id);


--
-- Name: organization_accounts_originating_invitation_idx; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE INDEX organization_accounts_originating_invitation_idx ON vortex_identity.organization_accounts USING btree (organization_id, originating_invitation_id) WHERE (originating_invitation_id IS NOT NULL);


--
-- Name: organization_invitations_accepted_account_idx; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE INDEX organization_invitations_accepted_account_idx ON vortex_identity.organization_invitations USING btree (organization_id, accepted_organization_account_id) WHERE (accepted_organization_account_id IS NOT NULL);


--
-- Name: organization_invitations_inviter_idx; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE INDEX organization_invitations_inviter_idx ON vortex_identity.organization_invitations USING btree (organization_id, invited_by_organization_account_id);


--
-- Name: organization_invitations_organization_email_idx; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE INDEX organization_invitations_organization_email_idx ON vortex_identity.organization_invitations USING btree (organization_id, invited_email, expires_at DESC) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: organization_invitations_revoker_idx; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE INDEX organization_invitations_revoker_idx ON vortex_identity.organization_invitations USING btree (organization_id, revoked_by_organization_account_id) WHERE (revoked_by_organization_account_id IS NOT NULL);


--
-- Name: organizations_parent_lookup_idx; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE INDEX organizations_parent_lookup_idx ON vortex_identity.organizations USING btree (tenant_id, parent_organization_id) WHERE (parent_organization_id IS NOT NULL);


--
-- Name: vortex_super_administrator_assignments_one_live_identity_idx; Type: INDEX; Schema: vortex_identity; Owner: postgres
--

CREATE UNIQUE INDEX vortex_super_administrator_assignments_one_live_identity_idx ON vortex_identity.vortex_super_administrator_assignments USING btree (identity_id) WHERE (revoked_at IS NULL);


--
-- Name: installation_bindings_application_release_idx; Type: INDEX; Schema: vortex_module; Owner: vortex_module_owner
--

CREATE INDEX installation_bindings_application_release_idx ON vortex_module.installation_bindings USING btree (application_root_id, application_release_revision);


--
-- Name: installation_bindings_module_release_idx; Type: INDEX; Schema: vortex_module; Owner: vortex_module_owner
--

CREATE INDEX installation_bindings_module_release_idx ON vortex_module.installation_bindings USING btree (module_root_id, module_release_revision);


--
-- Name: preview_installations_expiry_idx; Type: INDEX; Schema: vortex_module; Owner: vortex_module_owner
--

CREATE INDEX preview_installations_expiry_idx ON vortex_module.preview_installations USING btree (organization_id, expires_at, preview_installation_id);


--
-- Name: preview_installations_previewer_idx; Type: INDEX; Schema: vortex_module; Owner: vortex_module_owner
--

CREATE INDEX preview_installations_previewer_idx ON vortex_module.preview_installations USING btree (organization_id, application_root_id, previewer_organization_account_id, expires_at);


--
-- Name: alert_signals_open_last_seen_idx; Type: INDEX; Schema: vortex_operations; Owner: postgres
--

CREATE INDEX alert_signals_open_last_seen_idx ON vortex_operations.alert_signals USING btree (last_seen_at DESC, signal_id) WHERE (state = 'open'::text);


--
-- Name: form_drafts_organization_expiry_idx; Type: INDEX; Schema: vortex_page; Owner: postgres
--

CREATE INDEX form_drafts_organization_expiry_idx ON vortex_page.form_drafts USING btree (organization_id, expires_at);


--
-- Name: form_drafts_scope_unique; Type: INDEX; Schema: vortex_page; Owner: postgres
--

CREATE UNIQUE INDEX form_drafts_scope_unique ON vortex_page.form_drafts USING btree (organization_id, organization_account_id, application_root_id, installation_release_revision, form_id, COALESCE(flow_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(node_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(subject_record_id, '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: installation_access_plans_bundle_cleanup_idx; Type: INDEX; Schema: vortex_record; Owner: vortex_record_adapter
--

CREATE INDEX installation_access_plans_bundle_cleanup_idx ON vortex_record.installation_access_plans USING btree (organization_id, application_root_id, application_release_revision, plan_key);


--
-- Name: preview_storage_bindings_storage_idx; Type: INDEX; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE INDEX preview_storage_bindings_storage_idx ON vortex_record.preview_storage_bindings USING btree (storage_contract_id);


--
-- Name: relationship_edges_from_organisation_idx; Type: INDEX; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE INDEX relationship_edges_from_organisation_idx ON vortex_record.relationship_edges USING btree (from_organisation_id);


--
-- Name: relationship_edges_from_storage_idx; Type: INDEX; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE INDEX relationship_edges_from_storage_idx ON vortex_record.relationship_edges USING btree (from_storage_contract_id);


--
-- Name: relationship_edges_to_organisation_idx; Type: INDEX; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE INDEX relationship_edges_to_organisation_idx ON vortex_record.relationship_edges USING btree (to_organisation_id);


--
-- Name: relationship_edges_to_storage_idx; Type: INDEX; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE INDEX relationship_edges_to_storage_idx ON vortex_record.relationship_edges USING btree (to_storage_contract_id);


--
-- Name: relationship_storage_mappings_source_idx; Type: INDEX; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE INDEX relationship_storage_mappings_source_idx ON vortex_record.relationship_storage_mappings USING btree (source_storage_contract_id, source_field_id);


--
-- Name: storage_conversion_plans_organisation_idx; Type: INDEX; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE INDEX storage_conversion_plans_organisation_idx ON vortex_record.storage_conversion_plans USING btree (organisation_id);


--
-- Name: storage_conversion_progress_organisation_idx; Type: INDEX; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE INDEX storage_conversion_progress_organisation_idx ON vortex_record.storage_conversion_progress USING btree (organisation_id);


--
-- Name: documents_application_idx; Type: INDEX; Schema: vortex_search; Owner: postgres
--

CREATE INDEX documents_application_idx ON vortex_search.documents USING btree (organization_id, application_root_id, record_type_id) WHERE (application_root_id IS NOT NULL);


--
-- Name: flow_continuations_expiry_idx; Type: INDEX; Schema: vortex_workflow; Owner: postgres
--

CREATE INDEX flow_continuations_expiry_idx ON vortex_workflow.flow_continuations USING btree (expires_at);


--
-- Name: flow_start_intents_pending_idx; Type: INDEX; Schema: vortex_workflow; Owner: postgres
--

CREATE INDEX flow_start_intents_pending_idx ON vortex_workflow.flow_start_intents USING btree (accepted_at, intent_id) WHERE (status = 'pending'::text);


--
-- Name: application_role_template_continuities application_role_template_continuities_evidence; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE CONSTRAINT TRIGGER application_role_template_continuities_evidence AFTER INSERT OR UPDATE ON vortex_access.application_role_template_continuities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vortex_access.validate_application_role_template_continuity_evidence();


--
-- Name: application_role_template_continuities application_role_template_continuities_protect_change; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER application_role_template_continuities_protect_change BEFORE DELETE OR UPDATE ON vortex_access.application_role_template_continuities FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_application_role_template_continuity();


--
-- Name: capability_limit_changes capability_limit_changes_append_only; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER capability_limit_changes_append_only BEFORE DELETE OR UPDATE ON vortex_access.capability_limit_changes FOR EACH ROW EXECUTE FUNCTION vortex_access.refuse_capability_limit_change_edit();


--
-- Name: capability_limit_changes capability_limit_changes_no_truncate; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER capability_limit_changes_no_truncate BEFORE TRUNCATE ON vortex_access.capability_limit_changes FOR EACH STATEMENT EXECUTE FUNCTION vortex_access.refuse_capability_limit_change_edit();


--
-- Name: metering_events metering_events_immutable; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER metering_events_immutable BEFORE DELETE OR UPDATE ON vortex_access.metering_events FOR EACH ROW EXECUTE FUNCTION vortex_access.refuse_metering_event_change();


--
-- Name: metering_events metering_events_not_truncated; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER metering_events_not_truncated BEFORE TRUNCATE ON vortex_access.metering_events FOR EACH STATEMENT EXECUTE FUNCTION vortex_access.refuse_metering_event_change();


--
-- Name: organization_access_versions organization_access_versions_protect_update; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_access_versions_protect_update BEFORE UPDATE ON vortex_access.organization_access_versions FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_organization_access_version();


--
-- Name: organization_delegation_authorities organization_delegation_authorities_protect_change; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_delegation_authorities_protect_change BEFORE DELETE OR UPDATE ON vortex_access.organization_delegation_authorities FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_organization_delegation_authority();


--
-- Name: organization_delegation_authorities organization_delegation_authorities_validate_scope; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_delegation_authorities_validate_scope BEFORE INSERT OR UPDATE ON vortex_access.organization_delegation_authorities FOR EACH ROW EXECUTE FUNCTION vortex_access.validate_organization_delegation_authority();


--
-- Name: organization_direct_record_shares organization_direct_record_shares_protect_change; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_direct_record_shares_protect_change BEFORE DELETE OR UPDATE ON vortex_access.organization_direct_record_shares FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_organization_direct_record_share();


--
-- Name: organization_direct_record_shares organization_direct_record_shares_validate_insert; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_direct_record_shares_validate_insert BEFORE INSERT ON vortex_access.organization_direct_record_shares FOR EACH ROW EXECUTE FUNCTION vortex_access.validate_organization_direct_record_share_insert();


--
-- Name: organization_group_memberships organization_group_memberships_protect_change; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_group_memberships_protect_change BEFORE DELETE OR UPDATE ON vortex_access.organization_group_memberships FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_organization_group_membership();


--
-- Name: organization_group_memberships organization_group_memberships_validate_insert; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_group_memberships_validate_insert BEFORE INSERT ON vortex_access.organization_group_memberships FOR EACH ROW EXECUTE FUNCTION vortex_access.validate_organization_group_membership_insert();


--
-- Name: organization_groups organization_groups_protect_change; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_groups_protect_change BEFORE INSERT OR DELETE OR UPDATE ON vortex_access.organization_groups FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_organization_group();


--
-- Name: organization_role_activation_policy_revisions organization_role_activation_policy_revisions_immutable; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_role_activation_policy_revisions_immutable BEFORE DELETE OR UPDATE ON vortex_access.organization_role_activation_policy_revisions FOR EACH ROW EXECUTE FUNCTION vortex_access.refuse_organization_role_history_mutation();


--
-- Name: organization_role_activations organization_role_activations_protect_change; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_role_activations_protect_change BEFORE DELETE OR UPDATE ON vortex_access.organization_role_activations FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_organization_role_activation();


--
-- Name: organization_role_activations organization_role_activations_validate_insert; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_role_activations_validate_insert BEFORE INSERT ON vortex_access.organization_role_activations FOR EACH ROW EXECUTE FUNCTION vortex_access.validate_organization_role_activation_insert();


--
-- Name: organization_role_assignments organization_role_assignments_protect_change; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_role_assignments_protect_change BEFORE DELETE OR UPDATE ON vortex_access.organization_role_assignments FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_organization_role_assignment();


--
-- Name: organization_role_assignments organization_role_assignments_validate_insert; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_role_assignments_validate_insert BEFORE INSERT ON vortex_access.organization_role_assignments FOR EACH ROW EXECUTE FUNCTION vortex_access.validate_organization_role_assignment_insert();


--
-- Name: organization_role_permission_entries organization_role_permission_entries_immutable; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_role_permission_entries_immutable BEFORE DELETE OR UPDATE ON vortex_access.organization_role_permission_entries FOR EACH ROW EXECUTE FUNCTION vortex_access.refuse_organization_role_history_mutation();


--
-- Name: organization_role_permission_entries organization_role_permission_entries_refuse_sealed_append; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_role_permission_entries_refuse_sealed_append BEFORE INSERT ON vortex_access.organization_role_permission_entries FOR EACH ROW EXECUTE FUNCTION vortex_access.lock_role_and_refuse_sealed_permission_append();


--
-- Name: organization_role_revisions organization_role_revisions_evidence; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE CONSTRAINT TRIGGER organization_role_revisions_evidence AFTER INSERT ON vortex_access.organization_role_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vortex_access.validate_organization_role_revision_evidence();


--
-- Name: organization_role_revisions organization_role_revisions_immutable; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_role_revisions_immutable BEFORE DELETE OR UPDATE ON vortex_access.organization_role_revisions FOR EACH ROW EXECUTE FUNCTION vortex_access.refuse_organization_role_history_mutation();


--
-- Name: organization_role_revisions organization_role_revisions_lock_before_seal; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_role_revisions_lock_before_seal BEFORE INSERT ON vortex_access.organization_role_revisions FOR EACH ROW EXECUTE FUNCTION vortex_access.lock_role_before_revision_seal();


--
-- Name: organization_roles organization_roles_protect_change; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_roles_protect_change BEFORE DELETE OR UPDATE ON vortex_access.organization_roles FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_organization_role_identity();


--
-- Name: organization_stewardship_requirements organization_stewardship_requirements_protect_change; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER organization_stewardship_requirements_protect_change BEFORE DELETE OR UPDATE ON vortex_access.organization_stewardship_requirements FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_organization_stewardship_requirement();


--
-- Name: permission_catalogue_entries permission_catalogue_entries_immutable; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER permission_catalogue_entries_immutable BEFORE DELETE OR UPDATE ON vortex_access.permission_catalogue_entries FOR EACH ROW EXECUTE FUNCTION vortex_access.refuse_permission_registration_history_mutation();


--
-- Name: permission_continuities permission_continuities_evidence; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE CONSTRAINT TRIGGER permission_continuities_evidence AFTER INSERT OR UPDATE ON vortex_access.permission_continuities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vortex_access.validate_permission_continuity_evidence();


--
-- Name: permission_continuities permission_continuities_protect_change; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER permission_continuities_protect_change BEFORE DELETE OR UPDATE ON vortex_access.permission_continuities FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_permission_continuity();


--
-- Name: permission_registration_revisions permission_registration_revisions_immutable; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER permission_registration_revisions_immutable BEFORE DELETE OR UPDATE ON vortex_access.permission_registration_revisions FOR EACH ROW EXECUTE FUNCTION vortex_access.refuse_permission_registration_history_mutation();


--
-- Name: permission_registrations permission_registrations_protect_change; Type: TRIGGER; Schema: vortex_access; Owner: postgres
--

CREATE TRIGGER permission_registrations_protect_change BEFORE DELETE OR UPDATE ON vortex_access.permission_registrations FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_permission_registration();


--
-- Name: platform_permission_declarations platform_permission_declarations_protect_guarded; Type: TRIGGER; Schema: vortex_access; Owner: vortex_access_owner
--

CREATE TRIGGER platform_permission_declarations_protect_guarded BEFORE DELETE OR UPDATE ON vortex_access.platform_permission_declarations FOR EACH ROW EXECUTE FUNCTION vortex_access.protect_platform_permission_declarations();


--
-- Name: organization_activity_entries organization_activity_entries_immutable; Type: TRIGGER; Schema: vortex_activity; Owner: postgres
--

CREATE TRIGGER organization_activity_entries_immutable BEFORE DELETE OR UPDATE ON vortex_activity.organization_activity_entries FOR EACH ROW EXECUTE FUNCTION vortex_activity.refuse_activity_entry_change();


--
-- Name: organization_activity_super_administrator_authority organization_activity_super_administrator_authority_immutable; Type: TRIGGER; Schema: vortex_activity; Owner: postgres
--

CREATE TRIGGER organization_activity_super_administrator_authority_immutable BEFORE DELETE OR UPDATE ON vortex_activity.organization_activity_super_administrator_authority FOR EACH ROW EXECUTE FUNCTION vortex_activity.refuse_super_administrator_authority_change();


--
-- Name: organization_activity_entries organization_activity_super_administrator_authority_record; Type: TRIGGER; Schema: vortex_activity; Owner: postgres
--

CREATE TRIGGER organization_activity_super_administrator_authority_record AFTER INSERT ON vortex_activity.organization_activity_entries FOR EACH ROW EXECUTE FUNCTION vortex_activity.record_super_administrator_authority_internal();


--
-- Name: connection_application_grants connection_application_grants_root_validation; Type: TRIGGER; Schema: vortex_connection; Owner: postgres
--

CREATE TRIGGER connection_application_grants_root_validation BEFORE INSERT OR UPDATE ON vortex_connection.connection_application_grants FOR EACH ROW EXECUTE FUNCTION vortex_connection.enforce_grant_application_root();


--
-- Name: drafts drafts_validate_write; Type: TRIGGER; Schema: vortex_definition; Owner: postgres
--

CREATE TRIGGER drafts_validate_write BEFORE INSERT OR UPDATE ON vortex_definition.drafts FOR EACH ROW EXECUTE FUNCTION vortex_definition.validate_draft_write();


--
-- Name: release_dependencies release_dependencies_append_only; Type: TRIGGER; Schema: vortex_definition; Owner: postgres
--

CREATE TRIGGER release_dependencies_append_only BEFORE DELETE OR UPDATE ON vortex_definition.release_dependencies FOR EACH ROW EXECUTE FUNCTION vortex_definition.refuse_release_mutation();


--
-- Name: releases releases_append_only; Type: TRIGGER; Schema: vortex_definition; Owner: postgres
--

CREATE TRIGGER releases_append_only BEFORE DELETE OR UPDATE ON vortex_definition.releases FOR EACH ROW EXECUTE FUNCTION vortex_definition.refuse_release_mutation();


--
-- Name: releases releases_validate_insert; Type: TRIGGER; Schema: vortex_definition; Owner: postgres
--

CREATE TRIGGER releases_validate_insert BEFORE INSERT ON vortex_definition.releases FOR EACH ROW EXECUTE FUNCTION vortex_definition.validate_release_insert();


--
-- Name: roots roots_protect_identity; Type: TRIGGER; Schema: vortex_definition; Owner: postgres
--

CREATE TRIGGER roots_protect_identity BEFORE UPDATE OF root_id, organization_id, kind, key, created_at, created_by ON vortex_definition.roots FOR EACH ROW EXECUTE FUNCTION vortex_definition.protect_root_identity();


--
-- Name: source_identities source_identities_append_only; Type: TRIGGER; Schema: vortex_definition; Owner: postgres
--

CREATE TRIGGER source_identities_append_only BEFORE DELETE OR UPDATE ON vortex_definition.source_identities FOR EACH ROW EXECUTE FUNCTION vortex_definition.refuse_source_identity_mutation();


--
-- Name: source_identity_aliases source_identity_aliases_append_only; Type: TRIGGER; Schema: vortex_definition; Owner: postgres
--

CREATE TRIGGER source_identity_aliases_append_only BEFORE DELETE OR UPDATE ON vortex_definition.source_identity_aliases FOR EACH ROW EXECUTE FUNCTION vortex_definition.refuse_source_identity_mutation();


--
-- Name: event_outbox event_outbox_dispatch_wakeup; Type: TRIGGER; Schema: vortex_event; Owner: postgres
--

CREATE TRIGGER event_outbox_dispatch_wakeup AFTER INSERT ON vortex_event.event_outbox FOR EACH ROW EXECUTE FUNCTION vortex_event.request_event_dispatch_wakeup();


--
-- Name: event_outbox event_outbox_immutable; Type: TRIGGER; Schema: vortex_event; Owner: postgres
--

CREATE TRIGGER event_outbox_immutable BEFORE DELETE OR UPDATE ON vortex_event.event_outbox FOR EACH ROW EXECUTE FUNCTION vortex_event.refuse_event_outbox_change();


--
-- Name: file_records file_records_advance_metadata_revision; Type: TRIGGER; Schema: vortex_file; Owner: postgres
--

CREATE TRIGGER file_records_advance_metadata_revision BEFORE INSERT OR UPDATE ON vortex_file.file_records FOR EACH ROW EXECUTE FUNCTION vortex_file.advance_file_metadata_revision();


--
-- Name: TRIGGER file_records_advance_metadata_revision ON file_records; Type: COMMENT; Schema: vortex_file; Owner: postgres
--

COMMENT ON TRIGGER file_records_advance_metadata_revision ON vortex_file.file_records IS 'Initializes and advances the stored File metadata revision for each row write.';


--
-- Name: file_records file_records_application_root_validation; Type: TRIGGER; Schema: vortex_file; Owner: postgres
--

CREATE TRIGGER file_records_application_root_validation BEFORE INSERT OR UPDATE ON vortex_file.file_records FOR EACH ROW EXECUTE FUNCTION vortex_file.enforce_file_application_root();


--
-- Name: identity_disablement_commands identity_disablement_commands_not_truncated; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER identity_disablement_commands_not_truncated BEFORE TRUNCATE ON vortex_identity.identity_disablement_commands FOR EACH STATEMENT EXECUTE FUNCTION vortex_identity.refuse_identity_disablement_record_change();


--
-- Name: identity_disablement_commands identity_disablement_commands_protect; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER identity_disablement_commands_protect BEFORE DELETE OR UPDATE ON vortex_identity.identity_disablement_commands FOR EACH ROW EXECUTE FUNCTION vortex_identity.protect_identity_disablement_command();


--
-- Name: identity_disablement_events identity_disablement_events_immutable; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER identity_disablement_events_immutable BEFORE DELETE OR UPDATE ON vortex_identity.identity_disablement_events FOR EACH ROW EXECUTE FUNCTION vortex_identity.refuse_identity_disablement_record_change();


--
-- Name: identity_disablement_events identity_disablement_events_not_truncated; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER identity_disablement_events_not_truncated BEFORE TRUNCATE ON vortex_identity.identity_disablement_events FOR EACH STATEMENT EXECUTE FUNCTION vortex_identity.refuse_identity_disablement_record_change();


--
-- Name: identity_projections identity_projections_protect; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER identity_projections_protect BEFORE UPDATE ON vortex_identity.identity_projections FOR EACH ROW EXECUTE FUNCTION vortex_identity.protect_identity_projection();


--
-- Name: identity_projections identity_projections_start_disabled_suspended; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER identity_projections_start_disabled_suspended BEFORE INSERT ON vortex_identity.identity_projections FOR EACH ROW EXECUTE FUNCTION vortex_identity.start_disabled_identity_projection_suspended();


--
-- Name: organization_accounts organization_accounts_protect; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER organization_accounts_protect BEFORE UPDATE ON vortex_identity.organization_accounts FOR EACH ROW EXECUTE FUNCTION vortex_identity.protect_organization_account();


--
-- Name: organization_accounts organization_accounts_super_administrator_provenance_protect; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER organization_accounts_super_administrator_provenance_protect BEFORE UPDATE ON vortex_identity.organization_accounts FOR EACH ROW EXECUTE FUNCTION vortex_identity.protect_super_administrator_account_provenance();


--
-- Name: organization_invitations organization_invitations_protect; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER organization_invitations_protect BEFORE UPDATE ON vortex_identity.organization_invitations FOR EACH ROW EXECUTE FUNCTION vortex_identity.protect_organization_invitation();


--
-- Name: organizations organizations_lock_tenant; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER organizations_lock_tenant BEFORE UPDATE OF state ON vortex_identity.organizations FOR EACH ROW EXECUTE FUNCTION vortex_identity.lock_organization_tenant();


--
-- Name: organizations organizations_protect_identity; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER organizations_protect_identity BEFORE UPDATE OF organization_id, tenant_id, short_name ON vortex_identity.organizations FOR EACH ROW EXECUTE FUNCTION vortex_identity.protect_organization_identity();


--
-- Name: organizations organizations_refuse_cycle; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER organizations_refuse_cycle AFTER INSERT OR UPDATE OF parent_organization_id ON vortex_identity.organizations FOR EACH ROW EXECUTE FUNCTION vortex_identity.refuse_organization_cycle();


--
-- Name: organizations organizations_validate_lifecycle; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE CONSTRAINT TRIGGER organizations_validate_lifecycle AFTER INSERT OR UPDATE OF tenant_id, parent_organization_id, state ON vortex_identity.organizations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vortex_identity.validate_organization_lifecycle();


--
-- Name: tenants tenants_protect_identity; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER tenants_protect_identity BEFORE UPDATE OF tenant_id, short_name ON vortex_identity.tenants FOR EACH ROW EXECUTE FUNCTION vortex_identity.protect_tenant_identity();


--
-- Name: tenants tenants_validate_lifecycle; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE CONSTRAINT TRIGGER tenants_validate_lifecycle AFTER INSERT OR UPDATE OF state ON vortex_identity.tenants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vortex_identity.validate_tenant_lifecycle();


--
-- Name: vortex_super_administrator_assignment_receipts vortex_super_administrator_assignment_receipts_immutable; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER vortex_super_administrator_assignment_receipts_immutable BEFORE DELETE OR UPDATE ON vortex_identity.vortex_super_administrator_assignment_receipts FOR EACH ROW EXECUTE FUNCTION vortex_identity.refuse_super_administrator_assignment_receipt_change();


--
-- Name: vortex_super_administrator_assignments vortex_super_administrator_assignments_protect; Type: TRIGGER; Schema: vortex_identity; Owner: postgres
--

CREATE TRIGGER vortex_super_administrator_assignments_protect BEFORE DELETE OR UPDATE ON vortex_identity.vortex_super_administrator_assignments FOR EACH ROW EXECUTE FUNCTION vortex_identity.protect_vortex_super_administrator_assignment();


--
-- Name: command_receipts command_receipts_lifecycle_completed_at_commit; Type: TRIGGER; Schema: vortex_record; Owner: vortex_record_adapter
--

CREATE CONSTRAINT TRIGGER command_receipts_lifecycle_completed_at_commit AFTER INSERT OR UPDATE ON vortex_record.command_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.command_kind = 'record_lifecycle'::text)) EXECUTE FUNCTION vortex_record.assert_record_lifecycle_receipt_completed_internal();


--
-- Name: relationship_edges relationship_edges_scope; Type: TRIGGER; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE TRIGGER relationship_edges_scope BEFORE INSERT OR UPDATE ON vortex_record.relationship_edges FOR EACH ROW EXECUTE FUNCTION vortex_record.enforce_relationship_edge_scope();


--
-- Name: storage_catalogue storage_catalogue_account_deletion_fence; Type: TRIGGER; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE TRIGGER storage_catalogue_account_deletion_fence AFTER INSERT ON vortex_record.storage_catalogue FOR EACH ROW EXECUTE FUNCTION vortex_record.provision_account_deletion_fence_internal();


--
-- Name: TRIGGER storage_catalogue_account_deletion_fence ON storage_catalogue; Type: COMMENT; Schema: vortex_record; Owner: vortex_record_owner
--

COMMENT ON TRIGGER storage_catalogue_account_deletion_fence ON vortex_record.storage_catalogue IS 'Fences each new Record table for account deletion as it enters the live catalogue.';


--
-- Name: storage_catalogue storage_catalogue_offboarding_owner_index; Type: TRIGGER; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE TRIGGER storage_catalogue_offboarding_owner_index AFTER INSERT ON vortex_record.storage_catalogue FOR EACH ROW EXECUTE FUNCTION vortex_record.provision_offboarding_owner_index_internal();


--
-- Name: TRIGGER storage_catalogue_offboarding_owner_index ON storage_catalogue; Type: COMMENT; Schema: vortex_record; Owner: vortex_record_owner
--

COMMENT ON TRIGGER storage_catalogue_offboarding_owner_index ON vortex_record.storage_catalogue IS 'Provisions the account-owner partial index as each account-owned record table enters the live catalogue.';


--
-- Name: documents documents_application_root_validation; Type: TRIGGER; Schema: vortex_search; Owner: postgres
--

CREATE TRIGGER documents_application_root_validation BEFORE INSERT OR UPDATE ON vortex_search.documents FOR EACH ROW EXECUTE FUNCTION vortex_search.enforce_document_application_root();


--
-- Name: application_role_template_continuities application_role_template_continuities_registration_revision_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.application_role_template_continuities
    ADD CONSTRAINT application_role_template_continuities_registration_revision_fk FOREIGN KEY (organization_id, registration_kind, application_root_id, last_processed_registration_revision) REFERENCES vortex_access.permission_registration_revisions(organization_id, registration_kind, registration_owner_id, revision);


--
-- Name: capability_limit_changes capability_limit_changes_assignment_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_limit_changes
    ADD CONSTRAINT capability_limit_changes_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES vortex_access.capability_policy_assignments(assignment_id);


--
-- Name: capability_limit_changes capability_limit_changes_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_limit_changes
    ADD CONSTRAINT capability_limit_changes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: capability_limit_changes capability_limit_changes_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_limit_changes
    ADD CONSTRAINT capability_limit_changes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: capability_limit_changes capability_limit_changes_tenant_id_policy_id_policy_revisi_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_limit_changes
    ADD CONSTRAINT capability_limit_changes_tenant_id_policy_id_policy_revisi_fkey FOREIGN KEY (tenant_id, policy_id, policy_revision) REFERENCES vortex_access.capability_policy_definitions(tenant_id, policy_id, revision);


--
-- Name: capability_policy_assignments capability_policy_assignments_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_policy_assignments
    ADD CONSTRAINT capability_policy_assignments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: capability_policy_assignments capability_policy_assignments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_policy_assignments
    ADD CONSTRAINT capability_policy_assignments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: capability_policy_assignments capability_policy_assignments_tenant_id_policy_id_policy_r_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_policy_assignments
    ADD CONSTRAINT capability_policy_assignments_tenant_id_policy_id_policy_r_fkey FOREIGN KEY (tenant_id, policy_id, policy_revision) REFERENCES vortex_access.capability_policy_definitions(tenant_id, policy_id, revision);


--
-- Name: capability_policy_definitions capability_policy_definitions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_policy_definitions
    ADD CONSTRAINT capability_policy_definitions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: capability_reservation_balances capability_reservation_balanc_tenant_id_policy_id_policy_r_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservation_balances
    ADD CONSTRAINT capability_reservation_balanc_tenant_id_policy_id_policy_r_fkey FOREIGN KEY (tenant_id, policy_id, policy_revision) REFERENCES vortex_access.capability_policy_definitions(tenant_id, policy_id, revision);


--
-- Name: capability_reservation_balances capability_reservation_balances_assignment_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservation_balances
    ADD CONSTRAINT capability_reservation_balances_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES vortex_access.capability_policy_assignments(assignment_id);


--
-- Name: capability_reservation_balances capability_reservation_balances_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservation_balances
    ADD CONSTRAINT capability_reservation_balances_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: capability_reservation_balances capability_reservation_balances_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservation_balances
    ADD CONSTRAINT capability_reservation_balances_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: capability_reservation_commands capability_reservation_commands_request_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservation_commands
    ADD CONSTRAINT capability_reservation_commands_request_organization_id_fkey FOREIGN KEY (request_organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: capability_reservation_commands capability_reservation_commands_reservation_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservation_commands
    ADD CONSTRAINT capability_reservation_commands_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES vortex_access.capability_reservations(reservation_id);


--
-- Name: capability_reservation_commands capability_reservation_commands_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservation_commands
    ADD CONSTRAINT capability_reservation_commands_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: capability_reservations capability_reservations_assignment_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservations
    ADD CONSTRAINT capability_reservations_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES vortex_access.capability_policy_assignments(assignment_id);


--
-- Name: capability_reservations capability_reservations_request_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservations
    ADD CONSTRAINT capability_reservations_request_organization_id_fkey FOREIGN KEY (request_organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: capability_reservations capability_reservations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservations
    ADD CONSTRAINT capability_reservations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: capability_reservations capability_reservations_tenant_id_policy_id_policy_revisio_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.capability_reservations
    ADD CONSTRAINT capability_reservations_tenant_id_policy_id_policy_revisio_fkey FOREIGN KEY (tenant_id, policy_id, policy_revision) REFERENCES vortex_access.capability_policy_definitions(tenant_id, policy_id, revision);


--
-- Name: flow_execution_bindings flow_execution_bindings_actor_organization_account_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.flow_execution_bindings
    ADD CONSTRAINT flow_execution_bindings_actor_organization_account_id_fkey FOREIGN KEY (actor_organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_account_id);


--
-- Name: flow_execution_bindings flow_execution_bindings_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.flow_execution_bindings
    ADD CONSTRAINT flow_execution_bindings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: flow_run_as_principals flow_run_as_principals_actor_organization_account_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.flow_run_as_principals
    ADD CONSTRAINT flow_run_as_principals_actor_organization_account_id_fkey FOREIGN KEY (actor_organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_account_id);


--
-- Name: flow_run_as_principals flow_run_as_principals_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.flow_run_as_principals
    ADD CONSTRAINT flow_run_as_principals_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: metering_events metering_events_tenant_id_corrects_metering_event_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.metering_events
    ADD CONSTRAINT metering_events_tenant_id_corrects_metering_event_id_fkey FOREIGN KEY (tenant_id, corrects_metering_event_id) REFERENCES vortex_access.metering_events(tenant_id, metering_event_id);


--
-- Name: metering_events metering_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.metering_events
    ADD CONSTRAINT metering_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: metering_events metering_events_tenant_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.metering_events
    ADD CONSTRAINT metering_events_tenant_id_organization_id_fkey FOREIGN KEY (tenant_id, organization_id) REFERENCES vortex_identity.organizations(tenant_id, organization_id);


--
-- Name: organization_access_versions organization_access_versions_organization_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_access_versions
    ADD CONSTRAINT organization_access_versions_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: organization_delegation_authorities organization_delegation_authorities_account_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_delegation_authorities
    ADD CONSTRAINT organization_delegation_authorities_account_fk FOREIGN KEY (organization_id, organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: organization_delegation_authorities organization_delegation_authorities_group_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_delegation_authorities
    ADD CONSTRAINT organization_delegation_authorities_group_fk FOREIGN KEY (organization_id, group_id) REFERENCES vortex_access.organization_groups(organization_id, group_id);


--
-- Name: organization_direct_record_shares organization_direct_record_shares_account_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_direct_record_shares
    ADD CONSTRAINT organization_direct_record_shares_account_fk FOREIGN KEY (organization_id, organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: organization_direct_record_shares organization_direct_record_shares_grantor_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_direct_record_shares
    ADD CONSTRAINT organization_direct_record_shares_grantor_fk FOREIGN KEY (organization_id, granted_by) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: organization_direct_record_shares organization_direct_record_shares_group_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_direct_record_shares
    ADD CONSTRAINT organization_direct_record_shares_group_fk FOREIGN KEY (organization_id, group_id) REFERENCES vortex_access.organization_groups(organization_id, group_id);


--
-- Name: organization_direct_record_shares organization_direct_record_shares_organization_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_direct_record_shares
    ADD CONSTRAINT organization_direct_record_shares_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: organization_direct_record_shares organization_direct_record_shares_revoker_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_direct_record_shares
    ADD CONSTRAINT organization_direct_record_shares_revoker_fk FOREIGN KEY (organization_id, revoked_by) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: organization_group_memberships organization_group_memberships_account_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_group_memberships
    ADD CONSTRAINT organization_group_memberships_account_fk FOREIGN KEY (organization_id, organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: organization_group_memberships organization_group_memberships_group_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_group_memberships
    ADD CONSTRAINT organization_group_memberships_group_fk FOREIGN KEY (organization_id, group_id) REFERENCES vortex_access.organization_groups(organization_id, group_id);


--
-- Name: organization_groups organization_groups_organization_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_groups
    ADD CONSTRAINT organization_groups_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: organization_role_activation_policy_revisions organization_role_activation_policy_revisions_role_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_activation_policy_revisions
    ADD CONSTRAINT organization_role_activation_policy_revisions_role_fk FOREIGN KEY (organization_id, role_id) REFERENCES vortex_access.organization_roles(organization_id, role_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: organization_role_activations organization_role_activations_account_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_activations
    ADD CONSTRAINT organization_role_activations_account_fk FOREIGN KEY (organization_id, organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: organization_role_activations organization_role_activations_activation_policy_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_activations
    ADD CONSTRAINT organization_role_activations_activation_policy_fk FOREIGN KEY (organization_id, role_id, activation_policy_id, activation_policy_revision, activation_policy_fingerprint) REFERENCES vortex_access.organization_role_activation_policy_revisions(organization_id, role_id, activation_policy_id, revision, policy_fingerprint);


--
-- Name: organization_role_activations organization_role_activations_assignment_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_activations
    ADD CONSTRAINT organization_role_activations_assignment_fk FOREIGN KEY (organization_id, role_assignment_id) REFERENCES vortex_access.organization_role_assignments(organization_id, role_assignment_id);


--
-- Name: organization_role_activations organization_role_activations_membership_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_activations
    ADD CONSTRAINT organization_role_activations_membership_fk FOREIGN KEY (organization_id, membership_id) REFERENCES vortex_access.organization_group_memberships(organization_id, membership_id);


--
-- Name: organization_role_activations organization_role_activations_role_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_activations
    ADD CONSTRAINT organization_role_activations_role_fk FOREIGN KEY (organization_id, role_id) REFERENCES vortex_access.organization_roles(organization_id, role_id);


--
-- Name: organization_role_activations organization_role_activations_role_revision_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_activations
    ADD CONSTRAINT organization_role_activations_role_revision_fk FOREIGN KEY (organization_id, role_id, historical_role_revision) REFERENCES vortex_access.organization_role_revisions(organization_id, role_id, revision);


--
-- Name: organization_role_assignments organization_role_assignments_account_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_assignments
    ADD CONSTRAINT organization_role_assignments_account_fk FOREIGN KEY (organization_id, organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: organization_role_assignments organization_role_assignments_group_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_assignments
    ADD CONSTRAINT organization_role_assignments_group_fk FOREIGN KEY (organization_id, group_id) REFERENCES vortex_access.organization_groups(organization_id, group_id);


--
-- Name: organization_role_assignments organization_role_assignments_role_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_assignments
    ADD CONSTRAINT organization_role_assignments_role_fk FOREIGN KEY (organization_id, role_id) REFERENCES vortex_access.organization_roles(organization_id, role_id);


--
-- Name: organization_role_permission_entries organization_role_permission_entries_catalogue_entry_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_permission_entries
    ADD CONSTRAINT organization_role_permission_entries_catalogue_entry_fk FOREIGN KEY (organization_id, registration_kind, registration_owner_id, accepted_registration_revision, owner_kind, owner_id, permission_id) REFERENCES vortex_access.permission_catalogue_entries(organization_id, registration_kind, registration_owner_id, registration_revision, owner_kind, owner_id, permission_id);


--
-- Name: organization_role_permission_entries organization_role_permission_entries_role_revision_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_permission_entries
    ADD CONSTRAINT organization_role_permission_entries_role_revision_fk FOREIGN KEY (organization_id, role_id, role_revision, role_kind, role_application_scope_id) REFERENCES vortex_access.organization_role_revisions(organization_id, role_id, revision, role_kind, application_scope_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: organization_role_revisions organization_role_revisions_activation_policy_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_revisions
    ADD CONSTRAINT organization_role_revisions_activation_policy_fk FOREIGN KEY (organization_id, role_id, activation_policy_id, activation_policy_revision, activation_policy_fingerprint) REFERENCES vortex_access.organization_role_activation_policy_revisions(organization_id, role_id, activation_policy_id, revision, policy_fingerprint) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: organization_role_revisions organization_role_revisions_role_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_revisions
    ADD CONSTRAINT organization_role_revisions_role_fk FOREIGN KEY (organization_id, role_id, role_kind, application_scope_id) REFERENCES vortex_access.organization_roles(organization_id, role_id, role_kind, application_scope_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: organization_role_revisions organization_role_revisions_source_registration_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_role_revisions
    ADD CONSTRAINT organization_role_revisions_source_registration_fk FOREIGN KEY (organization_id, source_registration_kind, application_root_id, accepted_registration_revision) REFERENCES vortex_access.permission_registration_revisions(organization_id, registration_kind, registration_owner_id, revision);


--
-- Name: organization_roles organization_roles_current_revision_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_roles
    ADD CONSTRAINT organization_roles_current_revision_fk FOREIGN KEY (organization_id, role_id, live_revision, role_key) REFERENCES vortex_access.organization_role_revisions(organization_id, role_id, revision, role_key) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: organization_roles organization_roles_organization_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_roles
    ADD CONSTRAINT organization_roles_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: organization_stewardship_requirements organization_stewardship_requirements_account_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_stewardship_requirements
    ADD CONSTRAINT organization_stewardship_requirements_account_fk FOREIGN KEY (organization_id, original_organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: organization_stewardship_requirements organization_stewardship_requirements_assignment_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_stewardship_requirements
    ADD CONSTRAINT organization_stewardship_requirements_assignment_fk FOREIGN KEY (organization_id, original_role_assignment_id) REFERENCES vortex_access.organization_role_assignments(organization_id, role_assignment_id);


--
-- Name: organization_stewardship_requirements organization_stewardship_requirements_delegation_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_stewardship_requirements
    ADD CONSTRAINT organization_stewardship_requirements_delegation_fk FOREIGN KEY (organization_id, original_delegation_authority_id) REFERENCES vortex_access.organization_delegation_authorities(organization_id, delegation_authority_id);


--
-- Name: organization_stewardship_requirements organization_stewardship_requirements_organization_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_stewardship_requirements
    ADD CONSTRAINT organization_stewardship_requirements_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: organization_stewardship_requirements organization_stewardship_requirements_role_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.organization_stewardship_requirements
    ADD CONSTRAINT organization_stewardship_requirements_role_fk FOREIGN KEY (organization_id, original_role_id) REFERENCES vortex_access.organization_roles(organization_id, role_id);


--
-- Name: permission_catalogue_entries permission_catalogue_entries_revision_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.permission_catalogue_entries
    ADD CONSTRAINT permission_catalogue_entries_revision_fk FOREIGN KEY (organization_id, registration_kind, registration_owner_id, registration_revision) REFERENCES vortex_access.permission_registration_revisions(organization_id, registration_kind, registration_owner_id, revision);


--
-- Name: permission_continuities permission_continuities_registration_revision_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.permission_continuities
    ADD CONSTRAINT permission_continuities_registration_revision_fk FOREIGN KEY (organization_id, registration_kind, registration_owner_id, last_processed_registration_revision) REFERENCES vortex_access.permission_registration_revisions(organization_id, registration_kind, registration_owner_id, revision);


--
-- Name: permission_registration_revisions permission_registration_revisions_organization_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.permission_registration_revisions
    ADD CONSTRAINT permission_registration_revisions_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: permission_registrations permission_registrations_current_revision_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.permission_registrations
    ADD CONSTRAINT permission_registrations_current_revision_fk FOREIGN KEY (organization_id, registration_kind, registration_owner_id, revision) REFERENCES vortex_access.permission_registration_revisions(organization_id, registration_kind, registration_owner_id, revision) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: permission_registrations permission_registrations_organization_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.permission_registrations
    ADD CONSTRAINT permission_registrations_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: record_share_grant_consent_decisions record_share_grant_consent_de_approver_organization_accoun_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_decisions
    ADD CONSTRAINT record_share_grant_consent_de_approver_organization_accoun_fkey FOREIGN KEY (approver_organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_account_id);


--
-- Name: record_share_grant_consent_decisions record_share_grant_consent_decis_recipient_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_decisions
    ADD CONSTRAINT record_share_grant_consent_decis_recipient_organization_id_fkey FOREIGN KEY (recipient_organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: record_share_grant_consent_decisions record_share_grant_consent_decisi_approver_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_decisions
    ADD CONSTRAINT record_share_grant_consent_decisi_approver_organization_id_fkey FOREIGN KEY (approver_organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: record_share_grant_consent_decisions record_share_grant_consent_decision_source_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_decisions
    ADD CONSTRAINT record_share_grant_consent_decision_source_organization_id_fkey FOREIGN KEY (source_organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: record_share_grant_consent_decisions record_share_grant_consent_decisions_grant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_decisions
    ADD CONSTRAINT record_share_grant_consent_decisions_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES vortex_access.record_share_grants(grant_id);


--
-- Name: record_share_grant_consent_decisions record_share_grant_consent_decisions_request_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_decisions
    ADD CONSTRAINT record_share_grant_consent_decisions_request_id_fkey FOREIGN KEY (request_id) REFERENCES vortex_access.record_share_grant_consent_requests(request_id);


--
-- Name: record_share_grant_consent_decisions record_share_grant_consent_decisions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_decisions
    ADD CONSTRAINT record_share_grant_consent_decisions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: record_share_grant_consent_requests record_share_grant_consent_requests_grant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_requests
    ADD CONSTRAINT record_share_grant_consent_requests_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES vortex_access.record_share_grants(grant_id);


--
-- Name: record_share_grant_consent_requests record_share_grant_consent_requests_source_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grant_consent_requests
    ADD CONSTRAINT record_share_grant_consent_requests_source_organization_id_fkey FOREIGN KEY (source_organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: record_share_grants record_share_grants_consent_request_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grants
    ADD CONSTRAINT record_share_grants_consent_request_fk FOREIGN KEY (consent_request_id) REFERENCES vortex_access.record_share_grant_consent_requests(request_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: record_share_grants record_share_grants_source_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.record_share_grants
    ADD CONSTRAINT record_share_grants_source_organization_id_fkey FOREIGN KEY (source_organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: system_actor_grants system_actor_grants_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.system_actor_grants
    ADD CONSTRAINT system_actor_grants_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: usage_projection_reconciliation usage_projection_reconciliation_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.usage_projection_reconciliation
    ADD CONSTRAINT usage_projection_reconciliation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: usage_projection_rollups usage_projection_rollups_organization_fk; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.usage_projection_rollups
    ADD CONSTRAINT usage_projection_rollups_organization_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES vortex_identity.organizations(tenant_id, organization_id);


--
-- Name: usage_projection_rollups usage_projection_rollups_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_access; Owner: postgres
--

ALTER TABLE ONLY vortex_access.usage_projection_rollups
    ADD CONSTRAINT usage_projection_rollups_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: organization_activity_entries organization_activity_entries_organization_fk; Type: FK CONSTRAINT; Schema: vortex_activity; Owner: postgres
--

ALTER TABLE ONLY vortex_activity.organization_activity_entries
    ADD CONSTRAINT organization_activity_entries_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: organization_activity_super_administrator_authority organization_activity_super_administrator_authority_activity_fk; Type: FK CONSTRAINT; Schema: vortex_activity; Owner: postgres
--

ALTER TABLE ONLY vortex_activity.organization_activity_super_administrator_authority
    ADD CONSTRAINT organization_activity_super_administrator_authority_activity_fk FOREIGN KEY (organization_id, activity_id) REFERENCES vortex_activity.organization_activity_entries(organization_id, activity_id);


--
-- Name: organization_activity_super_administrator_authority organization_activity_super_administrator_authority_assignment_; Type: FK CONSTRAINT; Schema: vortex_activity; Owner: postgres
--

ALTER TABLE ONLY vortex_activity.organization_activity_super_administrator_authority
    ADD CONSTRAINT organization_activity_super_administrator_authority_assignment_ FOREIGN KEY (assignment_id) REFERENCES vortex_identity.vortex_super_administrator_assignments(assignment_id);


--
-- Name: connection_application_grants connection_application_grants_application_root_id_fkey; Type: FK CONSTRAINT; Schema: vortex_connection; Owner: postgres
--

ALTER TABLE ONLY vortex_connection.connection_application_grants
    ADD CONSTRAINT connection_application_grants_application_root_id_fkey FOREIGN KEY (application_root_id) REFERENCES vortex_definition.roots(root_id) ON DELETE CASCADE;


--
-- Name: connection_application_grants connection_application_grants_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_connection; Owner: postgres
--

ALTER TABLE ONLY vortex_connection.connection_application_grants
    ADD CONSTRAINT connection_application_grants_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: connection_application_grants connection_grants_instance_org_fk; Type: FK CONSTRAINT; Schema: vortex_connection; Owner: postgres
--

ALTER TABLE ONLY vortex_connection.connection_application_grants
    ADD CONSTRAINT connection_grants_instance_org_fk FOREIGN KEY (connection_instance_id, organization_id) REFERENCES vortex_connection.connection_instances(connection_instance_id, organization_id) ON DELETE CASCADE;


--
-- Name: connection_instances connection_instances_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_connection; Owner: postgres
--

ALTER TABLE ONLY vortex_connection.connection_instances
    ADD CONSTRAINT connection_instances_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: drafts drafts_restored_release_source_fk; Type: FK CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.drafts
    ADD CONSTRAINT drafts_restored_release_source_fk FOREIGN KEY (root_id, restored_from_release_revision, restored_from_source_fingerprint) REFERENCES vortex_definition.releases(root_id, release_revision, authored_source_fingerprint);


--
-- Name: drafts drafts_root_fk; Type: FK CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.drafts
    ADD CONSTRAINT drafts_root_fk FOREIGN KEY (root_id) REFERENCES vortex_definition.roots(root_id);


--
-- Name: release_dependencies release_dependencies_release_fk; Type: FK CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.release_dependencies
    ADD CONSTRAINT release_dependencies_release_fk FOREIGN KEY (root_id, release_revision) REFERENCES vortex_definition.releases(root_id, release_revision);


--
-- Name: release_dependencies release_dependencies_target_release_fk; Type: FK CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.release_dependencies
    ADD CONSTRAINT release_dependencies_target_release_fk FOREIGN KEY (target_root_id, target_release_revision, dependency_version, dependency_content_fingerprint) REFERENCES vortex_definition.releases(root_id, release_revision, release_version, content_fingerprint);


--
-- Name: releases releases_root_fk; Type: FK CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.releases
    ADD CONSTRAINT releases_root_fk FOREIGN KEY (root_id) REFERENCES vortex_definition.roots(root_id);


--
-- Name: roots roots_current_release_fk; Type: FK CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.roots
    ADD CONSTRAINT roots_current_release_fk FOREIGN KEY (root_id, current_release_revision) REFERENCES vortex_definition.releases(root_id, release_revision);


--
-- Name: roots roots_organization_fk; Type: FK CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.roots
    ADD CONSTRAINT roots_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: source_identities source_identities_root_fk; Type: FK CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.source_identities
    ADD CONSTRAINT source_identities_root_fk FOREIGN KEY (root_id) REFERENCES vortex_definition.roots(root_id);


--
-- Name: source_identity_aliases source_identity_aliases_owner_fk; Type: FK CONSTRAINT; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE ONLY vortex_definition.source_identity_aliases
    ADD CONSTRAINT source_identity_aliases_owner_fk FOREIGN KEY (root_id, owner_scope, kind, component_owner, identity_id) REFERENCES vortex_definition.source_identities(root_id, owner_scope, kind, component_owner, identity_id);


--
-- Name: consumer_occurrence_progress consumer_occurrence_progress_occurrence_id_fkey; Type: FK CONSTRAINT; Schema: vortex_event; Owner: postgres
--

ALTER TABLE ONLY vortex_event.consumer_occurrence_progress
    ADD CONSTRAINT consumer_occurrence_progress_occurrence_id_fkey FOREIGN KEY (occurrence_id) REFERENCES vortex_event.event_outbox(occurrence_id);


--
-- Name: event_outbox event_outbox_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_event; Owner: postgres
--

ALTER TABLE ONLY vortex_event.event_outbox
    ADD CONSTRAINT event_outbox_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: event_outbox event_outbox_storage_contract_id_fkey; Type: FK CONSTRAINT; Schema: vortex_event; Owner: postgres
--

ALTER TABLE ONLY vortex_event.event_outbox
    ADD CONSTRAINT event_outbox_storage_contract_id_fkey FOREIGN KEY (storage_contract_id) REFERENCES vortex_record.storage_catalogue(storage_contract_id);


--
-- Name: download_grants download_grants_file_id_fkey; Type: FK CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.download_grants
    ADD CONSTRAINT download_grants_file_id_fkey FOREIGN KEY (file_id) REFERENCES vortex_file.file_records(file_id);


--
-- Name: download_grants download_grants_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.download_grants
    ADD CONSTRAINT download_grants_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: file_records file_records_application_root_id_fkey; Type: FK CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.file_records
    ADD CONSTRAINT file_records_application_root_id_fkey FOREIGN KEY (application_root_id) REFERENCES vortex_definition.roots(root_id);


--
-- Name: file_records file_records_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.file_records
    ADD CONSTRAINT file_records_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: upload_grants upload_grants_file_id_fkey; Type: FK CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.upload_grants
    ADD CONSTRAINT upload_grants_file_id_fkey FOREIGN KEY (file_id) REFERENCES vortex_file.upload_reservations(file_id);


--
-- Name: upload_grants upload_grants_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.upload_grants
    ADD CONSTRAINT upload_grants_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: upload_reservations upload_reservations_capability_reservation_fk; Type: FK CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.upload_reservations
    ADD CONSTRAINT upload_reservations_capability_reservation_fk FOREIGN KEY (capability_reservation_id) REFERENCES vortex_access.capability_reservations(reservation_id) NOT VALID;


--
-- Name: upload_reservations upload_reservations_file_id_fkey; Type: FK CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.upload_reservations
    ADD CONSTRAINT upload_reservations_file_id_fkey FOREIGN KEY (file_id) REFERENCES vortex_file.file_records(file_id);


--
-- Name: upload_reservations upload_reservations_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.upload_reservations
    ADD CONSTRAINT upload_reservations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: upload_reservations upload_reservations_replacing_file_id_fkey; Type: FK CONSTRAINT; Schema: vortex_file; Owner: postgres
--

ALTER TABLE ONLY vortex_file.upload_reservations
    ADD CONSTRAINT upload_reservations_replacing_file_id_fkey FOREIGN KEY (replacing_file_id) REFERENCES vortex_file.file_records(file_id);


--
-- Name: accepted_administration_receipts accepted_administration_receipts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.accepted_administration_receipts
    ADD CONSTRAINT accepted_administration_receipts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: identity_disablement_events identity_disablement_events_command_id_fkey; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.identity_disablement_events
    ADD CONSTRAINT identity_disablement_events_command_id_fkey FOREIGN KEY (command_id) REFERENCES vortex_identity.identity_disablement_commands(command_id);


--
-- Name: organization_accounts organization_accounts_identity_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_accounts
    ADD CONSTRAINT organization_accounts_identity_fk FOREIGN KEY (identity_id) REFERENCES vortex_identity.identity_projections(identity_id);


--
-- Name: organization_accounts organization_accounts_organization_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_accounts
    ADD CONSTRAINT organization_accounts_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: organization_accounts organization_accounts_originating_invitation_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_accounts
    ADD CONSTRAINT organization_accounts_originating_invitation_fk FOREIGN KEY (organization_id, originating_invitation_id) REFERENCES vortex_identity.organization_invitations(organization_id, invitation_id);


--
-- Name: organization_accounts organization_accounts_provisioned_by_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_accounts
    ADD CONSTRAINT organization_accounts_provisioned_by_fk FOREIGN KEY (provisioned_by_identity_id) REFERENCES vortex_identity.identity_projections(identity_id);


--
-- Name: organization_accounts organization_accounts_provisioning_assignment_identity_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_accounts
    ADD CONSTRAINT organization_accounts_provisioning_assignment_identity_fk FOREIGN KEY (provisioning_assignment_id, provisioned_by_identity_id) REFERENCES vortex_identity.vortex_super_administrator_assignments(assignment_id, identity_id);


--
-- Name: organization_invitations organization_invitations_accepted_same_organization_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_invitations
    ADD CONSTRAINT organization_invitations_accepted_same_organization_fk FOREIGN KEY (organization_id, accepted_organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: organization_invitations organization_invitations_inviter_same_organization_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_invitations
    ADD CONSTRAINT organization_invitations_inviter_same_organization_fk FOREIGN KEY (organization_id, invited_by_organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: organization_invitations organization_invitations_organization_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_invitations
    ADD CONSTRAINT organization_invitations_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: organization_invitations organization_invitations_revoker_same_organization_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_invitations
    ADD CONSTRAINT organization_invitations_revoker_same_organization_fk FOREIGN KEY (organization_id, revoked_by_organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: organization_runtime_settings organization_runtime_settings_default_application_scope_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_runtime_settings
    ADD CONSTRAINT organization_runtime_settings_default_application_scope_fk FOREIGN KEY (organization_id, default_application_root_id) REFERENCES vortex_definition.roots(organization_id, root_id);


--
-- Name: organization_runtime_settings organization_runtime_settings_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organization_runtime_settings
    ADD CONSTRAINT organization_runtime_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: organizations organizations_parent_same_tenant_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organizations
    ADD CONSTRAINT organizations_parent_same_tenant_fk FOREIGN KEY (tenant_id, parent_organization_id) REFERENCES vortex_identity.organizations(tenant_id, organization_id);


--
-- Name: organizations organizations_tenant_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.organizations
    ADD CONSTRAINT organizations_tenant_fk FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: tenant_administrator_assignments tenant_administrator_assignments_identity_id_fkey; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.tenant_administrator_assignments
    ADD CONSTRAINT tenant_administrator_assignments_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES vortex_identity.identity_projections(identity_id);


--
-- Name: tenant_administrator_assignments tenant_administrator_assignments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.tenant_administrator_assignments
    ADD CONSTRAINT tenant_administrator_assignments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES vortex_identity.tenants(tenant_id);


--
-- Name: vortex_super_administrator_assignment_receipts vortex_super_administrator_assignment_receipts_assignment_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.vortex_super_administrator_assignment_receipts
    ADD CONSTRAINT vortex_super_administrator_assignment_receipts_assignment_fk FOREIGN KEY (assignment_id) REFERENCES vortex_identity.vortex_super_administrator_assignments(assignment_id);


--
-- Name: vortex_super_administrator_assignments vortex_super_administrator_assignments_identity_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.vortex_super_administrator_assignments
    ADD CONSTRAINT vortex_super_administrator_assignments_identity_fk FOREIGN KEY (identity_id) REFERENCES vortex_identity.identity_projections(identity_id);


--
-- Name: vortex_super_administrator_assignments vortex_super_administrator_assignments_revoker_fk; Type: FK CONSTRAINT; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE ONLY vortex_identity.vortex_super_administrator_assignments
    ADD CONSTRAINT vortex_super_administrator_assignments_revoker_fk FOREIGN KEY (revoked_by_id) REFERENCES vortex_identity.identity_projections(identity_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: installation_bindings installation_bindings_application_root_id_application_rele_fkey; Type: FK CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.installation_bindings
    ADD CONSTRAINT installation_bindings_application_root_id_application_rele_fkey FOREIGN KEY (application_root_id, application_release_revision) REFERENCES vortex_definition.releases(root_id, release_revision);


--
-- Name: installation_bindings installation_bindings_module_root_id_module_release_revisi_fkey; Type: FK CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.installation_bindings
    ADD CONSTRAINT installation_bindings_module_root_id_module_release_revisi_fkey FOREIGN KEY (module_root_id, module_release_revision) REFERENCES vortex_definition.releases(root_id, release_revision);


--
-- Name: installation_bindings installation_bindings_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.installation_bindings
    ADD CONSTRAINT installation_bindings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: installation_runtime_bundle_parts installation_runtime_bundle_parts_bundle_fk; Type: FK CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.installation_runtime_bundle_parts
    ADD CONSTRAINT installation_runtime_bundle_parts_bundle_fk FOREIGN KEY (organization_id, application_root_id, application_release_revision, bundle_format_version) REFERENCES vortex_module.installation_runtime_bundles(organization_id, application_root_id, application_release_revision, bundle_format_version);


--
-- Name: installation_runtime_bundles installation_runtime_bundles_application_release_fk; Type: FK CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.installation_runtime_bundles
    ADD CONSTRAINT installation_runtime_bundles_application_release_fk FOREIGN KEY (application_root_id, application_release_revision) REFERENCES vortex_definition.releases(root_id, release_revision);


--
-- Name: installation_runtime_bundles installation_runtime_bundles_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.installation_runtime_bundles
    ADD CONSTRAINT installation_runtime_bundles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: preview_installations preview_installations_application_root_id_fkey; Type: FK CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.preview_installations
    ADD CONSTRAINT preview_installations_application_root_id_fkey FOREIGN KEY (application_root_id) REFERENCES vortex_definition.roots(root_id);


--
-- Name: preview_installations preview_installations_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.preview_installations
    ADD CONSTRAINT preview_installations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: preview_installations preview_installations_organization_id_previewer_organizati_fkey; Type: FK CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.preview_installations
    ADD CONSTRAINT preview_installations_organization_id_previewer_organizati_fkey FOREIGN KEY (organization_id, previewer_organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: preview_installations preview_installations_previewer_identity_id_fkey; Type: FK CONSTRAINT; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE ONLY vortex_module.preview_installations
    ADD CONSTRAINT preview_installations_previewer_identity_id_fkey FOREIGN KEY (previewer_identity_id) REFERENCES vortex_identity.identity_projections(identity_id);


--
-- Name: organization_setup_source_manifests setup_source_manifest_organization_fk; Type: FK CONSTRAINT; Schema: vortex_module; Owner: postgres
--

ALTER TABLE ONLY vortex_module.organization_setup_source_manifests
    ADD CONSTRAINT setup_source_manifest_organization_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES vortex_identity.organizations(tenant_id, organization_id);


--
-- Name: organization_setup_source_manifests setup_source_manifest_receipt_fk; Type: FK CONSTRAINT; Schema: vortex_module; Owner: postgres
--

ALTER TABLE ONLY vortex_module.organization_setup_source_manifests
    ADD CONSTRAINT setup_source_manifest_receipt_fk FOREIGN KEY (receipt_id) REFERENCES vortex_identity.accepted_administration_receipts(receipt_id);


--
-- Name: form_drafts form_drafts_account_same_organization_fk; Type: FK CONSTRAINT; Schema: vortex_page; Owner: postgres
--

ALTER TABLE ONLY vortex_page.form_drafts
    ADD CONSTRAINT form_drafts_account_same_organization_fk FOREIGN KEY (organization_id, organization_account_id) REFERENCES vortex_identity.organization_accounts(organization_id, organization_account_id);


--
-- Name: form_drafts form_drafts_identity_same_organization_fk; Type: FK CONSTRAINT; Schema: vortex_page; Owner: postgres
--

ALTER TABLE ONLY vortex_page.form_drafts
    ADD CONSTRAINT form_drafts_identity_same_organization_fk FOREIGN KEY (organization_id, identity_id) REFERENCES vortex_identity.organization_accounts(organization_id, identity_id);


--
-- Name: field_storage_mappings field_storage_mappings_storage_contract_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.field_storage_mappings
    ADD CONSTRAINT field_storage_mappings_storage_contract_id_fkey FOREIGN KEY (storage_contract_id) REFERENCES vortex_record.storage_catalogue(storage_contract_id);


--
-- Name: index_catalogue index_catalogue_storage_contract_id_field_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.index_catalogue
    ADD CONSTRAINT index_catalogue_storage_contract_id_field_id_fkey FOREIGN KEY (storage_contract_id, field_id) REFERENCES vortex_record.field_storage_mappings(storage_contract_id, field_id);


--
-- Name: organization_lifecycle_limits organization_lifecycle_limits_organization_fk; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.organization_lifecycle_limits
    ADD CONSTRAINT organization_lifecycle_limits_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: preview_command_receipts preview_command_receipts_preview_installation_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE ONLY vortex_record.preview_command_receipts
    ADD CONSTRAINT preview_command_receipts_preview_installation_id_fkey FOREIGN KEY (preview_installation_id) REFERENCES vortex_module.preview_installations(preview_installation_id) ON DELETE CASCADE;


--
-- Name: preview_reference_counters preview_reference_counters_preview_installation_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE ONLY vortex_record.preview_reference_counters
    ADD CONSTRAINT preview_reference_counters_preview_installation_id_fkey FOREIGN KEY (preview_installation_id) REFERENCES vortex_module.preview_installations(preview_installation_id) ON DELETE CASCADE;


--
-- Name: preview_storage_bindings preview_storage_bindings_preview_installation_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.preview_storage_bindings
    ADD CONSTRAINT preview_storage_bindings_preview_installation_id_fkey FOREIGN KEY (preview_installation_id) REFERENCES vortex_module.preview_installations(preview_installation_id) ON DELETE CASCADE;


--
-- Name: preview_storage_bindings preview_storage_bindings_storage_contract_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.preview_storage_bindings
    ADD CONSTRAINT preview_storage_bindings_storage_contract_id_fkey FOREIGN KEY (storage_contract_id) REFERENCES vortex_record.storage_catalogue(storage_contract_id);


--
-- Name: record_lifecycle_command_effects record_lifecycle_command_effects_receipt_fk; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE ONLY vortex_record.record_lifecycle_command_effects
    ADD CONSTRAINT record_lifecycle_command_effects_receipt_fk FOREIGN KEY (organization_id, application_root_id, actor_organization_account_id, command_kind, command_id) REFERENCES vortex_record.command_receipts(organization_id, application_root_id, actor_organization_account_id, command_kind, command_id) ON DELETE CASCADE;


--
-- Name: record_reference_counters record_reference_counters_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.record_reference_counters
    ADD CONSTRAINT record_reference_counters_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: record_reference_counters record_reference_counters_storage_contract_id_field_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.record_reference_counters
    ADD CONSTRAINT record_reference_counters_storage_contract_id_field_id_fkey FOREIGN KEY (storage_contract_id, field_id) REFERENCES vortex_record.field_storage_mappings(storage_contract_id, field_id);


--
-- Name: record_reference_counters record_reference_counters_storage_contract_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.record_reference_counters
    ADD CONSTRAINT record_reference_counters_storage_contract_id_fkey FOREIGN KEY (storage_contract_id) REFERENCES vortex_record.storage_catalogue(storage_contract_id);


--
-- Name: record_type_lifecycle_policies record_type_lifecycle_policies_application_fk; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.record_type_lifecycle_policies
    ADD CONSTRAINT record_type_lifecycle_policies_application_fk FOREIGN KEY (application_root_id) REFERENCES vortex_definition.roots(root_id);


--
-- Name: record_type_lifecycle_policies record_type_lifecycle_policies_organization_fk; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.record_type_lifecycle_policies
    ADD CONSTRAINT record_type_lifecycle_policies_organization_fk FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: record_type_lifecycle_policies record_type_lifecycle_policies_storage_fk; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.record_type_lifecycle_policies
    ADD CONSTRAINT record_type_lifecycle_policies_storage_fk FOREIGN KEY (storage_contract_id) REFERENCES vortex_record.storage_catalogue(storage_contract_id);


--
-- Name: relationship_edges relationship_edges_from_organisation_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.relationship_edges
    ADD CONSTRAINT relationship_edges_from_organisation_id_fkey FOREIGN KEY (from_organisation_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: relationship_edges relationship_edges_from_storage_contract_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.relationship_edges
    ADD CONSTRAINT relationship_edges_from_storage_contract_id_fkey FOREIGN KEY (from_storage_contract_id) REFERENCES vortex_record.storage_catalogue(storage_contract_id);


--
-- Name: relationship_edges relationship_edges_relationship_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.relationship_edges
    ADD CONSTRAINT relationship_edges_relationship_id_fkey FOREIGN KEY (relationship_id) REFERENCES vortex_record.relationship_storage_mappings(relationship_id);


--
-- Name: relationship_edges relationship_edges_to_organisation_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.relationship_edges
    ADD CONSTRAINT relationship_edges_to_organisation_id_fkey FOREIGN KEY (to_organisation_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: relationship_edges relationship_edges_to_storage_contract_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.relationship_edges
    ADD CONSTRAINT relationship_edges_to_storage_contract_id_fkey FOREIGN KEY (to_storage_contract_id) REFERENCES vortex_record.storage_catalogue(storage_contract_id);


--
-- Name: relationship_storage_mappings relationship_storage_mappings_source_storage_contract_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.relationship_storage_mappings
    ADD CONSTRAINT relationship_storage_mappings_source_storage_contract_id_fkey FOREIGN KEY (source_storage_contract_id) REFERENCES vortex_record.storage_catalogue(storage_contract_id);


--
-- Name: relationship_storage_mappings relationship_storage_mappings_source_storage_contract_id_s_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.relationship_storage_mappings
    ADD CONSTRAINT relationship_storage_mappings_source_storage_contract_id_s_fkey FOREIGN KEY (source_storage_contract_id, source_field_id) REFERENCES vortex_record.field_storage_mappings(storage_contract_id, field_id);


--
-- Name: release_provisions release_provisions_module_root_id_release_revision_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.release_provisions
    ADD CONSTRAINT release_provisions_module_root_id_release_revision_fkey FOREIGN KEY (module_root_id, release_revision) REFERENCES vortex_definition.releases(root_id, release_revision);


--
-- Name: storage_catalogue storage_catalogue_protected_read_model_key_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_catalogue
    ADD CONSTRAINT storage_catalogue_protected_read_model_key_fkey FOREIGN KEY (protected_read_model_key) REFERENCES vortex_record.protected_read_model_views(protected_read_model_key);


--
-- Name: storage_conversion_catalogue storage_conversion_catalogue_source_storage_contract_id_so_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_conversion_catalogue
    ADD CONSTRAINT storage_conversion_catalogue_source_storage_contract_id_so_fkey FOREIGN KEY (source_storage_contract_id, source_field_id) REFERENCES vortex_record.field_storage_mappings(storage_contract_id, field_id);


--
-- Name: storage_conversion_plans storage_conversion_plans_conversion_contract_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_conversion_plans
    ADD CONSTRAINT storage_conversion_plans_conversion_contract_id_fkey FOREIGN KEY (conversion_contract_id) REFERENCES vortex_record.storage_conversion_catalogue(conversion_contract_id);


--
-- Name: storage_conversion_plans storage_conversion_plans_organisation_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_conversion_plans
    ADD CONSTRAINT storage_conversion_plans_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: storage_conversion_progress storage_conversion_progress_conversion_contract_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_conversion_progress
    ADD CONSTRAINT storage_conversion_progress_conversion_contract_id_fkey FOREIGN KEY (conversion_contract_id) REFERENCES vortex_record.storage_conversion_catalogue(conversion_contract_id);


--
-- Name: storage_conversion_progress storage_conversion_progress_organisation_id_fkey; Type: FK CONSTRAINT; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE ONLY vortex_record.storage_conversion_progress
    ADD CONSTRAINT storage_conversion_progress_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: documents documents_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_search; Owner: postgres
--

ALTER TABLE ONLY vortex_search.documents
    ADD CONSTRAINT documents_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: flow_continuations flow_continuations_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.flow_continuations
    ADD CONSTRAINT flow_continuations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: flow_effect_ledger flow_effect_ledger_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.flow_effect_ledger
    ADD CONSTRAINT flow_effect_ledger_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: flow_registrations flow_registrations_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.flow_registrations
    ADD CONSTRAINT flow_registrations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: flow_start_intents flow_start_intents_flow_release_fk; Type: FK CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.flow_start_intents
    ADD CONSTRAINT flow_start_intents_flow_release_fk FOREIGN KEY (flow_owner_root_id, flow_release_revision) REFERENCES vortex_definition.releases(root_id, release_revision);


--
-- Name: flow_start_intents flow_start_intents_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.flow_start_intents
    ADD CONSTRAINT flow_start_intents_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: flow_start_intents flow_start_intents_release_fk; Type: FK CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.flow_start_intents
    ADD CONSTRAINT flow_start_intents_release_fk FOREIGN KEY (application_root_id, application_release_revision) REFERENCES vortex_definition.releases(root_id, release_revision);


--
-- Name: protected_workflow_runs protected_workflow_runs_organization_id_fkey; Type: FK CONSTRAINT; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE ONLY vortex_workflow.protected_workflow_runs
    ADD CONSTRAINT protected_workflow_runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES vortex_identity.organizations(organization_id);


--
-- Name: application_role_template_continuities; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.application_role_template_continuities ENABLE ROW LEVEL SECURITY;

--
-- Name: capability_limit_changes; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.capability_limit_changes ENABLE ROW LEVEL SECURITY;

--
-- Name: capability_policy_assignments; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.capability_policy_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: capability_policy_definitions; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.capability_policy_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: capability_reservation_balances; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.capability_reservation_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: capability_reservation_commands; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.capability_reservation_commands ENABLE ROW LEVEL SECURITY;

--
-- Name: capability_reservations; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.capability_reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_execution_bindings; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.flow_execution_bindings ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_run_as_principals; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.flow_run_as_principals ENABLE ROW LEVEL SECURITY;

--
-- Name: metering_events; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.metering_events ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_access_versions; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_access_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_delegation_authorities; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_delegation_authorities ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_delegation_authorities organization_delegation_authorities_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY organization_delegation_authorities_access_owner_select ON vortex_access.organization_delegation_authorities FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: organization_direct_record_shares; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_direct_record_shares ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_direct_record_shares organization_direct_record_shares_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY organization_direct_record_shares_access_owner_select ON vortex_access.organization_direct_record_shares FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: organization_group_memberships; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_group_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_group_memberships organization_group_memberships_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY organization_group_memberships_access_owner_select ON vortex_access.organization_group_memberships FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: organization_groups; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_groups organization_groups_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY organization_groups_access_owner_select ON vortex_access.organization_groups FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: organization_role_activation_policy_revisions; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_role_activation_policy_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_role_activations; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_role_activations ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_role_activations organization_role_activations_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY organization_role_activations_access_owner_select ON vortex_access.organization_role_activations FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: organization_role_assignments; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_role_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_role_assignments organization_role_assignments_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY organization_role_assignments_access_owner_select ON vortex_access.organization_role_assignments FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: organization_role_permission_entries; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_role_permission_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_role_permission_entries organization_role_permission_entries_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY organization_role_permission_entries_access_owner_select ON vortex_access.organization_role_permission_entries FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: organization_role_revisions; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_role_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_role_revisions organization_role_revisions_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY organization_role_revisions_access_owner_select ON vortex_access.organization_role_revisions FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: organization_roles; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_roles organization_roles_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY organization_roles_access_owner_select ON vortex_access.organization_roles FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: organization_stewardship_requirements; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.organization_stewardship_requirements ENABLE ROW LEVEL SECURITY;

--
-- Name: permission_catalogue_entries; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.permission_catalogue_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: permission_catalogue_entries permission_catalogue_entries_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY permission_catalogue_entries_access_owner_select ON vortex_access.permission_catalogue_entries FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: permission_continuities; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.permission_continuities ENABLE ROW LEVEL SECURITY;

--
-- Name: permission_continuities permission_continuities_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY permission_continuities_access_owner_select ON vortex_access.permission_continuities FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: permission_registration_revisions; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.permission_registration_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: permission_registration_revisions permission_registration_revisions_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY permission_registration_revisions_access_owner_select ON vortex_access.permission_registration_revisions FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: permission_registrations; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.permission_registrations ENABLE ROW LEVEL SECURITY;

--
-- Name: permission_registrations permission_registrations_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY permission_registrations_access_owner_select ON vortex_access.permission_registrations FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: record_share_grant_consent_decisions; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.record_share_grant_consent_decisions ENABLE ROW LEVEL SECURITY;

--
-- Name: record_share_grant_consent_requests; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.record_share_grant_consent_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: record_share_grants; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.record_share_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: system_actor_grants; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.system_actor_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_projection_reconciliation; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.usage_projection_reconciliation ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_projection_rollups; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.usage_projection_rollups ENABLE ROW LEVEL SECURITY;

--
-- Name: validation_reference_values; Type: ROW SECURITY; Schema: vortex_access; Owner: postgres
--

ALTER TABLE vortex_access.validation_reference_values ENABLE ROW LEVEL SECURITY;

--
-- Name: validation_reference_values validation_reference_values_access_owner_select; Type: POLICY; Schema: vortex_access; Owner: postgres
--

CREATE POLICY validation_reference_values_access_owner_select ON vortex_access.validation_reference_values FOR SELECT TO vortex_access_owner USING (true);


--
-- Name: organization_activity_entries; Type: ROW SECURITY; Schema: vortex_activity; Owner: postgres
--

ALTER TABLE vortex_activity.organization_activity_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_activity_entries organization_activity_entries_activity_owner_select; Type: POLICY; Schema: vortex_activity; Owner: postgres
--

CREATE POLICY organization_activity_entries_activity_owner_select ON vortex_activity.organization_activity_entries FOR SELECT TO vortex_activity_owner USING (true);


--
-- Name: organization_activity_super_administrator_authority; Type: ROW SECURITY; Schema: vortex_activity; Owner: postgres
--

ALTER TABLE vortex_activity.organization_activity_super_administrator_authority ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_activity_super_administrator_authority organization_activity_super_administrator_authority_activity_ow; Type: POLICY; Schema: vortex_activity; Owner: postgres
--

CREATE POLICY organization_activity_super_administrator_authority_activity_ow ON vortex_activity.organization_activity_super_administrator_authority FOR SELECT TO vortex_activity_owner USING (true);


--
-- Name: connection_application_grants; Type: ROW SECURITY; Schema: vortex_connection; Owner: postgres
--

ALTER TABLE vortex_connection.connection_application_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_application_grants connection_application_grants_owner_delete; Type: POLICY; Schema: vortex_connection; Owner: postgres
--

CREATE POLICY connection_application_grants_owner_delete ON vortex_connection.connection_application_grants FOR DELETE TO vortex_connection_owner USING ((organization_id = vortex_context.organization_id()));


--
-- Name: connection_application_grants connection_application_grants_owner_select; Type: POLICY; Schema: vortex_connection; Owner: postgres
--

CREATE POLICY connection_application_grants_owner_select ON vortex_connection.connection_application_grants FOR SELECT TO vortex_connection_owner USING ((organization_id = vortex_context.organization_id()));


--
-- Name: connection_application_grants connection_application_grants_owner_update; Type: POLICY; Schema: vortex_connection; Owner: postgres
--

CREATE POLICY connection_application_grants_owner_update ON vortex_connection.connection_application_grants FOR UPDATE TO vortex_connection_owner USING ((organization_id = vortex_context.organization_id())) WITH CHECK ((organization_id = vortex_context.organization_id()));


--
-- Name: connection_instances; Type: ROW SECURITY; Schema: vortex_connection; Owner: postgres
--

ALTER TABLE vortex_connection.connection_instances ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_instances connection_instances_owner_insert; Type: POLICY; Schema: vortex_connection; Owner: postgres
--

CREATE POLICY connection_instances_owner_insert ON vortex_connection.connection_instances FOR INSERT TO vortex_connection_owner WITH CHECK ((organization_id = vortex_context.organization_id()));


--
-- Name: connection_instances connection_instances_owner_select; Type: POLICY; Schema: vortex_connection; Owner: postgres
--

CREATE POLICY connection_instances_owner_select ON vortex_connection.connection_instances FOR SELECT TO vortex_connection_owner USING ((organization_id = vortex_context.organization_id()));


--
-- Name: connection_instances connection_instances_owner_update; Type: POLICY; Schema: vortex_connection; Owner: postgres
--

CREATE POLICY connection_instances_owner_update ON vortex_connection.connection_instances FOR UPDATE TO vortex_connection_owner USING ((organization_id = vortex_context.organization_id())) WITH CHECK ((organization_id = vortex_context.organization_id()));


--
-- Name: request_contexts; Type: ROW SECURITY; Schema: vortex_context; Owner: postgres
--

ALTER TABLE vortex_context.request_contexts ENABLE ROW LEVEL SECURITY;

--
-- Name: drafts; Type: ROW SECURITY; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE vortex_definition.drafts ENABLE ROW LEVEL SECURITY;

--
-- Name: release_dependencies module_installation_definition_dependencies_read; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY module_installation_definition_dependencies_read ON vortex_definition.release_dependencies FOR SELECT TO vortex_module_owner USING (true);


--
-- Name: releases module_installation_definition_releases_read; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY module_installation_definition_releases_read ON vortex_definition.releases FOR SELECT TO vortex_module_owner USING (true);


--
-- Name: roots module_installation_definition_roots_read; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY module_installation_definition_roots_read ON vortex_definition.roots FOR SELECT TO vortex_module_owner USING (true);


--
-- Name: drafts module_preview_draft_revision_lock; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY module_preview_draft_revision_lock ON vortex_definition.drafts FOR UPDATE TO vortex_module_owner USING ((root_id = ((vortex_access.validated_human_request_context() ->> 'applicationRootId'::text))::uuid)) WITH CHECK (false);


--
-- Name: drafts module_preview_draft_revision_read; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY module_preview_draft_revision_read ON vortex_definition.drafts FOR SELECT TO vortex_module_owner USING ((root_id = ((vortex_access.validated_human_request_context() ->> 'applicationRootId'::text))::uuid));


--
-- Name: roots record_action_capabilities_definition_roots_read; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY record_action_capabilities_definition_roots_read ON vortex_definition.roots FOR SELECT TO vortex_record_adapter USING ((organization_id = vortex_context.organization_id()));


--
-- Name: releases record_adapter_definition_releases_read; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY record_adapter_definition_releases_read ON vortex_definition.releases FOR SELECT TO vortex_record_adapter USING (true);


--
-- Name: release_dependencies record_storage_definition_dependencies_read; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY record_storage_definition_dependencies_read ON vortex_definition.release_dependencies FOR SELECT TO vortex_record_owner USING (true);


--
-- Name: releases record_storage_definition_releases_read; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY record_storage_definition_releases_read ON vortex_definition.releases FOR SELECT TO vortex_record_owner USING (true);


--
-- Name: roots record_storage_definition_roots_read; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY record_storage_definition_roots_read ON vortex_definition.roots FOR SELECT TO vortex_record_owner USING (true);


--
-- Name: release_dependencies; Type: ROW SECURITY; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE vortex_definition.release_dependencies ENABLE ROW LEVEL SECURITY;

--
-- Name: releases; Type: ROW SECURITY; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE vortex_definition.releases ENABLE ROW LEVEL SECURITY;

--
-- Name: releases releases_owner_select; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY releases_owner_select ON vortex_definition.releases FOR SELECT TO vortex_definition_owner USING ((EXISTS ( SELECT 1
   FROM vortex_definition.roots root
  WHERE ((root.root_id = releases.root_id) AND (root.organization_id = ((vortex_access.validated_human_request_context() ->> 'organizationId'::text))::uuid)))));


--
-- Name: roots; Type: ROW SECURITY; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE vortex_definition.roots ENABLE ROW LEVEL SECURITY;

--
-- Name: roots roots_owner_select; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY roots_owner_select ON vortex_definition.roots FOR SELECT TO vortex_definition_owner USING ((kind = 'application'::text));


--
-- Name: source_identities; Type: ROW SECURITY; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE vortex_definition.source_identities ENABLE ROW LEVEL SECURITY;

--
-- Name: source_identities source_identities_human_application_role_select; Type: POLICY; Schema: vortex_definition; Owner: postgres
--

CREATE POLICY source_identities_human_application_role_select ON vortex_definition.source_identities FOR SELECT TO vortex_definition_owner USING (((kind = 'role'::text) AND (EXISTS ( SELECT 1
   FROM vortex_definition.roots root
  WHERE ((root.root_id = source_identities.root_id) AND (root.kind = 'application'::text) AND (root.organization_id = ((vortex_access.validated_human_request_context() ->> 'organizationId'::text))::uuid))))));


--
-- Name: source_identity_aliases; Type: ROW SECURITY; Schema: vortex_definition; Owner: postgres
--

ALTER TABLE vortex_definition.source_identity_aliases ENABLE ROW LEVEL SECURITY;

--
-- Name: consumer_occurrence_progress; Type: ROW SECURITY; Schema: vortex_event; Owner: postgres
--

ALTER TABLE vortex_event.consumer_occurrence_progress ENABLE ROW LEVEL SECURITY;

--
-- Name: consumer_occurrence_progress consumer_occurrence_progress_event_owner_insert; Type: POLICY; Schema: vortex_event; Owner: postgres
--

CREATE POLICY consumer_occurrence_progress_event_owner_insert ON vortex_event.consumer_occurrence_progress FOR INSERT TO vortex_event_owner WITH CHECK (true);


--
-- Name: consumer_occurrence_progress consumer_occurrence_progress_event_owner_select; Type: POLICY; Schema: vortex_event; Owner: postgres
--

CREATE POLICY consumer_occurrence_progress_event_owner_select ON vortex_event.consumer_occurrence_progress FOR SELECT TO vortex_event_owner USING (true);


--
-- Name: consumer_occurrence_progress consumer_occurrence_progress_event_owner_update; Type: POLICY; Schema: vortex_event; Owner: postgres
--

CREATE POLICY consumer_occurrence_progress_event_owner_update ON vortex_event.consumer_occurrence_progress FOR UPDATE TO vortex_event_owner USING (true) WITH CHECK (true);


--
-- Name: event_outbox; Type: ROW SECURITY; Schema: vortex_event; Owner: postgres
--

ALTER TABLE vortex_event.event_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: event_outbox event_outbox_event_owner_select; Type: POLICY; Schema: vortex_event; Owner: postgres
--

CREATE POLICY event_outbox_event_owner_select ON vortex_event.event_outbox FOR SELECT TO vortex_event_owner USING (true);


--
-- Name: download_grants; Type: ROW SECURITY; Schema: vortex_file; Owner: postgres
--

ALTER TABLE vortex_file.download_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: download_grants download_grants_file_owner_delete; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY download_grants_file_owner_delete ON vortex_file.download_grants FOR DELETE TO vortex_file_owner USING ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid));


--
-- Name: download_grants download_grants_file_owner_insert; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY download_grants_file_owner_insert ON vortex_file.download_grants FOR INSERT TO vortex_file_owner WITH CHECK ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid));


--
-- Name: download_grants download_grants_file_owner_read; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY download_grants_file_owner_read ON vortex_file.download_grants FOR SELECT TO vortex_file_owner USING ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid));


--
-- Name: download_grants download_grants_file_owner_update; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY download_grants_file_owner_update ON vortex_file.download_grants FOR UPDATE TO vortex_file_owner USING ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid)) WITH CHECK ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid));


--
-- Name: file_records; Type: ROW SECURITY; Schema: vortex_file; Owner: postgres
--

ALTER TABLE vortex_file.file_records ENABLE ROW LEVEL SECURITY;

--
-- Name: file_records file_records_file_owner_read; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY file_records_file_owner_read ON vortex_file.file_records FOR SELECT TO vortex_file_owner USING ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid));


--
-- Name: file_records file_records_file_owner_update; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY file_records_file_owner_update ON vortex_file.file_records FOR UPDATE TO vortex_file_owner USING ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid)) WITH CHECK ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid));


--
-- Name: file_records file_records_request_read; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY file_records_request_read ON vortex_file.file_records FOR SELECT TO vortex_request USING ((organization_id = vortex_context.organization_id()));


--
-- Name: upload_grants; Type: ROW SECURITY; Schema: vortex_file; Owner: postgres
--

ALTER TABLE vortex_file.upload_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: upload_grants upload_grants_file_owner_insert; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY upload_grants_file_owner_insert ON vortex_file.upload_grants FOR INSERT TO vortex_file_owner WITH CHECK ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid));


--
-- Name: upload_grants upload_grants_file_owner_read; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY upload_grants_file_owner_read ON vortex_file.upload_grants FOR SELECT TO vortex_file_owner USING ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid));


--
-- Name: upload_grants upload_grants_file_owner_update; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY upload_grants_file_owner_update ON vortex_file.upload_grants FOR UPDATE TO vortex_file_owner USING ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid)) WITH CHECK ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid));


--
-- Name: upload_reservations; Type: ROW SECURITY; Schema: vortex_file; Owner: postgres
--

ALTER TABLE vortex_file.upload_reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: upload_reservations upload_reservations_file_owner_read; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY upload_reservations_file_owner_read ON vortex_file.upload_reservations FOR SELECT TO vortex_file_owner USING ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid));


--
-- Name: upload_reservations upload_reservations_file_owner_update; Type: POLICY; Schema: vortex_file; Owner: postgres
--

CREATE POLICY upload_reservations_file_owner_update ON vortex_file.upload_reservations FOR UPDATE TO vortex_file_owner USING ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid)) WITH CHECK ((organization_id = ((vortex_file.upload_validated_context() ->> 'organizationId'::text))::uuid));


--
-- Name: accepted_administration_receipts; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.accepted_administration_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_disablement_commands; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.identity_disablement_commands ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_disablement_events; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.identity_disablement_events ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_projections identity_owner_1461_identity_projections_select; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_1461_identity_projections_select ON vortex_identity.identity_projections FOR SELECT TO vortex_identity_owner USING (true);


--
-- Name: organizations identity_owner_1461_organizations_select; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_1461_organizations_select ON vortex_identity.organizations FOR SELECT TO vortex_identity_owner USING (true);


--
-- Name: tenant_administrator_assignments identity_owner_1461_tenant_administrator_assignments_select; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_1461_tenant_administrator_assignments_select ON vortex_identity.tenant_administrator_assignments FOR SELECT TO vortex_identity_owner USING (true);


--
-- Name: tenants identity_owner_1461_tenants_select; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_1461_tenants_select ON vortex_identity.tenants FOR SELECT TO vortex_identity_owner USING (true);


--
-- Name: organization_accounts identity_owner_accounts_insert; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_accounts_insert ON vortex_identity.organization_accounts FOR INSERT TO vortex_identity_owner WITH CHECK (true);


--
-- Name: organization_accounts identity_owner_accounts_select; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_accounts_select ON vortex_identity.organization_accounts FOR SELECT TO vortex_identity_owner USING (true);


--
-- Name: organization_accounts identity_owner_accounts_update; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_accounts_update ON vortex_identity.organization_accounts FOR UPDATE TO vortex_identity_owner USING (true) WITH CHECK (true);


--
-- Name: identity_disablement_commands identity_owner_disablement_commands_select; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_disablement_commands_select ON vortex_identity.identity_disablement_commands FOR SELECT TO vortex_identity_owner USING (true);


--
-- Name: organization_invitations identity_owner_invitations_insert; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_invitations_insert ON vortex_identity.organization_invitations FOR INSERT TO vortex_identity_owner WITH CHECK (true);


--
-- Name: organization_invitations identity_owner_invitations_select; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_invitations_select ON vortex_identity.organization_invitations FOR SELECT TO vortex_identity_owner USING (true);


--
-- Name: organization_invitations identity_owner_invitations_update; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_invitations_update ON vortex_identity.organization_invitations FOR UPDATE TO vortex_identity_owner USING (true) WITH CHECK (true);


--
-- Name: organizations identity_owner_organizations_select; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_organizations_select ON vortex_identity.organizations FOR SELECT TO vortex_identity_owner USING (true);


--
-- Name: organizations identity_owner_organizations_update; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_organizations_update ON vortex_identity.organizations FOR UPDATE TO vortex_identity_owner USING (true) WITH CHECK (true);


--
-- Name: identity_projections identity_owner_projections_insert; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_projections_insert ON vortex_identity.identity_projections FOR INSERT TO vortex_identity_owner WITH CHECK (true);


--
-- Name: identity_projections identity_owner_projections_select; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_projections_select ON vortex_identity.identity_projections FOR SELECT TO vortex_identity_owner USING (true);


--
-- Name: identity_projections identity_owner_projections_update; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_projections_update ON vortex_identity.identity_projections FOR UPDATE TO vortex_identity_owner USING (true) WITH CHECK (true);


--
-- Name: organization_runtime_settings identity_owner_runtime_settings_insert; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_runtime_settings_insert ON vortex_identity.organization_runtime_settings FOR INSERT TO vortex_identity_owner WITH CHECK (true);


--
-- Name: organization_runtime_settings identity_owner_runtime_settings_select; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_runtime_settings_select ON vortex_identity.organization_runtime_settings FOR SELECT TO vortex_identity_owner USING (true);


--
-- Name: organization_runtime_settings identity_owner_runtime_settings_update; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_runtime_settings_update ON vortex_identity.organization_runtime_settings FOR UPDATE TO vortex_identity_owner USING (true) WITH CHECK (true);


--
-- Name: tenants identity_owner_tenants_select; Type: POLICY; Schema: vortex_identity; Owner: postgres
--

CREATE POLICY identity_owner_tenants_select ON vortex_identity.tenants FOR SELECT TO vortex_identity_owner USING (true);


--
-- Name: identity_projections; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.identity_projections ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_accounts; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.organization_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_invitations; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.organization_invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_runtime_settings; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.organization_runtime_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: organizations; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.organizations ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_administrator_assignments; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.tenant_administrator_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: tenants; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.tenants ENABLE ROW LEVEL SECURITY;

--
-- Name: vortex_super_administrator_assignment_receipts; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.vortex_super_administrator_assignment_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: vortex_super_administrator_assignments; Type: ROW SECURITY; Schema: vortex_identity; Owner: postgres
--

ALTER TABLE vortex_identity.vortex_super_administrator_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: installation_bindings; Type: ROW SECURITY; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE vortex_module.installation_bindings ENABLE ROW LEVEL SECURITY;

--
-- Name: installation_bindings installation_bindings_owner; Type: POLICY; Schema: vortex_module; Owner: vortex_module_owner
--

CREATE POLICY installation_bindings_owner ON vortex_module.installation_bindings TO vortex_module_owner USING (true) WITH CHECK (true);


--
-- Name: installation_runtime_bundle_parts; Type: ROW SECURITY; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE vortex_module.installation_runtime_bundle_parts ENABLE ROW LEVEL SECURITY;

--
-- Name: installation_runtime_bundle_parts installation_runtime_bundle_parts_owner; Type: POLICY; Schema: vortex_module; Owner: vortex_module_owner
--

CREATE POLICY installation_runtime_bundle_parts_owner ON vortex_module.installation_runtime_bundle_parts TO vortex_module_owner USING (true) WITH CHECK (true);


--
-- Name: installation_runtime_bundles; Type: ROW SECURITY; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE vortex_module.installation_runtime_bundles ENABLE ROW LEVEL SECURITY;

--
-- Name: installation_runtime_bundles installation_runtime_bundles_owner; Type: POLICY; Schema: vortex_module; Owner: vortex_module_owner
--

CREATE POLICY installation_runtime_bundles_owner ON vortex_module.installation_runtime_bundles TO vortex_module_owner USING (true) WITH CHECK (true);


--
-- Name: organization_setup_source_manifests; Type: ROW SECURITY; Schema: vortex_module; Owner: postgres
--

ALTER TABLE vortex_module.organization_setup_source_manifests ENABLE ROW LEVEL SECURITY;

--
-- Name: preview_installations; Type: ROW SECURITY; Schema: vortex_module; Owner: vortex_module_owner
--

ALTER TABLE vortex_module.preview_installations ENABLE ROW LEVEL SECURITY;

--
-- Name: preview_installations preview_installations_owner; Type: POLICY; Schema: vortex_module; Owner: vortex_module_owner
--

CREATE POLICY preview_installations_owner ON vortex_module.preview_installations TO vortex_module_owner USING (true) WITH CHECK (true);


--
-- Name: organization_setup_source_manifests setup_source_manifest_definer_insert; Type: POLICY; Schema: vortex_module; Owner: postgres
--

CREATE POLICY setup_source_manifest_definer_insert ON vortex_module.organization_setup_source_manifests FOR INSERT TO postgres WITH CHECK (true);


--
-- Name: organization_setup_source_manifests setup_source_manifest_definer_select; Type: POLICY; Schema: vortex_module; Owner: postgres
--

CREATE POLICY setup_source_manifest_definer_select ON vortex_module.organization_setup_source_manifests FOR SELECT TO postgres USING (true);


--
-- Name: alert_signals; Type: ROW SECURITY; Schema: vortex_operations; Owner: postgres
--

ALTER TABLE vortex_operations.alert_signals ENABLE ROW LEVEL SECURITY;

--
-- Name: alert_signals alert_signals_operations_owner_insert; Type: POLICY; Schema: vortex_operations; Owner: postgres
--

CREATE POLICY alert_signals_operations_owner_insert ON vortex_operations.alert_signals FOR INSERT TO vortex_operations_owner WITH CHECK (true);


--
-- Name: alert_signals alert_signals_operations_owner_select; Type: POLICY; Schema: vortex_operations; Owner: postgres
--

CREATE POLICY alert_signals_operations_owner_select ON vortex_operations.alert_signals FOR SELECT TO vortex_operations_owner USING (true);


--
-- Name: alert_signals alert_signals_operations_owner_update; Type: POLICY; Schema: vortex_operations; Owner: postgres
--

CREATE POLICY alert_signals_operations_owner_update ON vortex_operations.alert_signals FOR UPDATE TO vortex_operations_owner USING (true) WITH CHECK (true);


--
-- Name: form_drafts; Type: ROW SECURITY; Schema: vortex_page; Owner: postgres
--

ALTER TABLE vortex_page.form_drafts ENABLE ROW LEVEL SECURITY;

--
-- Name: form_drafts form_drafts_page_owner_delete; Type: POLICY; Schema: vortex_page; Owner: postgres
--

CREATE POLICY form_drafts_page_owner_delete ON vortex_page.form_drafts FOR DELETE TO vortex_page_owner USING ((organization_id = ( SELECT ((vortex_access.validated_human_request_context() ->> 'organizationId'::text))::uuid AS uuid)));


--
-- Name: form_drafts form_drafts_page_owner_insert; Type: POLICY; Schema: vortex_page; Owner: postgres
--

CREATE POLICY form_drafts_page_owner_insert ON vortex_page.form_drafts FOR INSERT TO vortex_page_owner WITH CHECK ((organization_id = ( SELECT ((vortex_access.validated_human_request_context() ->> 'organizationId'::text))::uuid AS uuid)));


--
-- Name: form_drafts form_drafts_page_owner_select; Type: POLICY; Schema: vortex_page; Owner: postgres
--

CREATE POLICY form_drafts_page_owner_select ON vortex_page.form_drafts FOR SELECT TO vortex_page_owner USING ((organization_id = ( SELECT ((vortex_access.validated_human_request_context() ->> 'organizationId'::text))::uuid AS uuid)));


--
-- Name: form_drafts form_drafts_page_owner_update; Type: POLICY; Schema: vortex_page; Owner: postgres
--

CREATE POLICY form_drafts_page_owner_update ON vortex_page.form_drafts FOR UPDATE TO vortex_page_owner USING ((organization_id = ( SELECT ((vortex_access.validated_human_request_context() ->> 'organizationId'::text))::uuid AS uuid))) WITH CHECK ((organization_id = ( SELECT ((vortex_access.validated_human_request_context() ->> 'organizationId'::text))::uuid AS uuid)));


--
-- Name: command_receipts; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE vortex_record.command_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: command_receipts command_receipts_adapter; Type: POLICY; Schema: vortex_record; Owner: vortex_record_adapter
--

CREATE POLICY command_receipts_adapter ON vortex_record.command_receipts TO vortex_record_adapter USING (true) WITH CHECK (true);


--
-- Name: field_storage_mappings; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.field_storage_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: field_storage_mappings field_storage_mappings_adapter_read; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY field_storage_mappings_adapter_read ON vortex_record.field_storage_mappings FOR SELECT TO vortex_record_adapter USING (true);


--
-- Name: field_storage_mappings field_storage_mappings_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY field_storage_mappings_owner ON vortex_record.field_storage_mappings TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: index_catalogue; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.index_catalogue ENABLE ROW LEVEL SECURITY;

--
-- Name: index_catalogue index_catalogue_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY index_catalogue_owner ON vortex_record.index_catalogue TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: installation_access_plans; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE vortex_record.installation_access_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: installation_access_plans installation_access_plans_adapter; Type: POLICY; Schema: vortex_record; Owner: vortex_record_adapter
--

CREATE POLICY installation_access_plans_adapter ON vortex_record.installation_access_plans TO vortex_record_adapter USING (true) WITH CHECK (true);


--
-- Name: installation_access_plans installation_access_plans_module_bundle_cleanup; Type: POLICY; Schema: vortex_record; Owner: vortex_record_adapter
--

CREATE POLICY installation_access_plans_module_bundle_cleanup ON vortex_record.installation_access_plans TO vortex_module_owner USING (true) WITH CHECK (true);


--
-- Name: legal_hold_versions; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.legal_hold_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: legal_hold_versions legal_hold_versions_validated_scope; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY legal_hold_versions_validated_scope ON vortex_record.legal_hold_versions FOR SELECT TO vortex_record_owner USING (((tenant_id = ((vortex_context.validated_service_context() ->> 'tenantId'::text))::uuid) AND (organization_id = ((vortex_context.validated_service_context() ->> 'organizationId'::text))::uuid)));


--
-- Name: organization_lifecycle_limits; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.organization_lifecycle_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_lifecycle_limits organization_lifecycle_limits_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY organization_lifecycle_limits_owner ON vortex_record.organization_lifecycle_limits TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: preview_command_receipts; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE vortex_record.preview_command_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: preview_command_receipts preview_command_receipts_adapter; Type: POLICY; Schema: vortex_record; Owner: vortex_record_adapter
--

CREATE POLICY preview_command_receipts_adapter ON vortex_record.preview_command_receipts TO vortex_record_adapter USING (true) WITH CHECK (true);


--
-- Name: preview_reference_counters; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE vortex_record.preview_reference_counters ENABLE ROW LEVEL SECURITY;

--
-- Name: preview_reference_counters preview_reference_counters_adapter; Type: POLICY; Schema: vortex_record; Owner: vortex_record_adapter
--

CREATE POLICY preview_reference_counters_adapter ON vortex_record.preview_reference_counters TO vortex_record_adapter USING (true) WITH CHECK (true);


--
-- Name: preview_storage_bindings; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.preview_storage_bindings ENABLE ROW LEVEL SECURITY;

--
-- Name: preview_storage_bindings preview_storage_bindings_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY preview_storage_bindings_owner ON vortex_record.preview_storage_bindings TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: protected_read_model_views; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.protected_read_model_views ENABLE ROW LEVEL SECURITY;

--
-- Name: protected_read_model_views protected_read_model_views_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY protected_read_model_views_owner ON vortex_record.protected_read_model_views TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: protected_read_model_views protected_read_model_views_projection_lock_postgres_select; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY protected_read_model_views_projection_lock_postgres_select ON vortex_record.protected_read_model_views FOR SELECT TO postgres USING (true);


--
-- Name: record_lifecycle_command_effects; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_adapter
--

ALTER TABLE vortex_record.record_lifecycle_command_effects ENABLE ROW LEVEL SECURITY;

--
-- Name: record_lifecycle_command_effects record_lifecycle_command_effects_adapter; Type: POLICY; Schema: vortex_record; Owner: vortex_record_adapter
--

CREATE POLICY record_lifecycle_command_effects_adapter ON vortex_record.record_lifecycle_command_effects TO vortex_record_adapter USING (true) WITH CHECK (true);


--
-- Name: record_reference_counters; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.record_reference_counters ENABLE ROW LEVEL SECURITY;

--
-- Name: record_reference_counters record_reference_counters_adapter; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY record_reference_counters_adapter ON vortex_record.record_reference_counters TO vortex_record_adapter USING ((organization_id = vortex_context.organization_id())) WITH CHECK ((organization_id = vortex_context.organization_id()));


--
-- Name: record_reference_counters record_reference_counters_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY record_reference_counters_owner ON vortex_record.record_reference_counters TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: record_type_lifecycle_policies; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.record_type_lifecycle_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: record_type_lifecycle_policies record_type_lifecycle_policies_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY record_type_lifecycle_policies_owner ON vortex_record.record_type_lifecycle_policies TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: relationship_edges; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.relationship_edges ENABLE ROW LEVEL SECURITY;

--
-- Name: relationship_edges relationship_edges_adapter_delete; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY relationship_edges_adapter_delete ON vortex_record.relationship_edges FOR DELETE TO vortex_record_adapter USING ((from_organisation_id = vortex_context.organization_id()));


--
-- Name: relationship_edges relationship_edges_adapter_insert; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY relationship_edges_adapter_insert ON vortex_record.relationship_edges FOR INSERT TO vortex_record_adapter WITH CHECK (((from_organisation_id = vortex_context.organization_id()) AND (to_organisation_id = vortex_context.organization_id())));


--
-- Name: relationship_edges relationship_edges_adapter_read; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY relationship_edges_adapter_read ON vortex_record.relationship_edges FOR SELECT TO vortex_record_adapter USING ((from_organisation_id = vortex_context.organization_id()));


--
-- Name: relationship_edges relationship_edges_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY relationship_edges_owner ON vortex_record.relationship_edges TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: relationship_storage_mappings; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.relationship_storage_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: relationship_storage_mappings relationship_storage_mappings_adapter_read; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY relationship_storage_mappings_adapter_read ON vortex_record.relationship_storage_mappings FOR SELECT TO vortex_record_adapter USING (true);


--
-- Name: relationship_storage_mappings relationship_storage_mappings_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY relationship_storage_mappings_owner ON vortex_record.relationship_storage_mappings TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: release_provisions; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.release_provisions ENABLE ROW LEVEL SECURITY;

--
-- Name: release_provisions release_provisions_adapter_read; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY release_provisions_adapter_read ON vortex_record.release_provisions FOR SELECT TO vortex_record_adapter USING (true);


--
-- Name: release_provisions release_provisions_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY release_provisions_owner ON vortex_record.release_provisions TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: storage_catalogue; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.storage_catalogue ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_catalogue storage_catalogue_adapter_read; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY storage_catalogue_adapter_read ON vortex_record.storage_catalogue FOR SELECT TO vortex_record_adapter USING (true);


--
-- Name: storage_catalogue storage_catalogue_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY storage_catalogue_owner ON vortex_record.storage_catalogue TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: storage_conversion_catalogue; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.storage_conversion_catalogue ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_conversion_catalogue storage_conversion_catalogue_adapter; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY storage_conversion_catalogue_adapter ON vortex_record.storage_conversion_catalogue FOR SELECT TO vortex_record_adapter USING (true);


--
-- Name: storage_conversion_catalogue storage_conversion_catalogue_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY storage_conversion_catalogue_owner ON vortex_record.storage_conversion_catalogue TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: storage_conversion_plans; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.storage_conversion_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_conversion_plans storage_conversion_plans_adapter; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY storage_conversion_plans_adapter ON vortex_record.storage_conversion_plans TO vortex_record_adapter USING (true) WITH CHECK (true);


--
-- Name: storage_conversion_plans storage_conversion_plans_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY storage_conversion_plans_owner ON vortex_record.storage_conversion_plans TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: storage_conversion_progress; Type: ROW SECURITY; Schema: vortex_record; Owner: vortex_record_owner
--

ALTER TABLE vortex_record.storage_conversion_progress ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_conversion_progress storage_conversion_progress_adapter; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY storage_conversion_progress_adapter ON vortex_record.storage_conversion_progress TO vortex_record_adapter USING (true) WITH CHECK (true);


--
-- Name: storage_conversion_progress storage_conversion_progress_owner; Type: POLICY; Schema: vortex_record; Owner: vortex_record_owner
--

CREATE POLICY storage_conversion_progress_owner ON vortex_record.storage_conversion_progress TO vortex_record_owner USING (true) WITH CHECK (true);


--
-- Name: documents; Type: ROW SECURITY; Schema: vortex_search; Owner: postgres
--

ALTER TABLE vortex_search.documents ENABLE ROW LEVEL SECURITY;

--
-- Name: documents documents_request_read; Type: POLICY; Schema: vortex_search; Owner: postgres
--

CREATE POLICY documents_request_read ON vortex_search.documents FOR SELECT TO vortex_request USING ((organization_id = vortex_context.organization_id()));


--
-- Name: documents documents_search_owner_insert; Type: POLICY; Schema: vortex_search; Owner: postgres
--

CREATE POLICY documents_search_owner_insert ON vortex_search.documents FOR INSERT TO vortex_search_owner WITH CHECK ((organization_id = vortex_context.organization_id()));


--
-- Name: documents documents_search_owner_select; Type: POLICY; Schema: vortex_search; Owner: postgres
--

CREATE POLICY documents_search_owner_select ON vortex_search.documents FOR SELECT TO vortex_search_owner USING ((organization_id = vortex_context.organization_id()));


--
-- Name: documents documents_search_owner_update; Type: POLICY; Schema: vortex_search; Owner: postgres
--

CREATE POLICY documents_search_owner_update ON vortex_search.documents FOR UPDATE TO vortex_search_owner USING ((organization_id = vortex_context.organization_id())) WITH CHECK ((organization_id = vortex_context.organization_id()));


--
-- Name: flow_continuations; Type: ROW SECURITY; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE vortex_workflow.flow_continuations ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_continuations flow_continuations_vortex_workflow_owner_delete; Type: POLICY; Schema: vortex_workflow; Owner: postgres
--

CREATE POLICY flow_continuations_vortex_workflow_owner_delete ON vortex_workflow.flow_continuations FOR DELETE TO vortex_workflow_owner USING (true);


--
-- Name: flow_continuations flow_continuations_vortex_workflow_owner_insert; Type: POLICY; Schema: vortex_workflow; Owner: postgres
--

CREATE POLICY flow_continuations_vortex_workflow_owner_insert ON vortex_workflow.flow_continuations FOR INSERT TO vortex_workflow_owner WITH CHECK (true);


--
-- Name: flow_continuations flow_continuations_vortex_workflow_owner_select; Type: POLICY; Schema: vortex_workflow; Owner: postgres
--

CREATE POLICY flow_continuations_vortex_workflow_owner_select ON vortex_workflow.flow_continuations FOR SELECT TO vortex_workflow_owner USING (true);


--
-- Name: flow_continuations flow_continuations_vortex_workflow_owner_update; Type: POLICY; Schema: vortex_workflow; Owner: postgres
--

CREATE POLICY flow_continuations_vortex_workflow_owner_update ON vortex_workflow.flow_continuations FOR UPDATE TO vortex_workflow_owner USING (true) WITH CHECK (true);


--
-- Name: flow_effect_ledger; Type: ROW SECURITY; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE vortex_workflow.flow_effect_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_effect_ledger flow_effect_ledger_vortex_workflow_owner_insert; Type: POLICY; Schema: vortex_workflow; Owner: postgres
--

CREATE POLICY flow_effect_ledger_vortex_workflow_owner_insert ON vortex_workflow.flow_effect_ledger FOR INSERT TO vortex_workflow_owner WITH CHECK (true);


--
-- Name: flow_effect_ledger flow_effect_ledger_vortex_workflow_owner_select; Type: POLICY; Schema: vortex_workflow; Owner: postgres
--

CREATE POLICY flow_effect_ledger_vortex_workflow_owner_select ON vortex_workflow.flow_effect_ledger FOR SELECT TO vortex_workflow_owner USING (true);


--
-- Name: flow_effect_ledger flow_effect_ledger_vortex_workflow_owner_update; Type: POLICY; Schema: vortex_workflow; Owner: postgres
--

CREATE POLICY flow_effect_ledger_vortex_workflow_owner_update ON vortex_workflow.flow_effect_ledger FOR UPDATE TO vortex_workflow_owner USING (true) WITH CHECK (true);


--
-- Name: flow_registrations; Type: ROW SECURITY; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE vortex_workflow.flow_registrations ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_start_intents; Type: ROW SECURITY; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE vortex_workflow.flow_start_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_start_intents flow_start_intents_vortex_workflow_owner_select; Type: POLICY; Schema: vortex_workflow; Owner: postgres
--

CREATE POLICY flow_start_intents_vortex_workflow_owner_select ON vortex_workflow.flow_start_intents FOR SELECT TO vortex_workflow_owner USING (true);


--
-- Name: protected_workflow_runs; Type: ROW SECURITY; Schema: vortex_workflow; Owner: postgres
--

ALTER TABLE vortex_workflow.protected_workflow_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: record_data; Owner: vortex_record_owner
--

SET ROLE vortex_record_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE vortex_record_owner IN SCHEMA record_data GRANT SELECT,UPDATE ON TABLES TO postgres;
RESET ROLE;


--
-- PostgreSQL database dump complete
--
