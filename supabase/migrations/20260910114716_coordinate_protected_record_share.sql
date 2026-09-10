-- Protected same-organisation direct record sharing (#37 slice 3). Reuses
-- #36's private structural writers unchanged: they already do the revision
-- check, Activity append and Access invalidation. These two functions own the
-- one thing the writers deliberately do not: making sure a share can never
-- give the recipient field access the grantor does not currently hold
-- themselves. No table changes, no second writer, no second Activity append,
-- no second Access change.
--
-- The grantor's own current read (and, when relevant, update) authority is
-- re-derived here, fresh, under the same governance lock the writer itself
-- takes -- never accepted as a caller-supplied fact. #35's exact-record
-- decision (20260910040755_compose_exact_record_access_decision.sql) and
-- #37 slice 1's field-bounds resolver
-- (20260910094534_resolve_record_field_bounds.sql) are the only sources of
-- that ceiling; this migration adds no second evaluator.
--
-- That current-decision recomputation still needs a "records" fact for the
-- exact target and a permission "declaration" naming the candidate
-- permissions, exactly like every other caller of the private decision
-- engine (the neutral fixed adapters in SQL430/440/445). No generic,
-- storage-reading adapter exists yet for arbitrary application-defined
-- record types -- that is #45's explicit, separately-tracked scope
-- (docs/build-plan/issue-35-row-policy-composition.md, "Trusted record
-- adapters"). Building one here would be exactly the kind of unrequested
-- machinery the brief warns against, and accepting the target record's real
-- field/ownership facts as a parameter from vortex_request would reopen the
-- "generic wrapper accepting ownership/row/relationship JSON from a caller"
-- hole that same document rules out. So the declaration this migration
-- builds is deliberately narrow: it looks up every *current* record-scoped
-- permission on the exact target record type from the live catalogue
-- itself (never caller-supplied), and evaluates it over the minimal facts
-- that are safe to assert without reading the record's real row --
-- identity/type/lifecycle only, an empty relationship/condition graph, no
-- claimed ownership. That is sufficient, and sound, for the two record-scope
-- routes that do not need a real row read: an organisation/application-wide
-- "all_records" grant, and an existing "direct_share" already held by the
-- grantor (read via #36's own real, generic
-- read_current_direct_record_share_contributions). "ownership" and
-- "relationship" routed permissions are excluded from the declaration (the
-- former would simply never admit without real owner data; the latter would
-- hard-fail decision evaluation on the missing relationship graph, per
-- 20260910040755's own "Record access facts are invalid" checks), so a
-- grantor whose *only* current authority is ownership- or relationship-
-- routed cannot yet share through this function. That is the concrete,
-- reported gap, not a silently narrowed test.

-- Takes the exact target record, the recipient, the proposed readable and
-- changeable fields and the share's validity window. Never a decision, a
-- field-set ceiling, a permission or an allow flag from the caller.
create function vortex_access.grant_record_share_for_administration(
  p_direct_share_id uuid,
  p_storage_scope text,
  p_application_root_id uuid,
  p_module_root_id uuid,
  p_record_type_id uuid,
  p_storage_contract_id uuid,
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
  target_facts jsonb;
  needed record;
  required_permissions jsonb;
  declaration jsonb;
  decision jsonb;
  bounds jsonb;
  read_admitted boolean := false;
  readable_ceiling uuid[] := array[]::uuid[];
  changeable_ceiling uuid[] := array[]::uuid[];
  granted record;
begin
  if p_direct_share_id is null
    or not vortex_context.is_non_nil_uuid(p_direct_share_id::text)
    or p_storage_scope is null
    or p_storage_scope not in ('organization_shared', 'application_contained')
    or (p_storage_scope = 'organization_shared' and p_application_root_id is not null)
    or (p_storage_scope = 'application_contained' and (
      p_application_root_id is null
      or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    ))
    or p_module_root_id is null
    or not vortex_context.is_non_nil_uuid(p_module_root_id::text)
    or p_record_type_id is null
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or p_storage_contract_id is null
    or not vortex_context.is_non_nil_uuid(p_storage_contract_id::text)
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
    or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
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

  -- Steps 3 and 5: the grantor's current record decision, evaluated fresh
  -- under the lock just acquired. Read is always evaluated (a share must
  -- name at least one readable field); update is evaluated only when
  -- changeable fields are actually proposed, so a grantor with read but no
  -- update authority is never wrongly required to hold update authority
  -- they do not need. Facts are the minimal, safe-to-assert projection
  -- described above -- identity/type/lifecycle only, no claimed ownership,
  -- no relationship or condition graph -- shared unchanged between both
  -- decisions.
  target_facts := pg_catalog.jsonb_build_object(
    'binding', pg_catalog.jsonb_build_object(
      'moduleRootId', p_module_root_id, 'recordTypeId', p_record_type_id,
      'storageContractId', p_storage_contract_id, 'storageScope', p_storage_scope
    ),
    'recordTypes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'moduleRootId', p_module_root_id, 'recordTypeId', p_record_type_id,
      'storageContractId', p_storage_contract_id, 'storageScope', p_storage_scope,
      'ownershipMode', 'none', 'fields', '[]'::jsonb
    )),
    'relationships', '[]'::jsonb,
    'sharingConditions', '[]'::jsonb,
    'records', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordScope', pg_catalog.jsonb_build_object(
        'storageScope', p_storage_scope,
        'organizationId', context_organization_id,
        'moduleRootId', p_module_root_id,
        'recordTypeId', p_record_type_id,
        'storageContractId', p_storage_contract_id,
        'recordId', p_record_id
      ) || case when p_storage_scope = 'application_contained'
        then pg_catalog.jsonb_build_object('applicationRootId', p_application_root_id)
        else '{}'::jsonb
      end,
      'lifecycleState', 'active',
      'fieldValues', '{}'::jsonb
    )),
    'edges', '[]'::jsonb
  );

  for needed in
    select 'read' as action_kind, 'record.share.read' as operation_key
    union all
    select 'update', 'record.share.update'
    where pg_catalog.cardinality(p_changeable_field_ids) > 0
  loop
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
        or (entry.owner_kind = 'module' and entry.owner_id = p_module_root_id)
      )
      and entry.record_type_id = p_record_type_id
      and entry.action_kind = needed.action_kind
      and entry.record_scope is not null
      and not (entry.record_scope ? 'savedCondition')
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(entry.record_scope -> 'routes') as route(value)
        where route.value ->> 'kind' = 'relationship'
      );

    -- No current candidate permission at all for this action kind: leave it
    -- unadmitted below rather than calling the decision engine with an
    -- empty requiredPermissions array, which it treats as a malformed
    -- declaration, not a graceful refusal.
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
      'recordBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', p_module_root_id, 'recordTypeId', p_record_type_id,
        'storageContractId', p_storage_contract_id, 'storageScope', p_storage_scope
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    );

    decision := vortex_access.evaluate_organization_record_access_internal(
      declaration, p_record_id, target_facts
    );

    if decision ->> 'outcome' = 'allowed' then
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
      if needed.action_kind = 'read' then
        read_admitted := true;
        select coalesce(pg_catalog.array_agg((elem.value)::uuid), array[]::uuid[])
        into readable_ceiling
        from pg_catalog.jsonb_array_elements_text(bounds -> 'readableFieldIds') as elem(value);
      else
        select coalesce(pg_catalog.array_agg((elem.value)::uuid), array[]::uuid[])
        into changeable_ceiling
        from pg_catalog.jsonb_array_elements_text(bounds -> 'changeableFieldIds') as elem(value);
      end if;
    end if;
  end loop;

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
  select result.* into strict granted
  from vortex_access.grant_organization_direct_record_share(
    context_organization_id, p_direct_share_id, p_storage_scope,
    p_application_root_id, p_module_root_id, p_record_type_id,
    p_storage_contract_id, p_record_id, p_recipient_kind,
    p_organization_account_id, p_group_id, p_readable_field_ids,
    p_changeable_field_ids, p_starts_at, p_expires_at, p_reason,
    context_account_id, context_correlation_id, p_activity_source, p_activity_id
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

-- Takes only the share id and the expected revision. Revocation is a
-- narrowing operation: it is always permitted to someone with current
-- authority over the share (here, the share's own grantor), never waits for
-- an approval, never requires the grantor to still hold the field ceiling
-- they had when granting, and never revives an already-expired or already-
-- revoked share -- all of that is the existing writer's own job.
create function vortex_access.revoke_record_share_for_administration(
  p_direct_share_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_activity_source text,
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
  locked_access_version bigint;
  current_share vortex_access.organization_direct_record_shares%rowtype;
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
    or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023',
      message = 'Protected record-share revocation input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

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

  -- Current authority over the share: its own grantor, checked directly --
  -- never the grantor's present field ceiling, and never a stand-in for the
  -- writer's own revision/state check just below.
  select share.* into current_share
  from vortex_access.organization_direct_record_shares as share
  where share.organization_id = context_organization_id
    and share.direct_share_id = p_direct_share_id
  for update;
  if not found or current_share.granted_by <> context_account_id then
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

revoke execute on function vortex_access.grant_record_share_for_administration(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid[], uuid[],
  timestamptz, timestamptz, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime;
revoke execute on function vortex_access.revoke_record_share_for_administration(
  uuid, bigint, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_access.grant_record_share_for_administration(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid[], uuid[],
  timestamptz, timestamptz, text, text, uuid
) to vortex_request;
grant execute on function vortex_access.revoke_record_share_for_administration(
  uuid, bigint, text, text, uuid
) to vortex_request;

comment on function vortex_access.grant_record_share_for_administration(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid[], uuid[],
  timestamptz, timestamptz, text, text, uuid
) is
  'Protected same-organisation direct-share grant: locks governance before re-deriving the grantor''s own current read/update ceiling from the live catalogue, requires the proposal to be its subset, then invokes the existing private writer.';
comment on function vortex_access.revoke_record_share_for_administration(
  uuid, bigint, text, text, uuid
) is
  'Protected direct-share revocation: only the share''s own grantor, checked under the governance lock, may invoke the existing private writer -- never re-requires their present field ceiling.';
