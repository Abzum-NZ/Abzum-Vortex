create or replace function vortex_definition.reconcile_preview_installation(
  p_preview_installation_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  reconcile_interval constant interval := interval '5 minutes';
  checked_context jsonb;
  preview_row vortex_definition.preview_installations;
  storage_identity jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  -- Like the seed, the check runs in the installed Application's own context, never the preview.
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  if not checked_context ? 'applicationRootId'
    or nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '')
      is not null then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.application_root_id = (checked_context ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Preview installation is unavailable';
  end if;
  -- A preview with nothing seeded has nothing to check; a recent check is not repeated.
  if not exists (
      select 1
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = p_preview_installation_id
    )
    or preview_row.reconciled_at > pg_catalog.statement_timestamp() - reconcile_interval then
    return false;
  end if;
  for storage_identity in
    select identity.value
    from pg_catalog.jsonb_array_elements(preview_row.storage_identities) as identity(value)
    -- Only the record types the preview was seeded with hold copies of live records.
    where exists (
      select 1
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = p_preview_installation_id
        and seed.record_type_id = (identity.value ->> 'recordTypeId')::uuid
    )
    and exists (
      select 1
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = (identity.value ->> 'releaseStorageContractId')::uuid
        and catalogue.physical_schema_token = 'record_data'
        and catalogue.state = 'active'
    )
    order by identity.value ->> 'previewStorageContractId'
  loop
    perform vortex_record.reconcile_preview_records_internal(
      (storage_identity ->> 'recordTypeId')::uuid,
      (storage_identity ->> 'releaseStorageContractId')::uuid,
      (storage_identity ->> 'previewStorageContractId')::uuid
    );
  end loop;
  update vortex_definition.preview_installations as preview
  set reconciled_at = pg_catalog.statement_timestamp()
  where preview.preview_installation_id = p_preview_installation_id;
  return true;
end
$function$;

alter function vortex_definition.reconcile_preview_installation(uuid) owner to vortex_owner;

revoke all on function vortex_definition.reconcile_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.reconcile_preview_installation(uuid) to vortex_request;
comment on function vortex_definition.reconcile_preview_installation(uuid) is
  'When a builder opens their preview, decides its copied records again by their current live access, at most every five minutes: a record they can no longer read leaves the preview and a field they can no longer read is emptied. A preview never keeps more than its builder sees live.';
