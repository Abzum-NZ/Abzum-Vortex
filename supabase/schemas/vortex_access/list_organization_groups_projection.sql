create or replace function vortex_access.list_organization_groups_projection(
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
  -- platform.organization.groups.read decision the bespoke administration
  -- reader applies is the only visibility, and the caller's current organisation
  -- is never an input. A viewer the decision refuses sees no rows, exactly as a
  -- missing or foreign record, so the record adapters return their identical
  -- refusal and a list page is empty rather than failing. The record identity is
  -- the group, the revision is the group's own revision and the attribute names
  -- are the lowercase field keys a projection record type declares. Group
  -- identity, key, label and state are the only facts projected; change evidence
  -- stays in the protected storage.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_groups_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  return query
  select
    scope_row.organization_id,
    organization_group.group_id,
    organization_group.revision,
    pg_catalog.jsonb_build_object(
      'key', organization_group.group_key,
      'label', organization_group.label,
      'state', organization_group.state
    )
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = scope_row.organization_id
    and (p_record_id is null or p_record_id = organization_group.group_id)
  order by organization_group.group_id;
end
$function$;

revoke all on function vortex_access.list_organization_groups_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_groups_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_groups_projection(uuid, integer) is
  'Registered group projection: returns every group of the current viewer''s organisation under the fixed platform.organization.groups.read decision, with the organisation, the group identity, the group revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer.';
