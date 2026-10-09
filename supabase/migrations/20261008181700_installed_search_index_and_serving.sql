begin;

-- Search resolves protected source authority as a non-login owner role before
-- establishing a request context. PostgreSQL also requires UPDATE privilege
-- for SELECT row-lock clauses, so grant UPDATE only on immutable identity
-- columns and make every corresponding owner UPDATE fail its forced-RLS check.
alter table vortex_access.organization_access_versions enable row level security;
alter table vortex_access.organization_access_versions force row level security;
grant select (organization_id, current_version)
  on table vortex_access.organization_access_versions to vortex_access_owner;
grant update (organization_id)
  on table vortex_access.organization_access_versions to vortex_access_owner;
create policy search_index_access_versions_owner_select
  on vortex_access.organization_access_versions
  for select to vortex_access_owner using (true);
create policy search_index_access_versions_owner_lock
  on vortex_access.organization_access_versions
  for update to vortex_access_owner using (true) with check (false);

alter table vortex_access.permission_registrations enable row level security;
alter table vortex_access.permission_registrations force row level security;
grant update (registration_owner_id)
  on table vortex_access.permission_registrations to vortex_access_owner;
create policy search_index_permission_registrations_owner_lock
  on vortex_access.permission_registrations
  for update to vortex_access_owner using (true) with check (false);

alter table vortex_access.system_actor_grants enable row level security;
alter table vortex_access.system_actor_grants force row level security;
grant select (system_actor_id, operation_key, organization_id, flow_id, scope_key, state)
  on table vortex_access.system_actor_grants to vortex_access_owner;
grant update (system_actor_grant_id)
  on table vortex_access.system_actor_grants to vortex_access_owner;
create policy search_index_system_actor_grants_owner_select
  on vortex_access.system_actor_grants
  for select to vortex_access_owner using (true);
create policy search_index_system_actor_grants_owner_lock
  on vortex_access.system_actor_grants
  for update to vortex_access_owner using (true) with check (false);

alter table vortex_identity.tenants enable row level security;
alter table vortex_identity.tenants force row level security;
grant update (tenant_id) on table vortex_identity.tenants to vortex_identity_owner;
create policy search_index_tenants_owner_lock
  on vortex_identity.tenants
  for update to vortex_identity_owner using (true) with check (false);

