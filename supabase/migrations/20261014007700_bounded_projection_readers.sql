set local role vortex_owner;

create index organization_accounts_display_name_sort_idx
  on vortex_identity.organization_accounts
  (organization_id, display_name collate "C" asc nulls first, organization_account_id asc);
create index organization_accounts_state_sort_idx
  on vortex_identity.organization_accounts
  (organization_id, state collate "C" asc nulls first, organization_account_id asc);

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
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
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

create or replace function vortex_access.list_organization_accounts_projection(
  p_record_id uuid, p_page_size integer, p_record_ids uuid[]
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_organization_accounts_projection(
    case when p_record_ids is not null then p_record_ids
      when p_record_id is not null then array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
  where p_record_id is null or p_record_id = projected.record_id
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

revoke all on function vortex_access.list_organization_accounts_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_accounts_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_accounts_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;

create or replace function vortex_access.list_organization_activity_entries_projection(
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
  checked_context jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  actor_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean;
  after_occurred_at timestamptz;
  after_record_id uuid;
  keyset_sql text := '';
  base_sql text;
  source_sql text;
  order_sql text;
  scan_sql text;
begin
  if p_sort_key <> 'occurred_at' or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or p_limit is null or p_limit < 1 then
    raise exception using errcode = '22023', message = 'Activity projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) <> 'string'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Activity projection cursor is invalid';
    end if;
    begin
      after_occurred_at := (p_after -> 'sortKey' ->> 0)::timestamptz;
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Activity projection cursor is invalid';
    end;
    keyset_sql := case when p_direction = 'descending'
      then ' and (entry.occurred_at, entry.activity_id) < ($6, $7)'
      else ' and (entry.occurred_at, entry.activity_id) > ($6, $7)' end;
  end if;
  begin
    checked_context := vortex_access.validated_human_request_context();
    visible_organization_id := (checked_context ->> 'organizationId')::uuid;
    actor_identity_id := (checked_context ->> 'identityId')::uuid;
    actor_account_id := (checked_context ->> 'organizationAccountId')::uuid;
    perform 1 from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    );
  exception
    when insufficient_privilege or no_data_found then
      return;
  end;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.permissions.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        'platform.organization.permissions.read'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = visible_organization_id
      and decision_account_id = actor_account_id,
    false
  );

  order_sql := pg_catalog.format(
    ' order by entry.occurred_at %s, entry.activity_id %s limit $8',
    case when p_direction = 'descending' then 'desc' else 'asc' end,
    case when p_direction = 'descending' then 'desc' else 'asc' end
  );
  base_sql := $scan$select entry.*
    from vortex_record.organization_activity_entries as entry
    where entry.organization_id = $1
      and entry.occurred_at >= pg_catalog.statement_timestamp() - interval '90 days'
      and ($2 is null or entry.activity_id = any($2))$scan$;
  if audit_projection then
    source_sql := base_sql || keyset_sql || order_sql;
  else
    source_sql := 'select visible.* from (('
      || base_sql
      || ' and entry.actor_kind = ''organization_account'' and entry.actor_id = $4'
      || keyset_sql || order_sql
      || ') union all ('
      || base_sql
      || ' and entry.actor_kind = ''identity'' and entry.actor_id = $5'
      || keyset_sql || order_sql
      || ')) as visible'
      || pg_catalog.format(' order by visible.occurred_at %s, visible.activity_id %s limit $8',
        case when p_direction = 'descending' then 'desc' else 'asc' end,
        case when p_direction = 'descending' then 'desc' else 'asc' end);
  end if;
  scan_sql := $scan$select
    entry.organization_id,
    entry.activity_id,
    1::bigint,
    pg_catalog.jsonb_build_object(
      'organization_id', entry.organization_id::text,
      'revision', 1,
      'occurred_at', entry.occurred_at,
      'actor_kind', case entry.actor_kind
        when 'organization_account' then 'Person'
        when 'identity' then 'Platform operator'
        when 'system' then 'System'
        when 'public_session' then 'Public visitor'
        else 'Other' end,
      'actor', case when entry.actor_kind = 'organization_account'
        then pg_catalog.jsonb_build_object('organizationAccountId', entry.actor_id::text)
        else null end,
      'action', entry.action,
      'subject_count', pg_catalog.cardinality(entry.subject_ids),
      'changed_field_count', case when $3
        then pg_catalog.cardinality(entry.changed_field_ids) else null end
    )
  from ($scan$ || source_sql || $scan$) as entry$scan$
    || pg_catalog.format(' order by entry.occurred_at %s, entry.activity_id %s',
      case when p_direction = 'descending' then 'desc' else 'asc' end,
      case when p_direction = 'descending' then 'desc' else 'asc' end);
  return query execute scan_sql using visible_organization_id, p_record_ids,
    audit_projection, actor_account_id, actor_identity_id,
    after_occurred_at, after_record_id, p_limit;
end
$function$;

create or replace function vortex_access.list_organization_activity_entries_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_organization_activity_entries_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'occurred_at', 'descending', null, 1000
  ) as projected
$function$;

revoke all on function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;

revoke all on function vortex_access.list_organization_activity_entries_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_activity_entries_projection(uuid, integer)
  to vortex_owner, vortex_record_adapter;
comment on function vortex_access.list_organization_activity_entries_projection(uuid, integer) is
  'Recent organisation activity projection; own rows or the existing permissions-read audit view, with counts and no payload or identifier lists.';
alter function vortex_access.list_organization_activity_entries_projection(uuid, integer)
  owner to vortex_owner;
grant execute on function vortex_access.list_organization_activity_entries_projection(uuid, integer)
  to postgres;

reset role;
