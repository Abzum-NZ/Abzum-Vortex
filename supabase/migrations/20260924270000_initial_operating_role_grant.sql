-- Issue #605: the Access-owned bounded first-owner setup operation. It accepts a
-- frozen, server-owned manifest that names the exact organisation, nominated
-- steward, installed management-application release, operating role acceptance,
-- provisioning receipt and expected setup revision. In one protected transaction
-- it binds that receipt and coordinates the existing owner-only role, assignment
-- and management-application requirement compositions, then records one idempotent
-- setup result. It accepts no browser-authored context and grants no later path.

create table vortex_access.organization_initial_operating_role_grants (
  organization_id uuid primary key,
  setup_revision bigint not null,
  provisioning_receipt_id uuid not null,
  setup_actor_id uuid not null,
  operating_role_id uuid not null,
  operating_role_revision bigint not null,
  role_assignment_id uuid not null,
  role_assignment_revision bigint not null,
  management_application_root_id uuid not null,
  management_application_release_revision bigint not null,
  management_required_role_revision bigint not null,
  access_version bigint not null,
  correlation_id uuid not null,
  manifest jsonb not null,
  established_at timestamptz not null,
  constraint organization_initial_operating_role_grants_ids_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and provisioning_receipt_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and setup_actor_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and operating_role_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and role_assignment_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and management_application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_initial_operating_role_grants_revisions_valid check (
    setup_revision between 1 and 9007199254740991
    and operating_role_revision between 1 and 9007199254740991
    and role_assignment_revision between 1 and 9007199254740991
    and management_application_release_revision between 1 and 9007199254740991
    and management_required_role_revision between 1 and 9007199254740991
    and access_version between 1 and 9007199254740991
  ),
  constraint organization_initial_operating_role_grants_manifest_valid check (
    pg_catalog.jsonb_typeof(manifest) = 'object'
  ),
  constraint organization_initial_operating_role_grants_time_valid check (
    established_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  ),
  constraint organization_initial_operating_role_grants_organization_fk
    foreign key (organization_id)
    references vortex_identity.organizations (organization_id),
  constraint organization_initial_operating_role_grants_role_fk
    foreign key (organization_id, operating_role_id)
    references vortex_access.organization_roles (organization_id, role_id),
  constraint organization_initial_operating_role_grants_assignment_fk
    foreign key (organization_id, role_assignment_id)
    references vortex_access.organization_role_assignments (
      organization_id, role_assignment_id
    )
);

alter table vortex_access.organization_initial_operating_role_grants
  enable row level security;
alter table vortex_access.organization_initial_operating_role_grants
  force row level security;

