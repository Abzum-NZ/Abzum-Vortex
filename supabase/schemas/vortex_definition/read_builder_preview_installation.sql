create or replace function vortex_definition.read_builder_preview_installation(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  identity_value jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation identity is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  -- A builder has at most one preview of an Application; the newest is the current one. A
  -- preview whose provisioning stopped before it wrote the release set it runs never runs, so it
  -- is not a current preview: the next request provisions one that replaces it.
  select pg_catalog.jsonb_build_object(
    'previewInstallationId', preview.preview_installation_id,
    'organizationId', preview.organization_id,
    'applicationRootId', preview.application_root_id,
    'definitionKey', root.key,
    'draftRevision', preview.draft_revision,
    'expiresAt', preview.expires_at,
    'seedable', preview.seedable,
    'seededRecordTypeIds', coalesce(seeds.seeded_ids, '[]'::jsonb),
    'derivedReadyRecordTypeIds', coalesce(seeds.ready_ids, '[]'::jsonb),
    -- Every record type it has storage for: the record types a demand may name.
    'recordTypeIds', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(identity.value ->> 'recordTypeId')
          order by identity.value ->> 'previewStorageContractId'), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(preview.storage_identities) as identity(value)
    ),
    'shapeFingerprint', preview.draft_shape_fingerprint,
    -- Copied live records are decided again by the builder's live access at most every five
    -- minutes, counting from the first seed; reconcile_preview_installation keeps the same interval.
    'reconcileDue', seeds.first_seeded_at is not null
      and coalesce(preview.reconciled_at, seeds.first_seeded_at)
        <= pg_catalog.statement_timestamp() - interval '5 minutes'
  ) into identity_value
  from vortex_definition.preview_installations as preview
  join vortex_definition.roots as root on root.root_id = preview.application_root_id
  left join lateral (
    select pg_catalog.min(seed.seeded_at) as first_seeded_at,
      pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
        order by seed.record_type_id) as seeded_ids,
      pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
        order by seed.record_type_id) filter (where seed.derived_ready_at is not null) as ready_ids
    from vortex_definition.preview_installation_seeds as seed
    where seed.preview_installation_id = preview.preview_installation_id
  ) as seeds on true
  where preview.application_root_id = p_application_root_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
    and preview.runtime_release_set is not null
    and root.kind = 'application'
    and root.organization_id = preview.organization_id
  order by preview.created_at desc, preview.preview_installation_id desc
  limit 1;
  return identity_value;
end
$function$;

alter function vortex_definition.read_builder_preview_installation(uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_builder_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_builder_preview_installation(uuid)
  to vortex_request;
comment on function vortex_definition.read_builder_preview_installation(uuid) is
  'The current runnable, unexpired preview of one Application that the builder of the validated human organisation context opened: its draft revision, the fingerprint of the draft data shape it runs, whether it can be seeded, the record types it has storage for, those it was seeded with and those whose derived fields are worked out, and whether its copied live records are due to be decided again; null when they have none. Studio reads the canvas and Data tab records through it.';
