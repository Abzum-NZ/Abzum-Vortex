create or replace function vortex_definition.read_builder_application_root_key(
  p_root_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  application_key text;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  if p_root_id is null or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Definition builder root key requires a non-nil root identifier';
  end if;

  select root.key into application_key
  from vortex_definition.roots as root
  where root.root_id = p_root_id
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'application';

  if not found then
    return null;
  end if;
  return application_key;
end
$function$;

revoke all on function vortex_definition.read_builder_application_root_key(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_builder_application_root_key(uuid)
  to vortex_request;
comment on function vortex_definition.read_builder_application_root_key(uuid) is
  'Returns only the key of one same-organisation Application root for validated builder evidence reads.';
