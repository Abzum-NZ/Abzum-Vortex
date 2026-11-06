-- B7D-B5 (SWEEP12-R1): the builder's preview reads the platform block and theme pins of the
-- Application's current release, to run that release only while the platform catalogue still
-- matches them; a release the catalogue has since superseded is replaced in the preview by a
-- compile of the draft. Read-only, builder-scoped like read_saved_condition_history; no stored
-- release is changed.
set role vortex_owner;

create or replace function vortex_definition.read_release_catalogue_pins(
  p_root_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  root_row vortex_definition.roots%rowtype;
begin
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if p_root_id is null or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Release catalogue pins require a non-nil root identifier';
  end if;
  select root.* into root_row from vortex_definition.roots as root where root.root_id = p_root_id;
  if not found or root_row.current_release_revision is null then return null; end if;
  if root_row.organization_id <> (checked_context ->> 'organizationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;
  return (
    select pg_catalog.jsonb_build_object(
      'validationContractVersion', release.validation_contract_version,
      'pins', coalesce((
        select pg_catalog.jsonb_agg(case dependency.dependency_kind
          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', dependency.dependency_kind,
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint)
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', dependency.dependency_kind,
            'key', dependency.dependency_reference,
            'rootId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint)
          when 'protected_operation' then dependency.dependency_entry
          else pg_catalog.jsonb_build_object(
            'kind', dependency.dependency_kind,
            'blockId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint)
        end order by dependency.dependency_kind, dependency.dependency_reference)
        from vortex_definition.release_dependencies as dependency
        where dependency.root_id = release.root_id
          and dependency.release_revision = release.release_revision
          and dependency.dependency_kind in ('platform_block', 'platform_theme', 'connection_type', 'protected_operation')
      ), '[]'::jsonb)
    )
    from vortex_definition.releases as release
    where release.root_id = p_root_id and release.release_revision = root_row.current_release_revision
  );
end
$function$;

alter function vortex_definition.read_release_catalogue_pins(uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_release_catalogue_pins(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_release_catalogue_pins(uuid) to vortex_request;
comment on function vortex_definition.read_release_catalogue_pins(uuid) is
  'The platform block, theme, connection type and operation pins of one Application''s current release, for a builder of its organisation, so the preview can tell whether that release still matches the platform catalogue.';

reset role;
