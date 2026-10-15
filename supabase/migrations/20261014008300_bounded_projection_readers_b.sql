set local role vortex_owner;

create or replace function vortex_access.permission_projection_record_id(
  p_organization_id uuid, p_registration_kind text, p_registration_owner_id uuid,
  p_owner_kind text, p_owner_id uuid, p_permission_id uuid
)
returns uuid
language sql immutable parallel safe set search_path = ''
as $function$
  select (
    pg_catalog.substr(hash_hex, 1, 8) || '-'
    || pg_catalog.substr(hash_hex, 9, 4) || '-'
    || '8' || pg_catalog.substr(hash_hex, 14, 3) || '-'
    || pg_catalog.substr(
         '89ab',
         1 + ((pg_catalog.strpos(
           '0123456789abcdef', pg_catalog.substr(hash_hex, 17, 1)
         ) - 1) % 4),
         1
       ) || pg_catalog.substr(hash_hex, 18, 3) || '-'
    || pg_catalog.substr(hash_hex, 21, 12)
  )::uuid
  from (
    select pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        'vortex.permission_projection' || E'\x1f'
          || p_organization_id::text || E'\x1f'
          || p_registration_kind || E'\x1f'
          || p_registration_owner_id::text || E'\x1f'
          || p_owner_kind || E'\x1f'
          || p_owner_id::text || E'\x1f'
          || p_permission_id::text,
        'UTF8'
      )),
      'hex'
    ) as hash_hex
  ) as derived
$function$;

revoke all on function vortex_access.permission_projection_record_id(uuid, text, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.permission_projection_record_id(uuid, text, uuid, text, uuid, uuid)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.permission_projection_record_id(uuid, text, uuid, text, uuid, uuid)
  owner to vortex_owner;


create or replace function vortex_access.list_organization_roles_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb,
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
  sort_column text;
  keyset_sql text := '';
  order_sql text;
  after_value text;
  after_record_id uuid;
  scan_sql text;
begin
  if p_sort_key not in ('record_id', 'key', 'label', 'lifecycle')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Role projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'key' then 'role.role_key'
    when 'label' then 'role_revision.label'
    when 'lifecycle' then 'role_revision.lifecycle'
    else 'role.role_id' end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Role projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Role projection cursor is invalid';
    end;
    after_value := p_after -> 'sortKey' ->> 0;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and role.role_id > $4' else ' and role.role_id < $4' end;
    else
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", role.role_id) %s ($3 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('role.role_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s collate "C" %s, role.role_id %s',
      sort_column, case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_roles_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  scan_sql := $scan$
  select role.organization_id,
    role.role_id,
    role.live_revision,
    pg_catalog.jsonb_build_object(
      'key', role_revision.role_key,
      'label', role_revision.label,
      'lifecycle', role_revision.lifecycle,
      'role_kind', role.role_kind,
      'privilege_classification', role_revision.privilege_classification,
      'assignment_policy', role_revision.assignment_policy,
      'accepted_permission_count', (
        select pg_catalog.count(*)
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = role_revision.organization_id
          and permission.role_id = role_revision.role_id
          and permission.role_revision = role_revision.revision
      )
    )
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as role_revision
    on role_revision.organization_id = role.organization_id
    and role_revision.role_id = role.role_id
    and role_revision.revision = role.live_revision
  where role.organization_id = $1
    and ($2 is null or role.role_id = any($2))
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $5', order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_value, after_record_id, p_limit;
end
$function$;

create or replace function vortex_access.list_organization_roles_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_organization_roles_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer)
  owner to vortex_owner;

revoke all on function vortex_access.list_organization_roles_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.list_organization_roles_projection(
  uuid, integer
) to vortex_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_roles_projection(uuid, integer) is
  'Registered role projection with the original record-id ordering and visibility; delegates to the bounded reader.';

alter function vortex_access.list_organization_roles_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;

grant execute on function vortex_access.list_organization_roles_projection(p_record_id uuid, p_page_size integer) to postgres;


create or replace function vortex_access.list_organization_permissions_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb,
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
  after_record_id uuid;
  record_id_sql text := 'vortex_access.permission_projection_record_id('
    || 'entry.organization_id, entry.registration_kind, entry.registration_owner_id, '
    || 'entry.owner_kind, entry.owner_id, entry.permission_id)';
  keyset_sql text := '';
  scan_sql text;
