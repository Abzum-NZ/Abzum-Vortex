create or replace function vortex_access.list_organization_delegations_projection(
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
  -- platform.organization.assignments.read decision the bespoke delegation
  -- administration reader applies is the only visibility, and the caller's
  -- current organisation is never an input. A viewer the decision refuses sees
  -- no rows, exactly as a missing or foreign record, so the record adapters
  -- return their identical refusal and a list page is empty rather than failing.
  -- The record identity is the delegation authority, the revision is the
  -- delegation's own revision and the attribute names are the lowercase field
  -- keys a projection record type declares. The temporal state is descriptive
  -- and grants no permission; the bounded permission set, its fingerprint and
  -- every grant or revocation audit column are never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  return query
  select
    scope_row.organization_id,
    delegation.delegation_authority_id,
    delegation.revision,
    pg_catalog.jsonb_build_object(
      'holder_kind', delegation.holder_kind,
      'organization_account_id', delegation.organization_account_id,
      'group_id', delegation.group_id,
      'scope_kind', delegation.scope_kind,
      'starts_at', delegation.starts_at,
      'expires_at', delegation.expires_at,
      'state', delegation.state,
      'temporal_state', case
        when delegation.state = 'revoked' then 'revoked'
        when delegation.starts_at > checked_at then 'scheduled'
        when delegation.expires_at is not null
          and delegation.expires_at <= checked_at then 'expired'
        else 'active'
      end
    )
  from vortex_access.organization_delegation_authorities as delegation
  where delegation.organization_id = scope_row.organization_id
    and (p_record_id is null or p_record_id = delegation.delegation_authority_id)
  order by delegation.delegation_authority_id;
end
$function$;

revoke all on function vortex_access.list_organization_delegations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_delegations_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_delegations_projection(uuid, integer) is
  'Registered delegation projection: returns every current delegation authority of the viewer''s organisation under the fixed platform.organization.assignments.read decision, with the organisation, the delegation identity, the delegation revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. The bounded permission set, its fingerprint and every grant or revocation audit column are never projected.';
