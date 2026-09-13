-- Private current facts for protected tenant administration.  This migration
-- deliberately creates no command surface: later #30 slices compose these
-- facts inside their existing outer transactions.

create function vortex_identity.tenant_structural_capability_set_is_canonical(
  p_capability_keys text[]
)
returns boolean
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $function$
declare
  capability_key text;
  previous_key text;
begin
  if pg_catalog.array_ndims(p_capability_keys) <> 1
    or pg_catalog.array_lower(p_capability_keys, 1) <> 1
    or pg_catalog.cardinality(p_capability_keys) not between 1 and 7 then
    return false;
  end if;

  foreach capability_key in array p_capability_keys loop
    if capability_key is null
      or capability_key not in (
        'platform.tenant.administrators.manage',
        'platform.tenant.administrators.read',
        'platform.tenant.hierarchy.read',
        'platform.tenant.organizations.create',
        'platform.tenant.organizations.lifecycle',
        'platform.tenant.organizations.rename',
        'platform.tenant.organizations.reparent'
      )
      or (previous_key is not null and previous_key >= capability_key) then
      return false;
    end if;
    previous_key := capability_key;
  end loop;

  return true;
end
$function$;

create table vortex_identity.tenant_administrator_assignments (
  assignment_id uuid primary key,
  tenant_id uuid not null references vortex_identity.tenants (tenant_id),
  identity_id uuid not null references vortex_identity.identity_projections (identity_id),
  capability_keys text[] not null,
  starts_at timestamptz not null,
  expires_at timestamptz,
  revision bigint not null,
  granted_at timestamptz not null,
  granted_by_actor_id uuid not null,
  grant_correlation_id uuid not null,
  changed_at timestamptz not null,
  changed_by_actor_id uuid not null,
  change_correlation_id uuid not null,
  revoked_at timestamptz,
  revoked_by_actor_id uuid,
  revocation_correlation_id uuid,
  constraint tenant_administrator_assignments_ids_non_nil check (
    vortex_context.is_non_nil_uuid(assignment_id::text)
    and vortex_context.is_non_nil_uuid(tenant_id::text)
    and vortex_context.is_non_nil_uuid(identity_id::text)
    and vortex_context.is_non_nil_uuid(granted_by_actor_id::text)
    and vortex_context.is_non_nil_uuid(grant_correlation_id::text)
    and vortex_context.is_non_nil_uuid(changed_by_actor_id::text)
    and vortex_context.is_non_nil_uuid(change_correlation_id::text)
    and (revoked_by_actor_id is null
      or vortex_context.is_non_nil_uuid(revoked_by_actor_id::text))
    and (revocation_correlation_id is null
      or vortex_context.is_non_nil_uuid(revocation_correlation_id::text))
  ),
  constraint tenant_administrator_assignments_capabilities_valid check (
    vortex_identity.tenant_structural_capability_set_is_canonical(capability_keys)
  ),
  constraint tenant_administrator_assignments_expiry_valid check (
    expires_at is null or expires_at > starts_at
  ),
  constraint tenant_administrator_assignments_revision_valid check (
    revision between 1 and 9007199254740991
  ),
  constraint tenant_administrator_assignments_time_valid check (
    starts_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and granted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (expires_at is null
      or expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and (revoked_at is null
      or revoked_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and changed_at >= granted_at
    and (revoked_at is null or revoked_at >= granted_at)
  ),
  constraint tenant_administrator_assignments_revocation_complete check (
    (revoked_at is null and revoked_by_actor_id is null and revocation_correlation_id is null)
    or (
      revoked_at is not null
      and revoked_by_actor_id is not null
      and revocation_correlation_id is not null
      and revoked_at = changed_at
      and revoked_by_actor_id = changed_by_actor_id
      and revocation_correlation_id = change_correlation_id
    )
  )
);

create function vortex_identity.subject_revisions_are_valid(
  p_subject_ids uuid[],
  p_subject_revisions bigint[]
)
returns boolean
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $function$
declare
  subject_revision bigint;
begin
  if pg_catalog.array_ndims(p_subject_revisions) <> 1
    or pg_catalog.array_lower(p_subject_revisions, 1) <> 1
    or pg_catalog.cardinality(p_subject_revisions) <> pg_catalog.cardinality(p_subject_ids) then
    return false;
  end if;

  foreach subject_revision in array p_subject_revisions loop
    if subject_revision is null or subject_revision not between 1 and 9007199254740991 then
      return false;
    end if;
  end loop;
  return true;
end
$function$;

-- This table is intentionally administration-only, not a reusable platform
-- idempotency abstraction.  Rows record accepted effects only; exact command
-- adapters later own the canonical input and result projections.
create table vortex_identity.accepted_administration_receipts (
  receipt_id uuid primary key,
  actor_id uuid not null,
  tenant_id uuid references vortex_identity.tenants (tenant_id),
  cluster_id uuid,
  operation_key text not null,
  duplicate_key uuid not null,
  command_fingerprint text not null,
  subject_ids uuid[] not null,
  subject_revisions bigint[] not null,
  accepted_at timestamptz not null,
  constraint accepted_administration_receipts_ids_non_nil check (
    vortex_context.is_non_nil_uuid(receipt_id::text)
    and vortex_context.is_non_nil_uuid(actor_id::text)
    and (tenant_id is null or vortex_context.is_non_nil_uuid(tenant_id::text))
    and (cluster_id is null or vortex_context.is_non_nil_uuid(cluster_id::text))
    and vortex_context.is_non_nil_uuid(duplicate_key::text)
  ),
  constraint accepted_administration_receipts_scope_valid check (
    (tenant_id is not null and cluster_id is null)
    or (tenant_id is null and cluster_id is not null)
  ),
  constraint accepted_administration_receipts_operation_valid check (
    operation_key = pg_catalog.btrim(operation_key)
    and pg_catalog.char_length(operation_key) between 3 and 160
    and operation_key ~ '^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*)+$'
  ),
  constraint accepted_administration_receipts_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint accepted_administration_receipts_subject_ids_valid check (
    pg_catalog.cardinality(subject_ids) >= 1
    and vortex_activity.uuid_array_is_canonical(subject_ids)
  ),
  constraint accepted_administration_receipts_subject_revisions_valid check (
    vortex_identity.subject_revisions_are_valid(subject_ids, subject_revisions)
  ),
  constraint accepted_administration_receipts_accepted_at_valid check (
    accepted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  )
);

-- Scope is an exact tenant-or-cluster choice, so two partial keys retain
-- deterministic replay uniqueness without relying on null-equality syntax
-- unavailable in the supported Local verification Postgres image.
create unique index accepted_administration_receipts_tenant_replay_unique
  on vortex_identity.accepted_administration_receipts (
    actor_id, tenant_id, operation_key, duplicate_key
  ) where tenant_id is not null;
create unique index accepted_administration_receipts_cluster_replay_unique
  on vortex_identity.accepted_administration_receipts (
    actor_id, cluster_id, operation_key, duplicate_key
  ) where cluster_id is not null;

alter table vortex_identity.tenant_administrator_assignments enable row level security;
alter table vortex_identity.tenant_administrator_assignments force row level security;
alter table vortex_identity.accepted_administration_receipts enable row level security;
alter table vortex_identity.accepted_administration_receipts force row level security;

revoke all on table vortex_identity.tenant_administrator_assignments,
  vortex_identity.accepted_administration_receipts
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_identity.tenant_structural_capability_set_is_canonical(text[])
  , vortex_identity.subject_revisions_are_valid(uuid[], bigint[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on table vortex_identity.tenant_administrator_assignments is
  'Private revisioned structural tenant authority facts; effective timing is derived by the protected tenant-administration operation.';
comment on table vortex_identity.accepted_administration_receipts is
  'Private accepted-result receipts for protected tenant administration only; it contains no raw command input, secret, profile or permission snapshot.';
