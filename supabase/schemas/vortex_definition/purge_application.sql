create or replace function vortex_definition.purge_application(
  p_application_root_id uuid,
  p_apply boolean,
  p_delete_only boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
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
  context_value jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_apply is null
    or p_delete_only is null then
    raise exception using errcode = '22023',
      message = 'Application purge command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  select root.root_id, root.key, root.application_origin_kind into app_root
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = authority.organization_id
    and root.kind = 'application'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Application is unavailable';
  end if;
  if app_root.application_origin_kind = 'platform_system_application' then
    raise exception using errcode = '42501',
      message = 'A system application can never be removed or deleted';
  end if;
  if exists (
    select 1 from vortex_identity.organization_runtime_settings as settings
    where settings.organization_id = authority.organization_id
      and settings.default_application_root_id = p_application_root_id
  ) then
    raise exception using errcode = '23514',
      message = 'The organisation default application cannot be removed or deleted';
  end if;

  select coalesce(pg_catalog.array_agg(module.root_id), array[]::uuid[]) into module_ids
  from vortex_definition.roots as module
  where module.organization_id = authority.organization_id
    and module.owner_application_root_id = p_application_root_id;
  all_ids := pg_catalog.array_append(module_ids, p_application_root_id);

  -- Another definition that was published against this one would lose what it pins.
  if exists (
    select 1 from vortex_definition.release_dependencies as dependency
    where dependency.target_root_id = any(all_ids) and dependency.root_id <> all(all_ids)
  ) then
    raise exception using errcode = '23503',
      message = 'Another application depends on this application';
  end if;

  select pg_catalog.bool_or(binding.state <> 'detached') into installed
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id;
  installed := coalesce(installed, false);
  if p_delete_only and installed then
    raise exception using errcode = '55006',
      message = 'An installed application cannot be deleted';
  end if;

  select coalesce(pg_catalog.array_agg(role_row.role_id), array[]::uuid[]) into role_ids
  from vortex_access.organization_roles as role_row
  where role_row.organization_id = authority.organization_id
    and (role_row.application_root_id = p_application_root_id
      or role_row.derived_application_root_id = p_application_root_id);
  role_count := pg_catalog.cardinality(role_ids);
  select pg_catalog.count(*) into assignment_count
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = authority.organization_id
    and assignment.role_id = any(role_ids);
  select pg_catalog.count(*) into entry_count
  from vortex_access.organization_role_permission_entries as entry
  where entry.organization_id = authority.organization_id
    and (entry.role_id = any(role_ids) or entry.application_root_id = p_application_root_id);
  select pg_catalog.count(*) into release_count
  from vortex_definition.releases as release where release.root_id = p_application_root_id;

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

  if not p_apply then
    return pg_catalog.jsonb_build_object(
      'application_name', coalesce((
        select release.application_address ->> 'name'
        from vortex_definition.roots as root
        join vortex_definition.releases as release
          on release.root_id = root.root_id
          and release.release_revision = root.current_release_revision
        where root.root_id = p_application_root_id),
        (select pg_catalog.btrim(draft.draft_source -> 'body' ->> 'name')
          from vortex_definition.drafts as draft where draft.root_id = p_application_root_id),
        app_root.key),
      'installed', installed,
      'roles', role_count,
      'role_assignments', assignment_count,
      'permission_entries', entry_count,
      'releases', release_count,
      'records', record_total,
      'record_tables', table_count
    );
  end if;

  -- The immutability triggers of the history tables let this one function delete their rows.
  perform pg_catalog.set_config('vortex.application_purge', 'on', true);

  delete from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = authority.organization_id
    and assignment.role_id = any(role_ids);
  delete from vortex_access.organization_role_permission_entries as entry
  where entry.organization_id = authority.organization_id
    and (entry.role_id = any(role_ids) or entry.application_root_id = p_application_root_id);
  delete from vortex_access.organization_role_revisions as revision
  where revision.organization_id = authority.organization_id
    and revision.role_id = any(role_ids);
  delete from vortex_access.organization_roles as role_row
  where role_row.organization_id = authority.organization_id
    and role_row.role_id = any(role_ids);
  delete from vortex_access.permission_continuities as continuity
  where continuity.organization_id = authority.organization_id
    and (continuity.application_root_id = p_application_root_id
      or continuity.registration_owner_id = any(all_ids));
  delete from vortex_access.application_role_template_continuities as continuity
  where continuity.organization_id = authority.organization_id
    and continuity.application_root_id = p_application_root_id;
  delete from vortex_access.permission_catalogue_entries as catalogue_entry
  where catalogue_entry.organization_id = authority.organization_id
    and (catalogue_entry.application_root_id = p_application_root_id
      or catalogue_entry.registration_owner_id = any(all_ids));
  delete from vortex_access.permission_registration_revisions as registration
  where registration.organization_id = authority.organization_id
    and registration.registration_owner_id = any(all_ids);
  delete from vortex_access.permission_registrations as registration
  where registration.organization_id = authority.organization_id
    and registration.registration_owner_id = any(all_ids);

  delete from vortex_access.flow_run_evidence as evidence
  where evidence.organization_id = authority.organization_id
    and evidence.application_root_id = p_application_root_id;
  delete from vortex_definition.form_drafts as form_draft
  where form_draft.organization_id = authority.organization_id
    and form_draft.application_root_id = p_application_root_id;
  delete from vortex_platform.backend_runs as run
  where run.organization_id = authority.organization_id
    and run.application_root_id = p_application_root_id;
  delete from vortex_platform.grid_views as view_row
  where view_row.organization_id = authority.organization_id
    and view_row.application_root_id = p_application_root_id;
  delete from vortex_platform.file_records as file_row
  where file_row.organization_id = authority.organization_id
    and file_row.application_root_id = p_application_root_id;
  delete from vortex_definition.preview_installations as preview
  where preview.organization_id = authority.organization_id
    and preview.application_root_id = p_application_root_id;

  delete from vortex_platform.consumer_occurrence_progress as progress
  where progress.occurrence_id in (
    select occurrence.occurrence_id from vortex_platform.event_outbox as occurrence
    where occurrence.organization_id = authority.organization_id
      and (occurrence.sequence_application_root_id = p_application_root_id
        or occurrence.storage_contract_id in (
          select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
          where catalogue.module_root_id = any(all_ids))));
  delete from vortex_platform.event_outbox as occurrence
  where occurrence.organization_id = authority.organization_id
    and (occurrence.sequence_application_root_id = p_application_root_id
      or occurrence.storage_contract_id in (
        select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
        where catalogue.module_root_id = any(all_ids)));

  delete from vortex_definition.installation_runtime_bundle_parts as part
  where part.organization_id = authority.organization_id
    and part.application_root_id = p_application_root_id;
  delete from vortex_definition.installation_runtime_bundles as bundle
  where bundle.organization_id = authority.organization_id
    and bundle.application_root_id = p_application_root_id;
  delete from vortex_definition.installation_bindings as binding
  where binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id;
  delete from vortex_record.installation_access_plans as plan
  where plan.organization_id = authority.organization_id
    and plan.application_root_id = p_application_root_id;

  delete from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = authority.organization_id
    and effect.application_root_id = p_application_root_id;
  delete from vortex_record.documents as document
  where document.organization_id = authority.organization_id
    and document.application_root_id = p_application_root_id;
  delete from vortex_record.record_type_lifecycle_policies as policy
  where policy.organization_id = authority.organization_id
    and policy.application_root_id = p_application_root_id;
  for storage_row in
    select catalogue.storage_contract_id, catalogue.physical_table_token
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = any(all_ids)
    order by catalogue.storage_contract_id
  loop
    delete from vortex_record.relationship_edges as edge
    where edge.from_storage_contract_id = storage_row.storage_contract_id
      or edge.to_storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.record_reference_counters as counter
    where counter.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.index_catalogue as index_row
    where index_row.storage_contract_id = storage_row.storage_contract_id;
    execute pg_catalog.format('drop table if exists record_data.%I', storage_row.physical_table_token);
    delete from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_row.storage_contract_id;
  end loop;
  delete from vortex_record.relationship_storage_mappings as mapping
  where mapping.module_root_id = any(all_ids);
  delete from vortex_record.release_provisions as provision
  where provision.module_root_id = any(all_ids);

  update vortex_definition.roots as root
  set current_release_revision = null
  where root.root_id = any(all_ids);
  delete from vortex_definition.drafts as draft where draft.root_id = any(all_ids);
  delete from vortex_definition.release_dependencies as dependency
  where dependency.root_id = any(all_ids);
  delete from vortex_definition.releases as release where release.root_id = any(all_ids);
  delete from vortex_definition.source_identity_aliases as alias where alias.root_id = any(all_ids);
  delete from vortex_definition.source_identities as identity_row
  where identity_row.root_id = any(all_ids);
  delete from vortex_definition.roots as module where module.root_id = any(module_ids);
  delete from vortex_definition.roots as root where root.root_id = p_application_root_id;

  perform pg_catalog.set_config('vortex.application_purge', 'off', true);

  context_value := vortex_access.validated_human_request_context();
  perform vortex_access.increment_organization_access_version(
    authority.organization_id,
    authority.organization_account_id,
    authority.correlation_id,
    'application_access_changed'
  );
  perform vortex_record.append_organization_activity_entry(
    authority.organization_id,
    pg_catalog.gen_random_uuid(),
    pg_catalog.statement_timestamp(),
    'organization_account',
    authority.organization_account_id,
    case when p_delete_only then 'delete_application' else 'purge_application' end,
    array[p_application_root_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    (context_value ->> 'correlationId')::uuid,
    'completed'
  );

  return pg_catalog.jsonb_build_object(
    'roles', role_count,
    'role_assignments', assignment_count,
    'permission_entries', entry_count,
    'releases', release_count,
    'records', record_total,
    'record_tables', table_count
  );
end
$function$;

revoke all on function vortex_definition.purge_application(uuid, boolean, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.purge_application(uuid, boolean, boolean)
  to vortex_request;

comment on function vortex_definition.purge_application(uuid, boolean, boolean) is
  'Counts, or with p_apply removes, everything one ordinary Application and the Modules it owns hold in the validated organisation: roots, releases, drafts, source identities, roles and their assignments and permission entries, catalogue entries, installation bindings, records and record tables, back-end runs, outbox events, in one transaction under the application installation authority. A system application, the default application and an application another one depends on are refused; p_delete_only also refuses an installed application.';

alter function vortex_definition.purge_application(uuid, boolean, boolean) owner to vortex_owner;
