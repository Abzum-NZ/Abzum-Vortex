set local role vortex_owner;

create index tenant_admin_assignments_active_tenant_identity_idx
  on vortex_identity.tenant_administrator_assignments (tenant_id, identity_id)
  where revoked_at is null;
create index tenants_short_name_projection_sort_idx
  on vortex_identity.tenants (short_name collate "C", tenant_id);
create index tenants_display_name_projection_sort_idx
  on vortex_identity.tenants (display_name collate "C", tenant_id);
create index tenants_state_projection_sort_idx
  on vortex_identity.tenants (state collate "C", tenant_id);
create index tenants_state_changed_projection_sort_idx
  on vortex_identity.tenants (state_changed_at, tenant_id);
create index tenants_created_projection_sort_idx
  on vortex_identity.tenants (created_at, tenant_id);
create index organizations_short_name_projection_sort_idx
  on vortex_identity.organizations (tenant_id, short_name collate "C", organization_id);
create index organizations_display_name_projection_sort_idx
  on vortex_identity.organizations (tenant_id, display_name collate "C", organization_id);
create index organizations_state_projection_sort_idx
  on vortex_identity.organizations (tenant_id, state collate "C", organization_id);
create index organizations_state_changed_projection_sort_idx
  on vortex_identity.organizations (tenant_id, state_changed_at, organization_id);
create index organizations_created_projection_sort_idx
  on vortex_identity.organizations (tenant_id, created_at, organization_id);
create index tenant_admin_assignments_starts_projection_sort_idx
  on vortex_identity.tenant_administrator_assignments
  (tenant_id, starts_at, assignment_id);
create index tenant_admin_assignments_expires_projection_sort_idx
  on vortex_identity.tenant_administrator_assignments
  (tenant_id, expires_at, assignment_id);

create or replace function vortex_identity.list_tenants_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  is_super_administrator boolean;
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
begin
  if p_sort_key not in ('record_id', 'short_name', 'display_name', 'state',
      'state_changed_at', 'created_at')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Tenant projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Tenant projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if p_sort_key in ('state_changed_at', 'created_at') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Tenant projection cursor is invalid';
    end;
  end if;

  begin
    context_value := vortex_access.validated_human_request_context();
  exception when insufficient_privilege then
    return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  is_super_administrator :=
    vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
      actor_identity_id, evaluated_at
    ) is not null;

  sort_column := case p_sort_key
    when 'short_name' then 'tenant.short_name'
    when 'display_name' then 'tenant.display_name'
    when 'state' then 'tenant.state'
    when 'state_changed_at' then 'tenant.state_changed_at'
    when 'created_at' then 'tenant.created_at'
    else 'tenant.tenant_id' end;
  if p_after is not null then
    if p_sort_key = 'record_id' then
      keyset_sql := pg_catalog.format(' and tenant.tenant_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif p_sort_key in ('short_name', 'display_name', 'state') then
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", tenant.tenant_id) %s ($3 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    else
      keyset_sql := pg_catalog.format(
        ' and (%s, tenant.tenant_id) %s ($5, $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  order_sql := pg_catalog.format('%s%s %s, tenant.tenant_id %s',
    sort_column,
    case when p_sort_key in ('short_name', 'display_name', 'state')
      then ' collate "C"' else '' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end);
  return query execute $scan$
    select $1, tenant.tenant_id, tenant.revision,
      pg_catalog.jsonb_build_object(
        'short_name', tenant.short_name,
        'display_name', tenant.display_name,
        'state', tenant.state,
        'state_changed_at', tenant.state_changed_at,
        'created_at', tenant.created_at
      )
    from vortex_identity.tenants as tenant
    where tenant.state = 'active'
      and ($2 is null or tenant.tenant_id = any($2))
      and ($7 or exists (
        select 1 from vortex_identity.tenant_administrator_assignments as assignment
        where assignment.tenant_id = tenant.tenant_id
          and assignment.identity_id = $8
          and assignment.revoked_at is null
          and assignment.starts_at <= $9
          and (assignment.expires_at is null or assignment.expires_at > $9)
      ))
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql)
  using visible_organization_id, p_record_ids, after_text, after_record_id,
    after_time, p_limit, is_super_administrator, actor_identity_id, evaluated_at;
end
$function$;

create or replace function vortex_identity.list_tenants_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.* from vortex_identity.list_tenants_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_identity.list_tenants_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_tenants_projection(uuid, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_identity.list_tenants_projection(uuid, integer) owner to vortex_owner;

revoke all on function vortex_identity.list_tenants_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_tenants_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_identity.list_tenants_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;

create or replace function vortex_identity.list_organizations_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_tenant_id uuid;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
begin
  if p_sort_key not in ('record_id', 'short_name', 'display_name', 'state',
      'state_changed_at', 'created_at')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Organisation projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Organisation projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if p_sort_key in ('state_changed_at', 'created_at') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Organisation projection cursor is invalid';
    end;
  end if;

  begin
    context_value := vortex_access.validated_human_request_context();
  exception when insufficient_privilege then
    return;
  end;
  visible_tenant_id := (context_value ->> 'tenantId')::uuid;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_tenant_id::text)
    or not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id, visible_tenant_id, 'platform.tenant.hierarchy.read', evaluated_at
    );
  exception when sqlstate 'V3101' then
    return;
  end;

  sort_column := case p_sort_key
    when 'short_name' then 'organization.short_name'
    when 'display_name' then 'organization.display_name'
    when 'state' then 'organization.state'
    when 'state_changed_at' then 'organization.state_changed_at'
    when 'created_at' then 'organization.created_at'
    else 'organization.organization_id' end;
  if p_after is not null then
    if p_sort_key = 'record_id' then
      keyset_sql := pg_catalog.format(' and organization.organization_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif p_sort_key in ('short_name', 'display_name', 'state') then
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", organization.organization_id) %s ($7 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    else
      keyset_sql := pg_catalog.format(
        ' and (%s, organization.organization_id) %s ($5, $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  order_sql := pg_catalog.format('%s%s %s, organization.organization_id %s',
    sort_column,
    case when p_sort_key in ('short_name', 'display_name', 'state')
      then ' collate "C"' else '' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end);
  return query execute $scan$
    select $1, organization.organization_id, organization.revision,
      pg_catalog.jsonb_build_object(
        'tenant_id', organization.tenant_id,
        'parent_organization_id', organization.parent_organization_id,
        'short_name', organization.short_name,
        'display_name', organization.display_name,
        'state', organization.state,
        'state_changed_at', organization.state_changed_at,
        'created_at', organization.created_at
      )
    from vortex_identity.organizations as organization
    where organization.tenant_id = $2
      and ($3 is null or organization.organization_id = any($3))
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql)
  using visible_organization_id, visible_tenant_id, p_record_ids,
    after_record_id, after_time, p_limit, after_text;
