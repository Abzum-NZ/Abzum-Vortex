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
  context_value jsonb;
  visible_organization_id uuid;
  active_members_only boolean;
begin
  -- The projection keeps today's row visibility inside itself, and the caller's
  -- current organisation is never an input. A viewer the fixed accounts.read
  -- decision admits sees every account of the organisation, exactly as the
  -- bespoke administration reader. Any other viewer whose human request context
  -- is still live sees only the active accounts of that organisation with their
  -- display name and state, exactly as the organisation-account choice reader.
  -- A viewer neither rule admits sees no rows, exactly as a missing or foreign
  -- record, so the record adapters return their identical refusal and a list
  -- page is empty rather than failing. The record identity is the organisation
  -- account, the revision is the account's own revision and the attribute
  -- names are the lowercase field keys a projection record type declares. The
  -- raw identity, invitation link and state-change evidence stay in the
  -- protected storage and are never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_accounts_administration_scope() as authorized;
    visible_organization_id := scope_row.organization_id;
    active_members_only := false;
  exception
    when insufficient_privilege then
      visible_organization_id := null;
  end;
  if visible_organization_id is null then
    begin
      context_value := vortex_access.validated_human_request_context();
    exception
      when insufficient_privilege then
        return;
    end;
    visible_organization_id := (context_value ->> 'organizationId')::uuid;
    active_members_only := true;
  end if;
  return query
  select
    visible_organization_id,
    projected.organization_account_id,
    projected.revision,
    pg_catalog.jsonb_build_object(
      'display_name', projected.display_name,
      'state', projected.account_state,
      'language', projected.language,
      'time_zone', projected.time_zone
    )
  from vortex_identity.list_organization_accounts_projection_internal(
    visible_organization_id, active_members_only
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
  'Registered organisation-account projection: returns every account of the organisation to a viewer the fixed accounts.read decision admits, otherwise only the active accounts with their display name and state to a live human member, with the organisation, the account identity, the account revision and the safe projected attribute values keyed by lowercase field key, or no row when neither rule admits the viewer.';
