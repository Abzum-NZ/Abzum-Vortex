-- Reuse the shared SQL validators, timestamp formatter and validated-context dispatcher.
begin;

create or replace function vortex_context.is_non_nil_uuid(candidate text)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $function$
  select
    coalesce(
      candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and candidate <> '00000000-0000-0000-0000-000000000000',
      false
    )
$function$;

revoke execute on function vortex_context.is_non_nil_uuid(text)
  from public, anon, authenticated, service_role;
grant execute on function vortex_context.is_non_nil_uuid(text)
  to vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter,
    vortex_module_owner;

comment on function vortex_context.is_non_nil_uuid(text) is
  'Accepts only a non-nil RFC UUID with a version nibble from 1 through 8 and an RFC variant nibble.';

create or replace function vortex_context.format_timestamp_utc(p_value timestamptz)
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select pg_catalog.to_char(
    pg_catalog.timezone('UTC', p_value), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )
$function$;

revoke execute on function vortex_context.format_timestamp_utc(timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_context.format_timestamp_utc(timestamptz)
  to vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_context.format_timestamp_utc(timestamptz) is
  'Formats one timestamp as a UTC ISO-8601 text value with six fractional digits.';

create or replace function vortex_context.uuid_array_is_canonical(p_values uuid[])
returns boolean
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $function$
declare
  current_value uuid;
  previous_value uuid;
begin
  if coalesce(pg_catalog.array_ndims(p_values), 1) <> 1
    or coalesce(pg_catalog.array_lower(p_values, 1), 1) <> 1 then
    return false;
  end if;

  foreach current_value in array p_values loop
    if current_value is null
      or not vortex_context.is_non_nil_uuid(current_value::text)
      or (previous_value is not null and previous_value >= current_value) then
      return false;
    end if;
    previous_value := current_value;
  end loop;

  return true;
end
$function$;

revoke execute on function vortex_context.uuid_array_is_canonical(uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_context.uuid_array_is_canonical(uuid[])
  to vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_context.uuid_array_is_canonical(uuid[]) is
  'Accepts only a one-dimensional array of strict non-nil UUIDs in ascending unique order.';

create or replace function vortex_context.validated_service_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_context.current_context();
begin
  case established ->> 'callerKind'
    when 'human' then
      return vortex_access.validated_human_request_context();
    when 'system' then
      return vortex_definition.validated_system_context();
    else
      raise exception using
        errcode = '42501',
        message = 'Request requires a validated human or system context';
  end case;
end
$function$;

revoke execute on function vortex_context.validated_service_context()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_context.validated_service_context() is
  'Dispatches an established request context through the authoritative human or system validator.';

create or replace function vortex_connection.validated_administration_context(p_organization_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb;
  ctx_org_id uuid;
begin
  ctx := vortex_context.validated_service_context();
  if ctx ->> 'callerKind' = 'human' then
    perform vortex_connection.assert_connection_administration_authority(ctx);
  end if;
  ctx_org_id := (ctx ->> 'organizationId')::uuid;

  if ctx_org_id is distinct from p_organization_id then
    raise exception using
      errcode = '42501',
      message = 'Connection operation organization does not match request context organization';
  end if;

  return ctx;
end;
$function$;

revoke all on function vortex_connection.validated_administration_context(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_connection.validated_administration_context(uuid) is
  'Returns a matching validated system context or a matching human context with connection administration authority.';

create or replace function vortex_file.upload_validated_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return vortex_context.validated_service_context();
end
$function$;

revoke execute on function vortex_file.upload_validated_context() from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_file.upload_validated_context() is
  'Returns the established upload context after the shared human or system context validator accepts it.';

set local role vortex_record_owner;

create or replace function vortex_record.is_record_type_lifecycle_policy(p_policy jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    p_policy is not null
    and pg_catalog.jsonb_typeof(p_policy) = 'object'
    and p_policy ?& array[
      'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
      'policyRevision', 'action', 'maxAgeDays', 'maxCount',
      'allowUnlimitedAge', 'allowUnlimitedCount'
    ]
    and vortex_context.is_non_nil_uuid(p_policy ->> 'policyId')
    and vortex_context.is_non_nil_uuid(p_policy ->> 'organizationId')
    and vortex_context.is_non_nil_uuid(p_policy ->> 'storageContractId')
    and (
      pg_catalog.jsonb_typeof(p_policy -> 'applicationRootId') = 'null'
      or vortex_context.is_non_nil_uuid(p_policy ->> 'applicationRootId')
    )
    and vortex_record.is_lifecycle_revision_value(p_policy -> 'policyRevision')
    and p_policy ->> 'action' in ('delete', 'archive_workflow')
    and pg_catalog.jsonb_typeof(p_policy -> 'allowUnlimitedAge') = 'boolean'
    and pg_catalog.jsonb_typeof(p_policy -> 'allowUnlimitedCount') = 'boolean'
    and vortex_record.is_lifecycle_limit_value(p_policy -> 'maxAgeDays')
    and vortex_record.is_lifecycle_limit_value(p_policy -> 'maxCount')
    -- Closed representation: an explicit ceiling or an explicit unlimited
    -- permission, never both and never a silent missing-limit fallback.
    and (p_policy -> 'allowUnlimitedAge' = 'true'::jsonb)
      = (pg_catalog.jsonb_typeof(p_policy -> 'maxAgeDays') = 'null')
    and (p_policy -> 'allowUnlimitedCount' = 'true'::jsonb)
      = (pg_catalog.jsonb_typeof(p_policy -> 'maxCount') = 'null')
    and case
      when p_policy ->> 'action' = 'delete' then
        p_policy - array[
          'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
          'policyRevision', 'action', 'maxAgeDays', 'maxCount',
          'allowUnlimitedAge', 'allowUnlimitedCount', 'recoveryWindowDays'
        ] = '{}'::jsonb
        and (
          not p_policy ? 'recoveryWindowDays'
          or case
            when pg_catalog.jsonb_typeof(p_policy -> 'recoveryWindowDays') = 'number'
              and (p_policy ->> 'recoveryWindowDays') ~ '^[1-9][0-9]{0,8}$'
            then (p_policy ->> 'recoveryWindowDays')::bigint <= 104249991
            else false end
        )
      else
        p_policy ?& array[
          'archiveWorkflowId', 'expectedWorkflowRevision', 'archiveConnectionInstanceId',
          'archiveDestination', 'expectedConnectionRevision',
          'expectedDestinationFingerprint', 'expectedConnectionHealthOutcome'
        ]
        and p_policy - array[
          'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
          'policyRevision', 'action', 'maxAgeDays', 'maxCount',
          'allowUnlimitedAge', 'allowUnlimitedCount',
          'archiveWorkflowId', 'expectedWorkflowRevision', 'archiveConnectionInstanceId',
          'archiveDestination', 'expectedConnectionRevision',
          'expectedDestinationFingerprint', 'expectedConnectionHealthOutcome'
        ] = '{}'::jsonb
        and vortex_context.is_non_nil_uuid(p_policy ->> 'archiveWorkflowId')
        and vortex_context.is_non_nil_uuid(p_policy ->> 'archiveConnectionInstanceId')
        and vortex_record.is_lifecycle_revision_value(p_policy -> 'expectedWorkflowRevision')
        and vortex_record.is_lifecycle_revision_value(p_policy -> 'expectedConnectionRevision')
        and pg_catalog.jsonb_typeof(p_policy -> 'archiveDestination') = 'string'
        and vortex_record.is_lifecycle_destination(p_policy ->> 'archiveDestination')
        and pg_catalog.jsonb_typeof(p_policy -> 'expectedDestinationFingerprint') = 'string'
        and (p_policy ->> 'expectedDestinationFingerprint') ~ '^[a-f0-9]{64}$'
        and p_policy ->> 'expectedConnectionHealthOutcome' = 'healthy'
    end,
    false
  );
$function$;

revoke all on function vortex_record.is_record_type_lifecycle_policy(jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_record.is_record_type_lifecycle_policy(jsonb) is
  'Closed shape check for one complete stored record-type lifecycle policy; guards both the protected save and the stored row.';

create or replace function vortex_record.initialize_organization_lifecycle_limits(
  p_organization_id uuid,
  p_limits jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_record.organization_lifecycle_limits%rowtype;
  max_retention_value bigint;
  max_count_value bigint;
  allow_unlimited_retention_value boolean;
  allow_unlimited_count_value boolean;
  allowed_actions_value text[];
  allowed_destinations_value text[];
begin
  if p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_limits is null
    or pg_catalog.jsonb_typeof(p_limits) <> 'object'
    or not p_limits ?& array[
      'organizationId', 'settingsRevision', 'maxRetentionDays', 'maxRecordCount',
      'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount', 'allowedActions',
      'allowedArchiveDestinations'
    ]
    or p_limits - array[
      'organizationId', 'settingsRevision', 'maxRetentionDays', 'maxRecordCount',
      'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount', 'allowedActions',
      'allowedArchiveDestinations'
    ] <> '{}'::jsonb
    or not vortex_context.is_non_nil_uuid(p_limits ->> 'organizationId')
    or pg_catalog.lower(p_limits ->> 'organizationId')
      <> pg_catalog.lower(p_organization_id::text)
    or (p_limits -> 'settingsRevision') <> pg_catalog.to_jsonb(1)
    or pg_catalog.jsonb_typeof(p_limits -> 'allowUnlimitedRetentionDays') <> 'boolean'
    or pg_catalog.jsonb_typeof(p_limits -> 'allowUnlimitedRecordCount') <> 'boolean'
    or not vortex_record.is_lifecycle_limit_value(p_limits -> 'maxRetentionDays')
    or not vortex_record.is_lifecycle_limit_value(p_limits -> 'maxRecordCount')
    or (p_limits -> 'allowUnlimitedRetentionDays' = 'true'::jsonb)
      <> (pg_catalog.jsonb_typeof(p_limits -> 'maxRetentionDays') = 'null')
    or (p_limits -> 'allowUnlimitedRecordCount' = 'true'::jsonb)
      <> (pg_catalog.jsonb_typeof(p_limits -> 'maxRecordCount') = 'null')
    or pg_catalog.jsonb_typeof(p_limits -> 'allowedActions') <> 'array'
    or pg_catalog.jsonb_typeof(p_limits -> 'allowedArchiveDestinations') <> 'array'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_limits -> 'allowedActions') = 'array'
          then p_limits -> 'allowedActions' else '[]'::jsonb end
      ) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'string'
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(p_limits -> 'allowedArchiveDestinations') = 'array'
            then p_limits -> 'allowedArchiveDestinations'
          else '[]'::jsonb
        end
      ) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'string'
    ) then
    raise exception using errcode = '22023',
      message = 'Organisation lifecycle limits setup is invalid';
  end if;

  max_retention_value := case
    when pg_catalog.jsonb_typeof(p_limits -> 'maxRetentionDays') = 'null' then null
    else (p_limits #>> '{maxRetentionDays}')::bigint
  end;
  max_count_value := case
    when pg_catalog.jsonb_typeof(p_limits -> 'maxRecordCount') = 'null' then null
    else (p_limits #>> '{maxRecordCount}')::bigint
  end;
  allow_unlimited_retention_value := (p_limits -> 'allowUnlimitedRetentionDays') = 'true'::jsonb;
  allow_unlimited_count_value := (p_limits -> 'allowUnlimitedRecordCount') = 'true'::jsonb;
  select coalesce(
    pg_catalog.array_agg(item.value #>> '{}' order by item.ordinal),
    array[]::text[]
  )
    into allowed_actions_value
  from pg_catalog.jsonb_array_elements(p_limits -> 'allowedActions')
    with ordinality as item(value, ordinal);
  select coalesce(
    pg_catalog.array_agg(item.value #>> '{}' order by item.ordinal),
    array[]::text[]
  )
    into allowed_destinations_value
  from pg_catalog.jsonb_array_elements(p_limits -> 'allowedArchiveDestinations')
    with ordinality as item(value, ordinal);

  if not vortex_record.is_lifecycle_action_list(allowed_actions_value)
    or not vortex_record.is_lifecycle_destination_list(allowed_destinations_value)
    or (
      'archive_workflow' = any (allowed_actions_value)
      and pg_catalog.cardinality(allowed_destinations_value) = 0
    ) then
    raise exception using errcode = '22023',
      message = 'Organisation lifecycle limits setup is invalid';
  end if;

  -- Serialize the absent-row case as well as retries against an existing row.
  -- Locking only the settings row cannot coordinate two concurrent first calls.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_record.lifecycle_limits:' || p_organization_id::text,
      0
    )
  );

  -- The existing row is the setup decision for this organisation. Locking it
  -- makes two simultaneous identical calls behave as retries.
  select stored.* into existing
  from vortex_record.organization_lifecycle_limits as stored
  where stored.organization_id = p_organization_id
  for update;

  if found then
    if existing.settings_revision <> 1
      or existing.max_retention_days is distinct from max_retention_value
      or existing.max_record_count is distinct from max_count_value
      or existing.allow_unlimited_retention_days is distinct from allow_unlimited_retention_value
      or existing.allow_unlimited_record_count is distinct from allow_unlimited_count_value
      or existing.allowed_actions is distinct from allowed_actions_value
      or existing.allowed_archive_destinations is distinct from allowed_destinations_value then
      raise exception using errcode = '40001',
        message = 'Organisation lifecycle limits are already initialised differently';
    end if;
  else
    begin
      insert into vortex_record.organization_lifecycle_limits (
        organization_id, settings_revision, max_retention_days, max_record_count,
        allow_unlimited_retention_days, allow_unlimited_record_count,
        allowed_actions, allowed_archive_destinations
      ) values (
        p_organization_id, 1, max_retention_value, max_count_value,
        allow_unlimited_retention_value, allow_unlimited_count_value,
        allowed_actions_value, allowed_destinations_value
      ) returning * into existing;
    exception when unique_violation then
      raise exception using errcode = '40001',
        message = 'Organisation lifecycle limits are already initialised differently';
    end;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', existing.organization_id,
    'settingsRevision', existing.settings_revision,
    'maxRetentionDays', existing.max_retention_days,
    'maxRecordCount', existing.max_record_count,
    'allowUnlimitedRetentionDays', existing.allow_unlimited_retention_days,
    'allowUnlimitedRecordCount', existing.allow_unlimited_record_count,
    'allowedActions', pg_catalog.to_jsonb(existing.allowed_actions),
    'allowedArchiveDestinations', pg_catalog.to_jsonb(existing.allowed_archive_destinations)
  );
end
$function$;

revoke all on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb) to vortex_runtime;

comment on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb) is
  'Trusted explicit setup of one organisation lifecycle ceiling row at revision 1; identical retries return the existing row and conflicting retries refuse.';

grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create or replace function vortex_record.read_time_clock_internal()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  zone_value text;
  instant_value timestamp with time zone := pg_catalog.statement_timestamp();
begin
  context_value := vortex_access.validated_human_request_context();
  -- No time zone is ever assumed: without the organisation's own settings the
  -- local date is unknown, so a date deadline is withheld or refused rather
  -- than worked out in the wrong zone. Exact-instant deadlines need no zone.
  zone_value := vortex_identity.read_organization_time_zone_internal(
    (context_value ->> 'organizationId')::uuid
  );
  return pg_catalog.jsonb_build_object(
    'instant', vortex_context.format_timestamp_utc(instant_value),
    'organizationLocalDate', case when zone_value is null then null else pg_catalog.to_char(
      pg_catalog.timezone(zone_value, instant_value), 'YYYY-MM-DD'
    ) end,
    'timeZone', zone_value
  );
end
$function$;

revoke all on function vortex_record.read_time_clock_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.read_time_clock_internal() is
  'The one statement timestamp and the current date in the organisation time zone of the validated request context (null when the organisation has no time zone), which every read-time calculation in a statement uses; owner-only.';

reset role;

create or replace function vortex_invalidation.publish_change_notice(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_record_version bigint,
  p_change_kind text,
  p_data_version bigint,
  p_sequence bigint,
  p_correlation_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  selected_topic text;
  selected_payload jsonb;
  stored_context text;
begin
  if p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_record_type_id is null
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or (p_record_id is not null and not vortex_context.is_non_nil_uuid(p_record_id::text))
    or (p_record_version is not null
      and p_record_version not between 1 and 9007199254740991)
    or p_change_kind is null
    or not (
      p_change_kind = any (
        vortex_access.validation_reference_list('private_invalidation_change_kind')
      )
    )
    or p_data_version is null
    or p_data_version not between 1 and 9007199254740991
    or p_sequence is null
    or p_sequence not between 1 and 9007199254740991
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text) then
    raise exception using errcode = '22023',
      message = 'Invalidation notice command is invalid';
  end if;

  stored_context := pg_catalog.current_setting('vortex.request_context', true);
  if stored_context is not null and stored_context <> ''
    and (vortex_context.current_context() ->> 'organizationId')::uuid
      is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Invalidation notice scope is unavailable';
  end if;

  if not exists (
    select 1
    from vortex_identity.organizations as organization
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where organization.organization_id = p_organization_id
      and organization.state = 'active'
      and tenant.state = 'active'
  ) or not vortex_invalidation.application_is_installed(
    p_organization_id, p_application_root_id
  ) then
    raise exception using errcode = 'P0002',
      message = 'Invalidation notice scope is unavailable';
  end if;

  selected_topic := vortex_invalidation.change_topic(p_organization_id, p_application_root_id);

  selected_payload := pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'recordTypeId', p_record_type_id,
    'changeKind', p_change_kind,
    'dataVersion', p_data_version,
    'sequence', p_sequence,
    'occurredAt', vortex_context.format_timestamp_utc(operation_at),
    'correlationId', p_correlation_id
  )
  || case when p_record_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('recordId', p_record_id) end
  || case when p_record_version is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('recordVersion', p_record_version) end;

  perform realtime.send(selected_payload, 'invalidation', selected_topic, true);

  return selected_topic;