end
$function$;

create or replace function vortex_identity.list_organizations_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.* from vortex_identity.list_organizations_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_identity.list_organizations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_organizations_projection(uuid, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_identity.list_organizations_projection(uuid, integer) owner to vortex_owner;

revoke all on function vortex_identity.list_organizations_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_organizations_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_identity.list_organizations_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;

create or replace function vortex_identity.list_tenant_administrators_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_tenant_id uuid;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
begin
  if p_sort_key not in ('record_id', 'starts_at', 'expires_at', 'state')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023',
      message = 'Tenant administrator projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) not in ('string', 'null')
      )) then
      raise exception using errcode = '22023',
        message = 'Tenant administrator projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if p_sort_key in ('starts_at', 'expires_at') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023',
        message = 'Tenant administrator projection cursor is invalid';
    end;
    if p_sort_key <> 'expires_at' and p_sort_key <> 'record_id'
      and after_text is null then
      raise exception using errcode = '22023',
        message = 'Tenant administrator projection cursor is invalid';
    end if;
  end if;

  begin
    context_value := vortex_access.validated_human_request_context();
  exception when insufficient_privilege then
    return;
  end;
  visible_tenant_id := (context_value ->> 'tenantId')::uuid;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_tenant_id::text)
    or not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id, visible_tenant_id,
      'platform.tenant.administrators.read', evaluated_at
    );
  exception when sqlstate 'V3101' then
    return;
  end;

  sort_column := case p_sort_key
    when 'starts_at' then 'assignment.starts_at'
    when 'expires_at' then 'assignment.expires_at'
    -- Older published releases may still forward this derived, unindexed sort.
    when 'state' then $state$case
      when assignment.revoked_at is not null
        and assignment.revoked_at <= $8 then 'revoked'
      when assignment.starts_at > $8 then 'scheduled'
      when assignment.expires_at is not null
        and assignment.expires_at <= $8 then 'expired'
      else 'active' end$state$
    else 'assignment.assignment_id' end;
  if p_after is not null then
    if p_sort_key = 'record_id' then
      keyset_sql := pg_catalog.format(' and assignment.assignment_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif p_sort_key = 'state' then
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", assignment.assignment_id) %s ($7 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    elsif p_sort_key = 'starts_at' then
      keyset_sql := pg_catalog.format(
        ' and (assignment.starts_at, assignment.assignment_id) %s ($5, $4)',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif after_time is null then
      keyset_sql := case when p_direction = 'ascending'
        then ' and assignment.expires_at is null and assignment.assignment_id > $4'
        else ' and (assignment.expires_at is not null or
          (assignment.expires_at is null and assignment.assignment_id < $4))'
        end;
    elsif p_direction = 'ascending' then
      keyset_sql := ' and ((assignment.expires_at, assignment.assignment_id) > ($5, $4)
        or assignment.expires_at is null)';
    else
      keyset_sql := ' and (assignment.expires_at, assignment.assignment_id) < ($5, $4)';
    end if;
  end if;
  order_sql := pg_catalog.format('%s%s %s, assignment.assignment_id %s',
    sort_column, case when p_sort_key = 'state' then ' collate "C"' else '' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end);
  return query execute $scan$
    select $1, assignment.assignment_id, assignment.revision,
      pg_catalog.jsonb_build_object(
        'tenant_id', assignment.tenant_id,
        'identity_id', assignment.identity_id,
        'capability_keys', assignment.capability_keys,
        'starts_at', assignment.starts_at,
        'expires_at', assignment.expires_at,
        'state', case
          when assignment.revoked_at is not null
            and assignment.revoked_at <= $8 then 'revoked'
          when assignment.starts_at > $8 then 'scheduled'
          when assignment.expires_at is not null
            and assignment.expires_at <= $8 then 'expired'
          else 'active'
        end
      )
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.tenant_id = $2
      and ($3 is null or assignment.assignment_id = any($3))
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql)
  using visible_organization_id, visible_tenant_id, p_record_ids,
    after_record_id, after_time, p_limit, after_text, evaluated_at;
end
$function$;

create or replace function vortex_identity.list_tenant_administrators_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.* from vortex_identity.list_tenant_administrators_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_identity.list_tenant_administrators_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_tenant_administrators_projection(uuid, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_identity.list_tenant_administrators_projection(uuid, integer)
  owner to vortex_owner;

revoke all on function vortex_identity.list_tenant_administrators_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_tenant_administrators_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_identity.list_tenant_administrators_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;


reset role;
