set local role vortex_owner;

-- Narrow the directory projection to requested accounts inside the scan; both older forms delegate.
create or replace function vortex_identity.list_organization_accounts_projection_internal(
  p_organization_id uuid,
  p_active_members_only boolean,
  p_account_ids uuid[]
)
returns table (
  organization_account_id uuid,
  display_name text,
  account_state text,
  language text,
  time_zone text,
  revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  -- Two fixed visibility modes, chosen only by the Access-owned reader. The
  -- administration mode returns every account of the organisation. The member
  -- mode applies today's account-choice rule: only active accounts whose
  -- identity, organisation and tenant are active, and only the display name and
  -- state, exactly the facts any active member may already list.
  select account.organization_account_id, account.display_name, account.state,
    case when p_active_members_only then null else account.language end,
    case when p_active_members_only then null else account.time_zone end,
    account.revision
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as projection
    on projection.identity_id = account.identity_id
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where account.organization_id = p_organization_id
    and p_organization_id is not null
    and p_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and p_active_members_only is not null
    and (p_account_ids is null or account.organization_account_id = any(p_account_ids))
    and (
      not p_active_members_only
      or (
        account.state = 'active'
        and projection.state = 'active'
        and organization.state = 'active'
        and tenant.state = 'active'
      )
    )
  order by account.organization_account_id
$function$;

create or replace function vortex_identity.list_organization_accounts_projection_internal(
  p_organization_id uuid,
  p_active_members_only boolean
)
returns table (
  organization_account_id uuid,
  display_name text,
  account_state text,
  language text,
  time_zone text,
  revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select projected.*
  from vortex_identity.list_organization_accounts_projection_internal(
    p_organization_id, p_active_members_only, null
  ) as projected
$function$;

revoke all on function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean) is
  'Identity-owned set-returning safe organisation-account projection bounded to the given organisation: every account in administration mode, or only active accounts with their display name and state in member mode; identity, originating invitation and state-change evidence are never exposed, and the already-decided request scope is the only visibility.';

alter function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean) owner to vortex_owner;
grant execute on function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean) to postgres;

revoke all on function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean, uuid[]) is
  'The organisation-account projection, optionally narrowed to the given account identities inside the scan so a label lookup never materialises the whole directory; visibility is identical to the two-argument form.';

alter function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean, uuid[]) owner to vortex_owner;
grant execute on function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean, uuid[]) to postgres;

create or replace function vortex_access.list_organization_accounts_projection(
  p_record_id uuid,
  p_page_size integer,
  p_record_ids uuid[]
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
    visible_organization_id, active_members_only,
    case when p_record_ids is not null then p_record_ids
      when p_record_id is not null then array[p_record_id] end
  ) as projected
  where p_record_id is null or p_record_id = projected.organization_account_id;
end
$function$;

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
language sql
volatile
security definer
set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_organization_accounts_projection(p_record_id, p_page_size, null) as projected
$function$;

revoke all on function vortex_access.list_organization_accounts_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.list_organization_accounts_projection(
  uuid, integer
) to vortex_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_accounts_projection(uuid, integer) is
  'Registered organisation-account projection: returns every account of the organisation to a viewer the fixed accounts.read decision admits, otherwise only the active accounts with their display name and state to a live human member, with the organisation, the account identity, the account revision and the safe projected attribute values keyed by lowercase field key, or no row when neither rule admits the viewer.';

alter function vortex_access.list_organization_accounts_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;

grant execute on function vortex_access.list_organization_accounts_projection(p_record_id uuid, p_page_size integer) to postgres;

revoke all on function vortex_access.list_organization_accounts_projection(uuid, integer, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.list_organization_accounts_projection(uuid, integer, uuid[])
  to vortex_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_accounts_projection(uuid, integer, uuid[]) is
  'The registered organisation-account projection with the same visibility as the two-argument form, optionally narrowed to the given account identities inside the scan.';

alter function vortex_access.list_organization_accounts_projection(uuid, integer, uuid[]) owner to vortex_owner;

grant execute on function vortex_access.list_organization_accounts_projection(uuid, integer, uuid[]) to postgres;

create or replace function vortex_access.list_visible_person_link_labels(p_record_ids uuid[])
returns table (record_id uuid, display_name text)
language sql
volatile
security definer
set search_path = ''
as $function$
  select person.record_id, person.attribute_values ->> 'display_name'
  from vortex_access.list_organization_accounts_projection(null, null, p_record_ids) as person
  where person.record_id = any(p_record_ids)
    and pg_catalog.length(pg_catalog.btrim(person.attribute_values ->> 'display_name')) > 0
$function$;

revoke all on function vortex_access.list_visible_person_link_labels(uuid[])
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.list_visible_person_link_labels(uuid[]) to vortex_request;

comment on function vortex_access.list_visible_person_link_labels(uuid[]) is
  'Returns labels only for the requested people visible through the current viewer-permitted directory projection.';

alter function vortex_access.list_visible_person_link_labels(uuid[]) owner to vortex_owner;
grant execute on function vortex_access.list_visible_person_link_labels(uuid[]) to postgres;

reset role;
