create or replace function vortex_access.list_organization_accounts_projection(
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
  -- accounts.read decision the bespoke administration reader applies decides
  -- whether the viewer sees any account at all, and the caller's current
  -- organisation is never an input. A viewer the decision refuses sees no rows,
  -- exactly as a missing or foreign record, so the record adapters return their
  -- identical refusal and a list page is empty rather than failing. The record
  -- identity is the organisation account, the revision is the account's own
  -- revision and the attribute names are the lowercase field keys a projection
  -- record type declares. The raw identity, invitation link and state-change
  -- evidence stay in the protected storage and are never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_accounts_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  return query
  select
    scope_row.organization_id,
    projected.organization_account_id,
    projected.revision,
    pg_catalog.jsonb_build_object(
      'display_name', projected.display_name,
      'state', projected.account_state,
      'language', projected.language,
      'time_zone', projected.time_zone
    )
  from vortex_identity.list_organization_accounts_projection_internal(
    scope_row.organization_id
  ) as projected
  where p_record_id is null or p_record_id = projected.organization_account_id;
end
$function$;

revoke all on function vortex_access.list_organization_accounts_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_accounts_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_accounts_projection(uuid, integer) is
  'Registered organisation-account projection: returns every account the current viewer may read under the fixed accounts.read decision, with the organisation, the account identity, the account revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer.';
