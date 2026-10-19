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
    or not vortex_platform.is_non_nil_uuid(initial_context ->> 'tenantId')
    or not vortex_platform.is_non_nil_uuid(initial_context ->> 'organizationId')
    or not vortex_platform.is_non_nil_uuid(initial_context ->> 'organizationAccountId')
    or not vortex_platform.is_non_nil_uuid(initial_context ->> 'applicationRootId')
    or not vortex_platform.is_non_nil_uuid(initial_context ->> 'correlationId')
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
  -- This entry is used by ownership transfers. Upgrade the request's shared
  -- scope before taking a record lock. NOWAIT turns competing shared readers
  -- or upgrades into a retry instead of a lock-upgrade deadlock.
  for update of version nowait;

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

  perform pg_catalog.set_config(
    'vortex_access.exclusive_organization_id',
    initial_context ->> 'organizationId', true
  );

  return initial_context;
end
$function$;

alter function vortex_access.lock_human_request_access_version_internal() owner to vortex_owner;

revoke all on function vortex_access.lock_human_request_access_version_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.lock_human_request_access_version_internal()
  to vortex_record_adapter;
comment on function vortex_access.lock_human_request_access_version_internal() is
  'Locks the exact active Human organization access version exclusively before an ownership transfer takes record locks, and revalidates the full original request context.';

grant execute on function vortex_access.lock_human_request_access_version_internal() to postgres;
