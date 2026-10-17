create or replace function vortex_definition.is_owned_module_source_internal(
  p_owner_application_root_id uuid,
  p_organization_id uuid,
  p_source jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  -- A Module source is exactly the lowering of one inline Module of its owning Application's
  -- current draft: the inline Module's alias, key and body, naming that Application as its owner,
  -- under the one accepted Module contract version (accepted_contract_version('module')). Nothing else may
  -- differ; a Module's dependencies are derived when it is compiled and never stored.
  select exists (
    select 1
    from vortex_definition.roots as owner_root
    join vortex_definition.drafts as owner_draft on owner_draft.root_id = owner_root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(owner_draft.draft_source #> '{body,modules}', '[]'::jsonb)
    ) as inline_module(value)
    where owner_root.root_id = p_owner_application_root_id
      and owner_root.organization_id = p_organization_id
      and owner_root.kind = 'application'
      and p_source = pg_catalog.jsonb_build_object(
        'source_contract_version', (vortex_definition.accepted_contract_version('module'))[1],
        'root_alias', inline_module.value -> 'id',
        'key', inline_module.value -> 'key',
        'kind', 'module',
        'body', (inline_module.value - 'id' - 'key')
          || pg_catalog.jsonb_build_object('owner_application', owner_root.key)
      )
  );
$function$;

revoke all on function vortex_definition.is_owned_module_source_internal(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_definition.is_owned_module_source_internal(uuid, uuid, jsonb) is
  'Whether a Module source is exactly one inline Module of its owning Application''s current draft.';

alter function vortex_definition.is_owned_module_source_internal(uuid, uuid, jsonb) owner to vortex_owner;