create function vortex_access.compose_initial_operating_role_grant(
  p_manifest jsonb
)
returns table (
  outcome text,
  organization_id uuid,
  operating_role_id uuid,
  operating_role_revision bigint,
  role_assignment_id uuid,
  role_assignment_revision bigint,
  management_application_root_id uuid,
  management_application_release_revision bigint,
  management_required_role_revision bigint,
  setup_revision bigint,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_access.organization_initial_operating_role_grants%rowtype;
  requirement vortex_access.organization_stewardship_requirements%rowtype;
  evidence jsonb;
  candidate jsonb;
  v_organization_id uuid;
  v_steward_account_id uuid;
  v_application_root_id uuid;
  v_release_revision bigint;
  v_registration_revision bigint;
  v_receipt_id uuid;
  v_setup_revision bigint;
  v_setup_actor_id uuid;
  v_correlation_id uuid;
  v_role_assignment_id uuid;
  v_operating_role_id uuid;
  v_operating_role_revision bigint;
  v_assignment_revision bigint;
  v_access_version bigint;
  operation_at timestamptz;
  role_changed record;
  assignment_changed record;
  requirement_changed record;
begin
  if p_manifest is null
    or pg_catalog.jsonb_typeof(p_manifest) is distinct from 'object'
    or p_manifest - array[
      'manifestVersion', 'organizationId', 'stewardOrganizationAccountId',
      'applicationRootId', 'applicationReleaseRevision',
      'provisioningReceiptId', 'setupRevision', 'setupActorId',
      'correlationId', 'roleAssignmentId', 'operatingRoleChangeEvidence'
    ]::text[] <> '{}'::jsonb
    or not (p_manifest ?& array[
      'manifestVersion', 'organizationId', 'stewardOrganizationAccountId',
      'applicationRootId', 'applicationReleaseRevision',
      'provisioningReceiptId', 'setupRevision', 'setupActorId',
      'correlationId', 'roleAssignmentId', 'operatingRoleChangeEvidence'
    ])
    or p_manifest ->> 'manifestVersion' is distinct from '1.0.0'
    or pg_catalog.jsonb_typeof(p_manifest -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_manifest -> 'stewardOrganizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_manifest -> 'applicationRootId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_manifest -> 'applicationReleaseRevision') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_manifest -> 'provisioningReceiptId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_manifest -> 'setupRevision') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_manifest -> 'setupActorId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_manifest -> 'correlationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_manifest -> 'roleAssignmentId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_manifest -> 'operatingRoleChangeEvidence') is distinct from 'object'
    or not vortex_context.is_non_nil_uuid(p_manifest ->> 'organizationId')
    or not vortex_context.is_non_nil_uuid(p_manifest ->> 'stewardOrganizationAccountId')
    or not vortex_context.is_non_nil_uuid(p_manifest ->> 'applicationRootId')
    or not vortex_context.is_non_nil_uuid(p_manifest ->> 'provisioningReceiptId')
    or not vortex_context.is_non_nil_uuid(p_manifest ->> 'setupActorId')
    or not vortex_context.is_non_nil_uuid(p_manifest ->> 'correlationId')
    or not vortex_context.is_non_nil_uuid(p_manifest ->> 'roleAssignmentId')
    or (p_manifest ->> 'applicationReleaseRevision')::numeric not between
      1 and 9007199254740991
    or (p_manifest ->> 'applicationReleaseRevision')::numeric <>
      pg_catalog.trunc((p_manifest ->> 'applicationReleaseRevision')::numeric)
    or (p_manifest ->> 'setupRevision')::numeric not between
      1 and 9007199254740991
    or (p_manifest ->> 'setupRevision')::numeric <>
      pg_catalog.trunc((p_manifest ->> 'setupRevision')::numeric) then
    raise exception using errcode = '22023',
      message = 'Initial operating-role grant manifest is invalid';
  end if;

  v_organization_id := (p_manifest ->> 'organizationId')::uuid;
  v_steward_account_id := (p_manifest ->> 'stewardOrganizationAccountId')::uuid;
  v_application_root_id := (p_manifest ->> 'applicationRootId')::uuid;
  v_release_revision := (p_manifest ->> 'applicationReleaseRevision')::numeric::bigint;
  v_receipt_id := (p_manifest ->> 'provisioningReceiptId')::uuid;
  v_setup_revision := (p_manifest ->> 'setupRevision')::numeric::bigint;
  v_setup_actor_id := (p_manifest ->> 'setupActorId')::uuid;
  v_correlation_id := (p_manifest ->> 'correlationId')::uuid;
  v_role_assignment_id := (p_manifest ->> 'roleAssignmentId')::uuid;

  evidence := p_manifest -> 'operatingRoleChangeEvidence';
  candidate := evidence -> 'candidate';
  if pg_catalog.jsonb_typeof(candidate) is distinct from 'object'
    or candidate ->> 'operation' is distinct from 'accept_new_application_role'
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string'
    or not vortex_context.is_non_nil_uuid(candidate ->> 'roleId')
    or pg_catalog.jsonb_typeof(candidate -> 'organizationId') is distinct from 'string'
    or (candidate ->> 'organizationId')::uuid <> v_organization_id
    or candidate #>> '{preparedTemplates,preparationBasis,kind}'
      is distinct from 'current_active_registration'
    or (candidate #>>
      '{preparedTemplates,permissionRegistration,organizationId}')::uuid
      <> v_organization_id
    or (candidate #>>
      '{preparedTemplates,permissionRegistration,applicationRootId}')::uuid
      <> v_application_root_id
    or (candidate #>>
      '{preparedTemplates,permissionRegistration,applicationRelease,releaseRevision}')::numeric::bigint
      <> v_release_revision
    or pg_catalog.jsonb_typeof(
      candidate #> '{preparedTemplates,preparationBasis,registrationRevision}'
    ) is distinct from 'number'
    or (candidate #>>
      '{preparedTemplates,preparationBasis,registrationRevision}')::numeric
        not between 1 and 9007199254740991
    or (candidate #>>
      '{preparedTemplates,preparationBasis,registrationRevision}')::numeric <>
        pg_catalog.trunc((candidate #>>
          '{preparedTemplates,preparationBasis,registrationRevision}')::numeric)
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate -> 'permissions') as item(value)
      where item.value ->> 'ownerKind' is distinct from 'application'
        or (item.value ->> 'applicationRootId')::uuid <> v_application_root_id
        or (item.value ->> 'ownerId')::uuid <> v_application_root_id
    ) then
    raise exception using errcode = '22023',
      message = 'Initial operating-role grant evidence is invalid';
  end if;
  v_operating_role_id := (candidate ->> 'roleId')::uuid;
  v_registration_revision :=
    (candidate #>> '{preparedTemplates,preparationBasis,registrationRevision}')::numeric::bigint;

  -- The governance lock orders every Access writer; the organisation and tenant
  -- must still be live and the manifest organisation is the only target.
  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = v_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Initial operating-role grant scope is unavailable';
  end if;

  select stored.* into existing
  from vortex_access.organization_initial_operating_role_grants as stored
  where stored.organization_id = v_organization_id
  for update;
  if found then
    if existing.manifest = p_manifest then
      return query select 'replayed'::text, existing.organization_id,
        existing.operating_role_id, existing.operating_role_revision,
        existing.role_assignment_id, existing.role_assignment_revision,
        existing.management_application_root_id,
        existing.management_application_release_revision,
        existing.management_required_role_revision, existing.setup_revision,
        existing.access_version, existing.correlation_id;
      return;
    end if;
    raise exception using errcode = '40001',
      message = 'Initial operating-role grant is already established for this organisation';
  end if;

  -- The provisioning receipt is the only setup authority. It must match the
  -- exact accepted provisioning actor, organisation and nominated steward.
  perform 1
  from vortex_identity.accepted_administration_receipts as receipt
  where receipt.receipt_id = v_receipt_id
    and receipt.operation_key = 'provision_tenant'
    and receipt.actor_id = v_setup_actor_id
    and receipt.subject_ids @> array[v_organization_id, v_steward_account_id]::uuid[];
  if not found then
    raise exception using errcode = '42501',
      message = 'Initial operating-role grant receipt is unavailable';
  end if;

  perform 1
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as identity
    on identity.identity_id = account.identity_id
    and identity.state = 'active'
  where account.organization_id = v_organization_id
    and account.organization_account_id = v_steward_account_id
    and account.state = 'active'
  for update of account;
  if not found then
    raise exception using errcode = '40001',
      message = 'Initial operating-role grant steward is unavailable';
  end if;

  select stored.* into requirement
  from vortex_access.organization_stewardship_requirements as stored
  where stored.organization_id = v_organization_id
  for update;
  if not found
    or requirement.management_application_root_id is not null
    or requirement.original_organization_account_id <> v_steward_account_id then
    raise exception using errcode = '40001',
      message = 'Initial operating-role grant stewardship evidence is unavailable';
  end if;

  -- The management application release must already be the exact active
  -- registration the operating-role evidence was prepared against.
  perform 1
  from vortex_access.permission_registrations as registration
  where registration.organization_id = v_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = v_application_root_id
    and registration.state = 'active'
    and registration.revision = v_registration_revision
  for update;
  if not found then
    raise exception using errcode = '40001',
      message = 'Initial operating-role grant application release is unavailable';
  end if;

  operation_at := pg_catalog.clock_timestamp();

  -- 1. Accept the exact operating application role from the frozen evidence.
  select changed.* into strict role_changed
  from vortex_access.coordinate_organization_role_change(
    evidence, v_setup_actor_id, v_correlation_id
  ) as changed;
  if role_changed.outcome is distinct from 'changed'
    or (role_changed.role ->> 'roleId')::uuid <> v_operating_role_id then
    raise exception using errcode = '55000',
      message = 'Initial operating-role grant role result is inconsistent';
  end if;
  v_operating_role_revision :=
    (role_changed.role ->> 'liveRevision')::numeric::bigint;

  -- 2. Grant the nominated steward one direct, standing, permanent assignment.
  select changed.* into strict assignment_changed
  from vortex_access.coordinate_organization_role_assignment_change(
    'grant', v_organization_id, v_role_assignment_id, null,
    v_operating_role_id, v_operating_role_revision, 'organization_account',
    v_steward_account_id, null, 'standing', operation_at, null,
    v_setup_actor_id, v_correlation_id
  ) as changed;
  if assignment_changed.outcome is distinct from 'changed'
    or assignment_changed.role_assignment_id is distinct from v_role_assignment_id
    or assignment_changed.organization_account_id is distinct from v_steward_account_id then
    raise exception using errcode = '55000',
      message = 'Initial operating-role grant assignment result is inconsistent';
  end if;
  v_assignment_revision := assignment_changed.revision;

  -- 3. Bind the exact management-application requirement to that same role.
  select changed.* into strict requirement_changed
  from vortex_access.coordinate_organization_management_application_requirement(
    'activate_management_application_requirement', v_organization_id,
    requirement.revision, v_application_root_id, v_operating_role_id,
    v_operating_role_revision, v_setup_actor_id, v_correlation_id
  ) as changed;
  if requirement_changed.outcome is distinct from 'changed' then
    raise exception using errcode = '55000',
      message = 'Initial operating-role grant requirement result is inconsistent';
  end if;
  v_access_version := requirement_changed.access_version;

  insert into vortex_access.organization_initial_operating_role_grants (
    organization_id, setup_revision, provisioning_receipt_id, setup_actor_id,
    operating_role_id, operating_role_revision, role_assignment_id,
    role_assignment_revision, management_application_root_id,
    management_application_release_revision, management_required_role_revision,
    access_version, correlation_id, manifest, established_at
  ) values (
    v_organization_id, v_setup_revision, v_receipt_id, v_setup_actor_id,
    v_operating_role_id, v_operating_role_revision, v_role_assignment_id,
    v_assignment_revision, v_application_root_id, v_release_revision,
    v_operating_role_revision, v_access_version, v_correlation_id, p_manifest,
    operation_at
  );

  return query select 'established'::text, v_organization_id,
    v_operating_role_id, v_operating_role_revision, v_role_assignment_id,
    v_assignment_revision, v_application_root_id, v_release_revision,
    v_operating_role_revision, v_setup_revision, v_access_version,
    v_correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value then
    raise exception using errcode = '22023',
      message = 'Initial operating-role grant manifest is invalid';
end
$function$;

revoke all on table vortex_access.organization_initial_operating_role_grants
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

revoke execute on function
  vortex_access.compose_initial_operating_role_grant(jsonb)
from public, anon, authenticated, service_role, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function
  vortex_access.compose_initial_operating_role_grant(jsonb)
to vortex_runtime;

comment on table vortex_access.organization_initial_operating_role_grants is
  'Private idempotent ledger of one bounded first-owner setup per organisation; the frozen manifest is retained so only the exact original retry replays.';
comment on function vortex_access.compose_initial_operating_role_grant(jsonb) is
  'Owner-only bounded first-owner setup: binds the provisioning receipt and coordinates the exact role, assignment and management-application requirement compositions once, or replays the original result.';