end
$function$;

revoke all on function vortex_invalidation.publish_change_notice(
  uuid, uuid, uuid, uuid, bigint, text, bigint, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_invalidation.publish_change_notice(
  uuid, uuid, uuid, uuid, bigint, text, bigint, bigint, uuid
) to vortex_request, vortex_runtime, vortex_record_adapter;

comment on function vortex_invalidation.publish_change_notice(
  uuid, uuid, uuid, uuid, bigint, text, bigint, bigint, uuid
) is
  'Protected post-commit broadcast of the bounded content-free invalidation envelope on the private topic for one organisation and application.';

create or replace function vortex_identity.grant_tenant_administrator(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_subject_identity_id uuid,
  p_capabilities jsonb,
  p_starts_at timestamptz,
  p_expires_at timestamptz
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  capabilities text[];
  computed_fingerprint text;
  expiry_cap timestamptz;
  evaluated_at timestamptz;
  actor_identity_id uuid;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_subject_identity_id is null or not vortex_context.is_non_nil_uuid(p_subject_identity_id::text)
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' or capabilities is null
    or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))) then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  perform 1 from vortex_identity.identity_projections projection
    where projection.identity_id in (actor_identity_id, p_subject_identity_id)
    order by projection.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments assignment
    where assignment.tenant_id = p_tenant_id and assignment.identity_id = actor_identity_id
    order by assignment.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at
  );
  if p_subject_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'grant_tenant_administrator',
      p_tenant_id::text, p_subject_identity_id::text, pg_catalog.array_to_string(capabilities, ','),
      vortex_context.format_timestamp_utc(p_starts_at),
      coalesce(vortex_context.format_timestamp_utc(p_expires_at), '')),
      'UTF8'), 'sha256'), 'hex');
  if not exists (
      select 1 from vortex_identity.identity_projections p
      where p.identity_id = p_subject_identity_id and p.state = 'active'
    ) or exists (
      select 1 from pg_catalog.unnest(capabilities) c
      where not exists (
        select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and c = any(a.capability_keys)
      )
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'grant_tenant_administrator'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'grant_tenant_administrator'::text,
      receipt.subject_ids[1], receipt.subject_revisions[1], receipt.receipt_id, receipt.accepted_at;
    return;
  end if;
  expiry_cap := vortex_identity.tenant_administrator_grant_expiry_cap(
    actor_identity_id, p_tenant_id, capabilities, evaluated_at
  );
  if expiry_cap is not null and (p_expires_at is null or p_expires_at > expiry_cap) then
    p_expires_at := expiry_cap;
  end if;
  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception using errcode = '42501', message = 'Tenant assignment cannot outlast your own authority';
  end if;
  insert into vortex_identity.tenant_administrator_assignments values (
    new_assignment_id, p_tenant_id, p_subject_identity_id, capabilities, p_starts_at, p_expires_at, 1,
    evaluated_at, actor_identity_id, new_correlation_id, evaluated_at, actor_identity_id, new_correlation_id, null, null, null
  );
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id, 'grant_tenant_administrator',
    p_duplicate_key, computed_fingerprint, array[new_assignment_id], array[1::bigint], evaluated_at
  );
  return query select 'accepted'::text, 'grant_tenant_administrator'::text,
    new_assignment_id, 1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator grant under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry and accepted replay.';

create or replace function vortex_identity.change_tenant_administrator(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_expected_revision bigint,
  p_capabilities jsonb,
  p_starts_at timestamptz,
  p_expires_at timestamptz
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  capabilities text[];
  computed_fingerprint text;
  expiry_cap timestamptz;
  evaluated_at timestamptz;
  actor_identity_id uuid;
  target_identity_id uuid;
  current_revision bigint;
  current_revoked_at timestamptz;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or capabilities is null or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))) then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  select a.identity_id into target_identity_id
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  perform 1 from vortex_identity.identity_projections p
    where p.identity_id in (actor_identity_id, target_identity_id)
    order by p.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments a
    where a.tenant_id = p_tenant_id
      and (a.identity_id = actor_identity_id or a.assignment_id = p_assignment_id)
    order by a.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id,
    'platform.tenant.administrators.manage', evaluated_at
  );
  if target_identity_id is null or not exists (
      select 1 from vortex_identity.identity_projections p
      where p.identity_id = target_identity_id and p.state = 'active'
    ) or exists (
      select 1 from pg_catalog.unnest(capabilities) c
      where not exists (
        select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and c = any(a.capability_keys)
      )
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if target_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'change_tenant_administrator',
      p_tenant_id::text, p_assignment_id::text, p_expected_revision::text,
      pg_catalog.array_to_string(capabilities, ','),
      vortex_context.format_timestamp_utc(p_starts_at),
      coalesce(vortex_context.format_timestamp_utc(p_expires_at), '')),
      'UTF8'), 'sha256'), 'hex');
  select a.revision, a.revoked_at into current_revision, current_revoked_at
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'change_tenant_administrator'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'change_tenant_administrator'::text,
      p_assignment_id, receipt.subject_revisions[1], receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;
  expiry_cap := vortex_identity.tenant_administrator_grant_expiry_cap(
    actor_identity_id, p_tenant_id, capabilities, evaluated_at
  );
  if expiry_cap is not null and (p_expires_at is null or p_expires_at > expiry_cap) then
    p_expires_at := expiry_cap;
  end if;
  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception using errcode = '42501', message = 'Tenant assignment cannot outlast your own authority';
  end if;
  if current_revision is null or current_revoked_at is not null then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Tenant assignment revision is stale';
  end if;
  if not (
      'platform.tenant.administrators.manage' = any(capabilities)
      and p_starts_at <= evaluated_at and p_expires_at is null
    ) and not vortex_identity.tenant_has_permanent_manager(
      p_tenant_id, evaluated_at, p_assignment_id
    ) then
    raise exception using errcode = 'V3103', message = 'Permanent tenant manager is required';
  end if;
  resulting_revision := current_revision + 1;
  update vortex_identity.tenant_administrator_assignments
  set capability_keys = capabilities, starts_at = p_starts_at,
    expires_at = p_expires_at, revision = resulting_revision,
    changed_at = evaluated_at, changed_by_actor_id = actor_identity_id,
    change_correlation_id = new_correlation_id
  where tenant_administrator_assignments.assignment_id = p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'change_tenant_administrator', p_duplicate_key, computed_fingerprint,
    array[p_assignment_id], array[resulting_revision], evaluated_at
  );
  return query select 'accepted'::text, 'change_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator change under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry, exact revision and accepted replay.';

set local role vortex_record_adapter;

create or replace function vortex_record.relationship_total_record_snapshot_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid,
  p_lock boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  columns_value jsonb;
  value_expression text;
  load_sql text;
  result_value jsonb;
begin
  if p_record_type_id is null or p_record_id is null or p_lock is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') <> 'array' then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if record_type is null then return null; end if;

  select stored.* into catalogue_row
  from vortex_record.storage_catalogue stored
  where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
    and stored.record_type_id = p_record_type_id
    and stored.state = 'active';
  if not found then return null; end if;

  select pg_catalog.jsonb_object_agg(
    pg_catalog.lower(field.value ->> 'fieldId'),
    pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type,
      'type', field.value ->> 'type'
    )
  ) into columns_value
  from pg_catalog.jsonb_array_elements(record_type -> 'fields') field(value)
  join vortex_record.field_storage_mappings mapping
    on mapping.storage_contract_id = (record_type ->> 'storageContractId')::uuid
   and mapping.field_id = (field.value ->> 'fieldId')::uuid
   and mapping.state = 'active';
  if (select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(coalesce(columns_value, '{}'::jsonb))) <>
      pg_catalog.jsonb_array_length(record_type -> 'fields') then
    return null;
  end if;

  select pg_catalog.string_agg(
    field_chunk.pairs_text,
    ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
  )
  into value_expression
  from (
    select (ordered_fields.field_number - 1) / 50 as chunk_index,
      pg_catalog.string_agg(
        pg_catalog.format(
          '%L, %s', ordered_fields.key,
          case ordered_fields.value ->> 'databaseValueType'
            when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', ordered_fields.value ->> 'token')
            when 'timestamp_with_time_zone' then pg_catalog.format(
              'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(stored.%I))',
              ordered_fields.value ->> 'token'
            )
            when 'date' then pg_catalog.format(
              'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              ordered_fields.value ->> 'token'
            )
            else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', ordered_fields.value ->> 'token')
          end
        ), ', ' order by ordered_fields.key collate "C"
      ) as pairs_text
    from (
      select entry.key, entry.value,
        pg_catalog.row_number() over (
          order by entry.key collate "C"
        ) as field_number
      from pg_catalog.jsonb_each(columns_value) entry(key, value)
    ) as ordered_fields
    group by (ordered_fields.field_number - 1) / 50
  ) as field_chunk;

  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordType'', $3 - ''moduleReleaseRevision'',
       ''recordTypeId'', %L::uuid,
       ''storageContractId'', %L::uuid,
       ''recordId'', stored.record_id,
       ''concurrencyNumber'', stored.concurrency_number,
       ''definitionRevision'', %L::bigint,
       ''existingValues'', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
     )
     from record_data.%I stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active''
       and stored.application_root_id is not distinct from %s%s',
    p_record_type_id,
    (record_type ->> 'storageContractId')::uuid,
    (record_type ->> 'moduleReleaseRevision')::bigint,
    value_expression,
    catalogue_row.physical_table_token,
    case when record_type ->> 'storageScope' = 'application_contained'
      then '$4::uuid' else 'null::uuid' end,
    case when p_lock then ' for update' else '' end
  );
  execute load_sql into result_value using
    (context_value ->> 'organizationId')::uuid,
    p_record_id,
    record_type,
    (context_value ->> 'applicationRootId')::uuid;
  return result_value;
end
$function$;

revoke all on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
)
  to vortex_record_adapter;
comment on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
) is
  'Private locked-or-read snapshot of one record for the validated human Application request context.';

