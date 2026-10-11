create or replace function vortex_access.lock_human_request_access_version_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_context jsonb;
  rechecked_context jsonb;
  locked_access_version bigint;
begin
  initial_context := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(initial_context) is distinct from 'object'
    or not (initial_context ?& array[
      'callerKind', 'tenantId', 'organizationId', 'organizationAccountId',
      'applicationRootId', 'accessVersion', 'correlationId'
    ])
    or initial_context ->> 'callerKind' is distinct from 'human'
    or not vortex_context.is_non_nil_uuid(initial_context ->> 'tenantId')
    or not vortex_context.is_non_nil_uuid(initial_context ->> 'organizationId')
    or not vortex_context.is_non_nil_uuid(initial_context ->> 'organizationAccountId')
    or not vortex_context.is_non_nil_uuid(initial_context ->> 'applicationRootId')
    or not vortex_context.is_non_nil_uuid(initial_context ->> 'correlationId')
    or not pg_catalog.pg_input_is_valid(initial_context ->> 'accessVersion', 'bigint')
    or (initial_context ->> 'accessVersion')::bigint not between 1 and 9007199254740991 then
    raise exception using errcode = '42501',
      message = 'Human ownership transfer access scope is unavailable';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = (initial_context ->> 'organizationId')::uuid
    and organization.tenant_id = (initial_context ->> 'tenantId')::uuid
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;

  if not found then
    raise exception using errcode = '42501',
      message = 'Human ownership transfer access scope is unavailable';
  end if;
  if locked_access_version is distinct from (initial_context ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Human ownership transfer access version changed';
  end if;

  rechecked_context := vortex_access.validated_human_request_context();
  if rechecked_context is distinct from initial_context then
    raise exception using errcode = '40001',
      message = 'Human ownership transfer context changed while acquiring access lock';
  end if;

  return initial_context;
end
$function$;

alter function vortex_access.lock_human_request_access_version_internal() owner to postgres;

revoke all on function vortex_access.lock_human_request_access_version_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_access_owner, vortex_definition_owner, vortex_identity_owner,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.lock_human_request_access_version_internal()
  to vortex_record_adapter;
comment on function vortex_access.lock_human_request_access_version_internal() is
  'Locks the exact active Human organization access version with a shared row lock and revalidates the full original request context.';
