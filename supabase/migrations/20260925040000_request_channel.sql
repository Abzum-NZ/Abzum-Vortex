-- #1093: carry the channel a protected operation was reached through in the
-- trusted request context, and keep one channel vocabulary for the Activity
-- source and the flow execution binding surface. The channel is set by the
-- trusted server entry point (the request-context resolver), never from client
-- input. The one vocabulary is:
--   web, mcp, programmatic_interface, connection, federation,
--   durable_workflow, system
-- It is mirrored by contracts/src/operation-contracts.ts
-- (protectedOperationChannelSchema, which documents each value) and shared with
-- the execution surface in contracts/src/application-flow-bindings.ts. Every
-- source value already stored (web, connection, system) stays valid and no
-- stored Activity row is rewritten; the former Activity source names workflow
-- and interface, which no stored row or caller used, are durable_workflow and
-- programmatic_interface. Per-wrapper p_activity_source lists are replaced by
-- the context channel in #1094 and #1095; every value a current caller passes
-- is in this vocabulary.

-- 1. The request-context validator accepts the optional trusted channel. It
--    stays optional so an existing context validates unchanged; an absent
--    channel keeps the historical 'web' meaning (vortex_context.channel()).
create or replace function vortex_context.validated(candidate jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  caller_kind text;
  authentication_strength text;
  issued_at timestamptz;
  expires_at timestamptz;
  access_token_issued_at timestamptz;
  primary_authenticated_at timestamptz;
  multi_factor_authenticated_at timestamptz;
  allowed_keys text[];
  nested jsonb;
begin
  if candidate is null or pg_catalog.jsonb_typeof(candidate) <> 'object' then
    raise exception using errcode = '22023', message = 'Vortex request context must be an object';
  end if;

  if not candidate ?& array[
    'callerKind', 'tenantId', 'organizationId', 'sessionId', 'issuedAt',
    'expiresAt', 'accessVersion', 'correlationId', 'authenticationStrength'
  ] then
    raise exception using errcode = '22023', message = 'Vortex request context is incomplete';
  end if;

  caller_kind := candidate ->> 'callerKind';
  authentication_strength := candidate ->> 'authenticationStrength';

  case caller_kind
    when 'human' then
      allowed_keys := array[
        'callerKind', 'identityAuthorityId', 'tenantId', 'organizationId',
        'applicationRootId', 'sessionId', 'issuedAt', 'expiresAt',
        'accessVersion', 'correlationId', 'identityId', 'organizationAccountId',
        'authenticationStrength', 'accessTokenIssuedAt', 'primaryAuthenticatedAt',
        'multiFactorAuthenticatedAt', 'delegatedContext', 'supportContext',
        'channel'
      ];
      if not candidate ? 'identityAuthorityId'
        or not vortex_context.is_non_nil_uuid(candidate ->> 'identityAuthorityId') then
        raise exception using errcode = '22023', message = 'Authenticated request context requires an Identity Authority';
      end if;
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor', 'recent_multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex human context has an invalid actor';
      end if;
    when 'federated' then
      allowed_keys := array[
        'callerKind', 'identityAuthorityId', 'tenantId', 'organizationId',
        'applicationRootId', 'sessionId', 'issuedAt', 'expiresAt',
        'accessVersion', 'correlationId', 'identityId', 'organizationAccountId',
        'authenticationStrength', 'channel'
      ];
      if not candidate ? 'identityAuthorityId'
        or not vortex_context.is_non_nil_uuid(candidate ->> 'identityAuthorityId') then
        raise exception using errcode = '22023', message = 'Authenticated request context requires an Identity Authority';
      end if;
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor', 'recent_multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex federated context has an invalid actor';
      end if;
    when 'system' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId',
        'sessionId', 'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'systemActorId', 'authenticationStrength', 'supportContext', 'channel'
      ];
      if not candidate ? 'systemActorId' or authentication_strength is distinct from 'service' then
        raise exception using errcode = '22023', message = 'Vortex system context has an invalid actor';
      end if;
    when 'public' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId',
        'sessionId', 'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'authenticationStrength', 'channel'
      ];
      if authentication_strength is distinct from 'anonymous' then
        raise exception using errcode = '22023', message = 'Vortex public context has an invalid actor';
      end if;
    else
      raise exception using errcode = '22023', message = 'Vortex request context has an unsupported caller kind';
  end case;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(candidate) as supplied(key)
    where not supplied.key = any (allowed_keys)
  ) then
    raise exception using errcode = '22023', message = 'Vortex request context has an unknown field';
  end if;

  if candidate ? 'channel'
    and (
      pg_catalog.jsonb_typeof(candidate -> 'channel') <> 'string'
      or (candidate ->> 'channel') <> all (array[
        'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
        'durable_workflow', 'system'
      ])
    ) then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid channel';
  end if;

  if not vortex_context.is_non_nil_uuid(candidate ->> 'tenantId')
    or not vortex_context.is_non_nil_uuid(candidate ->> 'organizationId')
    or not vortex_context.is_non_nil_uuid(candidate ->> 'sessionId')
    or not vortex_context.is_non_nil_uuid(candidate ->> 'correlationId')
    or (candidate ? 'applicationRootId' and not vortex_context.is_non_nil_uuid(candidate ->> 'applicationRootId'))
    or (candidate ? 'identityId' and not vortex_context.is_non_nil_uuid(candidate ->> 'identityId'))
    or (candidate ? 'organizationAccountId' and not vortex_context.is_non_nil_uuid(candidate ->> 'organizationAccountId'))
    or (candidate ? 'systemActorId' and not vortex_context.is_non_nil_uuid(candidate ->> 'systemActorId')) then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid identifier';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'accessVersion') <> 'number'
    or (candidate ->> 'accessVersion') !~ '^[1-9][0-9]*$'
    or (candidate ->> 'accessVersion')::numeric > 9007199254740991 then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid access version';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'issuedAt') <> 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'expiresAt') <> 'string'
    or (candidate ->> 'issuedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
    or (candidate ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid time';
  end if;

  begin
    issued_at := (candidate ->> 'issuedAt')::timestamptz;
    expires_at := (candidate ->> 'expiresAt')::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid time';
  end;

  if not pg_catalog.isfinite(issued_at)
    or not pg_catalog.isfinite(expires_at)
    or expires_at <= issued_at
    or expires_at <= pg_catalog.statement_timestamp() then
    raise exception using errcode = '22023', message = 'Vortex request context is expired or inconsistent';
  end if;

  if caller_kind = 'human' then
    if (candidate ? 'accessTokenIssuedAt')
      <> (candidate ? 'primaryAuthenticatedAt' or candidate ? 'multiFactorAuthenticatedAt') then
      raise exception using errcode = '22023', message = 'Vortex human authentication evidence is incomplete';
    end if;

    if candidate ? 'accessTokenIssuedAt' then
      if pg_catalog.jsonb_typeof(candidate -> 'accessTokenIssuedAt') <> 'string'
        or (candidate ->> 'accessTokenIssuedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        access_token_issued_at := (candidate ->> 'accessTokenIssuedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(access_token_issued_at)
        or access_token_issued_at >= expires_at
        or access_token_issued_at > issued_at + interval '60 seconds' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;

    if candidate ? 'primaryAuthenticatedAt' then
      if pg_catalog.jsonb_typeof(candidate -> 'primaryAuthenticatedAt') <> 'string'
        or (candidate ->> 'primaryAuthenticatedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        primary_authenticated_at := (candidate ->> 'primaryAuthenticatedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(primary_authenticated_at)
        or primary_authenticated_at > access_token_issued_at
        or primary_authenticated_at > pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;

    if candidate ? 'multiFactorAuthenticatedAt' then
      if authentication_strength not in ('multi_factor', 'recent_multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex human multi-factor evidence conflicts with authentication strength';
      end if;
      if pg_catalog.jsonb_typeof(candidate -> 'multiFactorAuthenticatedAt') <> 'string'
        or (candidate ->> 'multiFactorAuthenticatedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        multi_factor_authenticated_at := (candidate ->> 'multiFactorAuthenticatedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(multi_factor_authenticated_at)
        or multi_factor_authenticated_at > access_token_issued_at
        or multi_factor_authenticated_at > pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;
  end if;

  if candidate ? 'delegatedContext' then
    nested := candidate -> 'delegatedContext';
    if pg_catalog.jsonb_typeof(nested) <> 'object'
      or not nested ?& array['delegatedByOrganizationAccountId', 'reason', 'expiresAt']
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(nested) as supplied(key)
        where supplied.key <> all (array['delegatedByOrganizationAccountId', 'reason', 'expiresAt'])
      )
      or not vortex_context.is_non_nil_uuid(nested ->> 'delegatedByOrganizationAccountId')
      or pg_catalog.jsonb_typeof(nested -> 'reason') <> 'string'
      or pg_catalog.length(nested ->> 'reason') not between 1 and 500 then
      raise exception using errcode = '22023', message = 'Vortex delegated context is invalid';
    end if;
    if pg_catalog.jsonb_typeof(nested -> 'expiresAt') <> 'string'
      or (nested ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
      raise exception using errcode = '22023', message = 'Vortex delegated context has an invalid time';
    end if;
    begin
      if not pg_catalog.isfinite((nested ->> 'expiresAt')::timestamptz)
        or (nested ->> 'expiresAt')::timestamptz > expires_at
        or (nested ->> 'expiresAt')::timestamptz <= pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex delegated context is expired or inconsistent';
      end if;
    exception when invalid_datetime_format then
      raise exception using errcode = '22023', message = 'Vortex delegated context has an invalid time';
    end;
  end if;

  if candidate ? 'supportContext' then
    nested := candidate -> 'supportContext';
    if pg_catalog.jsonb_typeof(nested) <> 'object'
      or not nested ?& array['supportActorId', 'approvedByOrganizationAccountId', 'reason', 'expiresAt']
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(nested) as supplied(key)
        where supplied.key <> all (array['supportActorId', 'approvedByOrganizationAccountId', 'reason', 'expiresAt'])
      )
      or not vortex_context.is_non_nil_uuid(nested ->> 'supportActorId')
      or not vortex_context.is_non_nil_uuid(nested ->> 'approvedByOrganizationAccountId')
      or pg_catalog.jsonb_typeof(nested -> 'reason') <> 'string'
      or pg_catalog.length(nested ->> 'reason') not between 1 and 500 then
      raise exception using errcode = '22023', message = 'Vortex support context is invalid';
    end if;
    if pg_catalog.jsonb_typeof(nested -> 'expiresAt') <> 'string'
      or (nested ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
      raise exception using errcode = '22023', message = 'Vortex support context has an invalid time';
    end if;
    begin
      if not pg_catalog.isfinite((nested ->> 'expiresAt')::timestamptz)
        or (nested ->> 'expiresAt')::timestamptz > expires_at
        or (nested ->> 'expiresAt')::timestamptz <= pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex support context is expired or inconsistent';
      end if;
    exception when invalid_datetime_format then
      raise exception using errcode = '22023', message = 'Vortex support context has an invalid time';
    end;
  end if;

  return candidate;
end
$function$;

revoke execute on function vortex_context.validated(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function vortex_context.validated(jsonb)
  to vortex_runtime, vortex_request;

comment on function vortex_context.validated(jsonb) is
  'Validates one trusted request context, including its optional trusted channel, or fails closed.';

-- 2. One channel vocabulary on the Activity store, replacing the old source
--    list. Every value already stored (web, connection, system) stays valid.
alter table vortex_activity.organization_activity_entries
  drop constraint organization_activity_entries_source_valid;
alter table vortex_activity.organization_activity_entries
  add constraint organization_activity_entries_source_valid check (
    source in (
      'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
      'durable_workflow', 'system'
    )
  );

-- 3. The private Activity append states the same channel vocabulary and refuses
--    anything else before it reaches the table constraint.
create or replace function vortex_activity.append_organization_activity_entry(
  p_organization_id uuid,
  p_activity_id uuid,
  p_occurred_at timestamptz,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_subject_ids uuid[],
  p_changed_field_ids uuid[],
  p_source text,
  p_correlation_id uuid,
  p_outcome text
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  inserted_activity_id uuid;
  existing_entry vortex_activity.organization_activity_entries%rowtype;
begin
  if p_source is null
    or p_source <> all (array[
      'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
      'durable_workflow', 'system'
    ]) then
    raise exception using errcode = '22023', message = 'Activity source channel is invalid';
  end if;

  insert into vortex_activity.organization_activity_entries (
    organization_id, activity_id, occurred_at, actor_kind, actor_id, action,
    subject_ids, changed_field_ids, source, correlation_id, outcome
  ) values (
    p_organization_id, p_activity_id, p_occurred_at, p_actor_kind, p_actor_id,
    p_action, p_subject_ids, p_changed_field_ids, p_source, p_correlation_id,
    p_outcome
  )
  on conflict (organization_id, activity_id) do nothing
  returning activity_id into inserted_activity_id;

  if inserted_activity_id is not null then
    return 'inserted';
  end if;

  select entry.*
  into strict existing_entry
  from vortex_activity.organization_activity_entries as entry
  where entry.organization_id = p_organization_id
    and entry.activity_id = p_activity_id;

  if existing_entry.occurred_at is distinct from p_occurred_at
    or existing_entry.actor_kind is distinct from p_actor_kind
    or existing_entry.actor_id is distinct from p_actor_id
    or existing_entry.action is distinct from p_action
    or existing_entry.subject_ids is distinct from p_subject_ids
    or existing_entry.changed_field_ids is distinct from p_changed_field_ids
    or existing_entry.source is distinct from p_source
    or existing_entry.correlation_id is distinct from p_correlation_id
    or existing_entry.outcome is distinct from p_outcome then
    raise exception using
      errcode = '22023',
      message = 'Activity identity already records different evidence';
  end if;

  return 'already_recorded';
end
$function$;

revoke all on function vortex_activity.append_organization_activity_entry(
  uuid, uuid, timestamptz, text, uuid, text, uuid[], uuid[], text, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;

comment on function vortex_activity.append_organization_activity_entry(
  uuid, uuid, timestamptz, text, uuid, text, uuid[], uuid[], text, uuid, text
) is
  'Private content-free Activity append over the one channel vocabulary; an exact retry replays and different evidence under one identity is refused.';

-- 4. The protected Activity read filters accept the same one vocabulary.
create or replace function vortex_activity.read_organization_activity_page(
  p_occurred_from timestamptz,
  p_occurred_to timestamptz,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_correlation_id uuid,
  p_outcome text,
  p_source text,
  p_page_size integer,
  p_after_occurred_at timestamptz,
  p_after_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  context_organization_id uuid;
  context_identity_id uuid;
  context_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean := false;
  entries jsonb;
  has_more boolean := false;
  last_occurred_at timestamptz;
  last_activity_id uuid;
begin
  if p_page_size is null or p_page_size not between 1 and 200
    or (p_occurred_from is not null
      and p_occurred_from in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_to is not null
      and p_occurred_to in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_from is not null and p_occurred_to is not null
      and p_occurred_from > p_occurred_to)
    or (p_actor_kind is not null
      and p_actor_kind <> all (array['identity', 'organization_account', 'system', 'public_session']))
    or (p_actor_id is not null
      and p_actor_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_action is not null and (
      pg_catalog.char_length(p_action) not between 1 and 40
      or p_action !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    ))
    or (p_correlation_id is not null
      and p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_outcome is not null
      and p_outcome <> all (array['completed', 'refused', 'failed']))
    or (p_source is not null
      and p_source <> all (array[
        'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
        'durable_workflow', 'system'
      ]))
    or (p_after_occurred_at is null) <> (p_after_activity_id is null)
    or (p_after_occurred_at is not null
      and p_after_occurred_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_after_activity_id is not null
      and p_after_activity_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Activity history page selector is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Activity history is unavailable';
  end if;
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_identity_id := (checked_context ->> 'identityId')::uuid;
  context_account_id := (checked_context ->> 'organizationAccountId')::uuid;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.activity.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '687d5649-62ee-43dd-b684-b8af3a5394c1'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = context_organization_id
      and decision_account_id = context_account_id,
    false
  );

  with filtered as (
    select entry.*
    from vortex_activity.organization_activity_entries as entry
    where entry.organization_id = context_organization_id
      and (audit_projection
        or (entry.actor_kind = 'organization_account' and entry.actor_id = context_account_id)
        or (entry.actor_kind = 'identity' and entry.actor_id = context_identity_id))
      and (p_occurred_from is null or entry.occurred_at >= p_occurred_from)
      and (p_occurred_to is null or entry.occurred_at <= p_occurred_to)
      and (p_actor_kind is null or entry.actor_kind = p_actor_kind)
      and (p_actor_id is null or entry.actor_id = p_actor_id)
      and (p_action is null or entry.action = p_action)
      and (p_correlation_id is null or entry.correlation_id = p_correlation_id)
      and (p_outcome is null or entry.outcome = p_outcome)
      and (p_source is null or entry.source = p_source)
  ),
  ordered as (
    select filtered.*
    from filtered
    where p_after_occurred_at is null
      or (filtered.occurred_at, filtered.activity_id)
        < (p_after_occurred_at, p_after_activity_id)
    order by filtered.occurred_at desc, filtered.activity_id desc
    limit p_page_size + 1
  ),
  numbered as (
    select ordered.*,
      pg_catalog.row_number() over (
        order by ordered.occurred_at desc, ordered.activity_id desc
      ) as ordinal
    from ordered
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'activityId', numbered.activity_id,
          'occurredAt', numbered.occurred_at,
          'actorKind', numbered.actor_kind,
          'actorId', numbered.actor_id,
          'action', numbered.action,
          'subjectIds', pg_catalog.to_jsonb(numbered.subject_ids),
          'source', numbered.source,
          'correlationId', numbered.correlation_id,
          'outcome', numbered.outcome
        ) || case
          when audit_projection then pg_catalog.jsonb_build_object(
            'changedFieldIds', pg_catalog.to_jsonb(numbered.changed_field_ids)
          )
          else '{}'::jsonb
        end
        order by numbered.ordinal
      ) filter (where numbered.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    coalesce(pg_catalog.max(numbered.ordinal) > p_page_size, false),
    (pg_catalog.array_agg(numbered.occurred_at order by numbered.ordinal)
      filter (where numbered.ordinal = p_page_size))[1],
    (pg_catalog.array_agg(numbered.activity_id order by numbered.ordinal)
      filter (where numbered.ordinal = p_page_size))[1]
  into entries, has_more, last_occurred_at, last_activity_id
  from numbered;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'projection', case when audit_projection then 'audit' else 'own' end,
    'entries', entries,
    'next', case
      when has_more then pg_catalog.jsonb_build_object(
        'occurredAt', last_occurred_at,
        'activityId', last_activity_id
      )
      else null
    end
  );
end
$function$;

create or replace function vortex_activity.read_organization_activity_aggregates(
  p_occurred_from timestamptz,
  p_occurred_to timestamptz,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_correlation_id uuid,
  p_outcome text,
  p_source text,
  p_group_by text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  context_organization_id uuid;
  context_identity_id uuid;
  context_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean := false;
  groups jsonb;
  total bigint;
  truncated boolean;
begin
  if p_group_by is null
    or p_group_by <> all (array['action', 'actorKind', 'source', 'outcome'])
    or (p_occurred_from is not null
      and p_occurred_from in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_to is not null
      and p_occurred_to in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_from is not null and p_occurred_to is not null
      and p_occurred_from > p_occurred_to)
    or (p_actor_kind is not null
      and p_actor_kind <> all (array['identity', 'organization_account', 'system', 'public_session']))
    or (p_actor_id is not null
      and p_actor_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_action is not null and (
      pg_catalog.char_length(p_action) not between 1 and 40
      or p_action !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    ))
    or (p_correlation_id is not null
      and p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_outcome is not null
      and p_outcome <> all (array['completed', 'refused', 'failed']))
    or (p_source is not null
      and p_source <> all (array[
        'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
        'durable_workflow', 'system'
      ])) then
    raise exception using errcode = '22023',
      message = 'Activity history aggregate selector is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Activity history is unavailable';
  end if;
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_identity_id := (checked_context ->> 'identityId')::uuid;
  context_account_id := (checked_context ->> 'organizationAccountId')::uuid;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.activity.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '687d5649-62ee-43dd-b684-b8af3a5394c1'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = context_organization_id
      and decision_account_id = context_account_id,
    false
  );

  with filtered as (
    select entry.*
    from vortex_activity.organization_activity_entries as entry
    where entry.organization_id = context_organization_id
      and (audit_projection
        or (entry.actor_kind = 'organization_account' and entry.actor_id = context_account_id)
        or (entry.actor_kind = 'identity' and entry.actor_id = context_identity_id))
      and (p_occurred_from is null or entry.occurred_at >= p_occurred_from)
      and (p_occurred_to is null or entry.occurred_at <= p_occurred_to)
      and (p_actor_kind is null or entry.actor_kind = p_actor_kind)
      and (p_actor_id is null or entry.actor_id = p_actor_id)
      and (p_action is null or entry.action = p_action)
      and (p_correlation_id is null or entry.correlation_id = p_correlation_id)
      and (p_outcome is null or entry.outcome = p_outcome)
      and (p_source is null or entry.source = p_source)
  ),
  grouped as (
    select case p_group_by
        when 'action' then filtered.action
        when 'actorKind' then filtered.actor_kind
        when 'source' then filtered.source
        when 'outcome' then filtered.outcome
      end as value,
      pg_catalog.count(*)::bigint as entry_count
    from filtered
    group by 1
  ),
  ranked as (
    select grouped.value, grouped.entry_count,
      pg_catalog.row_number() over (
        order by grouped.entry_count desc, grouped.value
      ) as ordinal
    from grouped
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('value', ranked.value, 'count', ranked.entry_count)
        order by ranked.entry_count desc, ranked.value
      ) filter (where ranked.ordinal <= 100),
      '[]'::jsonb
    ),
    coalesce(pg_catalog.sum(ranked.entry_count), 0),
    pg_catalog.count(*) > 100
  into groups, total, truncated
  from ranked;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'projection', case when audit_projection then 'audit' else 'own' end,
    'total', total,
    'groups', groups,
    'truncated', truncated
  );
end
$function$;

revoke execute on function vortex_activity.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_activity.read_organization_activity_aggregates(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant usage on schema vortex_activity to vortex_request;
grant execute on function vortex_activity.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) to vortex_request;
grant execute on function vortex_activity.read_organization_activity_aggregates(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, text
) to vortex_request;

comment on function vortex_activity.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) is
  'Returns one bounded newest-first keyset page of the caller''s own organisation Activity, or the organisation-wide audit projection when the actor holds the organisation access-administration read authority.';

comment on function vortex_activity.read_organization_activity_aggregates(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, text
) is
  'Returns bounded group counts over the same protected Activity filters and projection as read_organization_activity_page.';

-- 5. The request context exposes its channel through one accessor. The value is
--    only ever the one the trusted entry point installed; when that entry point
--    set none, the channel is the historical web meaning. Nothing reads it from
--    client input.
create or replace function vortex_context.channel()
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(vortex_context.current_context() ->> 'channel', 'web')
$function$;

revoke execute on function vortex_context.channel()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_context.channel() to vortex_request;

comment on function vortex_context.channel() is
  'Returns the channel the trusted entry point installed in this transaction''s request context, or web when that entry point set none; never a client-supplied value.';

-- 6. Flow execution binding surfaces use the same one channel vocabulary.
--    register_flow_execution_binding is copied from its live definition
--    (20260923200000_flow_execution_bindings.sql; no later rewrite) and changes
--    only its permitted-surface list. The table bound on permitted surfaces
--    widens from five to the seven vocabulary values; every stored binding
--    already holds at most five, so no existing row changes or fails.
alter table vortex_access.flow_execution_bindings
  drop constraint flow_execution_bindings_bounds_shape;
alter table vortex_access.flow_execution_bindings
  add constraint flow_execution_bindings_bounds_shape check (
    pg_catalog.jsonb_typeof(permitted_invokers) = 'array'
    and pg_catalog.jsonb_array_length(permitted_invokers) between 1 and 20
    and pg_catalog.jsonb_typeof(permitted_surfaces) = 'array'
    and pg_catalog.jsonb_array_length(permitted_surfaces) between 1 and 7
    and pg_catalog.jsonb_typeof(permitted_inputs) = 'array'
    and pg_catalog.jsonb_array_length(permitted_inputs) <= 20
  );

create or replace function vortex_access.register_flow_execution_binding(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_release_version text,
  p_flow_id uuid,
  p_node_id uuid,
  p_operation_owner_kind text,
  p_operation_owner_id uuid,
  p_operation_id uuid,
  p_actor_kind text,
  p_actor_account_id uuid,
  p_actor_system_actor_id uuid,
  p_permitted_invokers jsonb,
  p_permitted_surfaces jsonb,
  p_permitted_inputs jsonb,
  p_expires_at timestamptz,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  result jsonb,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  command_fingerprint text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  current_binding vortex_access.flow_execution_bindings%rowtype;
  stored_binding vortex_access.flow_execution_bindings%rowtype;
  operation_at timestamptz;
  receipt_id uuid := pg_catalog.gen_random_uuid();
  next_revision bigint;
  activity_result text;
  permits_system boolean;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null
    or p_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_node_id is null or not vortex_context.is_non_nil_uuid(p_node_id::text)
    or p_operation_owner_kind is null
    or p_operation_owner_kind not in ('application', 'module', 'platform_service')
    or p_operation_owner_id is null or not vortex_context.is_non_nil_uuid(p_operation_owner_id::text)
    or (p_operation_owner_kind = 'application' and p_operation_owner_id <> p_application_root_id)
    or p_operation_id is null or not vortex_context.is_non_nil_uuid(p_operation_id::text)
    or p_actor_kind is null or p_actor_kind not in ('specified_user', 'system')
    or (p_actor_kind = 'specified_user' and (
      p_actor_account_id is null or not vortex_context.is_non_nil_uuid(p_actor_account_id::text)
      or p_actor_system_actor_id is not null))
    or (p_actor_kind = 'system' and (
      p_actor_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_actor_system_actor_id::text)
      or p_actor_account_id is not null))
    or p_permitted_invokers is null or pg_catalog.jsonb_typeof(p_permitted_invokers) <> 'array'
    or pg_catalog.jsonb_array_length(p_permitted_invokers) not between 1 and 20
    or p_permitted_surfaces is null or pg_catalog.jsonb_typeof(p_permitted_surfaces) <> 'array'
    or pg_catalog.jsonb_array_length(p_permitted_surfaces) not between 1 and 5
    or p_permitted_inputs is null or pg_catalog.jsonb_typeof(p_permitted_inputs) <> 'array'
    or pg_catalog.jsonb_array_length(p_permitted_inputs) > 20
    or (p_expected_revision is not null and p_expected_revision not between 1 and 9007199254740991)
    or (p_expires_at is not null and p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or p_activity_id is null or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow execution binding command is invalid';
  end if;

  -- Exact invoker, surface and input bounds: known shapes only, no duplicates.
  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_invokers) as invoker(value)
      where pg_catalog.jsonb_typeof(invoker.value) <> 'object'
        or not (
          (invoker.value = '{"kind":"system"}'::jsonb)
          or (
            invoker.value ->> 'kind' = 'organization_account'
            and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(invoker.value)) = 2
            and pg_catalog.jsonb_typeof(invoker.value -> 'organizationAccountId') = 'string'
            and vortex_context.is_non_nil_uuid(invoker.value ->> 'organizationAccountId')
          )
        )
    )
    or (
      select pg_catalog.count(distinct case invoker.value ->> 'kind'
        when 'system' then 'system'
        else 'account:' || pg_catalog.lower(invoker.value ->> 'organizationAccountId')
      end)
      from pg_catalog.jsonb_array_elements(p_permitted_invokers) as invoker(value)
    ) <> pg_catalog.jsonb_array_length(p_permitted_invokers)
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_surfaces) as surface(value)
      where pg_catalog.jsonb_typeof(surface.value) <> 'string'
        or surface.value #>> '{}' not in (
          'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
          'durable_workflow', 'system')
    )
    or (
      select pg_catalog.count(distinct surface.value)
      from pg_catalog.jsonb_array_elements(p_permitted_surfaces) as surface(value)
    ) <> pg_catalog.jsonb_array_length(p_permitted_surfaces)
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_inputs) as input(value)
      where pg_catalog.jsonb_typeof(input.value) <> 'string'
        or pg_catalog.char_length(input.value #>> '{}') not between 1 and 40
        or (input.value #>> '{}') !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    )
    or (
      select pg_catalog.count(distinct input.value)
      from pg_catalog.jsonb_array_elements(p_permitted_inputs) as input(value)
    ) <> pg_catalog.jsonb_array_length(p_permitted_inputs) then
    raise exception using errcode = '22023', message = 'Flow execution binding bounds are invalid';
  end if;

  permits_system := p_permitted_invokers @> '[{"kind":"system"}]'::jsonb;
  if (p_actor_kind = 'system') <> permits_system then
    raise exception using errcode = '22023',
      message = 'Only a system execution binding permits, and must permit, the system origin';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'grant'
  ) as granted;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'register_flow_execution_binding',
      p_organization_id::text,
      p_execution_binding_id::text,
      p_application_root_id::text,
      p_release_version,
      p_flow_id::text,
      p_node_id::text,
      p_operation_owner_kind,
      p_operation_owner_id::text,
      p_operation_id::text,
      p_actor_kind,
      coalesce(p_actor_account_id::text, ''),
      coalesce(p_actor_system_actor_id::text, ''),
      p_permitted_invokers::text,
      p_permitted_surfaces::text,
      p_permitted_inputs::text,
      coalesce(vortex_access.flow_execution_binding_timestamp_internal(p_expires_at), ''),
      coalesce(p_expected_revision::text, '')
    ), 'UTF8'),
    'sha256'), 'hex');

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_actor_organization_account_id
    and stored.tenant_id = authority.tenant_id
    and stored.operation_key = 'register_flow_execution_binding'
    and stored.duplicate_key = p_duplicate_key
  for update;

  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_execution_binding_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow execution binding duplicate conflicts';
    end if;
    select binding.* into stored_binding
    from vortex_access.flow_execution_bindings as binding
    where binding.execution_binding_id = p_execution_binding_id
      and binding.revision = receipt.subject_revisions[1]
      and binding.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow execution binding replay is unavailable';
    end if;
    return query select 'replayed'::text,
      vortex_access.flow_execution_binding_to_json_internal(stored_binding),
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  -- The effective person and every named invoker must be active accounts of
  -- this organisation now; #686 re-checks their lifecycle at each use.
  if p_actor_kind = 'specified_user' and not exists (
      select 1 from vortex_identity.organization_accounts as account
      where account.organization_account_id = p_actor_account_id
        and account.organization_id = p_organization_id
        and account.state = 'active'
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_invokers) as invoker(value)
      where invoker.value ->> 'kind' = 'organization_account'
        and not exists (
          select 1 from vortex_identity.organization_accounts as account
          where account.organization_account_id = (invoker.value ->> 'organizationAccountId')::uuid
            and account.organization_id = p_organization_id
            and account.state = 'active'
        )
    ) then
    raise exception using errcode = '42501', message = 'Flow execution binding account is unavailable';
  end if;

  select binding.* into current_binding
  from vortex_access.flow_execution_bindings as binding
  where binding.execution_binding_id = p_execution_binding_id
    and binding.is_current
  for update;

  if found then
    if current_binding.organization_id is distinct from p_organization_id then
      raise exception using errcode = '23505', message = 'Flow execution binding identity is unavailable';
    end if;
    if p_expected_revision is null then
      raise exception using errcode = '23505', message = 'Flow execution binding already exists';
    end if;
    if current_binding.state = 'revoked' then
      raise exception using errcode = 'V3101', message = 'A revoked flow execution binding cannot be revived';
    end if;
    if current_binding.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Flow execution binding revision is stale';
    end if;
    if current_binding.application_root_id is distinct from p_application_root_id
      or current_binding.release_version is distinct from p_release_version
      or current_binding.flow_id is distinct from p_flow_id
      or current_binding.node_id is distinct from p_node_id
      or current_binding.operation_owner_kind is distinct from p_operation_owner_kind
      or current_binding.operation_owner_id is distinct from p_operation_owner_id
      or current_binding.operation_id is distinct from p_operation_id
      or current_binding.actor_kind is distinct from p_actor_kind
      or current_binding.actor_organization_account_id is distinct from p_actor_account_id
      or current_binding.actor_system_actor_id is distinct from p_actor_system_actor_id then
      raise exception using errcode = '22023', message = 'Flow execution binding scope is immutable';
    end if;
    next_revision := current_binding.revision + 1;
  else
    if p_expected_revision is not null then
      raise exception using errcode = 'V3102', message = 'Flow execution binding is unavailable';
    end if;
    next_revision := 1;
  end if;

  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at is not null and p_expires_at <= operation_at then
    raise exception using errcode = '22023', message = 'Flow execution binding expiry must be in the future';
  end if;

  if next_revision > 1 then
    update vortex_access.flow_execution_bindings as binding
    set is_current = false
    where binding.execution_binding_id = p_execution_binding_id
      and binding.revision = current_binding.revision;
  end if;

  insert into vortex_access.flow_execution_bindings (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version,
    flow_id, node_id, operation_owner_kind, operation_owner_id, operation_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    permitted_invokers, permitted_surfaces, permitted_inputs,
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at
  ) values (
    p_execution_binding_id, next_revision, true,
    p_organization_id, p_application_root_id, p_release_version,
    p_flow_id, p_node_id, p_operation_owner_kind, p_operation_owner_id, p_operation_id,
    p_actor_kind, p_actor_account_id, p_actor_system_actor_id,
    p_permitted_invokers, p_permitted_surfaces, p_permitted_inputs,
    p_expires_at, 'active', operation_at, p_actor_organization_account_id, authority.correlation_id, null
  ) returning * into stored_binding;

  perform 1 from vortex_access.increment_organization_access_version(
    p_organization_id, p_actor_organization_account_id, authority.correlation_id,
    'access_grant_changed'
  );

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    case when next_revision = 1
      then 'register_flow_execution_binding'
      else 'replace_flow_execution_binding'
    end,
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    'web',
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow execution binding Activity is stale';
  end if;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    receipt_id, p_actor_organization_account_id, authority.tenant_id,
    'register_flow_execution_binding', p_duplicate_key, command_fingerprint,
    array[p_execution_binding_id], array[next_revision], operation_at
  );

  return query select 'accepted'::text,
    vortex_access.flow_execution_binding_to_json_internal(stored_binding),
    receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid,
  jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid,
  jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) to vortex_request;

comment on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid,
  jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) is
  'Registers or replaces one exact flow execution binding at its next revision; permitted surfaces are drawn from the one channel vocabulary.';
