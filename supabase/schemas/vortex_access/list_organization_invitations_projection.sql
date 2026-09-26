create or replace function vortex_access.list_organization_invitations_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- invitations.read decision the bespoke administration reader applies decides
  -- whether the viewer sees any invitation at all, and the caller's current
  -- organisation is never an input. A viewer the decision refuses sees no rows,
  -- exactly as a missing or foreign record. The record identity is the
  -- invitation, the revision is the invitation's own revision and the attribute
  -- names are the lowercase field keys a projection record type declares. The
  -- raw invitation secret and its stored fingerprint are never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_invitations_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  return query
  select
    scope_row.organization_id,
    projected.invitation_id,
    projected.revision,
    pg_catalog.jsonb_build_object(
      'invited_email', projected.invited_email,
      'state', projected.invitation_state,
      'invited_at', projected.invited_at,
      'expires_at', projected.expires_at
    )
  from vortex_identity.list_organization_invitations_projection_internal(
    scope_row.organization_id
  ) as projected
  where p_record_id is null or p_record_id = projected.invitation_id;
end
$function$;

revoke all on function vortex_access.list_organization_invitations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_invitations_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_invitations_projection(uuid, integer) is
  'Registered organisation-invitation projection: returns every invitation the current viewer may read under the fixed invitations.read decision, with the organisation, the invitation identity, the invitation revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. The secret and fingerprint are never projected.';
