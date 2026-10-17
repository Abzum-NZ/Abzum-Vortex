create or replace function vortex_definition.read_preview_runtime_source()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation_value jsonb;
  preview_row vortex_definition.preview_installations%rowtype;
begin
  installation_value := vortex_definition.read_current_active_installation();
  if not installation_value ? 'previewInstallationId' then
    raise exception using errcode = '42501', message = 'Preview installation address is required';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = (installation_value ->> 'previewInstallationId')::uuid;
  if not found or preview_row.runtime_release_set is null then
    raise exception using errcode = '55000', message = 'Preview release set is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'installation', installation_value,
    'draftRevision', preview_row.draft_revision,
    'expiresAt', preview_row.expires_at,
    'correlationId', vortex_access.validated_human_request_context() ->> 'correlationId',
    'releaseSet', preview_row.runtime_release_set,
    'seedBoundedRecordTypeIds', pg_catalog.to_jsonb(preview_row.seed_bounded_record_type_ids)
  );
end
$function$;

alter function vortex_definition.read_preview_runtime_source() owner to vortex_owner;

revoke all on function vortex_definition.read_preview_runtime_source()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_runtime_source()
  to vortex_request;
comment on function vortex_definition.read_preview_runtime_source() is
  'The installation, draft revision, expiry and stored release set of the preview the validated human Application request runs, for the runtime to render it as an installed Application.';