create or replace function vortex_record.resolve_installation_access_plan_internal(
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  none_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  plan_key_value text;
  cached_plan jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  application_release_revision_value bigint;
  binding_item jsonb;
  release_content jsonb;
  release_revision_value bigint;
  release_validation_contract_version text;
  record_type_item jsonb;
  field_item jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  permission_item jsonb;
  module_root_value uuid;
  record_type_id_value uuid;
  storage_contract_value uuid;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb;
  value_expression text;
  plan jsonb;
  cacheable boolean;
begin
  -- The plan is keyed by the exact installation pins. A binding revision is
  -- advanced by every installation lifecycle transition, and a release revision
  -- is immutable, so any change to definitions, bindings, permissions or saved
  -- conditions yields a different key and therefore a different plan. A plan
  -- that no longer matches the live pins can never be selected. The plan holds
  -- declared requirements only: role grants and every other decision input are
  -- read live by Access, never from the plan.
  if p_installation is null
    or pg_catalog.jsonb_typeof(p_installation) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_installation -> 'moduleBindings') is distinct from 'array'
    or (p_installation ->> 'organizationId') is null
    or (p_installation ->> 'applicationRootId') is null
    or (p_installation ->> 'applicationReleaseRevision') is null
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not item.value ?& array[
          'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state'
        ]
    ) then
    raise exception using errcode = '42501',
      message = 'Record installation is unavailable';
  end if;

  organization_id_value := (p_installation ->> 'organizationId')::uuid;
  application_root_id_value := (p_installation ->> 'applicationRootId')::uuid;
  application_release_revision_value :=
    (p_installation ->> 'applicationReleaseRevision')::bigint;
  if organization_id_value = none_uuid
    or application_root_id_value = none_uuid
    or application_release_revision_value not between 1 and 9007199254740991 then
    raise exception using errcode = '42501',
      message = 'Record installation is unavailable';
  end if;

  plan_key_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      organization_id_value::text || '|' || application_root_id_value::text || '|'
        || application_release_revision_value::text || '|' || coalesce((
          select pg_catalog.string_agg(
            (item.value ->> 'moduleRootId') || ':'
              || (item.value ->> 'moduleReleaseRevision') || ':'
              || (item.value ->> 'bindingRevision') || ':'
              || (item.value ->> 'state'),
            ',' order by (item.value ->> 'moduleRootId') collate "C"
          )
          from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
        ), ''),
      'UTF8'
    )),
    'hex'
  );

  -- Only an all-active pin set is cached. The storage catalogue and field
  -- mappings the plan resolves are not part of the key; storage adoption can
  -- retire a field mapping only while no provisioned or active binding pins a
  -- release that declares the field, so an active plan's mappings cannot
  -- change under it. A detached binding is not counted there, so a detached
  -- pin set is resolved afresh on every call and still refuses a retired
  -- mapping exactly as before.
  cacheable := not exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
    where (item.value ->> 'state') is distinct from 'active'
  );

  if cacheable then
    select stored.plan into cached_plan
    from vortex_record.installation_access_plans as stored
    where stored.plan_key = plan_key_value;
    if cached_plan is not null then
      return cached_plan;
    end if;
  end if;

  -- Step 1: the pinned definitions. Record types, relationships and saved
  -- conditions of every bound Module, plus the declared permissions of the
  -- Application release and of each Module release. Physical tokens are
  -- resolved here too, and every disagreement refuses.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
    -- Canonical binding order, so the plan content never depends on the order
    -- a caller happened to supply and always matches the plan key's order.
    order by (item.value ->> 'moduleRootId') collate "C"
  loop
    module_root_value := (binding_item ->> 'moduleRootId')::uuid;
    release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;

    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict release_content, release_validation_contract_version
    from vortex_definition.releases as release
    where release.root_id = module_root_value
      and release.release_revision = release_revision_value;

    if pg_catalog.jsonb_typeof(release_content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;

    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes') as item(value)
    loop
      record_type_id_value := (record_type_item ->> 'recordTypeId')::uuid;
      storage_contract_value := (record_type_item ->> 'storageContractId')::uuid;

      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = storage_contract_value;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> module_root_value
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        -- A system projection is read only through the protected reader
        -- registered for exactly the key its installed definition declares (the
        -- catalogue key references the closed registry); a generated record
        -- type is never read through a projection, and a disagreeing key
        -- refuses.
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}'))
        or not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and storage_contract_value = any (provision.storage_contract_ids)
        ) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      -- The column map and the one value expression that reads this record
      -- type's row, built once here and reused by every load below.
      columns_value := '{}'::jsonb;
      for field_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        select mapping.* into mapping_row
        from vortex_record.field_storage_mappings as mapping
        where mapping.storage_contract_id = storage_contract_value
          and mapping.field_id = (field_item ->> 'fieldId')::uuid;
        if not found or mapping_row.state <> 'active' then
          raise exception using errcode = '55000',
            message = 'Record storage disagrees with the installed definition';
        end if;
        columns_value := columns_value || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), pg_catalog.jsonb_build_object(
            'token', mapping_row.physical_column_token,
            'databaseValueType', mapping_row.database_value_type,
            'type', field_item ->> 'type'
          )
        );
      end loop;

      select pg_catalog.string_agg(
        field_chunk.pairs_text,
        ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
      )
      into value_expression
      from (
        select (ordered_fields.field_number - 1) / 50 as chunk_index,
          pg_catalog.string_agg(
            pg_catalog.format(
              '%L, %s',
              ordered_fields.key,
              case ordered_fields.value ->> 'databaseValueType'
                when 'decimal' then
                  pg_catalog.format('pg_catalog.to_jsonb(%I::text)', ordered_fields.value ->> 'token')
                when 'timestamp_with_time_zone' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(%I))',
                    ordered_fields.value ->> 'token'
                  )
                when 'date' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
                    ordered_fields.value ->> 'token'
                  )
                else pg_catalog.format('pg_catalog.to_jsonb(%I)', ordered_fields.value ->> 'token')
              end
            ),
            ', ' order by ordered_fields.key collate "C"
          ) as pairs_text
        from (
          select column_entry.key, column_entry.value,
            pg_catalog.row_number() over (
              order by column_entry.key collate "C"
            ) as field_number
          from pg_catalog.jsonb_each(columns_value) as column_entry(key, value)
        ) as ordered_fields
        group by (ordered_fields.field_number - 1) / 50
      ) as field_chunk;

      type_meta := type_meta || pg_catalog.jsonb_build_object(
        pg_catalog.lower(record_type_id_value::text),
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_root_value,
          'recordTypeId', record_type_id_value,
          'storageContractId', storage_contract_value,
          'storageScope', record_type_item ->> 'storageScope',
          'ownershipMode', record_type_item ->> 'ownershipMode',
          'releaseRevision', release_revision_value,
          'validationContractVersion', release_validation_contract_version,
          'table', catalogue_row.physical_table_token,
          'columns', columns_value,
          'valueExpression', value_expression,
          'fields', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'fieldId', declared.value -> 'fieldId',
                'type', declared.value -> 'type'
              ) || case
                when pg_catalog.jsonb_typeof(declared.value -> 'settings') = 'object'
                  then pg_catalog.jsonb_build_object('settings', declared.value -> 'settings')
                else '{}'::jsonb
              end
              order by declared.ordinality
            )
            from pg_catalog.jsonb_array_elements(record_type_item -> 'fields')
              with ordinality as declared(value, ordinality)
          ), '[]'::jsonb)
        ) || case
          when record_type_item ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', record_type_item -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
      );

      for relationship_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'relationships') as item(value)
      loop
        -- Every declared target, single or polymorphic, as one uniform list;
        -- Access proves a concrete edge target a member of it.
        relationship_by_id := relationship_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(relationship_item ->> 'relationshipId'),
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_item -> 'relationshipId',
            'fromModuleRootId', module_root_value,
            'fromRecordTypeId', record_type_item -> 'recordTypeId',
            'toRecordTypes', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'moduleRootId', target.value -> 'moduleRootId',
                'recordTypeId', target.value -> 'recordTypeId'
              ) order by target.ordinality)
              from pg_catalog.jsonb_array_elements(
                case when relationship_item ? 'toRecordType'
                  then pg_catalog.jsonb_build_array(relationship_item -> 'toRecordType')
                  else relationship_item -> 'toRecordTypes'
                end
              ) with ordinality as target(value, ordinality)
            ), '[]'::jsonb)
          )
        );
      end loop;
    end loop;

    for condition_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'sharingConditions') = 'array'
            then release_content -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      condition_list := condition_list || pg_catalog.jsonb_build_array(condition_item);
    end loop;

    for permission_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
            then release_content -> 'permissions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
        permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(permission_item ->> 'permissionId'),
          pg_catalog.jsonb_build_object(
            'ownerKind', 'module',
            'ownerId', module_root_value,
            'recordTypeId', permission_item -> 'recordTypeId',
            'actionKind', permission_item -> 'actionKind',
            'namedAction', permission_item -> 'namedAction',
            'recordScope', permission_item -> 'recordScope'
          )
        );
      end if;
    end loop;
  end loop;

  select release.compilation_output #> '{canonical,content}'
  into strict release_content
  from vortex_definition.releases as release
  where release.root_id = application_root_id_value
    and release.release_revision = application_release_revision_value;

  for permission_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
          then release_content -> 'permissions'
        else '[]'::jsonb
      end
    ) as item(value)
  loop
    if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
      permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(permission_item ->> 'permissionId'),
        pg_catalog.jsonb_build_object(
          'ownerKind', 'application',
          'ownerId', application_root_id_value,
          'recordTypeId', permission_item -> 'recordTypeId',
          'actionKind', permission_item -> 'actionKind',
          'namedAction', permission_item -> 'namedAction',
          'recordScope', permission_item -> 'recordScope'
        )
      );
    end if;
  end loop;

  plan := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'applicationReleaseRevision', application_release_revision_value,
    'recordTypes', type_meta,
    'relationships', relationship_by_id,
    'sharingConditions', condition_list,
    'permissions', permission_by_id
  );

  if not cacheable then
    return plan;
  end if;

  -- A concurrent builder may have stored the same plan first. Both were built
  -- from the same immutable pins, so either row is the same plan; this call's
  -- own plan is returned when that row is not yet visible to its snapshot.
  insert into vortex_record.installation_access_plans (
    plan_key, organization_id, application_root_id,
    application_release_revision, plan
  ) values (
    plan_key_value, organization_id_value, application_root_id_value,
    application_release_revision_value, plan
  )
  on conflict (plan_key) do nothing;

  select stored.plan into cached_plan
  from vortex_record.installation_access_plans as stored
  where stored.plan_key = plan_key_value;
  return coalesce(cached_plan, plan);
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

revoke all on function vortex_record.resolve_installation_access_plan_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.resolve_installation_access_plan_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_record.resolve_installation_access_plan_internal(jsonb) is
  'Private installation access plan builder and cache: resolves definitions, column maps, permission alternatives and saved conditions once per all-active installation binding revision; a detached pin set is resolved afresh.';

