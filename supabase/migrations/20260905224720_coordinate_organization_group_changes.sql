create function vortex_access.coordinate_organization_group_change(
  p_operation text,
  p_organization_id uuid,
  p_group_id uuid,
  p_expected_group_revision bigint,
  p_group_key text,
  p_label text,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  group_id uuid,
  group_key text,
  label text,
  state text,
  revision bigint,
  created_by_actor_id uuid,
  created_at timestamptz,
  changed_by_actor_id uuid,
  changed_at timestamptz,
  change_correlation_id uuid,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  current_group vortex_access.organization_groups%rowtype;
  next_access_version bigint;
  operation_at timestamptz;
begin
  if p_operation is null
    or p_operation not in ('create_group', 'revise_group_label', 'retire_group')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group change input is invalid';
  end if;

  if p_operation = 'create_group' then
    if p_expected_group_revision is not null
      or p_group_key is null
      or pg_catalog.char_length(p_group_key) not between 1 and 40
      or p_group_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or p_label is null
      or p_label <> pg_catalog.btrim(p_label)
      or pg_catalog.char_length(p_label) not between 1 and 60 then
      raise exception using errcode = '22023',
        message = 'Organization Group creation input is invalid';
    end if;
  elsif p_operation = 'revise_group_label' then
    if p_expected_group_revision is null
      or p_expected_group_revision not between 1 and 9007199254740991
      or p_group_key is not null
      or p_label is null
      or p_label <> pg_catalog.btrim(p_label)
      or pg_catalog.char_length(p_label) not between 1 and 60 then
      raise exception using errcode = '22023',
        message = 'Organization Group label revision input is invalid';
    end if;
  elsif p_expected_group_revision is null
    or p_expected_group_revision not between 1 and 9007199254740991
    or p_group_key is not null
    or p_label is not null then
    raise exception using errcode = '22023',
      message = 'Organization Group retirement input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization Group change scope is unavailable';
  end if;

  if p_operation = 'create_group' then
    if exists (
      select 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = p_group_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization Group creation is stale or unavailable';
    end if;

    operation_at := pg_catalog.clock_timestamp();
    insert into vortex_access.organization_groups (
      organization_id, group_id, group_key, label, state, revision,
      created_by, created_at, changed_by, changed_at, change_correlation_id
    ) values (
      p_organization_id, p_group_id, p_group_key, p_label, 'active', 1,
      p_changed_by, operation_at, p_changed_by, operation_at, p_correlation_id
    );
  else
    select organization_group.*
    into current_group
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = p_organization_id
      and organization_group.group_id = p_group_id
    for update;

    if not found
      or current_group.revision <> p_expected_group_revision
      or current_group.state <> 'active' then
      raise exception using errcode = '40001',
        message = 'Organization Group change is stale or unavailable';
    end if;

    if p_operation = 'revise_group_label'
      and current_group.label is not distinct from p_label then
      raise exception using errcode = '40001',
        message = 'Organization Group label is unchanged';
    end if;

    if current_group.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization Group revision is exhausted';
    end if;

    operation_at := greatest(
      current_group.changed_at,
      pg_catalog.clock_timestamp()
    );
    update vortex_access.organization_groups as organization_group
    set label = case
        when p_operation = 'revise_group_label' then p_label
        else current_group.label
      end,
      state = case
        when p_operation = 'retire_group' then 'retired'
        else current_group.state
      end,
      revision = current_group.revision + 1,
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id
    where organization_group.organization_id = p_organization_id
      and organization_group.group_id = p_group_id
      and organization_group.revision = p_expected_group_revision
      and organization_group.state = 'active';
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization Group change is stale or unavailable';
    end if;
  end if;

  select version.current_version
  into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'team_membership_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation, organization_group.organization_id,
    organization_group.group_id, organization_group.group_key,
    organization_group.label, organization_group.state,
    organization_group.revision, organization_group.created_by,
    organization_group.created_at, organization_group.changed_by,
    organization_group.changed_at, organization_group.change_correlation_id,
    next_access_version, p_correlation_id
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = p_organization_id
    and organization_group.group_id = p_group_id;
end
$function$;

revoke execute on function
  vortex_access.coordinate_organization_group_change(
    text, uuid, uuid, bigint, text, text, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_organization_group_change(
  text, uuid, uuid, bigint, text, text, uuid, uuid
) is
  'Owner-only atomic Group creation, label revision or terminal retirement. It changes Access once but grants no caller authority.';
