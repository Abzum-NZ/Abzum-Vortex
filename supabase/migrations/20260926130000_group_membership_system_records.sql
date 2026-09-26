-- Groups and memberships as system records (#1032).
--
-- A system projection record type is a read-only projection over protected core
-- storage: its typed fields project one registered protected view, it has no
-- ordinary create, update, delete or restore path, and every change goes through
-- a named protected operation. This migration registers the group and
-- group-membership projections and their readers, so the ordinary query path
-- reads them exactly as the #1030 organisation runtime-settings projection and
-- the #1031 person and organisation-invitation projections are read.
--
-- Row visibility stays inside each registered reader and follows today's rules.
-- Both the group and the group-membership projection apply the fixed
-- platform.organization.groups.read decision the bespoke Access administration
-- readers already apply, exactly as the organisation-group and group-membership
-- administration list and detail readers do. The readers are registered in the
-- closed vortex_record.protected_read_model_views registry, so storage
-- provisioning can only ever catalogue them under their exact declared key: the
-- group projection under `groups` and the group-membership projection under the
-- `people` read model whose owning reader is the group-membership list. The
-- group-membership projection lists every membership of the organisation
-- (current, scheduled, expired and revoked); the query engine narrows a single
-- group's members by the record type's declared group_id filter. Grant,
-- revocation and change evidence are never projected.

begin;

-- ============================================================================
-- Group projection reader. One reader per protected read-model key, applying
-- that read model's own visibility and returning the organisation, the
-- projected row identity, the projected revision and the projected safe
-- attribute values for the current viewer.
-- ============================================================================

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

-- ============================================================================
-- Group-membership projection reader. The registered key is the `people`
-- protected read model, whose owning reader is the group-membership list.
-- ============================================================================

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

-- ============================================================================
-- Register both readers under their exact closed keys, so a projection record
-- type can only ever be catalogued against the reader registered here. The
-- registry is owned by vortex_record_owner, whose policy is the only write
-- path, so the rows are inserted as that role.
-- ============================================================================

set local role vortex_record_owner;

insert into vortex_record.protected_read_model_views (
  protected_read_model_key, reader_schema, reader_function
) values
  ('groups', 'vortex_access', 'list_organization_groups_projection'),
  ('people', 'vortex_access', 'list_organization_group_memberships_projection');

reset role;

commit;
