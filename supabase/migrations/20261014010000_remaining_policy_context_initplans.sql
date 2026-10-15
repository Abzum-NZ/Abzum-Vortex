set local role vortex_owner;

-- Preserve each policy's predicate, command, roles, and mode. The scalar
-- subqueries allow PostgreSQL to evaluate request context once per statement.
alter policy download_grants_file_owner_delete on vortex_platform.download_grants
  using (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid));
alter policy download_grants_file_owner_insert on vortex_platform.download_grants
  with check (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid));
alter policy download_grants_file_owner_read on vortex_platform.download_grants
  using (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid));
alter policy download_grants_file_owner_update on vortex_platform.download_grants
  using (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid))
  with check (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid));

alter policy upload_grants_file_owner_insert on vortex_platform.upload_grants
  with check (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid));
alter policy upload_grants_file_owner_read on vortex_platform.upload_grants
  using (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid));
alter policy upload_grants_file_owner_update on vortex_platform.upload_grants
  using (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid))
  with check (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid));

alter policy upload_reservations_file_owner_read on vortex_platform.upload_reservations
  using (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid));
alter policy upload_reservations_file_owner_update on vortex_platform.upload_reservations
  using (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid))
  with check (organization_id = (select (vortex_platform.upload_validated_context() ->> 'organizationId')::uuid));

alter policy record_action_capabilities_definition_roots_read on vortex_definition.roots
  using (organization_id = (select vortex_platform.organization_id()));

reset role;
