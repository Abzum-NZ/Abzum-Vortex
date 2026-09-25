create or replace function vortex_record.relationship_total_catalogue_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  installation jsonb;
  binding jsonb;
  content jsonb;
  record_types jsonb := '[]'::jsonb;
  relationships jsonb := '[]'::jsonb;
  has_installed_rules boolean := false;
  record_type jsonb;
begin
  installation := vortex_module.read_current_active_installation();
  for binding in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') item(value)
    order by item.value ->> 'moduleRootId'
  loop
    select release.compilation_output #> '{canonical,content}' into strict content
    from vortex_definition.releases release
    where release.root_id = (binding ->> 'moduleRootId')::uuid
      and release.release_revision = (binding ->> 'moduleReleaseRevision')::bigint;
    if pg_catalog.jsonb_typeof(content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000', message = 'Installed Record definitions are unavailable';
    end if;
    has_installed_rules := has_installed_rules or
      pg_catalog.jsonb_array_length(coalesce(content -> 'rules', '[]'::jsonb)) > 0;
    record_types := record_types || coalesce((
      select pg_catalog.jsonb_agg(
        item.value || pg_catalog.jsonb_build_object(
          'moduleReleaseRevision', binding -> 'moduleReleaseRevision'
        )
        order by item.value ->> 'recordTypeId'
      )
      from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    ), '[]'::jsonb);
    for record_type in
      select item.value from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    loop
      relationships := relationships || coalesce(record_type -> 'relationships', '[]'::jsonb);
    end loop;
  end loop;
  select release.compilation_output #> '{canonical,content}' into strict content
  from vortex_definition.releases release
  where release.root_id = (installation ->> 'applicationRootId')::uuid
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  has_installed_rules := has_installed_rules or
    pg_catalog.jsonb_array_length(coalesce(content -> 'rules', '[]'::jsonb)) > 0;
  return pg_catalog.jsonb_build_object(
    'recordTypes', record_types,
    'relationships', relationships,
    'hasInstalledRules', has_installed_rules
  );
end
$function$;

revoke all on function vortex_record.relationship_total_catalogue_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.relationship_total_catalogue_internal()
  to vortex_record_adapter;
comment on function vortex_record.relationship_total_catalogue_internal() is
  'Private relationship-total catalogue for the validated human Application request context.';
