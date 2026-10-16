create or replace function vortex_definition.write_preview_runtime_release_set(
  p_release_set jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation_value jsonb;
begin
  if pg_catalog.jsonb_typeof(p_release_set) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_release_set -> 'application') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_release_set -> 'modules') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Preview release set is invalid';
  end if;
  installation_value := vortex_definition.read_current_active_installation();
  if not installation_value ? 'previewInstallationId' then
    raise exception using errcode = '42501', message = 'Preview installation address is required';
  end if;
  -- The release set names exactly the preview's Application release and Module pins.
  if p_release_set #>> '{application,rootId}' is distinct from installation_value ->> 'applicationRootId'
    or p_release_set #>> '{application,releaseRevision}'
      is distinct from installation_value ->> 'applicationReleaseRevision'
    or (
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          pg_catalog.lower(item.value ->> 'rootId'), item.value -> 'releaseRevision'
        ) order by pg_catalog.lower(item.value ->> 'rootId') collate "C"
      ), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(p_release_set -> 'modules') as item(value)
    ) is distinct from (
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          pg_catalog.lower(binding.value ->> 'moduleRootId'), binding.value -> 'moduleReleaseRevision'
        ) order by pg_catalog.lower(binding.value ->> 'moduleRootId') collate "C"
      ), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(installation_value -> 'moduleBindings') as binding(value)
    ) then
    raise exception using errcode = '23514', message = 'Preview release set does not match its pins';
  end if;
  update vortex_definition.preview_installations as preview
  set runtime_release_set = p_release_set
  where preview.preview_installation_id = (installation_value ->> 'previewInstallationId')::uuid
    and preview.runtime_release_set is null;
  if not found then
    raise exception using errcode = '55000', message = 'Preview release set is already written';
  end if;
  return true;
end
$function$;

alter function vortex_definition.write_preview_runtime_release_set(jsonb) owner to vortex_owner;

revoke all on function vortex_definition.write_preview_runtime_release_set(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.write_preview_runtime_release_set(jsonb)
  to vortex_request;
comment on function vortex_definition.write_preview_runtime_release_set(jsonb) is
  'Stores, once, the release set the runtime renders for the preview the validated human Application request runs, after checking it names exactly the preview''s release pins.';
