-- Whether an Application release places a platform block that is not a built-in block. A custom
-- component is a platform block release registered outside the built-in catalogue, and the stored
-- dependency manifest names every platform block a release places. Any block that
-- vortex_definition.platform_block_catalogue does not hold therefore counts, so a block the
-- database does not know can never skip the custom code permission and recent sign-in that
-- installing custom code needs. A built-in block added to the platform block catalogue
-- (application-composition-catalogue.source.json) is added to that table in the same change.
create or replace function vortex_definition.application_release_contains_custom_components_internal(
  p_application_root_id uuid,
  p_application_release_revision bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_definition.release_dependencies as dependency
    where dependency.root_id = p_application_root_id
      and dependency.release_revision = p_application_release_revision
      and dependency.dependency_kind = 'platform_block'
      and not exists (
        select 1 from vortex_definition.platform_block_catalogue as built_in
        where built_in.block_id = dependency.catalogue_item_id
      )
  );
$function$;

alter function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  owner to vortex_owner;

revoke all on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  to postgres;

comment on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint) is
  'Private: true when the stored dependency manifest of an Application release names a platform block that is not a built-in block, that is, a custom component.';
