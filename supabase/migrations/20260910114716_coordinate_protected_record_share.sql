-- Protected same-organisation direct record sharing (#37 slice 3, corrected
-- in slice 4 to require record.share before any share, and in slice 5 to
-- replace fabricated facts with the target record's real ones). Reuses #36's
-- private structural writers unchanged: they already do the revision check,
-- Activity append and Access invalidation. These two functions own what the
-- writers deliberately do not: confirming the acting context currently holds
-- record.share at all, and making sure a share can never give the recipient
-- field access the grantor does not currently hold themselves.
--
-- F1. The grantor's own current share authority, and its current read (and,
-- when relevant, update) ceiling, are re-derived here, fresh, under the same
-- governance lock the writer itself takes -- never accepted as a
-- caller-supplied fact. #35's exact-record decision
-- (20260910040755_compose_exact_record_access_decision.sql) and #37 slice
-- 1's field-bounds resolver (20260910094534_resolve_record_field_bounds.sql)
-- are the only sources of that authority; this migration adds no second
-- evaluator. Share authority is checked first, before any read/update
-- ceiling work and before any mutation. [Specification
-- 04](../../docs/specification/04-access-and-permissions.md): "The grantor
-- must hold record.share ... A direct share cannot grant delete, restore,
-- export, re-share, ownership, role administration, or any permission the
-- grantor does not hold."
--
-- F5 (slice 5). Both functions now take `p_facts jsonb` from the caller
-- instead of fabricating it, and both are owner-only: their `vortex_request`
-- grant is revoked below, exactly as #35's own record decision has never
-- carried one. A trusted fixed adapter -- resolving its own installed
-- binding, reading the record's real row from a real content table and
-- loading its real relationship edges, exactly like #35's own neutral proof
-- in supabase/tests/430_exact_record_access.test.sql and
-- supabase/tests/445_record_field_projection.test.sql -- is the only path a
-- request role has left to either function; the two adapters added in
-- supabase/tests/450_protected_record_share.test.sql are that path for this
-- proof, and #45 generates the permanent ones later.
--
-- This removes two consequences an independent review found: a record that
-- did not exist, or was soft-deleted, could be shared, because the
-- decision's lifecycle and existence checks were tautologies against an
-- asserted 'active' record built from whatever identifiers the caller named
-- for whatever record id it claimed; and a grantor whose only authority was
-- ownership-routed could never share, because ownership never admits without
-- the record's real owner, and every relationship- and condition-scoped
-- permission was filtered out of evaluation entirely -- an empty
-- relationship/condition graph would otherwise make the decision raise
-- rather than gracefully refuse one route. With real facts, none of those
-- three route kinds is filtered out any more (F3 below); they are evaluated
-- like every other route, and the record's actual existence and lifecycle
-- state decide the outcome instead of an assertion.
--
-- `moduleRootId`, `recordTypeId`, `storageContractId` and `storageScope` are
-- read from the trusted facts' own `binding` -- the same binding the
-- decision already cross-checks the declaration and the target row against
-- -- never from a caller-supplied scalar naming the same thing a second,
-- unchecked way. The persisted share row's `application_root_id` is the
-- verified request context's own `applicationRootId`, which the decision
-- already requires the target record's real scope to match before it admits
-- anything.
--
-- F3. Every declaration this migration builds -- share, read and update
-- alike -- looks up every *current* record-scoped permission of that exact
-- action on the exact target record type from the live catalogue itself
-- (never caller-supplied). No route shape is excluded from that lookup any
-- more: ownership, direct_share, relationship and condition-scoped
-- permissions are all passed to the decision and evaluated on their own
-- merits against the adapter's real facts.

