create or replace function vortex_identity.list_organization_accounts_projection_internal(
  p_organization_id uuid,
  p_active_members_only boolean,
  p_account_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
  p_limit integer
)
returns table (
  organization_account_id uuid,
  display_name text,
  account_state text,
  language text,
  time_zone text,
  revision bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_value text;
  after_record_id uuid;
  scan_sql text;
begin
  if p_sort_key not in ('record_id', 'display_name', 'state')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Account projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'display_name' then 'account.display_name'
    when 'state' then 'account.state'
    else 'account.organization_account_id' end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') <> 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') <> 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) not in ('string', 'null')
      )) then
      raise exception using errcode = '22023', message = 'Account projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Account projection cursor is invalid';
    end;
    after_value := p_after -> 'sortKey' ->> 0;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and account.organization_account_id > $6'
        else ' and account.organization_account_id < $6' end;
    elsif p_direction = 'ascending' then
      keyset_sql := case when after_value is null
        then pg_catalog.format(
          ' and (%s is not null or (%s is null and account.organization_account_id > $6))',
          sort_column, sort_column
        )
        else pg_catalog.format(
          ' and (%s collate "C", account.organization_account_id) > ($5 collate "C", $6)',
          sort_column
        ) end;
    else
      keyset_sql := case when after_value is null
        then pg_catalog.format(' and %s is null and account.organization_account_id < $6', sort_column)
        else pg_catalog.format(
          ' and (%s is null or (%s collate "C") < ($5 collate "C") or (%s = $5 and account.organization_account_id < $6))',
          sort_column, sort_column, sort_column
        ) end;
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('account.organization_account_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s collate "C" %s nulls %s, account.organization_account_id %s',
      sort_column, case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'first' else 'last' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;
  scan_sql := $scan$
  -- Two fixed visibility modes, chosen only by the Access-owned reader. The
  -- administration mode returns every account of the organisation. The member
  -- mode applies today's account-choice rule: only active accounts whose
  -- identity, organisation and tenant are active, and only the display name and
  -- state, exactly the facts any active member may already list.
  select account.organization_account_id, account.display_name, account.state,
    case when $2 then null else account.language end,
    case when $2 then null else account.time_zone end,
    account.revision
  from vortex_identity.organization_accounts as account
  where account.organization_id = $1
    and $1 is not null
    and $1 <> '00000000-0000-0000-0000-000000000000'::uuid
    and $2 is not null
    and ($3 is null or account.organization_account_id = any($3))
    and (select case when $2 then projection.state = 'active' else true end
         from vortex_identity.identity_projections as projection
         where projection.identity_id = account.identity_id) is true
    and (
      not $2
      or (
        account.state = 'active'
        and (select organization.state = 'active' and tenant.state = 'active'
             from vortex_identity.organizations as organization
             join vortex_identity.tenants as tenant
               on tenant.tenant_id = organization.tenant_id
             where organization.organization_id = $1) is true
      )
    )
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $4', order_sql);
  return query execute scan_sql using p_organization_id, p_active_members_only,
    p_account_ids, p_limit, after_value, after_record_id;
end
$function$;

create or replace function vortex_identity.list_organization_accounts_projection_internal(
  p_organization_id uuid, p_active_members_only boolean, p_account_ids uuid[]
)
returns table (
  organization_account_id uuid, display_name text, account_state text,
  language text, time_zone text, revision bigint
)
language sql stable security definer set search_path = ''
as $function$
  select projected.*
  from vortex_identity.list_organization_accounts_projection_internal(
    p_organization_id, p_active_members_only, p_account_ids,
    'record_id', 'ascending', null, null
  ) as projected
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

revoke all on function vortex_identity.list_organization_accounts_projection_internal(
  uuid, boolean, uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_organization_accounts_projection_internal(
  uuid, boolean, uuid[], text, text, jsonb, integer
) to vortex_owner, postgres;
alter function vortex_identity.list_organization_accounts_projection_internal(
  uuid, boolean, uuid[], text, text, jsonb, integer
) owner to vortex_owner;
