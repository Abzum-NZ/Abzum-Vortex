-- #408 Slice 1: FORCE-RLS-safe lifecycle candidate reader.
--
-- A fixed-name function that reads retained record identity, creation UTC, and
-- exact current record revision from the physical table named by the Record
-- storage catalogue.  It resolves the physical table exclusively through the
-- authoritative `vortex_record.storage_catalogue` and reuses the established
-- `vortex_record_adapter` boundary, which is NOBYPASSRLS, does not own
-- generated tables, and whose scope policies enforce the staged/validated
-- organization/application scope (20260908122641_record_storage_provisioning.sql
-- lines 637–671).
--
-- Security shape:
--   - Validates an authenticated system/background context using the established
--     `vortex_context.current_context()` authority.
--   - Requires `callerKind = 'system'` with service authentication (`authenticationStrength = 'service'`)
--     and validated `systemActorId`.  Rejects human, federated, and public callers.
--   - Binds the context organization to an existing tenant/organization row in
--     `vortex_identity.organizations`.
--   - The RLS policy on `vortex_identity.organizations` is narrowly bound to the
--     active transaction context (organization_id = vortex_context.organization_id()
--     and tenant_id = context tenant), granting zero ambient visibility to other
--     organizations in the database.
--   - Resolves physical table and scope through `vortex_record.storage_catalogue` only.
--   - Application-contained storage scopes the query to the context's exact
--     permanent application root.  Organization-shared storage stays correctly
--     scoped by organization.  A shared reader cannot leak across organizations;
--     a contained reader cannot select another permanent application root.
--   - Returns candidate facts for all retained rows: `lifecycle_state in ('active', 'soft_deleted', 'removal_pending')`.
--   - Fixed-name, least-privilege: granted to `vortex_request` only.
--   - Function is SECURITY DEFINER owned by `vortex_record_adapter`.  Because
--     that role is NOBYPASSRLS and does not own generated `record_data.*` tables,
--     every query remains subject to FORCE RLS scope policies.
--   - Never creates a bypass-RLS or owner-wide read path.
--   - Never accepts a caller-supplied table/column token.
--   - Never executes archive, delete, recovery, hold, or policy mutation.
--
-- Out of scope: the reserved `20260923010000_record_type_lifecycle_policies.sql`
-- is not touched.  #49 deletion/recovery and #50 writers/effect-journal/totals
-- ownership are preserved.

-- Grants for tenant/organization validation under vortex_record_adapter.
-- The read policy is strictly scoped to the active request context.
grant usage on schema vortex_identity to vortex_record_adapter;
grant select on vortex_identity.organizations to vortex_record_adapter;

create policy organizations_record_adapter_read on vortex_identity.organizations
  for select to vortex_record_adapter
  using (
    organization_id = vortex_context.organization_id()
    and tenant_id = (vortex_context.current_context() ->> 'tenantId')::uuid
  );

-- The adapter owner needs CREATE temporarily to define the function below.
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;

-- ============================================================================
-- The lifecycle candidate selection reader.
--
-- Given a storage contract identity, reads every retained record (lifecycle
-- state `active`, `soft_deleted`, or `removal_pending`) from its physical table.
-- Returns a set of rows: (record_id uuid, created_at timestamptz, record_revision bigint).
--
-- The caller (the policy engine or scheduled selector) receives raw candidate
-- facts and evaluates policy/retention/protection rules.  This function never
-- evaluates age, count, due reasons, holds, or protections; that logic belongs
-- to the contract and to the reserved policy migration.
-- ============================================================================
create function vortex_record.read_lifecycle_candidate_records(
  p_storage_contract_id uuid
)
returns table (
  record_id uuid,
  created_at timestamptz,
  record_revision bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_tenant_id uuid;
  context_organization_id uuid;
  context_application_root_id uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  target_table text;
  target_scope text;
  read_sql text;
begin
  -- 1. Validate input parameter.
  if p_storage_contract_id is null or p_storage_contract_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Lifecycle selection reader: storage contract identifier is invalid';
  end if;

  -- 2. Validate the authenticated request context: must be system context.
  context_value := vortex_context.current_context();

  if context_value ->> 'callerKind' is distinct from 'system' then
    raise exception using errcode = '42501',
      message = 'Lifecycle selection reader requires system context';
  end if;

  if (context_value ->> 'authenticationStrength') is distinct from 'service'
    or not context_value ? 'systemActorId' then
    raise exception using errcode = '42501',
      message = 'Lifecycle selection reader: system context requires service authentication';
  end if;

  context_tenant_id := (context_value ->> 'tenantId')::uuid;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;

  -- 3. Bind the context organization to an existing tenant/organization row.
  if not exists (
    select 1
    from vortex_identity.organizations as organization
    where organization.organization_id = context_organization_id
      and organization.tenant_id = context_tenant_id
  ) then
    raise exception using errcode = '23503',
      message = 'Lifecycle selection reader: context organization does not exist in its tenant';
  end if;

  -- 4. Resolve the physical table from the authoritative storage catalogue.
  -- Never accept a caller-supplied table token.
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;

  if not found then
    raise exception using errcode = '55000',
      message = 'Lifecycle selection reader: storage contract is unavailable';
  end if;
  if catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Lifecycle selection reader: storage contract is not active';
  end if;
  if catalogue_row.physical_schema_token <> 'record_data' then
    raise exception using errcode = '55000',
      message = 'Lifecycle selection reader: storage identity is malformed';
  end if;

  target_table := catalogue_row.physical_table_token;
  target_scope := catalogue_row.storage_scope;

  -- 5. For application-contained storage, the context must supply an application root.
  if target_scope = 'application_contained' and context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Lifecycle selection reader: application context is required for contained storage';
  end if;

  -- 6. Build and execute the dynamic query.  The scope policies on the physical
  -- table enforce organization_id = vortex_context.organization_id() and
  -- (for contained storage) application_root_id = vortex_context.application_root_id(true).
  --
  -- Includes all retained lifecycle states: active, soft_deleted, and removal_pending.
  read_sql := pg_catalog.format(
    'select stored.record_id,
            stored.created_at,
            stored.concurrency_number as record_revision
     from record_data.%I as stored
     where stored.organisation_id = $1
       and stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')
     order by stored.created_at, stored.record_id',
    target_table
  );

  return query execute read_sql using context_organization_id;
end
$function$;

comment on function vortex_record.read_lifecycle_candidate_records(uuid) is
  '#408 Slice 1: reads retained record identity, creation UTC and current revision from a storage contract''s physical table under FORCE RLS. Returns all retained states (active, soft_deleted, removal_pending) for system lifecycle evaluation.';

reset role;

-- ============================================================================
-- Grants.  Function is SECURITY DEFINER owned by vortex_record_adapter.
-- Granted to vortex_request only.
-- ============================================================================
grant execute on function vortex_record.read_lifecycle_candidate_records(uuid)
  to vortex_request;

-- Remove temporary schema CREATE privilege.
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