-- Takes the exact target record, the recipient, the proposed readable and
-- changeable fields, the share's validity window, and the trusted facts a
-- fixed adapter resolved for the target record. Never a decision, a
-- field-set ceiling, a permission, an allow flag or the record's binding
-- from the caller directly -- the binding travels only inside p_facts.
create function vortex_access.grant_record_share_for_administration(
  p_direct_share_id uuid,
  p_record_id uuid,
  p_recipient_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_readable_field_ids uuid[],
  p_changeable_field_ids uuid[],
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_reason text,
  p_activity_source text,
  p_activity_id uuid,
  p_facts jsonb
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
  facts_binding jsonb;
  -- Prefixed target_* deliberately: an unqualified module_root_id/record_
  -- type_id/storage_contract_id/storage_scope here would be ambiguous
  -- against the identically named columns the queries below select from --
  -- PL/pgSQL raises a hard error for that, not a silent wrong guess.
  target_module_root_id uuid;
  target_record_type_id uuid;
  target_storage_contract_id uuid;
  target_storage_scope text;
  needed record;
  required_permissions jsonb;
  declaration jsonb;
  decision jsonb;
  bounds jsonb;
  share_admitted boolean := false;
  read_admitted boolean := false;
  readable_ceiling uuid[] := array[]::uuid[];
  changeable_ceiling uuid[] := array[]::uuid[];
  granted record;
begin
  if p_direct_share_id is null
    or not vortex_context.is_non_nil_uuid(p_direct_share_id::text)
    or p_record_id is null
    or not vortex_context.is_non_nil_uuid(p_record_id::text)
    or p_recipient_kind is null
    or p_recipient_kind not in ('organization_account', 'group')
    or (p_recipient_kind = 'organization_account' and (
      p_organization_account_id is null
      or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
      or p_group_id is not null
    ))
    or (p_recipient_kind = 'group' and (
      p_group_id is null
      or not vortex_context.is_non_nil_uuid(p_group_id::text)
      or p_organization_account_id is not null
    ))
    or p_readable_field_ids is null
    or pg_catalog.cardinality(p_readable_field_ids) = 0
    or not vortex_access.direct_share_field_ids_are_canonical(p_readable_field_ids)
    or p_changeable_field_ids is null
    or not vortex_access.direct_share_field_ids_are_canonical(p_changeable_field_ids)
    or not (p_changeable_field_ids <@ p_readable_field_ids)
    or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or p_reason is null
    or pg_catalog.char_length(p_reason) not between 1 and 500
    or p_activity_source is null
    or p_activity_source not in (
      'web', 'workflow', 'interface', 'connection', 'federation', 'system'
    )
    or p_activity_id is null
    or not vortex_context.is_non_nil_uuid(p_activity_id::text)
    or p_facts is null
    or pg_catalog.jsonb_typeof(p_facts) <> 'object'
    or pg_catalog.jsonb_typeof(p_facts -> 'binding') <> 'object' then
    raise exception using errcode = '22023',
      message = 'Protected record-share grant input is invalid';
  end if;

  -- Step 1: validate the request context and the recipient. The recipient
  -- must be a current organisation account or Group in the caller's own
  -- (same) organisation; a foreign or unknown recipient refuses here, before
  -- any lock or authority evaluation.
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
      message = 'Protected record-share grant requires an application context';
  end if;

  if p_recipient_kind = 'organization_account' then
    perform 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = context_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active';
  else
    perform 1
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = context_organization_id
      and organization_group.group_id = p_group_id
      and organization_group.state = 'active';
  end if;
  if not found then
    raise exception using errcode = '42501',
      message = 'Protected record-share recipient is unavailable';
  end if;

  -- Step 2: acquire the existing governance/change lock before evaluating
  -- any authority. Never take a read lock and upgrade it later -- that
  -- upgrade is the exact race this ordering prevents: it would let a
  -- concurrent change to the grantor's own authority land between an
  -- unlocked check and the eventual write.
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
      message = 'Protected record-share grant is unavailable';
  end if;

  -- The binding this grant concerns comes from the caller's own trusted
  -- facts -- the adapter's real, resolved projection of the target record --
  -- never from a caller-supplied scalar naming the same module, record
  -- type, storage contract or storage scope a second, unchecked way. The
  -- decision below independently cross-checks this same binding against
  -- both the declaration it builds and the target row inside p_facts
  -- itself, so a facts payload that disagrees with the record it claims to
  -- describe refuses there, before anything is admitted.
  facts_binding := p_facts -> 'binding';
  target_module_root_id := (facts_binding ->> 'moduleRootId')::uuid;
  target_record_type_id := (facts_binding ->> 'recordTypeId')::uuid;
  target_storage_contract_id := (facts_binding ->> 'storageContractId')::uuid;
  target_storage_scope := facts_binding ->> 'storageScope';

  -- Steps 3 and 5: the grantor's current record decision, evaluated fresh
  -- under the lock just acquired. Read is always evaluated (a share must
  -- name at least one readable field); update is evaluated only when
  -- changeable fields are actually proposed, so a grantor with read but no
  -- update authority is never wrongly required to hold update authority
  -- they do not need. Facts are the adapter's real projection of the target
  -- record and its relationship/condition graph, shared unchanged between
  -- every decision below.
  for needed in
    select 1 as step, 'share' as action_kind, 'record.share' as operation_key
    union all
    select 2, 'read', 'record.share.read'
    union all
    select 3, 'update', 'record.share.update'
    where pg_catalog.cardinality(p_changeable_field_ids) > 0
    order by step
  loop
    -- required_permissions carries every *current* entry of this exact
    -- action kind on the exact target record type -- ownership,
    -- direct_share, relationship and condition-scoped alike (F3): none is
    -- excluded any more, because the facts backing evaluation are now the
    -- adapter's real projection of the record, not an empty stand-in that
    -- would make a relationship or condition route hard-fail instead of
    -- gracefully refuse.
    select
      pg_catalog.jsonb_agg(
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
        or (entry.owner_kind = 'module' and entry.owner_id = target_module_root_id)
      )
      and entry.record_type_id = target_record_type_id
      and entry.action_kind = needed.action_kind
      and entry.record_scope is not null;

    -- No current candidate permission at all for this action kind: leave it
    -- unadmitted below rather than calling the decision engine with an empty
    -- requiredPermissions array, which it treats as a malformed declaration,
    -- not a graceful refusal.
    if required_permissions is null then
      continue;
    end if;

    declaration := pg_catalog.jsonb_build_object(
      'operationKey', needed.operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', needed.action_kind),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application', 'applicationRootId', context_application_root_id
      ),
      'requiredPermissions', required_permissions,
      'recordBinding', facts_binding,
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    );

    decision := vortex_access.evaluate_organization_record_access_internal(
      declaration, p_record_id, p_facts
    );

    if decision ->> 'outcome' = 'allowed' then
      if needed.action_kind = 'share' then
        share_admitted := true;
      elsif needed.action_kind = 'read' then
        read_admitted := true;
        bounds := vortex_access.resolve_record_field_bounds_internal(decision);
        select coalesce(pg_catalog.array_agg((elem.value)::uuid), array[]::uuid[])
        into readable_ceiling
        from pg_catalog.jsonb_array_elements_text(bounds -> 'readableFieldIds') as elem(value);
      else
        bounds := vortex_access.resolve_record_field_bounds_internal(decision);
        select coalesce(pg_catalog.array_agg((elem.value)::uuid), array[]::uuid[])
        into changeable_ceiling
        from pg_catalog.jsonb_array_elements_text(bounds -> 'changeableFieldIds') as elem(value);
      end if;
    end if;
  end loop;

  -- Step 3b (F1): the grantor must currently hold record.share for this
  -- exact record type, over this exact record. Checked first -- before any
  -- ceiling comparison and before any mutation. This is also where a target
  -- record that does not exist, or is not active, ends up refused: every
  -- decision above shares the same p_facts, so a record the decision cannot
  -- find and verify as active admits nothing, for any action.
  if not share_admitted then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant requires a current share permission';
  end if;

  -- Step 4: the proposed readable fields must be a subset of the grantor's
  -- current readable set. A share must include at least one readable field,
  -- matching the existing writer's own requirement.
  if not read_admitted
    or pg_catalog.cardinality(p_readable_field_ids) = 0
    or not (p_readable_field_ids <@ readable_ceiling) then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant exceeds current read authority';
  end if;

  -- Step 6: the proposed changeable fields must be a subset of both the
  -- grantor's current changeable set and the proposed readable fields.
  -- Skipped entirely when no changeable fields are proposed, matching the
  -- update decision above never having been evaluated in that case.
  if pg_catalog.cardinality(p_changeable_field_ids) > 0
    and (
      not (p_changeable_field_ids <@ changeable_ceiling)
      or not (p_changeable_field_ids <@ p_readable_field_ids)
    ) then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant exceeds current update authority';
  end if;

  -- Step 7: invoke the existing grant writer. It owns the revision check,
  -- Activity append and Access invalidation; nothing here duplicates them.
  -- Every identifier passed through is either the verified request
  -- context's own, or read from the trusted facts' own binding -- never a
  -- caller-supplied scalar the decision above did not already verify.
  select result.* into strict granted
  from vortex_access.grant_organization_direct_record_share(
    context_organization_id, p_direct_share_id, target_storage_scope,
    case when target_storage_scope = 'application_contained' then context_application_root_id else null end,
    target_module_root_id, target_record_type_id, target_storage_contract_id, p_record_id,
    p_recipient_kind, p_organization_account_id, p_group_id,
    p_readable_field_ids, p_changeable_field_ids, p_starts_at, p_expires_at,
    p_reason, context_account_id, context_correlation_id, p_activity_source,
    p_activity_id
  ) as result;

  return pg_catalog.jsonb_build_object(
    'directShareId', granted.direct_share_id,
    'revision', granted.revision,
    'state', granted.state,
    'changedAt', granted.changed_at,
    'accessVersion', granted.access_version
  );
