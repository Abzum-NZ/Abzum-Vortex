alter function vortex_identity.validate_tenant_lifecycle() security definer;
alter function vortex_identity.validate_tenant_lifecycle() owner to postgres;
alter function vortex_identity.validate_tenant_lifecycle() set search_path = '';

revoke execute on function vortex_identity.validate_tenant_lifecycle()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
