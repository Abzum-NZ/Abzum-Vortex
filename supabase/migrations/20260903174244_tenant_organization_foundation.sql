-- Private structural storage for tenants and organisations. Administration
-- operations are added later; no runtime or Data API role can reach these
-- relations directly.
create schema if not exists vortex_identity authorization postgres;

revoke all on schema vortex_identity
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

alter default privileges for role postgres in schema vortex_identity
  revoke all on tables
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_identity
  revoke all on sequences
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_identity
  revoke execute on functions
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create table vortex_identity.tenants (
  tenant_id uuid not null,
  short_name text not null,
  display_name text not null,
  state text not null,
  created_at timestamptz not null,
  created_by uuid not null,
  state_changed_at timestamptz not null,
  revision bigint not null,
  constraint tenants_pk primary key (tenant_id),
  constraint tenants_id_non_nil check (tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  constraint tenants_short_name_format check (
    pg_catalog.char_length(short_name) between 1 and 40
    and short_name ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
  ),
  constraint tenants_short_name_unique unique (short_name),
  constraint tenants_display_name_length check (
    pg_catalog.char_length(pg_catalog.btrim(display_name)) between 1 and 120
    and display_name = pg_catalog.btrim(display_name)
  ),
  constraint tenants_state_valid check (
    state in ('active', 'suspended', 'archived', 'removal_pending')
  ),
  constraint tenants_created_by_non_nil check (
    created_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint tenants_state_time_order check (state_changed_at >= created_at),
  constraint tenants_revision_range check (revision between 1 and 9007199254740991)
);

create table vortex_identity.organizations (
  organization_id uuid not null,
  tenant_id uuid not null,
  parent_organization_id uuid,
  short_name text not null,
  display_name text not null,
  state text not null,
  created_at timestamptz not null,
  created_by uuid not null,
  state_changed_at timestamptz not null,
  revision bigint not null,
  constraint organizations_pk primary key (organization_id),
  constraint organizations_id_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organizations_tenant_non_nil check (
    tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organizations_parent_non_nil check (
    parent_organization_id is null
    or parent_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organizations_not_own_parent check (
    parent_organization_id is null or parent_organization_id <> organization_id
  ),
  constraint organizations_short_name_format check (
    pg_catalog.char_length(short_name) between 1 and 40
    and short_name ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
  ),
  constraint organizations_short_name_per_tenant_unique unique (tenant_id, short_name),
  constraint organizations_tenant_identity_unique unique (tenant_id, organization_id),
  constraint organizations_display_name_length check (
    pg_catalog.char_length(pg_catalog.btrim(display_name)) between 1 and 120
    and display_name = pg_catalog.btrim(display_name)
  ),
  constraint organizations_state_valid check (
    state in ('active', 'suspended', 'archived', 'removal_pending')
  ),
  constraint organizations_created_by_non_nil check (
    created_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organizations_state_time_order check (state_changed_at >= created_at),
  constraint organizations_revision_range check (revision between 1 and 9007199254740991),
  constraint organizations_tenant_fk foreign key (tenant_id)
    references vortex_identity.tenants (tenant_id),
  constraint organizations_parent_same_tenant_fk foreign key (
    tenant_id,
    parent_organization_id
  ) references vortex_identity.organizations (tenant_id, organization_id)
);

create index organizations_parent_lookup_idx
  on vortex_identity.organizations (tenant_id, parent_organization_id)
  where parent_organization_id is not null;

alter table vortex_identity.tenants enable row level security;
alter table vortex_identity.tenants force row level security;
alter table vortex_identity.organizations enable row level security;
alter table vortex_identity.organizations force row level security;

create function vortex_identity.protect_tenant_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.short_name is distinct from old.short_name then
    raise exception using
      errcode = '23514',
      message = 'Tenant identifiers and short names are permanent';
  end if;

  return new;
end
$function$;

create function vortex_identity.protect_organization_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.organization_id is distinct from old.organization_id
    or new.tenant_id is distinct from old.tenant_id
    or new.short_name is distinct from old.short_name then
    raise exception using
      errcode = '23514',
      message = 'Organisation identifiers, tenant ownership and short names are permanent';
  end if;

  return new;
end
$function$;

create function vortex_identity.refuse_organization_cycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  -- Keep serialisation and cycle validation in the same trigger so their
  -- correctness cannot depend on trigger-name ordering.
  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = new.tenant_id
  for update;

  if new.parent_organization_id is null then
    return new;
  end if;

  if exists (
    with recursive ancestors as (
      select candidate.organization_id, candidate.parent_organization_id
      from vortex_identity.organizations as candidate
      where candidate.tenant_id = new.tenant_id
        and candidate.organization_id = new.parent_organization_id

      union

      select parent.organization_id, parent.parent_organization_id
      from vortex_identity.organizations as parent
      join ancestors on ancestors.parent_organization_id = parent.organization_id
      where parent.tenant_id = new.tenant_id
    )
    select 1
    from ancestors
    where ancestors.organization_id = new.organization_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Organisation hierarchy cannot contain a cycle';
  end if;

  return new;
end
$function$;

create function vortex_identity.lock_organization_tenant()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  -- State and hierarchy changes share the same per-tenant serialisation point.
  -- This prevents parent/child and tenant/organisation lifecycle write skew as
  -- well as opposing hierarchy moves.
  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = new.tenant_id
  for update;

  return new;
end
$function$;

create function vortex_identity.validate_tenant_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  current_state text;
begin
  select tenant.state
  into current_state
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = new.tenant_id;

  if not found then
    return null;
  end if;

  if current_state in ('archived', 'removal_pending')
    and exists (
      select 1
      from vortex_identity.organizations as organization
      where organization.tenant_id = new.tenant_id
        and organization.state in ('active', 'suspended')
    ) then
    raise exception using
      errcode = '23514',
      message = 'An archived or removal-pending tenant cannot retain unresolved organisations';
  end if;

  return null;
end
$function$;

create function vortex_identity.validate_organization_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  current_parent_id uuid;
  current_state text;
  tenant_state text;
  parent_state text;
begin
  select organization.parent_organization_id, organization.state
  into current_parent_id, current_state
  from vortex_identity.organizations as organization
  where organization.organization_id = new.organization_id;

  if not found then
    return null;
  end if;

  select tenant.state
  into tenant_state
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = new.tenant_id;

  if current_state in ('active', 'suspended')
    and tenant_state in ('archived', 'removal_pending') then
    raise exception using
      errcode = '23514',
      message = 'An unresolved organisation requires a live tenant';
  end if;

  if current_parent_id is not null then
    select parent.state
    into parent_state
    from vortex_identity.organizations as parent
    where parent.tenant_id = new.tenant_id
      and parent.organization_id = current_parent_id;

    if current_state in ('active', 'suspended')
      and parent_state in ('archived', 'removal_pending') then
      raise exception using
        errcode = '23514',
        message = 'An unresolved organisation requires a live parent';
    end if;
  end if;

  if current_state in ('archived', 'removal_pending')
    and exists (
      select 1
      from vortex_identity.organizations as child
      where child.tenant_id = new.tenant_id
        and child.parent_organization_id = new.organization_id
        and child.state in ('active', 'suspended')
    ) then
    raise exception using
      errcode = '23514',
      message = 'An archived or removal-pending organisation cannot retain unresolved children';
  end if;

  return null;
end
$function$;

create trigger tenants_protect_identity
before update of tenant_id, short_name on vortex_identity.tenants
for each row execute function vortex_identity.protect_tenant_identity();

create trigger organizations_protect_identity
before update of organization_id, tenant_id, short_name on vortex_identity.organizations
for each row execute function vortex_identity.protect_organization_identity();

create trigger organizations_lock_tenant
before update of state on vortex_identity.organizations
for each row execute function vortex_identity.lock_organization_tenant();

create trigger organizations_refuse_cycle
after insert or update of parent_organization_id on vortex_identity.organizations
for each row execute function vortex_identity.refuse_organization_cycle();

create constraint trigger tenants_validate_lifecycle
after insert or update of state on vortex_identity.tenants
deferrable initially deferred
for each row execute function vortex_identity.validate_tenant_lifecycle();

create constraint trigger organizations_validate_lifecycle
after insert or update of tenant_id, parent_organization_id, state on vortex_identity.organizations
deferrable initially deferred
for each row execute function vortex_identity.validate_organization_lifecycle();

revoke all on all tables in schema vortex_identity
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on all sequences in schema vortex_identity
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on all functions in schema vortex_identity
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on schema vortex_identity is
  'Private Identity-service storage; never exposed through the Supabase Data API.';
comment on table vortex_identity.tenants is
  'Customer-level governance boundaries without business-domain or commercial records.';
comment on table vortex_identity.organizations is
  'Private organisation identities and adjacency-list hierarchy within one tenant.';
