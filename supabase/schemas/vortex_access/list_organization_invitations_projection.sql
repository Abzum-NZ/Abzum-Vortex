create or replace function vortex_access.list_organization_invitations_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope_row record;
begin
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_invitations_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  return query
  select scope_row.organization_id, projected.invitation_id, projected.revision,
    pg_catalog.jsonb_build_object(
      'invited_email', projected.invited_email,
      'state', projected.invitation_state,
      'invited_at', projected.invited_at,
      'expires_at', projected.expires_at
    )
  from vortex_identity.list_organization_invitations_projection_internal(
    scope_row.organization_id, p_record_ids, p_sort_key, p_direction, p_after, p_limit
  ) as projected;
end
$function$;

revoke all on function vortex_access.list_organization_invitations_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_invitations_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_invitations_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;
