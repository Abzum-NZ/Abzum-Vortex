set local role vortex_owner;

-- Keep each policy's command, roles and row predicate unchanged. The scalar
-- subqueries let PostgreSQL evaluate request context once for the statement.
alter policy module_preview_draft_revision_lock on vortex_definition.drafts
  using (root_id = (select (vortex_access.validated_human_request_context() ->> 'applicationRootId')::uuid));
alter policy module_preview_draft_revision_read on vortex_definition.drafts
  using (root_id = (select (vortex_access.validated_human_request_context() ->> 'applicationRootId')::uuid));
alter policy releases_owner_select on vortex_definition.releases
  using (exists (
    select 1 from vortex_definition.roots root
    where root.root_id = releases.root_id
      and root.organization_id = (select (vortex_access.validated_human_request_context() ->> 'organizationId')::uuid)
  ));
alter policy source_identities_human_application_role_select on vortex_definition.source_identities
  using (kind = 'role' and exists (
    select 1 from vortex_definition.roots root
    where root.root_id = source_identities.root_id
      and root.kind = 'application'
      and root.organization_id = (select (vortex_access.validated_human_request_context() ->> 'organizationId')::uuid)
  ));

alter policy documents_request_read on vortex_record.documents
  using (organization_id = (select vortex_platform.organization_id()));
alter policy documents_search_owner_insert on vortex_record.documents
  with check (organization_id = (select vortex_platform.organization_id()));
alter policy documents_search_owner_select on vortex_record.documents
  using (organization_id = (select vortex_platform.organization_id()));
alter policy documents_search_owner_update on vortex_record.documents
  using (organization_id = (select vortex_platform.organization_id()))
  with check (organization_id = (select vortex_platform.organization_id()));

alter policy relationship_edges_adapter_delete on vortex_record.relationship_edges
  using (from_organisation_id = (select vortex_platform.organization_id()));
alter policy relationship_edges_adapter_insert on vortex_record.relationship_edges
  with check (
    from_organisation_id = (select vortex_platform.organization_id())
    and to_organisation_id = (select vortex_platform.organization_id())
  );
alter policy relationship_edges_adapter_read on vortex_record.relationship_edges
  using (from_organisation_id = (select vortex_platform.organization_id()));
alter policy record_reference_counters_adapter on vortex_record.record_reference_counters
  using (organization_id = (select vortex_platform.organization_id()))
  with check (organization_id = (select vortex_platform.organization_id()));

alter policy connection_application_grants_owner_delete on vortex_platform.connection_application_grants
  using (organization_id = (select vortex_platform.organization_id()));
alter policy connection_application_grants_owner_select on vortex_platform.connection_application_grants
  using (organization_id = (select vortex_platform.organization_id()));
alter policy connection_application_grants_owner_update on vortex_platform.connection_application_grants
  using (organization_id = (select vortex_platform.organization_id()))
  with check (organization_id = (select vortex_platform.organization_id()));
alter policy connection_instances_owner_insert on vortex_platform.connection_instances
  with check (organization_id = (select vortex_platform.organization_id()));
alter policy connection_instances_owner_select on vortex_platform.connection_instances
  using (organization_id = (select vortex_platform.organization_id()));
alter policy connection_instances_owner_update on vortex_platform.connection_instances
  using (organization_id = (select vortex_platform.organization_id()))
  with check (organization_id = (select vortex_platform.organization_id()));

alter policy file_records_file_owner_read on vortex_platform.file_records
  using (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid));
alter policy file_records_file_owner_update on vortex_platform.file_records
  using (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid))
  with check (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid));
alter policy file_records_request_read on vortex_platform.file_records
  using (organization_id = (select vortex_platform.organization_id()));

reset role;
