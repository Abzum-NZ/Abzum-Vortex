create or replace function vortex_access.grant_record_share_for_administration(
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
  read_admitted boolean := false;
  readable_ceiling uuid[] := array[]::uuid[];
  changeable_ceiling uuid[] := array[]::uuid[];
  granted record;
  grantor_authority_until timestamptz;
  earliest_authority_until timestamptz;
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
  if p_recipient_kind = 'organization_account'
    and p_organization_account_id = context_account_id then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant cannot target the grantor''s own account';
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
    -- not a graceful refusal. For share (N3/N4), this is the genuine "no
    -- permission at all" cause, so it raises right here, while that is still
    -- the known reason -- the alternative, waiting until after the loop,
    -- would have nothing left to say why, because a later iteration's own
    -- query overwrites required_permissions before the loop ends.
    if required_permissions is null then
      if needed.action_kind = 'share' then
        raise exception using errcode = '42501',
          message = 'Protected record-share grant requires a current share permission';
      end if;
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
    -- How long this admitted authority lasts, beyond the session; null
    -- does not expire and so does not lower the bound.
    if decision ->> 'outcome' = 'allowed' then
      grantor_authority_until := vortex_access.record_share_grantor_authority_until_internal(
        declaration, p_record_id, p_facts, context_value
      );
      earliest_authority_until := least(earliest_authority_until, grantor_authority_until);
    end if;

    if needed.action_kind = 'share' then
      -- Step 3b (F1): the grantor must currently hold record.share for this
      -- exact record type, over this exact record. Checked first -- before
      -- any ceiling comparison and before any mutation -- by raising here,
      -- inline, while this decision is still the fresh one (the next
      -- iteration, evaluating read, would overwrite it). A share-permission
      -- candidate existed (required_permissions was not null, above); when
      -- this decision still did not admit it, `reasonCode` says which of two
      -- real causes it was (N3/N4), already computed by the decision itself
      -- rather than new state added here: `record_scope_refused` is a
      -- target the grantor's share authority cannot currently reach -- a
      -- nonexistent or soft-deleted record, an organisation/application
      -- mismatch, or a record no held route (ownership, an existing direct
      -- share, a relationship edge, a saved condition) actually connects
      -- them to -- distinct from every other reason, which is never holding
      -- an effective share permission at all (stale eligibility, an
      -- unsupported delegated/support context, or recent-authentication
      -- unsatisfied -- none reachable from this migration's own fixed
      -- declaration today, but named correctly regardless). F3 (slice 7):
      -- the message previously said the target record was "unavailable",
      -- which a caller who does hold a real share permission could read as
      -- "no such record" specifically -- an existence oracle for exactly the
      -- callers this refusal exists to stop. `record_scope_refused` covers
      -- both a record that does not currently exist and one that does but
      -- matched no held route, and the wording below no longer distinguishes
      -- them, on purpose.
      if decision ->> 'outcome' <> 'allowed' then
        if decision ->> 'reasonCode' = 'record_scope_refused' then
          raise exception using errcode = '42501',
            message = 'Protected record-share grant target record is not within your current share authority';
        else
          raise exception using errcode = '42501',
            message = 'Protected record-share grant requires a current share permission';
        end if;
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

  -- Reaching here means the share iteration above admitted -- it always
  -- raises otherwise, and it always runs first (order by step).

  -- Step 4: the proposed readable fields must be a subset of the grantor's
  -- current readable set. A share must include at least one readable field,
  -- matching the existing writer's own requirement. Split in two (N3/N4) so
  -- the message names its real cause: holding no current read authority
  -- that reaches this exact record at all, versus holding some but
  -- proposing beyond it. F4 (slice 7) adds a third: the read decision can be
  -- 'allowed' while every admitted contribution's own field policy is
  -- non-null but names no readable field at all (resolve_record_field_
  -- bounds_internal's own "a missing policy contributes no fields" rule
  -- means an *explicitly empty* one contributes none either) -- an empty
  -- ceiling is not exceeded by any non-empty proposal, so it is not the same
  -- cause as holding a non-empty ceiling too narrow for the proposal, and is
  -- named separately rather than folded into "exceeds".
  if not read_admitted then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant requires a current read permission';
  end if;
  if pg_catalog.cardinality(readable_ceiling) = 0 then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant currently holds no readable fields for this record';
  end if;
  if pg_catalog.cardinality(p_readable_field_ids) = 0
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
  -- The share never outlasts the earliest authority it was granted under.
  if earliest_authority_until is not null
    and (p_expires_at is null or p_expires_at > earliest_authority_until) then
    p_expires_at := earliest_authority_until;
  end if;
  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant cannot outlast your own authority';
  end if;
  select result.* into strict granted
  from vortex_access.grant_organization_direct_record_share(
    context_organization_id, p_direct_share_id, target_storage_scope,
    case when target_storage_scope = 'application_contained' then context_application_root_id else null end,
    target_module_root_id, target_record_type_id, target_storage_contract_id, p_record_id,
    p_recipient_kind, p_organization_account_id, p_group_id,
    p_readable_field_ids, p_changeable_field_ids, p_starts_at, p_expires_at,
    p_reason, context_account_id, context_correlation_id,
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

revoke execute on function vortex_access.grant_record_share_for_administration(
  uuid, uuid, text, uuid, uuid, uuid[], uuid[], timestamptz, timestamptz, text,
  uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.grant_record_share_for_administration(
  uuid, uuid, text, uuid, uuid, uuid[], uuid[], timestamptz, timestamptz, text,
  uuid, jsonb
) is
  'Protected same-organisation direct-share grant: locks governance before confirming the grantor currently holds record.share and re-deriving their own current read/update ceiling from the live catalogue evaluated over the caller''s trusted facts, requires the proposal to be a subset of that ceiling, then invokes the existing private writer. Owner-only; a fixed trusted adapter supplies p_facts (the target record''s real row, relationships and conditions) and holds the only request-role grant, exactly as #35''s own record decision.';