create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb,
  p_user_inputs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- The most candidate rows one request examines. A page that the budget ends
  -- early still returns a position, so a later request resumes exactly there.
  scan_limit constant integer := 500;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  trivial_condition constant jsonb :=
    '{"kind":"comparison","operator":"is_empty","left":{"source":"value","value":null}}'::jsonb;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  field_kind text;
  semantic_type text;
  selected_ids text[];
  requested_ids text[] := array[]::text[];
  sort_item jsonb;
  sort_ids text[] := array[]::text[];
  declared_sort_ids text[] := array[]::text[];
  sort_directions text[] := array[]::text[];
  sort_value_sql text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_field_columns jsonb := '{}'::jsonb;
  filter_field_database_types jsonb := '{}'::jsonb;
  filter_read_time_expressions jsonb := '{}'::jsonb;
  filter_plan jsonb;
  filter_predicate text;
  filter_parameters jsonb := '[]'::jsonb;
  input_item jsonb;
  input_key text;
  input_value jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  after_sort_key text[];
  after_record_id uuid;
  sort_index integer;
  column_sql text;
  value_sql text;
  pushed boolean;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  order_by_sql text;
  scan_sql text;
  access_plan record;
  readable_field_ids text[] := array[]::text[];
  access_sql text;
  scan_record record;
  examined integer := 0;
  budget_exhausted boolean := false;
  more_rows boolean := false;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  row_capabilities jsonb;
  rows_value jsonb := '[]'::jsonb;
  row_count integer := 0;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  last_returned_sort_key text[];
  last_returned_record_id uuid;
  next_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  list_key text;
  declared_list jsonb;
  parsed_ids text[];
  declared_lists jsonb := '{}'::jsonb;
  declared_sortable_ids text[] := array[]::text[];
  declared_filterable_ids text[] := array[]::text[];
  declared_searchable_ids text[] := array[]::text[];
  user_sort jsonb;
  user_filter jsonb;
  user_filter_ids text[] := array[]::text[];
  user_search text;
  user_search_folded text;
  effective_sort jsonb;
  effective_sort_is_user boolean := false;
  search_candidate_ids text[] := array[]::text[];
  search_field_ids text[] := array[]::text[];
  search_matches boolean;
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or p_requested_field_ids is null
    or pg_catalog.jsonb_typeof(p_requested_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_field_ids) not between 1 and 200
    or p_page_size is null or p_page_size not between 1 and 200
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in select item.value from pg_catalog.jsonb_array_elements(p_requested_field_ids) as item(value) loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(field_item #>> '{}') = any (requested_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    requested_ids := pg_catalog.array_append(requested_ids, pg_catalog.lower(field_item #>> '{}'));
  end loop;

  -- Declared system values: a closed set, each named at most once.
  if p_requested_system_field_keys is null then
    p_requested_system_field_keys := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_requested_system_field_keys) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_system_field_keys) > 5 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(p_requested_system_field_keys) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or (field_item #>> '{}') not in ('created_at', 'created_by', 'updated_at', 'updated_by', 'owner')
      or (field_item #>> '{}') = any (system_field_keys) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    system_field_keys := pg_catalog.array_append(system_field_keys, field_item #>> '{}');
  end loop;

  -- User-facing sort, filter and search: typed inputs the caller proved against
  -- the bound list component's declared sortable, filterable and searchable
  -- fields. Nothing here is authority; the published record-type field flags and
  -- the guaranteed-readable projection still decide every accepted field below,
  -- and a user input can only narrow the published query.
  if p_user_inputs is null then
    p_user_inputs := '{}'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_user_inputs) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_user_inputs) as supplied(key)
    where supplied.key not in (
      'sort', 'filter', 'search', 'sortableFieldIds', 'filterableFieldIds', 'searchableFieldIds'
    )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;

  -- The component-declared allow-lists, each an array of distinct field
  -- identities; a malformed or repeated identity refuses the request.
  for list_key in
    select pg_catalog.unnest(array['sortableFieldIds', 'filterableFieldIds', 'searchableFieldIds'])
  loop
    declared_list := coalesce(p_user_inputs -> list_key, '[]'::jsonb);
    if pg_catalog.jsonb_typeof(declared_list) <> 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if pg_catalog.jsonb_array_length(declared_list) > 200 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := array[]::text[];
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(declared_list) as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = any (parsed_ids) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(field_item #>> '{}'));
    end loop;
    declared_lists := declared_lists || pg_catalog.jsonb_build_object(list_key, pg_catalog.to_jsonb(parsed_ids));
  end loop;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_sortable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'sortableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_filterable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'filterableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_searchable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'searchableFieldIds') as item(value);

  -- The user's sort: the same pair shape as the published sort, bounded and each
  -- direction valid. It replaces the published order only when it is non-empty.
  user_sort := coalesce(p_user_inputs -> 'sort', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(user_sort) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(user_sort) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;

  -- The user's filter: the published typed condition tree, or null.
  user_filter := p_user_inputs -> 'filter';
  if user_filter = 'null'::jsonb then
    user_filter := null;
  end if;
  if user_filter is not null
    and pg_catalog.jsonb_typeof(user_filter) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;

  -- The user's search: one bounded, non-blank text term; a blank term is absent.
  if p_user_inputs ? 'search'
    and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') not in ('string', 'null') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search := pg_catalog.btrim(p_user_inputs ->> 'search');
  if user_search = '' then
    user_search := null;
  end if;
  if user_search is not null and pg_catalog.length(user_search) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search_folded := pg_catalog.lower(user_search);

  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(stored.created_at))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(stored.updated_at))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');

  -- The verified organisation and Application; never a caller value.
  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501', message = 'Query requires an application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;

  resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  if p_expected_release_revision is not null
    and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
  end if;
  query_item := resolved -> 'query';
  record_type_item := resolved -> 'recordType';
  record_type_id_value := (resolved ->> 'recordTypeId')::uuid;

  -- Grouped and totalled shapes are arrangements (#573); relationship hops have
  -- no declared path in this contract. Neither is run as plain rows.
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_page_size > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;

  -- The installed physical table for this exact record type.
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = (record_type_item ->> 'storageContractId')::uuid;
  if not found
    or catalogue_row.state <> 'active'
    or catalogue_row.module_root_id <> (resolved ->> 'recordTypeModuleRootId')::uuid
    or catalogue_row.record_type_id <> record_type_id_value
    or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
    or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
    or (catalogue_row.physical_schema_token = 'system_projection')
      is distinct from (record_type_item ? 'systemProjection')
    or (catalogue_row.physical_schema_token = 'system_projection'
      and catalogue_row.protected_read_model_key
        is distinct from (record_type_item #>> '{systemProjection,protectedView}')) then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the installed definition';
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;

  -- The read-scan plan. Its access routes narrow candidate rows before the
  -- budget is spent; its readable fields are the fields this reader is
  -- guaranteed to see on every row the scan examines, and none when the scan
  -- can examine a row the reader cannot read. Only those fields may drive the
  -- scan order, the pushed filter or the keyset cursor, because any other
  -- field could be withheld and its value must not influence which rows are
  -- examined. A failure yields no readable fields, so nothing is pushed.
  select plan.* into access_plan
  from vortex_record.plan_record_read_scan_internal(record_type_id_value) as plan;
  readable_field_ids := coalesce(access_plan.readable_field_ids, array[]::text[]);

  -- Search authority: the record type's own declared search priority. A component
  -- with only a search box declares no per-field list, so an empty declared set
  -- searches every field the record type marks searchable; a declared set narrows
  -- it. A row matches only through a field the reader can see on that row, so a
  -- hidden searchable value never decides a match.
  if pg_catalog.cardinality(declared_searchable_ids) > 0 then
    search_candidate_ids := declared_searchable_ids;
  else
    select coalesce(pg_catalog.array_agg(item.key), array[]::text[])
    into search_candidate_ids
    from pg_catalog.jsonb_object_keys(fields_by_id) as item(key);
  end if;
  foreach field_key in array search_candidate_ids loop
    if (fields_by_id ? field_key)
      and (fields_by_id -> field_key ->> 'searchPriority') in ('first', 'normal', 'last') then
      search_field_ids := pg_catalog.array_append(search_field_ids, field_key);
    end if;
  end loop;

  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (select 1 from pg_catalog.unnest(requested_ids) as requested(id) where requested.id <> all (selected_ids)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;

  -- Order: the published sort, or the user's chosen sort when one is supplied,
  -- over orderable typed columns, then the record id. A published sort field the
  -- reader is not guaranteed to see is validated but never pushed, so the scan
  -- order never depends on a value it may withhold. A user sort must instead be a
  -- field the component declares sortable, the record type declares sortable and
  -- the reader is guaranteed to see: silently ordering by something else would be
  -- wrong, so it is refused rather than pushed away.
  if pg_catalog.jsonb_array_length(user_sort) > 0 then
    effective_sort := user_sort;
    effective_sort_is_user := true;
  else
    effective_sort := query_item -> 'sort';
    effective_sort_is_user := false;
  end if;
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(effective_sort) as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (declared_sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if effective_sort_is_user
      and (not (field_key = any (declared_sortable_ids))
        or coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false) is not true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = catalogue_row.storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state <> 'active' then
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    declared_sort_ids := pg_catalog.array_append(declared_sort_ids, field_key);
    pushed := field_key = any (readable_field_ids);
    if effective_sort_is_user and not pushed then
      -- The user's order must actually be the scan order.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    -- A read-time field is worked out inside this statement, from the
    -- record's own stored values and one statement timestamp; it is never a
    -- stored column here.
    read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
      and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
        or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
    if read_time_field then
      read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
      read_time_sql := vortex_record.read_time_deadline_expression_internal(
        catalogue_row.storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
        read_time_clock
      );
      if read_time_sql is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
      end if;
      if not pushed then
        continue;
      end if;
      sort_ids := pg_catalog.array_append(sort_ids, field_key);
      sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
      sort_value_sql := pg_catalog.array_append(sort_value_sql, read_time_sql);
      sort_sql_types := pg_catalog.array_append(sort_sql_types, 'boolean');
      continue;
    end if;
    -- JSON-valued fields (money, links, choice sets, documents) have no total
    -- order here; money in particular is never ordered across currencies.
    if mapping_row.database_value_type not in (
      'integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if not pushed then
      continue;
    end if;
    sort_ids := pg_catalog.array_append(sort_ids, field_key);
    sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
    sort_value_sql := pg_catalog.array_append(
      sort_value_sql, pg_catalog.format('stored.%I', mapping_row.physical_column_token)
    );
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(declared_sort_ids) = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;

  -- Filter: the published condition tree over this record type's own fields, and,
  -- when supplied, the user's typed filter ANDed with it so it can only narrow.
  -- Every field the user's tree reads must be one the component declares
  -- filterable; the record type's own filterable flag is checked below for both.
  filter_condition := query_item -> 'filter';
  if filter_condition is not null and filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  if user_filter is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into user_filter_ids
    from pg_catalog.jsonb_path_query(
      user_filter, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    if exists (
      select 1 from pg_catalog.unnest(user_filter_ids) as referenced(id)
      where referenced.id <> pg_catalog.lower(referenced.id)
        or referenced.id <> all (declared_filterable_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end if;
    filter_condition := case
      when filter_condition is null then user_filter
      else pg_catalog.jsonb_build_object(
        'kind', 'all',
        'conditions', pg_catalog.jsonb_build_array(filter_condition, user_filter)
      )
    end;
  end if;
  if filter_condition is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into filter_ids
    from pg_catalog.jsonb_path_query(
      filter_condition, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    foreach field_key in array filter_ids loop
      -- Field values are keyed by lowercase identifier; so must the tree be.
      if field_key <> pg_catalog.lower(field_key) or not (fields_by_id ? field_key)
        or coalesce((fields_by_id -> field_key ->> 'filterable')::boolean, false) is not true then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      field_kind := fields_by_id -> field_key ->> 'type';
      if field_kind in ('calculation', 'total') then
        field_kind := fields_by_id -> field_key #>> '{settings,resultType}';
      end if;
      -- The exact (current Module contract) semantics of the saved-condition
      -- evaluator, so Query and database-backed conditions agree.
      semantic_type := case
        when field_kind = 'decimal_number' then 'decimal_number'
        when field_kind = 'money' then 'money'
        when field_kind = 'whole_number' then 'number'
        when field_kind = 'yes_no' then 'boolean'
        when field_kind = 'date' then 'date'
        when field_kind = 'date_time' then 'date_time'
        when field_kind = 'several_choices' then 'text_collection'
        when field_kind in ('table', 'attachment', 'formatted_text') then 'opaque_json'
        when field_kind in ('link', 'link_to_one_of_several') then 'record_reference'
        when field_kind = 'link_to_person' then 'organization_account_reference'
        when field_kind in (
          'text', 'long_text', 'choice', 'reference_number',
          'email_address', 'phone_number', 'web_address'
        ) then 'text'
        else null end;
      if semantic_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = catalogue_row.storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state <> 'active' then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      filter_field_columns := filter_field_columns || pg_catalog.jsonb_build_object(
        field_key, mapping_row.physical_column_token
      );
      filter_field_database_types := filter_field_database_types || pg_catalog.jsonb_build_object(
        field_key, mapping_row.database_value_type
      );
      filter_types := filter_types || pg_catalog.jsonb_build_object(field_key, semantic_type);
      filter_nulls := filter_nulls || pg_catalog.jsonb_build_object(field_key, null::jsonb);
      read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
        and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
          or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
      if read_time_field then
        read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
        read_time_sql := vortex_record.read_time_deadline_expression_internal(
          catalogue_row.storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
          read_time_clock
        );
        if read_time_sql is null then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
        end if;
        filter_read_time_expressions := filter_read_time_expressions || pg_catalog.jsonb_build_object(
          field_key, read_time_sql
        );
        filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
          '%L, %s', field_key, pg_catalog.format('pg_catalog.to_jsonb(%s)', read_time_sql)
        ));
        continue;
      end if;
      -- The same canonical value text the record reader projects; references
      -- are compared by their identifier, as the condition engine defines.
      filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
        '%L, %s', field_key,
        case
          when semantic_type = 'record_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''recordId''))',
              mapping_row.physical_column_token)
          when semantic_type = 'organization_account_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''organizationAccountId''))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'decimal' then
            pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'timestamp_with_time_zone' then
            pg_catalog.format(
              'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(stored.%I))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'date' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              mapping_row.physical_column_token)
          else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
        end
      ));
    end loop;
  end if;

  -- Inputs: exactly the declared keys, required ones present, references
  -- reduced to their identifier. Types are checked by the condition bridge.
  for input_key in select supplied.key from pg_catalog.jsonb_object_keys(p_input_values) as supplied(key) loop
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
      where item.value ->> 'key' = input_key
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
  end loop;
  for input_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
  loop
    input_key := input_item ->> 'key';
    input_value := coalesce(p_input_values -> input_key, 'null'::jsonb);
    if input_value = 'null'::jsonb and (input_item ->> 'required')::boolean then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
    if input_value <> 'null'::jsonb and input_item ->> 'type' = 'record_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'recordId') ~ uuid_pattern, false)
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements(input_item -> 'recordTypes') as allowed(value)
          where allowed.value ->> 'state' = 'resolved'
            and pg_catalog.lower(allowed.value ->> 'recordTypeId')
              = pg_catalog.lower(input_value ->> 'recordTypeId')
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'recordId'));
    elsif input_value <> 'null'::jsonb and input_item ->> 'type' = 'organization_account_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['organizationAccountId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'organizationAccountId') ~ uuid_pattern, false) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'organizationAccountId'));
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(input_key, case input_item ->> 'type'
      when 'formatted_text' then 'opaque_json'
      else input_item ->> 'type' end);
    parameter_values := parameter_values || pg_catalog.jsonb_build_object(input_key, input_value);
  end loop;
  begin
    perform vortex_access.evaluate_query_condition_internal(
      trivial_condition, '{}'::jsonb, '{}'::jsonb, parameter_types, parameter_values, true
    );
  exception when invalid_parameter_value then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
  end;
  if filter_condition is not null then
    begin
      perform vortex_access.evaluate_query_condition_internal(
        filter_condition, filter_types, filter_nulls, parameter_types, parameter_values, true
      );
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;

  -- The published filter is pushed into the candidate scan only when every
  -- field it reads is one the reader is guaranteed to see; otherwise it is
  -- evaluated per row, so which rows the budget examines can never depend on a
  -- value the reader cannot see.
  filter_predicate := 'true';
  if filter_condition is not null
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
      where referenced.id <> all (readable_field_ids)
    ) then
    begin
      filter_plan := vortex_record.compile_query_filter_internal(
        filter_condition,
        filter_types,
        filter_field_columns,
        filter_field_database_types,
        fields_by_id,
        filter_read_time_expressions,
        parameter_types,
        parameter_values,
        9,
        0
      );
      filter_predicate := coalesce(filter_plan ->> 'predicate', 'true');
      filter_parameters := coalesce(filter_plan -> 'parameters', '[]'::jsonb);
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;

  -- The keyset position, which must fit this exact order. The cursor carries
  -- only the readable sort fields' values and a record identity, so it never
  -- carries a hidden field value.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'recordId']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or pg_catalog.lower(p_after ->> 'recordId') !~ uuid_pattern
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') as item(value)
        where pg_catalog.jsonb_typeof(item.value) not in ('string', 'null')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality)
    into after_sort_key
    from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') with ordinality as item(value, ordinality);
    after_record_id := (p_after ->> 'recordId')::uuid;
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;

  -- The scan. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending. The
  -- order always ends with the record id, so the keyset stays total even when
  -- no readable sort field may be pushed.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then sort_value_sql[sort_index] || ' collate "C"'
      else sort_value_sql[sort_index] end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when sort_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'vortex_context.format_timestamp_utc(%s)',
        sort_value_sql[sort_index])
      when 'date' then pg_catalog.format(
        'pg_catalog.to_char(%s, ''YYYY-MM-DD'')', sort_value_sql[sort_index])
      else pg_catalog.format('(%s)::text', sort_value_sql[sort_index]) end);

    if after_record_id is not null then
      value_sql := case when sort_sql_types[sort_index] = 'text'
        then pg_catalog.format('$3[%s] collate "C"', sort_index)
        else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
      if after_sort_key[sort_index] is null then
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when sort_directions[sort_index] = 'ascending'
            then pg_catalog.format('(%s) is not null', sort_value_sql[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('(%s) is null and ', sort_value_sql[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when sort_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('((%s) is null or coalesce(%s < %s, false))',
            sort_value_sql[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false) and ', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix || 'stored.record_id > $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;
  order_by_sql := pg_catalog.array_to_string(order_terms, ', ');
  if order_by_sql = '' then
    order_by_sql := 'stored.record_id asc';
  else
    order_by_sql := order_by_sql || ', stored.record_id asc';
  end if;

  -- The scan narrowing the plan prepared: one predicate that OR-s every
  -- eligible alternative's exact route test with its saved condition, already
  -- compiled over the record catalogue's own columns and bound to the
  -- parameters the scan passes. It only removes rows the exact per-row decision
  -- below would refuse; every row the scan returns still goes through
  -- read_record, so it cannot widen a result.
  access_sql := coalesce(access_plan.access_predicate, 'true');

  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values
     from record_data.%I as stored
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and %s
       and (%s)
       and (%s)%s
     order by %s
     limit $5',
    pg_catalog.array_to_string(sort_key_terms, ', '),
    (select pg_catalog.string_agg(
       filter_chunk.pairs_text,
       ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index
     )
     from (
       select (filter_pair.pair_number - 1) / 50 as chunk_index,
         pg_catalog.string_agg(
           filter_pair.pair_text, ', ' order by filter_pair.pair_number
         ) as pairs_text
       from pg_catalog.unnest(filter_expressions)
         with ordinality as filter_pair(pair_text, pair_number)
       group by (filter_pair.pair_number - 1) / 50
     ) as filter_chunk),
    system_columns_sql,
    catalogue_row.physical_table_token,
    case when catalogue_row.storage_scope = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    access_sql,
    filter_predicate,
    keyset_sql,
    order_by_sql
  );

  for scan_record in execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_plan.owner_account_id,
      access_plan.owner_group_ids, access_plan.shared_record_ids,
      filter_parameters, access_plan.access_parameters
  loop
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;

    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered and sorted field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    if filter_condition is null then
      passes := true;
    else
      begin
        passes := vortex_access.evaluate_query_condition_internal(
          filter_condition, filter_types, scan_record.filter_values,
          parameter_types, parameter_values, false
        );
      exception when invalid_parameter_value then
        passes := true;
        needs_refusal_check := true;
      end;
    end if;

    if passes then
      projection := vortex_record.read_record(record_type_id_value, scan_record.record_id);
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if not exists (
          select 1 from pg_catalog.unnest(declared_sort_ids || filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if user_search is not null then
            search_matches := false;
            foreach field_key in array search_field_ids loop
              if readable_values ? field_key and (
                (pg_catalog.jsonb_typeof(readable_values -> field_key) in ('string', 'number')
                  and pg_catalog.strpos(
                    pg_catalog.lower(readable_values ->> field_key), user_search_folded
                  ) > 0)
                or (pg_catalog.jsonb_typeof(readable_values -> field_key) = 'array'
                  and exists (
                    select 1
                    from pg_catalog.jsonb_array_elements(readable_values -> field_key) as member(value)
                    where pg_catalog.jsonb_typeof(member.value) = 'string'
                      and pg_catalog.strpos(
                        pg_catalog.lower(member.value #>> '{}'), user_search_folded
                      ) > 0
                  ))
              ) then
                search_matches := true;
                exit;
              end if;
            end loop;
            if not search_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if row_count = p_page_size then
            more_rows := true;
            exit;
          end if;
          -- Every returned row carries the record's concurrency number from
          -- read_record and its per-row capabilities, each action decided exactly
          -- as its own writer decides it and only for a row read_record admits.
          -- The capabilities are computed only for a returned row; a row whose
          -- capabilities cannot be computed is withheld rather than exposed
          -- without them.
          row_capabilities := vortex_record.read_record_capabilities(
            record_type_id_value, scan_record.record_id
          );
          if row_capabilities is not null then
            rows_value := rows_value || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id,
              'revision', projection -> 'concurrencyNumber',
              'capabilities', row_capabilities,
              'values', coalesce((
                select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
                from pg_catalog.unnest(requested_ids) as requested(id)
                where readable_values ? requested.id
              ), '{}'::jsonb)
            ));
            row_count := row_count + 1;
            if pg_catalog.cardinality(system_field_keys) > 0 then
              rows_value := pg_catalog.jsonb_set(
                rows_value, array[(row_count - 1)::text, 'systemValues'], scan_record.system_values
              );
            end if;
            last_returned_sort_key := scan_record.sort_key;
            last_returned_record_id := scan_record.record_id;
          end if;
        end if;
      end if;
    end if;

    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;

  if more_rows then
    next_value := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(last_returned_sort_key),
      'recordId', last_returned_record_id
    );
  elsif budget_exhausted then
    next_value := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(last_examined_sort_key),
      'recordId', last_examined_record_id
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'rows', rows_value,
    'next', next_value
  );
end
$function$;


revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb)
  to vortex_request;

comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, each carrying the record''s concurrency number and the per-row capabilities from read_record_capabilities, each action decided exactly as its own writer decides it, with only the declared Record system values, or one refusal before any row is exposed; accepts a bound list component''s declared sortable, filterable and searchable field sets together with the viewer''s chosen sort, typed filter and search term, refuses a sort or filter outside the declared sets, keeps a user sort only over a field the record type declares sortable and the reader is guaranteed to see, ANDs the user filter with the published filter so it can only narrow, and matches a search only through searchable fields the returned row exposes to the reader; requires every filtered field to be declared filterable; pushes a filter or a sort into the candidate scan only for fields the reader is guaranteed to see for the whole record type, evaluates a filter on a possibly-withheld field per row, and keeps the keyset cursor over readable sort values and a record identity so no cursor carries a hidden field value and the scan order and budget never depend on one; narrows the scan with one predicate that OR-s every eligible alternative''s exact owner, owner-group and direct-share route test with its saved condition compiled over the record''s own catalogue columns where that condition can be expressed as a superset of the per-row decision, leaves the scan unrestricted where a route or condition has no exact stored form, and still decides every returned row through read_record; works out read-time fields, such as a deadline-passed calculation, inside the query at one statement timestamp in the organisation time zone, so no query is refused for freshness.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

create or replace function vortex_event.recover_consumer_occurrence_claim(
  p_consumer_key text,
  p_occurrence_id uuid,
  p_expected_failure_count integer,
  p_system_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  recovery_time timestamptz := pg_catalog.statement_timestamp();
  grant_state text;
  progress_row vortex_event.consumer_occurrence_progress%rowtype;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_expected_failure_count is null or p_expected_failure_count < 0
    or p_system_actor_id is null or p_system_actor_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Event delivery recovery input is invalid';
  end if;

  grant_state := vortex_access.resolve_system_actor_grant_internal(
    p_system_actor_id, 'recover_consumer_occurrence_claim', null, null, p_consumer_key
  );
  if grant_state is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unauthorised', 'reason', 'authority_not_configured'
    );
  end if;
  if grant_state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unauthorised', 'reason', 'authority_revoked'
    );
  end if;

  select progress.* into progress_row
  from vortex_event.consumer_occurrence_progress as progress
  where progress.consumer_key = p_consumer_key
    and progress.occurrence_id = p_occurrence_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'claim_unavailable');
  end if;
  if progress_row.acknowledged_at is not null then
    return pg_catalog.jsonb_build_object('outcome', 'already_acknowledged');
  end if;
  if progress_row.terminally_failed_at is null then
    if progress_row.lease_expires_at > recovery_time then
      return pg_catalog.jsonb_build_object('outcome', 'active');
    end if;
    -- Lapsed but never exhausted: ordinary reclaim already covers it, so the
    -- privileged override is not the right path for this claim.
    return pg_catalog.jsonb_build_object('outcome', 'not_exhausted');
  end if;
  if progress_row.failure_count <> p_expected_failure_count then
    return pg_catalog.jsonb_build_object(
      'outcome', 'stale',
      'failureCount', progress_row.failure_count
    );
  end if;

  -- Clearing the terminal hold and both budgets hands the claim back to
  -- #639's ordinary reclaim for exactly this consumer and occurrence. Failure
  -- evidence and the recovery attribution stay on the row.
  update vortex_event.consumer_occurrence_progress
  set terminally_failed_at = null,
      failure_count = 0,
      attempt_count = 0,
      recovered_at = recovery_time,
      recovered_by = p_system_actor_id,
      recovery_count = recovery_count + 1,
      lease_expires_at = recovery_time
  where consumer_key = p_consumer_key and occurrence_id = p_occurrence_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'recovered',
    'recoveredBy', p_system_actor_id,
    'leaseExpiresAt', vortex_context.format_timestamp_utc(recovery_time)
  );
