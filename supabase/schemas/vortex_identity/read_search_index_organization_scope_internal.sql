create or replace function vortex_identity.read_search_index_organization_scope_internal(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  retained jsonb;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_tenant_id uuid;
  locked_tenant_id uuid;
begin
  retained := vortex_event.read_search_index_occurrence_internal(p_occurrence_id,p_claim_cursor);
  selected_organization_id := (retained ->> 'sourceOrganizationId')::uuid;
  selected_application_root_id := (retained ->> 'sequenceApplicationRootId')::uuid;
  select organization.tenant_id into selected_tenant_id
  from vortex_identity.organizations as organization
  where organization.organization_id = selected_organization_id and organization.state = 'active'
  for share of organization;
  if selected_tenant_id is null then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  select tenant.tenant_id into locked_tenant_id
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = selected_tenant_id and tenant.state = 'active'
  for share of tenant;
  if locked_tenant_id is null then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  return pg_catalog.jsonb_build_object('tenantId',locked_tenant_id,
    'organizationId',selected_organization_id,'applicationRootId',selected_application_root_id);
end
$function$;
alter function vortex_identity.read_search_index_organization_scope_internal(uuid,uuid) owner to vortex_identity_owner;
revoke all on function vortex_identity.read_search_index_organization_scope_internal(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_identity.read_search_index_organization_scope_internal(uuid,uuid) to vortex_access_owner;
comment on function vortex_identity.read_search_index_organization_scope_internal(uuid,uuid) is 'Owner-only active tenant and organization scope for the exact retained Search claim; no Runtime organization or actor selector.';
