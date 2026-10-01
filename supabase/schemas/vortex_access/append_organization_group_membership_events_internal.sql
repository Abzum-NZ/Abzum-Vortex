create or replace function vortex_access.append_organization_group_membership_events_internal(
  p_operation text,
  p_captured_initiator jsonb,
  p_native_subjects jsonb,
  p_completed_activity_id uuid
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
  organization_id_value uuid;
  account_id_value uuid;
  correlation_id_value uuid;
  before_version bigint;
  after_version bigint;
  authority_checked_at timestamptz;
  version_row vortex_access.organization_access_versions%rowtype;
  activity_row vortex_activity.organization_activity_entries%rowtype;
  source_schema text;
  source_function text;
  expected_activity_action text;
  expected_subject_count integer;
  subject_item jsonb;
  subject_role text;
  subject_id uuid;
  subject_revision bigint;
  subject_ids uuid[] := array[]::uuid[];
  membership_fact vortex_access.organization_group_memberships%rowtype;
  renewal_group_id uuid;
  renewal_account_id uuid;
  expected_state text;
  event_kind text;
  changed_attributes jsonb;
  proof_subjects jsonb := '[]'::jsonb;
  native_proof jsonb;
begin
  if p_operation is null or p_operation not in (
      'add_membership', 'remove_membership', 'restore_membership',
      'renew_membership'
    )
    or p_completed_activity_id is null or p_completed_activity_id = nil_uuid
    or pg_catalog.jsonb_typeof(p_captured_initiator) is distinct from 'object'
    or not p_captured_initiator ?& array[
      'kind', 'organizationId', 'organizationAccountId', 'correlationId',
      'accessVersionBefore', 'authorityCheckedAt'
    ]
    or p_captured_initiator - array[
      'kind', 'organizationId', 'organizationAccountId', 'correlationId',
      'accessVersionBefore', 'authorityCheckedAt'
    ] <> '{}'::jsonb
    or p_captured_initiator ->> 'kind' is distinct from 'human'
    or pg_catalog.jsonb_typeof(p_captured_initiator -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_captured_initiator -> 'organizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_captured_initiator -> 'correlationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_captured_initiator -> 'accessVersionBefore') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_captured_initiator -> 'authorityCheckedAt') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_native_subjects) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Group membership Event input is invalid';
  end if;

  begin
    organization_id_value := (p_captured_initiator ->> 'organizationId')::uuid;
    account_id_value := (p_captured_initiator ->> 'organizationAccountId')::uuid;
    correlation_id_value := (p_captured_initiator ->> 'correlationId')::uuid;
    before_version := (p_captured_initiator ->> 'accessVersionBefore')::bigint;
    authority_checked_at := (p_captured_initiator ->> 'authorityCheckedAt')::timestamptz;
  exception when others then
    raise exception using errcode = '22023',
      message = 'Group membership Event initiator is invalid';
  end;

  if not vortex_context.is_non_nil_uuid(organization_id_value::text)
    or not vortex_context.is_non_nil_uuid(account_id_value::text)
    or not vortex_context.is_non_nil_uuid(correlation_id_value::text)
    or before_version < 0 or before_version >= maximum_safe_revision
    or authority_checked_at is null
    or authority_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz) then
    raise exception using errcode = '22023',
      message = 'Group membership Event initiator is invalid';
  end if;

  expected_subject_count := case when p_operation = 'renew_membership' then 2 else 1 end;
  if pg_catalog.jsonb_array_length(p_native_subjects) <> expected_subject_count
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not item.value ?& array['role', 'membershipId', 'revision']
        or item.value - array['role', 'membershipId', 'revision'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(item.value -> 'role') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'membershipId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'revision') is distinct from 'number'
    ) then
    raise exception using errcode = '22023',
      message = 'Group membership Event subjects are invalid';
  end if;

  begin
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
      where not vortex_context.is_non_nil_uuid(item.value ->> 'membershipId')
        or (item.value ->> 'revision')::bigint < 1
        or (item.value ->> 'revision')::bigint > maximum_safe_revision
    ) then
      raise exception using errcode = '22023',
        message = 'Group membership Event subjects are invalid';
    end if;
  exception when others then
    raise exception using errcode = '22023',
      message = 'Group membership Event subjects are invalid';
  end;

  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
      where case p_operation
        when 'renew_membership' then item.value ->> 'role' not in (
          'predecessor', 'replacement'
        )
        else item.value ->> 'role' is distinct from 'membership'
      end
    )
    or (
      select pg_catalog.count(distinct (item.value ->> 'membershipId')::uuid)
      from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
    ) <> expected_subject_count
    or (p_operation = 'renew_membership' and (
      (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
        where item.value ->> 'role' = 'predecessor') <> 1
      or (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
        where item.value ->> 'role' = 'replacement') <> 1
    )) then
    raise exception using errcode = '22023',
      message = 'Group membership Event subjects are invalid';
  end if;

  select registry.reader_schema, registry.reader_function
  into source_schema, source_function
  from vortex_record.protected_read_model_views as registry
  where registry.protected_read_model_key = 'people';
  if not found or source_schema is distinct from 'vortex_access'
    or source_function is distinct from 'list_organization_group_memberships_projection' then
    raise exception using errcode = '55000',
      message = 'Group membership projection source is unavailable';
  end if;

  select version.* into version_row
  from vortex_access.organization_access_versions as version
  where version.organization_id = organization_id_value
  for update;
  if not found then
    raise exception using errcode = '40001',
      message = 'Group membership Event Access evidence is stale';
  end if;
  after_version := version_row.current_version;
  if after_version is distinct from before_version + 1
    or version_row.current_version > maximum_safe_revision
    or version_row.changed_by is distinct from account_id_value
    or version_row.change_correlation_id is distinct from correlation_id_value
    or version_row.change_reason is distinct from 'group_membership_changed' then
    raise exception using errcode = '40001',
      message = 'Group membership Event Access evidence is stale';
  end if;

  expected_activity_action := case p_operation
    when 'add_membership' then 'add_group_membership'
    when 'remove_membership' then 'remove_group_membership'
    else p_operation
  end;
  select entry.* into activity_row
  from vortex_activity.organization_activity_entries as entry
  where entry.organization_id = organization_id_value
    and entry.activity_id = p_completed_activity_id;
  if not found
    or activity_row.outcome is distinct from 'completed'
    or activity_row.actor_kind is distinct from 'organization_account'
    or activity_row.actor_id is distinct from account_id_value
    or activity_row.correlation_id is distinct from correlation_id_value
    or (activity_row.action is distinct from expected_activity_action
      and not (p_operation = 'add_membership'
        and activity_row.action = 'add_membership'))
    or pg_catalog.cardinality(activity_row.subject_ids) <> expected_subject_count then
    raise exception using errcode = '40001',
      message = 'Group membership Event Activity is unavailable';
  end if;

  for subject_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
    order by (item.value ->> 'membershipId')::uuid
  loop
    subject_role := subject_item ->> 'role';
    subject_id := (subject_item ->> 'membershipId')::uuid;
    subject_revision := (subject_item ->> 'revision')::bigint;
    subject_ids := pg_catalog.array_append(subject_ids, subject_id);

    select membership.* into membership_fact
    from vortex_access.organization_group_memberships as membership
    where membership.organization_id = organization_id_value
      and membership.membership_id = subject_id
    for update;
    if not found
      or membership_fact.revision is distinct from subject_revision
      or membership_fact.changed_by is distinct from account_id_value
      or membership_fact.change_correlation_id is distinct from correlation_id_value then
      raise exception using errcode = '40001',
        message = 'Group membership Event subject is stale';
    end if;

    expected_state := case
      when p_operation = 'remove_membership' then 'revoked'
      when p_operation = 'renew_membership' and subject_role = 'predecessor' then 'revoked'
      else 'live'
    end;
    if membership_fact.state is distinct from expected_state then
      raise exception using errcode = '40001',
        message = 'Group membership Event subject is stale';
    end if;

    if p_operation = 'renew_membership' then
      if renewal_group_id is null then
        renewal_group_id := membership_fact.group_id;
        renewal_account_id := membership_fact.organization_account_id;
      elsif membership_fact.group_id is distinct from renewal_group_id
        or membership_fact.organization_account_id is distinct from renewal_account_id then
        raise exception using errcode = '40001',
          message = 'Group membership Event renewal is inconsistent';
      end if;
    end if;

    event_kind := case
      when p_operation = 'add_membership' then 'created'
      when p_operation = 'renew_membership' and subject_role = 'replacement' then 'created'
      else 'changed'
    end;
    changed_attributes := case when event_kind = 'created'
      then '[]'::jsonb else '["state", "temporal_state"]'::jsonb end;
    proof_subjects := proof_subjects || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordId', subject_id,
        'nativeRevision', subject_revision,
        'eventKind', event_kind,
        'changedProjectionAttributes', changed_attributes
      )
    );
  end loop;

  if not (activity_row.subject_ids @> subject_ids)
    or not (subject_ids @> activity_row.subject_ids) then
    raise exception using errcode = '40001',
      message = 'Group membership Event Activity is inconsistent';
  end if;

  native_proof := pg_catalog.jsonb_build_object(
    'kind', 'native-projection-v1',
    'source', pg_catalog.jsonb_build_object(
      'protectedReadModelKey', 'people',
      'readerSchema', source_schema,
      'readerFunction', source_function
    ),
    'initiator', pg_catalog.jsonb_build_object(
      'kind', 'human',
      'organizationId', organization_id_value,
      'organizationAccountId', account_id_value,
      'correlationId', correlation_id_value,
      'accessVersionBefore', before_version,
      'accessVersionAfter', after_version,
      'authorityCheckedAt', vortex_context.format_timestamp_utc(authority_checked_at)
    ),
    'nativeChange', pg_catalog.jsonb_build_object(
      'operation', p_operation,
      'completedActivityId', p_completed_activity_id,
      'subjects', proof_subjects
    )
  );

  perform vortex_event.append_system_projection_occurrences_internal(native_proof);
  return native_proof;
end
$function$;

alter function vortex_access.append_organization_group_membership_events_internal(
  text, jsonb, jsonb, uuid
) owner to postgres;
revoke all on function vortex_access.append_organization_group_membership_events_internal(
  text, jsonb, jsonb, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_event_owner, vortex_module_owner, vortex_definition_owner,
  vortex_record_owner, vortex_record_adapter;
comment on function vortex_access.append_organization_group_membership_events_internal(
  text, jsonb, jsonb, uuid
) is
  'Validates one completed human Group membership transaction and mints a closed native proof from retained Access-version, Activity, and membership facts before appending installed system projection occurrences.';
