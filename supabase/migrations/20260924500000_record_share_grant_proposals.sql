-- #727: persist exact record-share grant proposals and their lifecycle.
--
-- contracts/src/identity-access.ts defines accessGrantSchema and
-- grantConsentRequestSchema but nothing stored them. This migration adds the
-- protected storage and the four fixed Access operations the runtime service
-- (runtime/access/src/record-share-grants.ts) calls:
--
--   propose_record_share_grant_for_administration
--   revise_record_share_grant_for_administration
--   withdraw_record_share_grant_for_administration
--   get_record_share_grant_for_administration
--
-- A proposal is only ever draft (inside one organisation), pending_consent
-- (between organisations) or revoked (withdrawn before activation). Nothing here
-- activates a grant: activation needs the protected two-sided consent (#154,
-- #729/#730), which does not exist yet, so the stored status set is fixed to
-- these three values and a cross-organisation proposal stops at pending_consent.
--
-- The source organisation, account and application always come from the
-- validated human request context; the caller supplies only the proposed terms.
-- The proposer must currently hold the share permission for the exact record
-- type (and, for a single record, the exact record with read/update ceilings on
-- the proposed fields), evaluated fresh under the organisation Access-version
-- lock. A grant can never carry delete, restore, permission-change, ownership
-- transfer or re-sharing authority. The definition mapping fingerprint is
-- stored exactly as supplied; compatibility enforcement belongs to #728/#739.

create table vortex_access.record_share_grants (
  grant_id uuid primary key,
  source_organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  source_cluster_id uuid not null,
  source_application_root_id uuid not null,
  recipient_cluster_id uuid not null,
  recipient_organization_id uuid not null,
  recipient_application_root_id uuid not null,
  scope_kind text not null,
  module_root_id uuid not null,
  record_type_id uuid,
  record_id uuid,
  saved_condition_id uuid,
  saved_condition_revision bigint,
  saved_condition_fingerprint text,
  saved_condition_parameters jsonb,
  readable_field_ids uuid[] not null,
  changeable_field_ids uuid[] not null,
  recipient_role_ids uuid[] not null,
  allowed_action_keys text[] not null,
  export_allowed boolean not null,
  approved_recipient_region text not null,
  starts_at timestamptz not null,
  expires_at timestamptz,
  status text not null,
  created_by_organization_account_id uuid not null,
  consent_request_id uuid,
  contract_version text not null,
  contract_fingerprint text not null,
  recipient_binding_id uuid not null,
  definition_mapping_fingerprint text not null,
  proposal_fingerprint text not null,
  revoked_at timestamptz,
  revoked_by_organization_account_id uuid,
  revocation_reason text,
  revision bigint not null,
  created_at timestamptz not null,
  changed_at timestamptz not null,
  constraint record_share_grants_ids_non_nil check (
    grant_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and source_cluster_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and source_application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and recipient_cluster_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and recipient_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and recipient_application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and module_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and recipient_binding_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and created_by_organization_account_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint record_share_grants_scope_shape check (
    (scope_kind = 'module'
      and record_type_id is null and record_id is null
      and saved_condition_id is null and saved_condition_revision is null
      and saved_condition_fingerprint is null and saved_condition_parameters is null)
    or (scope_kind = 'record_type'
      and record_type_id is not null and record_id is null
      and saved_condition_id is null and saved_condition_revision is null
      and saved_condition_fingerprint is null and saved_condition_parameters is null)
    or (scope_kind = 'saved_condition'
      and record_type_id is not null and record_id is null
      and saved_condition_id is not null and saved_condition_revision is not null
      and saved_condition_fingerprint is not null
      and saved_condition_parameters is not null
      and pg_catalog.jsonb_typeof(saved_condition_parameters) = 'object')
    or (scope_kind = 'record'
      and record_type_id is not null and record_id is not null
      and saved_condition_id is null and saved_condition_revision is null
      and saved_condition_fingerprint is null and saved_condition_parameters is null)
  ),
  constraint record_share_grants_fields_valid check (
    pg_catalog.cardinality(readable_field_ids) between 1 and 500
    and pg_catalog.cardinality(changeable_field_ids) <= 500
    and changeable_field_ids <@ readable_field_ids
    and pg_catalog.cardinality(recipient_role_ids) between 1 and 100
    and pg_catalog.cardinality(allowed_action_keys) <= 100
  ),
  constraint record_share_grants_window_valid check (
    expires_at is null or expires_at > starts_at
  ),
  constraint record_share_grants_fingerprints_valid check (
    contract_fingerprint ~ '^sha256:[a-f0-9]{64}$'
    and definition_mapping_fingerprint ~ '^sha256:[a-f0-9]{64}$'
    and proposal_fingerprint ~ '^sha256:[a-f0-9]{64}$'
    and (saved_condition_fingerprint is null
      or saved_condition_fingerprint ~ '^sha256:[a-f0-9]{64}$')
  ),
  -- Only pre-activation lifecycle states exist until protected consent (#154).
  constraint record_share_grants_status_proposal_only check (
    status in ('draft', 'pending_consent', 'revoked')
  ),
  constraint record_share_grants_consent_shape check (
    (source_organization_id = recipient_organization_id
      and consent_request_id is null and status in ('draft', 'revoked'))
    or (source_organization_id <> recipient_organization_id
      and consent_request_id is not null and expires_at is not null
      and status in ('pending_consent', 'revoked'))
  ),
  constraint record_share_grants_revocation_shape check (
    (status = 'revoked') = (
      revoked_at is not null
      and revoked_by_organization_account_id is not null
      and revocation_reason is not null
    )
    and (revocation_reason is null
      or pg_catalog.char_length(revocation_reason) between 1 and 500)
    and (revoked_at is null or revoked_at = changed_at)
  ),
  constraint record_share_grants_revision_range check (
    revision between 1 and 9007199254740991
  )
);

create index record_share_grants_source_idx
  on vortex_access.record_share_grants (source_organization_id, changed_at desc);
create index record_share_grants_recipient_idx
  on vortex_access.record_share_grants (recipient_organization_id, changed_at desc);
create unique index record_share_grants_consent_request_unique
  on vortex_access.record_share_grants (consent_request_id)
  where consent_request_id is not null;

alter table vortex_access.record_share_grants enable row level security;
alter table vortex_access.record_share_grants force row level security;

create table vortex_access.record_share_grant_consent_requests (
  request_id uuid primary key,
  grant_id uuid not null unique
    references vortex_access.record_share_grants (grant_id),
  source_organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  source_cluster_id uuid not null,
  recipient_organization_id uuid not null,
  recipient_cluster_id uuid not null,
  proposed_grant_fingerprint text not null,
  status text not null,
  requested_by_organization_account_id uuid not null,
  requested_at timestamptz not null,
  source_authorizing_role_ids uuid[] not null,
  recipient_accepting_role_ids uuid[] not null,
  expires_at timestamptz not null,
  revision bigint not null,
  changed_at timestamptz not null,
  constraint record_share_grant_consent_requests_ids_non_nil check (
    request_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and requested_by_organization_account_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint record_share_grant_consent_requests_cross_organization check (
    source_organization_id <> recipient_organization_id
  ),
  constraint record_share_grant_consent_requests_fingerprint check (
    proposed_grant_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  -- No decision is recorded here yet; #729/#730 own decisions and activation.
  constraint record_share_grant_consent_requests_status check (
    status in ('pending', 'withdrawn')
  ),
  constraint record_share_grant_consent_requests_roles check (
    pg_catalog.cardinality(source_authorizing_role_ids) between 1 and 100
    and pg_catalog.cardinality(recipient_accepting_role_ids) between 1 and 100
  ),
  constraint record_share_grant_consent_requests_revision_range check (
    revision between 1 and 9007199254740991
  )
);

alter table vortex_access.record_share_grant_consent_requests enable row level security;
alter table vortex_access.record_share_grant_consent_requests force row level security;

alter table vortex_access.record_share_grants
  add constraint record_share_grants_consent_request_fk
  foreign key (consent_request_id)
  references vortex_access.record_share_grant_consent_requests (request_id)
  deferrable initially deferred;

revoke all on table vortex_access.record_share_grants
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;
revoke all on table vortex_access.record_share_grant_consent_requests
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;

comment on table vortex_access.record_share_grants is
  'Protected record-share grant proposals (draft, pending_consent or withdrawn); nothing activates without protected consent (#154).';
comment on table vortex_access.record_share_grant_consent_requests is
  'Protected cross-organisation consent request bound to the current proposal fingerprint of one grant; decisions are recorded by the consent lifecycle (#729/#730).';

-- Parses a JSON array of distinct non-nil UUIDs into a uuid[] (order kept).
create function vortex_access.record_share_grant_uuid_array_internal(
  p_value jsonb,
  p_minimum integer,
  p_maximum integer
)
returns uuid[]
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  parsed uuid[];
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'array' then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;
  select coalesce(pg_catalog.array_agg(item.value::uuid order by item.ordinality), array[]::uuid[])
  into parsed
  from pg_catalog.jsonb_array_elements_text(p_value) with ordinality as item(value, ordinality);
  if pg_catalog.cardinality(parsed) not between p_minimum and p_maximum
    or (select pg_catalog.count(distinct element) from pg_catalog.unnest(parsed) as element)
      <> pg_catalog.cardinality(parsed)
    or '00000000-0000-0000-0000-000000000000'::uuid = any (parsed) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;
  return parsed;
end
$function$;

-- Serialises one stored grant, with its consent request, in the camelCase shape
-- accessGrantSchema and grantConsentRequestSchema parse.
create function vortex_access.record_share_grant_json_internal(p_grant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  stored vortex_access.record_share_grants%rowtype;
  consent vortex_access.record_share_grant_consent_requests%rowtype;
  grant_json jsonb;
  consent_json jsonb := null;
begin
  select grants.* into strict stored
  from vortex_access.record_share_grants as grants
  where grants.grant_id = p_grant_id;

  grant_json := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'scopeKind', stored.scope_kind,
    'grantId', stored.grant_id,
    'sourceClusterId', stored.source_cluster_id,
    'sourceOrganizationId', stored.source_organization_id,
    'sourceApplicationRootId', stored.source_application_root_id,
    'recipientClusterId', stored.recipient_cluster_id,
    'recipientOrganizationId', stored.recipient_organization_id,
    'recipientApplicationRootId', stored.recipient_application_root_id,
    'readableFieldIds', pg_catalog.to_jsonb(stored.readable_field_ids),
    'changeableFieldIds', pg_catalog.to_jsonb(stored.changeable_field_ids),
    'recipientRoleIds', pg_catalog.to_jsonb(stored.recipient_role_ids),
    'moduleRootId', stored.module_root_id,
    'allowedActionKeys', pg_catalog.to_jsonb(stored.allowed_action_keys),
    'exportAllowed', stored.export_allowed,
    'approvedRecipientRegion', stored.approved_recipient_region,
    'startsAt', pg_catalog.to_char(
      stored.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'expiresAt', case when stored.expires_at is null then null else pg_catalog.to_char(
      stored.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) end,
    'status', stored.status,
    'createdByOrganizationAccountId', stored.created_by_organization_account_id,
    'consentRequestId', stored.consent_request_id,
    'contractVersion', stored.contract_version,
    'contractFingerprint', stored.contract_fingerprint,
    'recipientBindingId', stored.recipient_binding_id,
    'definitionMappingFingerprint', stored.definition_mapping_fingerprint,
    'recordTypeId', stored.record_type_id,
    'recordId', stored.record_id,
    'savedConditionId', stored.saved_condition_id,
    'savedConditionRevision', stored.saved_condition_revision,
    'savedConditionFingerprint', stored.saved_condition_fingerprint,
    'revokedAt', case when stored.revoked_at is null then null else pg_catalog.to_char(
      stored.revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) end,
    'revokedByOrganizationAccountId', stored.revoked_by_organization_account_id,
    'revocationReason', stored.revocation_reason
  ))
  -- Parameters are added after null stripping so a saved condition's exact
  -- parameter object survives unchanged.
  || case when stored.scope_kind = 'saved_condition'
    then pg_catalog.jsonb_build_object('parameters', stored.saved_condition_parameters)
    else '{}'::jsonb end;

  if stored.consent_request_id is not null then
    select requests.* into strict consent
    from vortex_access.record_share_grant_consent_requests as requests
    where requests.request_id = stored.consent_request_id;
    consent_json := pg_catalog.jsonb_build_object(
      'requestId', consent.request_id,
      'sourceOrganizationId', consent.source_organization_id,
      'sourceClusterId', consent.source_cluster_id,
      'recipientOrganizationId', consent.recipient_organization_id,
      'recipientClusterId', consent.recipient_cluster_id,
      'proposedGrantFingerprint', consent.proposed_grant_fingerprint,
      'status', consent.status,
      'requestedByOrganizationAccountId', consent.requested_by_organization_account_id,
      'requestedAt', pg_catalog.to_char(
        consent.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'requiredDecisions', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'side', 'source_authorization',
          'authorizedRoleIds', pg_catalog.to_jsonb(consent.source_authorizing_role_ids)
        ),
        pg_catalog.jsonb_build_object(
          'side', 'recipient_acceptance',
          'authorizedRoleIds', pg_catalog.to_jsonb(consent.recipient_accepting_role_ids)
        )
      ),
      'expiresAt', pg_catalog.to_char(
        consent.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'grant', grant_json,
    'consentRequest', consent_json,
    'proposalFingerprint', stored.proposal_fingerprint,
    'revision', stored.revision,
    'changedAt', pg_catalog.to_char(
      stored.changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$function$;

-- Validates one proposal's terms and the proposer's current source authority.
-- The caller has already established the validated request context and taken
-- the organisation Access-version lock; both are passed in, never re-derived
-- from the terms. Raises 22023 for an invalid proposal and 42501 when the
-- proposer lacks authority; it changes nothing.
create function vortex_access.check_record_share_grant_terms_internal(
  p_terms jsonb,
  p_facts jsonb,
  p_organization_id uuid,
  p_application_root_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_kind_value text;
  module_id uuid;
  type_id uuid;
  record_value uuid;
  recipient_org uuid;
  recipient_cluster uuid;
  source_cluster uuid;
  recipient_app uuid;
  readable uuid[];
  changeable uuid[];
  recipient_roles uuid[];
  source_roles uuid[];
  recipient_accept_roles uuid[];
  action_keys text[];
  starts_value timestamptz;
  expires_value timestamptz;
  cross_organization boolean;
  needed record;
  entry record;
  required_permissions jsonb;
  declaration jsonb;
  decision jsonb;
  bounds jsonb;
  facts_binding jsonb;
  read_admitted boolean := false;
  readable_ceiling uuid[] := array[]::uuid[];
  changeable_ceiling uuid[] := array[]::uuid[];
  eligibility record;
  share_admitted boolean := false;
begin
  if p_terms is null or pg_catalog.jsonb_typeof(p_terms) <> 'object'
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_terms) as supplied(key)
      where supplied.key <> all (array[
        'scopeKind', 'sourceClusterId', 'recipientClusterId', 'recipientOrganizationId',
        'recipientApplicationRootId', 'moduleRootId', 'recordTypeId', 'recordId',
        'savedConditionId', 'savedConditionRevision', 'savedConditionFingerprint',
        'parameters', 'readableFieldIds', 'changeableFieldIds', 'recipientRoleIds',
        'allowedActionKeys', 'exportAllowed', 'approvedRecipientRegion', 'startsAt',
        'expiresAt', 'contractVersion', 'contractFingerprint', 'recipientBindingId',
        'definitionMappingFingerprint', 'sourceAuthorizingRoleIds',
        'recipientAcceptingRoleIds'
      ])
    ) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  scope_kind_value := p_terms ->> 'scopeKind';
  module_id := (p_terms ->> 'moduleRootId')::uuid;
  type_id := (p_terms ->> 'recordTypeId')::uuid;
  record_value := (p_terms ->> 'recordId')::uuid;
  recipient_org := (p_terms ->> 'recipientOrganizationId')::uuid;
  recipient_cluster := (p_terms ->> 'recipientClusterId')::uuid;
  source_cluster := (p_terms ->> 'sourceClusterId')::uuid;
  recipient_app := (p_terms ->> 'recipientApplicationRootId')::uuid;
  starts_value := (p_terms ->> 'startsAt')::timestamptz;
  expires_value := (p_terms ->> 'expiresAt')::timestamptz;
  readable := vortex_access.record_share_grant_uuid_array_internal(
    p_terms -> 'readableFieldIds', 1, 500);
  changeable := vortex_access.record_share_grant_uuid_array_internal(
    p_terms -> 'changeableFieldIds', 0, 500);
  recipient_roles := vortex_access.record_share_grant_uuid_array_internal(
    p_terms -> 'recipientRoleIds', 1, 100);
  cross_organization := recipient_org <> p_organization_id;

  select coalesce(pg_catalog.array_agg(item.value order by item.ordinality), array[]::text[])
  into action_keys
  from pg_catalog.jsonb_array_elements_text(
    case when pg_catalog.jsonb_typeof(p_terms -> 'allowedActionKeys') = 'array'
      then p_terms -> 'allowedActionKeys' else '[]'::jsonb end
  ) with ordinality as item(value, ordinality);

  if scope_kind_value is null
    or scope_kind_value not in ('module', 'record_type', 'saved_condition', 'record')
    or module_id is null or recipient_org is null or recipient_cluster is null
    or source_cluster is null or recipient_app is null or starts_value is null
    or pg_catalog.jsonb_typeof(p_terms -> 'exportAllowed') <> 'boolean'
    or pg_catalog.jsonb_typeof(p_terms -> 'allowedActionKeys') <> 'array'
    or pg_catalog.cardinality(action_keys) > 100
    or (select pg_catalog.count(distinct action_key) from pg_catalog.unnest(action_keys) as action_key)
      <> pg_catalog.cardinality(action_keys)
    or p_terms ->> 'approvedRecipientRegion' is null
    or pg_catalog.char_length(p_terms ->> 'approvedRecipientRegion') not between 2 and 100
    or p_terms ->> 'contractVersion' is null
    or p_terms ->> 'contractFingerprint' !~ '^sha256:[a-f0-9]{64}$'
    or p_terms ->> 'definitionMappingFingerprint' !~ '^sha256:[a-f0-9]{64}$'
    or (p_terms ->> 'recipientBindingId')::uuid is null
    or starts_value in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (expires_value is not null and (
      expires_value <= starts_value
      or expires_value in ('-infinity'::timestamptz, 'infinity'::timestamptz)))
    or not (changeable <@ readable)
    or (scope_kind_value = 'module' and (type_id is not null or record_value is not null))
    or (scope_kind_value <> 'module' and type_id is null)
    or (scope_kind_value = 'record' and record_value is null)
    or (scope_kind_value <> 'record' and record_value is not null)
    or (scope_kind_value = 'saved_condition' and (
      (p_terms ->> 'savedConditionId')::uuid is null
      or (p_terms ->> 'savedConditionRevision')::bigint is null
      or (p_terms ->> 'savedConditionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pg_catalog.jsonb_typeof(p_terms -> 'parameters') <> 'object'))
    or (scope_kind_value <> 'saved_condition' and (
      p_terms ? 'savedConditionId' or p_terms ? 'savedConditionRevision'
      or p_terms ? 'savedConditionFingerprint' or p_terms ? 'parameters'))
    or (cross_organization and expires_value is null) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  -- A grant never carries delete, restore, permission-change, ownership
  -- transfer or re-sharing authority, whatever the recipient roles hold.
  if exists (
    select 1
    from pg_catalog.unnest(action_keys) as action_key
    where action_key !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
      or exists (
        select 1
        from pg_catalog.regexp_split_to_table(action_key, '[._]') as part
        where part in (
          'delete', 'restore', 'share', 'reshare', 'permission', 'permissions',
          'ownership', 'transfer', 'grant', 'revoke', 'role', 'roles', 'administer'
        )
      )
  ) then
    raise exception using errcode = '22023',
      message = 'A record-share grant cannot authorise that action';
  end if;

  -- The source side is always the caller's own organisation and application.
  if p_terms ? 'sourceOrganizationId' then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  if cross_organization then
    source_roles := vortex_access.record_share_grant_uuid_array_internal(
      p_terms -> 'sourceAuthorizingRoleIds', 1, 100);
    recipient_accept_roles := vortex_access.record_share_grant_uuid_array_internal(
      p_terms -> 'recipientAcceptingRoleIds', 1, 100);
    if exists (
      select 1 from pg_catalog.unnest(source_roles) as wanted(role_value)
      where not exists (
        select 1 from vortex_access.organization_roles as org_role
        where org_role.organization_id = p_organization_id
          and org_role.role_id = wanted.role_value
          and (org_role.application_root_id is null
            or org_role.application_root_id = p_application_root_id)
      )
    ) then
      raise exception using errcode = '22023',
        message = 'Record-share grant source authorising roles are unavailable';
    end if;
  elsif p_terms ? 'sourceAuthorizingRoleIds' or p_terms ? 'recipientAcceptingRoleIds' then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  -- Same-cluster recipients can be verified here: the recipient organisation
  -- must be active, the recipient application an exact active installation and
  -- every recipient role one of that organisation's. A recipient on another
  -- cluster cannot be read from this database; its identities are recorded as
  -- proposed and remain unverified until protected consent (#154).
  if recipient_cluster = source_cluster then
    if not exists (
      select 1
      from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
      where organization.organization_id = recipient_org
        and organization.state = 'active'
        and tenant.state = 'active'
    ) then
      raise exception using errcode = '42501',
        message = 'Record-share grant recipient is unavailable';
    end if;
    if not exists (
      select 1
      from vortex_access.permission_registrations as registration
      join vortex_definition.roots as root
        on root.root_id = registration.registration_owner_id
        and root.organization_id = registration.organization_id
        and root.kind = 'application'
      where registration.organization_id = recipient_org
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = recipient_app
        and registration.state = 'active'
        and exists (
          select 1
          from vortex_module.installation_bindings as binding
          where binding.organization_id = recipient_org
            and binding.application_root_id = recipient_app
            and binding.application_release_revision = registration.source_revision
            and binding.state = 'active'
        )
    ) then
      raise exception using errcode = '42501',
        message = 'Record-share grant recipient application is unavailable';
    end if;
    if exists (
      select 1 from pg_catalog.unnest(recipient_roles) as wanted(role_value)
      where not exists (
        select 1 from vortex_access.organization_roles as org_role
        where org_role.organization_id = recipient_org
          and org_role.role_id = wanted.role_value
          and (org_role.application_root_id is null
            or org_role.application_root_id = recipient_app)
      )
    ) then
      raise exception using errcode = '42501',
        message = 'Record-share grant recipient roles are unavailable';
    end if;
  end if;

  -- Source authority. Every scope needs a current share permission for the
  -- exact record type; a single record is decided against its real facts with
  -- the proposer's own read and update ceilings on the proposed fields.
  if scope_kind_value = 'record' then
    if p_facts is null or pg_catalog.jsonb_typeof(p_facts) <> 'object'
      or pg_catalog.jsonb_typeof(p_facts -> 'binding') <> 'object' then
      raise exception using errcode = '22023',
        message = 'Record-share grant proposal is invalid';
    end if;
    facts_binding := p_facts -> 'binding';
    if (facts_binding ->> 'moduleRootId')::uuid is distinct from module_id
      or (facts_binding ->> 'recordTypeId')::uuid is distinct from type_id then
      raise exception using errcode = '22023',
        message = 'Record-share grant proposal is invalid';
    end if;

    for needed in
      select 1 as step, 'share' as action_kind, 'record.share' as operation_key
      union all
      select 2, 'read', 'record.share.read'
      union all
      select 3, 'update', 'record.share.update'
      where pg_catalog.cardinality(changeable) > 0
      order by step
    loop
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'applicationRootId', catalogue.application_root_id,
          'ownerKind', catalogue.owner_kind, 'ownerId', catalogue.owner_id,
          'permissionId', catalogue.permission_id
        )
        order by catalogue.owner_kind, catalogue.owner_id, catalogue.permission_id
      )
      into required_permissions
      from vortex_access.permission_catalogue_entries as catalogue
      join vortex_access.permission_registrations as registration
        on registration.organization_id = catalogue.organization_id
        and registration.registration_kind = catalogue.registration_kind
        and registration.registration_owner_id = catalogue.registration_owner_id
        and registration.revision = catalogue.registration_revision
        and registration.state = 'active'
      where catalogue.organization_id = p_organization_id
        and catalogue.application_root_id = p_application_root_id
        and catalogue.owner_kind in ('application', 'module')
        and ((catalogue.owner_kind = 'application' and catalogue.owner_id = p_application_root_id)
          or (catalogue.owner_kind = 'module' and catalogue.owner_id = module_id))
        and catalogue.record_type_id = type_id
        and catalogue.action_kind = needed.action_kind
        and catalogue.record_scope is not null;

      if required_permissions is null then
        if needed.action_kind = 'share' then
          raise exception using errcode = '42501',
            message = 'Record-share grant requires a current share permission';
        end if;
        continue;
      end if;

      declaration := pg_catalog.jsonb_build_object(
        'operationKey', needed.operation_key,
        'action', pg_catalog.jsonb_build_object('actionKind', needed.action_kind),
        'target', pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', p_application_root_id
        ),
        'requiredPermissions', required_permissions,
        'recordBinding', facts_binding,
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      );
      decision := vortex_access.evaluate_organization_record_access_internal(
        declaration, record_value, p_facts
      );

      if needed.action_kind = 'share' then
        if decision ->> 'outcome' <> 'allowed' then
          raise exception using errcode = '42501',
            message = 'Record-share grant target record is not within your current share authority';
        end if;
      elsif needed.action_kind = 'read' then
        if decision ->> 'outcome' = 'allowed' then
          read_admitted := true;
          bounds := vortex_access.resolve_record_field_bounds_internal(decision);
          select coalesce(pg_catalog.array_agg((elem.value)::uuid), array[]::uuid[])
          into readable_ceiling
          from pg_catalog.jsonb_array_elements_text(bounds -> 'readableFieldIds') as elem(value);
        end if;
      else
        if decision ->> 'outcome' = 'allowed' then
          bounds := vortex_access.resolve_record_field_bounds_internal(decision);
          select coalesce(pg_catalog.array_agg((elem.value)::uuid), array[]::uuid[])
          into changeable_ceiling
          from pg_catalog.jsonb_array_elements_text(bounds -> 'changeableFieldIds') as elem(value);
        end if;
      end if;
    end loop;

    if not read_admitted or not (readable <@ readable_ceiling) then
      raise exception using errcode = '42501',
        message = 'Record-share grant exceeds current read authority';
    end if;
    if pg_catalog.cardinality(changeable) > 0 and not (changeable <@ changeable_ceiling) then
      raise exception using errcode = '42501',
        message = 'Record-share grant exceeds current update authority';
    end if;
  else
    -- A broader scope needs an organisation-wide (all_records) share route for
    -- the exact record type (or, for a module, any of its record types), and
    -- that permission must currently be eligible for this human context.
    for entry in
      select catalogue.application_root_id, catalogue.owner_kind, catalogue.owner_id,
        catalogue.permission_id
      from vortex_access.permission_catalogue_entries as catalogue
      join vortex_access.permission_registrations as registration
        on registration.organization_id = catalogue.organization_id
        and registration.registration_kind = catalogue.registration_kind
        and registration.registration_owner_id = catalogue.registration_owner_id
        and registration.revision = catalogue.registration_revision
        and registration.state = 'active'
      where catalogue.organization_id = p_organization_id
        and catalogue.application_root_id = p_application_root_id
        and catalogue.owner_kind in ('application', 'module')
        and ((catalogue.owner_kind = 'application' and catalogue.owner_id = p_application_root_id)
          or (catalogue.owner_kind = 'module' and catalogue.owner_id = module_id))
        and (type_id is null or catalogue.record_type_id = type_id)
        and catalogue.record_type_id is not null
        and catalogue.action_kind = 'share'
        and catalogue.record_scope is not null
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(catalogue.record_scope -> 'routes') as route(value)
          where route.value ->> 'kind' = 'all_records'
        )
      order by catalogue.owner_kind, catalogue.owner_id, catalogue.permission_id
    loop
      select evaluated.* into strict eligibility
      from vortex_access.evaluate_organization_permission_eligibility(
        pg_catalog.jsonb_build_object(
          'operationKey', 'record.share',
          'action', pg_catalog.jsonb_build_object('actionKind', 'share'),
          'target', pg_catalog.jsonb_build_object(
            'kind', 'application', 'applicationRootId', p_application_root_id
          ),
          'requiredPermission', pg_catalog.jsonb_build_object(
            'applicationRootId', entry.application_root_id,
            'ownerKind', entry.owner_kind, 'ownerId', entry.owner_id,
            'permissionId', entry.permission_id
          ),
          'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
          'authority', pg_catalog.jsonb_build_object('kind', 'permission')
        )
      ) as evaluated;
      if eligibility.outcome = 'eligible' then
        share_admitted := true;
        exit;
      end if;
    end loop;
    if not share_admitted then
      raise exception using errcode = '42501',
        message = 'Record-share grant requires a current share permission';
    end if;
  end if;
end
$function$;

create function vortex_access.propose_record_share_grant_for_administration(
  p_grant_id uuid,
  p_consent_request_id uuid,
  p_terms jsonb,
  p_proposal_fingerprint text,
  p_facts jsonb,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_application_root_id uuid;
  locked_access_version bigint;
  cross_organization boolean;
  now_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_proposal_fingerprint is null or p_proposal_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or p_terms is null or pg_catalog.jsonb_typeof(p_terms) <> 'object'
    or (p_consent_request_id is not null
      and p_consent_request_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId' then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share grant proposal requires an application context';
  end if;

  -- Take the organisation governance lock before evaluating any authority, so a
  -- concurrent authority change cannot land between the check and the write.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share grant proposal is unavailable';
  end if;

  perform vortex_access.check_record_share_grant_terms_internal(
    p_terms, p_facts, context_organization_id, context_application_root_id
  );

  cross_organization := (p_terms ->> 'recipientOrganizationId')::uuid
    <> context_organization_id;
  if cross_organization is distinct from (p_consent_request_id is not null) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  insert into vortex_access.record_share_grants (
    grant_id, source_organization_id, source_cluster_id, source_application_root_id,
    recipient_cluster_id, recipient_organization_id, recipient_application_root_id,
    scope_kind, module_root_id, record_type_id, record_id, saved_condition_id,
    saved_condition_revision, saved_condition_fingerprint, saved_condition_parameters,
    readable_field_ids, changeable_field_ids, recipient_role_ids, allowed_action_keys,
    export_allowed, approved_recipient_region, starts_at, expires_at, status,
    created_by_organization_account_id, consent_request_id, contract_version,
    contract_fingerprint, recipient_binding_id, definition_mapping_fingerprint,
    proposal_fingerprint, revision, created_at, changed_at
  ) values (
    p_grant_id, context_organization_id, (p_terms ->> 'sourceClusterId')::uuid,
    context_application_root_id, (p_terms ->> 'recipientClusterId')::uuid,
    (p_terms ->> 'recipientOrganizationId')::uuid,
    (p_terms ->> 'recipientApplicationRootId')::uuid,
    p_terms ->> 'scopeKind', (p_terms ->> 'moduleRootId')::uuid,
    (p_terms ->> 'recordTypeId')::uuid, (p_terms ->> 'recordId')::uuid,
    (p_terms ->> 'savedConditionId')::uuid, (p_terms ->> 'savedConditionRevision')::bigint,
    p_terms ->> 'savedConditionFingerprint', p_terms -> 'parameters',
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'readableFieldIds', 1, 500),
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'changeableFieldIds', 0, 500),
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'recipientRoleIds', 1, 100),
    array(select pg_catalog.jsonb_array_elements_text(p_terms -> 'allowedActionKeys')),
    (p_terms ->> 'exportAllowed')::boolean, p_terms ->> 'approvedRecipientRegion',
    (p_terms ->> 'startsAt')::timestamptz, (p_terms ->> 'expiresAt')::timestamptz,
    case when cross_organization then 'pending_consent' else 'draft' end,
    context_account_id, p_consent_request_id, p_terms ->> 'contractVersion',
    p_terms ->> 'contractFingerprint', (p_terms ->> 'recipientBindingId')::uuid,
    p_terms ->> 'definitionMappingFingerprint', p_proposal_fingerprint, 1,
    now_value, now_value
  );

  -- The grant's foreign key to its consent request is deferred, so the request
  -- follows the grant it names.
  if cross_organization then
    insert into vortex_access.record_share_grant_consent_requests (
      request_id, grant_id, source_organization_id, source_cluster_id,
      recipient_organization_id, recipient_cluster_id, proposed_grant_fingerprint,
      status, requested_by_organization_account_id, requested_at,
      source_authorizing_role_ids, recipient_accepting_role_ids, expires_at,
      revision, changed_at
    ) values (
      p_consent_request_id, p_grant_id, context_organization_id,
      (p_terms ->> 'sourceClusterId')::uuid,
      (p_terms ->> 'recipientOrganizationId')::uuid,
      (p_terms ->> 'recipientClusterId')::uuid, p_proposal_fingerprint,
      'pending', context_account_id, now_value,
      vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'sourceAuthorizingRoleIds', 1, 100),
      vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'recipientAcceptingRoleIds', 1, 100),
      (p_terms ->> 'expiresAt')::timestamptz, 1, now_value
    );
  end if;


  append_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'propose_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], 'web', context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant proposal Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

create function vortex_access.revise_record_share_grant_for_administration(
  p_grant_id uuid,
  p_expected_revision bigint,
  p_terms jsonb,
  p_proposal_fingerprint text,
  p_facts jsonb,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_application_root_id uuid;
  locked_access_version bigint;
  stored vortex_access.record_share_grants%rowtype;
  cross_organization boolean;
  now_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_proposal_fingerprint is null or p_proposal_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or p_terms is null or pg_catalog.jsonb_typeof(p_terms) <> 'object' then
    raise exception using errcode = '22023',
      message = 'Record-share grant revision is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId' then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share grant revision requires an application context';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share grant revision is unavailable';
  end if;

  -- Only the source organisation's own application may revise its proposal; a
  -- foreign or unknown grant is indistinguishable from a missing one.
  select grants.* into stored
  from vortex_access.record_share_grants as grants
  where grants.grant_id = p_grant_id
    and grants.source_organization_id = context_organization_id
    and grants.source_application_root_id = context_application_root_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record-share grant revision is unavailable';
  end if;
  if stored.revision <> p_expected_revision or stored.status not in ('draft', 'pending_consent') then
    raise exception using errcode = '40001',
      message = 'Record-share grant is stale or no longer a proposal';
  end if;

  perform vortex_access.check_record_share_grant_terms_internal(
    p_terms, p_facts, context_organization_id, context_application_root_id
  );

  -- A revision cannot turn a same-organisation proposal into a cross-organisation
  -- one or back: consent is bound to the grant's recipient organisation.
  cross_organization := (p_terms ->> 'recipientOrganizationId')::uuid
    <> context_organization_id;
  if cross_organization is distinct from (stored.consent_request_id is not null) then
    raise exception using errcode = '22023',
      message = 'Record-share grant revision is invalid';
  end if;

  update vortex_access.record_share_grants as grants
  set source_cluster_id = (p_terms ->> 'sourceClusterId')::uuid,
      recipient_cluster_id = (p_terms ->> 'recipientClusterId')::uuid,
      recipient_organization_id = (p_terms ->> 'recipientOrganizationId')::uuid,
      recipient_application_root_id = (p_terms ->> 'recipientApplicationRootId')::uuid,
      scope_kind = p_terms ->> 'scopeKind',
      module_root_id = (p_terms ->> 'moduleRootId')::uuid,
      record_type_id = (p_terms ->> 'recordTypeId')::uuid,
      record_id = (p_terms ->> 'recordId')::uuid,
      saved_condition_id = (p_terms ->> 'savedConditionId')::uuid,
      saved_condition_revision = (p_terms ->> 'savedConditionRevision')::bigint,
      saved_condition_fingerprint = p_terms ->> 'savedConditionFingerprint',
      saved_condition_parameters = p_terms -> 'parameters',
      readable_field_ids = vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'readableFieldIds', 1, 500),
      changeable_field_ids = vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'changeableFieldIds', 0, 500),
      recipient_role_ids = vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'recipientRoleIds', 1, 100),
      allowed_action_keys = array(
        select pg_catalog.jsonb_array_elements_text(p_terms -> 'allowedActionKeys')),
      export_allowed = (p_terms ->> 'exportAllowed')::boolean,
      approved_recipient_region = p_terms ->> 'approvedRecipientRegion',
      starts_at = (p_terms ->> 'startsAt')::timestamptz,
      expires_at = (p_terms ->> 'expiresAt')::timestamptz,
      contract_version = p_terms ->> 'contractVersion',
      contract_fingerprint = p_terms ->> 'contractFingerprint',
      recipient_binding_id = (p_terms ->> 'recipientBindingId')::uuid,
      definition_mapping_fingerprint = p_terms ->> 'definitionMappingFingerprint',
      proposal_fingerprint = p_proposal_fingerprint,
      revision = grants.revision + 1,
      changed_at = now_value
  where grants.grant_id = p_grant_id;

  -- The consent request follows the new fingerprint and roles; any earlier
  -- consent would have named the old fingerprint and is superseded.
  if cross_organization then
    update vortex_access.record_share_grant_consent_requests as requests
    set recipient_organization_id = (p_terms ->> 'recipientOrganizationId')::uuid,
        recipient_cluster_id = (p_terms ->> 'recipientClusterId')::uuid,
        source_cluster_id = (p_terms ->> 'sourceClusterId')::uuid,
        proposed_grant_fingerprint = p_proposal_fingerprint,
        status = 'pending',
        requested_by_organization_account_id = context_account_id,
        requested_at = now_value,
        source_authorizing_role_ids = vortex_access.record_share_grant_uuid_array_internal(
          p_terms -> 'sourceAuthorizingRoleIds', 1, 100),
        recipient_accepting_role_ids = vortex_access.record_share_grant_uuid_array_internal(
          p_terms -> 'recipientAcceptingRoleIds', 1, 100),
        expires_at = (p_terms ->> 'expiresAt')::timestamptz,
        revision = requests.revision + 1,
        changed_at = now_value
    where requests.request_id = stored.consent_request_id;
  end if;

  append_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'revise_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], 'web', context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant revision Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

create function vortex_access.withdraw_record_share_grant_for_administration(
  p_grant_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_application_root_id uuid;
  locked_access_version bigint;
  stored vortex_access.record_share_grants%rowtype;
  now_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_reason is null or pg_catalog.char_length(p_reason) not between 1 and 500
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record-share grant withdrawal is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId' then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal requires an application context';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal is unavailable';
  end if;

  select grants.* into stored
  from vortex_access.record_share_grants as grants
  where grants.grant_id = p_grant_id
    and grants.source_organization_id = context_organization_id
    and grants.source_application_root_id = context_application_root_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal is unavailable';
  end if;
  if stored.revision <> p_expected_revision or stored.status not in ('draft', 'pending_consent') then
    raise exception using errcode = '40001',
      message = 'Record-share grant is stale or no longer a proposal';
  end if;

  -- Withdrawing narrows what the proposal could ever become, so it needs no
  -- fresh share ceiling; the caller must still be the source organisation's own
  -- current human context (validated and locked above).
  update vortex_access.record_share_grants as grants
  set status = 'revoked',
      revoked_at = now_value,
      revoked_by_organization_account_id = context_account_id,
      revocation_reason = p_reason,
      revision = grants.revision + 1,
      changed_at = now_value
  where grants.grant_id = p_grant_id;

  if stored.consent_request_id is not null then
    update vortex_access.record_share_grant_consent_requests as requests
    set status = 'withdrawn', revision = requests.revision + 1, changed_at = now_value
    where requests.request_id = stored.consent_request_id;
  end if;

  append_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'withdraw_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], 'web', context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant withdrawal Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

-- Either party's organisation may read a proposal that names it; nothing else
-- is visible, and a foreign or unknown grant refuses the same way.
create function vortex_access.get_record_share_grant_for_administration(p_grant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record-share grant read is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  if not exists (
    select 1
    from vortex_access.record_share_grants as grants
    where grants.grant_id = p_grant_id
      and (grants.source_organization_id = context_organization_id
        or grants.recipient_organization_id = context_organization_id)
  ) then
    raise exception using errcode = '42501',
      message = 'Record-share grant read is unavailable';
  end if;
  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

revoke all on function vortex_access.record_share_grant_uuid_array_internal(jsonb, integer, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;
revoke all on function vortex_access.record_share_grant_json_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;
revoke all on function vortex_access.check_record_share_grant_terms_internal(
  jsonb, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke all on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, text, jsonb, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke all on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, text, jsonb, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke all on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke all on function vortex_access.get_record_share_grant_for_administration(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;

grant execute on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, text, jsonb, uuid
) to vortex_request;
grant execute on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, text, jsonb, uuid
) to vortex_request;
grant execute on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) to vortex_request;
grant execute on function vortex_access.get_record_share_grant_for_administration(uuid)
  to vortex_request;

comment on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, text, jsonb, uuid
) is
  'Fixed protected proposer: stores one exact record-share grant proposal for the context organisation after re-checking its current share authority; cross-organisation proposals stop at pending_consent with a consent request bound to the proposal fingerprint.';
comment on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, text, jsonb, uuid
) is
  'Fixed protected reviser: replaces the terms and fingerprints of a draft or pending_consent proposal under an exact expected revision, re-checking current share authority and resetting its consent request.';
comment on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) is
  'Fixed protected withdrawal: revokes a draft or pending_consent proposal of the context organisation under an exact expected revision and withdraws its consent request.';
comment on function vortex_access.get_record_share_grant_for_administration(uuid) is
  'Fixed protected read of one record-share grant proposal for its source or recipient organisation.';
