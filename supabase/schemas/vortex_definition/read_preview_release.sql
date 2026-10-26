create or replace function vortex_definition.read_preview_release()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation_value jsonb;
  application_value jsonb;
  modules_value jsonb;
begin
  installation_value := vortex_definition.read_current_active_installation();
  if not installation_value ? 'previewInstallationId' then
    raise exception using errcode = '42501', message = 'Preview installation address is required';
  end if;

  application_value := vortex_definition.project_consumer_release(
    'application',
    (installation_value ->> 'applicationRootId')::uuid,
    (installation_value ->> 'applicationReleaseRevision')::bigint
  );
  select pg_catalog.jsonb_agg(
    vortex_definition.project_consumer_release(
      'module',
      (binding.value ->> 'moduleRootId')::uuid,
      (binding.value ->> 'moduleReleaseRevision')::bigint
    ) order by binding.value ->> 'moduleRootId' collate "C"
  ) into modules_value
  from pg_catalog.jsonb_array_elements(installation_value -> 'moduleBindings') as binding(value);
  if application_value is null
    or modules_value is null
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(modules_value) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
    ) then
    raise exception using errcode = '23514', message = 'Preview release evidence is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'installation', installation_value,
    'correlationId', vortex_access.validated_human_request_context() ->> 'correlationId',
    'application', application_value,
    'modules', modules_value
  );
end
$function$;

alter function vortex_definition.read_preview_release() owner to vortex_owner;

revoke all on function vortex_definition.read_preview_release()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_release()
  to vortex_request;
comment on function vortex_definition.read_preview_release() is
  'The exact release evidence of the preview the validated human Application request runs, from which its provisioning projects the release set the runtime renders.';