end
$function$;

-- Takes only the share id, the expected revision, and the trusted facts a
-- fixed adapter resolved for the share's own target record (read via the
-- share's own stored record_id). Revocation is a narrowing operation: it is
-- always permitted to someone with *current* record.share authority over
-- the share's exact record -- never waits for an approval, never requires
-- that account to still hold the field ceiling it was granted under, and
-- never revives an already-expired or already-revoked share -- all of that
-- is the existing writer's own job.
--
-- F4 correction: current authority is evaluated fresh, the same way the
-- grant path evaluates it, rather than compared as raw `granted_by`
-- identity. Identity comparison had it backwards in both directions: an
-- account with current administrative or share authority who was not the
-- original grantor could not revoke, while a delegated or support context --
-- which the eligibility core refuses outright for a `permission`-authority
-- declaration -- could revoke merely by sharing the grantor's own account
-- id. Evaluating the decision fresh under the lock fixes both: any account
-- currently holding record.share for this record may revoke regardless of
-- who granted it, and a delegated or support context is refused exactly as
-- it would be for a grant. This function takes no record-type parameters of
-- its own: the declaration's binding is built from the share row's own
-- stored, already-persisted columns (the most trustworthy source for what
-- record type a share concerns), and the caller's facts must independently
-- agree with it or the decision itself refuses.
create function vortex_access.revoke_record_share_for_administration(
  p_direct_share_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_activity_source text,
  p_activity_id uuid,
  p_facts jsonb
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
  declaration_binding jsonb;
  required_permissions jsonb;
  declaration jsonb;
  decision jsonb;
  revoked record;
begin
  if p_direct_share_id is null
    or not vortex_context.is_non_nil_uuid(p_direct_share_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_reason is null
    or pg_catalog.char_length(p_reason) not between 1 and 500
    or p_activity_source is null
    or p_activity_source not in (
      'web', 'workflow', 'interface', 'connection', 'federation', 'system'
    )
    or p_activity_id is null
    or not vortex_context.is_non_nil_uuid(p_activity_id::text)
    or p_facts is null
    or pg_catalog.jsonb_typeof(p_facts) <> 'object'
    or pg_catalog.jsonb_typeof(p_facts -> 'binding') <> 'object' then
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

  -- Current authority over the share (F4): the acting context must currently
  -- hold record.share for this exact record type, over this exact record,
  -- re-derived fresh under the lock just acquired via the same decision
  -- engine the grant path uses -- never the share's own granted_by identity,
  -- and never the grantor's present read/update field ceiling (revocation is
  -- a narrowing act, unlike granting, so it needs neither).
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
    and entry.record_scope is not null;

  -- No current candidate share permission at all: leave the decision unset
  -- rather than calling the decision engine with an empty requiredPermissions
  -- array, exactly like the grant path.
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

    decision := vortex_access.evaluate_organization_record_access_internal(
      declaration, current_share.record_id, p_facts
    );
  end if;

  if decision is null or decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '42501',
      message = 'Protected record-share revocation is unavailable';
  end if;

  select result.* into strict revoked
  from vortex_access.revoke_organization_direct_record_share(
    context_organization_id, p_direct_share_id, p_expected_revision,
    p_reason, context_account_id, context_correlation_id,
    p_activity_source, p_activity_id
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

-- Owner-only: no request/runtime/module-owner/record-owner/record-adapter
-- grant. A request role reaches either function only through a fixed
-- trusted adapter that resolves its own binding, reads the record's real
-- row and calls the operation below -- exactly as #35's own record decision
-- is never callable directly.
revoke execute on function vortex_access.grant_record_share_for_administration(
  uuid, uuid, text, uuid, uuid, uuid[], uuid[], timestamptz, timestamptz, text,
  text, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner, vortex_record_adapter;
revoke execute on function vortex_access.revoke_record_share_for_administration(
  uuid, bigint, text, text, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.grant_record_share_for_administration(
  uuid, uuid, text, uuid, uuid, uuid[], uuid[], timestamptz, timestamptz, text,
  text, uuid, jsonb
) is
  'Protected same-organisation direct-share grant: locks governance before confirming the grantor currently holds record.share and re-deriving their own current read/update ceiling from the live catalogue evaluated over the caller''s trusted facts, requires the proposal to be a subset of that ceiling, then invokes the existing private writer. Owner-only; a fixed trusted adapter supplies p_facts (the target record''s real row, relationships and conditions) and holds the only request-role grant, exactly as #35''s own record decision.';
comment on function vortex_access.revoke_record_share_for_administration(
  uuid, bigint, text, text, uuid, jsonb
) is
  'Protected direct-share revocation: only an account currently holding record.share over the share''s exact record, re-evaluated under the governance lock against the caller''s trusted facts, may invoke the existing private writer -- never the share''s granted_by identity, and never a re-requirement of the acting account''s present field ceiling. Owner-only; a fixed trusted adapter supplies p_facts and holds the only request-role grant.';
