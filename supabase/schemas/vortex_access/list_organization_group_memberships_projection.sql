create or replace function vortex_access.list_organization_group_memberships_projection(
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
  checked_at timestamptz;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.organization.groups.read decision the bespoke membership
  -- administration reader applies is the only visibility, and the caller's
  -- current organisation is never an input. A viewer the decision refuses sees
  -- no rows, exactly as a missing or foreign record, so the record adapters
  -- return their identical refusal and a list page is empty rather than failing.
  -- The record identity is the membership, the revision is the membership's own
  -- revision and the attribute names are the lowercase field keys a projection
  -- record type declares. The temporal state is descriptive and grants no
  -- permission, exactly as the bespoke reader; grant and revocation evidence is
  -- never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_groups_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  return query
  select
    scope_row.organization_id,
    membership.membership_id,
    membership.revision,
    pg_catalog.jsonb_build_object(
      'group_id', membership.group_id,
      'organization_account_id', membership.organization_account_id,
      'account_display_name', account.display_name,
      'starts_at', membership.starts_at,
      'expires_at', membership.expires_at,
      'state', membership.state,
      'temporal_state', case
        when membership.state = 'revoked' then 'revoked'
        when membership.starts_at > checked_at then 'scheduled'
        when membership.expires_at is not null
          and membership.expires_at <= checked_at then 'expired'
        else 'active'
      end
    )
  from vortex_access.organization_group_memberships as membership
  join vortex_identity.organization_accounts as account
    on account.organization_id = membership.organization_id
    and account.organization_account_id = membership.organization_account_id
  where membership.organization_id = scope_row.organization_id
    and (p_record_id is null or p_record_id = membership.membership_id)
  order by membership.membership_id;
end
$function$;

revoke all on function vortex_access.list_organization_group_memberships_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_group_memberships_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_group_memberships_projection(uuid, integer) is
  'Registered group-membership projection: returns every membership of the current viewer''s organisation under the fixed platform.organization.groups.read decision, with the organisation, the membership identity, the membership revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. Grant and revocation evidence is never projected.';
