create or replace function vortex_definition.seed_preview_installation(
  p_preview_installation_id uuid,
  p_demand jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  preview_row vortex_definition.preview_installations;
  closure_value jsonb;
  storage_identity jsonb;
  copy_result jsonb;
  record_type_id_value uuid;
  bounded_value boolean;
  seeded_ids text[] := array[]::text[];
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
  closure_value := vortex_definition.preview_demand_closure_internal(
    p_preview_installation_id, p_demand
  );

  -- Each record type of the closure is seeded once, whole: every field its builder reads live.
  -- Demanding a seeded record type again seeds nothing.
  for storage_identity in
    select identity.value
    from pg_catalog.jsonb_array_elements(preview_row.storage_identities) as identity(value)
    where closure_value -> 'closure' ? pg_catalog.lower(identity.value ->> 'recordTypeId')
      and not exists (
        select 1
        from vortex_definition.preview_installation_seeds as seed
        where seed.preview_installation_id = p_preview_installation_id
          and seed.record_type_id = (identity.value ->> 'recordTypeId')::uuid
      )
    order by identity.value ->> 'previewStorageContractId'
  loop
    record_type_id_value := (storage_identity ->> 'recordTypeId')::uuid;
    bounded_value := false;
    -- Only an installed live type is seedable. New draft types start empty; an existing
    -- catalogue entry alone never makes a source readable through this installation.
    if preview_row.seedable and vortex_record.resolve_preview_seed_source_internal(
      preview_row.organization_id, preview_row.application_root_id,
      (storage_identity ->> 'moduleRootId')::uuid, record_type_id_value,
      (storage_identity ->> 'releaseStorageContractId')::uuid
    ) is not null then
      copy_result := vortex_record.copy_live_records_to_preview_internal(
        p_preview_installation_id, record_type_id_value,
        (storage_identity ->> 'releaseStorageContractId')::uuid,
        (storage_identity ->> 'previewStorageContractId')::uuid
      );
      bounded_value := (copy_result ->> 'bounded')::boolean;
    end if;
    -- A record type with no totals or stored calculations is ready as copied.
    insert into vortex_definition.preview_installation_seeds (
      preview_installation_id, record_type_id, seeded_at, bounded, derived_ready_at
    ) values (
      p_preview_installation_id, record_type_id_value, pg_catalog.statement_timestamp(),
      bounded_value,
      case when closure_value -> 'derivedRecordTypeIds' ? pg_catalog.lower(record_type_id_value::text)
        then null else pg_catalog.statement_timestamp() end
    );
    seeded_ids := seeded_ids || pg_catalog.lower(record_type_id_value::text);
  end loop;

  -- Records new to a total's source change its total: those record types are worked out again.
  update vortex_definition.preview_installation_seeds as seed
  set derived_ready_at = null
  where seed.preview_installation_id = p_preview_installation_id
    and seed.derived_ready_at is not null
    and exists (
      select 1
      from pg_catalog.unnest(seeded_ids) as source(id)
      where closure_value -> 'totalsOver' -> source.id ? pg_catalog.lower(seed.record_type_id::text)
    );
  -- A seeded record type the preview no longer runs, or that no longer has totals or stored
  -- calculations, has nothing left to work out.
  update vortex_definition.preview_installation_seeds as seed
  set derived_ready_at = pg_catalog.statement_timestamp()
  where seed.preview_installation_id = p_preview_installation_id
    and seed.derived_ready_at is null
    and not closure_value -> 'derivedRecordTypeIds' ? pg_catalog.lower(seed.record_type_id::text);

  return pg_catalog.jsonb_build_object(
    'draftRevision', preview_row.draft_revision,
    'closure', closure_value -> 'closure',
    'seeded', pg_catalog.to_jsonb(seeded_ids),
    'pendingDerived', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
        order by seed.record_type_id)
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = p_preview_installation_id
        and seed.derived_ready_at is null
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_definition.seed_preview_installation(uuid, jsonb) owner to vortex_owner;

revoke all on function vortex_definition.seed_preview_installation(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.seed_preview_installation(uuid, jsonb) to vortex_request;
comment on function vortex_definition.seed_preview_installation(uuid, jsonb) is
  'Seeds a preview''s storage with what one demand needs, decided by the database: each record type of the demand''s closure not yet seeded gets the live records its builder reads in the installed Application and only the fields they read there, at most 2,000, and a seed ledger row saying whether it reached that bound and whether its derived fields are worked out. Demanding seeded record types again seeds nothing. A preview never shows more than its builder sees live, plus what they create in it.';
