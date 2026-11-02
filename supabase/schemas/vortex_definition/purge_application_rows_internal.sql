-- The first deletion of an application (the history function runs it, and the migration that
-- converts the old App Store runs it as vortex_owner): everything that is not protected
-- history: records and their tables, drafts, bindings, runtime bundles, previews, runs, views,
-- files, access plans. It ends with the roots released so that the releases can go.
create or replace function vortex_definition.purge_application_rows_internal(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  all_ids uuid[];
  storage_row record;
begin
  select pg_catalog.array_agg(root.root_id) into all_ids
  from vortex_definition.roots as root
  where root.organization_id = p_organization_id
    and (root.root_id = p_application_root_id
      or root.owner_application_root_id = p_application_root_id);

  delete from vortex_access.flow_run_evidence as evidence
  where evidence.organization_id = p_organization_id
    and evidence.application_root_id = p_application_root_id;
  delete from vortex_definition.form_drafts as form_draft
  where form_draft.organization_id = p_organization_id
    and form_draft.application_root_id = p_application_root_id;
  delete from vortex_platform.backend_runs as run
  where run.organization_id = p_organization_id
    and run.application_root_id = p_application_root_id;
  delete from vortex_platform.grid_views as view_row
  where view_row.organization_id = p_organization_id
    and view_row.application_root_id = p_application_root_id;
  delete from vortex_platform.file_records as file_row
  where file_row.organization_id = p_organization_id
    and file_row.application_root_id = p_application_root_id;
  delete from vortex_definition.preview_installations as preview
  where preview.organization_id = p_organization_id
    and preview.application_root_id = p_application_root_id;
  -- A preview of another draft that pinned this application, and its storage bindings.
  delete from vortex_definition.preview_releases as pinned where pinned.root_id = any(all_ids);
  delete from vortex_record.preview_storage_bindings as binding
  where binding.module_root_id = any(all_ids)
    or binding.storage_contract_id in (
      select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
      where catalogue.module_root_id = any(all_ids));

  delete from vortex_platform.consumer_occurrence_progress as progress
  where progress.occurrence_id in (
    select occurrence.occurrence_id from vortex_platform.event_outbox as occurrence
    where occurrence.organization_id = p_organization_id
      and (occurrence.sequence_application_root_id = p_application_root_id
        or occurrence.storage_contract_id in (
          select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
          where catalogue.module_root_id = any(all_ids))));

  delete from vortex_definition.installation_runtime_bundle_parts as part
  where part.organization_id = p_organization_id
    and part.application_root_id = p_application_root_id;
  delete from vortex_definition.installation_runtime_bundles as bundle
  where bundle.organization_id = p_organization_id
    and bundle.application_root_id = p_application_root_id;
  delete from vortex_definition.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id;
  delete from vortex_record.installation_access_plans as plan
  where plan.organization_id = p_organization_id
    and plan.application_root_id = p_application_root_id;

  delete from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = p_organization_id
    and effect.application_root_id = p_application_root_id;
  delete from vortex_record.documents as document
  where document.organization_id = p_organization_id
    and document.application_root_id = p_application_root_id;
  delete from vortex_record.record_type_lifecycle_policies as policy
  where policy.organization_id = p_organization_id
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
    -- A lifecycle policy of any application that names this storage goes with it.
    delete from vortex_record.record_type_lifecycle_policies as policy
    where policy.storage_contract_id = storage_row.storage_contract_id;
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

  -- The roots stop naming a release so that the releases can go, and the drafts go first.
  update vortex_definition.roots as root
  set current_release_revision = null
  where root.root_id = any(all_ids);
  delete from vortex_definition.drafts as draft where draft.root_id = any(all_ids);
end
$function$;

revoke all on function vortex_definition.purge_application_rows_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.purge_application_rows_internal(uuid, uuid)
  to vortex_owner, vortex_history_purger;
alter function vortex_definition.purge_application_rows_internal(uuid, uuid) owner to vortex_owner;
