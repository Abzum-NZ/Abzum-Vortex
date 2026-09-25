create or replace function vortex_access.revoke_record_share_for_administration(
  p_direct_share_id uuid,
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
  current_share vortex_access.organization_direct_record_shares%rowtype;
  checked_at timestamptz;
  is_grantor boolean;
  declaration_binding jsonb;
  required_permissions jsonb;
  declaration jsonb;
  eligibility jsonb;
  revoked record;
begin
  if p_direct_share_id is null
    or not vortex_context.is_non_nil_uuid(p_direct_share_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_reason is null
    or pg_catalog.char_length(p_reason) not between 1 and 500
    or p_activity_id is null
    or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023',
      message = 'Protected record-share revocation input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Protected record-share revocation requires an application context';
  end if;

  -- Same governance lock as the grant path, acquired before the authority
  -- check below, for the same reason: no read-then-upgrade race.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Protected record-share revocation is unavailable';
  end if;

  select share.* into current_share
  from vortex_access.organization_direct_record_shares as share
  where share.organization_id = context_organization_id
    and share.direct_share_id = p_direct_share_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Protected record-share revocation is unavailable';
  end if;

  -- F1 correction (slice 7). The share's own application must match the
  -- caller's current one -- unless the share is organisation_shared, which
  -- by definition crosses applications -- exactly as the complete record
  -- decision already requires the target row's own real recordScope.
  -- applicationRootId to match before it admits anything
  -- (20260910040755_compose_exact_record_access_decision.sql:816-819).
  -- Before this correction, nothing on this path ever compared the share's
  -- own stored application to the caller's: the declaration's target below
  -- and the catalogue filter it feeds are both built from
  -- context_application_root_id, so the eligibility core's own
  -- target-context check compared context against itself and always
  -- passed. An account acting in one application could therefore revoke a
  -- share belonging to another merely by holding record.share somewhere in
  -- its own.
  if current_share.storage_scope <> 'organization_shared'
    and current_share.application_root_id <> context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Protected record-share revocation is unavailable';
  end if;

  checked_at := pg_catalog.clock_timestamp();

  -- Current authority over the share (F2 correction, slice 7): exactly two
  -- independent sufficient conditions, both re-derived fresh under the lock
  -- just acquired -- never the grantor's present read/update field ceiling
  -- (revocation is a narrowing act, unlike granting, so it needs neither),
  -- and -- unlike granting -- never the share's own target row: narrowing
  -- access never requires that the record being narrowed is currently
  -- visible. checked_at is this function's own one time sample, taken once
  -- under the lock, exactly as the complete decision takes its own one
  -- sample when the grant path calls it; context_value, sampled once above
  -- and already proven current against the freshly locked Access version,
  -- is reused rather than sampled a second time.
  --
  -- The first condition is being the account that granted this share.
  -- Identity is authority enough on its own -- a grantor can always
  -- withdraw what they gave, regardless of the record's lifecycle and
  -- regardless of whether they still hold any current permission at all --
  -- but a delegated or support context still cannot exercise it: "granted
  -- this share" names no permission the shared eligibility core can
  -- evaluate for context legitimacy, so the same unsupported-context test
  -- the core itself runs first for every other declaration is applied
  -- directly here for that one reason, not as a second evaluator.
  --
  -- The second, independent condition is holding a *current* record.share
  -- permission whose own catalogue record scope is decidable without the
  -- record row, which is exactly why revocation can outlive the record.
  -- A record scope is `{routes, savedCondition?}`, and both halves must be
  -- row-independent for the scope to be:
  --
  --   * Its routes must name all_records, the one route
  --     `evaluate_current_record_ownership_visibility` admits unconditionally
  --     once the binding matches, with no row-specific fact left to check
  --     (20260906144015_evaluate_current_record_ownership_visibility.sql).
  --     The contract already forces all_records to be the sole route when
  --     present, so naming it settles the whole array. Ownership,
  --     direct_share and relationship each require the row to mean anything.
  --
  --   * It must carry no saved condition. A saved condition narrows *every*
  --     route, all_records included -- `compose_exact_record_access_decision`
  --     says so in those words and evaluates it from the target row's own
  --     field values -- so a scope carrying one is row-dependent no matter
  --     how its routes read. Reasoning about the route in isolation was the
  --     hole an independent probe used: an account whose only share
  --     permission was all_records *narrowed by a condition* could not grant
  --     a share over a record the condition excluded, yet could revoke every
  --     existing share of that record type, including over records it can
  --     never reach.
  --
  -- Before either correction, every current share permission was accepted
  -- merely because its record_scope was not null, so an account whose only
  -- share permission was direct_share-routed -- which can never *create* a
  -- share -- could revoke every share of that record type.
  is_grantor := current_share.granted_by = context_account_id
    and not (context_value ? 'delegatedContext' or context_value ? 'supportContext');

  if not is_grantor then
    declaration_binding := pg_catalog.jsonb_build_object(
      'moduleRootId', current_share.module_root_id, 'recordTypeId', current_share.record_type_id,
      'storageContractId', current_share.storage_contract_id, 'storageScope', current_share.storage_scope
    );

    select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'applicationRootId', entry.application_root_id,
          'ownerKind', entry.owner_kind, 'ownerId', entry.owner_id,
          'permissionId', entry.permission_id
        )
        order by entry.owner_kind, entry.owner_id, entry.permission_id
      )
    into required_permissions
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = context_organization_id
      and entry.application_root_id = context_application_root_id
      and entry.owner_kind in ('application', 'module')
      and (
        (entry.owner_kind = 'application' and entry.owner_id = context_application_root_id)
        or (entry.owner_kind = 'module' and entry.owner_id = current_share.module_root_id)
      )
      and entry.record_type_id = current_share.record_type_id
      and entry.action_kind = 'share'
      and entry.record_scope is not null
      -- F2: only a record scope the eligibility core can resolve without the
      -- record row confers revoke authority -- see above. That is a property
      -- of the whole scope, not of its routes alone: a saved condition
      -- narrows every route, all_records included, so a scope carrying one
      -- is row-dependent however its routes read.
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(entry.record_scope -> 'routes') as route(value)
        where route.value ->> 'kind' = 'all_records'
      )
      and not (entry.record_scope ? 'savedCondition');

    -- No current candidate row-independent share permission at all:
    -- leave eligibility unset rather than calling the eligibility core with
    -- an empty requiredPermissions array, exactly like the grant path.
    if required_permissions is not null then
      declaration := pg_catalog.jsonb_build_object(
        'operationKey', 'record.share',
        'action', pg_catalog.jsonb_build_object('actionKind', 'share'),
        'target', pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', context_application_root_id
        ),
        'requiredPermissions', required_permissions,
        'recordBinding', declaration_binding,
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      );

      eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
        declaration, context_value, checked_at
      );
    end if;
  end if;

  if not is_grantor
    and (eligibility is null or eligibility ->> 'outcome' <> 'eligible') then
    raise exception using errcode = '42501',
      message = 'Protected record-share revocation is unavailable';
  end if;

  select result.* into strict revoked
  from vortex_access.revoke_organization_direct_record_share(
    context_organization_id, p_direct_share_id, p_expected_revision,
    p_reason, context_account_id, context_correlation_id,
    p_activity_id
  ) as result;

  return pg_catalog.jsonb_build_object(
    'directShareId', revoked.direct_share_id,
    'revision', revoked.revision,
    'state', revoked.state,
    'changedAt', revoked.changed_at,
    'accessVersion', revoked.access_version
  );
end
$function$;

revoke execute on function vortex_access.revoke_record_share_for_administration(
  uuid, bigint, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.revoke_record_share_for_administration(
  uuid, bigint, text, uuid
) is
  'Protected direct-share revocation: permitted only to an account currently acting in the share''s own application and organisation (organisation_shared shares excepted from the application match) that either is the share''s own non-delegated, non-support granted_by identity, or currently holds a record.share permission whose own catalogue record scope is decidable without the record row -- an all_records route and no saved condition, since a saved condition narrows every route including that one -- re-evaluated fresh under the governance lock, never the complete exact-record decision. Narrowing never requires the share''s own target record to be visible: never a re-requirement of the acting account''s present field ceiling, and never the record''s own existence or lifecycle state. Owner-only; reached only through a fixed adapter.';