end
$function$;

revoke all on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer, uuid)
  to vortex_runtime;

comment on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer, uuid) is
  'Recovery of one exhausted claim for the same consumer and occurrence identity, authorised by the system actor grant scoped to that consumer and attributed to the granted system actor.';

create or replace function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_occurrences jsonb,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  maximum_safe_revision constant bigint := 9007199254740991;
  context_value jsonb;
  installation jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  context_actor_id uuid;
  context_correlation_id uuid;
  application_release_revision bigint;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  binding_value jsonb;
  binding_count integer;
  binding_module_root_id uuid;
  binding_module_release_revision bigint;
  binding_revision bigint;
  module_release vortex_definition.releases%rowtype;
  application_release vortex_definition.releases%rowtype;
  module_content jsonb;
  application_content jsonb;
  record_type jsonb;
  record_type_count integer;
  locked_definition_revision bigint;
  locked_record_count integer;
  sequence_application_scope_id uuid;
  next_sequence bigint;
  occurrence_time timestamptz := pg_catalog.statement_timestamp();
  occurrence_time_text text;
  occurrence_item jsonb;
  occurrence_id uuid;
  descriptor jsonb;
  payload jsonb;
  event_kind text;
  owner_kind text;
  owner_root_id uuid;
  declared_event jsonb;
  declared_event_count integer;
  definition_release jsonb;
  field_item jsonb;
  field_id_text text;
  previous_field_id_text text;
  field_definition jsonb;
  queued_message_id bigint;
  envelope jsonb;
  envelopes jsonb := '[]'::jsonb;
