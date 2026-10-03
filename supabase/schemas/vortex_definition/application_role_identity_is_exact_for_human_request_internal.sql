create or replace function vortex_definition.application_role_identity_is_exact_for_human_request_internal(
  p_application_root_id uuid,
  p_source_role_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  visible_organization_id uuid;
begin
  if p_application_root_id is null or p_source_role_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;
  begin
    visible_organization_id := (
      vortex_access.validated_human_request_context() ->> 'organizationId'
    )::uuid;
  exception
    when insufficient_privilege then
      return false;
  end;
  return exists (
    select 1
    from vortex_definition.source_identities as identity
    join vortex_definition.roots as root on root.root_id = identity.root_id
    where identity.identity_id = p_source_role_id
      and identity.root_id = p_application_root_id
      and identity.kind = 'role'
      and root.kind = 'application'
      and root.organization_id = visible_organization_id
  );
end
$function$;

alter function vortex_definition.application_role_identity_is_exact_for_human_request_internal(
  uuid, uuid
) owner to vortex_definition_owner;

revoke all on function vortex_definition.application_role_identity_is_exact_for_human_request_internal(
  uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner;

grant execute on function vortex_definition.application_role_identity_is_exact_for_human_request_internal(
  uuid, uuid
) to postgres;

comment on function vortex_definition.application_role_identity_is_exact_for_human_request_internal(uuid, uuid) is
  'Private boolean identity proof for the current validated human organization: true only for an exact permanent role identity belonging to the supplied application root in that organization. Returns no identity records, aliases or source content; missing, foreign, nil and wrong-kind identities return false.';
