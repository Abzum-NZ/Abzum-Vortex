create or replace function vortex_definition.read_owned_module_roots(
  p_application_root_id uuid
)
returns table (
  root_id uuid,
  definition_key text,
  draft_revision bigint,
  current_release_revision bigint,
  source_fingerprint text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if p_application_root_id is null or not exists (
    select 1
    from vortex_definition.roots as owner_root
    where owner_root.root_id = p_application_root_id
      and owner_root.kind = 'application'
      and owner_root.organization_id = (checked_context ->> 'organizationId')::uuid
  ) then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  return query
  select root.root_id, root.key, draft.draft_revision, root.current_release_revision,
    draft.source_fingerprint
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.owner_application_root_id = p_application_root_id
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'module'
  order by root.key collate "C", root.root_id
  limit 200;
end
$function$;

revoke all on function vortex_definition.read_owned_module_roots(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_owned_module_roots(uuid) to vortex_request;

comment on function vortex_definition.read_owned_module_roots(uuid) is
  'Lists the internal Module roots one Application owns, with their draft and current release revisions, for its publication.';

alter function vortex_definition.read_owned_module_roots(uuid) owner to vortex_owner;