begin
  if p_storage_contract_id is null or p_storage_contract_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or pg_catalog.jsonb_typeof(p_occurrences) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Event append input is invalid';
  end if;

  if pg_catalog.jsonb_array_length(p_occurrences) = 0 then
    return envelopes;
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
    where pg_catalog.jsonb_typeof(candidate.value) is distinct from 'object'
      or not candidate.value ?& array['occurrenceId', 'descriptor', 'payload']
      or candidate.value - array['occurrenceId', 'descriptor', 'payload'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(candidate.value -> 'occurrenceId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate.value -> 'descriptor') is distinct from 'object'
      or pg_catalog.jsonb_typeof(candidate.value -> 'payload') is distinct from 'object'
  ) then
    raise exception using errcode = '22023', message = 'Event occurrence batch is invalid';
  end if;

  begin
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
      where (candidate.value ->> 'occurrenceId')::uuid = nil_uuid
    ) or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements(p_occurrences)
    ) <> (
      select pg_catalog.count(distinct (candidate.value ->> 'occurrenceId')::uuid)
      from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
    ) then
      raise exception using errcode = '22023', message = 'Event occurrence identities are invalid';
    end if;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Event occurrence identities are invalid';
  end;

  context_value := vortex_access.validated_human_request_context();
  if context_value ->> 'callerKind' is distinct from 'human'
    or not context_value ?& array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ] then
    raise exception using errcode = '42501', message = 'Human Application context is required';
  end if;
  context_actor_id := (context_value ->> 'organizationAccountId')::uuid;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if not found
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'record_data' then
    raise exception using errcode = 'P0002', message = 'Event record is unavailable';
  end if;

  -- Coordinate with the approved installation lifecycle writer before trusting
  -- the exact Module binding. The actual generated row is locked below and is
  -- the ordering lock shared by every consuming Application.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'vortex_module.binding:' || context_organization_id::text || ':' ||
        context_application_root_id::text || ':' || catalogue_row.module_root_id::text,
      0
    )
  );
  -- Installation evidence is resolved here, inside the protected region, and
  -- never before it.  A lifecycle detach that commits while this append waits
  -- for the canonical binding lock above is only observed by a read taken
  -- after that wait: this assignment is its own statement, so in read
  -- committed it sees the committed lifecycle state.  `p_installation` carries
  -- an exact pin-set only from a trusted reader that already resolved it while
  -- holding the same canonical lifecycle lock.
  if p_installation is null then
    installation := vortex_module.read_current_active_installation();
  else
    installation := p_installation;
  end if;
  if installation is null
    or pg_catalog.jsonb_typeof(installation) <> 'object'
    or not installation ?& array[
      'organizationId', 'applicationRootId', 'applicationReleaseRevision',
      'moduleBindings'
    ]
    or (installation ->> 'organizationId')::uuid is distinct from context_organization_id
    or (installation ->> 'applicationRootId')::uuid is distinct from context_application_root_id
    or pg_catalog.jsonb_typeof(installation -> 'moduleBindings') <> 'array' then
    raise exception using errcode = '42501', message = 'Resolved Event installation is unavailable';
  end if;
  application_release_revision :=
    (installation ->> 'applicationReleaseRevision')::bigint;
  -- Module's existing reader has already proved the complete binding set
  -- against the published dependency closure. Read the one exact binding from
  -- that result while its canonical lifecycle lock is held; do not add a
  -- second binding reader or broader cross-owner table grants.
  select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
  into binding_count, binding_value
  from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  where (item.value ->> 'moduleRootId')::uuid = catalogue_row.module_root_id;
  if binding_count <> 1 then
    raise exception using errcode = '55000', message = 'Installed Event binding is unavailable';
  end if;
  binding_module_root_id := (binding_value ->> 'moduleRootId')::uuid;
  binding_module_release_revision :=
    (binding_value ->> 'moduleReleaseRevision')::bigint;
  binding_revision := (binding_value ->> 'bindingRevision')::bigint;

  select release.* into module_release
  from vortex_definition.releases as release
  where release.root_id = binding_module_root_id
    and release.release_revision = binding_module_release_revision;
  if not found
    or not exists (
      select 1 from vortex_record.release_provisions as provision
      where provision.module_root_id = module_release.root_id
        and provision.release_revision = module_release.release_revision
        and p_storage_contract_id = any (provision.storage_contract_ids)
    ) then
    raise exception using errcode = '55000', message = 'Installed Event storage is unavailable';
  end if;
  module_content := module_release.compilation_output #> '{canonical,content}';

  select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
  into record_type_count, record_type
  from pg_catalog.jsonb_array_elements(module_content -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = catalogue_row.record_type_id;
  if record_type_count <> 1
    or (record_type ->> 'storageContractId')::uuid is distinct from p_storage_contract_id
    or record_type ->> 'storageScope' is distinct from catalogue_row.storage_scope then
    raise exception using errcode = '55000', message = 'Installed Event record type is unavailable';
  end if;

  select release.* into application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = context_application_root_id
    and release.release_revision = application_release_revision
    and root.organization_id = context_organization_id
    and root.kind = 'application';
  if not found then
    raise exception using errcode = '55000', message = 'Installed Application release is unavailable';
  end if;
  application_content := application_release.compilation_output #> '{canonical,content}';

  if catalogue_row.storage_scope = 'organization_shared' then
    sequence_application_scope_id := null;
    locked_definition_revision := null;
    execute pg_catalog.format(
      'select stored.definition_revision
       from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.application_root_id is null
       for update',
      catalogue_row.physical_table_token
    ) into locked_definition_revision
    using context_organization_id, p_record_id;
    get diagnostics locked_record_count = row_count;
  else
    sequence_application_scope_id := context_application_root_id;
    locked_definition_revision := null;
    execute pg_catalog.format(
      'select stored.definition_revision
       from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.application_root_id = $3
       for update',
      catalogue_row.physical_table_token
    ) into locked_definition_revision
    using context_organization_id, p_record_id, context_application_root_id;
    get diagnostics locked_record_count = row_count;
  end if;
  if locked_record_count <> 1 or locked_definition_revision is null
    or locked_definition_revision < catalogue_row.first_compatible_release_revision
    or (catalogue_row.last_compatible_release_revision is not null
      and locked_definition_revision > catalogue_row.last_compatible_release_revision) then
    raise exception using errcode = 'P0002', message = 'Event record is unavailable';
  end if;

  select coalesce(pg_catalog.max(stored.record_sequence), 0) + 1
  into next_sequence
  from vortex_event.event_outbox as stored
  where stored.organization_id = context_organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.sequence_application_root_id is not distinct from
      sequence_application_scope_id
    and stored.record_id = p_record_id;
  if next_sequence + pg_catalog.jsonb_array_length(p_occurrences) - 1 >
      maximum_safe_revision then
    raise exception using errcode = '22003', message = 'Event record sequence is exhausted';
  end if;

  occurrence_time_text := vortex_context.format_timestamp_utc(occurrence_time);

  for occurrence_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_occurrences) with ordinality as item(value, ordinal)
    order by item.ordinal
  loop
    occurrence_id := (occurrence_item ->> 'occurrenceId')::uuid;
    descriptor := occurrence_item -> 'descriptor';
    payload := occurrence_item -> 'payload';

    if descriptor ->> 'kind' = 'standard' then
      if not descriptor ?& array['kind', 'eventKind', 'recordTypeId']
        or descriptor - array['kind', 'eventKind', 'recordTypeId'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(descriptor -> 'eventKind') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'recordTypeId') is distinct from 'string'
        or (descriptor ->> 'recordTypeId')::uuid is distinct from catalogue_row.record_type_id
        or descriptor ->> 'eventKind' is null
        or descriptor ->> 'eventKind' not in (
          'created', 'changed', 'deleted', 'linked', 'unlinked', 'reassigned',
          'state_changed'
        ) then
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;
      event_kind := descriptor ->> 'eventKind';

      if event_kind = 'changed' then
        if not payload ?& array['kind', 'changedFieldIds']
          or payload - array['kind', 'changedFieldIds'] <> '{}'::jsonb
          or payload ->> 'kind' is distinct from event_kind
          or pg_catalog.jsonb_typeof(payload -> 'changedFieldIds') is distinct from 'array'
          or pg_catalog.jsonb_array_length(payload -> 'changedFieldIds') = 0 then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
        previous_field_id_text := null;
        for field_item in
          select item.value
          from pg_catalog.jsonb_array_elements(payload -> 'changedFieldIds')
            with ordinality as item(value, ordinal)
          order by item.ordinal
        loop
          if pg_catalog.jsonb_typeof(field_item) is distinct from 'string' then
            raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
          end if;
          field_id_text := pg_catalog.lower(field_item #>> '{}');
          if previous_field_id_text is not null
              and previous_field_id_text >= field_id_text
            or not exists (
              select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
              where pg_catalog.lower(field.value ->> 'fieldId') = field_id_text
            ) then
            raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
          end if;
          previous_field_id_text := field_id_text;
        end loop;
      elsif event_kind = 'state_changed' then
        if not payload ?& array['kind', 'fieldId']
          or payload - array['kind', 'fieldId', 'previousValue', 'newValue'] <> '{}'::jsonb
          or payload ->> 'kind' is distinct from event_kind
          or pg_catalog.jsonb_typeof(payload -> 'fieldId') is distinct from 'string' then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
        select field.value into field_definition
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
        where (field.value ->> 'fieldId')::uuid = (payload ->> 'fieldId')::uuid;
        if not found
          or (field_definition ->> 'personalData' = 'none'
            and not (payload ? 'previousValue' or payload ? 'newValue'))
          or (field_definition ->> 'personalData' <> 'none'
            and (payload ? 'previousValue' or payload ? 'newValue')) then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
      elsif payload <> pg_catalog.jsonb_build_object('kind', event_kind) then
        raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
      end if;

      definition_release := pg_catalog.jsonb_build_object(
        'kind', 'module',
        'rootId', module_release.root_id,
        'releaseRevision', module_release.release_revision,
        'releaseVersion', module_release.release_version,
        'contentFingerprint', module_release.content_fingerprint,
        'resolutionFingerprint', module_release.resolution_fingerprint
      );
    elsif descriptor ->> 'kind' = 'declared' then
      if not descriptor ?& array[
          'kind', 'owner', 'declarationId', 'key', 'recordTypeId', 'carriedFieldIds'
        ]
        or descriptor - array[
          'kind', 'owner', 'declarationId', 'key', 'recordTypeId', 'carriedFieldIds'
        ] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(descriptor -> 'owner') is distinct from 'object'
        or pg_catalog.jsonb_typeof(descriptor -> 'declarationId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'key') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'recordTypeId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'carriedFieldIds') is distinct from 'array'
        or (descriptor ->> 'recordTypeId')::uuid is distinct from catalogue_row.record_type_id then
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;

      owner_kind := descriptor #>> '{owner,kind}';
      if owner_kind = 'application'
        and (descriptor -> 'owner') - array['kind', 'applicationRootId'] = '{}'::jsonb
        and (descriptor -> 'owner') ?& array['kind', 'applicationRootId']
        and pg_catalog.jsonb_typeof(
          descriptor #> '{owner,applicationRootId}'
        ) is not distinct from 'string' then
        owner_root_id := (descriptor #>> '{owner,applicationRootId}')::uuid;
        if owner_root_id <> context_application_root_id then
          raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
        end if;
        select pg_catalog.count(*), pg_catalog.jsonb_agg(event.value) -> 0
        into declared_event_count, declared_event
        from pg_catalog.jsonb_array_elements(application_content -> 'events') as event(value)
        where (event.value ->> 'eventId')::uuid = (descriptor ->> 'declarationId')::uuid
          and event.value ->> 'key' = descriptor ->> 'key';
        definition_release := pg_catalog.jsonb_build_object(
          'kind', 'application',
          'rootId', application_release.root_id,
          'releaseRevision', application_release.release_revision,
          'releaseVersion', application_release.release_version,
          'contentFingerprint', application_release.content_fingerprint,
          'resolutionFingerprint', application_release.resolution_fingerprint
        );
      elsif owner_kind = 'module'
        and (descriptor -> 'owner') - array['kind', 'moduleRootId'] = '{}'::jsonb
        and (descriptor -> 'owner') ?& array['kind', 'moduleRootId']
        and pg_catalog.jsonb_typeof(
          descriptor #> '{owner,moduleRootId}'
        ) is not distinct from 'string' then
        owner_root_id := (descriptor #>> '{owner,moduleRootId}')::uuid;
        if owner_root_id <> module_release.root_id then
          raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
        end if;
        select pg_catalog.count(*), pg_catalog.jsonb_agg(event.value) -> 0
        into declared_event_count, declared_event
        from pg_catalog.jsonb_array_elements(module_content -> 'events') as event(value)
        where (event.value ->> 'eventId')::uuid = (descriptor ->> 'declarationId')::uuid
          and event.value ->> 'key' = descriptor ->> 'key';
        definition_release := pg_catalog.jsonb_build_object(
          'kind', 'module',
          'rootId', module_release.root_id,
          'releaseRevision', module_release.release_revision,
          'releaseVersion', module_release.release_version,
          'contentFingerprint', module_release.content_fingerprint,
          'resolutionFingerprint', module_release.resolution_fingerprint
        );
      else
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;

      if declared_event_count <> 1
        or (declared_event ->> 'recordTypeId')::uuid <> catalogue_row.record_type_id
        or declared_event -> 'carriedFieldIds' is distinct from
          descriptor -> 'carriedFieldIds'
        or declared_event -> 'personalOrSensitiveValuesAllowed' is distinct from
          'false'::jsonb
        or not payload ?& array['kind', 'carriedValues']
        or payload - array['kind', 'carriedValues'] <> '{}'::jsonb
        or payload ->> 'kind' is distinct from 'declared'
        or pg_catalog.jsonb_typeof(payload -> 'carriedValues') is distinct from 'object' then
        raise exception using errcode = '22023', message = 'Installed Event declaration is invalid';
      end if;

      if exists (
        select 1
        from pg_catalog.jsonb_each(payload -> 'carriedValues') as carried(field_id, value)
        where not (descriptor -> 'carriedFieldIds') ? carried.field_id
          or not exists (
            select 1
            from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
            where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(carried.field_id)
              and field.value ->> 'personalData' = 'none'
          )
      ) then
        raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
      end if;
    else
      raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
    end if;

    envelope := pg_catalog.jsonb_build_object(
      'contractVersion', '2.0.0',
      'occurrenceId', occurrence_id,
      'organizationId', context_organization_id,
      'installation', pg_catalog.jsonb_build_object(
        'applicationRootId', context_application_root_id,
        'applicationReleaseRevision', application_release_revision,
        'moduleBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', binding_module_root_id,
          'moduleReleaseRevision', binding_module_release_revision,
          'bindingRevision', binding_revision
        )
      ),
      'descriptor', descriptor,
      'definitionRelease', definition_release,
      'recordId', p_record_id,
      'occurredAt', occurrence_time_text,
      'actorId', context_actor_id,
      'correlationId', context_correlation_id,
      'recordSequence', next_sequence,
      'payload', payload
    );

    insert into vortex_event.event_outbox (
      occurrence_id, organization_id, storage_contract_id, storage_scope,
      sequence_application_root_id, record_id, record_sequence, occurred_at,
      envelope
    ) values (
      occurrence_id, context_organization_id, p_storage_contract_id,
      catalogue_row.storage_scope, sequence_application_scope_id, p_record_id,
      next_sequence, occurrence_time, envelope
    );

    select sent.msg_id into strict queued_message_id
    from pgmq.send(
      'vortex_event_occurrences',
      pg_catalog.jsonb_build_object(
        'contractVersion', '2.0.0', 'occurrenceId', occurrence_id
      )
    ) as sent(msg_id);
    if queued_message_id is null then
      raise exception using errcode = '55000', message = 'Event queue append failed';
    end if;

    envelopes := envelopes || pg_catalog.jsonb_build_array(envelope);
    next_sequence := next_sequence + 1;
  end loop;

  return envelopes;
end
$function$;

revoke all on function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
comment on function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
) is
  'Appends an exact validated record occurrence batch; resolves the active installation under the canonical binding lock unless a trusted reader supplies an exact pin-set it resolved under that same lock.';

create or replace function vortex_access.evaluate_organization_record_access_internal(
  p_declaration jsonb,
  p_target_record_id uuid,
  p_facts jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  declaration_binding jsonb := p_declaration -> 'recordBinding';
  facts_binding jsonb;
  record_type_item jsonb;
  field_item jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  record_item jsonb;
  record_scope_item jsonb;
  edge_item jsonb;
  scope_key_count integer;
  seen_type_ids text[] := array[]::text[];
  seen_field_ids text[];
  seen_relationship_ids text[] := array[]::text[];
  seen_condition_ids text[] := array[]::text[];
  seen_record_ids text[] := array[]::text[];
  ctx jsonb;
  checked_at timestamptz;
  auth_deadline timestamptz;
  eligibility jsonb;
  decision_evidence jsonb;
  target_application_root_id uuid;
  target_record_row jsonb;
  target_ok boolean;
  matched jsonb;
  decision_valid_until text;
begin
  -- Facts shape: a closed object with exactly the declared top-level keys.
  if p_facts is null or pg_catalog.jsonb_typeof(p_facts) <> 'object'
    or not (p_facts ?& array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_facts) as supplied(key)
      where supplied.key <> all (array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    )
    or pg_catalog.jsonb_typeof(p_facts -> 'binding') <> 'object'
    or pg_catalog.jsonb_typeof(p_facts -> 'recordTypes') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'relationships') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'sharingConditions') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'records') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'edges') <> 'array' then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  facts_binding := p_facts -> 'binding';
  if not (facts_binding ?& array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(facts_binding) as supplied(key)
      where supplied.key <> all (array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    )
    or not vortex_context.is_non_nil_uuid(facts_binding ->> 'moduleRootId')
    or not vortex_context.is_non_nil_uuid(facts_binding ->> 'recordTypeId')
    or not vortex_context.is_non_nil_uuid(facts_binding ->> 'storageContractId')
    or facts_binding ->> 'storageScope' not in ('organization_shared', 'application_contained') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  if pg_catalog.lower(facts_binding ->> 'moduleRootId') <> pg_catalog.lower(declaration_binding ->> 'moduleRootId')
    or pg_catalog.lower(facts_binding ->> 'recordTypeId') <> pg_catalog.lower(declaration_binding ->> 'recordTypeId')
    or pg_catalog.lower(facts_binding ->> 'storageContractId') <> pg_catalog.lower(declaration_binding ->> 'storageContractId')
    or (facts_binding ->> 'storageScope') <> (declaration_binding ->> 'storageScope') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Record types: unique identity, well-formed ownership/field shape.
  for record_type_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_type_item) <> 'object'
      or not (record_type_item ?& array[
        'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope', 'ownershipMode', 'fields'
      ])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(record_type_item) as supplied(key)
        where supplied.key <> all (array[
          'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope',
          'ownershipMode', 'ownershipRelationshipId', 'validationContractVersion', 'fields'
        ])
      )
      or not vortex_context.is_non_nil_uuid(record_type_item ->> 'moduleRootId')
      or not vortex_context.is_non_nil_uuid(record_type_item ->> 'recordTypeId')
      or not vortex_context.is_non_nil_uuid(record_type_item ->> 'storageContractId')
      or record_type_item ->> 'storageScope' not in ('organization_shared', 'application_contained')
      or record_type_item ->> 'ownershipMode' not in ('none', 'organization_account', 'group', 'inherited')
      or ((record_type_item ? 'ownershipRelationshipId') <> (record_type_item ->> 'ownershipMode' = 'inherited'))
      or (record_type_item ? 'ownershipRelationshipId'
        and not vortex_context.is_non_nil_uuid(record_type_item ->> 'ownershipRelationshipId'))
      or (record_type_item ? 'validationContractVersion' and (
        pg_catalog.jsonb_typeof(record_type_item -> 'validationContractVersion') <> 'string'
        or record_type_item ->> 'validationContractVersion' <> all (vortex_definition.accepted_contract_version('record_type'))
      ))
      or pg_catalog.jsonb_typeof(record_type_item -> 'fields') <> 'array' then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(record_type_item ->> 'recordTypeId') = any (seen_type_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_type_ids := pg_catalog.array_append(seen_type_ids, pg_catalog.lower(record_type_item ->> 'recordTypeId'));

    seen_field_ids := array[]::text[];
    for field_item in
      select value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'object'
        or not (field_item ?& array['fieldId', 'type'])
        or exists (
          select 1 from pg_catalog.jsonb_object_keys(field_item) as supplied(key)
          where supplied.key <> all (array['fieldId', 'type', 'settings'])
        )
        or not vortex_context.is_non_nil_uuid(field_item ->> 'fieldId')
        or pg_catalog.jsonb_typeof(field_item -> 'type') <> 'string'
        or (field_item ? 'settings' and pg_catalog.jsonb_typeof(field_item -> 'settings') <> 'object') then
        raise exception using errcode = '22023', message = 'Record access facts are invalid';
      end if;
      if pg_catalog.lower(field_item ->> 'fieldId') = any (seen_field_ids) then
        raise exception using errcode = '22023', message = 'Record access facts are invalid';
      end if;
      seen_field_ids := pg_catalog.array_append(seen_field_ids, pg_catalog.lower(field_item ->> 'fieldId'));
    end loop;
  end loop;

  if not (pg_catalog.lower(facts_binding ->> 'recordTypeId') = any (seen_type_ids)) then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Relationships: unique identity, well-formed endpoints. `toRecordTypes`
  -- is every declared target: one for a link, several for a link to one of
  -- several record types.
  for relationship_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
  loop
    if pg_catalog.jsonb_typeof(relationship_item) <> 'object'
      or not (relationship_item ?& array[
        'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
      ])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(relationship_item) as supplied(key)
        where supplied.key <> all (array[
          'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
        ])
      )
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'relationshipId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'fromModuleRootId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'fromRecordTypeId')
      or pg_catalog.jsonb_typeof(relationship_item -> 'toRecordTypes') is distinct from 'array'
      or pg_catalog.jsonb_array_length(relationship_item -> 'toRecordTypes') = 0
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(relationship_item -> 'toRecordTypes') as target(value)
        where pg_catalog.jsonb_typeof(target.value) <> 'object'
          or not (target.value ?& array['moduleRootId', 'recordTypeId'])
          or exists (
            select 1 from pg_catalog.jsonb_object_keys(target.value) as supplied(key)
            where supplied.key <> all (array['moduleRootId', 'recordTypeId'])
          )
          or not vortex_context.is_non_nil_uuid(target.value ->> 'moduleRootId')
          or not vortex_context.is_non_nil_uuid(target.value ->> 'recordTypeId')
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(relationship_item ->> 'relationshipId') = any (seen_relationship_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_relationship_ids := pg_catalog.array_append(
      seen_relationship_ids, pg_catalog.lower(relationship_item ->> 'relationshipId')
    );
  end loop;

  -- Sharing conditions: unique identity, the fields the row-scope composition
  -- and the saved-condition predicate actually consume. Extra compiled-release
  -- fields (key, publicationTests, ...) are passed through untouched.
  for condition_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'sharingConditions') as item(value)
  loop
    if pg_catalog.jsonb_typeof(condition_item) <> 'object'
      or not (condition_item ?& array[
        'conditionId', 'sourceRecordTypeId', 'publishedRevision', 'contractFingerprint',
        'parameters', 'condition', 'declaredFieldIds'
      ])
      or not vortex_context.is_non_nil_uuid(condition_item ->> 'conditionId')
      or not vortex_context.is_non_nil_uuid(condition_item ->> 'sourceRecordTypeId')
      or pg_catalog.jsonb_typeof(condition_item -> 'publishedRevision') <> 'number'
      or pg_catalog.jsonb_typeof(condition_item -> 'contractFingerprint') <> 'string'
      or pg_catalog.jsonb_typeof(condition_item -> 'parameters') <> 'array'
      or pg_catalog.jsonb_typeof(condition_item -> 'condition') <> 'object'
      or pg_catalog.jsonb_typeof(condition_item -> 'declaredFieldIds') <> 'array' then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(condition_item ->> 'conditionId') = any (seen_condition_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_condition_ids := pg_catalog.array_append(
      seen_condition_ids, pg_catalog.lower(condition_item ->> 'conditionId')
    );
  end loop;

  -- Records: unique identity, well-formed record-identity scope, known type.
  for record_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_item) <> 'object'
      or not (record_item ?& array['recordScope', 'lifecycleState', 'fieldValues'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(record_item) as supplied(key)
        where supplied.key <> all (array[
          'recordScope', 'ownerOrganizationAccountId', 'ownerGroupId', 'lifecycleState', 'fieldValues'
        ])
      )
      or pg_catalog.jsonb_typeof(record_item -> 'recordScope') <> 'object'
      or record_item ->> 'lifecycleState' not in ('active', 'soft_deleted', 'removal_pending')
      or pg_catalog.jsonb_typeof(record_item -> 'fieldValues') <> 'object'
      or (record_item ? 'ownerOrganizationAccountId'
        and not vortex_context.is_non_nil_uuid(record_item ->> 'ownerOrganizationAccountId'))
      or (record_item ? 'ownerGroupId'
        and not vortex_context.is_non_nil_uuid(record_item ->> 'ownerGroupId'))
      or (record_item ? 'ownerOrganizationAccountId' and record_item ? 'ownerGroupId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    record_scope_item := record_item -> 'recordScope';
    select pg_catalog.count(*) into scope_key_count
    from pg_catalog.jsonb_object_keys(record_scope_item) as supplied(key);

    if not (record_scope_item ?& array[
        'storageScope', 'organizationId', 'moduleRootId', 'recordTypeId', 'storageContractId', 'recordId'
      ])
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'organizationId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'moduleRootId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'recordTypeId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'storageContractId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'recordId')
      or (record_scope_item ->> 'storageScope') not in ('organization_shared', 'application_contained')
      or (
        (record_scope_item ->> 'storageScope') = 'organization_shared'
        and (scope_key_count <> 6 or record_scope_item ? 'applicationRootId')
      )
      or (
        (record_scope_item ->> 'storageScope') = 'application_contained'
        and (scope_key_count <> 7 or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'applicationRootId'))
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(record_scope_item ->> 'recordTypeId') = any (seen_type_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(record_scope_item ->> 'recordId') = any (seen_record_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_record_ids := pg_catalog.array_append(seen_record_ids, pg_catalog.lower(record_scope_item ->> 'recordId'));
  end loop;

  -- Edges: well-formed, no dangling relationship or missing endpoint record.
  -- Duplicate/ambiguous edges are a functional refusal inside the row-scope
  -- composition, not a facts-shape violation, so they are not rejected here.
  for edge_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
  loop
    if pg_catalog.jsonb_typeof(edge_item) <> 'object'
      or not (edge_item ?& array['relationshipId', 'fromRecordId', 'toRecordId'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(edge_item) as supplied(key)
        where supplied.key <> all (array['relationshipId', 'fromRecordId', 'toRecordId'])
      )
      or not vortex_context.is_non_nil_uuid(edge_item ->> 'relationshipId')
      or not vortex_context.is_non_nil_uuid(edge_item ->> 'fromRecordId')
      or not vortex_context.is_non_nil_uuid(edge_item ->> 'toRecordId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(edge_item ->> 'relationshipId') = any (seen_relationship_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    if not (pg_catalog.lower(edge_item ->> 'fromRecordId') = any (seen_record_ids))
      or not (pg_catalog.lower(edge_item ->> 'toRecordId') = any (seen_record_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
  end loop;

  -- One Access-version observation, one time sample, shared by the eligibility
  -- call and every row-scope composition below.
  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, ctx, checked_at
  );

  decision_evidence := (eligibility - 'outcome' - 'validUntil' - 'eligiblePermissions' - 'reasonCode')
    || pg_catalog.jsonb_build_object('recordId', p_target_record_id, 'action', p_declaration -> 'action');

  if eligibility ->> 'outcome' = 'refused' then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', eligibility ->> 'reasonCode'
    );
  end if;

  target_application_root_id := (p_declaration -> 'target' ->> 'applicationRootId')::uuid;

  -- Target row check: fail closed, never raise. This is the cross-organisation
  -- and cross-application isolation path.
  select value into target_record_row
  from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  where (value -> 'recordScope' ->> 'recordId')::uuid = p_target_record_id
  limit 1;

  target_ok := target_record_row is not null
    and (target_record_row -> 'recordScope' ->> 'organizationId')::uuid = (ctx ->> 'organizationId')::uuid
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'moduleRootId') = pg_catalog.lower(facts_binding ->> 'moduleRootId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'recordTypeId') = pg_catalog.lower(facts_binding ->> 'recordTypeId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'storageContractId') = pg_catalog.lower(facts_binding ->> 'storageContractId')
    and (target_record_row -> 'recordScope' ->> 'storageScope') = (facts_binding ->> 'storageScope')
    and (
      (facts_binding ->> 'storageScope') = 'organization_shared'
      or (target_record_row -> 'recordScope' ->> 'applicationRootId')::uuid = target_application_root_id
    )
    and target_record_row ->> 'lifecycleState' = 'active';

  if not target_ok then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  auth_deadline := vortex_access.recent_authentication_deadline_internal(
    ctx, checked_at, p_declaration -> 'recentAuthentication'
  );

  select coalesce(
    pg_catalog.jsonb_agg(
      contribution.value
      order by
        alt.ordinality,
        case contribution.value -> 'route' ->> 'kind'
          when 'all_records' then 0
          when 'ownership' then 1
          when 'direct_share' then 2
          when 'relationship' then 3
        end,
        coalesce(
          contribution.value -> 'route' ->> 'directShareId',
          contribution.value -> 'route' ->> 'sourceRecordId',
          ''
        )
    ),
    '[]'::jsonb
  )
  into matched
  from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions')
    with ordinality as alt(value, ordinality)
  cross join lateral pg_catalog.jsonb_array_elements(
    vortex_access.evaluate_record_permission_row_scope_internal(
      ctx,
      checked_at,
      auth_deadline,
      target_application_root_id,
      p_declaration -> 'action',
      alt.value,
      p_target_record_id,
      p_facts,
      array[(alt.value -> 'permission' ->> 'permissionId')::uuid]
    )
  ) as contribution(value);

  if pg_catalog.jsonb_array_length(matched) = 0 then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  select vortex_context.format_timestamp_utc(
    pg_catalog.min((elem.value ->> 'validUntil')::timestamptz)
  )
  into decision_valid_until
  from pg_catalog.jsonb_array_elements(matched) as elem(value);

  return decision_evidence || pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'validUntil', decision_valid_until,
    'matchedContributions', matched
  );
end
$function$;

revoke execute on function vortex_access.evaluate_organization_record_access_internal(jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner;
grant execute on function vortex_access.evaluate_organization_record_access_internal(jsonb, uuid, jsonb)
  to vortex_record_adapter;
comment on function vortex_access.evaluate_organization_record_access_internal(jsonb, uuid, jsonb) is
  'The complete exact-record access decision: unions every eligible alternative''s own complete row scope and always carries the exact recordId. Owner-only except for the fixed record adapter.';

create or replace function vortex_file.upload_file_record(p_file vortex_file.file_records)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'fileId', p_file.file_id,
    'organizationId', p_file.organization_id,
    'applicationRootId', p_file.application_root_id,
    'lifecycleState', p_file.lifecycle_state,
    'originalSafeDisplayName', p_file.original_safe_display_name,
    'detectedMediaType', p_file.detected_media_type,
    'extension', p_file.extension,
    'sizeBytes', p_file.size_bytes,
    'checksum', p_file.checksum,
    'storageKey', p_file.storage_key,
    'bucketId', p_file.bucket_id,
    'scannerName', p_file.scanner_name,
    'scannerVersion', p_file.scanner_version,
    'scannerResult', p_file.scanner_result,
    'previewReferences', p_file.preview_references,
    'uploadedBy', p_file.uploaded_by,
    'createdAt', vortex_context.format_timestamp_utc(p_file.created_at),
    'activatedAt', vortex_context.format_timestamp_utc(p_file.activated_at),
    'deletedAt', vortex_context.format_timestamp_utc(p_file.deleted_at),
    'removalDueAt', vortex_context.format_timestamp_utc(p_file.removal_due_at),
    'owningAttachmentReferences', pg_catalog.to_jsonb(p_file.owning_attachment_references),
    'ownerRecordTypeId', p_file.owner_record_type_id,
    'ownerRecordId', p_file.owner_record_id,
    'ownerFieldId', p_file.owner_field_id,
    'legalHold', pg_catalog.jsonb_build_object('isHeld', p_file.legal_hold)
  ))
$function$;

revoke execute on function vortex_file.upload_file_record(vortex_file.file_records) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_file.upload_file_record(vortex_file.file_records) is
  'Returns the canonical FileRecord projection with UTC timestamp values.';

create or replace function vortex_file.read_file_upload(p_file_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_file.upload_validated_context();
  reservation vortex_file.upload_reservations%rowtype;
  uploaded vortex_file.file_records%rowtype;
  current_grant_id uuid;
begin
  select stored.* into reservation
  from vortex_file.upload_reservations as stored
  where stored.file_id = p_file_id
    and stored.organization_id = (established ->> 'organizationId')::uuid;
  if not found then
    return null;
  end if;

  select stored.* into strict uploaded
  from vortex_file.file_records as stored
  where stored.file_id = p_file_id;

  select current_grant.one_time_id into current_grant_id
  from vortex_file.upload_grants as current_grant
  where current_grant.file_id = p_file_id
    and current_grant.superseded_at is null;

  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'fileRecord', vortex_file.upload_file_record(uploaded),
    'uploader', reservation.uploaded_by,
    'maximumBytes', reservation.maximum_bytes,
    'uploadExpiresAt', vortex_context.format_timestamp_utc(reservation.upload_expires_at),
    'replacingFileId', reservation.replacing_file_id,
    'currentGrantId', current_grant_id,
    'correlationId', reservation.correlation_id,
    'revision', reservation.revision
  ));
end
$function$;

revoke execute on function vortex_file.read_file_upload(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.read_file_upload(uuid) to vortex_request;

comment on function vortex_file.read_file_upload(uuid) is
  'Reads one upload of the request organisation with its current grant and revision.';

create or replace function vortex_file.claim_file_upload_grant(p_one_time_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_file.upload_validated_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  claimed_file_id uuid;
  reservation vortex_file.upload_reservations%rowtype;
  claimed vortex_file.upload_grants%rowtype;
  uploaded vortex_file.file_records%rowtype;
begin
  select candidate.file_id into claimed_file_id
  from vortex_file.upload_grants as candidate
  where candidate.one_time_id = p_one_time_id
    and candidate.organization_id = (established ->> 'organizationId')::uuid;
  if not found or request_actor is null then
    return null;
  end if;

  -- Reservation first, then grant: the same order renewal and completion use.
  select stored.* into strict reservation
  from vortex_file.upload_reservations as stored
  where stored.file_id = claimed_file_id
  for update;

  select stored.* into strict claimed
  from vortex_file.upload_grants as stored
  where stored.one_time_id = p_one_time_id
  for update;

  select stored.* into strict uploaded
  from vortex_file.file_records as stored
  where stored.file_id = claimed_file_id;

  if claimed.superseded_at is not null
    or claimed.credential_issued_at is not null
    or claimed.expires_at <= evaluated_at
    or claimed.actor is distinct from request_actor
    or reservation.uploaded_by is distinct from request_actor
    or reservation.upload_expires_at <= evaluated_at
    or uploaded.lifecycle_state <> 'pending' then
    return null;
  end if;

  update vortex_file.upload_grants
  set credential_issued_at = evaluated_at
  where one_time_id = claimed.one_time_id;

  return pg_catalog.jsonb_build_object(
    'grant', pg_catalog.jsonb_build_object(
      'kind', 'upload',
      'organizationId', claimed.organization_id,
      'actor', claimed.actor,
      'recordTypeId', reservation.owner_record_type_id,
      'recordId', reservation.owner_record_id,
      'fieldId', reservation.owner_field_id,
      'maximumBytes', claimed.maximum_bytes,
      'policyFingerprint', claimed.policy_fingerprint,
      'expiresAt', vortex_context.format_timestamp_utc(claimed.expires_at),
      'oneTimeId', claimed.one_time_id
    ),
    'fileRecord', vortex_file.upload_file_record(uploaded),
    'correlationId', reservation.correlation_id
  );
end
$function$;

revoke execute on function vortex_file.claim_file_upload_grant(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.claim_file_upload_grant(uuid) to vortex_request;

comment on function vortex_file.claim_file_upload_grant(uuid) is
  'Issues the one Storage credential of a current, unexpired grant for the uploader of a pending upload.';

create or replace function vortex_file.read_file_for_download(p_file_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_context.validated_service_context();
  stored vortex_file.file_records%rowtype;
begin
  select candidate.* into stored
  from vortex_file.file_records as candidate
  where candidate.file_id = p_file_id
    and candidate.organization_id = (established ->> 'organizationId')::uuid;
  if not found then
    return null;
  end if;
  return vortex_file.upload_file_record(stored);
end
$function$;

revoke execute on function vortex_file.read_file_for_download(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.read_file_for_download(uuid) to vortex_request;

comment on function vortex_file.read_file_for_download(uuid) is
  'Reads the canonical FileRecord of one file of the request organisation.';

create or replace function vortex_file.record_file_download_grant(
  p_one_time_id uuid,
  p_file_id uuid,
  p_owner_record_type_id uuid,
  p_owner_record_id uuid,
  p_owner_field_id uuid,
  p_actor jsonb,
  p_purpose text,
  p_correlation_id uuid,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_context.validated_service_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  request_organization_id uuid := (established ->> 'organizationId')::uuid;
  stored vortex_file.file_records%rowtype;
begin
  if request_actor is null
    or p_actor is distinct from request_actor then
    raise exception using errcode = '42501', message = 'File read scope is unavailable';
  end if;

  if p_one_time_id is null
    or p_file_id is null
    or p_owner_record_type_id is null
    or p_owner_record_id is null
    or p_owner_field_id is null
    or p_correlation_id is null
    or p_purpose is null or p_purpose not in ('download', 'preview')
    or p_expires_at is null
    or p_expires_at <= evaluated_at
    or p_expires_at > evaluated_at + interval '65 seconds' then
    raise exception using errcode = '22023', message = 'File read grant is invalid';
  end if;

  select candidate.* into stored
  from vortex_file.file_records as candidate
  where candidate.file_id = p_file_id
    and candidate.organization_id = request_organization_id;
  if not found
    or stored.lifecycle_state <> 'active'
    or stored.scanner_result <> 'clean'
    or stored.owner_record_type_id is distinct from p_owner_record_type_id
    or stored.owner_record_id is distinct from p_owner_record_id
    or stored.owner_field_id is distinct from p_owner_field_id then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  delete from vortex_file.download_grants as expired
  where expired.ctid in (
    select candidate.ctid
    from vortex_file.download_grants as candidate
    where candidate.organization_id = request_organization_id
      and candidate.expires_at < evaluated_at - interval '1 hour'
    order by candidate.expires_at
    limit 100
  );

  insert into vortex_file.download_grants (
    one_time_id, file_id, organization_id,
    owner_record_type_id, owner_record_id, owner_field_id,
    actor, purpose, correlation_id, expires_at, created_at
  ) values (
    p_one_time_id, p_file_id, request_organization_id,
    p_owner_record_type_id, p_owner_record_id, p_owner_field_id,
    request_actor, p_purpose, p_correlation_id, p_expires_at, evaluated_at
  );

  return pg_catalog.jsonb_build_object('outcome', 'recorded');
end
$function$;

revoke execute on function vortex_file.record_file_download_grant(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, uuid, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.record_file_download_grant(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, uuid, timestamptz
) to vortex_request;

comment on function vortex_file.record_file_download_grant(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, uuid, timestamptz
) is
  'Records one unclaimed short-lived read grant for the request actor on an active clean attached file.';

create or replace function vortex_file.claim_file_download_grant(p_one_time_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_context.validated_service_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  claimed vortex_file.download_grants%rowtype;
  stored vortex_file.file_records%rowtype;
begin
  if request_actor is null then
    return null;
  end if;

  select candidate.* into claimed
  from vortex_file.download_grants as candidate
  where candidate.one_time_id = p_one_time_id
    and candidate.organization_id = (established ->> 'organizationId')::uuid
  for update;
  if not found
    or claimed.credential_issued_at is not null
    or claimed.expires_at <= evaluated_at
    or claimed.actor is distinct from request_actor then
    return null;
  end if;

  select candidate.* into stored
  from vortex_file.file_records as candidate
  where candidate.file_id = claimed.file_id
    and candidate.organization_id = claimed.organization_id;
  if not found
    or stored.lifecycle_state <> 'active'
    or stored.scanner_result <> 'clean'
    or stored.owner_record_type_id is distinct from claimed.owner_record_type_id
    or stored.owner_record_id is distinct from claimed.owner_record_id
    or stored.owner_field_id is distinct from claimed.owner_field_id then
    return null;
  end if;

  update vortex_file.download_grants
  set credential_issued_at = evaluated_at
  where one_time_id = claimed.one_time_id;

  return pg_catalog.jsonb_build_object(
    'grant', pg_catalog.jsonb_build_object(
      'kind', 'download',
      'organizationId', claimed.organization_id,
      'actor', claimed.actor,
      'recordTypeId', claimed.owner_record_type_id,
      'recordId', claimed.owner_record_id,
      'fieldId', claimed.owner_field_id,
      'fileId', claimed.file_id,
      'oneTimeId', claimed.one_time_id,
      'expiresAt', vortex_context.format_timestamp_utc(claimed.expires_at)
    ),
    'fileRecord', vortex_file.upload_file_record(stored),
    'correlationId', claimed.correlation_id
  );
end
$function$;

revoke execute on function vortex_file.claim_file_download_grant(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.claim_file_download_grant(uuid) to vortex_request;

comment on function vortex_file.claim_file_download_grant(uuid) is
  'Claims an unexpired read grant of the request actor exactly once with its current FileRecord.';

create or replace function vortex_access.flow_execution_binding_to_json_internal(
  b vortex_access.flow_execution_bindings
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'executionBindingId', b.execution_binding_id,
    'organizationId', b.organization_id,
    'applicationRootId', b.application_root_id,
    'releaseVersion', b.release_version,
    'flowId', b.flow_id,
    'nodeId', b.node_id,
    'operation', pg_catalog.jsonb_build_object(
      'owner', case b.operation_owner_kind
        when 'application' then pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', b.operation_owner_id)
        when 'module' then pg_catalog.jsonb_build_object(
          'kind', 'module', 'moduleRootId', b.operation_owner_id)
        else pg_catalog.jsonb_build_object(
          'kind', 'platform_service', 'serviceId', b.operation_owner_id)
      end,
      'operationId', b.operation_id
    ),
    'actor', case b.actor_kind
      when 'specified_user' then pg_catalog.jsonb_build_object(
        'kind', 'specified_user', 'organizationAccountId', b.actor_organization_account_id)
      else pg_catalog.jsonb_build_object('kind', 'system', 'systemActorId', b.actor_system_actor_id)
    end,
    'permittedInvokers', b.permitted_invokers,
    'permittedSurfaces', b.permitted_surfaces,
    'permittedInputs', b.permitted_inputs,
    'state', b.state,
    'revision', b.revision,
    'recordedAt', vortex_context.format_timestamp_utc(b.recorded_at)
  )
  || case when b.expires_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'expiresAt', vortex_context.format_timestamp_utc(b.expires_at)) end
  || case when b.revoked_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'revokedAt', vortex_context.format_timestamp_utc(b.revoked_at)) end
$function$;

revoke all on function vortex_access.flow_execution_binding_to_json_internal(vortex_access.flow_execution_bindings) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.flow_execution_binding_to_json_internal(vortex_access.flow_execution_bindings) is
  'Projects one stored flow execution binding into its canonical JSON form.';

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
      coalesce(vortex_context.format_timestamp_utc(p_expires_at), ''),
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
    vortex_context.channel(),
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
    or not vortex_context.uuid_array_is_canonical(p_readable_field_ids)
    or p_changeable_field_ids is null
    or not vortex_context.uuid_array_is_canonical(p_changeable_field_ids)
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

create or replace function vortex_access.grant_organization_direct_record_share(
  p_organization_id uuid,
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
  p_changed_by uuid,
  p_correlation_id uuid,
  p_activity_id uuid
)
returns table (
  direct_share_id uuid,
  revision bigint,
  state text,
  changed_at timestamptz,
  access_version bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  operation_at timestamptz;
  next_access_version bigint;
  activity_result text;
begin
  if p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_direct_share_id is null
    or not vortex_context.is_non_nil_uuid(p_direct_share_id::text)
    or p_module_root_id is null
    or not vortex_context.is_non_nil_uuid(p_module_root_id::text)
    or p_record_type_id is null
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or p_storage_contract_id is null
    or not vortex_context.is_non_nil_uuid(p_storage_contract_id::text)
    or p_record_id is null
    or not vortex_context.is_non_nil_uuid(p_record_id::text)
    or p_changed_by is null
    or not vortex_context.is_non_nil_uuid(p_changed_by::text)
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text)
    or p_activity_id is null
    or not vortex_context.is_non_nil_uuid(p_activity_id::text)
    or p_storage_scope not in ('organization_shared', 'application_contained')
    or (p_storage_scope = 'organization_shared' and p_application_root_id is not null)
    or (p_storage_scope = 'application_contained' and (
      p_application_root_id is null
      or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    ))
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
    or not vortex_context.uuid_array_is_canonical(p_readable_field_ids)
    or p_changeable_field_ids is null
    or not vortex_context.uuid_array_is_canonical(p_changeable_field_ids)
    or not (p_changeable_field_ids <@ p_readable_field_ids)
    or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or p_reason is null
    or pg_catalog.char_length(p_reason) not between 1 and 500 then
    raise exception using errcode = '22023',
      message = 'Direct record-share grant input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Direct record-share grant scope is unavailable';
  end if;

  if p_recipient_kind = 'organization_account' then
    perform 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active';
  else
    perform 1
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = p_organization_id
      and organization_group.group_id = p_group_id
      and organization_group.state = 'active';
  end if;
  if not found then
    raise exception using errcode = '42501',
      message = 'Direct record-share recipient is unavailable';
  end if;

  if exists (
    select 1
    from vortex_access.organization_direct_record_shares as share
    where share.organization_id = p_organization_id
      and share.direct_share_id = p_direct_share_id
  ) then
    raise exception using errcode = '40001',
      message = 'Direct record-share grant is stale or unavailable';
  end if;

  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at is not null and p_expires_at <= operation_at then
    raise exception using errcode = '40001',
      message = 'Direct record-share grant window is stale';
  end if;
  insert into vortex_access.organization_direct_record_shares (
    organization_id, direct_share_id, storage_scope, application_root_id,
    module_root_id, record_type_id, storage_contract_id, record_id,
    recipient_kind, organization_account_id, group_id, readable_field_ids,
    changeable_field_ids, starts_at, expires_at, state, revision, granted_by,
    granted_at, grant_correlation_id, reason, changed_at
  ) values (
    p_organization_id, p_direct_share_id, p_storage_scope,
    p_application_root_id, p_module_root_id, p_record_type_id,
    p_storage_contract_id, p_record_id, p_recipient_kind,
    p_organization_account_id, p_group_id, p_readable_field_ids,
    p_changeable_field_ids, p_starts_at, p_expires_at, 'active', 1,
    p_changed_by, operation_at, p_correlation_id, p_reason, operation_at
  );

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'direct_share_changed'
  ) as version;

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id, p_activity_id, operation_at, 'organization_account',
    p_changed_by, 'grant_direct_record_share', array[p_direct_share_id]::uuid[],
    array[]::uuid[], vortex_context.channel(), p_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Direct record-share grant Activity is stale';
  end if;

  return query select p_direct_share_id, 1::bigint, 'active'::text,
    operation_at, next_access_version;
end
$function$;

revoke execute on function vortex_access.grant_organization_direct_record_share(
  uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid[],
  uuid[], timestamptz, timestamptz, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.grant_organization_direct_record_share(
  uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid[],
  uuid[], timestamptz, timestamptz, text, uuid, uuid, uuid
) is
  'Owner-only structural direct-share grant writer. It changes Access and appends Activity but makes no grantor authorization or field-ceiling decision.';

-- Existing stored UUID identities are preserved. Refuse this migration rather than silently
-- retaining lifecycle policy values that the strict UUID contract would reject.
set local role vortex_record_owner;
do $guard$
begin
  if exists (
    select 1
    from vortex_record.record_type_lifecycle_policies as policy
    where not vortex_context.is_non_nil_uuid(policy.policy_id::text)
      or not vortex_context.is_non_nil_uuid(policy.organization_id::text)
      or not vortex_context.is_non_nil_uuid(policy.storage_contract_id::text)
      or (policy.application_root_id is not null
        and not vortex_context.is_non_nil_uuid(policy.application_root_id::text))
      or not vortex_context.is_non_nil_uuid(policy.policy_body ->> 'policyId')
      or not vortex_context.is_non_nil_uuid(policy.policy_body ->> 'organizationId')
      or not vortex_context.is_non_nil_uuid(policy.policy_body ->> 'storageContractId')
      or (policy.policy_body ->> 'applicationRootId' is not null
        and not vortex_context.is_non_nil_uuid(policy.policy_body ->> 'applicationRootId'))
      or (policy.policy_body ? 'archiveWorkflowId'
        and not vortex_context.is_non_nil_uuid(policy.policy_body ->> 'archiveWorkflowId'))
      or (policy.policy_body ? 'archiveConnectionInstanceId'
        and not vortex_context.is_non_nil_uuid(policy.policy_body ->> 'archiveConnectionInstanceId'))
  ) then
    raise exception using errcode = '23514',
      message = 'Stored lifecycle policy contains a UUID outside the strict version and variant rule';
  end if;

  if exists (
    select 1
    from vortex_record.organization_lifecycle_limits as limits
    where not vortex_context.is_non_nil_uuid(limits.organization_id::text)
  ) then
    raise exception using errcode = '23514',
      message = 'Stored lifecycle limits contain an organization UUID outside the strict version and variant rule';
  end if;
end
$guard$;
reset role;

do $guard$
begin
  if exists (
    select 1
    from vortex_activity.organization_activity_entries as entry
    where (entry.subject_ids is not null
        and not vortex_context.uuid_array_is_canonical(entry.subject_ids))
      or (entry.changed_field_ids is not null
        and not vortex_context.uuid_array_is_canonical(entry.changed_field_ids))
  ) then
    raise exception using errcode = '23514',
      message = 'Stored activity UUID arrays violate the strict version, variant, or ordering rule';
  end if;

  if exists (
    select 1
    from vortex_identity.accepted_administration_receipts as receipt
    where receipt.subject_ids is not null
      and not vortex_context.uuid_array_is_canonical(receipt.subject_ids)
  ) then
    raise exception using errcode = '23514',
      message = 'Stored administration receipt UUID arrays violate the strict version, variant, or ordering rule';
  end if;

  if exists (
    select 1
    from vortex_access.organization_direct_record_shares as share
    where (share.readable_field_ids is not null
        and not vortex_context.uuid_array_is_canonical(share.readable_field_ids))
      or (share.changeable_field_ids is not null
        and not vortex_context.uuid_array_is_canonical(share.changeable_field_ids))
  ) then
    raise exception using errcode = '23514',
      message = 'Stored direct-share UUID arrays violate the strict version, variant, or ordering rule';
  end if;
end
$guard$;

-- Repoint stored checks before removing their service-specific implementations.
alter table vortex_activity.organization_activity_entries
  drop constraint organization_activity_entries_subjects_canonical,
  drop constraint organization_activity_entries_fields_canonical;
alter table vortex_activity.organization_activity_entries
  add constraint organization_activity_entries_subjects_canonical check (
    pg_catalog.cardinality(subject_ids) >= 1
    and vortex_context.uuid_array_is_canonical(subject_ids)
  ),
  add constraint organization_activity_entries_fields_canonical check (
    vortex_context.uuid_array_is_canonical(changed_field_ids)
  );

alter table vortex_identity.accepted_administration_receipts
  drop constraint accepted_administration_receipts_subject_ids_valid;
alter table vortex_identity.accepted_administration_receipts
  add constraint accepted_administration_receipts_subject_ids_valid check (
    pg_catalog.cardinality(subject_ids) >= 1
    and vortex_context.uuid_array_is_canonical(subject_ids)
  );

alter table vortex_access.organization_direct_record_shares
  drop constraint organization_direct_record_shares_fields_valid;
alter table vortex_access.organization_direct_record_shares
  add constraint organization_direct_record_shares_fields_valid check (
    pg_catalog.cardinality(readable_field_ids) > 0
    and vortex_context.uuid_array_is_canonical(readable_field_ids)
    and vortex_context.uuid_array_is_canonical(changeable_field_ids)
    and changeable_field_ids <@ readable_field_ids
  );

-- Retire duplicate validators now that their callers and constraints share one implementation.
set local role vortex_record_owner;
drop function vortex_record.is_lifecycle_uuid_text(text);
reset role;
drop function vortex_file.upload_timestamp(timestamptz);
drop function vortex_access.flow_execution_binding_timestamp_internal(timestamptz);
drop function vortex_activity.uuid_array_is_canonical(uuid[]);
drop function vortex_access.direct_share_field_ids_are_canonical(uuid[]);

commit;
