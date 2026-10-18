create or replace function vortex_access.list_organization_accounts_projection(
  p_record_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
  p_limit integer
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
    visible_organization_id, active_members_only, p_record_ids,
    p_sort_key, p_direction, p_after, p_limit
  ) as projected;
end
$function$;

revoke all on function vortex_access.list_organization_accounts_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_accounts_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_accounts_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;
