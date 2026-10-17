create or replace function vortex_definition.seed_preview_installation(
  p_preview_installation_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  preview_row vortex_definition.preview_installations;
  storage_identity jsonb;
  copy_result jsonb;
  seeded_count bigint := 0;
  bounded_ids uuid[] := array[]::uuid[];
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  -- The seed reads the installed Application as its builder reads it: the request runs in the
  -- installed Application's own context, never in the preview.
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
  if preview_row.seeded_at is not null or preview_row.runtime_release_set is not null then
    raise exception using errcode = '55000', message = 'Preview installation is already seeded';
  end if;

  for storage_identity in
    select identity.value
    from pg_catalog.jsonb_array_elements(preview_row.storage_identities) as identity(value)
    where exists (
      select 1
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = (identity.value ->> 'releaseStorageContractId')::uuid
        and catalogue.physical_schema_token = 'record_data'
        and catalogue.state = 'active'
    )
    order by identity.value ->> 'previewStorageContractId'
  loop
    copy_result := vortex_record.copy_live_records_to_preview_internal(
      p_preview_installation_id,
      (storage_identity ->> 'recordTypeId')::uuid,
      (storage_identity ->> 'releaseStorageContractId')::uuid,
      (storage_identity ->> 'previewStorageContractId')::uuid
    );
    seeded_count := seeded_count + (copy_result ->> 'copied')::bigint;
    if (copy_result ->> 'bounded')::boolean then
      bounded_ids := bounded_ids || (storage_identity ->> 'recordTypeId')::uuid;
    end if;
  end loop;
  update vortex_definition.preview_installations as preview
  set seeded_at = pg_catalog.statement_timestamp(),
      seed_bounded_record_type_ids = bounded_ids
  where preview.preview_installation_id = p_preview_installation_id;
  return seeded_count;
end
$function$;

alter function vortex_definition.seed_preview_installation(uuid) owner to vortex_owner;

revoke all on function vortex_definition.seed_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.seed_preview_installation(uuid) to vortex_request;
comment on function vortex_definition.seed_preview_installation(uuid) is
  'Seeds a new preview''s storage, once, with the live records its builder reads in the installed Application and only the fields they read there, at most 2,000 per record type, and records the record types that reached that bound. A preview never shows more than its builder sees live, plus what they create in it.';
