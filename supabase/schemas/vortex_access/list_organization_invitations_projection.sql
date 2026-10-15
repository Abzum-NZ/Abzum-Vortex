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

create or replace function vortex_access.list_organization_invitations_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_organization_invitations_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
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

revoke all on function vortex_access.list_organization_invitations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_invitations_projection(
  uuid, integer
) to vortex_owner, vortex_record_adapter, postgres;
comment on function vortex_access.list_organization_invitations_projection(uuid, integer) is
  'Registered invitation projection with the original record-id ordering and visibility; delegates to the bounded reader.';
alter function vortex_access.list_organization_invitations_projection(uuid, integer)
  owner to vortex_owner;