begin
  if p_sort_key is distinct from 'record_id'
    or p_direction not in ('ascending', 'descending')
    or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Permission projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Permission projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Permission projection cursor is invalid';
    end;
    keyset_sql := pg_catalog.format(' and %s %s $3', record_id_sql,
      case when p_direction = 'ascending' then '>' else '<' end);
  end if;
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_permissions_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  scan_sql := $scan$
    select entry.organization_id,
      vortex_access.permission_projection_record_id(
        entry.organization_id, entry.registration_kind, entry.registration_owner_id,
        entry.owner_kind, entry.owner_id, entry.permission_id
      ),
      entry.registration_revision,
      pg_catalog.jsonb_build_object(
        'key', entry.permission_key,
        'label', entry.label,
        'description', entry.description,
        'owner_kind', entry.owner_kind,
        'action_kind', entry.action_kind,
        'named_action', entry.named_action,
        'administrative', entry.administrative
      )
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
    where entry.organization_id = $1
      and registration.state = 'active'
      and ($2 is null or vortex_access.permission_projection_record_id(
        entry.organization_id, entry.registration_kind, entry.registration_owner_id,
        entry.owner_kind, entry.owner_id, entry.permission_id
      ) = any($2))
  $scan$ || keyset_sql || pg_catalog.format(' order by %s %s limit $4',
    record_id_sql, case when p_direction = 'ascending' then 'asc' else 'desc' end);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_record_id, p_limit;
end
$function$;

create or replace function vortex_access.list_organization_permissions_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_organization_permissions_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer)
  owner to vortex_owner;


revoke all on function vortex_access.list_organization_permissions_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.list_organization_permissions_projection(
  uuid, integer
) to vortex_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_permissions_projection(uuid, integer) is
  'Registered permission projection with the original record-id ordering and visibility; delegates to the bounded reader.';

alter function vortex_access.list_organization_permissions_projection(uuid, integer)
  owner to vortex_owner;


create or replace function vortex_access.list_organization_delegations_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb, p_limit integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
  sort_column text;
  sort_expression text;
  sort_type text;
  order_sql text;
  keyset_sql text := '';
  after_value text;
  after_record_id uuid;
  scan_sql text;
begin
  if p_sort_key not in ('record_id', 'scope_kind', 'starts_at', 'expires_at', 'state')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Delegation projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'scope_kind' then 'delegation.scope_kind'
    when 'starts_at' then 'delegation.starts_at'
    when 'expires_at' then 'delegation.expires_at'
    when 'state' then 'delegation.state'
    else 'delegation.delegation_authority_id' end;
  sort_type := case when p_sort_key in ('starts_at', 'expires_at')
    then 'timestamptz' else 'text' end;
  sort_expression := case when sort_type = 'text'
    then sort_column || ' collate "C"' else sort_column end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) not in ('string', 'null')
      )) then
      raise exception using errcode = '22023', message = 'Delegation projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_value := p_after -> 'sortKey' ->> 0;
      if sort_type = 'timestamptz' and after_value is not null then
        perform after_value::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Delegation projection cursor is invalid';
    end;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and delegation.delegation_authority_id > $4'
        else ' and delegation.delegation_authority_id < $4' end;
    elsif p_direction = 'ascending' then
      keyset_sql := case when after_value is null
        then pg_catalog.format(
          ' and (%s is not null or (%s is null and delegation.delegation_authority_id > $4))',
          sort_column, sort_column)
        else pg_catalog.format(
          ' and (%s, delegation.delegation_authority_id) > ($3::%s, $4)',
          sort_expression, sort_type) end;
    else
      keyset_sql := case when after_value is null
        then pg_catalog.format(
          ' and %s is null and delegation.delegation_authority_id < $4', sort_column)
        else pg_catalog.format(
          ' and (%s is null or %s < $3::%s or (%s = $3::%s and delegation.delegation_authority_id < $4))',
          sort_column, sort_expression, sort_type, sort_expression, sort_type) end;
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('delegation.delegation_authority_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s %s nulls %s, delegation.delegation_authority_id %s',
      sort_expression, case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'first' else 'last' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;

  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  scan_sql := $scan$
    select delegation.organization_id, delegation.delegation_authority_id,
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
          when delegation.starts_at > $5 then 'scheduled'
          when delegation.expires_at is not null
            and delegation.expires_at <= $5 then 'expired'
          else 'active' end)
    from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id = $1
      and ($2 is null or delegation.delegation_authority_id = any($2))
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_value, after_record_id, checked_at, p_limit;
end
$function$;

create or replace function vortex_access.list_organization_delegations_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_organization_delegations_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_access.list_organization_delegations_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_delegations_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_delegations_projection(uuid[], text, text, jsonb, integer)
  owner to vortex_owner;

