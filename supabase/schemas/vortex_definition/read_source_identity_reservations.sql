create or replace function vortex_definition.read_source_identity_reservations(p_root_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  root_row vortex_definition.roots%rowtype;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  select root.* into root_row from vortex_definition.roots as root where root.root_id = p_root_id;
  if not found then
    raise exception using errcode = '23503', message = 'Definition root is missing';
  end if;
  if root_row.organization_id <> (checked_context ->> 'organizationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'definitionKey', root.key, 'scope', alias.scope, 'kind', alias.kind,
      'componentOwner', alias.component_owner, 'alias', alias.alias
    ) order by root.key, alias.scope, alias.kind, alias.alias)
    from vortex_definition.roots as root
    join vortex_definition.source_identity_aliases as alias on alias.root_id = root.root_id
    where root.organization_id = root_row.organization_id
      and (root.root_id = p_root_id or root.owner_application_root_id = p_root_id)
  ), '[]'::jsonb);
end
$function$;

alter function vortex_definition.read_source_identity_reservations(uuid) owner to vortex_owner;
revoke all on function vortex_definition.read_source_identity_reservations(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_source_identity_reservations(uuid) to vortex_request, postgres;
