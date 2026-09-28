create or replace function vortex_page.private_form_draft_context_internal()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  identity_id uuid,
  application_root_id uuid,
  release_revision bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  installation jsonb;
  selected_application_root_id uuid;
begin
  checked := vortex_access.validated_human_request_context();
  if not (checked ?& array['organizationAccountId', 'identityId', 'applicationRootId'])
    or not vortex_context.is_non_nil_uuid(checked ->> 'applicationRootId')
    or not vortex_context.is_non_nil_uuid(checked ->> 'organizationAccountId')
    or not vortex_context.is_non_nil_uuid(checked ->> 'identityId') then
    raise exception using errcode = '42501',
      message = 'Private form draft scope is unavailable';
  end if;
  selected_application_root_id := (checked ->> 'applicationRootId')::uuid;

  installation := vortex_module.read_current_active_installation();
  if installation is null
    or pg_catalog.jsonb_typeof(installation) <> 'object'
    or (installation ->> 'organizationId')::uuid
      is distinct from (checked ->> 'organizationId')::uuid
    or (installation ->> 'applicationRootId')::uuid is distinct from selected_application_root_id
    or pg_catalog.jsonb_typeof(installation -> 'applicationReleaseRevision')
      is distinct from 'number'
    or not vortex_context.is_non_nil_uuid(checked ->> 'correlationId') then
    raise exception using errcode = '42501',
      message = 'Private form draft scope is unavailable';
  end if;

  return query select
    (checked ->> 'organizationId')::uuid,
    (checked ->> 'organizationAccountId')::uuid,
    (checked ->> 'identityId')::uuid,
    selected_application_root_id,
    (installation ->> 'applicationReleaseRevision')::bigint,
    (checked ->> 'correlationId')::uuid;
end
$function$;

revoke all on function vortex_page.private_form_draft_context_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

alter function vortex_page.private_form_draft_context_internal()
  owner to vortex_page_owner;
