-- Everything that must hold before an application can be removed for good, proved in one place and
-- read by both the purge function and the history purge, so whoever calls either gets the same
-- proof: the application exists in the organisation and is ordinary (never a system application),
-- is not the organisation's default application, nothing else depends on it, an installed
-- application is not deleted, and, when a typed name is given, it equals the application's name.
-- It returns what the removal would take. It deletes nothing.
create or replace function vortex_definition.purge_application_review_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_delete_only boolean,
  p_confirmed_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  app_root record;
  module_ids uuid[];
  all_ids uuid[];
  role_ids uuid[];
  storage_row record;
  installed boolean;
  record_total bigint := 0;
  table_total bigint;
  table_count bigint := 0;
  role_count bigint;
  assignment_count bigint;
  entry_count bigint;
  release_count bigint;
  external_links bigint;
  application_name text;
begin
  if p_organization_id is null
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_delete_only is null then
    raise exception using errcode = '22023',
      message = 'Application purge command is invalid';
  end if;

  select root.root_id, root.key, root.application_origin_kind into app_root
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = p_organization_id
    and root.kind = 'application'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Application is unavailable';
  end if;
  if app_root.application_origin_kind <> 'ordinary' then
    raise exception using errcode = '42501',
      message = 'Only an ordinary application can be removed or deleted';
  end if;
  if exists (
    select 1 from vortex_identity.organization_runtime_settings as settings
    where settings.organization_id = p_organization_id
      and settings.default_application_root_id = p_application_root_id
  ) then
    raise exception using errcode = 'VX001',
      message = 'The organisation default application cannot be removed or deleted';
  end if;

  select coalesce(pg_catalog.array_agg(module.root_id), array[]::uuid[]) into module_ids
  from vortex_definition.roots as module
  where module.organization_id = p_organization_id
    and module.owner_application_root_id = p_application_root_id;
  all_ids := pg_catalog.array_append(module_ids, p_application_root_id);

  -- Another definition that was published against this one would lose what it pins.
  if exists (
    select 1 from vortex_definition.release_dependencies as dependency
    where dependency.target_root_id = any(all_ids) and dependency.root_id <> all(all_ids)
  ) then
    raise exception using errcode = 'VX002',
      message = 'Another application depends on this application';
  end if;

  select pg_catalog.bool_or(binding.state <> 'detached') into installed
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id;
  installed := coalesce(installed, false);
  if p_delete_only and installed then
    raise exception using errcode = 'VX003',
      message = 'An installed application cannot be deleted';
  end if;

  select coalesce(pg_catalog.array_agg(role_row.role_id), array[]::uuid[]) into role_ids
  from vortex_access.organization_roles as role_row
  where role_row.organization_id = p_organization_id
    and (role_row.application_root_id = p_application_root_id
      or role_row.derived_application_root_id = p_application_root_id);
  role_count := pg_catalog.cardinality(role_ids);
  select pg_catalog.count(*) into assignment_count
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = p_organization_id
    and assignment.role_id = any(role_ids);
  select pg_catalog.count(*) into entry_count
  from vortex_access.organization_role_permission_entries as entry
  where entry.organization_id = p_organization_id
    and (entry.role_id = any(role_ids) or entry.application_root_id = p_application_root_id);
  select pg_catalog.count(*) into release_count
  from vortex_definition.releases as release where release.root_id = p_application_root_id;
  application_name := coalesce((
      select release.application_address ->> 'name'
      from vortex_definition.roots as root
      join vortex_definition.releases as release
        on release.root_id = root.root_id
        and release.release_revision = root.current_release_revision
      where root.root_id = p_application_root_id),
    (select pg_catalog.btrim(draft.draft_source -> 'body' ->> 'name')
      from vortex_definition.drafts as draft where draft.root_id = p_application_root_id),
    app_root.key);
  -- Links other applications keep into this one's records are removed with them, and counted.
  select pg_catalog.count(*) into external_links
  from vortex_record.relationship_edges as edge
  where edge.to_storage_contract_id in (
      select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
      where catalogue.module_root_id = any(all_ids))
    and edge.from_storage_contract_id not in (
      select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
      where catalogue.module_root_id = any(all_ids));

  for storage_row in
    select catalogue.storage_contract_id, catalogue.physical_table_token
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = any(all_ids)
      and catalogue.physical_schema_token = 'record_data'
    order by catalogue.storage_contract_id
  loop
    table_count := table_count + 1;
    if pg_catalog.to_regclass(pg_catalog.format('record_data.%I', storage_row.physical_table_token))
      is not null then
      execute pg_catalog.format('select pg_catalog.count(*) from record_data.%I',
        storage_row.physical_table_token) into table_total;
      record_total := record_total + table_total;
    end if;
  end loop;

  if p_confirmed_name is not null
    and pg_catalog.btrim(p_confirmed_name) <> application_name then
    raise exception using errcode = 'VX004',
      message = 'The typed name does not match the application name';
  end if;

  return pg_catalog.jsonb_build_object(
    'application_name', application_name,
    'installed', installed,
    'external_links', external_links,
    'roles', role_count,
    'role_assignments', assignment_count,
    'permission_entries', entry_count,
    'releases', release_count,
    'records', record_total,
    'record_tables', table_count
  );
end
$function$;

revoke all on function vortex_definition.purge_application_review_internal(uuid, uuid, boolean, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.purge_application_review_internal(uuid, uuid, boolean, text)
  to vortex_owner, vortex_history_purger;

comment on function vortex_definition.purge_application_review_internal(uuid, uuid, boolean, text) is
  'The proof every removal of an application needs, and what it would take: an ordinary application of the organisation, not the default application, nothing depending on it, not installed when only deleting, and the typed name when one is given. Deletes nothing.';

alter function vortex_definition.purge_application_review_internal(uuid, uuid, boolean, text) owner to vortex_owner;
