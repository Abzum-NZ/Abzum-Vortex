-- #1461 Tenant and cluster identity definers use the Identity owner.

begin;

-- Privileges for the tenant, cluster and administrator definers owned by vortex_identity_owner.
grant select (organization_id, tenant_id, parent_organization_id, state)
  on table vortex_identity.organizations to vortex_identity_owner;
grant select (tenant_id, state)
  on table vortex_identity.tenants to vortex_identity_owner;
grant select (assignment_id, tenant_id, identity_id, capability_keys, starts_at, expires_at, revoked_at)
  on table vortex_identity.tenant_administrator_assignments to vortex_identity_owner;
grant select (identity_id, state)
  on table vortex_identity.identity_projections to vortex_identity_owner;

create policy identity_owner_1461_organizations_select
  on vortex_identity.organizations for select to vortex_identity_owner using (true);
create policy identity_owner_1461_tenants_select
  on vortex_identity.tenants for select to vortex_identity_owner using (true);
create policy identity_owner_1461_tenant_administrator_assignments_select
  on vortex_identity.tenant_administrator_assignments for select to vortex_identity_owner using (true);
create policy identity_owner_1461_identity_projections_select
  on vortex_identity.identity_projections for select to vortex_identity_owner using (true);

-- Existing private lifecycle helpers remain postgres-owned because they read Access tables.
grant execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) to vortex_identity_owner;
grant execute on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) to vortex_identity_owner;

-- Transfer only the nine functions whose dependencies are available to the Identity owner.
alter function vortex_identity.close_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) owner to vortex_identity_owner;
alter function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) owner to vortex_identity_owner;
alter function vortex_identity.reactivate_tenant(uuid,uuid,uuid,text,uuid,bigint) owner to vortex_identity_owner;
alter function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) owner to vortex_identity_owner;
alter function vortex_identity.suspend_tenant(uuid,uuid,uuid,text,uuid,bigint) owner to vortex_identity_owner;
alter function vortex_identity.tenant_administrator_grant_expiry_cap(uuid,uuid,text[],timestamp with time zone) owner to vortex_identity_owner;
alter function vortex_identity.tenant_has_permanent_manager(uuid,timestamp with time zone,uuid) owner to vortex_identity_owner;
alter function vortex_identity.validate_organization_lifecycle() owner to vortex_identity_owner;
alter function vortex_identity.validate_tenant_lifecycle() owner to vortex_identity_owner;

-- Preserve calls from existing postgres-owned Identity definers.
set local role vortex_identity_owner;
grant execute on function vortex_identity.tenant_administrator_grant_expiry_cap(uuid,uuid,text[],timestamp with time zone) to postgres;
grant execute on function vortex_identity.tenant_has_permanent_manager(uuid,timestamp with time zone,uuid) to postgres;
reset role;

commit;
