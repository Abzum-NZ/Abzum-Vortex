create or replace function vortex_platform.grid_view_scope_internal()
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  application_root_id uuid,
  release_revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  installation jsonb;
begin
  -- The actor and the installation come only from the validated request context: a grid layout
  -- belongs to the person's own organisation account in the one application the request selected.
  checked := vortex_access.validated_human_request_context();
  if not (checked ?& array['tenantId', 'organizationAccountId', 'applicationRootId'])
    or not vortex_platform.is_non_nil_uuid(checked ->> 'tenantId')
    or not vortex_platform.is_non_nil_uuid(checked ->> 'organizationAccountId')
    or not vortex_platform.is_non_nil_uuid(checked ->> 'applicationRootId') then
    raise exception using errcode = '42501', message = 'Grid layout scope is unavailable';
  end if;

  installation := vortex_definition.read_current_active_installation();
  if installation is null
    or pg_catalog.jsonb_typeof(installation) <> 'object'
    or (installation ->> 'organizationId')::uuid
      is distinct from (checked ->> 'organizationId')::uuid
    or (installation ->> 'applicationRootId')::uuid
      is distinct from (checked ->> 'applicationRootId')::uuid
    or pg_catalog.jsonb_typeof(installation -> 'applicationReleaseRevision')
      is distinct from 'number' then
    raise exception using errcode = '42501', message = 'Grid layout scope is unavailable';
  end if;

  return query select
    (checked ->> 'tenantId')::uuid,
    (checked ->> 'organizationId')::uuid,
    (checked ->> 'organizationAccountId')::uuid,
    (checked ->> 'applicationRootId')::uuid,
    (installation ->> 'applicationReleaseRevision')::bigint;
end
$function$;

revoke all on function vortex_platform.grid_view_scope_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_scope_internal() is
  'Resolves the validated human request scope and the active Application installation a grid layout belongs to; owner-only.';

alter function vortex_platform.grid_view_scope_internal() owner to vortex_owner;