alter table vortex_search.documents
  add column application_scope_id uuid generated always as (
    coalesce(application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) stored;
alter table vortex_search.documents drop constraint documents_pkey;
alter table vortex_search.documents add constraint documents_pkey
  primary key (organization_id, record_type_id, record_id, application_scope_id);
comment on column vortex_search.documents.application_scope_id is
  'Non-null storage identity for the nullable Application scope; the nil UUID represents the existing organisation-shared identity and is never selected by this Application-only consumer.';

grant select (application_scope_id) on table vortex_search.documents to vortex_search_owner;
grant usage on schema vortex_access, vortex_module to vortex_search_owner;
grant execute on function vortex_context.current_context() to vortex_access_owner;
set local role vortex_event_owner;
create or replace function vortex_event.read_search_index_occurrence_internal(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  source_row record;
begin
  if p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_claim_cursor is null or p_claim_cursor = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Search claim selector is invalid';
  end if;
  select occurrence.envelope, occurrence.organization_id, occurrence.storage_contract_id,
    occurrence.storage_scope, occurrence.sequence_application_root_id,
    occurrence.record_id, progress.lease_expires_at
  into source_row
  from vortex_event.event_outbox as occurrence
  join vortex_event.consumer_occurrence_progress as progress
    on progress.occurrence_id = occurrence.occurrence_id
  where occurrence.occurrence_id = p_occurrence_id
    and progress.consumer_key = 'search.documents'
    and progress.claim_cursor = p_claim_cursor
    and progress.acknowledged_at is null
    and progress.terminally_failed_at is null
    and progress.lease_expires_at > pg_catalog.clock_timestamp();
  if not found or source_row.storage_scope is distinct from 'application_contained'
    or source_row.sequence_application_root_id is null
    or source_row.envelope ->> 'occurrenceId' is distinct from p_occurrence_id::text
    or source_row.envelope ->> 'organizationId' is distinct from source_row.organization_id::text
    or source_row.envelope ->> 'recordId' is distinct from source_row.record_id::text
    or source_row.envelope #>> '{installation,applicationRootId}'
      is distinct from source_row.sequence_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search claim is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'occurrence', source_row.envelope,
    'storageScope', source_row.storage_scope,
    'sourceOrganizationId', source_row.organization_id,
    'storageContractId', source_row.storage_contract_id,
    'sequenceApplicationRootId', source_row.sequence_application_root_id,
    'leaseExpiresAt', pg_catalog.to_char(pg_catalog.timezone('UTC',source_row.lease_expires_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
end
$function$;
alter function vortex_event.read_search_index_occurrence_internal(uuid,uuid) owner to vortex_event_owner;
revoke all on function vortex_event.read_search_index_occurrence_internal(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_event.read_search_index_occurrence_internal(uuid,uuid) to vortex_access_owner, vortex_identity_owner;
comment on function vortex_event.read_search_index_occurrence_internal(uuid,uuid) is 'Owner-only fixed search.documents retained source reader; no mutable lock before Access authority, no caller actor or scope selector.';
reset role;

set local role vortex_event_owner;
create or replace function vortex_event.validate_search_index_claim_internal(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  claim_row record;
begin
  if p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_claim_cursor is null or p_claim_cursor = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Search claim selector is invalid';
  end if;
  select progress.claim_cursor, progress.acknowledged_at, progress.terminally_failed_at,
    progress.lease_expires_at into claim_row
  from vortex_event.consumer_occurrence_progress as progress
  where progress.consumer_key = 'search.documents' and progress.occurrence_id = p_occurrence_id
  for update of progress;
  if not found or claim_row.claim_cursor is distinct from p_claim_cursor
    or claim_row.acknowledged_at is not null or claim_row.terminally_failed_at is not null
    or claim_row.lease_expires_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501', message = 'Search claim is unavailable';
  end if;
  return vortex_event.read_search_index_occurrence_internal(p_occurrence_id,p_claim_cursor);
end
$function$;
alter function vortex_event.validate_search_index_claim_internal(uuid,uuid) owner to vortex_event_owner;
revoke all on function vortex_event.validate_search_index_claim_internal(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_event.validate_search_index_claim_internal(uuid,uuid) to vortex_access_owner;
comment on function vortex_event.validate_search_index_claim_internal(uuid,uuid) is 'Owner-only fixed search.documents live claim check and progress lock using the retained cursor and current database time.';
reset role;

set local role vortex_identity_owner;
create or replace function vortex_identity.read_search_index_organization_scope_internal(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  retained jsonb;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_tenant_id uuid;
  locked_tenant_id uuid;
begin
  retained := vortex_event.read_search_index_occurrence_internal(p_occurrence_id,p_claim_cursor);
  selected_organization_id := (retained ->> 'sourceOrganizationId')::uuid;
  selected_application_root_id := (retained ->> 'sequenceApplicationRootId')::uuid;
  select organization.tenant_id into selected_tenant_id
  from vortex_identity.organizations as organization
  where organization.organization_id = selected_organization_id and organization.state = 'active'
  for share of organization;
  if selected_tenant_id is null then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  select tenant.tenant_id into locked_tenant_id
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = selected_tenant_id and tenant.state = 'active'
  for share of tenant;
  if locked_tenant_id is null then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  return pg_catalog.jsonb_build_object('tenantId',locked_tenant_id,
    'organizationId',selected_organization_id,'applicationRootId',selected_application_root_id);
end
$function$;
alter function vortex_identity.read_search_index_organization_scope_internal(uuid,uuid) owner to vortex_identity_owner;
revoke all on function vortex_identity.read_search_index_organization_scope_internal(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_identity.read_search_index_organization_scope_internal(uuid,uuid) to vortex_access_owner;
comment on function vortex_identity.read_search_index_organization_scope_internal(uuid,uuid) is 'Owner-only active tenant and organization scope for the exact retained Search claim; no Runtime organization or actor selector.';
reset role;

set local role vortex_access_owner;
create or replace function vortex_access.read_search_index_actor_scope_internal(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  selected jsonb;
  locked_claim jsonb;
  identity_scope jsonb;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_access_version bigint;
  registration_rows uuid[];
  granted_actor_ids uuid[];
  observed_at timestamptz;
begin
  selected := vortex_event.read_search_index_occurrence_internal(p_occurrence_id,p_claim_cursor);
  selected_organization_id := (selected ->> 'sourceOrganizationId')::uuid;
  selected_application_root_id := (selected ->> 'sequenceApplicationRootId')::uuid;
  -- Access version is first; no mutable Event progress lock is taken by the initial read.
  select version.current_version into selected_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = selected_organization_id
  for share of version;
  if selected_access_version is null then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  identity_scope := vortex_identity.read_search_index_organization_scope_internal(
    p_occurrence_id,p_claim_cursor);
  if identity_scope ->> 'organizationId' is distinct from selected_organization_id::text
    or identity_scope ->> 'applicationRootId' is distinct from selected_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  select pg_catalog.array_agg(matched.registration_owner_id) into registration_rows
  from (select registration.registration_owner_id
    from vortex_access.permission_registrations as registration
    where registration.organization_id = selected_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = selected_application_root_id
      and registration.state = 'active'
    for share of registration) as matched;
  if registration_rows is null or pg_catalog.cardinality(registration_rows) <> 1 then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  select pg_catalog.array_agg(matched.system_actor_id) into granted_actor_ids
  from (select actor_grant.system_actor_id
    from vortex_access.system_actor_grants as actor_grant
    where actor_grant.operation_key = 'index_search_documents'
      and actor_grant.organization_id = selected_organization_id
      and actor_grant.flow_id is null
      and actor_grant.scope_key = 'application:' || selected_application_root_id::text
      and actor_grant.state = 'active'
    for share of actor_grant) as matched;
  if granted_actor_ids is null or pg_catalog.cardinality(granted_actor_ids) <> 1 then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  locked_claim := vortex_event.validate_search_index_claim_internal(p_occurrence_id,p_claim_cursor);
  observed_at := pg_catalog.clock_timestamp();
  if (locked_claim - 'leaseExpiresAt') is distinct from (selected - 'leaseExpiresAt')
    or (locked_claim ->> 'leaseExpiresAt')::timestamptz <= observed_at then
    raise exception using errcode = '42501', message = 'Search claim is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'systemActorId',granted_actor_ids[1], 'tenantId',identity_scope ->> 'tenantId',
    'organizationId',selected_organization_id,'applicationRootId',selected_application_root_id,
    'accessVersion',selected_access_version,'occurrence',selected -> 'occurrence',
    'storageScope',selected ->> 'storageScope','storageContractId',selected ->> 'storageContractId',
    'sequenceApplicationRootId',selected_application_root_id,
    'observedAt',pg_catalog.to_char(pg_catalog.timezone('UTC',observed_at),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'leaseExpiresAt',locked_claim ->> 'leaseExpiresAt');
end
$function$;
alter function vortex_access.read_search_index_actor_scope_internal(uuid,uuid) owner to vortex_access_owner;
revoke all on function vortex_access.read_search_index_actor_scope_internal(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_access.read_search_index_actor_scope_internal(uuid,uuid) to vortex_access_owner;
comment on function vortex_access.read_search_index_actor_scope_internal(uuid,uuid) is 'Private fixed-purpose Search grant and current tenant/organization/Application/version resolver, locked before live Event progress; no registry mutation or fallback actor.';
reset role;

set local role vortex_access_owner;
create or replace function vortex_access.validated_search_index_request_context_internal(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  resolved jsonb;
  observed_at timestamptz;
begin
  checked := vortex_context.current_context();
  if checked ->> 'callerKind' is distinct from 'system'
    or checked ->> 'channel' is distinct from 'system'
    or checked ? 'supportContext'
    or not checked ?& array['systemActorId','tenantId','organizationId','applicationRootId',
      'accessVersion','issuedAt','expiresAt'] then
    raise exception using errcode = '42501', message = 'Search purpose context is unavailable';
  end if;
  resolved := vortex_access.read_search_index_actor_scope_internal(p_occurrence_id,p_claim_cursor);
  observed_at := pg_catalog.clock_timestamp();
  if checked ->> 'systemActorId' is distinct from resolved ->> 'systemActorId'
    or checked ->> 'tenantId' is distinct from resolved ->> 'tenantId'
    or checked ->> 'organizationId' is distinct from resolved ->> 'organizationId'
    or checked ->> 'applicationRootId' is distinct from resolved ->> 'applicationRootId'
    or (checked ->> 'accessVersion')::bigint is distinct from (resolved ->> 'accessVersion')::bigint
    or (checked ->> 'issuedAt')::timestamptz > observed_at
    or (checked ->> 'expiresAt')::timestamptz <= observed_at
    or (checked ->> 'expiresAt')::timestamptz > (resolved ->> 'leaseExpiresAt')::timestamptz then
    raise exception using errcode = '42501', message = 'Search purpose context is unavailable';
  end if;
  return resolved;
end
$function$;
alter function vortex_access.validated_search_index_request_context_internal(uuid,uuid) owner to vortex_access_owner;
revoke all on function vortex_access.validated_search_index_request_context_internal(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_access.validated_search_index_request_context_internal(uuid,uuid) to vortex_module_owner, vortex_search_owner, vortex_record_adapter;
comment on function vortex_access.validated_search_index_request_context_internal(uuid,uuid) is 'Owner-only current SYSTEM Search purpose validator over the exact retained source claim and active fixed grant; no caller supplied authority.';
reset role;

set local role vortex_access_owner;
create or replace function vortex_access.resolve_search_index_actor_scope(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return vortex_access.read_search_index_actor_scope_internal(p_occurrence_id,p_claim_cursor);
end
$function$;
alter function vortex_access.resolve_search_index_actor_scope(uuid,uuid) owner to vortex_access_owner;
revoke all on function vortex_access.resolve_search_index_actor_scope(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_access.resolve_search_index_actor_scope(uuid,uuid) to vortex_runtime;
comment on function vortex_access.resolve_search_index_actor_scope(uuid,uuid) is 'Runtime-only fixed Search indexing resolver over the actual retained occurrence and cursor; registry tables and private owner interfaces are not exposed.';
reset role;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;
create or replace function vortex_record.read_search_index_record_internal(
  p_trusted_source_plan jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  plan jsonb := p_trusted_source_plan;
  context_value jsonb;
  authority jsonb;
  occurrence jsonb;
  module_release vortex_definition.releases%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  provision_row vortex_record.release_provisions%rowtype;
  record_type jsonb;
  record_types jsonb;
  selected_field jsonb;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  selected_field_id uuid;
  selected_field_ids uuid[] := array[]::uuid[];
  field_value_pairs text[] := array[]::text[];
  field_value_sql text;
  selected_module_root_id uuid;
  selected_module_release_revision bigint;
  selected_application_release_revision bigint;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_record_type_id uuid;
  selected_record_id uuid;
  selected_storage_contract_id uuid;
  selected_occurrence_id uuid;
  selected_claim_cursor uuid;
  physical_table text;
  physical_column text;
  record_row record;
  row_count integer;
begin
  if pg_catalog.jsonb_typeof(plan) is distinct from 'object'
    or not plan ?& array[
      'occurrenceId', 'claimCursor', 'organizationId', 'applicationRootId',
      'applicationReleaseRevision', 'moduleRootId', 'moduleReleaseRevision',
      'bindingRevision', 'storageContractId', 'recordTypeId', 'recordId',
      'recordType', 'fieldIds'
    ]
    or plan - array[
      'occurrenceId', 'claimCursor', 'organizationId', 'applicationRootId',
      'applicationReleaseRevision', 'moduleRootId', 'moduleReleaseRevision',
      'bindingRevision', 'storageContractId', 'recordTypeId', 'recordId',
      'recordType', 'fieldIds'
    ] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(plan -> 'fieldIds') is distinct from 'array'
    or pg_catalog.jsonb_typeof(plan -> 'recordType') is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Search Record plan is invalid';
  end if;

  selected_occurrence_id := (plan ->> 'occurrenceId')::uuid;
  selected_claim_cursor := (plan ->> 'claimCursor')::uuid;
  selected_organization_id := (plan ->> 'organizationId')::uuid;
  selected_application_root_id := (plan ->> 'applicationRootId')::uuid;
  selected_application_release_revision := (plan ->> 'applicationReleaseRevision')::bigint;
  selected_module_root_id := (plan ->> 'moduleRootId')::uuid;
  selected_module_release_revision := (plan ->> 'moduleReleaseRevision')::bigint;
  selected_record_type_id := (plan ->> 'recordTypeId')::uuid;
  selected_record_id := (plan ->> 'recordId')::uuid;
  selected_storage_contract_id := (plan ->> 'storageContractId')::uuid;

  if selected_occurrence_id is null or selected_occurrence_id = nil_uuid
    or selected_claim_cursor is null or selected_claim_cursor = nil_uuid
    or selected_organization_id is null or selected_organization_id = nil_uuid
    or selected_application_root_id is null or selected_application_root_id = nil_uuid
    or selected_module_root_id is null or selected_module_root_id = nil_uuid
    or selected_record_type_id is null or selected_record_type_id = nil_uuid
    or selected_record_id is null or selected_record_id = nil_uuid
    or selected_storage_contract_id is null or selected_storage_contract_id = nil_uuid
    or selected_application_release_revision not between 1 and 9007199254740991
    or selected_module_release_revision not between 1 and 9007199254740991
    or (plan ->> 'bindingRevision')::bigint not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Search Record plan identity is invalid';
  end if;

  context_value := vortex_context.current_context();
  if context_value ->> 'callerKind' is distinct from 'system'
    or context_value ->> 'channel' is distinct from 'system'
    or context_value ? 'supportContext'
    or context_value ->> 'organizationId' is distinct from selected_organization_id::text
    or context_value ->> 'applicationRootId' is distinct from selected_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search Record authority is unavailable';
  end if;
  authority := vortex_access.validated_search_index_request_context_internal(
    selected_occurrence_id, selected_claim_cursor
  );
  occurrence := authority -> 'occurrence';
  if authority ->> 'organizationId' is distinct from selected_organization_id::text
    or authority ->> 'applicationRootId' is distinct from selected_application_root_id::text
    or authority ->> 'storageContractId' is distinct from selected_storage_contract_id::text
    or authority ->> 'storageScope' is distinct from 'application_contained'
    or occurrence ->> 'recordId' is distinct from selected_record_id::text
    or occurrence #>> '{descriptor,recordTypeId}' is distinct from selected_record_type_id::text
    or occurrence #>> '{installation,moduleBinding,moduleRootId}' is distinct from selected_module_root_id::text
    or occurrence #>> '{definitionRelease,kind}' is distinct from 'module'
    or occurrence #>> '{definitionRelease,rootId}' is distinct from selected_module_root_id::text
    or occurrence #>> '{definitionRelease,releaseRevision}' is distinct from
      occurrence #>> '{installation,moduleBinding,moduleReleaseRevision}'
    or occurrence #>> '{installation,applicationRootId}' is distinct from selected_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search Record claim or source changed';
  end if;

  select release.* into module_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = selected_module_root_id
    and release.release_revision = selected_module_release_revision
    and root.kind = 'module';
  if not found
    or module_release.source_contract_version is distinct from module_release.validation_contract_version
    or module_release.validation_contract_version <>
      all (vortex_definition.accepted_contract_version('module'))
    or module_release.compilation_output #>> '{kind}' is distinct from 'module'
    or module_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from selected_module_root_id::text
    or module_release.compilation_output #>> '{validationContractVersion}'
      is distinct from module_release.validation_contract_version then
    raise exception using errcode = '42501', message = 'Search Record release is unavailable';
  end if;

  record_types := module_release.compilation_output #> '{canonical,content,recordTypes}';
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(record_types) as item(value)
  where item.value ->> 'recordTypeId' = selected_record_type_id::text
    and item.value ->> 'storageContractId' = selected_storage_contract_id::text;
  if not found or (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    where item.value ->> 'recordTypeId' = selected_record_type_id::text
      and item.value ->> 'storageContractId' = selected_storage_contract_id::text
  ) <> 1
    or record_type is distinct from plan -> 'recordType'
    or record_type ->> 'storageScope' is distinct from 'application_contained' then
    raise exception using errcode = '42501', message = 'Search Record type is unavailable';
  end if;

  select provision.* into provision_row
  from vortex_record.release_provisions as provision
  where provision.module_root_id = selected_module_root_id
    and provision.release_revision = selected_module_release_revision;
  if not found
    or provision_row.content_fingerprint is distinct from module_release.content_fingerprint
    or provision_row.resolution_fingerprint is distinct from module_release.resolution_fingerprint
    or not selected_storage_contract_id = any (provision_row.storage_contract_ids) then
    raise exception using errcode = '42501', message = 'Search Record provision is unavailable';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = selected_storage_contract_id;
  if not found
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'record_data'
    or catalogue_row.module_root_id is distinct from selected_module_root_id
    or catalogue_row.record_type_id is distinct from selected_record_type_id
    or catalogue_row.storage_scope is distinct from 'application_contained'
    or selected_module_release_revision < catalogue_row.first_compatible_release_revision
    or (catalogue_row.last_compatible_release_revision is not null and
      selected_module_release_revision > catalogue_row.last_compatible_release_revision)
    or vortex_record.storage_meaning(catalogue_row.record_type_definition)
      is distinct from vortex_record.storage_meaning(record_type) then
    raise exception using errcode = '42501', message = 'Search Record storage is unavailable';
  end if;
  physical_table := catalogue_row.physical_table_token;
  if physical_table is null or physical_table !~ '^rt_[a-f0-9]{32}$'
    or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', physical_table)) is null then
    raise exception using errcode = '42501', message = 'Search Record storage is unavailable';
  end if;

  for selected_field in
    select item.value
    from pg_catalog.jsonb_array_elements(plan -> 'fieldIds') as item(value)
    order by item.value #>> '{}' collate "C"
  loop
    begin
      selected_field_id := (selected_field #>> '{}')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Search field identity is invalid';
    end;
    if selected_field_id is null or selected_field_id = nil_uuid
      or selected_field_id = any (selected_field_ids) then
      raise exception using errcode = '42501', message = 'Search field identity is invalid';
    end if;
    selected_field_ids := selected_field_ids || selected_field_id;

    select field.value into selected_field
    from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
    where field.value ->> 'fieldId' = selected_field_id::text;
    if not found
      or selected_field ->> 'personalData' is distinct from 'none'
      or selected_field ->> 'searchPriority' not in ('first', 'normal', 'last')
      or selected_field ->> 'type' not in (
        'text', 'long_text', 'formatted_text', 'whole_number', 'decimal_number', 'date',
        'date_time', 'choice', 'several_choices', 'reference_number', 'email_address',
        'phone_number', 'web_address'
      ) then
      raise exception using errcode = '42501', message = 'Search field is not directly disclosable';
    end if;

    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = selected_storage_contract_id
      and mapping.field_id = selected_field_id
      and mapping.state = 'active';
    if not found
      or mapping_row.field_definition is distinct from selected_field
      or mapping_row.physical_column_token is distinct from
        ('f_' || pg_catalog.replace(pg_catalog.lower(selected_field_id::text), '-', ''))
      or mapping_row.database_value_type is distinct from
        vortex_record.database_value_type(selected_field)
      or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', physical_table)) is null
      or not exists (
        select 1
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(
            pg_catalog.format('%I.%I', 'record_data', physical_table)
          )
          and attribute.attname = mapping_row.physical_column_token
          and attribute.attnum > 0
          and not attribute.attisdropped
      ) then
      raise exception using errcode = '42501', message = 'Search field storage is unavailable';
    end if;

    physical_column := mapping_row.physical_column_token;
    field_value_sql := case mapping_row.database_value_type
      when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', physical_column)
      when 'date' then pg_catalog.format(
        'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))', physical_column
      )
      when 'timestamp_with_time_zone' then pg_catalog.format(
        'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(stored.%I))', physical_column
      )
      else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', physical_column)
    end;
    field_value_pairs := pg_catalog.array_append(
      field_value_pairs,
      pg_catalog.format('%L, %s', selected_field_id::text, field_value_sql)
    );
  end loop;

  if pg_catalog.cardinality(selected_field_ids) > 100 then
    raise exception using errcode = '42501', message = 'Search field count is out of bounds';
  end if;

  execute pg_catalog.format(
    'select stored.organisation_id, stored.application_root_id, stored.module_root_id,
       stored.record_type_id, stored.storage_contract_id, stored.record_id,
       stored.definition_revision, stored.concurrency_number, stored.lifecycle_state,
       pg_catalog.jsonb_build_object(%s) as field_values
     from record_data.%I as stored
     where stored.organisation_id = $1
       and stored.application_root_id = $2
       and stored.record_id = $3
       and stored.module_root_id = $4
       and stored.record_type_id = $5
       and stored.storage_contract_id = $6
     for update of stored',
    case when pg_catalog.cardinality(field_value_pairs) = 0 then ''
      else pg_catalog.array_to_string(field_value_pairs, ', ') end,
    physical_table
  ) into record_row
  using selected_organization_id, selected_application_root_id, selected_record_id,
    selected_module_root_id, selected_record_type_id, selected_storage_contract_id;
  get diagnostics row_count = ROW_COUNT;
  if row_count <> 1 or record_row.record_id is null
    or record_row.organisation_id is distinct from selected_organization_id
    or record_row.application_root_id is distinct from selected_application_root_id
    or record_row.module_root_id is distinct from selected_module_root_id
    or record_row.record_type_id is distinct from selected_record_type_id
    or record_row.storage_contract_id is distinct from selected_storage_contract_id
    or record_row.definition_revision not between catalogue_row.first_compatible_release_revision and
      coalesce(catalogue_row.last_compatible_release_revision, 9007199254740991)
    or record_row.concurrency_number not between 1 and 9007199254740991
    or record_row.lifecycle_state not in ('active', 'soft_deleted', 'removal_pending') then
    raise exception using errcode = 'P0002', message = 'Search current Record is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'indexOrganisationId', selected_organization_id,
    'ownerOrganisationId', selected_organization_id,
    'applicationRootId', selected_application_root_id,
    'recordTypeId', selected_record_type_id,
    'recordId', selected_record_id,
    'definitionRevision', record_row.definition_revision,
    'recordVersion', record_row.concurrency_number,
    'lifecycle', case when record_row.lifecycle_state = 'active' then 'active' else 'deleted' end,
    'fieldValues', case when record_row.lifecycle_state = 'active'
      then record_row.field_values else '{}'::jsonb end
  );
end
$function$;

alter function vortex_record.read_search_index_record_internal(jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.read_search_index_record_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner,
    vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_record.read_search_index_record_internal(jsonb)
  to vortex_module_owner;
comment on function vortex_record.read_search_index_record_internal(jsonb) is
  'Returns one locked current application-contained Record Search snapshot to the Module owner only, deriving physical storage from current immutable provision and catalogue metadata while preserving generated Record RLS.';
reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

set local role vortex_module_owner;
create or replace function vortex_module.read_search_index_source(
  p_occurrence_id uuid,
  p_claim_cursor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  occurrence jsonb;
  initial_installation jsonb;
  current_installation jsonb;
  current_binding jsonb;
  current_application_release vortex_definition.releases%rowtype;
  retained_application_release vortex_definition.releases%rowtype;
  current_module_release vortex_definition.releases%rowtype;
  retained_module_release vortex_definition.releases%rowtype;
  historical_record_type jsonb;
  current_record_type jsonb;
  projected_record_type jsonb;
  selected_fields jsonb;
  projected_snapshot jsonb;
  selected_field_ids uuid[];
  trusted_record_plan jsonb;
  record_snapshot jsonb;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_module_root_id uuid;
  selected_record_type_id uuid;
  selected_storage_contract_id uuid;
  selected_application_release_revision bigint;
  selected_module_release_revision bigint;
  selected_binding_revision bigint;
  binding_item jsonb;
  binding_row vortex_module.installation_bindings%rowtype;
  retained_record_types jsonb;
  current_record_types jsonb;
  matched_count integer;
begin
  if p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_claim_cursor is null or p_claim_cursor = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Search occurrence selector is invalid';
  end if;

  authority := vortex_access.validated_search_index_request_context_internal(
    p_occurrence_id, p_claim_cursor
  );
  occurrence := authority -> 'occurrence';
  selected_organization_id := (authority ->> 'organizationId')::uuid;
  selected_application_root_id := (authority ->> 'applicationRootId')::uuid;
  selected_module_root_id := (occurrence #>> '{installation,moduleBinding,moduleRootId}')::uuid;
  selected_application_release_revision :=
    (occurrence #>> '{installation,applicationReleaseRevision}')::bigint;
  selected_module_release_revision :=
    (occurrence #>> '{installation,moduleBinding,moduleReleaseRevision}')::bigint;
  selected_binding_revision :=
    (occurrence #>> '{installation,moduleBinding,bindingRevision}')::bigint;
  selected_record_type_id := (occurrence #>> '{descriptor,recordTypeId}')::uuid;
  selected_storage_contract_id := (authority ->> 'storageContractId')::uuid;

  if occurrence ->> 'contractVersion' is distinct from '2.0.0'
    or occurrence #>> '{descriptor,kind}' is distinct from 'standard'
    or occurrence #>> '{descriptor,recordTypeId}' is distinct from selected_record_type_id::text
    or occurrence #>> '{definitionRelease,kind}' is distinct from 'module'
    or occurrence #>> '{definitionRelease,rootId}' is distinct from selected_module_root_id::text
    or (occurrence #>> '{definitionRelease,releaseRevision}')::bigint
      is distinct from selected_module_release_revision
    or occurrence ->> 'organizationId' is distinct from selected_organization_id::text
    or selected_application_release_revision not between 1 and 9007199254740991
    or selected_module_release_revision not between 1 and 9007199254740991
    or selected_binding_revision not between 1 and 9007199254740991
    or authority ->> 'storageScope' is distinct from 'application_contained'
    or authority ->> 'sequenceApplicationRootId' is distinct from selected_application_root_id::text
    or occurrence #>> '{installation,applicationRootId}' is distinct from selected_application_root_id::text
    or occurrence #>> '{descriptor,eventKind}' not in (
      'created', 'changed', 'deleted', 'state_changed', 'reassigned'
    ) then
    raise exception using errcode = '42501', message = 'Search source is unavailable';
  end if;

  initial_installation := vortex_module.read_active_installation_for_scope_internal(
    selected_organization_id, selected_application_root_id
  );
  if initial_installation ->> 'organizationId' is distinct from selected_organization_id::text
    or initial_installation ->> 'applicationRootId' is distinct from selected_application_root_id::text
    or initial_installation ->> 'applicationReleaseRevision' is null
    or pg_catalog.jsonb_typeof(initial_installation -> 'moduleBindings') is distinct from 'array' then
    raise exception using errcode = '42501', message = 'Search installation is unavailable';
  end if;

  -- Match the installation lifecycle's canonical advisory identity and UUID ordering.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(initial_installation -> 'moduleBindings') as item(value)
    order by (item.value ->> 'moduleRootId') collate "C"
  loop
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended(
        'vortex_module.binding:' || selected_organization_id::text || ':' ||
          selected_application_root_id::text || ':' || (binding_item ->> 'moduleRootId'),
        0
      )
    );
  end loop;

  perform 1
  from vortex_module.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.state = 'active'
  order by binding.module_root_id
  for share of binding;

  current_installation := vortex_module.read_active_installation_for_scope_internal(
    selected_organization_id, selected_application_root_id
  );
  if current_installation is distinct from initial_installation then
    raise exception using errcode = '42501', message = 'Search installation changed';
  end if;

  select release.* into retained_application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = selected_application_root_id
    and release.release_revision = selected_application_release_revision
    and root.organization_id = selected_organization_id
    and root.kind = 'application';
  if not found
    or retained_application_release.validation_contract_version <>
      all (vortex_definition.accepted_contract_version('application'))
    or retained_application_release.source_contract_version is distinct from
      retained_application_release.validation_contract_version
    or retained_application_release.compilation_output #>> '{kind}' is distinct from 'application'
    or retained_application_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from selected_application_root_id::text
    or retained_application_release.compilation_output #>> '{validationContractVersion}'
      is distinct from retained_application_release.validation_contract_version then
    raise exception using errcode = '42501', message = 'Search retained Application release is unavailable';
  end if;

  select binding.* into binding_row
  from vortex_module.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.module_root_id = selected_module_root_id
    and binding.state = 'active'
    and binding.application_release_revision =
      (current_installation ->> 'applicationReleaseRevision')::bigint
  for share of binding;
  if not found
    or binding_row.binding_revision not between 1 and 9007199254740991
    or binding_row.module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '42501', message = 'Search binding is unavailable';
  end if;
  select item.value into current_binding
  from pg_catalog.jsonb_array_elements(current_installation -> 'moduleBindings') as item(value)
  where item.value ->> 'moduleRootId' = selected_module_root_id::text;
  if not found
    or current_binding ->> 'organizationId' is distinct from selected_organization_id::text
    or current_binding ->> 'applicationRootId' is distinct from selected_application_root_id::text
    or current_binding ->> 'moduleRootId' is distinct from selected_module_root_id::text
    or current_binding ->> 'bindingRevision' is distinct from binding_row.binding_revision::text
    or current_binding ->> 'applicationReleaseRevision' is distinct from
      binding_row.application_release_revision::text
    or current_binding ->> 'moduleReleaseRevision' is distinct from
      binding_row.module_release_revision::text
    or current_binding ->> 'state' is distinct from 'active' then
    raise exception using errcode = '42501', message = 'Search active binding closure is unavailable';
  end if;

  select release.* into current_application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = selected_application_root_id
    and release.release_revision = binding_row.application_release_revision
    and root.organization_id = selected_organization_id
    and root.kind = 'application';
  if not found
    or current_application_release.validation_contract_version <>
      all (vortex_definition.accepted_contract_version('application'))
    or current_application_release.source_contract_version is distinct from
      current_application_release.validation_contract_version
    or current_application_release.compilation_output #>> '{kind}' is distinct from 'application'
    or current_application_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from selected_application_root_id::text
    or current_application_release.compilation_output #>> '{validationContractVersion}'
      is distinct from current_application_release.validation_contract_version then
    raise exception using errcode = '42501', message = 'Search Application release is unavailable';
  end if;

  select release.* into current_module_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = selected_module_root_id
    and release.release_revision = binding_row.module_release_revision
    and root.kind = 'module';
  if not found
    or current_module_release.validation_contract_version <>
      all (vortex_definition.accepted_contract_version('module'))
    or current_module_release.source_contract_version is distinct from
      current_module_release.validation_contract_version
    or current_module_release.compilation_output #>> '{kind}' is distinct from 'module'
    or current_module_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from selected_module_root_id::text
    or current_module_release.compilation_output #>> '{validationContractVersion}'
      is distinct from current_module_release.validation_contract_version then
    raise exception using errcode = '42501', message = 'Search Module release is unavailable';
  end if;

  select release.* into retained_module_release
  from vortex_definition.releases as release
  where release.root_id = selected_module_root_id
    and release.release_revision = selected_module_release_revision;
  if not found
    or retained_module_release.release_version is distinct from
      occurrence #>> '{definitionRelease,releaseVersion}'
    or retained_module_release.content_fingerprint is distinct from
      occurrence #>> '{definitionRelease,contentFingerprint}'
    or retained_module_release.resolution_fingerprint is distinct from
      occurrence #>> '{definitionRelease,resolutionFingerprint}'
    or retained_module_release.validation_contract_version <>
      all (vortex_definition.accepted_contract_version('module'))
    or retained_module_release.source_contract_version is distinct from
      retained_module_release.validation_contract_version
    or retained_module_release.compilation_output #>> '{kind}' is distinct from 'module'
    or retained_module_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from selected_module_root_id::text
    or retained_module_release.compilation_output #>> '{validationContractVersion}'
      is distinct from retained_module_release.validation_contract_version then
    raise exception using errcode = '42501', message = 'Search retained Module release is unavailable';
  end if;

  retained_record_types := retained_module_release.compilation_output #> '{canonical,content,recordTypes}';
  current_record_types := current_module_release.compilation_output #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(retained_record_types) is distinct from 'array'
    or pg_catalog.jsonb_typeof(current_record_types) is distinct from 'array' then
    raise exception using errcode = '42501', message = 'Search Record type is unavailable';
  end if;

  select item.value into historical_record_type
  from pg_catalog.jsonb_array_elements(retained_record_types) as item(value)
  where item.value ->> 'recordTypeId' = selected_record_type_id::text
    and item.value ->> 'storageContractId' = selected_storage_contract_id::text;
  if not found or (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(retained_record_types) as item(value)
    where item.value ->> 'recordTypeId' = selected_record_type_id::text
      and item.value ->> 'storageContractId' = selected_storage_contract_id::text
  ) <> 1 then
    raise exception using errcode = '42501', message = 'Search retained Record type is unavailable';
  end if;

  select item.value into current_record_type
  from pg_catalog.jsonb_array_elements(current_record_types) as item(value)
  where item.value ->> 'recordTypeId' = selected_record_type_id::text
    and item.value ->> 'storageContractId' = selected_storage_contract_id::text;
  if not found or (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(current_record_types) as item(value)
    where item.value ->> 'recordTypeId' = selected_record_type_id::text
      and item.value ->> 'storageContractId' = selected_storage_contract_id::text
  ) <> 1
    or current_record_type ->> 'storageScope' is distinct from 'application_contained'
    or historical_record_type ->> 'storageScope' is distinct from 'application_contained'
    or pg_catalog.jsonb_typeof(current_record_type -> 'fields') is distinct from 'array'
    or pg_catalog.jsonb_typeof(historical_record_type -> 'fields') is distinct from 'array' then
    raise exception using errcode = '42501', message = 'Search current Record type is unavailable';
  end if;

  select coalesce(pg_catalog.array_agg((field.value ->> 'fieldId')::uuid order by
      pg_catalog.lower(field.value ->> 'fieldId') collate "C"), array[]::uuid[]),
    coalesce(pg_catalog.jsonb_agg(field.value order by
      pg_catalog.lower(field.value ->> 'fieldId') collate "C"), '[]'::jsonb)
  into selected_field_ids, selected_fields
  from pg_catalog.jsonb_array_elements(current_record_type -> 'fields') as field(value)
  where field.value ->> 'personalData' = 'none'
    and field.value ->> 'searchPriority' in ('first', 'normal', 'last')
    and field.value ->> 'type' in (
      'text', 'long_text', 'formatted_text', 'whole_number', 'decimal_number', 'date',
      'date_time', 'choice', 'several_choices', 'reference_number', 'email_address',
      'phone_number', 'web_address'
    )
    and vortex_context.is_non_nil_uuid(field.value ->> 'fieldId');

  if selected_fields is null or pg_catalog.jsonb_array_length(selected_fields) > 100 then
    raise exception using errcode = '42501', message = 'Search fields are unavailable';
  end if;
  projected_record_type := pg_catalog.jsonb_build_object(
    'recordTypeId', selected_record_type_id,
    'fields', selected_fields
  );

  trusted_record_plan := pg_catalog.jsonb_build_object(
    'occurrenceId', p_occurrence_id,
    'claimCursor', p_claim_cursor,
    'organizationId', selected_organization_id,
    'applicationRootId', selected_application_root_id,
    'applicationReleaseRevision', binding_row.application_release_revision,
    'moduleRootId', selected_module_root_id,
    'moduleReleaseRevision', binding_row.module_release_revision,
    'bindingRevision', binding_row.binding_revision,
    'storageContractId', selected_storage_contract_id,
    'recordTypeId', selected_record_type_id,
    'recordId', (occurrence ->> 'recordId')::uuid,
    'recordType', current_record_type,
    'fieldIds', pg_catalog.to_jsonb(selected_field_ids)
  );
  record_snapshot := vortex_record.read_search_index_record_internal(trusted_record_plan);

  if pg_catalog.jsonb_typeof(record_snapshot) is distinct from 'object'
    or record_snapshot ->> 'recordId' is distinct from occurrence ->> 'recordId'
    or record_snapshot ->> 'recordTypeId' is distinct from selected_record_type_id::text
    or record_snapshot ->> 'indexOrganisationId' is distinct from selected_organization_id::text
    or record_snapshot ->> 'ownerOrganisationId' is distinct from selected_organization_id::text
    or record_snapshot ->> 'applicationRootId' is distinct from selected_application_root_id::text
    or (record_snapshot ->> 'definitionRevision')::bigint not between 1 and 9007199254740991 then
    raise exception using errcode = '42501', message = 'Search Record snapshot is unavailable';
  end if;

  projected_snapshot := pg_catalog.jsonb_build_object(
    'indexOrganisationId', record_snapshot -> 'indexOrganisationId',
    'ownerOrganisationId', record_snapshot -> 'ownerOrganisationId',
    'applicationRootId', record_snapshot -> 'applicationRootId',
    'recordTypeId', record_snapshot -> 'recordTypeId',
    'recordId', record_snapshot -> 'recordId',
    'recordVersion', record_snapshot -> 'recordVersion',
    'lifecycle', record_snapshot -> 'lifecycle',
    'fieldValues', record_snapshot -> 'fieldValues'
  );

  return pg_catalog.jsonb_build_object(
    'occurrence', occurrence,
    'recordType', projected_record_type,
    'snapshot', projected_snapshot
  );
end
$function$;

alter function vortex_module.read_search_index_source(uuid, uuid)
  owner to vortex_module_owner;
revoke all on function vortex_module.read_search_index_source(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner,
    vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_module.read_search_index_source(uuid, uuid)
  to vortex_request, vortex_search_owner;
comment on function vortex_module.read_search_index_source(uuid, uuid) is
  'Returns only the current exact installed application-contained Search event source and bounded direct nonpersonal Record snapshot for one retained live SYSTEM claim; all selectors derive from immutable Event evidence and the current locked installation.';
reset role;

set local role vortex_search_owner;
create or replace function vortex_search.store_claimed_search_document(
  p_occurrence_id uuid,
  p_claim_cursor uuid,
  p_organization_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_application_root_id uuid,
  p_source_record_version bigint,
  p_deleted boolean,
  p_entries jsonb,
  p_content_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  authority jsonb;
  source_before jsonb;
  source_after jsonb;
  record_type jsonb;
  snapshot jsonb;
  entry jsonb;
  field jsonb;
  selected_field_ids text[] := array[]::text[];
  expected_weight integer;
  stored_outcome text;
  database_time timestamptz;
begin
  if p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_claim_cursor is null or p_claim_cursor = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id is null or p_record_type_id is null or p_record_id is null
    or p_application_root_id is null or p_source_record_version not between 1 and 9007199254740991
    or p_deleted is null or p_entries is null
    or (p_deleted and (p_entries is distinct from '[]'::jsonb or p_content_fingerprint is not null))
    or (not p_deleted and (p_content_fingerprint is null
      or p_content_fingerprint !~ '^sha256:[0-9a-f]{64}$'
      or not vortex_search.document_entries_are_valid(p_entries))) then
    raise exception using errcode = '22023', message = 'Search store command is invalid';
  end if;

  context_value := vortex_context.current_context();
  if context_value ->> 'callerKind' is distinct from 'system'
    or context_value ->> 'channel' is distinct from 'system'
    or context_value ? 'supportContext'
    or context_value ->> 'organizationId' is distinct from p_organization_id::text
    or context_value ->> 'applicationRootId' is distinct from p_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search store authority is unavailable';
  end if;
  authority := vortex_access.validated_search_index_request_context_internal(
    p_occurrence_id, p_claim_cursor
  );
  if authority ->> 'organizationId' is distinct from p_organization_id::text
    or authority ->> 'applicationRootId' is distinct from p_application_root_id::text
    or authority ->> 'storageScope' is distinct from 'application_contained'
    or authority ->> 'sequenceApplicationRootId' is distinct from p_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search store claim is unavailable';
  end if;

  source_before := vortex_module.read_search_index_source(p_occurrence_id, p_claim_cursor);
  record_type := source_before -> 'recordType';
  snapshot := source_before -> 'snapshot';
  if pg_catalog.jsonb_typeof(record_type) is distinct from 'object'
    or pg_catalog.jsonb_typeof(record_type -> 'fields') is distinct from 'array'
    or snapshot ->> 'indexOrganisationId' is distinct from p_organization_id::text
    or snapshot ->> 'ownerOrganisationId' is distinct from p_organization_id::text
    or snapshot ->> 'applicationRootId' is distinct from p_application_root_id::text
    or snapshot ->> 'recordTypeId' is distinct from p_record_type_id::text
    or snapshot ->> 'recordId' is distinct from p_record_id::text
    or (snapshot ->> 'recordVersion')::bigint is distinct from p_source_record_version
    or ((snapshot ->> 'lifecycle') = 'deleted') is distinct from p_deleted then
    raise exception using errcode = '42501', message = 'Search store source is unavailable';
  end if;

  if not p_deleted then
    for entry in
      select item.value from pg_catalog.jsonb_array_elements(p_entries) as item(value)
    loop
      select field.value into field
      from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') =
        pg_catalog.lower(entry ->> 'fieldId');
      if not found
        or field ->> 'personalData' is distinct from 'none'
        or field ->> 'searchPriority' is distinct from entry ->> 'priority'
        or field ->> 'type' not in (
          'text', 'long_text', 'formatted_text', 'whole_number', 'decimal_number', 'date',
          'date_time', 'choice', 'several_choices', 'reference_number', 'email_address',
          'phone_number', 'web_address'
        ) then
        raise exception using errcode = '42501', message = 'Search entry is not source-authorized';
      end if;
      expected_weight := case field ->> 'searchPriority'
        when 'first' then 3 when 'normal' then 2 when 'last' then 1 else null end;
      if (entry ->> 'weight')::numeric is distinct from expected_weight::numeric
        or (entry ->> 'fieldId') <> pg_catalog.lower(entry ->> 'fieldId')
        or (entry ->> 'fieldId') = any (selected_field_ids) then
        raise exception using errcode = '42501', message = 'Search entry is not canonical';
      end if;
      selected_field_ids := selected_field_ids || (entry ->> 'fieldId');
    end loop;
  end if;

  select stored.outcome into stored_outcome
  from vortex_search.put_document(
    p_organization_id,
    p_record_type_id,
    p_record_id,
    p_application_root_id,
    p_source_record_version,
    p_deleted,
    p_entries,
    p_content_fingerprint
  ) as stored;
  if stored_outcome not in (
    'stored', 'replaced', 'rebuilt', 'replayed', 'ignored_older', 'ignored_deleted'
  ) then
    raise exception using errcode = '55000', message = 'Search store outcome is unavailable';
  end if;

  source_after := vortex_module.read_search_index_source(p_occurrence_id, p_claim_cursor);
  database_time := pg_catalog.clock_timestamp();
  if source_after is distinct from source_before
    or (authority ->> 'leaseExpiresAt')::timestamptz <= database_time
    or (context_value ->> 'expiresAt')::timestamptz <= database_time then
    raise exception using errcode = '42501', message = 'Search claim expired or source changed';
  end if;
  perform vortex_access.validated_search_index_request_context_internal(
    p_occurrence_id, p_claim_cursor
  );

  return pg_catalog.jsonb_build_object('outcome', stored_outcome);
end
$function$;

alter function vortex_search.store_claimed_search_document(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) owner to vortex_search_owner;
revoke all on function vortex_search.store_claimed_search_document(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner,
  vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_search.store_claimed_search_document(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) to vortex_request;
comment on function vortex_search.store_claimed_search_document(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) is
  'Stores one bounded current document for the exact live Search claim and installed source in its SYSTEM transaction; ownership, scope, version, field identity and completion are revalidated around the canonical writer.';
reset role;

set local role vortex_search_owner;
create or replace function vortex_search.put_document(
  p_organization_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_application_root_id uuid,
  p_source_record_version bigint,
  p_deleted boolean,
  p_entries jsonb,
  p_content_fingerprint text
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored vortex_search.documents%rowtype;
  next_entries jsonb := case when p_deleted then '[]'::jsonb else p_entries end;
  next_fingerprint text := case when p_deleted then null else p_content_fingerprint end;
begin
  if p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_record_type_id is null or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or p_record_id is null or not vortex_context.is_non_nil_uuid(p_record_id::text)
    or (p_application_root_id is not null
      and not vortex_context.is_non_nil_uuid(p_application_root_id::text))
    or p_source_record_version is null
    or p_source_record_version not between 1 and 9007199254740991
    or p_deleted is null or p_entries is null then
    raise exception using errcode = '22023', message = 'Search document command is invalid';
  end if;

  -- The established request supplies the organisation; the caller only
  -- cross-checks it and cannot write into another organisation's index.
  if vortex_context.organization_id() is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Search document scope is unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', 'search_document',
      p_organization_id::text, p_record_type_id::text, p_record_id::text,
      coalesce(p_application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)::text), 643)
  );

  select existing.* into stored
  from vortex_search.documents as existing
  where existing.organization_id = p_organization_id
    and existing.record_type_id = p_record_type_id
    and existing.record_id = p_record_id
    and existing.application_root_id is not distinct from p_application_root_id;

  if found then
    if stored.source_record_version > p_source_record_version then
      return query select 'ignored_older'::text;
      return;
    end if;
    if stored.source_record_version = p_source_record_version then
      if stored.deleted then
        return query select
          case when p_deleted then 'replayed' else 'ignored_deleted' end::text;
        return;
      end if;
      if stored.deleted = p_deleted
        and stored.entries = next_entries
        and stored.content_fingerprint is not distinct from next_fingerprint
        and stored.application_root_id is not distinct from p_application_root_id then
        return query select 'replayed'::text;
        return;
      end if;
    end if;
    update vortex_search.documents as existing
    set application_root_id = p_application_root_id,
        source_record_version = p_source_record_version,
        deleted = p_deleted,
        entries = next_entries,
        content_fingerprint = next_fingerprint,
        updated_at = pg_catalog.statement_timestamp()
    where existing.organization_id = p_organization_id
      and existing.record_type_id = p_record_type_id
      and existing.record_id = p_record_id
      and existing.application_root_id is not distinct from p_application_root_id;
    return query select case
      when stored.source_record_version = p_source_record_version then 'rebuilt'
      else 'replaced'
    end::text;
    return;
  end if;

  insert into vortex_search.documents (
    organization_id, record_type_id, record_id, application_root_id,
    source_record_version, document_schema_version, deleted, entries,
    content_fingerprint
  ) values (
    p_organization_id, p_record_type_id, p_record_id, p_application_root_id,
    p_source_record_version, 1, p_deleted, next_entries, next_fingerprint
  );
  return query select 'stored'::text;
end
$function$;
revoke execute on function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) to vortex_request;

comment on function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) is
  'Stores one built search document or deletion marker for the request organisation and Application scope; an older source version never overwrites a newer one, and a same-version rebuild replaces changed content only within that scope.';

alter function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) owner to vortex_search_owner;
reset role;

commit;
