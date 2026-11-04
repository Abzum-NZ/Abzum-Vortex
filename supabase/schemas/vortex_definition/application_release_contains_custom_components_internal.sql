-- Whether an Application release places a platform block that is not a built-in block. A custom
-- component is a platform block release registered outside the built-in catalogue. The decision
-- reads the release content's platformBlockDependencies, the list the runtime bundle registers
-- (write_installation_runtime_bundle), and counts any block that
-- vortex_definition.platform_block_catalogue does not hold, so a block the database does not know
-- can never skip the custom code permission and recent sign-in that installing custom code needs. A
-- list that is missing or malformed counts too. A built-in block added to the platform block
-- catalogue (application-composition-catalogue.source.json) is added to that table in the same
-- change.
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
  select coalesce((
    select pg_catalog.jsonb_typeof(source.dependencies) is distinct from 'array'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(source.dependencies) = 'array'
            then source.dependencies else '[]'::jsonb end
        ) as dependency(value)
        where pg_catalog.jsonb_typeof(dependency.value) is distinct from 'object'
          or dependency.value ->> 'blockId' is null
          or dependency.value ->> 'blockId' !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or not exists (
            select 1 from vortex_definition.platform_block_catalogue as built_in
            where built_in.block_id = (dependency.value ->> 'blockId')::uuid
          )
      )
    from (
      select release.compilation_output #> '{canonical,content,platformBlockDependencies}'
      from vortex_definition.releases as release
      where release.root_id = p_application_root_id
        and release.release_revision = p_application_release_revision
    ) as source(dependencies)
  ), true);
$function$;

alter function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  owner to vortex_owner;

revoke all on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  to postgres;

comment on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint) is
  'Private: true when the content of an Application release names a platform block that is not a built-in block, that is, a custom component, or a malformed list.';