revoke all on function vortex_access.list_organization_delegations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_delegations_projection(uuid, integer)
  to vortex_owner, vortex_record_adapter, postgres;
comment on function vortex_access.list_organization_delegations_projection(uuid, integer) is
  'Registered delegation projection with the original record-id ordering and visibility; delegates to the bounded reader.';
alter function vortex_access.list_organization_delegations_projection(uuid, integer)
  owner to vortex_owner;


create or replace function vortex_access.list_organization_runtime_settings_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb,
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
  settings_row record;
  settings_default_application_root_id uuid;
  settings_extension_values jsonb;
begin
  if p_sort_key is distinct from 'record_id'
    or p_direction not in ('ascending', 'descending')
    or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Runtime settings projection bounds are invalid';
  end if;
  if p_after is not null and (
    pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
  ) then
    raise exception using errcode = '22023', message = 'Runtime settings projection cursor is invalid';
  end if;
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- runtime-settings read decision the bespoke reader applies decides whether
  -- any row exists at all, and the caller's current organisation is never an
  -- input. A viewer the decision refuses sees no row, exactly as a missing or
  -- foreign record, so the record adapters return their identical refusal and
  -- a list page is empty rather than failing. The record identity is the
  -- organisation, whose settings are a single row, and the revision is the
  -- settings document's own revision, which the default application shares.
  -- Attribute names are the lowercase field keys a projection record type
  -- declares.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_runtime_settings_administration_read_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  select result.* into settings_row
  from vortex_identity.read_current_organization_runtime_settings_internal(
    scope_row.organization_id
  ) as result;
  if settings_row.organization_id is null
    or settings_row.organization_id is distinct from scope_row.organization_id then
    return;
  end if;
  if p_record_ids is not null
    and not (settings_row.organization_id = any(p_record_ids)) then
    return;
  end if;
  if p_after is not null then
    begin
      if (p_direction = 'ascending'
          and settings_row.organization_id <= (p_after ->> 'recordId')::uuid)
        or (p_direction = 'descending'
          and settings_row.organization_id >= (p_after ->> 'recordId')::uuid) then
        return;
      end if;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Runtime settings projection cursor is invalid';
    end;
  end if;
  select settings.default_application_root_id, settings.extension_values
  into settings_default_application_root_id, settings_extension_values
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = settings_row.organization_id;
  return query select
    settings_row.organization_id,
    settings_row.organization_id,
    settings_row.revision,
    coalesce(settings_extension_values, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'language', settings_row.language,
      'time_zone', settings_row.time_zone,
      'currency', settings_row.currency,
      'date_format', settings_row.date_format,
      'number_format', settings_row.number_format,
      'default_application_root_id', settings_default_application_root_id
    );
end
$function$;

create or replace function vortex_access.list_organization_runtime_settings_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_organization_runtime_settings_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_access.list_organization_runtime_settings_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_runtime_settings_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_runtime_settings_projection(uuid[], text, text, jsonb, integer)
  owner to vortex_owner;

revoke all on function vortex_access.list_organization_runtime_settings_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.list_organization_runtime_settings_projection(
  uuid, integer
) to vortex_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_runtime_settings_projection(uuid, integer) is
  'Registered runtime-settings projection with the original single-row visibility; delegates to the bounded reader.';

alter function vortex_access.list_organization_runtime_settings_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;

grant execute on function vortex_access.list_organization_runtime_settings_projection(p_record_id uuid, p_page_size integer) to postgres;


create index organization_roles_projection_key_idx on vortex_access.organization_roles (organization_id, role_key collate "C", role_id);

create index organization_role_revisions_projection_label_idx on vortex_access.organization_role_revisions (organization_id, label collate "C", role_id);

create index organization_role_revisions_projection_lifecycle_idx on vortex_access.organization_role_revisions (organization_id, lifecycle collate "C", role_id);

create index organization_delegations_projection_scope_idx on vortex_access.organization_delegation_authorities (organization_id, scope_kind collate "C", delegation_authority_id);

create index organization_delegations_projection_starts_idx on vortex_access.organization_delegation_authorities (organization_id, starts_at, delegation_authority_id);

create index organization_delegations_projection_expires_idx on vortex_access.organization_delegation_authorities (organization_id, expires_at, delegation_authority_id);

create index organization_delegations_projection_state_idx on vortex_access.organization_delegation_authorities (organization_id, state collate "C", delegation_authority_id);

create index permission_catalogue_projection_record_idx on vortex_access.permission_catalogue_entries (organization_id, vortex_access.permission_projection_record_id(organization_id, registration_kind, registration_owner_id, owner_kind, owner_id, permission_id));

reset role;
