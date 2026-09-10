-- Protected activation-ledger reads describe retained temporary role
-- activations. Their temporal state never replaces the central Access
-- decision or revalidates the stored eligibility source.

create function vortex_access.list_organization_role_activations_for_administration(
  p_after_role_activation_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  activations jsonb,
  next_after_role_activation_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  checked_at timestamptz;
  activation_items jsonb;
  page_activation_ids uuid[];
  candidate_count integer;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or p_after_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role activation page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  with candidates as (
    select activation.role_activation_id,
      activation.organization_account_id, account.display_name,
      activation.role_id, role_revision.role_key, role_revision.label,
      role_revision.lifecycle, activation.revision,
      activation.historical_role_revision,
      activation.eligibility_source_kind, activation.activated_at,
      activation.expires_at, activation.state,
      case
        when activation.state = 'revoked' then 'revoked'
        when activation.expires_at <= checked_at then 'expired'
        else 'active'
      end as temporal_state,
      pg_catalog.row_number() over (
        order by activation.role_activation_id
      ) as ordinal
    from vortex_access.organization_role_activations as activation
    join vortex_identity.organization_accounts as account
      on account.organization_id = activation.organization_id
      and account.organization_account_id = activation.organization_account_id
    join vortex_access.organization_roles as role
      on role.organization_id = activation.organization_id
      and role.role_id = activation.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
    where activation.organization_id = scope.organization_id
      and (
        p_after_role_activation_id is null
        or activation.role_activation_id > p_after_role_activation_id
      )
    order by activation.role_activation_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'roleActivationId', candidate.role_activation_id,
          'beneficiary', pg_catalog.jsonb_build_object(
            'organizationAccountId', candidate.organization_account_id,
            'displayName', candidate.display_name
          ),
          'role', pg_catalog.jsonb_build_object(
            'roleId', candidate.role_id,
            'key', candidate.role_key,
            'label', candidate.label,
            'lifecycle', candidate.lifecycle
          ),
          'revision', candidate.revision,
          'historicalRoleRevision', candidate.historical_role_revision,
          'eligibilitySourceKind', candidate.eligibility_source_kind,
          'activatedAt', candidate.activated_at,
          'expiresAt', candidate.expires_at,
          'state', candidate.state,
          'temporalState', candidate.temporal_state
        ) order by candidate.role_activation_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.role_activation_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into activation_items, page_activation_ids, candidate_count
  from candidates as candidate;

  return query select scope.organization_id, activation_items,
    case when candidate_count > p_page_size
      then page_activation_ids[p_page_size] else null end,
    scope.access_version;
end
$function$;

create function vortex_access.read_organization_role_activation_for_administration(
  p_role_activation_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  activation_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  checked_at timestamptz;
  activation_value jsonb;
begin
  if p_role_activation_id is null
    or p_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role activation detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  select pg_catalog.jsonb_build_object(
    'roleActivationId', activation.role_activation_id,
    'beneficiary', pg_catalog.jsonb_build_object(
      'organizationAccountId', activation.organization_account_id,
      'displayName', account.display_name
    ),
    'role', pg_catalog.jsonb_build_object(
      'roleId', activation.role_id,
      'key', role_revision.role_key,
      'label', role_revision.label,
      'lifecycle', role_revision.lifecycle
    ),
    'revision', activation.revision,
    'historicalRoleRevision', activation.historical_role_revision,
    'eligibilitySource', case activation.eligibility_source_kind
      when 'direct' then pg_catalog.jsonb_build_object(
        'kind', 'direct',
        'eligibilityAssignment', pg_catalog.jsonb_build_object(
          'roleAssignmentId', activation.role_assignment_id,
          'revision', activation.role_assignment_revision
        )
      )
      else pg_catalog.jsonb_build_object(
        'kind', 'group',
        'eligibilityAssignment', pg_catalog.jsonb_build_object(
          'roleAssignmentId', activation.role_assignment_id,
          'revision', activation.role_assignment_revision
        ),
        'originatingMembership', pg_catalog.jsonb_build_object(
          'membershipId', activation.membership_id,
          'revision', activation.membership_revision
        )
      )
    end,
    'policyAtActivation', pg_catalog.jsonb_build_object(
      'maximumActivationDurationSeconds',
        policy.maximum_activation_duration_seconds,
      'reasonRequired', policy.reason_required,
      'recentAuthentication', case policy.authentication_requirement
        when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
        else pg_catalog.jsonb_build_object(
          'kind', policy.authentication_requirement,
          'maximumAgeSeconds', policy.authentication_maximum_age_seconds
        )
      end,
      'independentApprovalRequired', policy.independent_approval_required
    ),
    'activatedAt', activation.activated_at,
    'expiresAt', activation.expires_at,
    'state', activation.state,
    'temporalState', case
      when activation.state = 'revoked' then 'revoked'
      when activation.expires_at <= checked_at then 'expired'
      else 'active'
    end
  )
  into activation_value
  from vortex_access.organization_role_activations as activation
  join vortex_identity.organization_accounts as account
    on account.organization_id = activation.organization_id
    and account.organization_account_id = activation.organization_account_id
  join vortex_access.organization_roles as role
    on role.organization_id = activation.organization_id
    and role.role_id = activation.role_id
  join vortex_access.organization_role_revisions as role_revision
    on role_revision.organization_id = role.organization_id
    and role_revision.role_id = role.role_id
    and role_revision.revision = role.live_revision
  join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = activation.organization_id
    and policy.role_id = activation.role_id
    and policy.activation_policy_id = activation.activation_policy_id
    and policy.revision = activation.activation_policy_revision
    and policy.policy_fingerprint = activation.activation_policy_fingerprint
  where activation.organization_id = scope.organization_id
    and activation.role_activation_id = p_role_activation_id;

  return query select scope.organization_id,
    case when activation_value is null then 'unavailable' else 'available' end,
    activation_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.list_organization_role_activations_for_administration(uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_organization_role_activation_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.list_organization_role_activations_for_administration(uuid, integer)
to vortex_request;
grant execute on function
  vortex_access.read_organization_role_activation_for_administration(uuid)
to vortex_request;

comment on function
  vortex_access.list_organization_role_activations_for_administration(uuid, integer) is
  'Returns one bounded retained activation page with descriptive window state, not effective permission.';
comment on function
  vortex_access.read_organization_role_activation_for_administration(uuid) is
  'Returns one safe exact activation with historical source and policy settings, not current authority.';
