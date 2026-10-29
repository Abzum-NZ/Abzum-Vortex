begin;

set local role vortex_owner;

create or replace function vortex_access.list_organization_activity_entries_projection(
  p_record_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
  p_limit integer,
  p_predicate jsonb
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  actor_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean;
  person_record_type_id uuid;
  installation_plan jsonb;
  installation_record_types jsonb;
  after_occurred_at timestamptz;
  after_record_id uuid;
  keyset_sql text := '';
  base_sql text;
  source_sql text;
  order_sql text;
  scan_sql text;
  predicate_plan jsonb;
begin
  -- The action is the one filterable key (the record title); there is no searchable key.
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "action": {"sql": "entry.action", "database": "text", "filter": true}
    }$declared$::jsonb,
    10
  );
  if p_sort_key <> 'occurred_at' or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Activity projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) <> 'string'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Activity projection cursor is invalid';
    end if;
    begin
      after_occurred_at := (p_after -> 'sortKey' ->> 0)::timestamptz;
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Activity projection cursor is invalid';
    end;
    keyset_sql := case when p_direction = 'descending'
      then ' and (entry.occurred_at, entry.activity_id) < ($6, $7)'
      else ' and (entry.occurred_at, entry.activity_id) > ($6, $7)' end;
  end if;
  begin
    checked_context := vortex_access.validated_human_request_context();
    visible_organization_id := (checked_context ->> 'organizationId')::uuid;
    actor_identity_id := (checked_context ->> 'identityId')::uuid;
    actor_account_id := (checked_context ->> 'organizationAccountId')::uuid;
    perform 1 from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    );
  exception
    when insufficient_privilege or no_data_found then
      return;
  end;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.activity.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        'platform.organization.activity.read'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = visible_organization_id
      and decision_account_id = actor_account_id,
    false
  );

  -- Use this request's validated live/preview installation, including its pins.
  installation_plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_definition.read_current_active_installation()
  );
  select pg_catalog.jsonb_agg(installed.value) into installation_record_types
  from pg_catalog.jsonb_each(installation_plan -> 'recordTypes') as installed(key, value);
  person_record_type_id := vortex_access.resolve_installed_account_record_type_internal(
    installation_record_types
  );

  order_sql := pg_catalog.format(
    ' order by entry.occurred_at %s, entry.activity_id %s limit $8',
    case when p_direction = 'descending' then 'desc' else 'asc' end,
    case when p_direction = 'descending' then 'desc' else 'asc' end
  );
  base_sql := $scan$select entry.*
    from vortex_record.organization_activity_entries as entry
    where entry.organization_id = $1
      and entry.occurred_at >= pg_catalog.statement_timestamp() - interval '90 days'
      and ($2 is null or entry.activity_id = any($2))$scan$
    || coalesce(' and ' || (predicate_plan ->> 'predicate'), '');
  if audit_projection then
    source_sql := base_sql || keyset_sql || order_sql;
  else
    source_sql := 'select visible.* from (('
      || base_sql
      || ' and entry.actor_kind = ''organization_account'' and entry.actor_id = $4'
      || keyset_sql || order_sql
      || ') union all ('
      || base_sql
      || ' and entry.actor_kind = ''identity'' and entry.actor_id = $5'
      || keyset_sql || order_sql
      || ')) as visible'
      || pg_catalog.format(' order by visible.occurred_at %s, visible.activity_id %s limit $8',
        case when p_direction = 'descending' then 'desc' else 'asc' end,
        case when p_direction = 'descending' then 'desc' else 'asc' end);
  end if;
  scan_sql := $scan$select
    entry.organization_id,
    entry.activity_id,
    1::bigint,
    pg_catalog.jsonb_build_object(
      'organization_id', entry.organization_id::text,
      'revision', 1,
      'occurred_at', entry.occurred_at,
      'actor_kind', case entry.actor_kind
        when 'organization_account' then 'Person'
        when 'identity' then 'Platform operator'
        when 'system' then 'System'
        when 'public_session' then 'Public visitor'
        else 'Other' end,
      'actor', case when entry.actor_kind = 'organization_account'
        then pg_catalog.jsonb_build_object('recordTypeId', $9, 'recordId', entry.actor_id::text)
        else null end,
      'action', entry.action,
      'subject_count', pg_catalog.cardinality(entry.subject_ids),
      'changed_field_count', case when $3
        then pg_catalog.cardinality(entry.changed_field_ids) else null end
    )
  from ($scan$ || source_sql || $scan$) as entry$scan$
    || pg_catalog.format(' order by entry.occurred_at %s, entry.activity_id %s',
      case when p_direction = 'descending' then 'desc' else 'asc' end,
      case when p_direction = 'descending' then 'desc' else 'asc' end);
  return query execute scan_sql using visible_organization_id, p_record_ids,
    audit_projection, actor_account_id, actor_identity_id,
    after_occurred_at, after_record_id, p_limit, person_record_type_id,
    predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

drop function vortex_record.read_organization_activity_aggregates(timestamptz, timestamptz, text, uuid, text, uuid, text, text, text);
drop function vortex_record.read_organization_activity_page(timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid);


-- Do not silently remove a restriction or a persisted execution binding.
do $preflight$
declare
  affected record;
begin
  select organization_id, role_id into affected
  from vortex_access.organization_role_activation_policy_revisions
  where required_caller_execution_binding_id is not null
  order by organization_id, role_id limit 1;
  if found then
    raise exception 'Required-caller policy exists for organisation % and role %',
      affected.organization_id, affected.role_id;
  end if;
  select organization_id, execution_binding_id into affected
  from vortex_access.flow_execution_bindings
  order by organization_id, execution_binding_id limit 1;
  if found then
    raise exception 'Flow execution binding % exists for organisation %; no role is associated with the binding',
      affected.execution_binding_id, affected.organization_id;
  end if;
end
$preflight$;

-- No writer remains for flow execution bindings. Existing policy revisions no longer require one.
drop function vortex_access.coordinate_organization_role_activation_change(text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid, bigint, uuid, bigint, uuid, uuid, uuid);
alter table vortex_access.organization_role_activation_policy_revisions drop column required_caller_execution_binding_id;
drop table vortex_access.flow_execution_bindings;





create or replace function vortex_access.project_organization_role_change_summary(
  p_organization_id uuid,
  p_role_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'roleId', role.role_id,
    'key', revision.role_key,
    'label', revision.label,
    'roleKind', role.role_kind,
    'lifecycle', revision.lifecycle,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'maximumActivationDurationSeconds',
          policy.maximum_activation_duration_seconds,
        'reasonRequired', policy.reason_required,
        'recentAuthentication', case policy.authentication_requirement
          when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
          else pg_catalog.jsonb_build_object(
            'kind', policy.authentication_requirement,
            'maximumAgeSeconds', policy.authentication_maximum_age_seconds
          )
        end
      ))
    end,
    'source', case role.role_kind
      when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
      else pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', role.application_root_id,
        'sourceRoleId', role.source_role_id
      )
    end,
    'acceptedPermissionCount', (
      select pg_catalog.count(*)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    )
  )
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
  where role.organization_id = p_organization_id
    and role.role_id = p_role_id
$function$;

revoke execute on function
  vortex_access.project_organization_role_change_summary(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function
  vortex_access.project_organization_role_change_summary(uuid, uuid) is
  'Private safe current role projection for protected structural changes.';

alter function vortex_access.project_organization_role_change_summary(p_organization_id uuid, p_role_id uuid) owner to vortex_owner;

grant execute on function vortex_access.project_organization_role_change_summary(p_organization_id uuid, p_role_id uuid) to postgres;


create or replace function vortex_access.read_organization_role_for_administration(
  p_role_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  role_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  role_value jsonb;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  select pg_catalog.jsonb_build_object(
    'roleId', role.role_id,
    'key', revision.role_key,
    'label', revision.label,
    'description', revision.description,
    'roleKind', role.role_kind,
    'lifecycle', revision.lifecycle,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'maximumActivationDurationSeconds', policy.maximum_activation_duration_seconds,
        'reasonRequired', policy.reason_required,
        'recentAuthentication', case policy.authentication_requirement
          when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
          else pg_catalog.jsonb_build_object(
            'kind', policy.authentication_requirement,
            'maximumAgeSeconds', policy.authentication_maximum_age_seconds
          )
        end
      ))
    end,
    'source', case role.role_kind
      when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
      else pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', role.application_root_id,
        'sourceRoleId', role.source_role_id
      )
    end,
    'acceptedPermissionCount', (
      select pg_catalog.count(*)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    ),
    'acceptedPermissions', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_strip_nulls(
            pg_catalog.jsonb_build_object(
              'reference', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'applicationRootId', permission.application_root_id,
                  'ownerKind', permission.owner_kind,
                  'ownerId', permission.owner_id,
                  'permissionId', permission.permission_id
                )
              ),
              'key', catalogue.permission_key,
              'label', catalogue.label,
              'description', catalogue.description,
              'recordTypeId', catalogue.record_type_id,
              'action', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'actionKind', catalogue.action_kind,
                  'namedAction', catalogue.named_action
                )
              ),
              'administrative', catalogue.administrative,
              -- The meaning the role accepted, which may be older than the registered one.
              'recordScope', catalogue.record_scope,
              'fieldPolicy', catalogue.field_policy
            )
          ) order by permission.entry_ordinal
        ),
        '[]'::jsonb
      )
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_catalogue_entries as catalogue
        on catalogue.organization_id = permission.organization_id
        and catalogue.registration_kind = permission.registration_kind
        and catalogue.registration_owner_id = permission.registration_owner_id
        and catalogue.registration_revision = permission.accepted_registration_revision
        and catalogue.owner_kind = permission.owner_kind
        and catalogue.owner_id = permission.owner_id
        and catalogue.permission_id = permission.permission_id
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    )
  )
  into role_value
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
  where role.organization_id = scope.organization_id
    and role.role_id = p_role_id;

  return query select scope.organization_id,
    case when role_value is null then 'unavailable' else 'available' end,
    role_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.read_organization_role_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.read_organization_role_for_administration(uuid)
to vortex_request;

comment on function vortex_access.read_organization_role_for_administration(uuid) is
  'Returns one current local role and its accepted configuration without assignment evidence.';

alter function vortex_access.read_organization_role_for_administration(p_role_id uuid) owner to vortex_owner;

grant execute on function vortex_access.read_organization_role_for_administration(p_role_id uuid) to postgres;


create or replace function vortex_identity.tenant_short_name_reserved(p_short_name text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $function$
  select p_short_name = any (array['api', 'auth', 'fonts', 'health', 'signed-in', 'studio']::text[])
$function$;

alter function vortex_identity.tenant_short_name_reserved(text) owner to vortex_owner;
revoke all on function vortex_identity.tenant_short_name_reserved(text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.tenant_short_name_reserved(text) to vortex_owner, postgres;

-- Report conflicting names rather than rename tenants silently.
do $reserved_names$
declare
  names text;
begin
  select pg_catalog.string_agg(short_name, ', ' order by short_name) into names
  from vortex_identity.tenants
  where vortex_identity.tenant_short_name_reserved(short_name);
  if names is not null then
    raise exception 'Existing tenant short names are reserved for platform routes: %', names;
  end if;
end
$reserved_names$;

alter table vortex_identity.tenants add constraint tenants_short_name_not_reserved
  check (not vortex_identity.tenant_short_name_reserved(short_name));


-- Carry durable disablement commands into the shared idempotency table. A collision
-- aborts the migration rather than choosing a result from two unrelated commands.
create temporary table identity_disablement_receipt_carry on commit drop as
select command_id, actor_identity_id, subject_identity_id, requested_at
from vortex_identity.identity_disablement_commands;
grant select on identity_disablement_receipt_carry to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;
insert into vortex_record.command_receipts (
  command_id, organization_id, tenant_id, actor_id, command_kind, result, created_at
)
select command_id, null, null, actor_identity_id, 'identity_disablement',
  pg_catalog.jsonb_build_object('subjectIdentityId', subject_identity_id), requested_at
from identity_disablement_receipt_carry;
reset role;
set local role vortex_owner;
alter table vortex_identity.identity_disablement_commands drop column command_fingerprint;
comment on table vortex_identity.identity_disablement_commands is
  'Private resumable state for environment-wide identity disablement: actor, subject, command identity and current outcome; it contains no credential, token, address or profile.';
drop function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, text, uuid);

create or replace function vortex_identity.begin_identity_disablement(
  p_actor_identity_id uuid,
  p_subject_identity_id uuid,
  p_command_id uuid,
  p_correlation_id uuid
)
returns table(outcome text, sessions_revoked integer, correlation_id uuid, subject_identity_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  existing vortex_identity.identity_disablement_commands%rowtype;
  claimed jsonb;
  original_subject_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_actor_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_subject_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or not vortex_platform.is_non_nil_uuid(p_correlation_id::text)
    or p_actor_identity_id is null or p_subject_identity_id is null
    or p_command_id is null or p_correlation_id is null then
    raise exception 'invalid identity disablement command' using errcode = '22023';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'identity_disablement', p_command_id, null, null, p_actor_identity_id,
    'Identity disablement command conflicts'
  );
  if claimed is null then
    if p_actor_identity_id = p_subject_identity_id then
      raise exception 'identity cannot disable itself' using errcode = 'V3191';
    end if;
    perform vortex_record.complete_scoped_command_receipt_internal(
      p_command_id, pg_catalog.jsonb_build_object('subjectIdentityId', p_subject_identity_id)
    );
    insert into vortex_identity.identity_disablement_commands (
      command_id, actor_identity_id, subject_identity_id,
      correlation_id, outcome, requested_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id,
      p_correlation_id, 'started', operation_at
    );
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event, recorded_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id, p_correlation_id,
      'started', operation_at
    );
    return query select 'started'::text, null::integer, p_correlation_id, p_subject_identity_id;
    return;
  end if;

  original_subject_id := (claimed ->> 'subjectIdentityId')::uuid;
  select recorded.* into strict existing
  from vortex_identity.identity_disablement_commands as recorded
  where recorded.command_id = p_command_id
  for update;
  if original_subject_id is distinct from existing.subject_identity_id
    or existing.actor_identity_id is distinct from p_actor_identity_id then
    raise exception 'identity disablement workflow state is inconsistent' using errcode = '55000';
  end if;
  if existing.outcome = 'disabled' then
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event, recorded_at
    ) values (
      p_command_id, existing.actor_identity_id, original_subject_id, p_correlation_id,
      'replayed', operation_at
    );
    return query select 'replayed'::text, existing.sessions_revoked,
      existing.correlation_id, original_subject_id;
    return;
  end if;

  update vortex_identity.identity_disablement_commands as recorded
  set outcome = 'started', completed_at = null, sessions_revoked = null,
      attempt_count = recorded.attempt_count + 1
  where recorded.command_id = p_command_id;
  insert into vortex_identity.identity_disablement_events (
    command_id, actor_identity_id, subject_identity_id, correlation_id, event, recorded_at
  ) values (
    p_command_id, existing.actor_identity_id, original_subject_id, p_correlation_id,
    'started', operation_at
  );
  return query select 'started'::text, null::integer, existing.correlation_id, original_subject_id;
end
$function$;

alter function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) owner to vortex_owner;
comment on function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) is
  'Starts or resumes the stored Identity Authority disablement subject, or replays its completed outcome.';
revoke all on function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) from public;
grant execute on function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) to vortex_runtime, postgres;

-- Preserve the original subject in existing super-administrator command results.
create temporary table super_administrator_assignment_carry on commit drop as
select assignment_id, identity_id from vortex_identity.vortex_super_administrator_assignments;
grant select on super_administrator_assignment_carry to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;
do $super_receipts$
begin
  if exists (
    select 1 from vortex_record.command_receipts as receipt
    where receipt.command_kind in (
      'vortex_super_administrator_bootstrap', 'vortex_super_administrator_grant',
      'vortex_super_administrator_revoke'
    ) and not exists (
      select 1 from super_administrator_assignment_carry as assignment
      where assignment.assignment_id::text = receipt.result ->> 'assignmentId'
    )
  ) then
    raise exception 'A super-administrator receipt has no assignment to preserve its identity';
  end if;
end
$super_receipts$;
update vortex_record.command_receipts as receipt
set result = (receipt.result - 'fingerprint') || pg_catalog.jsonb_build_object('identityId', assignment.identity_id)
from super_administrator_assignment_carry as assignment
where receipt.command_kind in (
    'vortex_super_administrator_bootstrap', 'vortex_super_administrator_grant',
    'vortex_super_administrator_revoke'
  ) and assignment.assignment_id::text = receipt.result ->> 'assignmentId';
reset role;
set local role vortex_owner;

create or replace function vortex_identity.bootstrap_vortex_super_administrator(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_identity_id uuid
)
returns table (
  outcome text,
  assignment_id uuid,
  identity_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  claimed jsonb;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text) then
    raise exception using errcode = '22023',
      message = 'Super-administrator bootstrap command is invalid';
  end if;

  perform vortex_access.require_platform_operator_internal(p_operator_actor_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
  );

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'vortex_super_administrator_bootstrap', p_duplicate_key, null, null, p_operator_actor_id,
    'Super-administrator bootstrap duplicate conflicts', 'V3143'
  );
  if claimed is not null then
    return query select 'replayed'::text, (claimed ->> 'assignmentId')::uuid,
      (claimed ->> 'identityId')::uuid, (claimed ->> 'revision')::bigint,
      (claimed ->> 'correlationId')::uuid, (claimed ->> 'acceptedAt')::timestamptz;
    return;
  end if;

  perform 1
  from vortex_identity.identity_projections as identity
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
  for share;
  if not found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator identity is unavailable';
  end if;

  perform 1
  from vortex_identity.vortex_super_administrator_assignments as assignment
  for update;
  if found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator bootstrap is available only for the first assignment';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  insert into vortex_identity.vortex_super_administrator_assignments (
    assignment_id, identity_id, revision, granted_at, granted_by_kind,
    granted_by_id, grant_correlation_id, changed_at, changed_by_kind,
    changed_by_id, change_correlation_id
  ) values (
    new_assignment_id, p_identity_id, 1, evaluated_at,
    'configured_system_operator', p_operator_actor_id, new_correlation_id,
    evaluated_at, 'configured_system_operator', p_operator_actor_id,
    new_correlation_id
  );

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key, pg_catalog.jsonb_build_object(
      'identityId', p_identity_id, 'assignmentId', new_assignment_id, 'revision', 1,
      'correlationId', new_correlation_id, 'acceptedAt', evaluated_at
    )
  );

  return query select 'accepted'::text, new_assignment_id, p_identity_id,
    1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke all on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid)
  to vortex_runtime;

comment on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid) is
  'Bootstraps the first named super-administrator assignment through the existing configured system operator.';

alter function vortex_identity.bootstrap_vortex_super_administrator(p_operator_actor_id uuid, p_duplicate_key uuid, p_identity_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.bootstrap_vortex_super_administrator(p_operator_actor_id uuid, p_duplicate_key uuid, p_identity_id uuid) to postgres;


create or replace function vortex_identity.grant_vortex_super_administrator(
  p_duplicate_key uuid,
  p_identity_id uuid
)
returns table (
  outcome text,
  assignment_id uuid,
  identity_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  actor_identity_id uuid;
  claimed jsonb;
  active_assignment_id uuid;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text) then
    raise exception using errcode = '22023',
      message = 'Super-administrator grant command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
  );
  perform 1
  from vortex_identity.identity_projections as identity
  where identity.identity_id = actor_identity_id
    and identity.state = 'active'
  for share;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  select assignment.assignment_id into active_assignment_id
  from vortex_identity.vortex_super_administrator_assignments as assignment
  join vortex_identity.identity_projections as identity
    on identity.identity_id = assignment.identity_id
    and identity.state = 'active'
  where assignment.identity_id = actor_identity_id
    and assignment.revoked_at is null
  for share of assignment;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  if vortex_access.recent_authentication_deadline_internal(
    context_value, evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Multi-factor authentication is required for super-administrator changes';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'vortex_super_administrator_grant', p_duplicate_key, null, null, actor_identity_id,
    'Super-administrator grant duplicate conflicts', 'V3143'
  );
  if claimed is not null then
    return query select 'replayed'::text, (claimed ->> 'assignmentId')::uuid,
      (claimed ->> 'identityId')::uuid, (claimed ->> 'revision')::bigint,
      (claimed ->> 'correlationId')::uuid, (claimed ->> 'acceptedAt')::timestamptz;
    return;
  end if;

  perform 1
  from vortex_identity.identity_projections as identity
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
  for share;
  if not found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator identity is unavailable';
  end if;

  if exists (
    select 1
    from vortex_identity.vortex_super_administrator_assignments as assignment
    where assignment.identity_id = p_identity_id
      and assignment.revoked_at is null
  ) then
    raise exception using errcode = 'V3141',
      message = 'Identity already has an active super-administrator assignment';
  end if;

  insert into vortex_identity.vortex_super_administrator_assignments (
    assignment_id, identity_id, revision, granted_at, granted_by_kind,
    granted_by_id, grant_correlation_id, changed_at, changed_by_kind,
    changed_by_id, change_correlation_id
  ) values (
    new_assignment_id, p_identity_id, 1, evaluated_at, 'identity',
    actor_identity_id, new_correlation_id, evaluated_at, 'identity',
    actor_identity_id, new_correlation_id
  );

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key, pg_catalog.jsonb_build_object(
      'identityId', p_identity_id, 'assignmentId', new_assignment_id, 'revision', 1,
      'correlationId', new_correlation_id, 'acceptedAt', evaluated_at
    )
  );

  perform vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid, pg_catalog.gen_random_uuid(),
    evaluated_at, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'super_administrator_assignment_granted',
    array(
      select subject_id
      from pg_catalog.unnest(array[p_identity_id, new_assignment_id]) as subject(subject_id)
      order by subject_id
    ), '{}'::uuid[], coalesce(context_value ->> 'channel', 'web'),
    new_correlation_id, 'completed'
  );

  return query select 'accepted'::text, new_assignment_id, p_identity_id,
    1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke all on function vortex_identity.grant_vortex_super_administrator(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.grant_vortex_super_administrator(uuid, uuid)
  to vortex_runtime;

comment on function vortex_identity.grant_vortex_super_administrator(uuid, uuid) is
  'Grants a named super-administrator assignment through the live account-bound super-administrator context, with recent sign-in and immutable attribution.';

alter function vortex_identity.grant_vortex_super_administrator(p_duplicate_key uuid, p_identity_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.grant_vortex_super_administrator(p_duplicate_key uuid, p_identity_id uuid) to postgres;


create or replace function vortex_identity.revoke_vortex_super_administrator(
  p_duplicate_key uuid,
  p_assignment_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  assignment_id uuid,
  identity_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  actor_identity_id uuid;
  target_identity_id uuid;
  claimed jsonb;
  assignment_fact vortex_identity.vortex_super_administrator_assignments%rowtype;
  evaluated_at timestamptz;
  revoked_at_value timestamptz;
  resulting_revision bigint;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_assignment_id is null
    or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Super-administrator revocation command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
  );
  perform 1
  from vortex_identity.identity_projections as identity
  where identity.identity_id = actor_identity_id
    and identity.state = 'active'
  for share;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  perform 1
  from vortex_identity.vortex_super_administrator_assignments as assignment
  where assignment.identity_id = actor_identity_id
    and assignment.revoked_at is null
  for share;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  if vortex_access.recent_authentication_deadline_internal(
    context_value, evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Multi-factor authentication is required for super-administrator changes';
  end if;


  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'vortex_super_administrator_revoke', p_duplicate_key, null, null, actor_identity_id,
    'Super-administrator revocation duplicate conflicts', 'V3143'
  );
  if claimed is not null then
    return query select 'replayed'::text, (claimed ->> 'assignmentId')::uuid,
      (claimed ->> 'identityId')::uuid, (claimed ->> 'revision')::bigint,
      (claimed ->> 'correlationId')::uuid, (claimed ->> 'acceptedAt')::timestamptz;
    return;
  end if;

  select assignment.* into assignment_fact
  from vortex_identity.vortex_super_administrator_assignments as assignment
  where assignment.assignment_id = p_assignment_id
  for update;
  if not found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator assignment is unavailable';
  end if;
  target_identity_id := assignment_fact.identity_id;

  if assignment_fact.revoked_at is not null then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator assignment is already revoked';
  end if;
  if assignment_fact.revision <> p_expected_revision
    or assignment_fact.revision = 9007199254740991 then
    raise exception using errcode = 'V3102',
      message = 'Super-administrator assignment revision is stale';
  end if;

  revoked_at_value := evaluated_at;
  resulting_revision := assignment_fact.revision + 1;

  perform vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid, pg_catalog.gen_random_uuid(),
    evaluated_at, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'super_administrator_assignment_revoked',
    array(
      select subject_id
      from pg_catalog.unnest(array[target_identity_id, p_assignment_id]) as subject(subject_id)
      order by subject_id
    ), '{}'::uuid[], coalesce(context_value ->> 'channel', 'web'),
    new_correlation_id, 'completed'
  );

  update vortex_identity.vortex_super_administrator_assignments as assignment
  set revision = resulting_revision,
    changed_at = revoked_at_value,
    changed_by_kind = 'identity',
    changed_by_id = actor_identity_id,
    change_correlation_id = new_correlation_id,
    revoked_at = revoked_at_value,
    revoked_by_kind = 'identity',
    revoked_by_id = actor_identity_id,
    revocation_correlation_id = new_correlation_id
  where assignment.assignment_id = p_assignment_id;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key, pg_catalog.jsonb_build_object(
      'identityId', target_identity_id, 'assignmentId', p_assignment_id, 'revision', resulting_revision,
      'correlationId', new_correlation_id, 'acceptedAt', revoked_at_value
    )
  );

  return query select 'accepted'::text, p_assignment_id, target_identity_id,
    resulting_revision, new_correlation_id, revoked_at_value;
end
$function$;

revoke all on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint) is
  'Revokes a named super-administrator assignment through the live account-bound super-administrator context, with recent sign-in and exact revision evidence.';

alter function vortex_identity.revoke_vortex_super_administrator(p_duplicate_key uuid, p_assignment_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.revoke_vortex_super_administrator(p_duplicate_key uuid, p_assignment_id uuid, p_expected_revision bigint) to postgres;


-- Tenant lifecycle receipts previously used platform scope; retain their tenant scope
-- from the stored result before changing replay classification.
reset role;
set local role vortex_record_adapter;
do $tenant_receipts$
begin
  if exists (
    select 1 from vortex_record.command_receipts as receipt
    where receipt.command_kind in ('suspend_tenant', 'reactivate_tenant')
      and (receipt.organization_id is not null or receipt.tenant_id is not null
        or not coalesce(pg_catalog.pg_input_is_valid(receipt.result #>> '{subjectIds,0}', 'uuid'), false))
  ) then
    raise exception 'A tenant lifecycle receipt cannot preserve its original tenant scope';
  end if;
end
$tenant_receipts$;
update vortex_record.command_receipts as receipt
set tenant_id = (receipt.result #>> '{subjectIds,0}')::uuid,
  result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind in ('suspend_tenant', 'reactivate_tenant');
reset role;
set local role vortex_owner;
drop function vortex_identity.suspend_tenant(uuid, uuid, uuid, text, uuid, bigint);
drop function vortex_identity.reactivate_tenant(uuid, uuid, uuid, text, uuid, bigint);
drop function vortex_identity.apply_configured_tenant_lifecycle(text, uuid, uuid, uuid, text, uuid, bigint);

create or replace function vortex_identity.apply_configured_tenant_lifecycle(
  p_operation text,
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored record;
  claimed jsonb;
  initial_organization_ids uuid[];
  current_organization_ids uuid[];
  current_state text;
  current_revision bigint;
  current_state_changed_at timestamptz;
  required_source_state text;
  resulting_state text;
  resulting_revision bigint;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
  persisted_state_changed_at timestamptz;
begin
  if p_operation not in ('suspend_tenant', 'reactivate_tenant')
    or p_cluster_id is null
    or not vortex_platform.is_non_nil_uuid(p_cluster_id::text)
    or p_operator_actor_id is null
    or not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Configured tenant lifecycle command is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operator_actor_id::text || '|' || p_cluster_id::text || '|' ||
      p_operation || '|' || p_duplicate_key::text,
    30
  ));

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    p_operation, p_duplicate_key, null, p_tenant_id, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query select 'replayed'::text, p_operation, stored."subjectIds"[1],
      stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
    return;
  end if;

  select coalesce(
    pg_catalog.array_agg(organization.organization_id order by organization.organization_id),
    array[]::uuid[]
  ) into initial_organization_ids
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id;

  perform 1
  from vortex_access.organization_access_versions as governance
  where governance.organization_id = any(initial_organization_ids)
  order by governance.organization_id
  for update;

  select tenant.state, tenant.revision, tenant.state_changed_at
  into current_state, current_revision, current_state_changed_at
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  select coalesce(
    pg_catalog.array_agg(organization.organization_id order by organization.organization_id),
    array[]::uuid[]
  ) into current_organization_ids
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id;

  if current_organization_ids is distinct from initial_organization_ids then
    raise exception using errcode = 'V3102',
      message = 'Tenant organisation scope changed while the command waited';
  end if;

  if current_revision <> p_expected_revision
    or current_revision >= 9007199254740991 then
    raise exception using errcode = 'V3102',
      message = 'Tenant revision is stale';
  end if;

  case p_operation
    when 'suspend_tenant' then
      required_source_state := 'active';
      resulting_state := 'suspended';
    when 'reactivate_tenant' then
      required_source_state := 'suspended';
      resulting_state := 'active';
  end case;
  if current_state <> required_source_state then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  -- Authority readiness always uses a fresh observation after all scope locks.
  -- A future-skewed existing audit value is only clamped for persistence.
  evaluated_at := pg_catalog.clock_timestamp();
  persisted_state_changed_at := greatest(evaluated_at, current_state_changed_at);

  if p_operation = 'reactivate_tenant' then
    if (
        vortex_record.command_receipt_subject_exists_internal(
          'adopt_tenant', p_tenant_id, null, p_duplicate_key
        )
        or vortex_record.command_receipt_subject_exists_internal(
          'provision_tenant', null, p_tenant_id, p_duplicate_key
        )
      )
      and not vortex_identity.tenant_has_permanent_manager(
        p_tenant_id, evaluated_at
      ) then
      raise exception using errcode = 'V3002',
        message = 'Permanent tenant manager is required';
    end if;

    if exists (
      select 1
      from vortex_access.organization_stewardship_requirements as requirement
      join vortex_identity.organizations as organization
        on organization.organization_id = requirement.organization_id
      where organization.tenant_id = p_tenant_id
        and not vortex_access.organization_has_permanent_steward(
          requirement.organization_id, evaluated_at
        )
    ) then
      raise exception using errcode = 'V3002',
        message = 'Permanent organisation steward is required';
    end if;
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.tenants as tenant
  set state = resulting_state,
    state_changed_at = persisted_state_changed_at,
    revision = resulting_revision
  where tenant.tenant_id = p_tenant_id;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_tenant_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );

  return query select 'accepted'::text, p_operation, p_tenant_id,
    resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,uuid,bigint) to vortex_owner;

comment on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,uuid,bigint) is 'Private exact composition for configured-system tenant suspension and reactivation.';

alter function vortex_identity.apply_configured_tenant_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.apply_configured_tenant_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_identity.suspend_tenant(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_tenant_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, tenant_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_tenant_lifecycle(
    'suspend_tenant', p_cluster_id, p_operator_actor_id, p_duplicate_key,
    p_tenant_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.suspend_tenant(uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.suspend_tenant(uuid,uuid,uuid,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.suspend_tenant(uuid,uuid,uuid,uuid,bigint) is 'Configured-system-only non-cascading suspension of one active tenant.';

alter function vortex_identity.suspend_tenant(uuid,uuid,uuid,uuid,bigint) owner to vortex_owner;


create or replace function vortex_identity.reactivate_tenant(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_tenant_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, tenant_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_tenant_lifecycle(
    'reactivate_tenant', p_cluster_id, p_operator_actor_id, p_duplicate_key,
    p_tenant_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.reactivate_tenant(uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.reactivate_tenant(uuid,uuid,uuid,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.reactivate_tenant(uuid,uuid,uuid,uuid,bigint) is 'Configured-system-only reactivation of one stewardship-ready suspended tenant.';

alter function vortex_identity.reactivate_tenant(uuid,uuid,uuid,uuid,bigint) owner to vortex_owner;


-- Preserve the original subject and result of existing cluster identity commands.
reset role;
set local role vortex_record_adapter;
update vortex_record.command_receipts as receipt
set result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind in (
  'suspend_cluster_identity', 'reactivate_cluster_identity', 'close_cluster_identity'
);
reset role;
set local role vortex_owner;
drop function vortex_identity.suspend_cluster_identity(uuid, uuid, uuid, text, uuid, bigint);
drop function vortex_identity.reactivate_cluster_identity(uuid, uuid, uuid, text, uuid, bigint);
drop function vortex_identity.close_cluster_identity(uuid, uuid, uuid, text, uuid, bigint);
drop function vortex_identity.apply_configured_cluster_identity_lifecycle(text, uuid, uuid, uuid, text, uuid, bigint);

create or replace function vortex_identity.apply_configured_cluster_identity_lifecycle(
  p_operation text,
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_identity_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  identity_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored record;
  claimed jsonb;
  initial_organization_ids uuid[];
  current_organization_ids uuid[];
  initial_tenant_ids uuid[];
  current_tenant_ids uuid[];
  current_state text;
  current_revision bigint;
  current_changed_at timestamptz;
  required_source_state text;
  resulting_state text;
  resulting_revision bigint;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
  persisted_state_changed_at timestamptz;
begin
  if p_operation not in (
      'suspend_cluster_identity',
      'reactivate_cluster_identity',
      'close_cluster_identity'
    )
    or p_cluster_id is null
    or not vortex_platform.is_non_nil_uuid(p_cluster_id::text)
    or p_operator_actor_id is null
    or not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Cluster identity lifecycle command is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operator_actor_id::text || '|' || p_cluster_id::text || '|' ||
      p_operation || '|' || p_duplicate_key::text,
    30
  ));

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    p_operation, p_duplicate_key, null, null, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query select 'replayed'::text, p_operation, stored."subjectIds"[1],
      stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
    return;
  end if;

  select coalesce(
    pg_catalog.array_agg(distinct account.organization_id order by account.organization_id),
    array[]::uuid[]
  ) into initial_organization_ids
  from vortex_identity.organization_accounts as account
  where account.identity_id = p_identity_id;

  select coalesce(
    pg_catalog.array_agg(distinct affected.tenant_id order by affected.tenant_id),
    array[]::uuid[]
  ) into initial_tenant_ids
  from (
    select organization.tenant_id
    from vortex_identity.organization_accounts as account
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    where account.identity_id = p_identity_id
    union
    select assignment.tenant_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.identity_id = p_identity_id
  ) as affected;

  perform 1
  from vortex_access.organization_access_versions as governance
  where governance.organization_id = any(initial_organization_ids)
  order by governance.organization_id
  for update;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = any(initial_tenant_ids)
  order by tenant.tenant_id
  for update;

  select projection.state, projection.revision, projection.state_changed_at
  into current_state, current_revision, current_changed_at
  from vortex_identity.identity_projections as projection
  where projection.identity_id = p_identity_id
  for update;
  if not found then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  select coalesce(
    pg_catalog.array_agg(distinct account.organization_id order by account.organization_id),
    array[]::uuid[]
  ) into current_organization_ids
  from vortex_identity.organization_accounts as account
  where account.identity_id = p_identity_id;

  select coalesce(
    pg_catalog.array_agg(distinct affected.tenant_id order by affected.tenant_id),
    array[]::uuid[]
  ) into current_tenant_ids
  from (
    select organization.tenant_id
    from vortex_identity.organization_accounts as account
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    where account.identity_id = p_identity_id
    union
    select assignment.tenant_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.identity_id = p_identity_id
  ) as affected;

  if current_organization_ids is distinct from initial_organization_ids
    or current_tenant_ids is distinct from initial_tenant_ids then
    raise exception using errcode = 'V3102',
      message = 'Cluster identity scope changed while the command waited';
  end if;

  if current_revision <> p_expected_revision
    or current_revision >= 9007199254740991 then
    raise exception using errcode = 'V3102',
      message = 'Identity projection revision is stale';
  end if;

  case p_operation
    when 'suspend_cluster_identity' then
      required_source_state := 'active';
      resulting_state := 'suspended';
    when 'reactivate_cluster_identity' then
      required_source_state := 'suspended';
      resulting_state := 'active';
    when 'close_cluster_identity' then
      if current_state not in ('active', 'suspended') then
        raise exception using errcode = 'V3003',
          message = 'Administration scope is unavailable';
      end if;
      resulting_state := 'closed';
  end case;
  if required_source_state is not null and current_state <> required_source_state then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  -- Eligibility is always evaluated against a fresh database observation made
  -- after every governance and projection lock. A future-skewed audit value is
  -- compatible with the projection trigger, but never grants future authority.
  evaluated_at := pg_catalog.clock_timestamp();
  persisted_state_changed_at := greatest(evaluated_at, current_changed_at);
  resulting_revision := current_revision + 1;
  update vortex_identity.identity_projections as projection
  set state = resulting_state,
    state_changed_at = persisted_state_changed_at,
    state_changed_by = p_operator_actor_id,
    state_change_correlation_id = new_correlation_id,
    revision = resulting_revision
  where projection.identity_id = p_identity_id;

  if exists (
    select 1
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = any(current_organization_ids)
      and not vortex_access.organization_has_permanent_steward(
        requirement.organization_id, evaluated_at
      )
  ) then
    raise exception using errcode = 'V3002',
      message = 'Permanent organisation steward is required';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(current_tenant_ids) as affected(tenant_id)
    where (
        vortex_record.command_receipt_subject_exists_internal(
          'adopt_tenant', affected.tenant_id, null, p_duplicate_key
        )
        or vortex_record.command_receipt_subject_exists_internal(
          'provision_tenant', null, affected.tenant_id, p_duplicate_key
        )
      )
      and not vortex_identity.tenant_has_permanent_manager(
        affected.tenant_id, evaluated_at
      )
  ) then
    raise exception using errcode = 'V3002',
      message = 'Permanent tenant manager is required';
  end if;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_identity_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );

  return query select 'accepted'::text, p_operation, p_identity_id,
    resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,uuid,bigint) to vortex_owner;

comment on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,uuid,bigint) is 'Private exact composition for the three configured-system cluster-local identity lifecycle commands.';

alter function vortex_identity.apply_configured_cluster_identity_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_identity_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_identity_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_identity.suspend_cluster_identity(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_identity_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, identity_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_cluster_identity_lifecycle(
    'suspend_cluster_identity', p_cluster_id, p_operator_actor_id,
    p_duplicate_key, p_identity_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,uuid,bigint) is 'Configured-system-only suspension of one cluster-local identity projection.';

alter function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,uuid,bigint) owner to vortex_owner;


create or replace function vortex_identity.reactivate_cluster_identity(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_identity_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, identity_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_cluster_identity_lifecycle(
    'reactivate_cluster_identity', p_cluster_id, p_operator_actor_id,
    p_duplicate_key, p_identity_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,uuid,bigint) is 'Configured-system-only reactivation of one cluster-local identity projection.';

alter function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,uuid,bigint) owner to vortex_owner;


create or replace function vortex_identity.close_cluster_identity(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_identity_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, identity_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_cluster_identity_lifecycle(
    'close_cluster_identity', p_cluster_id, p_operator_actor_id,
    p_duplicate_key, p_identity_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.close_cluster_identity(uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.close_cluster_identity(uuid,uuid,uuid,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.close_cluster_identity(uuid,uuid,uuid,uuid,bigint) is 'Configured-system-only terminal closure of one cluster-local identity projection.';

alter function vortex_identity.close_cluster_identity(uuid,uuid,uuid,uuid,bigint) owner to vortex_owner;


-- Retain the result of existing adoption and provisioning commands without input hashes.
reset role;
set local role vortex_record_adapter;
update vortex_record.command_receipts as receipt
set result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind in ('adopt_tenant', 'provision_tenant');
reset role;
set local role vortex_owner;
drop function vortex_identity.adopt_tenant(uuid, uuid, text, uuid, uuid);
drop function vortex_identity.provision_tenant(uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, text, text, text, text, text, text, text, text, text);

create or replace function vortex_identity.adopt_tenant(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_tenant_steward_identity_id uuid
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  tenant_administrator_assignment_id uuid,
  tenant_administrator_assignment_revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored record;
  claimed jsonb;
  tenant_revision bigint;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_assignment_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or not vortex_platform.is_non_nil_uuid(p_tenant_steward_identity_id::text) then
    raise exception using errcode = '22023', message = 'Tenant adoption input is invalid';
  end if;

  select tenant.revision into tenant_revision
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id and tenant.state = 'active'
  for update;
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'adopt_tenant', p_duplicate_key, null, p_tenant_id, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    select assignment.assignment_id into replay_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(stored."subjectIds");
    if replay_assignment_id is null then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'adopt_tenant'::text, p_tenant_id,
      replay_assignment_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_assignment_id)],
      stored."receiptId", stored."acceptedAt";
    return;
  end if;

  if exists (
    select 1
    where vortex_record.command_receipt_subject_exists_internal(
        'adopt_tenant', p_tenant_id, null, p_duplicate_key
      )
      or vortex_record.command_receipt_subject_exists_internal(
        'provision_tenant', null, p_tenant_id, p_duplicate_key
      )
  ) then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  perform 1 from vortex_identity.identity_projections as projection
  where projection.identity_id = p_tenant_steward_identity_id
    and projection.state = 'active'
  for update;
  if not found then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  if exists (
    select 1
    from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.state = 'active'
      and not vortex_access.organization_has_permanent_steward(
        organization.organization_id, operation_at
      )
  ) then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  insert into vortex_identity.tenant_administrator_assignments (
    assignment_id, tenant_id, identity_id, capability_keys, starts_at,
    expires_at, revision, granted_at, granted_by_actor_id,
    grant_correlation_id, changed_at, changed_by_actor_id, change_correlation_id
  ) values (
    new_assignment_id, p_tenant_id, p_tenant_steward_identity_id,
    array[
      'platform.tenant.administrators.manage',
      'platform.tenant.administrators.read',
      'platform.tenant.hierarchy.read',
      'platform.tenant.organizations.create',
      'platform.tenant.organizations.lifecycle',
      'platform.tenant.organizations.rename',
      'platform.tenant.organizations.reparent'
    ], operation_at, null, 1, operation_at, p_operator_actor_id,
    new_correlation_id, operation_at, p_operator_actor_id, new_correlation_id
  );

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values (p_tenant_id, tenant_revision), (new_assignment_id, 1::bigint))
    as result(subject_id, subject_revision);
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', operation_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions)
    )
  );
  return query select 'accepted'::text, 'adopt_tenant'::text, p_tenant_id,
    new_assignment_id, 1::bigint, new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.adopt_tenant(uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.adopt_tenant(uuid,uuid,uuid,uuid) to vortex_runtime;

comment on function vortex_identity.adopt_tenant(uuid,uuid,uuid,uuid) is 'Configured-system-only explicit tenant stewardship adoption; it creates no organisation authority.';

alter function vortex_identity.adopt_tenant(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_tenant_steward_identity_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.adopt_tenant(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_tenant_steward_identity_id uuid) to postgres;


create or replace function vortex_identity.provision_tenant(
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_tenant_short_name text,
  p_tenant_display_name text,
  p_organization_short_name text,
  p_organization_display_name text,
  p_tenant_steward_identity_id uuid,
  p_organization_steward_identity_id uuid,
  p_account_display_name text,
  p_account_language text,
  p_account_time_zone text,
  p_runtime_language text,
  p_runtime_time_zone text,
  p_runtime_currency text,
  p_runtime_date_format text,
  p_runtime_number_format text,
  p_storage_project text
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  root_organization_id uuid,
  tenant_administrator_assignment_id uuid,
  tenant_administrator_assignment_revision bigint,
  organization_account_id uuid,
  organization_account_revision bigint,
  access_version bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored record;
  claimed jsonb;
  new_tenant_id uuid := pg_catalog.gen_random_uuid();
  new_organization_id uuid := pg_catalog.gen_random_uuid();
  new_tenant_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_account_id uuid := pg_catalog.gen_random_uuid();
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_group_id uuid := pg_catalog.gen_random_uuid();
  new_membership_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_tenant_id uuid;
  replay_organization_id uuid;
  replay_assignment_id uuid;
  replay_account_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_cluster_id::text)
    or not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text) then
    raise exception using errcode = '22023', message = 'Tenant provisioning input is invalid';
  end if;

  -- The new tenant has no row to lock yet. This lock is limited to one trusted
  -- actor/cluster/duplicate tuple and exists only to converge simultaneous retry.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operator_actor_id::text || '|' || p_cluster_id::text || '|provision_tenant|' ||
      p_duplicate_key::text,
    30
  ));

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'provision_tenant', p_duplicate_key, null, null, p_operator_actor_id,
    'Administration duplicate conflicts'
  );

  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    select tenant.tenant_id into replay_tenant_id
    from vortex_identity.tenants as tenant
    where tenant.tenant_id = any(stored."subjectIds");
    select organization.organization_id into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored."subjectIds");
    select assignment.assignment_id into replay_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(stored."subjectIds");
    select account.organization_account_id into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(stored."subjectIds");
    if replay_tenant_id is null or replay_organization_id is null
      or replay_assignment_id is null or replay_account_id is null then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'provision_tenant'::text,
      replay_tenant_id, replay_organization_id, replay_assignment_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_assignment_id)],
      replay_account_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_account_id)],
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_organization_id)],
      stored."receiptId", stored."acceptedAt";
    return;
  end if;

  if p_storage_project is null or p_storage_project !~ '^[a-z0-9][a-z0-9-]{0,119}$' then
    raise exception using errcode = '22023', message = 'Storage destination is invalid';
  end if;
  insert into vortex_platform.storage_destination(singleton, project_ref)
  values (true, p_storage_project) on conflict (singleton) do nothing;
  if not exists (select 1 from vortex_platform.storage_destination where singleton and project_ref = p_storage_project) then
    raise exception using errcode = '55000', message = 'Storage destination differs from the provisioned project';
  end if;
  if vortex_identity.tenant_short_name_reserved(p_tenant_short_name) then
    raise exception using errcode = 'V3190', message = 'Tenant short name is reserved for a platform route';
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    p_runtime_language, p_runtime_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );
  -- Reuse the organisation runtime settings language/time-zone validators for account preferences.
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_account_language, p_account_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );

  begin
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by,
      state_changed_at, revision
    ) values (
      new_tenant_id, p_tenant_short_name, p_tenant_display_name, 'active',
      operation_at, p_operator_actor_id, operation_at, 1
    );
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name,
      display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      new_organization_id, new_tenant_id, null, p_organization_short_name,
      p_organization_display_name, 'active', operation_at,
      p_operator_actor_id, operation_at, 1
    );
  exception when unique_violation then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end;

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    (p_tenant_steward_identity_id, 'active', operation_at, operation_at,
      p_operator_actor_id, new_correlation_id, 1),
    (p_organization_steward_identity_id, 'active', operation_at, operation_at,
      p_operator_actor_id, new_correlation_id, 1)
  on conflict on constraint identity_projections_pk do nothing;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id in (
      p_tenant_steward_identity_id, p_organization_steward_identity_id
    ) and projection.state = 'active'
  order by projection.identity_id
  for update;
  if (select pg_catalog.count(distinct projection.identity_id)
      from vortex_identity.identity_projections as projection
      where projection.identity_id in (
        p_tenant_steward_identity_id, p_organization_steward_identity_id
      ) and projection.state = 'active') <>
     (select pg_catalog.count(distinct identity_id)
      from (values (p_tenant_steward_identity_id),
                   (p_organization_steward_identity_id)) as nominated(identity_id)) then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, language, time_zone, activated_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    new_account_id, new_organization_id, p_organization_steward_identity_id,
    p_account_display_name, 'active', p_account_language, p_account_time_zone,
    operation_at, operation_at, operation_at, p_operator_actor_id,
    new_correlation_id, 1
  );

  perform 1 from vortex_identity.initialize_organization_runtime_settings(
    new_organization_id, p_runtime_language, p_runtime_time_zone,
    p_runtime_currency, p_runtime_date_format, p_runtime_number_format
  );
  perform 1 from vortex_access.initialize_organization_access_version(
    new_organization_id, p_operator_actor_id, new_correlation_id
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    new_organization_id, p_operator_actor_id, new_correlation_id
  );

  insert into vortex_identity.tenant_administrator_assignments (
    assignment_id, tenant_id, identity_id, capability_keys, starts_at,
    expires_at, revision, granted_at, granted_by_actor_id,
    grant_correlation_id, changed_at, changed_by_actor_id, change_correlation_id
  ) values (
    new_tenant_assignment_id, new_tenant_id, p_tenant_steward_identity_id,
    array[
      'platform.tenant.administrators.manage',
      'platform.tenant.administrators.read',
      'platform.tenant.hierarchy.read',
      'platform.tenant.organizations.create',
      'platform.tenant.organizations.lifecycle',
      'platform.tenant.organizations.rename',
      'platform.tenant.organizations.reparent'
    ], operation_at, null, 1, operation_at, p_operator_actor_id,
    new_correlation_id, operation_at, p_operator_actor_id, new_correlation_id
  );

  select adopted.access_version into resulting_access_version
  from vortex_access.coordinate_organization_stewardship_adoption(
    new_organization_id, new_account_id, new_role_id, 'organization_steward',
    'Organisation steward', 'Permanent minimum organisation administration.',
    new_role_assignment_id, new_delegation_id, p_operator_actor_id,
    new_correlation_id
  ) as adopted;

  -- The first owner needs a real current Group for Group-owned records. Access
  -- owns both facts and their version; no application-specific permission is added.
  perform 1 from vortex_access.coordinate_organization_group_change(
    'create_group', new_organization_id, new_group_id, null,
    'organisation_owners', 'Organisation owners', new_account_id,
    new_correlation_id
  );
  select changed.access_version into resulting_access_version
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', new_organization_id, new_membership_id, null,
    new_group_id, new_account_id, operation_at, null, null,
    new_account_id, new_correlation_id
  ) as changed;

  -- The role revision check trigger is deferred. Validate it while the privileged
  -- boundary is still active so a runtime-role commit cannot bypass or fail its reads.
  set constraints
    vortex_access.organization_role_revisions_checked
    immediate;
  set constraints
    vortex_access.organization_role_revisions_checked
    deferred;

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values
    (new_tenant_id, 1::bigint),
    (new_organization_id, resulting_access_version),
    (new_tenant_assignment_id, 1::bigint),
    (new_account_id, 1::bigint)
  ) as result(subject_id, subject_revision);

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', operation_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions)
    )
  );

  return query select 'accepted'::text, 'provision_tenant'::text,
    new_tenant_id, new_organization_id, new_tenant_assignment_id, 1::bigint,
    new_account_id, 1::bigint, resulting_access_version,
    new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text, text
) to vortex_runtime;
comment on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text, text
) is 'Configured-system-only atomic tenant/root-organisation provisioning with separate explicit tenant and organisation steward nominations and an initial current owner Group membership for the organisation steward.';

alter function vortex_identity.provision_tenant(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_short_name text, p_tenant_display_name text, p_organization_short_name text, p_organization_display_name text, p_tenant_steward_identity_id uuid, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text, p_storage_project text) owner to vortex_owner;

grant execute on function vortex_identity.provision_tenant(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_short_name text, p_tenant_display_name text, p_organization_short_name text, p_organization_display_name text, p_tenant_steward_identity_id uuid, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text, p_storage_project text) to postgres;


-- The tenant administrator receipts already carry the original assignment.
reset role;
set local role vortex_record_adapter;
update vortex_record.command_receipts as receipt
set result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind in (
  'grant_tenant_administrator', 'change_tenant_administrator', 'revoke_tenant_administrator'
);
reset role;
set local role vortex_owner;
drop function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz);
drop function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz);
drop function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint);

create or replace function vortex_identity.grant_tenant_administrator(
  p_duplicate_key uuid,
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
  expiry_cap timestamptz;
  evaluated_at timestamptz;
  actor_identity_id uuid;
  stored record;
  claimed jsonb;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_subject_identity_id is null or not vortex_platform.is_non_nil_uuid(p_subject_identity_id::text)
    or capabilities is null
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'grant_tenant_administrator', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query select 'replayed'::text, 'grant_tenant_administrator'::text,
      stored."subjectIds"[1], stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
    return;
  end if;
  if p_subject_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  if not exists (
      select 1 from vortex_identity.identity_projections p
      where p.identity_id = p_subject_identity_id and p.state = 'active'
    ) or exists (
      select 1 from pg_catalog.unnest(capabilities) c
      where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          actor_identity_id, evaluated_at
        ) is null
        and not exists (
          select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and (
            c = any(a.capability_keys)
            or c = 'platform.tenant.capability_limits.read'
          )
      )
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[new_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[1::bigint])
    )
  );
  return query select 'accepted'::text, 'grant_tenant_administrator'::text,
    new_assignment_id, 1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.grant_tenant_administrator(uuid, uuid, uuid, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.grant_tenant_administrator(uuid, uuid, uuid, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.grant_tenant_administrator(uuid, uuid, uuid, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator grant under the bound request context person''s current structural authority, with self-grant refusal, grantor-bounded expiry and accepted replay.';

alter function vortex_identity.grant_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_subject_identity_id uuid, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) owner to vortex_owner;

grant execute on function vortex_identity.grant_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_subject_identity_id uuid, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) to postgres;


create or replace function vortex_identity.change_tenant_administrator(
  p_duplicate_key uuid,
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
  expiry_cap timestamptz;
  evaluated_at timestamptz;
  actor_identity_id uuid;
  target_identity_id uuid;
  current_revision bigint;
  current_revoked_at timestamptz;
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;
  select a.revision, a.revoked_at into current_revision, current_revoked_at
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'change_tenant_administrator', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query select 'replayed'::text, 'change_tenant_administrator'::text,
      stored."subjectIds"[1], stored."subjectRevisions"[1], stored."receiptId",
      stored."acceptedAt";
    return;
  end if;
  if target_identity_id is null or not exists (
      select 1 from vortex_identity.identity_projections p
      where p.identity_id = target_identity_id and p.state = 'active'
    ) or exists (
      select 1 from pg_catalog.unnest(capabilities) c
      where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          actor_identity_id, evaluated_at
        ) is null
        and not exists (
          select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and (
            c = any(a.capability_keys)
            or c = 'platform.tenant.capability_limits.read'
          )
      )
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if target_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );
  return query select 'accepted'::text, 'change_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.change_tenant_administrator(uuid, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.change_tenant_administrator(uuid, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.change_tenant_administrator(uuid, uuid, uuid, bigint, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator change under the bound request context person''s current structural authority, with self-grant refusal, grantor-bounded expiry, exact revision and accepted replay.';

alter function vortex_identity.change_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) owner to vortex_owner;

grant execute on function vortex_identity.change_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) to postgres;


create or replace function vortex_identity.revoke_tenant_administrator(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_expected_revision bigint
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  target_identity_id uuid;
  current_revision bigint;
  current_revoked_at timestamptz;
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
 then
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;
  select a.revision, a.revoked_at into current_revision, current_revoked_at
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_tenant_administrator', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query select 'replayed'::text, 'revoke_tenant_administrator'::text,
      stored."subjectIds"[1], stored."subjectRevisions"[1], stored."receiptId",
      stored."acceptedAt";
    return;
  end if;
  if current_revision is null or current_revoked_at is not null then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Tenant assignment revision is stale';
  end if;
  if not vortex_identity.tenant_has_permanent_manager(
    p_tenant_id, evaluated_at, p_assignment_id
  ) then
    raise exception using errcode = 'V3103', message = 'Permanent tenant manager is required';
  end if;
  resulting_revision := current_revision + 1;
  update vortex_identity.tenant_administrator_assignments
  set revision = resulting_revision, changed_at = evaluated_at,
    changed_by_actor_id = actor_identity_id,
    change_correlation_id = new_correlation_id, revoked_at = evaluated_at,
    revoked_by_actor_id = actor_identity_id,
    revocation_correlation_id = new_correlation_id
  where tenant_administrator_assignments.assignment_id = p_assignment_id;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );
  return query select 'accepted'::text, 'revoke_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.revoke_tenant_administrator(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.revoke_tenant_administrator(uuid, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.revoke_tenant_administrator(uuid, uuid, uuid, bigint) is
  'Protected same-tenant tenant-administrator revocation under the bound request context person''s current structural authority, with permanent-manager preservation, exact revision and accepted replay.';

alter function vortex_identity.revoke_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.revoke_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) to postgres;


-- Organisation governance receipts were tenant-scoped. Recover the exact
-- organisation from each stored subject set, failing if it cannot be mapped.
create temporary table organization_receipt_scope_carry on commit drop as
select organization_id, tenant_id from vortex_identity.organizations;
grant select on organization_receipt_scope_carry to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;
do $organization_receipts$
declare
  bad_command uuid;
begin
  select receipt.command_id into bad_command
  from vortex_record.command_receipts as receipt
  where receipt.command_kind in (
      'archive_tenant_organization', 'reactivate_tenant_organization',
      'suspend_tenant_organization', 'rename_tenant_organization',
      'reparent_tenant_organization', 'adopt_organization'
    ) and (receipt.organization_id is not null or (
      select count(*) from organization_receipt_scope_carry as organization
      where organization.tenant_id = receipt.tenant_id
        and receipt.result -> 'subjectIds' @> pg_catalog.to_jsonb(array[organization.organization_id])
    ) <> 1)
  order by receipt.command_id limit 1;
  if bad_command is not null then
    raise exception 'Organisation scope cannot be recovered for command %', bad_command;
  end if;
end
$organization_receipts$;
update vortex_record.command_receipts as receipt
set organization_id = organization.organization_id,
  result = receipt.result - 'fingerprint' - 'clusterId'
from organization_receipt_scope_carry as organization
where receipt.command_kind in (
    'archive_tenant_organization', 'reactivate_tenant_organization',
    'suspend_tenant_organization', 'rename_tenant_organization',
    'reparent_tenant_organization', 'adopt_organization'
  ) and organization.tenant_id = receipt.tenant_id
  and receipt.result -> 'subjectIds' @> pg_catalog.to_jsonb(array[organization.organization_id]);
reset role;
set local role vortex_owner;
drop function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint);
drop function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint);
drop function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint);
drop function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text);
drop function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid);
drop function vortex_identity.adopt_organization(uuid, uuid, text, uuid, uuid, uuid, uuid);

create or replace function vortex_identity.archive_tenant_organization(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  current_state text;
  stored record;
  claimed jsonb;
  target_access_found boolean;
  target_organization_found boolean;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation archive command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  where version.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update of version;
  target_access_found := found;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  select organization.revision, organization.state
  into current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  target_organization_found := found;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.lifecycle',
    evaluated_at
  );
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'archive_tenant_organization', p_duplicate_key, p_organization_id, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query
    select 'replayed'::text,
      'archive_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  if not target_access_found or not target_organization_found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  if current_revision <> p_expected_revision
    or current_revision = 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if current_state not in ('active', 'suspended')
    or exists (
      select 1
      from vortex_identity.organizations as child
      where child.tenant_id = p_tenant_id
        and child.parent_organization_id = p_organization_id
        and child.state in ('active', 'suspended')
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations as organization
  set state = 'archived',
    state_changed_at = evaluated_at,
    revision = resulting_revision
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );

  return query
  select 'accepted'::text,
    'archive_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.archive_tenant_organization(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.archive_tenant_organization(uuid, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.archive_tenant_organization(uuid, uuid, uuid, bigint) is
  'Protected terminal organisation archive with no unresolved direct child, under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.archive_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.archive_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_identity.reactivate_tenant_organization(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_parent_id uuid;
  current_revision bigint;
  current_state text;
  parent_state text;
  stored record;
  claimed jsonb;
  target_access_found boolean;
  target_organization_found boolean;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation reactivation command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  where version.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update of version;
  target_access_found := found;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  select organization.parent_organization_id,
    organization.revision, organization.state
  into current_parent_id, current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  target_organization_found := found;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.lifecycle',
    evaluated_at
  );
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'reactivate_tenant_organization', p_duplicate_key, p_organization_id, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query
    select 'replayed'::text,
      'reactivate_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  if not target_access_found or not target_organization_found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  if current_revision <> p_expected_revision
    or current_revision = 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if current_state <> 'suspended' then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  if current_parent_id is not null then
    select parent.state
    into parent_state
    from vortex_identity.organizations as parent
    where parent.tenant_id = p_tenant_id
      and parent.organization_id = current_parent_id;
    if not found or parent_state in ('archived', 'removal_pending') then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
  end if;

  if not exists (
      select 1
      from vortex_access.organization_stewardship_requirements as requirement
      where requirement.organization_id = p_organization_id
    )
    or not vortex_access.organization_has_permanent_steward(
      p_organization_id, evaluated_at
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations as organization
  set state = 'active',
    state_changed_at = evaluated_at,
    revision = resulting_revision
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );

  return query
  select 'accepted'::text,
    'reactivate_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.reactivate_tenant_organization(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.reactivate_tenant_organization(uuid, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.reactivate_tenant_organization(uuid, uuid, uuid, bigint) is
  'Protected stewardship-ready suspended-to-active organisation transition under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.reactivate_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.reactivate_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_identity.suspend_tenant_organization(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  current_state text;
  stored record;
  claimed jsonb;
  target_access_found boolean;
  target_organization_found boolean;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation suspension command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  where version.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update of version;
  target_access_found := found;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  select organization.revision, organization.state
  into current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  target_organization_found := found;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.lifecycle',
    evaluated_at
  );
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'suspend_tenant_organization', p_duplicate_key, p_organization_id, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query
    select 'replayed'::text,
      'suspend_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  if not target_access_found or not target_organization_found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  if current_revision <> p_expected_revision
    or current_revision = 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if current_state <> 'active' then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations as organization
  set state = 'suspended',
    state_changed_at = evaluated_at,
    revision = resulting_revision
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );

  return query
  select 'accepted'::text,
    'suspend_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.suspend_tenant_organization(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.suspend_tenant_organization(uuid, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.suspend_tenant_organization(uuid, uuid, uuid, bigint) is
  'Protected non-cascading active-to-suspended organisation transition under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.suspend_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.suspend_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_identity.rename_tenant_organization(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint,
  p_display_name text
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_display_name is null
    or p_display_name <> pg_catalog.btrim(p_display_name)
    or pg_catalog.char_length(p_display_name) not between 1 and 120 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation rename command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.rename',
    evaluated_at
  );
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'rename_tenant_organization', p_duplicate_key, p_organization_id, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query
    select 'replayed'::text,
      'rename_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  select organization.revision
  into current_revision
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations
  set display_name = p_display_name,
    revision = resulting_revision
  where organizations.tenant_id = p_tenant_id
    and organizations.organization_id = p_organization_id;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );

  return query
  select 'accepted'::text,
    'rename_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.rename_tenant_organization(uuid, uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.rename_tenant_organization(uuid, uuid, uuid, bigint, text)
  to vortex_runtime;

comment on function vortex_identity.rename_tenant_organization(uuid, uuid, uuid, bigint, text) is
  'Protected same-tenant display-name-only organisation rename under the bound request context person''s current structural authority, exact revision and accepted replay.';

alter function vortex_identity.rename_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_display_name text) owner to vortex_owner;

grant execute on function vortex_identity.rename_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_display_name text) to postgres;


create or replace function vortex_identity.reparent_tenant_organization(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint,
  p_parent_organization_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  current_state text;
  parent_state text;
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or (
      p_parent_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_parent_organization_id::text)
    ) then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation reparent command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.reparent',
    evaluated_at
  );
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'reparent_tenant_organization', p_duplicate_key, p_organization_id, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query
    select 'replayed'::text,
      'reparent_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  select organization.revision, organization.state
  into current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if p_parent_organization_id = p_organization_id then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if p_parent_organization_id is not null then
    select parent.state
    into parent_state
    from vortex_identity.organizations as parent
    where parent.tenant_id = p_tenant_id
      and parent.organization_id = p_parent_organization_id;
    if not found
      or (
        current_state in ('active', 'suspended')
        and parent_state in ('archived', 'removal_pending')
      ) then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations
  set parent_organization_id = p_parent_organization_id,
    revision = resulting_revision
  where organizations.tenant_id = p_tenant_id
    and organizations.organization_id = p_organization_id;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );

  return query
  select 'accepted'::text,
    'reparent_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.reparent_tenant_organization(uuid, uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.reparent_tenant_organization(uuid, uuid, uuid, bigint, uuid)
  to vortex_runtime;

comment on function vortex_identity.reparent_tenant_organization(uuid, uuid, uuid, bigint, uuid) is
  'Protected same-tenant adjacency-link-only organisation move under the bound request context person''s current structural authority, exact revision and accepted replay.';

alter function vortex_identity.reparent_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_parent_organization_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.reparent_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_parent_organization_id uuid) to postgres;


create or replace function vortex_identity.adopt_organization(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_steward_identity_id uuid,
  p_organization_account_id uuid
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored record;
  claimed jsonb;
  requirement vortex_access.organization_stewardship_requirements%rowtype;
  account_revision bigint;
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  authoritative_tenant_id uuid;
  authoritative_organization_id uuid;
  authoritative_account_id uuid;
  replay_account_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_steward_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text) then
    raise exception using errcode = '22023', message = 'Organization adoption input is invalid';
  end if;

  -- Keep Access before Identity without creating state or refusing a replay.
  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  where version.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update of version;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'adopt_organization', p_duplicate_key, p_organization_id, p_tenant_id, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    select account.organization_account_id into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = any(stored."subjectIds");
    if replay_account_id is null then
      raise exception using errcode = '55000', message = 'Stored adoption result is unavailable';
    end if;
    return query select 'replayed'::text, 'adopt_organization'::text,
      p_tenant_id, p_organization_id, replay_account_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", p_organization_id)],
      stored."receiptId", stored."acceptedAt";
    return;
  end if;

  -- This is deliberately an unlocked eligibility probe. Existing request
  -- resolution locks Access first and then authoritatively locks Identity, so
  -- adoption must follow that same order.
  perform 1
  from vortex_identity.organizations as organization
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where organization.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
    and organization.state = 'active'
    and tenant.state = 'active';
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  perform 1 from vortex_access.initialize_organization_access_version(
    p_organization_id, p_operator_actor_id, new_correlation_id
  );
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;


  if exists (
    select 1
    where vortex_record.command_receipt_subject_exists_internal(
      'adopt_organization', p_tenant_id, p_organization_id, p_duplicate_key
    )
  ) then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    p_organization_id, p_operator_actor_id, new_correlation_id
  );

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id, account.revision
  into authoritative_tenant_id, authoritative_organization_id,
    authoritative_account_id, account_revision
  from vortex_identity.resolve_active_organization_account(
    p_steward_identity_id, p_organization_id
  ) as scope
  join vortex_identity.organization_accounts as account
    on account.organization_account_id = scope.organization_account_id;
  if not found or authoritative_account_id is distinct from p_organization_account_id then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;
  if authoritative_tenant_id is distinct from p_tenant_id
    or authoritative_organization_id is distinct from p_organization_id then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  select current_requirement.* into requirement
  from vortex_access.organization_stewardship_requirements as current_requirement
  where current_requirement.organization_id = p_organization_id
  for update;
  if found then
    if requirement.original_organization_account_id <> p_organization_account_id then
      raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
    end if;
    select adopted.access_version into resulting_access_version
    from vortex_access.coordinate_organization_stewardship_adoption(
      p_organization_id, p_organization_account_id,
      requirement.original_role_id, 'organization_steward',
      'Organisation steward', 'Permanent minimum organisation administration.',
      requirement.original_role_assignment_id,
      requirement.original_delegation_authority_id,
      requirement.adopted_by, requirement.adoption_correlation_id
    ) as adopted;
  else
    select adopted.access_version into resulting_access_version
    from vortex_access.coordinate_organization_stewardship_adoption(
      p_organization_id, p_organization_account_id, new_role_id,
      'organization_steward', 'Organisation steward',
      'Permanent minimum organisation administration.',
      new_role_assignment_id, new_delegation_id, p_operator_actor_id,
      new_correlation_id
    ) as adopted;
  end if;

  -- The role revision check trigger is deferred. Validate it while the privileged
  -- boundary is still active so a runtime-role commit cannot bypass or fail its reads.
  set constraints
    vortex_access.organization_role_revisions_checked
    immediate;
  set constraints
    vortex_access.organization_role_revisions_checked
    deferred;

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values
    (p_organization_id, resulting_access_version),
    (p_organization_account_id, account_revision)
  ) as result(subject_id, subject_revision);
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', operation_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions)
    )
  );
  return query select 'accepted'::text, 'adopt_organization'::text,
    p_tenant_id, p_organization_id, p_organization_account_id,
    resulting_access_version, new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.adopt_organization(uuid,uuid,uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.adopt_organization(uuid,uuid,uuid,uuid,uuid,uuid) to vortex_runtime;

comment on function vortex_identity.adopt_organization(uuid,uuid,uuid,uuid,uuid,uuid) is 'Configured-system-only explicit organisation stewardship adoption through the existing Access coordinator.';

alter function vortex_identity.adopt_organization(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_steward_identity_id uuid, p_organization_account_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.adopt_organization(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_steward_identity_id uuid, p_organization_account_id uuid) to postgres;


-- Organisation creation stays tenant-scoped; its stored subject set supplies the result.
reset role;
set local role vortex_record_adapter;
update vortex_record.command_receipts as receipt
set result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind = 'create_tenant_organization';
reset role;
set local role vortex_owner;
drop function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text);

create or replace function vortex_identity.create_tenant_organization(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_parent_organization_id uuid,
  p_organization_short_name text,
  p_organization_display_name text,
  p_organization_steward_identity_id uuid,
  p_account_display_name text,
  p_account_language text,
  p_account_time_zone text,
  p_runtime_language text,
  p_runtime_time_zone text,
  p_runtime_currency text,
  p_runtime_date_format text,
  p_runtime_number_format text
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  organization_revision bigint,
  organization_account_id uuid,
  organization_account_revision bigint,
  access_version bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  stored record;
  claimed jsonb;
  new_organization_id uuid := pg_catalog.gen_random_uuid();
  new_account_id uuid := pg_catalog.gen_random_uuid();
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_group_id uuid := pg_catalog.gen_random_uuid();
  new_membership_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_organization_id uuid;
  replay_account_id uuid;
  required_projection_count bigint;
  active_projection_count bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or (p_parent_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_parent_organization_id::text))
    or p_organization_steward_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_steward_identity_id::text)
    or p_organization_short_name is null
    or pg_catalog.char_length(p_organization_short_name) not between 1 and 40
    or p_organization_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_display_name is null
    or p_organization_display_name is distinct from pg_catalog.btrim(p_organization_display_name)
    or pg_catalog.char_length(p_organization_display_name) not between 1 and 120
    or p_account_display_name is null
    or p_account_display_name is distinct from pg_catalog.btrim(p_account_display_name)
    or pg_catalog.char_length(p_account_display_name) not between 1 and 120 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation creation command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  -- Tenant serialization converges duplicate and short-name races and keeps a
  -- parent lifecycle change from crossing this creation decision.
  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  -- Identity lifecycle writers use the same projection rows. Lock caller and
  -- nominee in stable order, but defer eligibility checks until after replay.
  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = any(array[
    actor_identity_id, p_organization_steward_identity_id
  ])
  order by projection.identity_id
  for share;

  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.create',
    evaluated_at
  );
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'create_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    select organization.organization_id
    into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored."subjectIds");
    select account.organization_account_id
    into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(stored."subjectIds");
    if replay_organization_id is null or replay_account_id is null then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
    return query
    select 'replayed'::text,
      'create_tenant_organization'::text,
      replay_organization_id,
      1::bigint,
      replay_account_id,
      stored."subjectRevisions"[
        pg_catalog.array_position(stored."subjectIds", replay_account_id)
      ],
      stored."subjectRevisions"[
        pg_catalog.array_position(stored."subjectIds", replay_organization_id)
      ],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    p_runtime_language, p_runtime_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_account_language, p_account_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );


  select pg_catalog.count(distinct nominated.identity_id)
  into required_projection_count
  from (values
    (actor_identity_id),
    (p_organization_steward_identity_id)
  ) as nominated(identity_id);
  select pg_catalog.count(distinct projection.identity_id)
  into active_projection_count
  from vortex_identity.identity_projections as projection
  where projection.identity_id = any(array[
    actor_identity_id, p_organization_steward_identity_id
  ])
    and projection.state = 'active';
  if active_projection_count <> required_projection_count then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  if p_parent_organization_id is not null
    and not exists (
      select 1
      from vortex_identity.organizations as parent
      where parent.tenant_id = p_tenant_id
        and parent.organization_id = p_parent_organization_id
        and parent.state in ('active', 'suspended')
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  -- Re-evaluate after all locks on existing facts. No creator membership or
  -- projection fallback is inferred from the tenant assignment.
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.create',
    evaluated_at
  );

  begin
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name,
      display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      new_organization_id, p_tenant_id, p_parent_organization_id,
      p_organization_short_name, p_organization_display_name, 'active',
      evaluated_at, actor_identity_id, evaluated_at, 1
    );
  exception when unique_violation then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end;

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, language, time_zone, activated_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    new_account_id, new_organization_id, p_organization_steward_identity_id,
    p_account_display_name, 'active', p_account_language, p_account_time_zone,
    evaluated_at, evaluated_at, evaluated_at, actor_identity_id,
    new_correlation_id, 1
  );

  perform 1 from vortex_identity.initialize_organization_runtime_settings(
    new_organization_id, p_runtime_language, p_runtime_time_zone,
    p_runtime_currency, p_runtime_date_format, p_runtime_number_format
  );
  perform 1 from vortex_access.initialize_organization_access_version(
    new_organization_id, actor_identity_id, new_correlation_id
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    new_organization_id, actor_identity_id, new_correlation_id
  );

  select adopted.access_version
  into resulting_access_version
  from vortex_access.coordinate_organization_stewardship_adoption(
    new_organization_id, new_account_id, new_role_id, 'organization_steward',
    'Organisation steward', 'Permanent minimum organisation administration.',
    new_role_assignment_id, new_delegation_id, actor_identity_id,
    new_correlation_id
  ) as adopted;

  -- The initial steward has one current Group for Group-owned records.
  perform 1 from vortex_access.coordinate_organization_group_change(
    'create_group', new_organization_id, new_group_id, null,
    'organisation_owners', 'Organisation owners', new_account_id,
    new_correlation_id
  );
  select changed.access_version into resulting_access_version
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', new_organization_id, new_membership_id, null,
    new_group_id, new_account_id, evaluated_at, null, null,
    new_account_id, new_correlation_id
  ) as changed;

  set constraints
    vortex_access.organization_role_revisions_checked
    immediate;
  set constraints
    vortex_access.organization_role_revisions_checked
    deferred;

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values
    (new_organization_id, resulting_access_version),
    (new_account_id, 1::bigint)
  ) as result(subject_id, subject_revision);

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions)
    )
  );

  return query
  select 'accepted'::text,
    'create_tenant_organization'::text,
    new_organization_id,
    1::bigint,
    new_account_id,
    1::bigint,
    resulting_access_version,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.create_tenant_organization(uuid, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.create_tenant_organization(uuid, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  to vortex_runtime;

comment on function vortex_identity.create_tenant_organization(uuid, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text) is
  'Creates one tenant organisation for the bound request context person with an explicit existing steward, runtime settings, delivered Access composition and an initial current owner Group membership for that steward.';

alter function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) owner to vortex_owner;

grant execute on function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) to postgres;

CREATE OR REPLACE FUNCTION vortex_identity.protect_identity_disablement_command() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception 'identity disablement records are append-only'
      using errcode = '55000';
  end if;
  if new.command_id is distinct from old.command_id
    or new.actor_identity_id is distinct from old.actor_identity_id
    or new.subject_identity_id is distinct from old.subject_identity_id
    or new.correlation_id is distinct from old.correlation_id
    or new.requested_at is distinct from old.requested_at
    or old.outcome = 'disabled'
  then
    raise exception 'a recorded identity disablement command identity and result are immutable'
      using errcode = '55000';
  end if;
  return new;
end
$$;

alter function vortex_identity.protect_identity_disablement_command() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_identity.protect_identity_disablement_command() FROM PUBLIC;

grant execute on function vortex_identity.protect_identity_disablement_command() to postgres;

-- Administration receipts already store the organisation and original subject.
reset role;
set local role vortex_record_adapter;
update vortex_record.command_receipts as receipt
set result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind in ('create_organization_invitation', 'revoke_organization_invitation', 'close_organization_account', 'reactivate_organization_account', 'suspend_organization_account');
reset role;
set local role vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  scope record;
  stored record; claimed jsonb;
  new_receipt_id uuid; new_accepted_at timestamptz;
  created record; target_invitation_id uuid;
  subject_ids uuid[]; subject_revisions bigint[];
  operation_at timestamptz;
  role_item record; role_intents jsonb := '[]'::jsonb;
  locked_version bigint;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_invited_email is null
    or p_invited_email <> pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or pg_catalog.char_length(p_invited_email) not between 3 and 320
    or p_invited_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or p_expires_at is null
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_role_ids is null or pg_catalog.cardinality(p_role_ids) = 0
    or exists (select 1 from pg_catalog.unnest(p_role_ids) as id where id is null or not vortex_platform.is_non_nil_uuid(id::text))
    or pg_catalog.cardinality(p_role_ids) <> (select pg_catalog.count(distinct id) from pg_catalog.unnest(p_role_ids) as id) then
    raise exception using errcode = '22023', message = 'Invitation creation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'create_organization_invitation', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]);
    if pg_catalog.cardinality(stored."subjectIds") is distinct from 2
      or pg_catalog.cardinality(stored."subjectRevisions") is distinct from 2
      or pg_catalog.array_position(stored."subjectIds", null) is not null
      or stored."subjectIds"[1] = stored."subjectIds"[2]
      or not scope.organization_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Invitation creation receipt is unavailable';
    end if;
    target_invitation_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'create_organization_invitation'::text,
      scope.organization_id, target_invitation_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", target_invitation_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at <= operation_at then
    raise exception using errcode = '40001', message = 'Invitation creation is stale or unavailable';
  end if;
  select version.current_version into locked_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id for update;
  if locked_version is distinct from scope.access_version then
    raise exception using errcode = '40001', message = 'Invitation authority is stale';
  end if;
  for role_item in
    select role.role_id, role.live_revision, revision.lifecycle, revision.assignment_policy
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = scope.organization_id and role.role_id = any(p_role_ids)
    order by role.role_id for update of role
  loop
    if role_item.lifecycle <> 'active' or role_item.assignment_policy not in ('standing', 'activation_required')
      or not vortex_access.check_organization_invitation_role_authority_internal(
        scope.organization_id, scope.organization_account_id, role_item.role_id, operation_at
      ) then
      raise exception using errcode = 'V3145', message = 'You cannot give this role';
    end if;
    role_intents := role_intents || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'roleId', role_item.role_id, 'roleRevision', role_item.live_revision
    ));
  end loop;
  if pg_catalog.jsonb_array_length(role_intents) <> pg_catalog.cardinality(p_role_ids) then
    raise exception using errcode = 'V3145', message = 'You cannot give this role';
  end if;
  select result.* into strict created
  from vortex_identity.create_organization_invitation(
    p_invited_email, p_expires_at, role_intents
  ) as result;
  if created.organization_id <> scope.organization_id or created.revision <> 1
    or created.invited_email <> p_invited_email or created.expires_at <> p_expires_at
    or created.invited_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation creation result is unavailable';
  end if;
  if scope.organization_id < created.invitation_id then
    subject_ids := array[scope.organization_id, created.invitation_id];
    subject_revisions := array[scope.access_version, created.revision];
  else
    subject_ids := array[created.invitation_id, scope.organization_id];
    subject_revisions := array[created.revision, scope.access_version];
  end if;
  new_receipt_id := (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
  new_accepted_at := created.created_at;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', new_accepted_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions)));
  return query select 'accepted'::text, 'create_organization_invitation'::text,
    scope.organization_id, created.invitation_id, created.revision,
    new_receipt_id, new_accepted_at, scope.access_version;
end
$_$;

alter function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) IS 'Protected role-intent invitation creation; replay returns receipt evidence. The invited person accepts it after signing in with that verified email.';

REVOKE ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) TO vortex_request;

grant execute on function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) to postgres;


CREATE OR REPLACE FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  stored record; claimed jsonb;
  replay_target_id uuid;
  new_receipt_id uuid; new_accepted_at timestamptz;
  revoked record;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_invitation_id is null or not vortex_platform.is_non_nil_uuid(p_invitation_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Invitation revocation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_organization_invitation', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]);
    if pg_catalog.cardinality(stored."subjectIds") is distinct from 2
      or pg_catalog.cardinality(stored."subjectRevisions") is distinct from 2
      or pg_catalog.array_position(stored."subjectIds", null) is not null
      or stored."subjectIds"[1] = stored."subjectIds"[2]
      or not scope.organization_id = any(stored."subjectIds")
      then
      raise exception using errcode = '42501', message = 'Invitation revocation receipt is unavailable';
    end if;
    replay_target_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'revoke_organization_invitation'::text,
      scope.organization_id, replay_target_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_target_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  if p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Invitation revocation is stale or unavailable';
  end if;
  select result.* into strict revoked
  from vortex_identity.revoke_organization_invitation(
    p_invitation_id, p_expected_revision
  ) as result;
  if revoked.organization_id <> scope.organization_id
    or revoked.invitation_id <> p_invitation_id
    or revoked.revision <> p_expected_revision + 1
    or revoked.accepted_at is not null or revoked.revoked_at is null
    or revoked.revoked_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation revocation result is unavailable';
  end if;
  if scope.organization_id < p_invitation_id then
    subject_ids := array[scope.organization_id, p_invitation_id];
    subject_revisions := array[scope.access_version, revoked.revision];
  else
    subject_ids := array[p_invitation_id, scope.organization_id];
    subject_revisions := array[revoked.revision, scope.access_version];
  end if;
  new_receipt_id := (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
  new_accepted_at := revoked.changed_at;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', new_accepted_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions)));
  return query select 'accepted'::text, 'revoke_organization_invitation'::text,
    scope.organization_id, p_invitation_id, revoked.revision,
    new_receipt_id, new_accepted_at, scope.access_version;
end
$$;

alter function vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) IS 'Protected pending invitation revocation, including expired invitations, using the existing Identity owner.';

REVOKE ALL ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) TO vortex_request;

grant execute on function vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_access.close_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  stored record; claimed jsonb;
  replay_target_id uuid;
  target record; changed record;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account closure command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'close_organization_account', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]);
    if pg_catalog.cardinality(stored."subjectIds") is distinct from 2
      or pg_catalog.cardinality(stored."subjectRevisions") is distinct from 2
      or pg_catalog.array_position(stored."subjectIds", null) is not null
      or stored."subjectIds"[1] = stored."subjectIds"[2]
      or not scope.organization_id = any(stored."subjectIds")
      then
      raise exception using errcode = '42501', message = 'Account closure receipt is unavailable';
    end if;
    replay_target_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'close_organization_account'::text,
      scope.organization_id, replay_target_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_target_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state not in ('active', 'suspended')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account closure is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'closed'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'closed' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account closure result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', changed.state_change_correlation_id,
      'acceptedAt', changed.changed_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions)));
  return query select 'accepted'::text, 'close_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-or-suspended-to-closed account command; closure is not deletion.';

revoke execute on function
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

alter function vortex_access.close_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.close_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_access.reactivate_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  stored record; claimed jsonb;
  replay_target_id uuid;
  target record; changed record;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account reactivation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'reactivate_organization_account', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]);
    if pg_catalog.cardinality(stored."subjectIds") is distinct from 2
      or pg_catalog.cardinality(stored."subjectRevisions") is distinct from 2
      or pg_catalog.array_position(stored."subjectIds", null) is not null
      or stored."subjectIds"[1] = stored."subjectIds"[2]
      or not scope.organization_id = any(stored."subjectIds")
      then
      raise exception using errcode = '42501', message = 'Account reactivation receipt is unavailable';
    end if;
    replay_target_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'reactivate_organization_account'::text,
      scope.organization_id, replay_target_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_target_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state not in ('suspended', 'closed')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account reactivation is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'active'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'active' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account reactivation result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', changed.state_change_correlation_id,
      'acceptedAt', changed.changed_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions)));
  return query select 'accepted'::text, 'reactivate_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected suspended-or-closed-to-active account command using the existing guarded owner and accepted receipt.';

revoke execute on function
  vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

alter function vortex_access.reactivate_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.reactivate_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_access.suspend_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  stored record; claimed jsonb;
  replay_target_id uuid;
  target record; changed record;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account suspension command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'suspend_organization_account', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]);
    if pg_catalog.cardinality(stored."subjectIds") is distinct from 2
      or pg_catalog.cardinality(stored."subjectRevisions") is distinct from 2
      or pg_catalog.array_position(stored."subjectIds", null) is not null
      or stored."subjectIds"[1] = stored."subjectIds"[2]
      or not scope.organization_id = any(stored."subjectIds")
      then
      raise exception using errcode = '42501', message = 'Account suspension receipt is unavailable';
    end if;
    replay_target_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'suspend_organization_account'::text,
      scope.organization_id, replay_target_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_target_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state <> 'active' or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account suspension is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'suspended'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'suspended' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account suspension result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', changed.state_change_correlation_id,
      'acceptedAt', changed.changed_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions)));
  return query select 'accepted'::text, 'suspend_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-to-suspended account command using the existing guarded owner and accepted receipt.';

revoke execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

alter function vortex_access.suspend_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.suspend_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) to postgres;



-- Remove the unconsumed capability policy, reservation and usage projection stack.
drop table vortex_access.capability_limit_changes;
drop table vortex_access.capability_reservation_balances;
drop table vortex_access.capability_reservations;
drop table vortex_access.capability_policy_assignments;
drop table vortex_access.capability_policy_definitions;
drop table vortex_access.usage_projection_reconciliation;
drop table vortex_access.usage_projection_rollups;
drop function vortex_access.capability_limit_bounds_internal(uuid,uuid,text,text,timestamp with time zone,boolean);
drop function vortex_access.capability_reservation_request_context(uuid,uuid);
drop function vortex_access.consume_capability_reservation(uuid,uuid,text,text,uuid,bigint,uuid,bigint,uuid,numeric,uuid);
drop function vortex_access.derive_usage_projection(uuid,timestamp with time zone,timestamp with time zone);
drop function vortex_access.expire_stale_capability_reservations(uuid,uuid,text,text);
drop function vortex_access.lock_effective_capability_policy(uuid,uuid,text,text,timestamp with time zone);
drop function vortex_access.publish_capability_policy_definition(uuid,uuid,uuid,uuid,text,text,numeric,bigint);
drop function vortex_access.read_capability_reservation_balance(uuid,uuid,text,text);
drop function vortex_access.read_usage_projection(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone,text,integer,text);
drop function vortex_access.rebuild_usage_projection(uuid,uuid,timestamp with time zone,timestamp with time zone);
drop function vortex_access.refresh_capability_reservation_balance(uuid,uuid,text,text,text,uuid,uuid,bigint,uuid,bigint,numeric,timestamp with time zone);
drop function vortex_access.refuse_capability_limit_change_edit();
drop function vortex_access.release_capability_reservation(uuid,uuid,text,text,uuid,bigint,uuid,bigint,uuid,uuid,numeric);
drop function vortex_access.reserve_capability_quantity(uuid,uuid,text,text,jsonb,numeric,uuid);
drop function vortex_access.resolve_effective_capability_policy(uuid,uuid,text,text);
drop function vortex_access.revoke_capability_limit_allocation(uuid,uuid,uuid,uuid,bigint,uuid);
drop function vortex_access.revoke_capability_policy_ceiling(uuid,uuid,uuid,uuid,bigint);
drop function vortex_access.set_capability_limit_allocation(uuid,uuid,uuid,uuid,text,text,numeric,timestamp with time zone,bigint,uuid);
drop function vortex_access.set_capability_policy_ceiling(uuid,uuid,uuid,uuid,uuid,bigint,timestamp with time zone,timestamp with time zone,bigint);


-- Preserve the old integrity check for current pending proposals before removing hashes.
do $preflight$
declare
  bad_grant uuid;
  bad_organization uuid;
begin
  select grant_row.grant_id, grant_row.source_organization_id
  into bad_grant, bad_organization
  from vortex_access.record_share_grants as grant_row
  join vortex_access.record_share_grant_consent_requests as request_row
    on request_row.request_id = grant_row.consent_request_id
  where grant_row.status = 'pending_consent'
    and (request_row.revision is distinct from grant_row.revision
      or request_row.proposed_grant_fingerprint is distinct from grant_row.proposal_fingerprint
      or exists (
        select 1 from vortex_access.record_share_grant_consent_decisions as decision_row
        where decision_row.request_id = request_row.request_id
          and decision_row.proposal_revision = grant_row.revision
          and decision_row.proposed_grant_fingerprint is distinct from grant_row.proposal_fingerprint
      ))
  limit 1;
  if found then
    raise exception using errcode = '23514',
      message = pg_catalog.format('share_proposal_revision_mismatch: organization %s grant %s',
        bad_organization, bad_grant);
  end if;
end
$preflight$;

-- Consent evidence names the existing grant revision instead of a duplicate hash.
drop function vortex_access.propose_record_share_grant_for_administration(uuid, uuid, jsonb, text, uuid);
drop function vortex_access.revise_record_share_grant_for_administration(uuid, bigint, jsonb, text, uuid);
drop function vortex_access.record_share_grant_consent_decision_for_administration(uuid, uuid, bigint, text, text, text, uuid);
alter table vortex_access.record_share_grant_consent_decisions drop column proposed_grant_fingerprint;
alter table vortex_access.record_share_grant_consent_requests drop column proposed_grant_fingerprint;
alter table vortex_access.record_share_grants drop column proposal_fingerprint;

CREATE OR REPLACE FUNCTION vortex_access.record_share_grant_json_internal(p_grant_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
    'revision', stored.revision,
    'changedAt', pg_catalog.to_char(
      stored.changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$$;

alter function vortex_access.record_share_grant_json_internal(p_grant_id uuid) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.record_share_grant_json_internal(p_grant_id uuid) FROM PUBLIC;

grant execute on function vortex_access.record_share_grant_json_internal(p_grant_id uuid) to postgres;

create or replace function vortex_access.propose_record_share_grant_for_administration(
  p_grant_id uuid,
  p_consent_request_id uuid,
  p_terms jsonb,
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

  -- Take the organisation's shared Access lock before evaluating any authority, so a
  -- concurrent authority change cannot land between the check and the write.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active'
  for share of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share grant proposal is unavailable';
  end if;

  perform vortex_access.check_record_share_grant_terms_internal(p_terms, context_value);

  if vortex_access.recent_authentication_deadline_internal(
    context_value, pg_catalog.clock_timestamp(),
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Record-share grant administration requires multi-factor authentication';
  end if;

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
    revision, created_at, changed_at
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
    p_terms ->> 'definitionMappingFingerprint', 1,
    now_value, now_value
  );

  -- The grant's foreign key to its consent request is deferred, so the request
  -- follows the grant it names.
  if cross_organization then
    insert into vortex_access.record_share_grant_consent_requests (
      request_id, grant_id, source_organization_id, source_cluster_id,
      recipient_organization_id, recipient_cluster_id,
      status, requested_by_organization_account_id, requested_at,
      source_authorizing_role_ids, recipient_accepting_role_ids, expires_at,
      revision, changed_at
    ) values (
      p_consent_request_id, p_grant_id, context_organization_id,
      (p_terms ->> 'sourceClusterId')::uuid,
      (p_terms ->> 'recipientOrganizationId')::uuid,
      (p_terms ->> 'recipientClusterId')::uuid,
      'pending', context_account_id, now_value,
      vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'sourceAuthorizingRoleIds', 1, 100),
      vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'recipientAcceptingRoleIds', 1, 100),
      (p_terms ->> 'expiresAt')::timestamptz, 1, now_value
    );
  end if;


  append_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'propose_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], vortex_platform.channel(), context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant proposal Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

revoke all on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, uuid
) to vortex_request;

comment on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, uuid
) is
  'Fixed protected proposer: stores one exact record-share grant proposal for the context organisation after re-checking its current share authority; cross-organisation proposals stop at pending_consent with a consent request bound to the proposal revision.';

alter function vortex_access.propose_record_share_grant_for_administration(p_grant_id uuid, p_consent_request_id uuid, p_terms jsonb, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.propose_record_share_grant_for_administration(p_grant_id uuid, p_consent_request_id uuid, p_terms jsonb, p_activity_id uuid) to postgres;

create or replace function vortex_access.revise_record_share_grant_for_administration(
  p_grant_id uuid,
  p_expected_revision bigint,
  p_terms jsonb,
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
  for share of version;
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

  perform vortex_access.check_record_share_grant_terms_internal(p_terms, context_value);

  if vortex_access.recent_authentication_deadline_internal(
    context_value, pg_catalog.clock_timestamp(),
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Record-share grant administration requires multi-factor authentication';
  end if;

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
      revision = grants.revision + 1,
      changed_at = now_value
  where grants.grant_id = p_grant_id;

  -- The consent request follows the new revision and roles; earlier decisions
  -- name the previous revision and cannot approve this proposal.
  if cross_organization then
    update vortex_access.record_share_grant_consent_requests as requests
    set recipient_organization_id = (p_terms ->> 'recipientOrganizationId')::uuid,
        recipient_cluster_id = (p_terms ->> 'recipientClusterId')::uuid,
        source_cluster_id = (p_terms ->> 'sourceClusterId')::uuid,
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

  append_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'revise_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], vortex_platform.channel(), context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant revision Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

revoke all on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, uuid
) to vortex_request;

comment on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, uuid
) is
  'Fixed protected reviser: replaces the terms of a draft or pending_consent proposal under an exact expected revision, re-checking current share authority and resetting its consent request.';

alter function vortex_access.revise_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_terms jsonb, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revise_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_terms jsonb, p_activity_id uuid) to postgres;

create or replace function vortex_access.record_share_grant_consent_decision_for_administration(
  p_decision_id uuid,
  p_request_id uuid,
  p_expected_revision bigint,
  p_decision text,
  p_note text,
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
  context_tenant_id uuid;
  context_organization_id uuid;
  context_account_id uuid;
  context_application_root_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_multi_factor_at timestamptz;
  authentication_expires_at timestamptz;
  locked_access_version bigint;
  current_access_version bigint;
  lock_organization_id uuid;
  pre_source_organization_id uuid;
  pre_source_application_root_id uuid;
  pre_recipient_organization_id uuid;
  pre_recipient_application_root_id uuid;
  registration_target record;
  stored_grant vortex_access.record_share_grants%rowtype;
  stored_request vortex_access.record_share_grant_consent_requests%rowtype;
  source_tenant_id uuid;
  recipient_tenant_id uuid;
  side_value text;
  role_ids uuid[];
  checked_at timestamptz;
  path_checked_at timestamptz;
  authorization_path jsonb;
  path_valid_until timestamptz;
  source_authority jsonb;
  readable_ceiling uuid[];
  changeable_ceiling uuid[];
  decision_expires_at timestamptz;
  inserted_decision_id uuid;
  activity_result text;
begin
  if p_decision_id is null
    or p_decision_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_request_id is null
    or p_request_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_decision is null
    or p_decision not in ('consented', 'refused')
    or (p_note is not null and pg_catalog.char_length(p_note) > 500)
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record-share consent decision is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_tenant_id := (context_value ->> 'tenantId')::uuid;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_multi_factor_at :=
    (context_value ->> 'multiFactorAuthenticatedAt')::timestamptz;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision evidence is unavailable';
  end if;

  select grants.source_organization_id, grants.source_application_root_id,
    grants.recipient_organization_id, grants.recipient_application_root_id
  into pre_source_organization_id, pre_source_application_root_id,
    pre_recipient_organization_id, pre_recipient_application_root_id
  from vortex_access.record_share_grants as grants
  join vortex_access.record_share_grant_consent_requests as requests
    on requests.request_id = grants.consent_request_id
    and requests.grant_id = grants.grant_id
  where requests.request_id = p_request_id;
  if not found
    or pre_source_organization_id is null
    or pre_source_application_root_id is null
    or pre_recipient_organization_id is null
    or pre_recipient_application_root_id is null
    or pre_source_organization_id = pre_recipient_organization_id
    or context_organization_id not in (
      pre_source_organization_id, pre_recipient_organization_id
    ) then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  -- The human scope resolver already holds the caller's Access-version row
  -- FOR SHARE. Lock both participant versions by organisation ID, then
  -- exact application registrations by (organisation ID, application root ID).
  -- FOR SHARE is the weakest lock that blocks non-key updates. NOWAIT avoids a
  -- cross-side deadlock when the preheld caller row reverses UUID order; SQLSTATE
  -- 55P03 becomes a retryable unavailable result at the service boundary.
  for lock_organization_id in
    select participant.organization_id
    from (values
      (pre_source_organization_id),
      (pre_recipient_organization_id)
    ) as participant(organization_id)
    order by participant.organization_id
  loop
    select version.current_version into current_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = lock_organization_id
    for share nowait;
    if not found then
      raise exception using errcode = '42501',
        message = 'Record-share consent decision is unavailable';
    end if;
    if lock_organization_id = context_organization_id then
      locked_access_version := current_access_version;
    end if;
  end loop;
  if locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  for registration_target in
    select participant.organization_id, participant.application_root_id
    from (values
      (pre_source_organization_id, pre_source_application_root_id),
      (pre_recipient_organization_id, pre_recipient_application_root_id)
    ) as participant(organization_id, application_root_id)
    order by participant.organization_id, participant.application_root_id
  loop
    perform 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = registration_target.organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = registration_target.application_root_id
      and registration.state = 'active'
    for share nowait;
    if not found then
      raise exception using errcode = '42501',
        message = 'Record-share consent application is unavailable';
    end if;
  end loop;

  if (
    select pg_catalog.count(*)
    from vortex_identity.organizations as organization
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where organization.organization_id in (
      pre_source_organization_id, pre_recipient_organization_id
    )
      and organization.state = 'active'
      and tenant.state = 'active'
  ) <> 2 then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  select grants.* into stored_grant
  from vortex_access.record_share_grants as grants
  where grants.consent_request_id = p_request_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  select requests.* into stored_request
  from vortex_access.record_share_grant_consent_requests as requests
  where requests.request_id = p_request_id
    and requests.grant_id = stored_grant.grant_id
  for update;
  if not found
    or stored_grant.revision <> p_expected_revision
    or stored_request.revision <> p_expected_revision
    or stored_grant.status <> 'pending_consent'
    or stored_request.status <> 'pending'
    or stored_grant.consent_request_id is distinct from stored_request.request_id
    or stored_grant.source_organization_id is distinct from
      stored_request.source_organization_id
    or stored_grant.source_organization_id is distinct from
      pre_source_organization_id
    or stored_grant.source_cluster_id is distinct from
      stored_request.source_cluster_id
    or stored_grant.source_application_root_id is distinct from
      pre_source_application_root_id
    or stored_grant.recipient_organization_id is distinct from
      stored_request.recipient_organization_id
    or stored_grant.recipient_organization_id is distinct from
      pre_recipient_organization_id
    or stored_grant.recipient_cluster_id is distinct from
      stored_request.recipient_cluster_id
    or stored_grant.recipient_application_root_id is distinct from
      pre_recipient_application_root_id
    or stored_grant.expires_at is distinct from stored_request.expires_at
    or stored_grant.source_organization_id = stored_grant.recipient_organization_id
    or stored_grant.source_cluster_id is distinct from stored_grant.recipient_cluster_id then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is stale or unavailable';
  end if;

  if context_organization_id = stored_grant.source_organization_id then
    side_value := 'source_authorization';
    role_ids := stored_request.source_authorizing_role_ids;
    if context_application_root_id is distinct from
      stored_grant.source_application_root_id then
      raise exception using errcode = '42501',
        message = 'Record-share consent decision is unavailable';
    end if;
  elsif context_organization_id = stored_grant.recipient_organization_id then
    side_value := 'recipient_acceptance';
    role_ids := stored_request.recipient_accepting_role_ids;
    if context_application_root_id is distinct from
      stored_grant.recipient_application_root_id then
      raise exception using errcode = '42501',
        message = 'Record-share consent decision is unavailable';
    end if;
  else
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  select source.tenant_id, recipient.tenant_id
  into source_tenant_id, recipient_tenant_id
  from vortex_identity.organizations as source
  join vortex_identity.tenants as source_tenant
    on source_tenant.tenant_id = source.tenant_id
    and source_tenant.state = 'active'
  join vortex_identity.organizations as recipient
    on recipient.organization_id = stored_grant.recipient_organization_id
    and recipient.state = 'active'
  join vortex_identity.tenants as recipient_tenant
    on recipient_tenant.tenant_id = recipient.tenant_id
    and recipient_tenant.state = 'active'
  where source.organization_id = stored_grant.source_organization_id
    and source.state = 'active';
  if not found
    or (side_value = 'source_authorization'
      and source_tenant_id is distinct from context_tenant_id)
    or (side_value = 'recipient_acceptance'
      and recipient_tenant_id is distinct from context_tenant_id) then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  path_checked_at := pg_catalog.clock_timestamp();
  authentication_expires_at := vortex_access.recent_authentication_deadline_internal(
    context_value, path_checked_at,
    '{"kind":"multi_factor","maximumAgeSeconds":300}'::jsonb
  );
  if authentication_expires_at is null then
    raise exception using errcode = 'V3152',
      message = 'Record-share consent requires recent multi-factor authentication';
  end if;
  if stored_grant.expires_at is null
    or stored_grant.expires_at <= path_checked_at
    or stored_request.expires_at <= path_checked_at then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision evidence is stale or unavailable';
  end if;

  authorization_path :=
    vortex_access.record_share_grant_consent_role_path_internal(
      context_organization_id,
      context_account_id,
      context_application_root_id,
      role_ids,
      path_checked_at,
      context_expires_at
    );
  if authorization_path is null then
    raise exception using errcode = '42501',
      message = 'Record-share consent role path is unavailable';
  end if;
  path_valid_until := (authorization_path ->> 'validUntil')::timestamptz;

  if side_value = 'source_authorization' then
    source_authority :=
      vortex_access.record_share_grant_source_authority_internal(
        context_value, stored_grant.module_root_id, stored_grant.record_type_id
      );
    if source_authority is null
      or pg_catalog.jsonb_typeof(source_authority -> 'recordTypeIds') is distinct from 'array'
      or pg_catalog.jsonb_array_length(source_authority -> 'recordTypeIds') = 0
      or pg_catalog.jsonb_typeof(source_authority -> 'readableFieldIds') is distinct from 'array'
      or pg_catalog.jsonb_typeof(source_authority -> 'changeableFieldIds') is distinct from 'array' then
      raise exception using errcode = '42501',
        message = 'Record-share consent requires current source share permission';
    end if;
    select coalesce(pg_catalog.array_agg(field.value::uuid), array[]::uuid[])
    into readable_ceiling
    from pg_catalog.jsonb_array_elements_text(
      source_authority -> 'readableFieldIds'
    ) as field(value);
    select coalesce(pg_catalog.array_agg(field.value::uuid), array[]::uuid[])
    into changeable_ceiling
    from pg_catalog.jsonb_array_elements_text(
      source_authority -> 'changeableFieldIds'
    ) as field(value);
    if not (stored_grant.readable_field_ids <@ readable_ceiling)
      or not (stored_grant.changeable_field_ids <@ changeable_ceiling) then
      raise exception using errcode = '42501',
        message = 'Record-share consent exceeds current source field authority';
    end if;
  end if;

  checked_at := pg_catalog.clock_timestamp();
  authentication_expires_at := vortex_access.recent_authentication_deadline_internal(
    context_value, checked_at,
    '{"kind":"multi_factor","maximumAgeSeconds":300}'::jsonb
  );
  if authentication_expires_at is null then
    raise exception using errcode = 'V3152',
      message = 'Record-share consent requires recent multi-factor authentication';
  end if;
  if stored_grant.expires_at <= checked_at
    or stored_request.expires_at <= checked_at
    or path_valid_until <= checked_at then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision evidence is stale or unavailable';
  end if;

  decision_expires_at := least(
    authentication_expires_at,
    path_valid_until,
    stored_grant.expires_at,
    stored_request.expires_at
  );

  insert into vortex_access.record_share_grant_consent_decisions (
    decision_id,
    request_id,
    grant_id,
    tenant_id,
    source_organization_id,
    recipient_organization_id,
    side,
    approver_organization_id,
    approver_organization_account_id,
    approver_application_root_id,
    proposal_revision,
    proposal_expires_at,
    access_version,
    decision,
    note,
    authorization_path,
    multi_factor_authenticated_at,
    multi_factor_authentication_expires_at,
    decided_at,
    expires_at,
    correlation_id
  ) values (
    p_decision_id,
    stored_request.request_id,
    stored_grant.grant_id,
    context_tenant_id,
    stored_grant.source_organization_id,
    stored_grant.recipient_organization_id,
    side_value,
    context_organization_id,
    context_account_id,
    context_application_root_id,
    stored_grant.revision,
    stored_grant.expires_at,
    locked_access_version,
    p_decision,
    p_note,
    authorization_path,
    context_multi_factor_at,
    authentication_expires_at,
    checked_at,
    decision_expires_at,
    context_correlation_id
  )
  on conflict (request_id, proposal_revision, side) do nothing
  returning decision_id into inserted_decision_id;
  if not found or inserted_decision_id is distinct from p_decision_id then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is already recorded or unavailable';
  end if;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id,
    p_activity_id,
    checked_at,
    'organization_account',
    context_account_id,
    'record_share_consent_decision',
    array[stored_grant.grant_id, stored_request.request_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    context_correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share consent decision Activity is stale';
  end if;

  return pg_catalog.jsonb_build_object(
    'decisionId', p_decision_id,
    'requestId', stored_request.request_id,
    'side', side_value,
    'proposalRevision', stored_grant.revision,
    'approverOrganizationId', context_organization_id,
    'approverOrganizationAccountId', context_account_id,
    'approverApplicationRootId', context_application_root_id,
    'accessVersion', locked_access_version,
    'proposalExpiresAt', pg_catalog.to_char(
      stored_grant.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'decision', p_decision,
    'decidedAt', pg_catalog.to_char(
      checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'authorizationPath', authorization_path,
    'authenticationStrength', 'recent_multi_factor',
    'multiFactorAuthenticatedAt', pg_catalog.to_char(
      context_multi_factor_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'multiFactorAuthenticationExpiresAt', pg_catalog.to_char(
      authentication_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'expiresAt', pg_catalog.to_char(
      decision_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'correlationId', context_correlation_id
  ) || case when p_note is null then '{}'::jsonb
      else pg_catalog.jsonb_build_object('note', p_note) end;
end
$function$;

revoke all on function vortex_access.record_share_grant_consent_decision_for_administration(
  uuid, uuid, bigint, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.record_share_grant_consent_decision_for_administration(
  uuid, uuid, bigint, text, text, uuid
) to vortex_request;

comment on function vortex_access.record_share_grant_consent_decision_for_administration(
  uuid, uuid, bigint, text, text, uuid
) is
  'Fixed protected same-cluster consent writer: records one immutable side decision for the locked current proposal, requiring current named role-path evidence, source share and field authority where applicable and MFA no older than 300 seconds; it never activates a grant.';

alter function vortex_access.record_share_grant_consent_decision_for_administration(p_decision_id uuid, p_request_id uuid, p_expected_revision bigint, p_decision text, p_note text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.record_share_grant_consent_decision_for_administration(p_decision_id uuid, p_request_id uuid, p_expected_revision bigint, p_decision text, p_note text, p_activity_id uuid) to postgres;


-- Metering rows are durable product evidence; their UUID is their replay identity.
drop function vortex_access.record_metering_event(uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz, uuid, text, uuid, uuid, text);
alter table vortex_access.metering_events drop constraint metering_events_result_valid;
alter table vortex_access.metering_events disable trigger metering_events_immutable;
update vortex_access.metering_events set result = result - 'duplicateProtectionKey';
alter table vortex_access.metering_events enable trigger metering_events_immutable;
alter table vortex_access.metering_events drop column duplicate_protection_key;
alter table vortex_access.metering_events drop column command_fingerprint;
alter table vortex_access.metering_events add constraint metering_events_result_valid check (
  pg_catalog.jsonb_typeof(result) = 'object'
  and result ?& array['meteringEventId', 'operationId', 'tenantId', 'allocationOwner',
    'capabilityKey', 'quantity', 'unit', 'occurredAt', 'source', 'dimensions',
    'correlationId', 'acceptedAt']
  and (result ->> 'meteringEventId')::uuid is not distinct from metering_event_id
  and (result ->> 'operationId')::uuid is not distinct from operation_id
  and (result ->> 'tenantId')::uuid is not distinct from tenant_id
  and (result ->> 'organizationId')::uuid is not distinct from organization_id
  and (result ->> 'quantity')::numeric is not distinct from quantity
  and (result ->> 'correctsMeteringEventId')::uuid is not distinct from corrects_metering_event_id
  and result ->> 'correctionDirection' is not distinct from correction_direction
);
comment on table vortex_access.metering_events is
  'Immutable generic usage evidence keyed by event identity; corrections are later linked events.';

create or replace function vortex_access.record_metering_event(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_allocation_owner text,
  p_operation_id uuid,
  p_capability_key text,
  p_quantity numeric,
  p_unit text,
  p_source text,
  p_dimensions jsonb,
  p_occurred_at timestamptz,
  p_source_event_id uuid,
  p_metering_event_id uuid,
  p_correlation_id uuid,
  p_corrects_metering_event_id uuid,
  p_correction_direction text
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  accepted_at_value timestamptz := pg_catalog.clock_timestamp();
  established jsonb;
  existing vortex_access.metering_events%rowtype;
  corrected vortex_access.metering_events%rowtype;
  corrected_remaining numeric;
  safe_event jsonb;
begin
  if p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_organization_id::text))
    or p_allocation_owner is null
    or p_allocation_owner not in ('local', 'federated_source', 'federated_recipient')
    or p_operation_id is null or not vortex_platform.is_non_nil_uuid(p_operation_id::text)
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity)
    or p_source is null
    or p_source not in ('web', 'workflow', 'interface', 'connection', 'federation', 'system')
    or not vortex_access.metering_event_dimensions_are_valid(p_dimensions)
    or p_occurred_at is null
    or p_occurred_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_source_event_id is not null
      and not vortex_platform.is_non_nil_uuid(p_source_event_id::text))
    or p_metering_event_id is null
    or not vortex_platform.is_non_nil_uuid(p_metering_event_id::text)
    or p_correlation_id is null
    or not vortex_platform.is_non_nil_uuid(p_correlation_id::text)
    or (p_corrects_metering_event_id is not null
      and not vortex_platform.is_non_nil_uuid(p_corrects_metering_event_id::text))
    or ((p_corrects_metering_event_id is null) <> (p_correction_direction is null))
    or (p_correction_direction is not null
      and p_correction_direction not in ('increase', 'decrease')) then
    raise exception using errcode = '22023', message = 'Metering event command is invalid';
  end if;
  if (p_source = 'federation'
      and p_allocation_owner not in ('federated_source', 'federated_recipient'))
    or (p_source <> 'federation' and p_allocation_owner <> 'local') then
    raise exception using errcode = '22023', message = 'Metering event allocation is invalid';
  end if;
  established := vortex_platform.current_context();
  if (established ->> 'tenantId')::uuid is distinct from p_tenant_id
    or (established ->> 'organizationId')::uuid is distinct from p_organization_id
    or (established ->> 'correlationId')::uuid is distinct from p_correlation_id then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  -- Corrections and non-web sources are system operations. A human, federated
  -- or public request context can never fabricate system/federation usage or
  -- reduce recorded usage.
  if (established ->> 'callerKind') is distinct from 'system'
    and (p_source <> 'web' or p_corrects_metering_event_id is not null) then
    raise exception using errcode = '42501',
      message = 'Metering event authority is unavailable';
  end if;
  -- Key-share locks keep the attributed scope present without serialising the
  -- tenant's other writes behind every metered operation.
  perform 1 from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id for key share;
  if not found then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  if p_organization_id is not null then
    perform 1 from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = p_organization_id
      and organization.state = 'active'
    for key share;
    if not found then
      raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
    end if;
  end if;
  -- The caller-minted event identity is the durable duplicate key.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_metering_event_id::text, 751)
  );
  select stored.* into existing
  from vortex_access.metering_events as stored
  where stored.metering_event_id = p_metering_event_id;
  if found then
    if existing.tenant_id is distinct from p_tenant_id
      or existing.organization_id is distinct from p_organization_id then
      raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
    end if;
    return query select pg_catalog.jsonb_build_object(
      'status', 'replayed', 'event', existing.result
    );
    return;
  end if;
  -- Second lock, always taken after the event identity lock: an original serialises
  -- on its final operation identity, a correction on the event it corrects.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      case when p_corrects_metering_event_id is null then
        pg_catalog.concat_ws(E'\x1f', 'operation', p_tenant_id::text,
          p_operation_id::text, p_capability_key, p_unit)
      else
        pg_catalog.concat_ws(E'\x1f', 'correction', p_tenant_id::text,
          p_corrects_metering_event_id::text)
      end, 751)
  );
  if p_corrects_metering_event_id is null then
    if exists (
      select 1 from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.operation_id = p_operation_id
        and stored.capability_key = p_capability_key
        and stored.unit = p_unit
        and stored.corrects_metering_event_id is null
    ) then
      raise exception using errcode = 'V3001', message = 'Metering operation is already recorded';
    end if;
  else
    select stored.* into corrected
    from vortex_access.metering_events as stored
    where stored.tenant_id = p_tenant_id
      and stored.metering_event_id = p_corrects_metering_event_id;
    -- A correction targets an original event with the same attribution,
    -- allocation, capability and unit, so it never moves usage elsewhere.
    if not found
      or corrected.corrects_metering_event_id is not null
      or corrected.organization_id is distinct from p_organization_id
      or corrected.allocation_owner <> p_allocation_owner
      or corrected.capability_key <> p_capability_key
      or corrected.unit <> p_unit then
      raise exception using errcode = '22023', message = 'Metering correction target is unavailable';
    end if;
    if exists (
      select 1 from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.corrects_metering_event_id = p_corrects_metering_event_id
        and stored.operation_id = p_operation_id
    ) then
      raise exception using errcode = 'V3001', message = 'Metering operation is already recorded';
    end if;
    if p_correction_direction = 'decrease' then
      select corrected.quantity + coalesce(pg_catalog.sum(
          case stored.correction_direction
            when 'increase' then stored.quantity
            else -stored.quantity
          end), 0)
      into corrected_remaining
      from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.corrects_metering_event_id = p_corrects_metering_event_id;
      if p_quantity > corrected_remaining then
        raise exception using errcode = '22023',
          message = 'Metering correction exceeds the recorded quantity';
      end if;
    end if;
  end if;
  safe_event := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'meteringEventId', p_metering_event_id,
    'operationId', p_operation_id,
    'tenantId', p_tenant_id,
    'organizationId', p_organization_id,
    'allocationOwner', p_allocation_owner,
    'capabilityKey', p_capability_key,
    'quantity', p_quantity::float8,
    'unit', p_unit,
    'occurredAt', pg_catalog.to_char(p_occurred_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'source', p_source,
    'sourceEventId', p_source_event_id,
    'dimensions', p_dimensions,
    'correlationId', p_correlation_id,
    'correctsMeteringEventId', p_corrects_metering_event_id,
    'correctionDirection', p_correction_direction,
    'acceptedAt', pg_catalog.to_char(accepted_at_value at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ));
  insert into vortex_access.metering_events (
    metering_event_id, operation_id, tenant_id, organization_id,
    allocation_owner, capability_key, quantity, unit, source, dimensions,
    occurred_at, source_event_id, correlation_id, corrects_metering_event_id,
    correction_direction, accepted_at, result
  ) values (
    p_metering_event_id, p_operation_id, p_tenant_id, p_organization_id,
    p_allocation_owner, p_capability_key, p_quantity, p_unit, p_source,
    p_dimensions, p_occurred_at, p_source_event_id, p_correlation_id, p_corrects_metering_event_id,
    p_correction_direction, accepted_at_value, safe_event
  );
  return query select pg_catalog.jsonb_build_object(
    'status', 'accepted', 'event', safe_event
  );
end
$function$;

comment on function vortex_access.record_metering_event(
  uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
  uuid, uuid, uuid, uuid, text
) is
  'Appends one immutable metering event for an operation or attempt, or replays it by event identity.';

revoke execute on function
  vortex_access.record_metering_event(
    uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
    uuid, uuid, uuid, uuid, text
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_access.record_metering_event(
  uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
  uuid, uuid, uuid, uuid, text
) to vortex_request;

alter function vortex_access.record_metering_event(p_tenant_id uuid, p_organization_id uuid, p_allocation_owner text, p_operation_id uuid, p_capability_key text, p_quantity numeric, p_unit text, p_source text, p_dimensions jsonb, p_occurred_at timestamp with time zone, p_source_event_id uuid, p_metering_event_id uuid, p_correlation_id uuid, p_corrects_metering_event_id uuid, p_correction_direction text) owner to vortex_owner;

grant execute on function vortex_access.record_metering_event(p_tenant_id uuid, p_organization_id uuid, p_allocation_owner text, p_operation_id uuid, p_capability_key text, p_quantity numeric, p_unit text, p_source text, p_dimensions jsonb, p_occurred_at timestamp with time zone, p_source_event_id uuid, p_metering_event_id uuid, p_correlation_id uuid, p_corrects_metering_event_id uuid, p_correction_direction text) to postgres;


-- Registration revisions and exact source entries replace the duplicate candidate hash.
do $preflight$
declare
  bad_organization uuid;
  bad_owner uuid;
begin
  select current_row.organization_id, current_row.registration_owner_id
  into bad_organization, bad_owner
  from vortex_access.permission_registrations as current_row
  left join vortex_access.permission_registration_revisions as history
    on history.organization_id = current_row.organization_id
    and history.registration_kind = current_row.registration_kind
    and history.registration_owner_id = current_row.registration_owner_id
    and history.revision = current_row.revision
  where current_row.candidate_fingerprint is distinct from history.candidate_fingerprint
    or (current_row.registration_kind = 'platform'
      and current_row.candidate_fingerprint is distinct from current_row.permission_catalogue_fingerprint)
  limit 1;
  if found then
    raise exception using errcode = '23514',
      message = pg_catalog.format('permission_candidate_history_mismatch: organization %s owner %s',
        bad_organization, bad_owner);
  end if;
end
$preflight$;
alter table vortex_access.permission_registration_revisions
  drop constraint permission_registration_revisions_fingerprints_valid;
alter table vortex_access.permission_registration_revisions drop column candidate_fingerprint;
alter table vortex_access.permission_registrations drop column candidate_fingerprint;
alter table vortex_access.permission_registration_revisions
  add constraint permission_registration_revisions_catalogue_fingerprint_valid
  check (permission_catalogue_fingerprint ~ '^sha256:[a-f0-9]{64}$');








-- Replace permission-meaning fingerprints with protected continuity.

create or replace function vortex_access.permission_meaning_is_same_internal(
  p_left vortex_access.permission_catalogue_entries,
  p_right vortex_access.permission_catalogue_entries
) returns boolean
language sql immutable security invoker set search_path = ''
as $function$
  select row(
    (p_left).owner_kind, (p_left).owner_id, (p_left).permission_id, (p_left).permission_key,
    (p_left).record_type_id, (p_left).action_kind, (p_left).named_action, (p_left).administrative,
    (p_left).record_scope, (p_left).field_policy
  ) is not distinct from row(
    (p_right).owner_kind, (p_right).owner_id, (p_right).permission_id, (p_right).permission_key,
    (p_right).record_type_id, (p_right).action_kind, (p_right).named_action, (p_right).administrative,
    (p_right).record_scope, (p_right).field_policy
  );
$function$;

alter function vortex_access.permission_meaning_is_same_internal(
  vortex_access.permission_catalogue_entries, vortex_access.permission_catalogue_entries
) owner to vortex_owner;
revoke all on function vortex_access.permission_meaning_is_same_internal(
  vortex_access.permission_catalogue_entries, vortex_access.permission_catalogue_entries
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.permission_meaning_is_same_internal(
  vortex_access.permission_catalogue_entries, vortex_access.permission_catalogue_entries
) to postgres;


-- Preserve valid accepted meanings while replacing hashes with continuity revisions.
lock table vortex_access.permission_catalogue_entries, vortex_access.permission_continuities,
  vortex_access.organization_role_permission_entries, vortex_access.organization_delegation_authorities,
  vortex_access.platform_permission_declarations in access exclusive mode;

do $preflight$
begin
  if exists (
    select 1 from vortex_access.permission_continuities as continuity
    left join vortex_access.permission_catalogue_entries as current_entry
      on current_entry.organization_id = continuity.organization_id
      and current_entry.registration_kind = continuity.registration_kind
      and current_entry.registration_owner_id = continuity.registration_owner_id
      and current_entry.registration_revision = continuity.last_processed_registration_revision
      and current_entry.application_root_id is not distinct from continuity.application_root_id
      and current_entry.owner_kind = continuity.owner_kind and current_entry.owner_id = continuity.owner_id
      and current_entry.permission_id = continuity.permission_id
    where continuity.state = 'available'
      and (current_entry.permission_id is null
        or current_entry.meaning_fingerprint is distinct from continuity.meaning_fingerprint)
  ) then
    raise exception using errcode = '23514', message = 'permission_continuity_meaning_evidence_invalid';
  end if;
  if exists (
    select 1 from vortex_access.organization_role_permission_entries as permission
    left join vortex_access.permission_catalogue_entries as accepted
      on accepted.organization_id = permission.organization_id
      and accepted.registration_kind = permission.registration_kind
      and accepted.registration_owner_id = permission.registration_owner_id
      and accepted.registration_revision = permission.accepted_registration_revision
      and accepted.application_root_id is not distinct from permission.application_root_id
      and accepted.owner_kind = permission.owner_kind and accepted.owner_id = permission.owner_id
      and accepted.permission_id = permission.permission_id
    where accepted.permission_id is null
      or accepted.meaning_fingerprint is distinct from permission.meaning_fingerprint
  ) then
    raise exception using errcode = '23514', message = 'role_permission_meaning_evidence_invalid';
  end if;
  if exists (
    select 1 from vortex_access.organization_delegation_authorities as delegation
    cross join lateral pg_catalog.jsonb_array_elements(delegation.bounded_permissions) as permission(value)
    left join vortex_access.permission_catalogue_entries as accepted
      on accepted.organization_id = delegation.organization_id
      and accepted.application_root_id is not distinct from (permission.value ->> 'applicationRootId')::uuid
      and accepted.owner_kind = permission.value ->> 'ownerKind'
      and accepted.owner_id = (permission.value ->> 'ownerId')::uuid
      and accepted.permission_id = (permission.value ->> 'permissionId')::uuid
      and accepted.registration_kind = case when permission.value ->> 'ownerKind' = 'platform'
        then 'platform' else 'application' end
      and accepted.registration_owner_id = coalesce((permission.value ->> 'applicationRootId')::uuid,
        (permission.value ->> 'ownerId')::uuid)
      and accepted.registration_revision = (permission.value ->> 'acceptedRegistrationRevision')::bigint
    where delegation.bounded_permissions is not null
      and (accepted.permission_id is null
        or accepted.meaning_fingerprint is distinct from permission.value ->> 'meaningFingerprint')
  ) then
    raise exception using errcode = '23514', message = 'delegation_permission_meaning_evidence_invalid';
  end if;
end
$preflight$;

create temporary table rst_permission_meaning_bumps on commit drop as
select continuity.organization_id, continuity.application_root_id, continuity.application_scope_id,
  continuity.owner_kind, continuity.owner_id, continuity.permission_id,
  continuity.registration_kind, continuity.registration_owner_id,
  continuity.last_processed_registration_revision, continuity.continuity_revision as old_revision
from vortex_access.permission_continuities as continuity
join vortex_access.permission_catalogue_entries as current_entry
  on current_entry.organization_id = continuity.organization_id
  and current_entry.registration_kind = continuity.registration_kind
  and current_entry.registration_owner_id = continuity.registration_owner_id
  and current_entry.registration_revision = continuity.last_processed_registration_revision
  and current_entry.application_root_id is not distinct from continuity.application_root_id
  and current_entry.owner_kind = continuity.owner_kind and current_entry.owner_id = continuity.owner_id
  and current_entry.permission_id = continuity.permission_id
where continuity.state = 'available' and (
  exists (
    select 1 from vortex_access.organization_role_permission_entries as permission
    join vortex_access.permission_catalogue_entries as accepted
      on accepted.organization_id = permission.organization_id
      and accepted.registration_kind = permission.registration_kind
      and accepted.registration_owner_id = permission.registration_owner_id
      and accepted.registration_revision = permission.accepted_registration_revision
      and accepted.application_root_id is not distinct from permission.application_root_id
      and accepted.owner_kind = permission.owner_kind and accepted.owner_id = permission.owner_id
      and accepted.permission_id = permission.permission_id
    where permission.organization_id = continuity.organization_id
      and permission.application_root_id is not distinct from continuity.application_root_id
      and permission.owner_kind = continuity.owner_kind and permission.owner_id = continuity.owner_id
      and permission.permission_id = continuity.permission_id
      and permission.registration_kind = continuity.registration_kind
      and permission.registration_owner_id = continuity.registration_owner_id
      and permission.continuity_revision = continuity.continuity_revision
      and not vortex_access.permission_meaning_is_same_internal(accepted, current_entry)
  ) or exists (
    select 1 from vortex_access.organization_delegation_authorities as delegation
    cross join lateral pg_catalog.jsonb_array_elements(delegation.bounded_permissions) as permission(value)
    join vortex_access.permission_catalogue_entries as accepted
      on accepted.organization_id = delegation.organization_id
      and accepted.registration_kind = continuity.registration_kind
      and accepted.registration_owner_id = continuity.registration_owner_id
      and accepted.registration_revision = (permission.value ->> 'acceptedRegistrationRevision')::bigint
      and accepted.application_root_id is not distinct from continuity.application_root_id
      and accepted.owner_kind = continuity.owner_kind and accepted.owner_id = continuity.owner_id
      and accepted.permission_id = continuity.permission_id
    where delegation.organization_id = continuity.organization_id
      and (permission.value ->> 'applicationRootId')::uuid is not distinct from continuity.application_root_id
      and permission.value ->> 'ownerKind' = continuity.owner_kind
      and (permission.value ->> 'ownerId')::uuid = continuity.owner_id
      and (permission.value ->> 'permissionId')::uuid = continuity.permission_id
      and (permission.value ->> 'continuityRevision')::bigint = continuity.continuity_revision
      and not vortex_access.permission_meaning_is_same_internal(accepted, current_entry)
  )
);

do $preflight$
begin
  if exists (select 1 from rst_permission_meaning_bumps where old_revision = 9007199254740991) then
    raise exception using errcode = '22003', message = 'permission_meaning_continuity_revision_exhausted';
  end if;
end
$preflight$;

alter table vortex_access.permission_continuities disable trigger permission_continuities_protect_change;
alter table vortex_access.organization_role_permission_entries disable trigger organization_role_permission_entries_immutable;
alter table vortex_access.organization_delegation_authorities disable trigger organization_delegation_authorities_protect_change;
alter table vortex_access.organization_delegation_authorities disable trigger organization_delegation_authorities_validate_scope;

do $migrate$
declare
  bumped_count bigint;
  moved_roles bigint;
  moved_delegations bigint;
  unavailable_roles bigint;
  unavailable_delegations bigint;
  live_moved_roles bigint;
  live_unavailable_roles bigint;
  live_moved_delegations bigint;
  live_unavailable_delegations bigint;
begin
  select pg_catalog.count(*) into bumped_count from rst_permission_meaning_bumps;
  select pg_catalog.count(*) filter (where not vortex_access.permission_meaning_is_same_internal(accepted, current_entry)),
    pg_catalog.count(*) filter (where role.live_revision = permission.role_revision
      and vortex_access.permission_meaning_is_same_internal(accepted, current_entry)),
    pg_catalog.count(*) filter (where role.live_revision = permission.role_revision
      and not vortex_access.permission_meaning_is_same_internal(accepted, current_entry))
  into unavailable_roles, live_moved_roles, live_unavailable_roles
  from vortex_access.organization_role_permission_entries as permission
  join rst_permission_meaning_bumps as bump
    on bump.organization_id = permission.organization_id
    and bump.application_root_id is not distinct from permission.application_root_id
    and bump.owner_kind = permission.owner_kind and bump.owner_id = permission.owner_id
    and bump.permission_id = permission.permission_id
    and bump.registration_kind = permission.registration_kind
    and bump.registration_owner_id = permission.registration_owner_id
    and bump.old_revision = permission.continuity_revision
  join vortex_access.organization_roles as role
    on role.organization_id = permission.organization_id and role.role_id = permission.role_id
  join vortex_access.permission_catalogue_entries as accepted
    on accepted.organization_id = permission.organization_id
    and accepted.registration_kind = permission.registration_kind
    and accepted.registration_owner_id = permission.registration_owner_id
    and accepted.registration_revision = permission.accepted_registration_revision
    and accepted.application_root_id is not distinct from permission.application_root_id
    and accepted.owner_kind = permission.owner_kind and accepted.owner_id = permission.owner_id
    and accepted.permission_id = permission.permission_id
  join vortex_access.permission_catalogue_entries as current_entry
    on current_entry.organization_id = bump.organization_id
    and current_entry.registration_kind = bump.registration_kind
    and current_entry.registration_owner_id = bump.registration_owner_id
    and current_entry.registration_revision = bump.last_processed_registration_revision
    and current_entry.application_root_id is not distinct from bump.application_root_id
    and current_entry.owner_kind = bump.owner_kind and current_entry.owner_id = bump.owner_id
    and current_entry.permission_id = bump.permission_id;

  update vortex_access.organization_role_permission_entries as permission
  set continuity_revision = bump.old_revision + 1
  from rst_permission_meaning_bumps as bump,
    vortex_access.permission_catalogue_entries as accepted,
    vortex_access.permission_catalogue_entries as current_entry
  where bump.organization_id = permission.organization_id
    and bump.application_root_id is not distinct from permission.application_root_id
    and bump.owner_kind = permission.owner_kind and bump.owner_id = permission.owner_id
    and bump.permission_id = permission.permission_id
    and bump.registration_kind = permission.registration_kind
    and bump.registration_owner_id = permission.registration_owner_id
    and bump.old_revision = permission.continuity_revision
    and accepted.organization_id = permission.organization_id
    and accepted.registration_kind = permission.registration_kind
    and accepted.registration_owner_id = permission.registration_owner_id
    and accepted.registration_revision = permission.accepted_registration_revision
    and accepted.application_root_id is not distinct from permission.application_root_id
    and accepted.owner_kind = permission.owner_kind and accepted.owner_id = permission.owner_id
    and accepted.permission_id = permission.permission_id
    and current_entry.organization_id = bump.organization_id
    and current_entry.registration_kind = bump.registration_kind
    and current_entry.registration_owner_id = bump.registration_owner_id
    and current_entry.registration_revision = bump.last_processed_registration_revision
    and current_entry.application_root_id is not distinct from bump.application_root_id
    and current_entry.owner_kind = bump.owner_kind and current_entry.owner_id = bump.owner_id
    and current_entry.permission_id = bump.permission_id
    and vortex_access.permission_meaning_is_same_internal(accepted, current_entry);
  get diagnostics moved_roles = row_count;

  select pg_catalog.count(*) filter (where vortex_access.permission_meaning_is_same_internal(accepted, current_entry)),
    pg_catalog.count(*) filter (where not vortex_access.permission_meaning_is_same_internal(accepted, current_entry)),
    pg_catalog.count(*) filter (where delegation.state = 'live'
      and vortex_access.permission_meaning_is_same_internal(accepted, current_entry)),
    pg_catalog.count(*) filter (where delegation.state = 'live'
      and not vortex_access.permission_meaning_is_same_internal(accepted, current_entry))
  into moved_delegations, unavailable_delegations, live_moved_delegations, live_unavailable_delegations
  from vortex_access.organization_delegation_authorities as delegation
  cross join lateral pg_catalog.jsonb_array_elements(delegation.bounded_permissions) as permission(value)
  join rst_permission_meaning_bumps as bump
    on bump.organization_id = delegation.organization_id
    and bump.application_root_id is not distinct from (permission.value ->> 'applicationRootId')::uuid
    and bump.owner_kind = permission.value ->> 'ownerKind'
    and bump.owner_id = (permission.value ->> 'ownerId')::uuid
    and bump.permission_id = (permission.value ->> 'permissionId')::uuid
    and bump.old_revision = (permission.value ->> 'continuityRevision')::bigint
  join vortex_access.permission_catalogue_entries as accepted
    on accepted.organization_id = bump.organization_id
    and accepted.registration_kind = bump.registration_kind
    and accepted.registration_owner_id = bump.registration_owner_id
    and accepted.registration_revision = (permission.value ->> 'acceptedRegistrationRevision')::bigint
    and accepted.application_root_id is not distinct from bump.application_root_id
    and accepted.owner_kind = bump.owner_kind and accepted.owner_id = bump.owner_id
    and accepted.permission_id = bump.permission_id
  join vortex_access.permission_catalogue_entries as current_entry
    on current_entry.organization_id = bump.organization_id
    and current_entry.registration_kind = bump.registration_kind
    and current_entry.registration_owner_id = bump.registration_owner_id
    and current_entry.registration_revision = bump.last_processed_registration_revision
    and current_entry.application_root_id is not distinct from bump.application_root_id
    and current_entry.owner_kind = bump.owner_kind and current_entry.owner_id = bump.owner_id
    and current_entry.permission_id = bump.permission_id;

  update vortex_access.organization_delegation_authorities as delegation
  set bounded_permissions = (
    select pg_catalog.jsonb_agg(
      case when exists (
        select 1 from rst_permission_meaning_bumps as bump
        join vortex_access.permission_catalogue_entries as accepted
          on accepted.organization_id = bump.organization_id
          and accepted.registration_kind = bump.registration_kind
          and accepted.registration_owner_id = bump.registration_owner_id
          and accepted.registration_revision = (permission.value ->> 'acceptedRegistrationRevision')::bigint
          and accepted.application_root_id is not distinct from bump.application_root_id
          and accepted.owner_kind = bump.owner_kind and accepted.owner_id = bump.owner_id
          and accepted.permission_id = bump.permission_id
        join vortex_access.permission_catalogue_entries as current_entry
          on current_entry.organization_id = bump.organization_id
          and current_entry.registration_kind = bump.registration_kind
          and current_entry.registration_owner_id = bump.registration_owner_id
          and current_entry.registration_revision = bump.last_processed_registration_revision
          and current_entry.application_root_id is not distinct from bump.application_root_id
          and current_entry.owner_kind = bump.owner_kind and current_entry.owner_id = bump.owner_id
          and current_entry.permission_id = bump.permission_id
        where bump.organization_id = delegation.organization_id
          and bump.application_root_id is not distinct from (permission.value ->> 'applicationRootId')::uuid
          and bump.owner_kind = permission.value ->> 'ownerKind'
          and bump.owner_id = (permission.value ->> 'ownerId')::uuid
          and bump.permission_id = (permission.value ->> 'permissionId')::uuid
          and bump.old_revision = (permission.value ->> 'continuityRevision')::bigint
          and vortex_access.permission_meaning_is_same_internal(accepted, current_entry)
      ) then pg_catalog.jsonb_set(permission.value - 'meaningFingerprint', '{continuityRevision}',
        pg_catalog.to_jsonb((permission.value ->> 'continuityRevision')::bigint + 1))
      else permission.value - 'meaningFingerprint' end order by permission.ordinal
    ) from pg_catalog.jsonb_array_elements(delegation.bounded_permissions)
      with ordinality as permission(value, ordinal)
  ) where delegation.bounded_permissions is not null;

  update vortex_access.permission_continuities as continuity
  set continuity_revision = bump.old_revision + 1
  from rst_permission_meaning_bumps as bump
  where continuity.organization_id = bump.organization_id
    and continuity.application_scope_id = bump.application_scope_id
    and continuity.owner_kind = bump.owner_kind and continuity.owner_id = bump.owner_id
    and continuity.permission_id = bump.permission_id
    and continuity.registration_kind = bump.registration_kind
    and continuity.registration_owner_id = bump.registration_owner_id;

  raise notice 'permission_meaning_migration live role revisions and non-revoked delegations: bumped permissions %, moved %, made unavailable %',
    bumped_count, live_moved_roles + live_moved_delegations,
    live_unavailable_roles + live_unavailable_delegations;
  raise notice 'permission_meaning_migration all stored references: bumped permissions %, moved %, made unavailable %',
    bumped_count, moved_roles + moved_delegations, unavailable_roles + unavailable_delegations;
end
$migrate$;

alter table vortex_access.permission_catalogue_entries
  drop constraint permission_catalogue_entries_fingerprints_valid;
alter table vortex_access.organization_role_permission_entries
  drop constraint organization_role_permission_entries_fingerprints_valid;
-- Preserve open previews while changing the catalogue row type.
drop index vortex_access.preview_permission_entries_identity;
alter table vortex_access.preview_permission_entries
  alter column entry type jsonb using pg_catalog.to_jsonb(entry);
alter table vortex_access.permission_catalogue_entries drop column meaning_fingerprint;
alter table vortex_access.preview_permission_entries
  alter column entry type vortex_access.permission_catalogue_entries
  using pg_catalog.jsonb_populate_record(null::vortex_access.permission_catalogue_entries, entry - 'meaning_fingerprint');
create unique index preview_permission_entries_identity
  on vortex_access.preview_permission_entries (
    preview_installation_id, ((entry).owner_kind), ((entry).owner_id), ((entry).permission_id)
  );
alter table vortex_access.permission_continuities drop column meaning_fingerprint;
alter table vortex_access.organization_role_permission_entries drop column meaning_fingerprint;
alter table vortex_access.platform_permission_declarations drop column meaning_fingerprint;
alter table vortex_access.permission_catalogue_entries
  add constraint permission_catalogue_entries_catalogue_fingerprint_valid
  check (source_catalogue_fingerprint is null or source_catalogue_fingerprint ~ '^sha256:[a-f0-9]{64}$');
alter table vortex_access.organization_role_permission_entries
  add constraint organization_role_permission_entries_catalogue_fingerprint_valid
  check (catalogue_fingerprint ~ '^sha256:[a-f0-9]{64}$');

alter table vortex_access.permission_continuities enable trigger permission_continuities_protect_change;
alter table vortex_access.organization_role_permission_entries enable trigger organization_role_permission_entries_immutable;
alter table vortex_access.organization_delegation_authorities enable trigger organization_delegation_authorities_protect_change;
alter table vortex_access.organization_delegation_authorities enable trigger organization_delegation_authorities_validate_scope;

drop function vortex_access.accepted_permission_meaning_internal(uuid, uuid, text, uuid, uuid, bigint, bigint, text);
drop function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid);
drop function vortex_access.read_guarded_platform_permission_minimum_internal();
drop function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint);


create or replace function vortex_access.read_platform_permission_declaration_catalogue_internal(
  p_registration_revision bigint
)
returns table (
  declared_current_revision bigint,
  registration_revision bigint,
  source_version text,
  catalogue_fingerprint text,
  permission_id uuid,
  permission_key text,
  action_kind text,
  label text,
  description text,
  steward_minimum boolean,
  first_revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  with declarations as materialized (
    select declaration.*
    from vortex_access.platform_permission_declarations as declaration
    where declaration.owner_kind = 'platform'
      and declaration.owner_id = vortex_access.platform_permission_owner_id()
  ),
  valid as (
    select p_registration_revision = 6
      and pg_catalog.count(*) = 23
      and pg_catalog.count(distinct permission_id) = 23
      and pg_catalog.count(distinct permission_key) = 23
      and pg_catalog.count(*) filter (where action_kind = 'named') = 0
      and pg_catalog.bool_and(first_revision between 1 and 6)
      as is_valid
    from declarations
  )
  select 6::bigint, 6::bigint, '1.4.0'::text,
    'sha256:60d2c42cab03723fda56198083a70e8703792587546379372334d99609b15538'::text,
    declaration.permission_id, declaration.permission_key,
    declaration.action_kind, declaration.label, declaration.description,
    declaration.steward_minimum,
    declaration.first_revision
  from declarations as declaration
  cross join valid
  where valid.is_valid
$function$;

alter function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  owner to vortex_owner;

revoke all on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  to postgres;
comment on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint) is
  'Returns the trusted current platform permission declaration catalogue to the authorized postgres caller.';

create or replace function vortex_access.read_guarded_platform_permission_minimum_internal()
returns table (
  permission_id uuid
)
language sql
stable
security definer
set search_path = ''
as $function$
  select declaration.permission_id
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform'
    and declaration.owner_id = vortex_access.platform_permission_owner_id()
    and declaration.steward_minimum
  order by declaration.permission_id
$function$;
alter function vortex_access.read_guarded_platform_permission_minimum_internal() owner to vortex_owner;


revoke all on function vortex_access.read_guarded_platform_permission_minimum_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.read_guarded_platform_permission_minimum_internal()
  to postgres;
comment on function vortex_access.read_guarded_platform_permission_minimum_internal() is
  'Returns the complete guarded platform permanent-steward permission identity set only to the authorized postgres caller.';
alter function vortex_access.read_guarded_platform_permission_minimum_internal()
  owner to vortex_owner;

create or replace function vortex_access.read_available_permission(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_permission_id uuid
)
returns table (
  organization_id uuid,
  application_root_id uuid,
  registration_revision bigint,
  owner_kind text,
  owner_id uuid,
  permission_id uuid,
  permission_key text,
  label text,
  description text,
  record_type_id uuid,
  record_scope jsonb,
  field_policy jsonb,
  action_kind text,
  named_action text,
  administrative boolean,
  source_kind text,
  source_definition_key text,
  source_root_id uuid,
  source_version text,
  source_revision bigint,
  source_validation_contract_version text,
  source_catalogue_fingerprint text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select entry.organization_id, entry.application_root_id, entry.registration_revision,
    entry.owner_kind, entry.owner_id, entry.permission_id, entry.permission_key,
    entry.label, entry.description, entry.record_type_id, entry.record_scope,
    entry.field_policy,
    entry.action_kind, entry.named_action, entry.administrative, entry.source_kind,
    entry.source_definition_key, entry.source_root_id, entry.source_version,
    entry.source_revision, entry.source_validation_contract_version,
    entry.source_catalogue_fingerprint
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
  where registration.organization_id = p_organization_id
    and registration.state = 'active'
    and entry.owner_kind = p_owner_kind
    and entry.owner_id = p_owner_id
    and entry.permission_id = p_permission_id
    and (
      (p_owner_kind = 'platform' and p_application_root_id is null and entry.application_root_id is null)
      or (
        p_owner_kind in ('application', 'module')
        and p_application_root_id is not null
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and entry.application_root_id = p_application_root_id
      )
    )
$function$;
alter function vortex_access.read_available_permission(uuid,uuid,text,uuid,uuid) owner to vortex_owner;

revoke execute on function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid) is
  'Owner-only exact current permission lookup retaining application context, record scope and field policy.';
alter function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid)
  owner to vortex_owner;

create or replace function vortex_access.accepted_permission_meaning_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_permission_id uuid,
  p_continuity_revision bigint,
  p_accepted_registration_revision bigint
)
returns setof vortex_access.permission_catalogue_entries
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  -- Accepted authority remains valid only in the same continuity and while its
  -- stored authority-bearing fields still match the current registration.
  return query
    select accepted.*
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as current_entry
      on current_entry.organization_id = registration.organization_id
      and current_entry.registration_kind = registration.registration_kind
      and current_entry.registration_owner_id is not distinct from registration.registration_owner_id
      and current_entry.registration_revision = registration.revision
      and current_entry.application_root_id is not distinct from p_application_root_id
      and current_entry.owner_kind = p_owner_kind
      and current_entry.owner_id = p_owner_id
      and current_entry.permission_id = p_permission_id
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = current_entry.organization_id
      and continuity.application_scope_id = coalesce(current_entry.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and continuity.owner_kind = current_entry.owner_kind
      and continuity.owner_id = current_entry.owner_id
      and continuity.permission_id = current_entry.permission_id
      and continuity.registration_kind = current_entry.registration_kind
      and continuity.registration_owner_id is not distinct from current_entry.registration_owner_id
      and continuity.last_processed_registration_revision = registration.revision
      and continuity.state = 'available'
      and continuity.continuity_revision = p_continuity_revision
    join vortex_access.permission_catalogue_entries as accepted
      on accepted.organization_id = current_entry.organization_id
      and accepted.registration_kind = current_entry.registration_kind
      and accepted.registration_owner_id is not distinct from current_entry.registration_owner_id
      and accepted.registration_revision = p_accepted_registration_revision
      and accepted.application_root_id is not distinct from current_entry.application_root_id
      and accepted.owner_kind = current_entry.owner_kind
      and accepted.owner_id = current_entry.owner_id
      and accepted.permission_id = current_entry.permission_id
      and vortex_access.permission_meaning_is_same_internal(accepted, current_entry)
    where registration.organization_id = p_organization_id
      and registration.state = 'active'
      and p_accepted_registration_revision <= registration.revision
    limit 1;
end
$function$;

revoke execute on function vortex_access.accepted_permission_meaning_internal(uuid, uuid, text, uuid, uuid, bigint, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.accepted_permission_meaning_internal(uuid, uuid, text, uuid, uuid, bigint, bigint)
  to vortex_owner, postgres;
alter function vortex_access.accepted_permission_meaning_internal(uuid, uuid, text, uuid, uuid, bigint, bigint)
  owner to vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.application_access_current_state_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_prepared_templates jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  role_record record;
  target_template jsonb;
  current_permission_count bigint;
  retained_permission_count bigint;
  unchanged_permission_count bigint;
  target_permission_count bigint;
  target_lifecycle text;
  target_template_continuity_revision bigint;
begin
  if not vortex_access.application_permission_registration_matches_candidate(
    p_organization_id, p_application_root_id, p_registration_revision,
    p_prepared_templates -> 'permissionRegistration'
  ) then
    return false;
  end if;

  if exists (
    select 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.last_processed_registration_revision <> p_registration_revision
  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
    where not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.source_role_id = (item.value #>> '{template,roleId}')::uuid
        and continuity.state = 'available'
        and continuity.last_processed_registration_revision = p_registration_revision
    )
  ) or exists (
    select 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.state = 'available'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
        where (item.value #>> '{template,roleId}')::uuid = continuity.source_role_id
      )
  ) then
    return false;
  end if;

  for role_record in
    select role.role_id, role.source_role_id, revision.lifecycle,
      revision.revision as role_revision,
      revision.template_continuity_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_kind = 'application'
      and role.application_root_id = p_application_root_id
    order by role.role_id
  loop
    if role_record.lifecycle = 'retired' then
      continue;
    end if;

    target_template := null;
    target_template_continuity_revision := null;
    select item.value, continuity.continuity_revision
    into target_template, target_template_continuity_revision
    from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
    join vortex_access.application_role_template_continuities as continuity
      on continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.source_role_id = (item.value #>> '{template,roleId}')::uuid
      and continuity.state = 'available'
    where (item.value #>> '{template,roleId}')::uuid = role_record.source_role_id;

    select pg_catalog.count(*) into current_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = p_organization_id
      and permission.role_id = role_record.role_id
      and permission.role_revision = role_record.role_revision;

    if target_template is null then
      retained_permission_count := 0;
      target_permission_count := 0;
      target_lifecycle := 'unavailable';
    else
      -- Exactly the coordinator's carry-over: a permission the template still grants stays in
      -- its availability lineage with the meaning the role accepted.
      select pg_catalog.count(*) into retained_permission_count
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.role_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
        );
      select pg_catalog.count(*) into unchanged_permission_count
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.role_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
        );
      target_permission_count := pg_catalog.jsonb_array_length(
        target_template -> 'livePermissions'
      );
      if role_record.lifecycle = 'active'
        and unchanged_permission_count > 0
        and unchanged_permission_count = target_permission_count
        and retained_permission_count = target_permission_count
        and role_record.template_continuity_revision =
          target_template_continuity_revision then
        target_lifecycle := 'active';
      else
        target_lifecycle := 'acceptance_required';
      end if;
    end if;

    if role_record.lifecycle <> target_lifecycle
      or current_permission_count <> retained_permission_count then
      return false;
    end if;
  end loop;

  return true;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end
$$;

alter function vortex_access.application_access_current_state_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_prepared_templates jsonb) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.application_access_current_state_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_prepared_templates jsonb) FROM PUBLIC;

grant execute on function vortex_access.application_access_current_state_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_prepared_templates jsonb) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  release_value jsonb;
  actual_entries jsonb;
  actual_application_permission_ids jsonb;
  registration_exact boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_registration_revision is null
    or p_registration_revision not between 1 and 9007199254740991
    or p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) is distinct from 'object'
    or p_candidate - array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries'
    ]::text[] <> '{}'::jsonb
    or not (p_candidate ?& array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries'
    ])
    or p_candidate ->> 'contractVersion' is distinct from '1.0.0'
    or (p_candidate ->> 'organizationId')::uuid is distinct from p_organization_id
    or (p_candidate ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationRelease') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationPermissionIds') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_candidate -> 'entries') is distinct from 'array' then
    return false;
  end if;

  release_value := p_candidate -> 'applicationRelease';

  select pg_catalog.count(*) = 1 into registration_exact
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_registration_revisions as history
    on history.organization_id = registration.organization_id
    and history.registration_kind = registration.registration_kind
    and history.registration_owner_id = registration.registration_owner_id
    and history.revision = registration.revision
  join vortex_definition.releases as release
    on release.root_id = registration.registration_owner_id
    and release.release_revision = registration.source_revision
    and release.release_version = registration.source_version
    and release.validation_contract_version = registration.validation_contract_version
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
    and registration.revision = p_registration_revision
    and registration.source_definition_key = release_value ->> 'definitionKey'
    and registration.source_version = release_value ->> 'releaseVersion'
    and registration.source_revision = (release_value ->> 'releaseRevision')::bigint
    and registration.validation_contract_version =
      release_value ->> 'validationContractVersion'
    and release.content_fingerprint = release_value ->> 'contentFingerprint'
    and release.resolution_fingerprint = release_value ->> 'resolutionFingerprint'
    and registration.permission_catalogue_fingerprint =
      p_candidate ->> 'applicationCatalogueFingerprint'
    and history.operation in ('register', 'update', 'reactivate')
    and row(
      registration.state, registration.source_definition_key, registration.source_version,
      registration.source_revision, registration.validation_contract_version,
      registration.permission_catalogue_fingerprint,
      registration.changed_at, registration.changed_by, registration.change_correlation_id
    ) is not distinct from row(
      history.state, history.source_definition_key, history.source_version,
      history.source_revision, history.validation_contract_version,
      history.permission_catalogue_fingerprint,
      history.changed_at, history.changed_by, history.change_correlation_id
    );

  if not registration_exact then
    return false;
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'applicationRootId', entry.application_root_id,
        'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id,
        'permission', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'permissionId', entry.permission_id,
          'key', entry.permission_key,
          'label', entry.label,
          'description', entry.description,
          'recordTypeId', entry.record_type_id,
          'recordScope', entry.record_scope,
          'fieldPolicy', entry.field_policy,
          'actionKind', entry.action_kind,
          'namedAction', entry.named_action,
          'administrative', entry.administrative
        )),
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', entry.source_kind,
          'definitionKey', entry.source_definition_key,
          'rootId', entry.source_root_id,
          'releaseRevision', entry.source_revision,
          'releaseVersion', entry.source_version,
          'validationContractVersion', entry.source_validation_contract_version,
          'contentFingerprint', source_release.content_fingerprint,
          'resolutionFingerprint', source_release.resolution_fingerprint
        )
      ) order by
        entry.owner_kind collate "C", entry.owner_id,
        entry.permission_key collate "C", entry.permission_id
    ),
    '[]'::jsonb
  ) into actual_entries
  from vortex_access.permission_catalogue_entries as entry
  left join vortex_definition.releases as source_release
    on source_release.root_id = entry.source_root_id
    and source_release.release_revision = entry.source_revision
    and source_release.release_version = entry.source_version
    and source_release.validation_contract_version =
      entry.source_validation_contract_version
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id
    and entry.registration_revision = p_registration_revision;

  select coalesce(
    pg_catalog.jsonb_agg(entry.permission_id order by
      entry.permission_key collate "C", entry.permission_id),
    '[]'::jsonb
  ) into actual_application_permission_ids
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id
    and entry.registration_revision = p_registration_revision
    and entry.owner_kind = 'application'
    and not entry.administrative;

  return actual_entries = p_candidate -> 'entries'
    and actual_application_permission_ids = p_candidate -> 'applicationPermissionIds';
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end
$$;

ALTER FUNCTION vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) OWNER TO vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) FROM PUBLIC;

grant execute on function vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) to postgres;

create or replace function vortex_access.application_role_template_live_permissions_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_registration_revision bigint,
  p_source_role_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  registration vortex_access.permission_registrations%rowtype;
  selected_template jsonb;
  wildcard boolean;
  resolved_count bigint;
  live_permissions jsonb;
begin
  select stored.* into registration
  from vortex_access.permission_registrations as stored
  where stored.organization_id = p_organization_id
    and stored.registration_kind = 'application'
    and stored.registration_owner_id = p_application_root_id
    and stored.revision = p_registration_revision;
  if not found then
    return null;
  end if;

  -- The source role exactly as the registered Application release declares it.
  select template.value into selected_template
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = registration.source_revision
    and release.release_version = registration.source_version
    and release.validation_contract_version = registration.validation_contract_version
  cross join lateral pg_catalog.jsonb_array_elements(
    release.compilation_output #> '{canonical,content,roles}'
  ) as template(value)
  where root.root_id = p_application_root_id
    and root.organization_id = p_organization_id
    and root.kind = 'application'
    and root.key = registration.source_definition_key
    and (template.value ->> 'roleId')::uuid = p_source_role_id;
  if selected_template is null
    or pg_catalog.jsonb_typeof(selected_template -> 'permissionKeys') is distinct from 'array' then
    return null;
  end if;
  wildcard := selected_template #>> '{permissionSelection,kind}' = 'application_wildcard';

  -- Each template key resolves to exactly one entry of that registration revision, in the
  -- template's own key order: an exact template among every registered entry, a wildcard template
  -- only among the Application's own non-administrative permissions. The live projection of a
  -- wildcard template also leaves out export permissions.
  with resolved as (
    select key.ordinal, entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.administrative, entry.action_kind
    from pg_catalog.jsonb_array_elements_text(selected_template -> 'permissionKeys')
      with ordinality as key(permission_key, ordinal)
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = p_registration_revision
      and entry.permission_key = key.permission_key
      and (
        not wildcard
        or (
          entry.owner_kind = 'application'
          and entry.application_root_id = p_application_root_id
          and entry.owner_id = p_application_root_id
          and not entry.administrative
        )
      )
  )
  select pg_catalog.count(*),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', resolved.application_root_id,
        'ownerKind', resolved.owner_kind,
        'ownerId', resolved.owner_id,
        'permissionId', resolved.permission_id
      )) order by resolved.ordinal) filter (
        where not wildcard or resolved.action_kind <> 'export'
      ), '[]'::jsonb)
  into resolved_count, live_permissions
  from resolved;
  if resolved_count <> pg_catalog.jsonb_array_length(selected_template -> 'permissionKeys') then
    return null;
  end if;

  return live_permissions;
end
$function$;

alter function vortex_access.application_role_template_live_permissions_internal(uuid, uuid, bigint, uuid) owner to vortex_owner;

revoke all on function vortex_access.application_role_template_live_permissions_internal(uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.application_role_template_live_permissions_internal(uuid, uuid, bigint, uuid)
  to vortex_owner;

comment on function vortex_access.application_role_template_live_permissions_internal(uuid, uuid, bigint, uuid) is
  'Private Access projection: the live permission references of one Application source role at one exact registration revision, in template key order, or null when a template key does not resolve to exactly one registered entry. Role-change preparation and the role-change writer both read it, so the prepared evidence names the registration instead of carrying its entries.';

CREATE OR REPLACE FUNCTION vortex_access.apply_application_permission_registration_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  operation_at timestamptz;
  candidate_organization_id uuid;
  candidate_application_root_id uuid;
  candidate_release jsonb;
  candidate_release_revision bigint;
  candidate_release_version text;
  candidate_validation_version text;
  candidate_content_fingerprint text;
  candidate_resolution_fingerprint text;
  candidate_catalogue_fingerprint text;
  current_registration vortex_access.permission_registrations%rowtype;
  next_revision bigint;
  resulting_version bigint;
  entry_value jsonb;
  permission_value jsonb;
  source_value jsonb;
  entry_owner_kind text;
  entry_owner_id uuid;
  entry_source_revision bigint;
  canonical_application_permissions jsonb;
begin
  if p_operation not in ('register', 'update', 'reactivate')
    or p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) <> 'object'
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'register' and p_expected_revision is not null)
    or (p_operation <> 'register' and (p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991))
    or p_candidate - array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries'
    ]::text[] <> '{}'::jsonb
    or not (p_candidate ?& array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries'
    ])
    or p_candidate ->> 'contractVersion' <> '1.0.0'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationRelease') <> 'object'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationPermissionIds') <> 'array'
    or pg_catalog.jsonb_typeof(p_candidate -> 'entries') <> 'array' then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end if;

  begin
    candidate_organization_id := (p_candidate ->> 'organizationId')::uuid;
    candidate_application_root_id := (p_candidate ->> 'applicationRootId')::uuid;
    candidate_release := p_candidate -> 'applicationRelease';
    candidate_release_revision := (candidate_release ->> 'releaseRevision')::bigint;
    candidate_release_version := candidate_release ->> 'releaseVersion';
    candidate_validation_version := candidate_release ->> 'validationContractVersion';
    candidate_content_fingerprint := candidate_release ->> 'contentFingerprint';
    candidate_resolution_fingerprint := candidate_release ->> 'resolutionFingerprint';
    candidate_catalogue_fingerprint := p_candidate ->> 'applicationCatalogueFingerprint';
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end;

  if candidate_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate_release - array[
      'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
      'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
    ]::text[] <> '{}'::jsonb
    or not (candidate_release ?& array[
      'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
      'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
    ])
    or candidate_release ->> 'kind' <> 'application'
    or (candidate_release ->> 'rootId')::uuid <> candidate_application_root_id
    or candidate_release_revision not between 1 and 9007199254740991
    or candidate_catalogue_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = candidate_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501', message = 'Application permission registration scope is unavailable';
  end if;

  select release.compilation_output #> '{canonical,content,permissions}'
  into canonical_application_permissions
    from vortex_definition.roots as root
    join vortex_definition.releases as release on release.root_id = root.root_id
    where root.root_id = candidate_application_root_id
      and root.organization_id = candidate_organization_id
      and root.kind = 'application'
      and root.key = candidate_release ->> 'definitionKey'
      and release.release_revision = candidate_release_revision
      and release.release_version = candidate_release_version
      and release.validation_contract_version = candidate_validation_version
      and release.content_fingerprint = candidate_content_fingerprint
      and release.resolution_fingerprint = candidate_resolution_fingerprint;
  if not found
    or pg_catalog.jsonb_typeof(canonical_application_permissions) is distinct from 'array' then
    raise exception using errcode = '40001', message = 'Application permission release evidence is stale or unavailable';
  end if;

  for entry_value in
    select item.entry from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry)
  loop
    if pg_catalog.jsonb_typeof(entry_value) <> 'object'
      or entry_value - array[
        'applicationRootId', 'ownerKind', 'ownerId', 'permission',
        'sourceRelease'
      ]::text[] <> '{}'::jsonb
      or (entry_value ->> 'applicationRootId')::uuid <> candidate_application_root_id
      or pg_catalog.jsonb_typeof(entry_value -> 'permission') <> 'object'
      or pg_catalog.jsonb_typeof(entry_value -> 'sourceRelease') <> 'object' then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end if;
    permission_value := entry_value -> 'permission';
    source_value := entry_value -> 'sourceRelease';
    begin
      entry_owner_kind := entry_value ->> 'ownerKind';
      entry_owner_id := (entry_value ->> 'ownerId')::uuid;
      entry_source_revision := (source_value ->> 'releaseRevision')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end;
    if entry_owner_kind not in ('application', 'module')
      or entry_owner_id = '00000000-0000-0000-0000-000000000000'::uuid
      or permission_value - array[
        'permissionId', 'key', 'label', 'description', 'recordTypeId',
        'recordScope', 'fieldPolicy', 'actionKind', 'namedAction', 'administrative'
      ]::text[] <> '{}'::jsonb
      or not (permission_value ?& array[
        'permissionId', 'key', 'label', 'description', 'actionKind', 'administrative'
      ])
      or (
        permission_value ? 'recordScope'
        and (
          permission_value ->> 'recordTypeId' is null
          or pg_catalog.jsonb_typeof(permission_value -> 'recordScope') is distinct from 'object'
        )
      )
      or (
        permission_value ? 'fieldPolicy'
        and (
          permission_value ->> 'recordTypeId' is null
          or not vortex_access.permission_field_policy_is_valid(
            permission_value -> 'fieldPolicy'
          )
        )
      )
      or source_value - array[
        'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
        'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
      ]::text[] <> '{}'::jsonb
      or not (source_value ?& array[
        'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
        'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
      ])
      or source_value ->> 'kind' <> entry_owner_kind
      or (source_value ->> 'rootId')::uuid <> entry_owner_id
      or entry_source_revision not between 1 and 9007199254740991 then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end if;
    if entry_owner_kind = 'application' then
      if entry_owner_id <> candidate_application_root_id or source_value <> candidate_release then
        raise exception using errcode = '40001', message = 'Application permission ownership evidence is stale or unavailable';
      end if;
    elsif not exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        candidate_application_root_id, candidate_release_revision
      ) as dependency
      join vortex_definition.roots as module_root on module_root.root_id = dependency.target_root_id
      join vortex_definition.releases as module_release
        on module_release.root_id = dependency.target_root_id
        and module_release.release_revision = dependency.target_release_revision
      where dependency.target_root_id = entry_owner_id
        and dependency.target_release_revision = entry_source_revision
        and dependency.dependency_reference = source_value ->> 'definitionKey'
        and dependency.dependency_version = source_value ->> 'releaseVersion'
        and dependency.dependency_content_fingerprint = source_value ->> 'contentFingerprint'
        and module_root.organization_id = candidate_organization_id
        and module_root.kind = 'module'
        and module_root.key = source_value ->> 'definitionKey'
        and module_release.release_version = source_value ->> 'releaseVersion'
        and module_release.validation_contract_version = source_value ->> 'validationContractVersion'
        and module_release.content_fingerprint = source_value ->> 'contentFingerprint'
        and module_release.resolution_fingerprint = source_value ->> 'resolutionFingerprint'
    ) then
      raise exception using errcode = '40001', message = 'Module permission ownership evidence is stale or unavailable';
    end if;
  end loop;

  if coalesce(
    (
      select pg_catalog.jsonb_agg(stored.permission_value order by
        (stored.permission_value ->> 'key') collate "C",
        (stored.permission_value ->> 'permissionId') collate "C")
      from pg_catalog.jsonb_array_elements(canonical_application_permissions) as stored(permission_value)
    ),
    '[]'::jsonb
  ) is distinct from coalesce(
    (
      select pg_catalog.jsonb_agg(item.entry_value -> 'permission' order by
        (item.entry_value #>> '{permission,key}') collate "C",
        (item.entry_value #>> '{permission,permissionId}') collate "C")
      from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
      where item.entry_value ->> 'ownerKind' = 'application'
    ),
    '[]'::jsonb
  ) then
    raise exception using errcode = '40001', message = 'Application permission declarations are stale or unavailable';
  end if;

  if exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      candidate_application_root_id, candidate_release_revision
    ) as dependency
    join vortex_definition.releases as module_release
      on module_release.root_id = dependency.target_root_id
      and module_release.release_revision = dependency.target_release_revision
    where (
        pg_catalog.jsonb_typeof(
          module_release.compilation_output #> '{canonical,content,permissions}'
        ) is distinct from 'array'
        or coalesce(
          (
            select pg_catalog.jsonb_agg(stored.permission_value order by
              (stored.permission_value ->> 'key') collate "C",
              (stored.permission_value ->> 'permissionId') collate "C")
            from pg_catalog.jsonb_array_elements(
              module_release.compilation_output #> '{canonical,content,permissions}'
            ) as stored(permission_value)
          ),
          '[]'::jsonb
        ) is distinct from coalesce(
          (
            select pg_catalog.jsonb_agg(item.entry_value -> 'permission' order by
              (item.entry_value #>> '{permission,key}') collate "C",
              (item.entry_value #>> '{permission,permissionId}') collate "C")
            from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
            where item.entry_value ->> 'ownerKind' = 'module'
              and (item.entry_value ->> 'ownerId')::uuid = dependency.target_root_id
          ),
          '[]'::jsonb
        )
      )
  ) then
    raise exception using errcode = '40001', message = 'Module permission declarations are stale or unavailable';
  end if;

  if coalesce(
    (
      select pg_catalog.jsonb_agg(item.entry_value order by
        (item.entry_value ->> 'ownerKind') collate "C",
        (item.entry_value ->> 'ownerId') collate "C",
        (item.entry_value #>> '{permission,key}') collate "C",
        (item.entry_value #>> '{permission,permissionId}') collate "C")
      from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
    ),
    '[]'::jsonb
  ) <> p_candidate -> 'entries' then
    raise exception using errcode = '22023', message = 'Application permission entry order is invalid';
  end if;

  if (
    select coalesce(
      pg_catalog.jsonb_agg(permission.permission_value ->> 'permissionId' order by
        (permission.permission_value ->> 'key') collate "C",
        (permission.permission_value ->> 'permissionId') collate "C"),
      '[]'::jsonb
    )
    from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
    cross join lateral (select item.entry_value -> 'permission' as permission_value) as permission
    where item.entry_value ->> 'ownerKind' = 'application'
      and (permission.permission_value ->> 'administrative')::boolean = false
  ) <> p_candidate -> 'applicationPermissionIds' then
    raise exception using errcode = '22023', message = 'Application permission snapshot is invalid';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = candidate_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = candidate_application_root_id;

  if p_operation = 'register' then
    if found then
      raise exception using errcode = '40001', message = 'Application permission registration already exists';
    end if;
    next_revision := 1;
  else
    if not found
      or current_registration.revision <> p_expected_revision
      or current_registration.revision = 9007199254740991
      or (p_operation = 'update' and current_registration.state <> 'active')
      or (p_operation = 'reactivate' and current_registration.state <> 'withdrawn') then
      raise exception using errcode = '40001', message = 'Application permission registration revision is stale or unavailable';
    end if;
    next_revision := current_registration.revision + 1;
  end if;

  if p_operation = 'register' then
    operation_at := pg_catalog.clock_timestamp();
  else
    operation_at := greatest(
      current_registration.changed_at,
      pg_catalog.clock_timestamp()
    );
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    candidate_organization_id, 'application', candidate_application_root_id, next_revision, 'active', p_operation, candidate_release ->> 'definitionKey', candidate_release_version, candidate_release_revision, candidate_validation_version, candidate_catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_catalogue_fingerprint,
    record_scope, field_policy
  )
  select candidate_organization_id, 'application', candidate_application_root_id,
    next_revision, candidate_application_root_id, item.entry_value ->> 'ownerKind',
    (item.entry_value ->> 'ownerId')::uuid,
    (permission.permission_value ->> 'permissionId')::uuid,
    permission.permission_value ->> 'key', permission.permission_value ->> 'label',
    permission.permission_value ->> 'description',
    (permission.permission_value ->> 'recordTypeId')::uuid,
    permission.permission_value ->> 'actionKind',
    permission.permission_value ->> 'namedAction',
    (permission.permission_value ->> 'administrative')::boolean,
    source.source_value ->> 'kind', source.source_value ->> 'definitionKey',
    (source.source_value ->> 'rootId')::uuid, source.source_value ->> 'releaseVersion',
    (source.source_value ->> 'releaseRevision')::bigint,
    source.source_value ->> 'validationContractVersion', null,
    permission.permission_value -> 'recordScope',
    permission.permission_value -> 'fieldPolicy'
  from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
  cross join lateral (select item.entry_value -> 'permission' as permission_value) as permission
  cross join lateral (select item.entry_value -> 'sourceRelease' as source_value) as source;

  if p_operation = 'register' then
    insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state, revision, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    candidate_organization_id, 'application', candidate_application_root_id, 'active', next_revision, candidate_release ->> 'definitionKey', candidate_release_version, candidate_release_revision, candidate_validation_version, candidate_catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );
  else
    update vortex_access.permission_registrations as registration
    set state = 'active', revision = next_revision,
        source_definition_key = candidate_release ->> 'definitionKey',
        source_version = candidate_release_version,
        source_revision = candidate_release_revision,
        validation_contract_version = candidate_validation_version,
        permission_catalogue_fingerprint = candidate_catalogue_fingerprint,
        changed_at = operation_at, changed_by = p_changed_by,
        change_correlation_id = p_correlation_id
    where registration.organization_id = candidate_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = candidate_application_root_id;
  end if;

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    candidate_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;

  return query select p_operation, candidate_organization_id, candidate_application_root_id,
    'active'::text, next_revision, resulting_version, p_correlation_id;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
end
$_$;

ALTER FUNCTION vortex_access.apply_application_permission_registration_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.apply_application_permission_registration_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) IS 'The registration writer of the coordinated application-access change; owner-only.';

REVOKE ALL ON FUNCTION vortex_access.apply_application_permission_registration_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.apply_application_permission_registration_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) to postgres;

create or replace function vortex_access.appoint_organization_steward_for_administration(
  p_organization_account_id uuid,
  p_expected_account_revision bigint
)
returns table (
  outcome text,
  organization_id uuid,
  appointment_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  platform_owner_id uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_channel text;
  locked_access_version bigint;
  stewardship_requirement vortex_access.organization_stewardship_requirements%rowtype;
  target_account vortex_identity.organization_accounts%rowtype;
  steward_role vortex_access.organization_roles%rowtype;
  steward_role_revision vortex_access.organization_role_revisions%rowtype;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  delegation_fact vortex_access.organization_delegation_authorities%rowtype;
  decision record;
  role_decision record;
  version_change record;
  affected_permissions jsonb;
  guarded_minimum jsonb;
  current_guarded_minimum jsonb;
  catalogue_declaration jsonb;
  existing_steward_role_id uuid;
  existing_role_assignment_id uuid;
  existing_delegation_authority_id uuid;
  steward_role_is_qualified boolean;
  generated_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  generated_delegation_authority_id uuid := pg_catalog.gen_random_uuid();
  activity_id uuid;
  activity_result text;
  appointment_starts_at timestamptz;
  authorization_checked_at timestamptz;
  result_summary jsonb;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_account_revision is null
    or p_expected_account_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Organization steward appointment input is invalid';
  end if;

  platform_owner_id := (vortex_access.required_platform_permission('platform.organization.assignments.manage') ->> 'ownerId')::uuid;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_channel := vortex_platform.channel();

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
      message = 'Organization steward appointment is unavailable';
  end if;

  select requirement.* into stewardship_requirement
  from vortex_access.organization_stewardship_requirements as requirement
  where requirement.organization_id = context_organization_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  catalogue_declaration := pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.delegations.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    );
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    catalogue_declaration
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.delegations.grant'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_id := pg_catalog.gen_random_uuid();
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, activity_id, decision.checked_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[],
      context_channel, context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization steward appointment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id
    or decision.reason_code is not null
    or decision.checked_at is null
    or decision.valid_until is null
    or decision.checked_at > pg_catalog.clock_timestamp()
    or decision.valid_until <= pg_catalog.clock_timestamp()
    or decision.valid_until <= decision.checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  appointment_starts_at := pg_catalog.clock_timestamp();
  select account.* into target_account
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as identity
    on identity.identity_id = account.identity_id
  where account.organization_id = context_organization_id
    and account.organization_account_id = p_organization_account_id
    and account.state = 'active'
    and identity.state = 'active'
  for update of account, identity;
  if not found or p_organization_account_id = context_account_id then
    activity_id := pg_catalog.gen_random_uuid();
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, activity_id, appointment_starts_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[],
      context_channel, context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization steward appointment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, null::text;
    return;
  end if;
  -- Match the target against the same live minimum used by the permanent-steward
  -- safeguard. The original adoption role may have changed or another role may
  -- already qualify the target.
  with required_declaration as materialized (
    select declaration.permission_id
    from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration
  ), required_permission as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id,
      registration.revision as registration_revision
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = registration.organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = registration.registration_owner_id
      and entry.registration_revision = registration.revision
    join required_declaration as required
      on required.permission_id = entry.permission_id
    where registration.organization_id = context_organization_id
      and registration.registration_kind = 'platform'
      and registration.registration_owner_id =
        platform_owner_id
      and registration.state = 'active'
      and vortex_access.platform_permission_catalogue_revision_is_exact(
        context_organization_id, registration.revision
      )
      and entry.application_root_id is null
      and entry.owner_kind = 'platform'
      and entry.owner_id = platform_owner_id
  ), qualifying_role as (
    select role.role_id
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = context_organization_id
      and revision.lifecycle = 'active'
      and revision.assignment_policy = 'standing'
      and (select pg_catalog.count(*) from required_declaration) > 0
      and (select pg_catalog.count(distinct permission_id) from required_declaration)
        = (select pg_catalog.count(*) from required_declaration)
      and (select pg_catalog.count(distinct permission_id) from required_permission)
        = (select pg_catalog.count(*) from required_declaration)
      and (select pg_catalog.count(*) from required_permission)
        = (select pg_catalog.count(*) from required_declaration)
      and not exists (
        select 1 from required_permission as required
        where not exists (
          select 1
          from vortex_access.organization_role_permission_entries as permission
          join vortex_access.permission_continuities as continuity
            on continuity.organization_id = permission.organization_id
            and continuity.application_scope_id = coalesce(permission.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
            and continuity.owner_kind = permission.owner_kind
            and continuity.owner_id = permission.owner_id
            and continuity.permission_id = permission.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision = permission.continuity_revision
            and continuity.last_processed_registration_revision = required.registration_revision
          where permission.organization_id = role.organization_id
            and permission.role_id = role.role_id
            and permission.role_revision = role.live_revision
            and permission.application_root_id is not distinct from required.application_root_id
            and permission.owner_kind = required.owner_kind
            and permission.owner_id = required.owner_id
            and permission.permission_id = required.permission_id
        )
      )
  ), current_steward as (
    select assignment.role_assignment_id,
      delegation.delegation_authority_id, role.role_id
    from vortex_access.organization_role_assignments as assignment
    join qualifying_role as role on role.role_id = assignment.role_id
    join vortex_access.organization_delegation_authorities as delegation
      on delegation.organization_id = assignment.organization_id
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = p_organization_account_id
      and delegation.group_id is null
      and delegation.scope_kind = 'organization_catalogue'
      and delegation.state = 'live'
      and delegation.starts_at <= appointment_starts_at
      and delegation.expires_at is null
    where assignment.organization_id = context_organization_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = p_organization_account_id
      and assignment.group_id is null
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= appointment_starts_at
      and assignment.expires_at is null
    order by assignment.role_assignment_id, delegation.delegation_authority_id
    limit 1
  )
  select exists (
      select 1 from qualifying_role as role
      where role.role_id = stewardship_requirement.original_role_id
    ), current_steward_result.role_assignment_id,
    current_steward_result.delegation_authority_id,
    current_steward_result.role_id,
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'permissionId', declaration.permission_id
    ) order by declaration.permission_id) from required_declaration as declaration)
  into steward_role_is_qualified, existing_role_assignment_id,
    existing_delegation_authority_id, existing_steward_role_id, guarded_minimum
  from (select 1) as anchor
  left join current_steward as current_steward_result on true;
  if existing_role_assignment_id is null and steward_role_is_qualified is not true then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select role.* into steward_role
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = coalesce(
      existing_steward_role_id, stewardship_requirement.original_role_id
    )
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select revision.* into steward_role_revision
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = steward_role.role_id
    and revision.revision = steward_role.live_revision
  for share;
  if not found
    or steward_role_revision.lifecycle is distinct from 'active'
    or steward_role_revision.assignment_policy is distinct from 'standing' then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  -- Bind the complete role grant, including every permission beyond the minimum.
  select pg_catalog.jsonb_agg(reference.permission order by
    reference.application_root_id nulls first, reference.owner_kind,
    reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind, 'ownerId', permission.owner_id,
        'permissionId', permission.permission_id,
        'acceptedRegistrationRevision', permission.accepted_registration_revision
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = steward_role.role_id
      and permission.role_revision = steward_role.live_revision
  ) as reference;
  if affected_permissions is null then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  -- Refresh catalogue authority under all initial locks, without changing context.
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    catalogue_declaration
  ) as evaluated;
  select evaluated.* into strict role_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object(
          'kind', 'bounded', 'permissions', affected_permissions
        )
      )
    )
  ) as evaluated;
  authorization_checked_at := pg_catalog.clock_timestamp();
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id
    or decision.reason_code is not null
    or decision.checked_at is null or decision.valid_until is null
    or decision.checked_at > authorization_checked_at
    or decision.valid_until <= authorization_checked_at
    or decision.valid_until <= decision.checked_at
    or role_decision.outcome is distinct from 'eligible'
    or role_decision.operation_key is distinct from 'platform.organization.role_assignments.grant'
    or role_decision.target_kind is distinct from 'organization'
    or role_decision.target_application_root_id is not null
    or role_decision.organization_id is distinct from context_organization_id
    or role_decision.organization_account_id is distinct from context_account_id
    or role_decision.access_version is distinct from context_access_version
    or role_decision.correlation_id is distinct from context_correlation_id
    or role_decision.reason_code is not null
    or role_decision.checked_at is null or role_decision.valid_until is null
    or role_decision.checked_at > authorization_checked_at
    or role_decision.valid_until <= authorization_checked_at
    or role_decision.valid_until <= role_decision.checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'permissionId', declaration.permission_id
  ) order by declaration.permission_id)
  into current_guarded_minimum
  from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration;
  if current_guarded_minimum is distinct from guarded_minimum
    or vortex_access.validated_human_request_context() is distinct from context_value
    or decision.valid_until <= pg_catalog.clock_timestamp()
    or role_decision.valid_until <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  if target_account.revision is distinct from p_expected_account_revision then
    return query select 'conflict'::text, context_organization_id,
      null::jsonb, context_access_version, null::text;
    return;
  end if;
  if existing_role_assignment_id is not null then
    perform vortex_access.assert_organization_has_permanent_steward(
      context_organization_id
    );
    if vortex_access.validated_human_request_context() is distinct from context_value
      or decision.valid_until <= pg_catalog.clock_timestamp()
      or role_decision.valid_until <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Organization steward appointment is unavailable';
    end if;
    result_summary := pg_catalog.jsonb_build_object(
      'organizationAccountId', p_organization_account_id,
      'roleAssignmentId', existing_role_assignment_id,
      'delegationAuthorityId', existing_delegation_authority_id
    );
    return query select 'unchanged'::text, context_organization_id,
      result_summary, context_access_version, null::text;
    return;
  end if;

  appointment_starts_at := pg_catalog.clock_timestamp();
  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id,
    changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    context_organization_id, generated_role_assignment_id, steward_role.role_id,
    'organization_account', p_organization_account_id, null, 'standing', 1,
    appointment_starts_at, null, 'live', context_account_id, appointment_starts_at,
    context_correlation_id, context_account_id, appointment_starts_at,
    context_correlation_id, null, null, null
  ) returning * into assignment_fact;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization steward role grant is stale or unavailable';
  end if;
  insert into vortex_access.organization_delegation_authorities (
    organization_id, delegation_authority_id, holder_kind,
    organization_account_id, group_id, scope_kind, bounded_permissions,
    revision, starts_at, expires_at, state, granted_by,
    granted_at, grant_correlation_id, changed_by, changed_at,
    change_correlation_id, revoked_by, revoked_at, revocation_correlation_id
  ) values (
    context_organization_id, generated_delegation_authority_id,
    'organization_account', p_organization_account_id, null,
    'organization_catalogue', null, 1, appointment_starts_at, null, 'live',
    context_account_id, appointment_starts_at, context_correlation_id,
    context_account_id, appointment_starts_at, context_correlation_id, null, null, null
  ) returning * into delegation_fact;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization steward delegation grant is stale or unavailable';
  end if;

  activity_id := pg_catalog.gen_random_uuid();
  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, activity_id, assignment_fact.changed_at,
    'organization_account', context_account_id, 'grant_role_assignment',
    array[assignment_fact.role_assignment_id]::uuid[], array[]::uuid[],
    context_channel, context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization steward role Activity is stale';
  end if;
  activity_id := pg_catalog.gen_random_uuid();
  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, activity_id, delegation_fact.changed_at,
    'organization_account', context_account_id, 'grant_delegation',
    array[delegation_fact.delegation_authority_id]::uuid[], array[]::uuid[],
    context_channel, context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization steward delegation Activity is stale';
  end if;

  if not exists (
      select 1
      from vortex_access.organization_role_assignments as assignment
      join vortex_access.organization_roles as role
        on role.organization_id = assignment.organization_id
        and role.role_id = assignment.role_id
      join vortex_access.organization_role_revisions as revision
        on revision.organization_id = role.organization_id
        and revision.role_id = role.role_id
        and revision.revision = role.live_revision
      join vortex_access.organization_delegation_authorities as delegation
        on delegation.organization_id = assignment.organization_id
      join vortex_identity.organization_accounts as account
        on account.organization_id = assignment.organization_id
        and account.organization_account_id = assignment.organization_account_id
      join vortex_identity.identity_projections as identity
        on identity.identity_id = account.identity_id
      where assignment.organization_id = context_organization_id
        and assignment.role_assignment_id = generated_role_assignment_id
        and assignment.role_id = stewardship_requirement.original_role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = p_organization_account_id
        and assignment.group_id is null
        and assignment.assignment_kind = 'standing'
        and assignment.revision = 1
        and assignment.state = 'live'
        and assignment.starts_at = appointment_starts_at
        and assignment.expires_at is null
        and assignment.granted_by = context_account_id
        and assignment.granted_at = appointment_starts_at
        and assignment.grant_correlation_id = context_correlation_id
        and assignment.changed_by = context_account_id
        and assignment.changed_at = appointment_starts_at
        and assignment.change_correlation_id = context_correlation_id
        and assignment.revoked_by is null and assignment.revoked_at is null
        and assignment.revocation_correlation_id is null
        and role.live_revision = steward_role.live_revision
        and revision.lifecycle = 'active'
        and revision.assignment_policy = 'standing'
        and delegation.delegation_authority_id = generated_delegation_authority_id
        and delegation.holder_kind = 'organization_account'
        and delegation.organization_account_id = p_organization_account_id
        and delegation.group_id is null
        and delegation.scope_kind = 'organization_catalogue'
        and delegation.bounded_permissions is null
        and delegation.revision = 1
        and delegation.state = 'live'
        and delegation.starts_at = appointment_starts_at
        and delegation.expires_at is null
        and delegation.granted_by = context_account_id
        and delegation.granted_at = appointment_starts_at
        and delegation.grant_correlation_id = context_correlation_id
        and delegation.changed_by = context_account_id
        and delegation.changed_at = appointment_starts_at
        and delegation.change_correlation_id = context_correlation_id
        and delegation.revoked_by is null and delegation.revoked_at is null
        and delegation.revocation_correlation_id is null
        and account.state = 'active'
        and identity.state = 'active'
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(guarded_minimum) as required(value)
          where not exists (
            select 1
            from vortex_access.organization_role_permission_entries as permission
            join vortex_access.permission_continuities as continuity
              on continuity.organization_id = permission.organization_id
              and continuity.application_scope_id = coalesce(permission.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
              and continuity.owner_kind = permission.owner_kind
              and continuity.owner_id = permission.owner_id
              and continuity.permission_id = permission.permission_id
              and continuity.state = 'available'
              and continuity.continuity_revision = permission.continuity_revision
              join vortex_access.permission_registrations as registration
              on registration.organization_id = permission.organization_id
              and registration.registration_kind = 'platform'
              and registration.registration_owner_id =
                platform_owner_id
              and registration.state = 'active'
              and continuity.last_processed_registration_revision = registration.revision
            join vortex_access.permission_catalogue_entries as entry
              on entry.organization_id = registration.organization_id
              and entry.registration_kind = registration.registration_kind
              and entry.registration_owner_id = registration.registration_owner_id
              and entry.registration_revision = registration.revision
              and entry.application_root_id is null
              and entry.owner_kind = 'platform'
              and entry.owner_id = platform_owner_id
              and entry.permission_id = permission.permission_id
            where permission.organization_id = role.organization_id
              and permission.role_id = role.role_id
              and permission.role_revision = role.live_revision
              and permission.application_root_id is null
              and permission.owner_kind = 'platform'
              and permission.owner_id = platform_owner_id
              and permission.permission_id = (required.value ->> 'permissionId')::uuid
          )
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Organization steward appointment result is stale or unavailable';
  end if;

  perform vortex_access.assert_organization_has_permanent_steward(
    context_organization_id
  );
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'permissionId', declaration.permission_id
  ) order by declaration.permission_id)
  into current_guarded_minimum
  from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration;
  authorization_checked_at := pg_catalog.clock_timestamp();
  if current_guarded_minimum is distinct from guarded_minimum
    or vortex_access.validated_human_request_context() is distinct from context_value
    or decision.valid_until <= authorization_checked_at
    or role_decision.valid_until <= authorization_checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select changed.* into strict version_change
  from vortex_access.increment_organization_access_version(
    context_organization_id, context_account_id, context_correlation_id,
    'stewardship_changed'
  ) as changed;
  if version_change.organization_id is distinct from context_organization_id
    or version_change.current_version is distinct from context_access_version + 1
    or version_change.changed_by is distinct from context_account_id
    or version_change.change_correlation_id is distinct from context_correlation_id
    or version_change.change_reason is distinct from 'stewardship_changed' then
    raise exception using errcode = '40001',
      message = 'Organization steward appointment version is stale or unavailable';
  end if;
  result_summary := pg_catalog.jsonb_build_object(
    'organizationAccountId', p_organization_account_id,
    'roleAssignmentId', generated_role_assignment_id,
    'delegationAuthorityId', generated_delegation_authority_id
  );
  return query select 'changed'::text, context_organization_id,
    result_summary, version_change.current_version, null::text;
end
$function$;

revoke execute on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint)
to vortex_request;

comment on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint) is
  'Verified human request entry: atomically appoints another active same-organisation account to the current steward role and catalogue delegation under the original context with one Access increment, safe target-revision conflict and no public operation binding.';

alter function vortex_access.appoint_organization_steward_for_administration(p_organization_account_id uuid, p_expected_account_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.appoint_organization_steward_for_administration(p_organization_account_id uuid, p_expected_account_revision bigint) to postgres;

create or replace function vortex_access.assign_organization_role_assignment_for_administration(
  p_role_assignment_id uuid,
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_assignee_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_assignment_kind text,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  assignment_summary jsonb,
  access_version bigint, refusal_reason text
)
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
  role_fact vortex_access.organization_roles%rowtype;
  revision_fact vortex_access.organization_role_revisions%rowtype;
  affected_permissions jsonb;
  authority_after jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  existing_assignment_id uuid;
  summary_assignment_id uuid;
  changed_at_value timestamptz;
  changed_access_version bigint;
  checked_at timestamptz;
  activity_result text;
begin
  p_starts_at := coalesce(p_starts_at, now());

  if p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_role_revision is null
    or p_expected_role_revision not between 1 and 9007199254740991
    or p_assignee_kind is null
    or p_assignee_kind not in ('organization_account', 'group')
    or p_assignment_kind is null
    or p_assignment_kind not in ('standing', 'eligible')
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or (
      p_assignee_kind = 'organization_account'
      and (
        p_organization_account_id is null
        or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
        or p_group_id is not null
      )
    )
    or (
      p_assignee_kind = 'group'
      and (
        p_group_id is null
        or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
        or p_organization_account_id is not null
      )
    )
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment assignment input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

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
      message = 'Organization role-assignment assignment is unavailable';
  end if;

  select role.* into role_fact
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = p_role_id
  for update;
  if not found or role_fact.live_revision <> p_expected_role_revision then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment is stale or unavailable';
  end if;
  select revision.* into strict revision_fact
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = p_role_id
    and revision.revision = role_fact.live_revision;
  if revision_fact.lifecycle <> 'acceptance_required'
    and (
      revision_fact.lifecycle <> 'active'
      or not (
        (p_assignment_kind = 'standing' and revision_fact.assignment_policy = 'standing')
        or (
          p_assignment_kind = 'eligible'
          and revision_fact.assignment_policy = 'activation_required'
        )
      )
    ) then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment is stale or unavailable';
  end if;

  select pg_catalog.jsonb_agg(reference.permission order by
      reference.application_root_id nulls first, reference.owner_kind,
      reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind,
        'ownerId', permission.owner_id,
        'permissionId', permission.permission_id,
        'acceptedRegistrationRevision', permission.accepted_registration_revision
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = p_role_id
      and permission.role_revision = role_fact.live_revision
  ) as reference;
  if affected_permissions is not null then
    authority_after := pg_catalog.jsonb_build_object(
      'kind', 'bounded', 'permissions', affected_permissions
    );
  elsif revision_fact.lifecycle = 'acceptance_required' then
    authority_after := pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  else
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment authority is stale or unavailable';
  end if;

  authority_requirement := pg_catalog.jsonb_build_object(
    'kind', 'delegated_management',
    'before', pg_catalog.jsonb_build_object('kind', 'none'),
    'after', authority_after
  );

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', authority_requirement
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.role_assignments.grant'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment assignment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.role_assignments.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment assignment is unavailable';
  end if;

  -- Named only to a caller already eligible to assign the role, so its lifecycle is not disclosed.
  if revision_fact.lifecycle = 'acceptance_required' then
    raise exception using errcode = 'V3144',
      message = 'Organization role revision requires acceptance before assignment';
  end if;

  -- One live assignment of a role per assignee: the same role assigned again to the same assignee
  -- with an overlapping live period returns the assignment already in force instead of a second row.
  select existing.role_assignment_id into existing_assignment_id
  from vortex_access.organization_role_assignments as existing
  where existing.organization_id = context_organization_id
    and existing.role_id = p_role_id
    and existing.assignee_kind = p_assignee_kind
    and existing.organization_account_id is not distinct from p_organization_account_id
    and existing.group_id is not distinct from p_group_id
    and existing.assignment_kind = p_assignment_kind
    and existing.state = 'live'
    and existing.role_assignment_id <> p_role_assignment_id
    and existing.starts_at < coalesce(p_expires_at, 'infinity'::timestamptz)
    and coalesce(existing.expires_at, 'infinity'::timestamptz) > p_starts_at
  order by existing.starts_at, existing.role_assignment_id
  limit 1;

  if existing_assignment_id is null then
    select result.* into strict changed
    from vortex_access.coordinate_organization_role_assignment_change(
      'grant', context_organization_id, p_role_assignment_id, null,
      p_role_id, p_expected_role_revision, p_assignee_kind,
      p_organization_account_id, p_group_id, p_assignment_kind,
      p_starts_at, p_expires_at, context_account_id, context_correlation_id
    ) as result;
    summary_assignment_id := p_role_assignment_id;
    changed_at_value := changed.changed_at;
    changed_access_version := changed.access_version;
  else
    summary_assignment_id := existing_assignment_id;
    changed_at_value := pg_catalog.clock_timestamp();
    changed_access_version := context_access_version;
  end if;

  checked_at := pg_catalog.clock_timestamp();
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'roleAssignmentId', assignment.role_assignment_id,
    'role', pg_catalog.jsonb_build_object(
      'roleId', role.role_id, 'key', revision.role_key,
      'label', revision.label, 'lifecycle', revision.lifecycle
    ),
    'assignee', case assignment.assignee_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', assignment.organization_account_id,
        'displayName', account.display_name
      ) else pg_catalog.jsonb_build_object(
        'kind', 'group', 'groupId', assignment.group_id,
        'key', organization_group.group_key, 'label', organization_group.label,
        'state', organization_group.state
      ) end,
    'assignmentKind', assignment.assignment_kind,
    'revision', assignment.revision, 'startsAt', assignment.starts_at,
    'expiresAt', assignment.expires_at, 'state', assignment.state,
    'temporalState', case
      when assignment.state = 'revoked' then 'revoked'
      when assignment.starts_at > checked_at then 'scheduled'
      when assignment.expires_at is not null
        and assignment.expires_at <= checked_at then 'expired'
      else 'active'
    end
  )) into strict changed_summary
  from vortex_access.organization_role_assignments as assignment
  join vortex_access.organization_roles as role
    on role.organization_id = assignment.organization_id
    and role.role_id = assignment.role_id
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id and revision.revision = role.live_revision
  left join vortex_identity.organization_accounts as account
    on assignment.assignee_kind = 'organization_account'
    and account.organization_id = assignment.organization_id
    and account.organization_account_id = assignment.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on assignment.assignee_kind = 'group'
    and organization_group.organization_id = assignment.organization_id
    and organization_group.group_id = assignment.group_id
  where assignment.organization_id = context_organization_id
    and assignment.role_assignment_id = summary_assignment_id;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed_at_value,
    'organization_account', context_account_id,
    case when existing_assignment_id is null
      then 'grant_role_assignment' else 'role_already_assigned' end,
    array[summary_assignment_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed_access_version, null::text;
end
$function$;

revoke execute on function vortex_access.assign_organization_role_assignment_for_administration(uuid, uuid, bigint, text, uuid, uuid, text, timestamptz, timestamptz, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.assign_organization_role_assignment_for_administration(uuid, uuid, bigint, text, uuid, uuid, text, timestamptz, timestamptz, uuid)
to vortex_request;

comment on function vortex_access.assign_organization_role_assignment_for_administration(uuid, uuid, bigint, text, uuid, uuid, text, timestamptz, timestamptz, uuid) is
  'Standalone request entry: performs grant_role_assignment after fixed protected checks of the caller current authority, the delegation subset and the target organisation account, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.assign_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.assign_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) to postgres;

create or replace function vortex_access.check_organization_invitation_role_authority_internal(
  p_organization_id uuid, p_inviter_id uuid, p_role_id uuid, p_checked_at timestamptz
)
returns boolean
language plpgsql stable security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  permissions jsonb;
  authority jsonb;
  delegation record;
begin
  select pg_catalog.jsonb_build_object(
    'organizationId', account.organization_id,
    'organizationAccountId', account.organization_account_id,
    'identityId', account.identity_id,
    'expiresAt', p_checked_at + interval '1 day'
  ) into context_value
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as identity on identity.identity_id = account.identity_id
  join vortex_identity.organizations as organization on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_inviter_id
    and account.state = 'active' and identity.state = 'active'
    and organization.state = 'active' and tenant.state = 'active';
  if context_value is null then return false; end if;

  if not exists (
    select 1 from vortex_access.evaluate_permission_role_path_internal(
      context_value, p_checked_at,
      vortex_access.required_platform_permission('platform.organization.invitations.manage'),
      pg_catalog.jsonb_build_object('actionKind', 'manage'), null
    ) as path where path.path_valid_until > p_checked_at
  ) or not exists (
    select 1 from vortex_access.evaluate_permission_role_path_internal(
      context_value, p_checked_at,
      vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      pg_catalog.jsonb_build_object('actionKind', 'manage'), null
    ) as path where path.path_valid_until > p_checked_at
  ) then return false; end if;

  select pg_catalog.jsonb_agg(reference.permission order by
    reference.application_root_id nulls first, reference.owner_kind,
    reference.owner_id, reference.permission_id)
  into permissions
  from (
    select distinct entry.application_root_id, entry.owner_kind, entry.owner_id, entry.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', entry.application_root_id, 'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id, 'permissionId', entry.permission_id,
        'acceptedRegistrationRevision', entry.accepted_registration_revision
      )) as permission
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_permission_entries as entry
      on entry.organization_id = role.organization_id and entry.role_id = role.role_id
      and entry.role_revision = role.live_revision
    where role.organization_id = p_organization_id and role.role_id = p_role_id
  ) as reference;
  if permissions is null then return false; end if;
  authority := pg_catalog.jsonb_build_object(
    'kind', 'delegated_management', 'before', pg_catalog.jsonb_build_object('kind', 'none'),
    'after', pg_catalog.jsonb_build_object('kind', 'bounded', 'permissions', permissions)
  );
  select * into strict delegation from vortex_access.evaluate_organization_delegation_internal(
    p_organization_id, p_inviter_id, p_checked_at + interval '1 day', p_checked_at, authority
  );
  return delegation.requirement_count > 0 and delegation.requirement_count = delegation.selected_count;
end
$function$;

alter function vortex_access.check_organization_invitation_role_authority_internal(uuid, uuid, uuid, timestamptz) owner to vortex_owner;
revoke all on function vortex_access.check_organization_invitation_role_authority_internal(uuid, uuid, uuid, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.check_organization_invitation_role_authority_internal(uuid, uuid, uuid, timestamptz) to postgres, vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  current_registration vortex_access.permission_registrations%rowtype;
  raw_result record;
  first_observation boolean := false;
  permission_candidate jsonb;
  template_value jsonb;
  template_role_id uuid;
  role_record record;
  target_template jsonb;
  current_permission_count bigint;
  retained_permission_count bigint;
  unchanged_permission_count bigint;
  target_permission_count bigint;
  target_lifecycle text;
  next_role_revision bigint;
  next_authority_continuity_revision bigint;
  target_template_continuity_revision bigint;
begin
  if p_operation is null
    or p_operation not in ('register', 'update', 'reactivate', 'withdraw')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'register' and p_expected_revision is not null)
    or (
      p_operation <> 'register'
      and (
        p_expected_revision is null
        or p_expected_revision not between 1 and 9007199254740991
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Coordinated application access input is invalid';
  end if;

  if p_operation = 'withdraw' then
    if p_prepared_templates is not null then
      raise exception using errcode = '22023',
        message = 'Coordinated application access input is invalid';
    end if;
  else
    if p_prepared_templates is null
      or pg_catalog.jsonb_typeof(p_prepared_templates) is distinct from 'object'
      or p_prepared_templates - array[
        'contractVersion', 'preparationBasis', 'permissionRegistration',
        'templates'
      ]::text[] <> '{}'::jsonb
      or not (p_prepared_templates ?& array[
        'contractVersion', 'preparationBasis', 'permissionRegistration',
        'templates'
      ])
      or p_prepared_templates ->> 'contractVersion' is distinct from '1.0.0'
      or p_prepared_templates -> 'preparationBasis' is distinct from
        '{"kind":"registration_candidate"}'::jsonb
      or pg_catalog.jsonb_typeof(p_prepared_templates -> 'permissionRegistration')
        is distinct from 'object'
      or p_prepared_templates #>> '{permissionRegistration,contractVersion}'
        is distinct from '1.0.0'
      or pg_catalog.jsonb_typeof(p_prepared_templates -> 'templates')
        is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_prepared_templates -> 'templates') = 0
      or (p_prepared_templates #>> '{permissionRegistration,organizationId}')::uuid
        is distinct from
        p_organization_id
      or (p_prepared_templates #>> '{permissionRegistration,applicationRootId}')::uuid
        is distinct from
        p_application_root_id then
      raise exception using errcode = '22023',
        message = 'Coordinated application access preparation is invalid';
    end if;

    permission_candidate := p_prepared_templates -> 'permissionRegistration';
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array['template', 'sourcePermissions', 'livePermissions']::text[]
          <> '{}'::jsonb
        or not (item.value ?& array['template', 'sourcePermissions', 'livePermissions'])
        or pg_catalog.jsonb_typeof(item.value -> 'template') is distinct from 'object'
        or pg_catalog.jsonb_typeof(item.value -> 'sourcePermissions') is distinct from 'array'
        or pg_catalog.jsonb_typeof(item.value -> 'livePermissions') is distinct from 'array'
        or item.value #>> '{template,roleId}' is null
        or (item.value #>> '{template,roleId}')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      group by item.value #>> '{template,roleId}'
      having pg_catalog.count(*) <> 1
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        item.value -> 'livePermissions'
      ) as live(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(permission_candidate -> 'entries') as entry(value)
        where entry.value = live.value
      )
    ) then
      raise exception using errcode = '22023',
        message = 'Coordinated application access preparation is invalid';
    end if;
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Coordinated application access scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
  for update;

  if p_operation = 'register' then
    if found then
      raise exception using errcode = '40001',
        message = 'Application permission registration already exists';
    end if;
  elsif not found
    or current_registration.revision <> p_expected_revision
    or (p_operation in ('update', 'withdraw') and current_registration.state <> 'active')
    or (p_operation = 'reactivate' and current_registration.state <> 'withdrawn') then
    raise exception using errcode = '40001',
      message = 'Application permission registration revision is stale or unavailable';
  end if;

  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id = p_application_root_id
  order by continuity.application_scope_id, continuity.owner_kind collate "C",
    continuity.owner_id, continuity.permission_id
  for update;

  perform 1
  from vortex_access.application_role_template_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id = p_application_root_id
  order by continuity.source_role_id
  for update;

  perform 1
  from vortex_access.organization_roles as role
  where role.organization_id = p_organization_id
    and role.role_kind = 'application'
    and role.application_root_id = p_application_root_id
  order by role.role_id
  for update;

  if p_operation <> 'register' then
    first_observation :=
      not exists (
        select 1
        from vortex_access.permission_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.application_role_template_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_roles as role
        where role.organization_id = p_organization_id
          and role.role_kind = 'application'
          and role.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_role_revisions as revision
        where revision.organization_id = p_organization_id
          and revision.role_kind = 'application'
          and revision.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = p_organization_id
          and permission.application_root_id = p_application_root_id
      );

    if p_operation = 'update'
      and vortex_access.application_permission_registration_matches_candidate(
        p_organization_id, p_application_root_id, current_registration.revision,
        permission_candidate
      )
      and not first_observation then
      if not vortex_access.application_access_current_state_matches_candidate(
          p_organization_id, p_application_root_id, current_registration.revision,
          p_prepared_templates
      ) then
        raise exception using errcode = '55000',
          message = 'Coordinated application access state is incomplete';
      end if;

      return query
      select 'unchanged'::text, p_operation, p_organization_id, p_application_root_id,
        current_registration.state, current_registration.revision,
        version.current_version, p_correlation_id
      from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id;
      return;
    end if;

    if current_registration.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Application permission registration revision is exhausted';
    end if;
  end if;

  -- The organization version row is already locked. Check before invoking the
  -- registration helper, whose input-error handler also catches numeric overflow.
  -- A complete exact no-op returned above does not need a new Access version.
  if exists (
    select 1 from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id
      and version.current_version >= 9007199254740991
  ) then
    raise exception using errcode = '22003',
      message = 'Organization Access version is exhausted';
  end if;

  if first_observation then
    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id, permission_id,
      registration_kind, registration_owner_id, state, continuity_revision,
      last_processed_registration_revision, changed_at
    )
    select entry.organization_id, entry.application_root_id, entry.owner_kind,
      entry.owner_id, entry.permission_id, 'application', p_application_root_id,
      case when current_registration.state = 'active' then 'available' else 'unavailable' end,
      1, current_registration.revision,
      pg_catalog.statement_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = current_registration.revision;
  end if;

  if not first_observation
    and current_registration.state = 'active'
    and not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
    ) then
    raise exception using errcode = '55000',
      message = 'Coordinated application access state is incomplete';
  end if;

  if p_operation = 'withdraw' then
    select changed.* into strict raw_result
    from vortex_access.withdraw_application_permission_registration_internal(
      p_organization_id, p_application_root_id, p_expected_revision,
      p_changed_by, p_correlation_id
    ) as changed;
  else
    select changed.* into strict raw_result
    from vortex_access.apply_application_permission_registration_internal(
      p_operation, p_expected_revision, permission_candidate,
      p_changed_by, p_correlation_id
    ) as changed;
  end if;

  -- A still-available permission retains continuity only while its protected
  -- authority-bearing fields match the previous registration exactly.
  if exists (
    select 1 from vortex_access.permission_continuities as continuity
    join vortex_access.permission_catalogue_entries as target
      on target.organization_id = continuity.organization_id
      and target.registration_kind = continuity.registration_kind
      and target.registration_owner_id = continuity.registration_owner_id
      and target.registration_revision = raw_result.registration_revision
      and target.application_root_id is not distinct from continuity.application_root_id
      and target.owner_kind = continuity.owner_kind
      and target.owner_id = continuity.owner_id
      and target.permission_id = continuity.permission_id
    left join vortex_access.permission_catalogue_entries as previous
      on previous.organization_id = continuity.organization_id
      and previous.registration_kind = continuity.registration_kind
      and previous.registration_owner_id = continuity.registration_owner_id
      and previous.registration_revision = continuity.last_processed_registration_revision
      and previous.application_root_id is not distinct from continuity.application_root_id
      and previous.owner_kind = continuity.owner_kind
      and previous.owner_id = continuity.owner_id
      and previous.permission_id = continuity.permission_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.state = 'available'
      and raw_result.registration_state = 'active'
      and previous.permission_id is null
  ) then
    raise exception using errcode = '55000',
      message = 'Previous permission meaning is unavailable';
  end if;

  if exists (
    with target as (
      select entry.application_root_id, entry.owner_kind, entry.owner_id,
        entry.permission_id, entry as target_entry
      from vortex_access.permission_catalogue_entries as entry
      where raw_result.registration_state = 'active'
        and entry.organization_id = p_organization_id
        and entry.registration_kind = 'application'
        and entry.registration_owner_id = p_application_root_id
        and entry.registration_revision = raw_result.registration_revision
    )
    select 1 from vortex_access.permission_continuities as continuity
    left join target on target.application_root_id = continuity.application_root_id
      and target.owner_kind = continuity.owner_kind and target.owner_id = continuity.owner_id
      and target.permission_id = continuity.permission_id
    left join vortex_access.permission_catalogue_entries as previous
      on previous.organization_id = continuity.organization_id
      and previous.registration_kind = continuity.registration_kind
      and previous.registration_owner_id = continuity.registration_owner_id
      and previous.registration_revision = continuity.last_processed_registration_revision
      and previous.application_root_id is not distinct from continuity.application_root_id
      and previous.owner_kind = continuity.owner_kind and previous.owner_id = continuity.owner_id
      and previous.permission_id = continuity.permission_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.continuity_revision = 9007199254740991
      and (
        (target.permission_id is null and continuity.state <> 'unavailable')
        or (target.permission_id is not null and continuity.state <> 'available')
        or (target.permission_id is not null and continuity.state = 'available'
          and not vortex_access.permission_meaning_is_same_internal(previous, target.target_entry))
      )
  ) then
    raise exception using errcode = '22003',
      message = 'Application permission continuity revision is exhausted';
  end if;

  with target as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry as target_entry
    from vortex_access.permission_catalogue_entries as entry
    where raw_result.registration_state = 'active'
      and entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = raw_result.registration_revision
  ), transition as (
    select continuity.ctid as continuity_row, target.permission_id as target_permission_id,
      vortex_access.permission_meaning_is_same_internal(previous, target.target_entry) as same_meaning
    from vortex_access.permission_continuities as continuity
    left join target on target.application_root_id = continuity.application_root_id
      and target.owner_kind = continuity.owner_kind and target.owner_id = continuity.owner_id
      and target.permission_id = continuity.permission_id
    left join vortex_access.permission_catalogue_entries as previous
      on previous.organization_id = continuity.organization_id
      and previous.registration_kind = continuity.registration_kind
      and previous.registration_owner_id = continuity.registration_owner_id
      and previous.registration_revision = continuity.last_processed_registration_revision
      and previous.application_root_id is not distinct from continuity.application_root_id
      and previous.owner_kind = continuity.owner_kind and previous.owner_id = continuity.owner_id
      and previous.permission_id = continuity.permission_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
  )
  update vortex_access.permission_continuities as continuity
  set state = case when transition.target_permission_id is null then 'unavailable'
        else 'available' end,
      continuity_revision = case
        when transition.target_permission_id is not null and continuity.state = 'available'
          and transition.same_meaning then continuity.continuity_revision
        when transition.target_permission_id is null and continuity.state = 'unavailable'
          then continuity.continuity_revision
        else continuity.continuity_revision + 1
      end,
      last_processed_registration_revision = raw_result.registration_revision,
      changed_at = pg_catalog.statement_timestamp()
  from transition
  where continuity.ctid = transition.continuity_row;

  if raw_result.registration_state = 'active' then
    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id, permission_id,
      registration_kind, registration_owner_id, state, continuity_revision,
      last_processed_registration_revision, changed_at
    )
    select entry.organization_id, entry.application_root_id, entry.owner_kind,
      entry.owner_id, entry.permission_id, 'application', p_application_root_id,
      'available', 1, raw_result.registration_revision,
      pg_catalog.statement_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = raw_result.registration_revision
      and not exists (
        select 1
        from vortex_access.permission_continuities as continuity
        where continuity.organization_id = entry.organization_id
          and continuity.application_root_id = entry.application_root_id
          and continuity.owner_kind = entry.owner_kind
          and continuity.owner_id = entry.owner_id
          and continuity.permission_id = entry.permission_id
      );
  end if;

  if exists (
    with target as (
      select (item.value #>> '{template,roleId}')::uuid as source_role_id
      from pg_catalog.jsonb_array_elements(
        case when raw_result.registration_state = 'active'
          then p_prepared_templates -> 'templates'
          else '[]'::jsonb
        end
      ) as item(value)
    )
    select 1
    from vortex_access.application_role_template_continuities as continuity
    left join target on target.source_role_id = continuity.source_role_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.continuity_revision = 9007199254740991
      and (
        (target.source_role_id is null and continuity.state <> 'unavailable')
        or (
          target.source_role_id is not null
          and continuity.state <> 'available'
        )
      )
  ) then
    raise exception using errcode = '22003',
      message = 'Application role template continuity revision is exhausted';
  end if;

  with target as (
    select (item.value #>> '{template,roleId}')::uuid as source_role_id,
      item.value #>> '{template,key}' as role_key,
      item.value #>> '{template,name}' as role_label
    from pg_catalog.jsonb_array_elements(
      case when raw_result.registration_state = 'active'
        then p_prepared_templates -> 'templates'
        else '[]'::jsonb
      end
    ) as item(value)
  ), transition as (
    select continuity.ctid as continuity_row, target.source_role_id as target_role_id,
      target.role_key, target.role_label
    from vortex_access.application_role_template_continuities as continuity
    left join target on target.source_role_id = continuity.source_role_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
  )
  update vortex_access.application_role_template_continuities as continuity
  set state = case when transition.target_role_id is null
        then 'unavailable' else 'available' end,
      key = coalesce(transition.role_key, continuity.key),
      label = coalesce(transition.role_label, continuity.label),
      continuity_revision = case
        when transition.target_role_id is not null and continuity.state = 'available'
          then continuity.continuity_revision
        when transition.target_role_id is null and continuity.state = 'unavailable'
          then continuity.continuity_revision
        else continuity.continuity_revision + 1
      end,
      last_processed_registration_revision = raw_result.registration_revision,
      changed_at = pg_catalog.statement_timestamp()
  from transition
  where continuity.ctid = transition.continuity_row;

  if raw_result.registration_state = 'active' then
    insert into vortex_access.application_role_template_continuities (
      organization_id, application_root_id, source_role_id, state,
      continuity_revision, last_processed_registration_revision, changed_at,
      key, label
    )
    select p_organization_id, p_application_root_id,
      (item.value #>> '{template,roleId}')::uuid, 'available', 1,
      raw_result.registration_revision, pg_catalog.statement_timestamp(),
      item.value #>> '{template,key}', item.value #>> '{template,name}'
    from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
    where not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.source_role_id = (item.value #>> '{template,roleId}')::uuid
    );
  end if;

  for role_record in
    select role.role_id, role.source_role_id, role.live_revision,
      revision.lifecycle, revision.privilege_classification,
      revision.assignment_policy, revision.policy_continuity_revision,
      revision.authority_continuity_revision,
      revision.activation_policy_id, revision.activation_policy_revision,
      revision.role_key,
      revision.label, revision.description, revision.source_definition_key,
      revision.source_release_revision, revision.source_release_version,
      revision.source_validation_contract_version,
      revision.accepted_registration_revision,
      revision.template_continuity_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_kind = 'application'
      and role.application_root_id = p_application_root_id
    order by role.role_id
  loop
    if role_record.lifecycle = 'retired' then
      continue;
    end if;

    target_template := null;
    target_template_continuity_revision := null;
    if raw_result.registration_state = 'active' then
      select item.value, continuity.continuity_revision
      into target_template, target_template_continuity_revision
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates')
        as item(value)
      join vortex_access.application_role_template_continuities as continuity
        on continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.source_role_id =
          (item.value #>> '{template,roleId}')::uuid
        and continuity.state = 'available'
      where (item.value #>> '{template,roleId}')::uuid = role_record.source_role_id;
    end if;

    select pg_catalog.count(*) into current_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = p_organization_id
      and permission.role_id = role_record.role_id
      and permission.role_revision = role_record.live_revision;

    if target_template is null then
      retained_permission_count := 0;
      target_permission_count := 0;
      target_lifecycle := 'unavailable';
    else
      -- A role keeps every permission the template still grants, with the
      -- meaning it was accepted under: a changed meaning is neither applied
      -- nor dropped until the role revision is accepted. A permission the
      -- template no longer grants, or that is no longer registered, leaves.
      select pg_catalog.count(*) into retained_permission_count
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.live_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
        );
      select pg_catalog.count(*) into unchanged_permission_count
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.live_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
        );
      target_permission_count := pg_catalog.jsonb_array_length(
        target_template -> 'livePermissions'
      );
      -- ACCEPTANCE INVARIANT: a role stays active only when it holds every
      -- permission of the template with exactly its registered meaning. Any
      -- meaning change, added or removed permission requires acceptance. The
      -- release version class (patch, minor or major) is never consulted.
      if role_record.lifecycle = 'active'
        and unchanged_permission_count > 0
        and unchanged_permission_count = target_permission_count
        and retained_permission_count = target_permission_count
        and role_record.template_continuity_revision =
          target_template_continuity_revision then
        target_lifecycle := 'active';
      else
        target_lifecycle := 'acceptance_required';
      end if;
    end if;

    if role_record.lifecycle = target_lifecycle
      and current_permission_count = retained_permission_count then
      continue;
    end if;

    if role_record.live_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role revision is exhausted';
    end if;
    next_role_revision := role_record.live_revision + 1;
    next_authority_continuity_revision :=
      role_record.authority_continuity_revision;
    if role_record.lifecycle in ('unavailable', 'retired')
      and target_lifecycle in ('active', 'acceptance_required') then
      if role_record.authority_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role authority continuity is exhausted';
      end if;
      next_authority_continuity_revision :=
        role_record.authority_continuity_revision + 1;
    end if;

    if target_template is not null then
      insert into vortex_access.organization_role_permission_entries (
        organization_id, role_id, role_revision, entry_ordinal, role_kind,
        role_application_root_id, application_root_id, owner_kind, owner_id,
        permission_id, registration_kind, registration_owner_id,
        accepted_registration_revision, catalogue_fingerprint,
        continuity_revision
      )
      select permission.organization_id, permission.role_id, next_role_revision,
        pg_catalog.row_number() over (
          order by permission.application_root_id, permission.owner_kind collate "C",
            permission.owner_id, permission.permission_id
        ), permission.role_kind, permission.role_application_root_id,
        permission.application_root_id, permission.owner_kind,
        permission.owner_id, permission.permission_id,
        permission.registration_kind, permission.registration_owner_id,
        permission.accepted_registration_revision,
        permission.catalogue_fingerprint, permission.continuity_revision
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.live_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
        );
    end if;

    insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, application_root_id,
      lifecycle, privilege_classification, assignment_policy,
      policy_continuity_revision, authority_continuity_revision,
      activation_policy_id,
      activation_policy_revision, role_key,
      label, description, source_definition_key, source_release_revision,
      source_release_version, source_validation_contract_version, accepted_registration_revision,
      template_continuity_revision,
      changed_by, changed_at, change_correlation_id
    ) values (
      p_organization_id, role_record.role_id, next_role_revision, 'application',
      p_application_root_id, target_lifecycle,
      role_record.privilege_classification, role_record.assignment_policy,
      role_record.policy_continuity_revision,
      next_authority_continuity_revision, role_record.activation_policy_id,
      role_record.activation_policy_revision,
      role_record.role_key,
      role_record.label, role_record.description,
      role_record.source_definition_key, role_record.source_release_revision,
      role_record.source_release_version,
      role_record.source_validation_contract_version,
      role_record.accepted_registration_revision,
      role_record.template_continuity_revision,
      p_changed_by,
      pg_catalog.statement_timestamp(), p_correlation_id
    );

    update vortex_access.organization_roles as role
    set live_revision = next_role_revision
    where role.organization_id = p_organization_id
      and role.role_id = role_record.role_id
      and role.live_revision = role_record.live_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role revision is stale';
    end if;
  end loop;

  return query select 'changed'::text, raw_result.operation,
    raw_result.organization_id, raw_result.application_root_id,
    raw_result.registration_state, raw_result.registration_revision,
    raw_result.access_version, raw_result.correlation_id;
exception
  when invalid_text_representation then
    raise exception using errcode = '22023',
      message = 'Coordinated application access input is invalid';
end
$_$;

COMMENT ON FUNCTION vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) IS 'Internal application-access implementation retained only behind the stewardship safeguard.';

REVOKE ALL ON FUNCTION vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

alter function vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

grant execute on function vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;

create or replace function vortex_access.coordinate_organization_role_activation_change(
  p_operation text,
  p_organization_id uuid,
  p_role_activation_id uuid,
  p_expected_activation_revision bigint,
  p_organization_account_id uuid,
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_requested_duration_seconds bigint,
  p_eligibility_source_kind text,
  p_role_assignment_id uuid,
  p_expected_role_assignment_revision bigint,
  p_membership_id uuid,
  p_expected_membership_revision bigint,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  activation jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  role_fact record;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  membership_fact vortex_access.organization_group_memberships%rowtype;
  activation_fact vortex_access.organization_role_activations%rowtype;
  checked_at timestamptz;
  operation_at timestamptz;
  duration_cap_seconds numeric;
  source_seconds numeric;
  activation_expires_at timestamptz;
  next_access_version bigint;
begin
  if p_operation is null
    or p_operation not in ('activate_role', 'revoke_role_activation')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_activation_id is null
    or p_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-activation change input is invalid';
  end if;

  if p_operation = 'activate_role' then
    if p_expected_activation_revision is not null
      or p_organization_account_id is null
      or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_role_id is null
      or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_revision is null
      or p_expected_role_revision not between 1 and 9007199254740991
      or p_requested_duration_seconds is null
      or p_requested_duration_seconds not between 1 and 9007199254740991
      or p_eligibility_source_kind is null
      or p_eligibility_source_kind not in ('direct', 'group')
      or p_role_assignment_id is null
      or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_assignment_revision is null
      or p_expected_role_assignment_revision not between 1 and 9007199254740991
      or (
        p_eligibility_source_kind = 'direct'
        and (
          p_membership_id is not null
          or p_expected_membership_revision is not null
        )
      )
      or (
        p_eligibility_source_kind = 'group'
        and (
          p_membership_id is null
          or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
          or p_expected_membership_revision is null
          or p_expected_membership_revision not between 1 and 9007199254740991
        )
      ) then
      raise exception using errcode = '22023',
        message = 'Organization role activation input is invalid';
    end if;
  elsif p_expected_activation_revision is null
    or p_expected_activation_revision not between 1 and 9007199254740991
    or p_organization_account_id is not null
    or p_role_id is not null
    or p_expected_role_revision is not null
    or p_requested_duration_seconds is not null
    or p_eligibility_source_kind is not null
    or p_role_assignment_id is not null
    or p_expected_role_assignment_revision is not null
    or p_membership_id is not null
    or p_expected_membership_revision is not null then
    raise exception using errcode = '22023',
      message = 'Organization role-activation revocation input is invalid';
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
      message = 'Organization role-activation change scope is unavailable';
  end if;

  if p_operation = 'activate_role' then
    if exists (
      select 1
      from vortex_access.organization_role_activations as stored_activation
      where stored_activation.organization_id = p_organization_id
        and stored_activation.role_activation_id = p_role_activation_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation is stale or unavailable';
    end if;

    select role.live_revision, revision.lifecycle, revision.assignment_policy,
      revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision,
      policy.maximum_activation_duration_seconds
    into role_fact
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_activation_policy_revisions as policy
      on policy.organization_id = revision.organization_id
      and policy.role_id = revision.role_id
      and policy.activation_policy_id = revision.activation_policy_id
      and policy.revision = revision.activation_policy_revision
    where role.organization_id = p_organization_id
      and role.role_id = p_role_id
    for update of role;

    if not found
      or role_fact.live_revision <> p_expected_role_revision
      or role_fact.lifecycle not in ('active', 'acceptance_required')
      or role_fact.assignment_policy <> 'activation_required'
      or not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        join vortex_access.permission_continuities as continuity
          on continuity.organization_id = permission.organization_id
          and continuity.application_scope_id = coalesce(permission.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
          and continuity.owner_kind = permission.owner_kind
          and continuity.owner_id = permission.owner_id
          and continuity.permission_id = permission.permission_id
          and continuity.state = 'available'
          and continuity.continuity_revision = permission.continuity_revision
        where permission.organization_id = p_organization_id
          and permission.role_id = p_role_id
          and permission.role_revision = p_expected_role_revision
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation role evidence is stale or unavailable';
    end if;

    perform 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active'
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role activation account is stale or unavailable';
    end if;

    select assignment.* into assignment_fact
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = p_organization_id
      and assignment.role_assignment_id = p_role_assignment_id
    for update;
    if not found
      or assignment_fact.role_id <> p_role_id
      or assignment_fact.assignment_kind <> 'eligible'
      or assignment_fact.revision <> p_expected_role_assignment_revision
      or assignment_fact.state <> 'live'
      or (
        p_eligibility_source_kind = 'direct'
        and (
          assignment_fact.assignee_kind <> 'organization_account'
          or assignment_fact.organization_account_id <> p_organization_account_id
        )
      )
      or (
        p_eligibility_source_kind = 'group'
        and assignment_fact.assignee_kind <> 'group'
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation eligibility is stale or unavailable';
    end if;

    if p_eligibility_source_kind = 'group' then
      perform 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = assignment_fact.group_id
        and organization_group.state = 'active'
      for update;
      if not found then
        raise exception using errcode = '40001',
          message = 'Organization role activation Group is stale or unavailable';
      end if;

      select membership.* into membership_fact
      from vortex_access.organization_group_memberships as membership
      where membership.organization_id = p_organization_id
        and membership.membership_id = p_membership_id
      for update;
      if not found
        or membership_fact.group_id <> assignment_fact.group_id
        or membership_fact.organization_account_id <> p_organization_account_id
        or membership_fact.revision <> p_expected_membership_revision
        or membership_fact.state <> 'live' then
        raise exception using errcode = '40001',
          message = 'Organization role activation membership is stale or unavailable';
      end if;
    end if;

    checked_at := pg_catalog.clock_timestamp();
    if assignment_fact.starts_at > checked_at
      or (
        assignment_fact.expires_at is not null
        and assignment_fact.expires_at <= checked_at
      )
      or (
        p_eligibility_source_kind = 'group'
        and (
          membership_fact.starts_at > checked_at
          or (
            membership_fact.expires_at is not null
            and membership_fact.expires_at <= checked_at
          )
        )
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation source window is no longer current';
    end if;

    duration_cap_seconds := least(
      p_requested_duration_seconds::numeric,
      role_fact.maximum_activation_duration_seconds::numeric
    );
    if assignment_fact.expires_at is not null then
      source_seconds := extract(
        epoch from assignment_fact.expires_at - checked_at
      );
      duration_cap_seconds := least(
        duration_cap_seconds,
        source_seconds
      );
    end if;
    if p_eligibility_source_kind = 'group'
      and membership_fact.expires_at is not null then
      source_seconds := extract(
        epoch from membership_fact.expires_at - checked_at
      );
      duration_cap_seconds := least(
        duration_cap_seconds,
        source_seconds
      );
    end if;
    if duration_cap_seconds <= 0 then
      raise exception using errcode = '40001',
        message = 'Organization role activation source window is no longer current';
    end if;

    begin
      activation_expires_at := checked_at +
        (duration_cap_seconds::double precision * interval '1 second');
    exception
      when datetime_field_overflow or numeric_value_out_of_range then
        raise exception using errcode = '22023',
          message = 'Organization role activation duration is not representable';
    end;
    if assignment_fact.expires_at is not null then
      activation_expires_at := least(
        activation_expires_at,
        assignment_fact.expires_at
      );
    end if;
    if p_eligibility_source_kind = 'group'
      and membership_fact.expires_at is not null then
      activation_expires_at := least(
        activation_expires_at,
        membership_fact.expires_at
      );
    end if;
    if activation_expires_at in (
      '-infinity'::timestamptz, 'infinity'::timestamptz
    ) or activation_expires_at <= checked_at then
      raise exception using errcode = '22023',
        message = 'Organization role activation duration is not representable';
    end if;

    insert into vortex_access.organization_role_activations (
      organization_id, role_activation_id, organization_account_id, role_id,
      revision, historical_role_revision, authority_continuity_revision,
      policy_continuity_revision, activation_policy_id,
      activation_policy_revision,
      eligibility_source_kind, role_assignment_id, role_assignment_revision,
      membership_id, membership_revision, state, activated_by, activated_at,
      expires_at, activation_correlation_id, changed_by, changed_at,
      change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      p_organization_id, p_role_activation_id, p_organization_account_id,
      p_role_id, 1, p_expected_role_revision,
      role_fact.authority_continuity_revision,
      role_fact.policy_continuity_revision, role_fact.activation_policy_id,
      role_fact.activation_policy_revision, p_eligibility_source_kind,
      p_role_assignment_id, p_expected_role_assignment_revision,
      p_membership_id, p_expected_membership_revision, 'live', p_changed_by,
      checked_at, activation_expires_at, p_correlation_id, p_changed_by,
      checked_at, p_correlation_id, null, null, null
    ) returning * into activation_fact;
  else
    select stored_activation.* into activation_fact
    from vortex_access.organization_role_activations as stored_activation
    where stored_activation.organization_id = p_organization_id
      and stored_activation.role_activation_id = p_role_activation_id
    for update;

    if not found
      or activation_fact.revision <> p_expected_activation_revision
      or activation_fact.state <> 'live' then
      raise exception using errcode = '40001',
        message = 'Organization role-activation revocation is stale or unavailable';
    end if;
    if activation_fact.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role activation revision is exhausted';
    end if;

    operation_at := greatest(
      activation_fact.changed_at,
      pg_catalog.clock_timestamp()
    );
    update vortex_access.organization_role_activations as stored_activation
    set revision = activation_fact.revision + 1,
      state = 'revoked',
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id,
      revoked_by = p_changed_by,
      revoked_at = operation_at,
      revocation_correlation_id = p_correlation_id
    where stored_activation.organization_id = p_organization_id
      and stored_activation.role_activation_id = p_role_activation_id
      and stored_activation.revision = p_expected_activation_revision
      and stored_activation.state = 'live'
    returning stored_activation.* into activation_fact;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role-activation revocation is stale or unavailable';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_activation_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'roleActivationId', activation_fact.role_activation_id,
      'organizationId', activation_fact.organization_id,
      'organizationAccountId', activation_fact.organization_account_id,
      'roleId', activation_fact.role_id,
      'revision', activation_fact.revision,
      'historicalRoleRevision', activation_fact.historical_role_revision,
      'authorityContinuityRevision',
        activation_fact.authority_continuity_revision,
      'policyContinuityRevision', activation_fact.policy_continuity_revision,
      'activationPolicy', pg_catalog.jsonb_build_object(
        'activationPolicyId', activation_fact.activation_policy_id,
        'revision', activation_fact.activation_policy_revision
      ),
      'eligibilitySource', case activation_fact.eligibility_source_kind
        when 'direct' then pg_catalog.jsonb_build_object(
          'kind', 'direct',
          'eligibilityAssignment', pg_catalog.jsonb_build_object(
            'roleAssignmentId', activation_fact.role_assignment_id,
            'revision', activation_fact.role_assignment_revision
          )
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'group',
          'eligibilityAssignment', pg_catalog.jsonb_build_object(
            'roleAssignmentId', activation_fact.role_assignment_id,
            'revision', activation_fact.role_assignment_revision
          ),
          'originatingMembership', pg_catalog.jsonb_build_object(
            'membershipId', activation_fact.membership_id,
            'revision', activation_fact.membership_revision
          )
        )
      end,
      'state', activation_fact.state,
      'activatedByActorId', activation_fact.activated_by,
      'activatedAt', activation_fact.activated_at,
      'expiresAt', activation_fact.expires_at,
      'activationCorrelationId', activation_fact.activation_correlation_id,
      'changedByActorId', activation_fact.changed_by,
      'changedAt', activation_fact.changed_at,
      'changeCorrelationId', activation_fact.change_correlation_id,
      'revokedByActorId', activation_fact.revoked_by,
      'revokedAt', activation_fact.revoked_at,
      'revocationCorrelationId', activation_fact.revocation_correlation_id
    )),
    next_access_version, p_correlation_id;
end
$function$;

revoke execute on function
  vortex_access.coordinate_organization_role_activation_change(
    text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid,
    bigint, uuid, bigint, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_organization_role_activation_change(
  text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid,
  bigint, uuid, bigint, uuid, uuid
) is
  'Owner-only atomic individual role activation or terminal revocation. It changes Access once but grants no caller authority.';

alter function vortex_access.coordinate_organization_role_activation_change(p_operation text, p_organization_id uuid, p_role_activation_id uuid, p_expected_activation_revision bigint, p_organization_account_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_requested_duration_seconds bigint, p_eligibility_source_kind text, p_role_assignment_id uuid, p_expected_role_assignment_revision bigint, p_membership_id uuid, p_expected_membership_revision bigint, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

grant execute on function vortex_access.coordinate_organization_role_activation_change(p_operation text, p_organization_id uuid, p_role_activation_id uuid, p_expected_activation_revision bigint, p_organization_account_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_requested_duration_seconds bigint, p_eligibility_source_kind text, p_role_assignment_id uuid, p_expected_role_assignment_revision bigint, p_membership_id uuid, p_expected_membership_revision bigint, p_changed_by uuid, p_correlation_id uuid) to postgres;

create or replace function vortex_access.coordinate_organization_stewardship_adoption(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_role_id uuid,
  p_role_key text,
  p_role_label text,
  p_role_description text,
  p_role_assignment_id uuid,
  p_delegation_authority_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  requirement jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  platform_owner_id constant uuid := vortex_access.platform_permission_owner_id();
  stewardship vortex_access.organization_stewardship_requirements%rowtype;
  platform_registration vortex_access.permission_registrations%rowtype;
  is_replay boolean;
  expected_count bigint;
  expected_metadata_exact boolean;
  continuity_count bigint;
  distinct_continuity_count bigint;
  granted_count bigint;
  checked_at timestamptz;
  next_access_version bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_assignment_id is null
    or p_role_assignment_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_delegation_authority_id is null
    or p_delegation_authority_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_key is null
    or pg_catalog.char_length(p_role_key) not between 1 and 40
    or p_role_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_role_label is null
    or p_role_label is distinct from pg_catalog.btrim(p_role_label)
    or pg_catalog.char_length(p_role_label) not between 1 and 60
    or p_role_description is null
    or p_role_description is distinct from pg_catalog.btrim(p_role_description)
    or pg_catalog.char_length(p_role_description) not between 1 and 1000
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization stewardship adoption input is invalid';
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
      message = 'Organization stewardship adoption scope is unavailable';
  end if;

  perform pg_catalog.set_config(
    'vortex_access.exclusive_organization_id', p_organization_id::text, true
  );

  select stored.* into stewardship
  from vortex_access.organization_stewardship_requirements as stored
  where stored.organization_id = p_organization_id
  for update;

  is_replay := found;
  if is_replay then
    if stewardship.original_organization_account_id <>
        p_organization_account_id
      or stewardship.original_role_id <> p_role_id
      or stewardship.original_role_assignment_id <> p_role_assignment_id
      or stewardship.original_delegation_authority_id <>
        p_delegation_authority_id
      or stewardship.adopted_by <> p_changed_by
      or stewardship.adoption_correlation_id <> p_correlation_id then
      raise exception using errcode = '40001',
        message = 'Organization stewardship adoption conflicts with existing evidence';
    end if;
  end if;

  if not is_replay then
    perform 1
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as identity
      on identity.identity_id = account.identity_id
      and identity.state = 'active'
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active'
    for update of account;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization stewardship account is stale or unavailable';
    end if;

    if exists (
      select 1 from vortex_access.organization_roles as role
      where role.organization_id = p_organization_id
        and (role.role_id = p_role_id or role.role_key = p_role_key)
    ) or exists (
      select 1 from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = p_organization_id
        and assignment.role_assignment_id = p_role_assignment_id
    ) or exists (
      select 1
      from vortex_access.organization_delegation_authorities as delegation
      where delegation.organization_id = p_organization_id
        and delegation.delegation_authority_id = p_delegation_authority_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization stewardship grant identity is unavailable';
    end if;
  end if;

  select registration.* into platform_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
    and registration.state = 'active'
  for update;
  if not found
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, platform_registration.revision
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue evidence is invalid';
  end if;

  -- The private producer supplies the whole selected catalogue and its target.
  with expected as materialized (
    select declaration.*
    from vortex_access.read_platform_permission_declaration_catalogue_internal(
      platform_registration.revision
    ) as declaration
  )
  select pg_catalog.count(*),
    coalesce(
      pg_catalog.count(*) > 0
      and pg_catalog.count(*) = pg_catalog.count(distinct expected.permission_id)
      and pg_catalog.count(*) = pg_catalog.count(distinct expected.permission_key)
      and pg_catalog.count(distinct expected.declared_current_revision) = 1
      and pg_catalog.count(distinct expected.registration_revision) = 1
      and pg_catalog.count(distinct expected.source_version) = 1
      and pg_catalog.count(distinct expected.catalogue_fingerprint) = 1
      and pg_catalog.bool_and(
        expected.registration_revision = platform_registration.revision
        and expected.declared_current_revision = platform_registration.revision
        and expected.source_version = platform_registration.source_version
        and expected.catalogue_fingerprint =
          platform_registration.permission_catalogue_fingerprint
      ),
      false
    )
  into expected_count, expected_metadata_exact
  from expected;
  if not expected_metadata_exact then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue evidence is invalid';
  end if;

  -- Lock the complete fixed registration-owner set, including invalid roots.
  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
  order by continuity.owner_kind collate "C", continuity.owner_id,
    continuity.permission_id
  for update;

  select pg_catalog.count(*), pg_catalog.count(distinct continuity.permission_id)
  into continuity_count, distinct_continuity_count
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id;

  if continuity_count <> expected_count
    or distinct_continuity_count <> expected_count
    or exists (
      select 1
      from vortex_access.permission_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.registration_kind = 'platform'
        and continuity.registration_owner_id = platform_owner_id
        and not exists (
          select 1
          from vortex_access.permission_catalogue_entries as entry
          where entry.organization_id = continuity.organization_id
            and entry.registration_kind = continuity.registration_kind
            and entry.registration_owner_id = platform_owner_id
            and entry.registration_revision = platform_registration.revision
            and entry.application_root_id is null
            and entry.owner_kind = 'platform'
            and entry.owner_id = platform_owner_id
            and entry.owner_kind = continuity.owner_kind
            and entry.owner_id = continuity.owner_id
            and entry.permission_id = continuity.permission_id
            and continuity.application_root_id is null
            and continuity.state = 'available'
            and continuity.continuity_revision > 0
            and continuity.last_processed_registration_revision =
              platform_registration.revision
        )
    ) or exists (
      select 1
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = platform_owner_id
        and entry.registration_revision = platform_registration.revision
        and not exists (
          select 1
          from vortex_access.permission_continuities as continuity
          where continuity.organization_id = entry.organization_id
            and continuity.application_root_id is null
            and continuity.registration_kind = 'platform'
            and continuity.registration_owner_id = platform_owner_id
            and continuity.owner_kind = 'platform'
            and continuity.owner_id = platform_owner_id
            and continuity.owner_kind = entry.owner_kind
            and continuity.owner_id = entry.owner_id
            and continuity.permission_id = entry.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision > 0
            and continuity.last_processed_registration_revision =
              platform_registration.revision
        )
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission continuity evidence is incomplete';
  end if;

  if is_replay then
    perform vortex_access.assert_organization_has_permanent_steward(
      p_organization_id
    );
    select version.current_version into next_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return query select 'unchanged'::text,
      'adopt_organization_stewardship'::text,
      pg_catalog.jsonb_build_object(
        'organizationId', stewardship.organization_id,
        'originalOrganizationAccountId',
          stewardship.original_organization_account_id,
        'originalRoleId', stewardship.original_role_id,
        'originalRoleAssignmentId', stewardship.original_role_assignment_id,
        'originalDelegationAuthorityId',
          stewardship.original_delegation_authority_id,
        'revision', stewardship.revision,
        'adoptedByActorId', stewardship.adopted_by,
        'adoptedAt', stewardship.adopted_at,
        'adoptionCorrelationId', stewardship.adoption_correlation_id,
        'changedByActorId', stewardship.changed_by,
        'changedAt', stewardship.changed_at,
        'changeCorrelationId', stewardship.change_correlation_id
      ), next_access_version, p_correlation_id;
    return;
  end if;

  checked_at := pg_catalog.clock_timestamp();

  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, application_root_id,
    source_role_id, derived_application_root_id, derived_source_role_id,
    derived_source_definition_key, derived_source_release_revision,
    derived_source_release_version,
    derived_source_validation_contract_version, live_revision, created_by, created_at
  ) values (
    p_organization_id, p_role_id, 'custom', p_role_key, null, null,
    null, null, null, null, null, null, 1,
    p_changed_by, checked_at
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision
  )
  select p_organization_id, p_role_id, 1,
    pg_catalog.row_number() over (
      order by entry.owner_kind collate "C", entry.owner_id,
        entry.permission_id
    ),
    'custom', null, null, entry.owner_kind, entry.owner_id,
    entry.permission_id, 'platform', entry.registration_owner_id,
    entry.registration_revision,
    platform_registration.permission_catalogue_fingerprint,
    continuity.continuity_revision
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is null
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
    and continuity.registration_owner_id = entry.registration_owner_id
    and continuity.state = 'available'
    and continuity.continuity_revision > 0
    and continuity.last_processed_registration_revision =
      platform_registration.revision
  where entry.organization_id = p_organization_id
    and entry.application_root_id is null
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = platform_registration.revision
    and entry.owner_kind = 'platform'
    and entry.owner_id = platform_owner_id
  order by entry.owner_kind collate "C", entry.owner_id, entry.permission_id;

  get diagnostics granted_count = row_count;
  if granted_count <> expected_count or (
    select pg_catalog.count(distinct grant_entry.permission_id)
    from vortex_access.organization_role_permission_entries as grant_entry
    where grant_entry.organization_id = p_organization_id
      and grant_entry.role_id = p_role_id
      and grant_entry.role_revision = 1
  ) <> expected_count then
    raise exception using errcode = '55000',
      message = 'Platform permission stewardship grant evidence is incomplete';
  end if;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, accepted_registration_revision,
    template_continuity_revision,
    changed_by, changed_at, change_correlation_id
  ) values (
    p_organization_id, p_role_id, 1, 'custom', null, 'active', 'privileged',
    'standing', 1, 1, null, null, p_role_key, p_role_label,
    p_role_description, null, null, null, null, null, null,
    p_changed_by, checked_at, p_correlation_id
  );

  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id,
    changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    p_organization_id, p_role_assignment_id, p_role_id,
    'organization_account', p_organization_account_id, null, 'standing', 1,
    checked_at, null, 'live', p_changed_by, checked_at, p_correlation_id,
    p_changed_by, checked_at, p_correlation_id, null, null, null
  );

  insert into vortex_access.organization_delegation_authorities (
    organization_id, delegation_authority_id, holder_kind,
    organization_account_id, group_id, scope_kind, bounded_permissions,
    revision, starts_at, expires_at, state, granted_by,
    granted_at, grant_correlation_id, changed_by, changed_at,
    change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    p_organization_id, p_delegation_authority_id, 'organization_account',
    p_organization_account_id, null, 'organization_catalogue', null, 1,
    checked_at, null, 'live', p_changed_by, checked_at, p_correlation_id,
    p_changed_by, checked_at, p_correlation_id, null, null, null
  );

  insert into vortex_access.organization_stewardship_requirements (
    organization_id, original_organization_account_id, original_role_id,
    original_role_assignment_id, original_delegation_authority_id, revision,
    adopted_by, adopted_at, adoption_correlation_id, changed_by, changed_at,
    change_correlation_id
  ) values (
    p_organization_id, p_organization_account_id, p_role_id,
    p_role_assignment_id, p_delegation_authority_id, 1, p_changed_by,
    checked_at, p_correlation_id, p_changed_by, checked_at, p_correlation_id
  ) returning * into stewardship;

  perform vortex_access.assert_organization_has_permanent_steward(
    p_organization_id
  );

  perform 1
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'stewardship_changed'
  ) as version;

  select version.current_version into next_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;
  return query select 'changed'::text,
    'adopt_organization_stewardship'::text,
    pg_catalog.jsonb_build_object(
      'organizationId', stewardship.organization_id,
      'originalOrganizationAccountId',
        stewardship.original_organization_account_id,
      'originalRoleId', stewardship.original_role_id,
      'originalRoleAssignmentId', stewardship.original_role_assignment_id,
      'originalDelegationAuthorityId',
        stewardship.original_delegation_authority_id,
      'revision', stewardship.revision,
      'adoptedByActorId', stewardship.adopted_by,
      'adoptedAt', stewardship.adopted_at,
      'adoptionCorrelationId', stewardship.adoption_correlation_id,
      'changedByActorId', stewardship.changed_by,
      'changedAt', stewardship.changed_at,
      'changeCorrelationId', stewardship.change_correlation_id
    ), next_access_version, p_correlation_id;
end
$function$;

comment on function vortex_access.coordinate_organization_stewardship_adoption(
  uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
) is
  'Owner-only atomic whole-current-catalogue first-steward adoption or exact unchanged replay. It preserves original grants and validates complete availability.';

revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.coordinate_organization_stewardship_adoption(uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid) to postgres;

create or replace function vortex_access.coordinate_role_change_without_stewardship_internal(
  p_evidence jsonb,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  role jsonb,
  created_activation_policy jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  candidate jsonb;
  operation_name text;
  target_organization_id uuid;
  target_role_id uuid;
  expected_role_revision bigint;
  target_role_kind text;
  target_lifecycle text;
  target_role_key text;
  target_label text;
  target_description text;
  target_privilege_classification text;
  target_assignment_policy text;
  target_policy_continuity_revision bigint;
  target_authority_continuity_revision bigint;
  target_activation_policy_id uuid;
  target_activation_policy_revision bigint;
  target_application_root_id uuid;
  target_source_role_id uuid;
  target_source_definition_key text;
  target_source_release_revision bigint;
  target_source_release_version text;
  target_source_validation_contract_version text;
  target_accepted_registration_revision bigint;
  target_template_continuity_revision bigint;
  target_role_revision bigint;
  candidate_permissions jsonb;
  canonical_permissions jsonb;
  current_permissions jsonb;
  permission_count bigint;
  template_source jsonb;
  live_permissions jsonb;
  selected_template_count bigint;
  policy_choice jsonb;
  policy_value jsonb;
  policy_reference jsonb;
  manifest jsonb;
  canonical_assignments jsonb;
  manifest_required boolean := false;
  authority_broadened boolean := false;
  permissions_changed boolean := false;
  configured_state_changed boolean := false;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  maximum_policy_revision bigint;
  operation_at timestamptz;
  next_access_version bigint;
  role_result jsonb;
  policy_result jsonb;
begin
  if p_evidence is null
    or pg_catalog.jsonb_typeof(p_evidence) is distinct from 'object'
    or p_evidence - array[
      'contractVersion', 'candidate', 'affectedAssignmentManifest'
    ]::text[] <> '{}'::jsonb
    or not (p_evidence ?& array['contractVersion', 'candidate'])
    or p_evidence ->> 'contractVersion' is distinct from '1.0.0'
    or pg_catalog.jsonb_typeof(p_evidence -> 'candidate') is distinct from 'object'
    or (p_evidence ? 'affectedAssignmentManifest' and
      pg_catalog.jsonb_typeof(p_evidence -> 'affectedAssignmentManifest')
        is distinct from 'object')
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-change evidence is invalid';
  end if;

  candidate := p_evidence -> 'candidate';
  operation_name := candidate ->> 'operation';
  if operation_name is null or operation_name not in (
    'create_custom', 'create_custom_from_template',
    'accept_new_application_role', 'revise_metadata_policy',
    'revise_custom_permissions', 'accept_application_role_revision',
    'retire_role'
  ) then
    raise exception using errcode = '22023',
      message = 'Organization role-change operation is invalid';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'operation') is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string' then
    raise exception using errcode = '22023',
      message = 'Organization role-change identity is invalid';
  end if;
  target_organization_id := (candidate ->> 'organizationId')::uuid;
  target_role_id := (candidate ->> 'roleId')::uuid;
  if target_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate ->> 'organizationId' <> target_organization_id::text
    or candidate ->> 'roleId' <> target_role_id::text then
    raise exception using errcode = '22023',
      message = 'Organization role-change identity is invalid';
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    if candidate ? 'expectedRoleRevision' then
      raise exception using errcode = '22023',
        message = 'A role creation cannot carry an expected revision';
    end if;
  elsif pg_catalog.jsonb_typeof(candidate -> 'expectedRoleRevision')
      is distinct from 'number'
    or (candidate ->> 'expectedRoleRevision')::numeric < 1
    or (candidate ->> 'expectedRoleRevision')::numeric > 9007199254740991
    or (candidate ->> 'expectedRoleRevision')::numeric <>
      pg_catalog.trunc((candidate ->> 'expectedRoleRevision')::numeric) then
    raise exception using errcode = '22023',
      message = 'Expected role revision is invalid';
  else
    expected_role_revision := (candidate ->> 'expectedRoleRevision')::numeric::bigint;
  end if;

  if operation_name = 'retire_role' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision'
    ]::text[] <> '{}'::jsonb
      or not (candidate ?& array[
        'operation', 'organizationId', 'roleId', 'expectedRoleRevision'
      ]) then
      raise exception using errcode = '22023',
        message = 'Role retirement shape is invalid';
    end if;
  else
    if not (candidate ?& array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'key') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'label') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'description') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'privilegeClassification')
        is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'assignmentPolicy')
        is distinct from 'object'
      or pg_catalog.char_length(candidate ->> 'key') not between 1 and 40
      or candidate ->> 'key' !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or candidate ->> 'label' <> pg_catalog.btrim(candidate ->> 'label')
      or pg_catalog.char_length(candidate ->> 'label') not between 1 and 60
      or candidate ->> 'description' <> pg_catalog.btrim(candidate ->> 'description')
      or pg_catalog.char_length(candidate ->> 'description') not between 1 and 1000
      or candidate ->> 'privilegeClassification' not in ('standard', 'privileged') then
      raise exception using errcode = '22023',
        message = 'Role configuration shape is invalid';
    end if;
    target_role_key := candidate ->> 'key';
    target_label := candidate ->> 'label';
    target_description := candidate ->> 'description';
    target_privilege_classification := candidate ->> 'privilegeClassification';
  end if;

  if operation_name in (
    'create_custom', 'revise_custom_permissions', 'create_custom_from_template',
    'accept_new_application_role', 'accept_application_role_revision'
  ) then
    if pg_catalog.jsonb_typeof(candidate -> 'permissions') is distinct from 'array'
      or pg_catalog.jsonb_array_length(candidate -> 'permissions') = 0 then
      raise exception using errcode = '22023',
        message = 'Role permission evidence is invalid';
    end if;
    candidate_permissions := candidate -> 'permissions';
  elsif candidate ? 'permissions' then
    raise exception using errcode = '22023',
      message = 'This role-change intent cannot carry permissions';
  end if;

  if operation_name in (
    'create_custom_from_template', 'accept_new_application_role',
    'accept_application_role_revision'
  ) then
    if not (candidate ?& array[
      'templateSource', 'sourceRoleId', 'templateContinuityRevision'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'templateSource') is distinct from 'object'
      or pg_catalog.jsonb_typeof(candidate -> 'sourceRoleId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'templateContinuityRevision')
        is distinct from 'number'
      or (candidate ->> 'templateContinuityRevision')::numeric < 1
      or (candidate ->> 'templateContinuityRevision')::numeric > 9007199254740991
      or (candidate ->> 'templateContinuityRevision')::numeric <>
        pg_catalog.trunc((candidate ->> 'templateContinuityRevision')::numeric) then
      raise exception using errcode = '22023',
        message = 'Application role-template evidence is invalid';
    end if;
    template_source := candidate -> 'templateSource';
    target_source_role_id := (candidate ->> 'sourceRoleId')::uuid;
    target_template_continuity_revision :=
      (candidate ->> 'templateContinuityRevision')::numeric::bigint;
  elsif candidate ? 'templateSource'
    or candidate ? 'sourceRoleId'
    or candidate ? 'templateContinuityRevision' then
    raise exception using errcode = '22023',
      message = 'This role-change intent cannot carry template evidence';
  end if;

  if operation_name = 'create_custom' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom role shape is invalid';
    end if;
  elsif operation_name in ('create_custom_from_template', 'accept_new_application_role') then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy', 'templateSource',
      'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'New template role shape is invalid';
    end if;
  elsif operation_name = 'revise_metadata_policy' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Role metadata shape is invalid';
    end if;
  elsif operation_name = 'revise_custom_permissions' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy',
      'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom permission shape is invalid';
    end if;
  elsif operation_name = 'accept_application_role_revision' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy',
      'templateSource', 'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Application acceptance shape is invalid';
    end if;
  end if;

  if operation_name <> 'retire_role' then
    policy_choice := candidate -> 'assignmentPolicy';
    if policy_choice ->> 'kind' = 'standing' then
      if policy_choice <> pg_catalog.jsonb_build_object('kind', 'standing') then
        raise exception using errcode = '22023', message = 'Standing policy shape is invalid';
      end if;
      target_assignment_policy := 'standing';
    elsif policy_choice ->> 'kind' = 'activation_required'
      and policy_choice - array['kind', 'activationPolicy']::text[] = '{}'::jsonb
      and policy_choice ?& array['kind', 'activationPolicy']
      and pg_catalog.jsonb_typeof(policy_choice -> 'activationPolicy') = 'object' then
      target_assignment_policy := 'activation_required';
      if policy_choice #>> '{activationPolicy,selection}' = 'existing' then
        if (policy_choice -> 'activationPolicy') - array['selection', 'reference']::text[] <>
            '{}'::jsonb
          or not ((policy_choice -> 'activationPolicy') ?& array['selection', 'reference'])
          or pg_catalog.jsonb_typeof(policy_choice #> '{activationPolicy,reference}') <>
            'object' then
          raise exception using errcode = '22023',
            message = 'Existing activation policy shape is invalid';
        end if;
        policy_reference := policy_choice #> '{activationPolicy,reference}';
        if policy_reference - array[
          'activationPolicyId', 'revision'
        ]::text[] <> '{}'::jsonb
          or not (policy_reference ?& array[
            'activationPolicyId', 'revision'
          ])
          or pg_catalog.jsonb_typeof(policy_reference -> 'activationPolicyId') <> 'string'
          or pg_catalog.jsonb_typeof(policy_reference -> 'revision') <> 'number'
          or (policy_reference ->> 'revision')::numeric < 1
          or (policy_reference ->> 'revision')::numeric > 9007199254740991
          or (policy_reference ->> 'revision')::numeric <>
            pg_catalog.trunc((policy_reference ->> 'revision')::numeric) then
          raise exception using errcode = '22023',
            message = 'Existing activation policy evidence is invalid';
        end if;
        target_activation_policy_id := (policy_reference ->> 'activationPolicyId')::uuid;
        target_activation_policy_revision :=
          (policy_reference ->> 'revision')::numeric::bigint;
      elsif policy_choice #>> '{activationPolicy,selection}' = 'new' then
        if (policy_choice -> 'activationPolicy') - array['selection', 'policy']::text[] <>
            '{}'::jsonb
          or not ((policy_choice -> 'activationPolicy') ?& array['selection', 'policy'])
          or pg_catalog.jsonb_typeof(policy_choice #> '{activationPolicy,policy}') <> 'object' then
          raise exception using errcode = '22023',
            message = 'New activation policy shape is invalid';
        end if;
        policy_value := policy_choice #> '{activationPolicy,policy}';
        if policy_value - array[
          'activationPolicyId', 'revision', 'maximumActivationDurationSeconds',
          'reasonRequired', 'recentAuthentication'
        ]::text[] <> '{}'::jsonb
          or not (policy_value ?& array[
            'activationPolicyId', 'revision', 'maximumActivationDurationSeconds',
            'reasonRequired', 'recentAuthentication'
          ])
          or pg_catalog.jsonb_typeof(policy_value -> 'activationPolicyId') <> 'string'
          or pg_catalog.jsonb_typeof(policy_value -> 'revision') <> 'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'maximumActivationDurationSeconds') <>
            'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'reasonRequired') <> 'boolean'
          or pg_catalog.jsonb_typeof(policy_value -> 'recentAuthentication') <> 'object'
          or (policy_value ->> 'revision')::numeric < 1
          or (policy_value ->> 'revision')::numeric > 9007199254740991
          or (policy_value ->> 'revision')::numeric <>
            pg_catalog.trunc((policy_value ->> 'revision')::numeric)
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric < 1
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric >
            9007199254740991
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric <>
            pg_catalog.trunc(
              (policy_value ->> 'maximumActivationDurationSeconds')::numeric
            ) then
          raise exception using errcode = '22023',
            message = 'New activation policy evidence is invalid';
        end if;
        if policy_value #>> '{recentAuthentication,kind}' = 'none' then
          if policy_value -> 'recentAuthentication' <>
            pg_catalog.jsonb_build_object('kind', 'none') then
            raise exception using errcode = '22023',
              message = 'Recent authentication policy is invalid';
          end if;
        elsif policy_value #>> '{recentAuthentication,kind}' in ('primary', 'multi_factor') then
          if (policy_value -> 'recentAuthentication') - array[
            'kind', 'maximumAgeSeconds'
          ]::text[] <> '{}'::jsonb
            or not ((policy_value -> 'recentAuthentication') ?& array[
              'kind', 'maximumAgeSeconds'
            ])
            or pg_catalog.jsonb_typeof(
              policy_value #> '{recentAuthentication,maximumAgeSeconds}'
            ) <> 'number'
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric < 1
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric >
              9007199254740991
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric <>
              pg_catalog.trunc(
                (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric
              ) then
            raise exception using errcode = '22023',
              message = 'Recent authentication policy is invalid';
          end if;
        else
          raise exception using errcode = '22023',
            message = 'Recent authentication policy is invalid';
        end if;
        target_activation_policy_id := (policy_value ->> 'activationPolicyId')::uuid;
        target_activation_policy_revision :=
          (policy_value ->> 'revision')::numeric::bigint;
      else
        raise exception using errcode = '22023',
          message = 'Activation-required policy selection is invalid';
      end if;
    else
      raise exception using errcode = '22023', message = 'Assignment policy is invalid';
    end if;
  end if;

  if candidate_permissions is not null then
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array[
          'kind', 'applicationRootId', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'kind', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision'
        ])
        or item.value ->> 'kind' is distinct from 'exact'
        or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
        or item.value ->> 'ownerKind' not in ('platform', 'application', 'module')
        or pg_catalog.jsonb_typeof(item.value -> 'ownerId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'permissionId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'acceptedRegistrationRevision')
          is distinct from 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'continuityRevision')
          is distinct from 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'catalogueFingerprint')
          is distinct from 'string'
        or item.value ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        or (item.value ->> 'acceptedRegistrationRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'acceptedRegistrationRevision')::numeric <>
          pg_catalog.trunc(
            (item.value ->> 'acceptedRegistrationRevision')::numeric
          )
        or (item.value ->> 'continuityRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'continuityRevision')::numeric <>
          pg_catalog.trunc((item.value ->> 'continuityRevision')::numeric)
        or (
          item.value ->> 'ownerKind' = 'platform'
          and item.value ? 'applicationRootId'
        )
        or (
          item.value ->> 'ownerKind' in ('application', 'module')
          and pg_catalog.jsonb_typeof(item.value -> 'applicationRootId')
            is distinct from 'string'
        )
    ) then
      raise exception using errcode = '22023', message = 'Role permission entry is invalid';
    end if;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'exact',
        'applicationRootId', case
          when item.value ? 'applicationRootId'
            then (item.value ->> 'applicationRootId')::uuid
          else null
        end,
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', (item.value ->> 'ownerId')::uuid,
        'permissionId', (item.value ->> 'permissionId')::uuid,
        'acceptedRegistrationRevision',
          (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
        'catalogueFingerprint', item.value ->> 'catalogueFingerprint',
        'continuityRevision',
          (item.value ->> 'continuityRevision')::numeric::bigint
      )) order by
        case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end nulls last,
        (item.value ->> 'ownerKind') collate "C",
        (item.value ->> 'ownerId')::uuid,
        (item.value ->> 'permissionId')::uuid
    ) into canonical_permissions
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value);

    if canonical_permissions is distinct from candidate_permissions then
      raise exception using errcode = '22023',
        message = 'Role permissions must use canonical unique identity order';
    end if;
    select pg_catalog.count(*), pg_catalog.count(distinct pg_catalog.jsonb_build_array(
      case when item.value ? 'applicationRootId'
        then (item.value ->> 'applicationRootId')::uuid else null end,
      item.value ->> 'ownerKind',
      (item.value ->> 'ownerId')::uuid,
      (item.value ->> 'permissionId')::uuid
    ))
    into permission_count, selected_template_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value);
    if permission_count <> selected_template_count then
      raise exception using errcode = '22023',
        message = 'Role permission identities must be unique';
    end if;
  end if;

  if template_source is not null then
    if template_source - array[
      'applicationRootId', 'registrationRevision', 'releaseRevision', 'catalogueFingerprint'
    ]::text[] <> '{}'::jsonb
      or not (template_source ?& array[
        'applicationRootId', 'registrationRevision', 'releaseRevision', 'catalogueFingerprint'
      ])
      or pg_catalog.jsonb_typeof(template_source -> 'applicationRootId') <> 'string'
      or vortex_platform.is_non_nil_uuid(template_source ->> 'applicationRootId') is not true
      or pg_catalog.jsonb_typeof(template_source -> 'registrationRevision') <> 'number'
      or (template_source ->> 'registrationRevision')::numeric not between 1 and 9007199254740991
      or (template_source ->> 'registrationRevision')::numeric <>
        pg_catalog.trunc((template_source ->> 'registrationRevision')::numeric)
      or pg_catalog.jsonb_typeof(template_source -> 'releaseRevision') <> 'number'
      or (template_source ->> 'releaseRevision')::numeric not between 1 and 9007199254740991
      or (template_source ->> 'releaseRevision')::numeric <>
        pg_catalog.trunc((template_source ->> 'releaseRevision')::numeric)
      or pg_catalog.jsonb_typeof(template_source -> 'catalogueFingerprint') <> 'string'
      or target_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Application role-template evidence is invalid';
    end if;

    target_accepted_registration_revision :=
      (template_source ->> 'registrationRevision')::numeric::bigint;
    target_application_root_id := (template_source ->> 'applicationRootId')::uuid;

    -- The evidence names the registration; the source release and the role's live permissions
    -- are read from it here, exactly as the preparation read them.
    select registration.source_definition_key, registration.source_revision,
      registration.source_version, registration.validation_contract_version
    into target_source_definition_key, target_source_release_revision,
      target_source_release_version, target_source_validation_contract_version
    from vortex_access.permission_registrations as registration
    where registration.organization_id = target_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.revision = target_accepted_registration_revision
      and registration.source_revision = (template_source ->> 'releaseRevision')::bigint
      and registration.state = 'active'
      and registration.permission_catalogue_fingerprint =
        template_source ->> 'catalogueFingerprint';
    if not found then
      raise exception using errcode = '40001',
        message = 'Prepared application registration is stale or unavailable';
    end if;

    live_permissions := vortex_access.application_role_template_live_permissions_internal(
      target_organization_id, target_application_root_id,
      target_accepted_registration_revision, target_source_role_id
    );
    if live_permissions is null or pg_catalog.jsonb_array_length(live_permissions) = 0 then
      raise exception using errcode = '40001',
        message = 'Application role template is stale or unavailable';
    end if;
  end if;

  manifest := p_evidence -> 'affectedAssignmentManifest';

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = target_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization role-change scope is unavailable';
  end if;

  if candidate_permissions is not null then
    perform 1
    from vortex_access.permission_registrations as registration
    join pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      on registration.organization_id = target_organization_id
      and registration.registration_kind = case
        when item.value ->> 'ownerKind' = 'platform' then 'platform'
        else 'application'
      end
      and registration.registration_owner_id = case
        when item.value ->> 'ownerKind' = 'platform'
          then vortex_access.platform_permission_owner_id()
        else (item.value ->> 'applicationRootId')::uuid
      end
      and registration.revision =
        (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint
      and registration.permission_catalogue_fingerprint =
        item.value ->> 'catalogueFingerprint'
      and registration.state = 'active'
    order by registration.registration_kind collate "C",
      registration.registration_owner_id
    for update of registration;

    perform 1
    from vortex_access.permission_continuities as continuity
    join pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
    order by continuity.application_root_id nulls last,
      continuity.owner_kind collate "C", continuity.owner_id, continuity.permission_id
    for update of continuity;

    select pg_catalog.count(*) into permission_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
      and continuity.state = 'available'
      and continuity.continuity_revision =
        (item.value ->> 'continuityRevision')::numeric::bigint
    join vortex_access.permission_registrations as registration
      on registration.organization_id = continuity.organization_id
      and registration.registration_kind = continuity.registration_kind
      and registration.registration_owner_id = continuity.registration_owner_id
      and registration.state = 'active'
      and registration.revision =
        (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint
      and registration.permission_catalogue_fingerprint =
        item.value ->> 'catalogueFingerprint'
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = continuity.organization_id
      and catalogue.registration_kind = continuity.registration_kind
      and catalogue.registration_owner_id = continuity.registration_owner_id
      and catalogue.registration_revision = registration.revision
      and catalogue.owner_kind = continuity.owner_kind
      and catalogue.owner_id = continuity.owner_id
      and catalogue.permission_id = continuity.permission_id
      and catalogue.application_root_id is not distinct from continuity.application_root_id
      and continuity.last_processed_registration_revision = registration.revision;
    if permission_count <> pg_catalog.jsonb_array_length(candidate_permissions) then
      raise exception using errcode = '40001',
        message = 'Role permission evidence is stale or unavailable';
    end if;
  end if;

  if template_source is not null then
    perform 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = target_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.revision = target_accepted_registration_revision
      and registration.state = 'active'
    ;
    if not found then
      raise exception using errcode = '40001',
        message = 'Application registration is stale or unavailable';
    end if;

    perform 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = target_organization_id
      and continuity.application_root_id = target_application_root_id
      and continuity.source_role_id = target_source_role_id
      and continuity.state = 'available'
      and continuity.continuity_revision = target_template_continuity_revision
      and continuity.last_processed_registration_revision =
        target_accepted_registration_revision
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Application role template is stale or unavailable';
    end if;

    select pg_catalog.count(*) into permission_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as permission(value)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements(live_permissions) as live(value)
      where (live.value ->> 'applicationRootId')::uuid =
          (permission.value ->> 'applicationRootId')::uuid
        and live.value ->> 'ownerKind' = permission.value ->> 'ownerKind'
        and (live.value ->> 'ownerId')::uuid =
          (permission.value ->> 'ownerId')::uuid
        and (live.value ->> 'permissionId')::uuid =
          (permission.value ->> 'permissionId')::uuid
    );
    if permission_count <> pg_catalog.jsonb_array_length(candidate_permissions)
      or (
        operation_name in ('accept_new_application_role', 'accept_application_role_revision')
        and permission_count <>
          pg_catalog.jsonb_array_length(live_permissions)
      ) then
      raise exception using errcode = '40001',
        message = 'Role permissions do not match the current application template';
    end if;
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;
    if found then
      raise exception using errcode = '40001',
        message = 'Organization role identity already exists';
    end if;

    target_role_revision := 1;
    target_policy_continuity_revision := 1;
    target_authority_continuity_revision := 1;
    target_role_kind := case
      when operation_name = 'accept_new_application_role' then 'application'
      else 'custom'
    end;
    target_lifecycle := 'active';
    operation_at := pg_catalog.clock_timestamp();

    insert into vortex_access.organization_roles (
      organization_id, role_id, role_kind, role_key, application_root_id,
      source_role_id, derived_application_root_id, derived_source_role_id,
      derived_source_definition_key, derived_source_release_revision,
      derived_source_release_version, derived_source_validation_contract_version,
      live_revision, created_by, created_at
    ) values (
      target_organization_id, target_role_id, target_role_kind, target_role_key,
      case when target_role_kind = 'application' then target_application_root_id else null end,
      case when target_role_kind = 'application' then target_source_role_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_application_root_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_role_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_definition_key else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_release_revision else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_release_version else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_validation_contract_version else null end,
      1, p_changed_by, operation_at
    );

    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;

    if operation_name = 'create_custom_from_template' then
      target_application_root_id := null;
      target_source_role_id := null;
      target_source_definition_key := null;
      target_source_release_revision := null;
      target_source_release_version := null;
      target_source_validation_contract_version := null;
      target_accepted_registration_revision := null;
      target_template_continuity_revision := null;
    end if;
  else
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;
    if not found or role_identity.live_revision <> expected_role_revision then
      raise exception using errcode = '40001',
        message = 'Organization role revision is stale or unavailable';
    end if;
    if role_identity.live_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role revision is exhausted';
    end if;
    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = role_identity.live_revision;
    if not found then
      raise exception using errcode = '23514',
        message = 'Current organization role revision is unavailable';
    end if;
    if current_revision.lifecycle = 'retired' then
      raise exception using errcode = '40001',
        message = 'A retired organization role is terminal';
    end if;
    if operation_name = 'revise_custom_permissions'
      and role_identity.role_kind <> 'custom' then
      raise exception using errcode = '40001',
        message = 'Custom role permission revision requires a custom role';
    end if;
    if operation_name = 'accept_application_role_revision'
      and (
        role_identity.role_kind <> 'application'
        or role_identity.application_root_id <> target_application_root_id
        or role_identity.source_role_id <> target_source_role_id
      ) then
      raise exception using errcode = '40001',
        message = 'Application role acceptance targets the wrong role source';
    end if;
    target_role_revision := role_identity.live_revision + 1;
  end if;

  if operation_at is null then
    operation_at := pg_catalog.clock_timestamp();
  end if;
  if operation_name not in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    target_role_kind := role_identity.role_kind;
    target_application_root_id := role_identity.application_root_id;
    target_source_role_id := role_identity.source_role_id;
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    target_lifecycle := case
      when operation_name = 'retire_role' then 'retired'
      else current_revision.lifecycle
    end;
    target_privilege_classification := case
      when operation_name = 'retire_role' then current_revision.privilege_classification
      else target_privilege_classification
    end;
    target_assignment_policy := case
      when operation_name = 'retire_role' then current_revision.assignment_policy
      else target_assignment_policy
    end;
    if operation_name = 'retire_role' then
      target_role_key := current_revision.role_key;
      target_label := current_revision.label;
      target_description := current_revision.description;
      target_activation_policy_id := current_revision.activation_policy_id;
      target_activation_policy_revision := current_revision.activation_policy_revision;
    end if;
    target_source_definition_key := current_revision.source_definition_key;
    target_source_release_revision := current_revision.source_release_revision;
    target_source_release_version := current_revision.source_release_version;
    target_source_validation_contract_version :=
      current_revision.source_validation_contract_version;
    target_accepted_registration_revision := current_revision.accepted_registration_revision;
    target_template_continuity_revision := current_revision.template_continuity_revision;
  elsif operation_name = 'revise_custom_permissions' then
    target_lifecycle := 'active';
    target_source_definition_key := null;
    target_source_release_revision := null;
    target_source_release_version := null;
    target_source_validation_contract_version := null;
    target_accepted_registration_revision := null;
    target_template_continuity_revision := null;
  elsif operation_name = 'accept_application_role_revision' then
    target_lifecycle := 'active';
  end if;

  if operation_name <> 'retire_role' then
    if target_assignment_policy = 'standing' then
      target_activation_policy_id := null;
      target_activation_policy_revision := null;
    elsif policy_value is null then
      perform 1
      from vortex_access.organization_role_activation_policy_revisions as policy
      where policy.organization_id = target_organization_id
        and policy.role_id = target_role_id
        and policy.activation_policy_id = target_activation_policy_id
        and policy.revision = target_activation_policy_revision;
      if not found then
        raise exception using errcode = '40001',
          message = 'Existing role activation policy is stale or unavailable';
      end if;
    else
      select pg_catalog.max(policy.revision) into maximum_policy_revision
      from vortex_access.organization_role_activation_policy_revisions as policy
      where policy.organization_id = target_organization_id
        and policy.role_id = target_role_id
        and policy.activation_policy_id = target_activation_policy_id;
      if maximum_policy_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'New role activation policy revision is exhausted';
      end if;
      if (maximum_policy_revision is null and target_activation_policy_revision <> 1)
        or (maximum_policy_revision is not null
          and target_activation_policy_revision <> maximum_policy_revision + 1) then
        raise exception using errcode = '40001',
          message = 'New role activation policy revision is stale or invalid';
      end if;
    end if;
  end if;

  if current_revision.organization_id is not null then
    if current_revision.assignment_policy = target_assignment_policy
      and current_revision.activation_policy_id is not distinct from
        target_activation_policy_id
      and current_revision.activation_policy_revision is not distinct from
        target_activation_policy_revision then
      target_policy_continuity_revision := current_revision.policy_continuity_revision;
    else
      if current_revision.policy_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role policy continuity is exhausted';
      end if;
      target_policy_continuity_revision :=
        current_revision.policy_continuity_revision + 1;
    end if;
  end if;

  if current_revision.organization_id is not null then
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'exact',
          'applicationRootId', permission.application_root_id,
          'ownerKind', permission.owner_kind,
          'ownerId', permission.owner_id,
          'permissionId', permission.permission_id,
          'acceptedRegistrationRevision', permission.accepted_registration_revision,
          'catalogueFingerprint', permission.catalogue_fingerprint,
          'continuityRevision', permission.continuity_revision
        )) order by permission.entry_ordinal
      ),
      '[]'::jsonb
    ) into current_permissions
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = current_revision.revision;
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    candidate_permissions := current_permissions;
  end if;
  permissions_changed := current_revision.organization_id is not null
    and candidate_permissions is distinct from current_permissions;

  if operation_name = 'revise_custom_permissions' and not permissions_changed then
    raise exception using errcode = '40001',
      message = 'Explicit custom permission revision must change the accepted set';
  end if;
  if operation_name = 'accept_application_role_revision'
    and current_revision.lifecycle = 'active'
    and not permissions_changed
    and current_revision.source_definition_key is not distinct from
      target_source_definition_key
    and current_revision.source_release_revision is not distinct from
      target_source_release_revision
    and current_revision.source_release_version is not distinct from
      target_source_release_version
    and current_revision.source_validation_contract_version is not distinct from
      target_source_validation_contract_version
    and current_revision.accepted_registration_revision is not distinct from
      target_accepted_registration_revision
    and current_revision.template_continuity_revision is not distinct from
      target_template_continuity_revision then
    raise exception using errcode = '40001',
      message = 'Explicit application acceptance must change accepted source evidence';
  end if;

  if current_revision.organization_id is not null then
    configured_state_changed :=
      current_revision.role_key is distinct from target_role_key
      or current_revision.label is distinct from target_label
      or current_revision.description is distinct from target_description
      or current_revision.privilege_classification is distinct from
        target_privilege_classification
      or current_revision.assignment_policy is distinct from target_assignment_policy
      or current_revision.activation_policy_id is distinct from target_activation_policy_id
      or current_revision.activation_policy_revision is distinct from
        target_activation_policy_revision
      or current_revision.lifecycle is distinct from target_lifecycle
      or permissions_changed
      or current_revision.source_definition_key is distinct from target_source_definition_key
      or current_revision.source_release_revision is distinct from
        target_source_release_revision
      or current_revision.source_release_version is distinct from target_source_release_version
      or current_revision.source_validation_contract_version is distinct from
        target_source_validation_contract_version
      or current_revision.accepted_registration_revision is distinct from
        target_accepted_registration_revision
      or current_revision.template_continuity_revision is distinct from
        target_template_continuity_revision;
    if not configured_state_changed then
      raise exception using errcode = '40001',
        message = 'Organization role candidate does not change configured state';
    end if;
  end if;

  if current_revision.organization_id is not null then
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_permissions) as proposed(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(current_permissions) as existing(value)
        where existing.value -> 'applicationRootId' is not distinct from
            proposed.value -> 'applicationRootId'
          and existing.value ->> 'ownerKind' = proposed.value ->> 'ownerKind'
          and existing.value ->> 'ownerId' = proposed.value ->> 'ownerId'
          and existing.value ->> 'permissionId' = proposed.value ->> 'permissionId'
          and existing.value ->> 'continuityRevision' =
            proposed.value ->> 'continuityRevision'
      )
    ) into authority_broadened;

    manifest_required :=
      current_revision.assignment_policy <> target_assignment_policy
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      )
      or authority_broadened;

    if authority_broadened
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      ) then
      if current_revision.authority_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role authority continuity is exhausted';
      end if;
      target_authority_continuity_revision :=
        current_revision.authority_continuity_revision + 1;
    else
      target_authority_continuity_revision :=
        current_revision.authority_continuity_revision;
    end if;
  end if;

  if manifest_required then
    if manifest is null
      or manifest - array[
        'organizationId', 'roleId', 'assignments'
      ]::text[] <> '{}'::jsonb
      or not (manifest ?& array['organizationId', 'roleId', 'assignments'])
      or pg_catalog.jsonb_typeof(manifest -> 'organizationId') <> 'string'
      or pg_catalog.jsonb_typeof(manifest -> 'roleId') <> 'string'
      or pg_catalog.jsonb_typeof(manifest -> 'assignments') <> 'array'
      or (manifest ->> 'organizationId')::uuid <> target_organization_id
      or (manifest ->> 'roleId')::uuid <> target_role_id then
      raise exception using errcode = '22023',
        message = 'Affected assignment manifest shape is invalid';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(manifest -> 'assignments') as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or item.value - array[
          'roleAssignmentId', 'expectedRevision', 'assignee'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'roleAssignmentId', 'expectedRevision', 'assignee'
        ])
        or pg_catalog.jsonb_typeof(item.value -> 'roleAssignmentId') <> 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'expectedRevision') <> 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'assignee') <> 'object'
        or (item.value ->> 'expectedRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'expectedRevision')::numeric <>
          pg_catalog.trunc((item.value ->> 'expectedRevision')::numeric)
        or not (
          (
            item.value #>> '{assignee,kind}' = 'organization_account'
            and (item.value -> 'assignee') - array[
              'kind', 'organizationAccountId'
            ]::text[] = '{}'::jsonb
            and (item.value -> 'assignee') ?& array[
              'kind', 'organizationAccountId'
            ]
            and pg_catalog.jsonb_typeof(
              item.value #> '{assignee,organizationAccountId}'
            ) = 'string'
          )
          or (
            item.value #>> '{assignee,kind}' = 'group'
            and (item.value -> 'assignee') - array['kind', 'groupId']::text[] = '{}'::jsonb
            and (item.value -> 'assignee') ?& array['kind', 'groupId']
            and pg_catalog.jsonb_typeof(item.value #> '{assignee,groupId}') = 'string'
          )
        )
    ) then
      raise exception using errcode = '22023',
        message = 'Affected assignment manifest entry is invalid';
    end if;

    perform 1
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = target_organization_id
      and assignment.role_id = target_role_id
      and assignment.state = 'live'
    order by assignment.role_assignment_id
    for update;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'roleAssignmentId', assignment.role_assignment_id,
          'expectedRevision', assignment.revision,
          'assignee', case
            when assignment.assignee_kind = 'organization_account' then
              pg_catalog.jsonb_build_object(
                'kind', 'organization_account',
                'organizationAccountId', assignment.organization_account_id
              )
            else pg_catalog.jsonb_build_object(
              'kind', 'group', 'groupId', assignment.group_id
            )
          end
        ) order by assignment.role_assignment_id
      ),
      '[]'::jsonb
    ) into canonical_assignments
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = target_organization_id
      and assignment.role_id = target_role_id
      and assignment.state = 'live';

    if manifest -> 'assignments' is distinct from canonical_assignments then
      raise exception using errcode = '40001',
        message = 'Affected assignment manifest is stale or incomplete';
    end if;
  elsif manifest is not null then
    raise exception using errcode = '22023',
      message = 'This role change must not carry an affected assignment manifest';
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision
    )
    select permission.organization_id, permission.role_id, target_role_revision,
      permission.entry_ordinal, permission.role_kind,
      permission.role_application_root_id, permission.application_root_id,
      permission.owner_kind, permission.owner_id, permission.permission_id,
      permission.registration_kind, permission.registration_owner_id,
      permission.accepted_registration_revision, permission.catalogue_fingerprint,
      permission.continuity_revision
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = current_revision.revision
    order by permission.entry_ordinal;
  else
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision
    )
    select target_organization_id, target_role_id, target_role_revision,
      item.ordinality, target_role_kind,
      case when target_role_kind = 'application' then target_application_root_id else null end,
      continuity.application_root_id, continuity.owner_kind,
      continuity.owner_id, continuity.permission_id,
      continuity.registration_kind, continuity.registration_owner_id,
      (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
      item.value ->> 'catalogueFingerprint',
      (item.value ->> 'continuityRevision')::numeric::bigint
    from pg_catalog.jsonb_array_elements(candidate_permissions) with ordinality
      as item(value, ordinality)
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
    order by item.ordinality;
  end if;

  if policy_value is not null then
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision,
      maximum_activation_duration_seconds,
      reason_required, authentication_requirement,
      authentication_maximum_age_seconds,
      changed_by, changed_at, change_correlation_id
    ) values (
      target_organization_id, target_role_id, target_activation_policy_id,
      target_activation_policy_revision,
      (policy_value ->> 'maximumActivationDurationSeconds')::numeric::bigint,
      (policy_value ->> 'reasonRequired')::boolean,
      policy_value #>> '{recentAuthentication,kind}',
      case when policy_value #>> '{recentAuthentication,kind}' = 'none' then null
        else (policy_value #>>
          '{recentAuthentication,maximumAgeSeconds}')::numeric::bigint end,
      p_changed_by, operation_at, p_correlation_id
    );
  end if;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, accepted_registration_revision,
    template_continuity_revision,
    changed_by, changed_at, change_correlation_id
  ) values (
    target_organization_id, target_role_id, target_role_revision,
    target_role_kind, target_application_root_id, target_lifecycle,
    target_privilege_classification, target_assignment_policy,
    target_policy_continuity_revision, target_authority_continuity_revision,
    target_activation_policy_id, target_activation_policy_revision,
    target_role_key, target_label,
    target_description, target_source_definition_key,
    target_source_release_revision, target_source_release_version,
    target_source_validation_contract_version, target_accepted_registration_revision,
    target_template_continuity_revision,
    p_changed_by, operation_at, p_correlation_id
  );

  if current_revision.organization_id is not null then
    update vortex_access.organization_roles as stored
    set live_revision = target_role_revision,
      role_key = target_role_key
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
      and stored.live_revision = expected_role_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role revision changed concurrently';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    target_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_catalogue_changed'
  ) as version;

  select pg_catalog.jsonb_build_object(
    'roleId', revision.role_id,
    'organizationId', revision.organization_id,
    'key', revision.role_key,
    'label', revision.label,
    'description', revision.description,
    'kind', revision.role_kind,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case
      when revision.assignment_policy = 'standing' then
        pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'activationPolicyId', revision.activation_policy_id,
          'revision', revision.activation_policy_revision
        )
      )
    end,
    'policyContinuityRevision', revision.policy_continuity_revision,
    'authorityContinuityRevision', revision.authority_continuity_revision,
    'lifecycle', revision.lifecycle,
    'permissions', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'exact',
          'applicationRootId', permission.application_root_id,
          'ownerKind', permission.owner_kind,
          'ownerId', permission.owner_id,
          'permissionId', permission.permission_id,
          'acceptedRegistrationRevision', permission.accepted_registration_revision,
          'catalogueFingerprint', permission.catalogue_fingerprint,
          'continuityRevision', permission.continuity_revision
        )) order by permission.entry_ordinal
      )
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    ), '[]'::jsonb),
    'createdByActorId', identity.created_by,
    'createdAt', identity.created_at,
    'changedByActorId', revision.changed_by,
    'changedAt', revision.changed_at,
    'changeCorrelationId', revision.change_correlation_id
  ) || case
    when revision.role_kind = 'application' then pg_catalog.jsonb_build_object(
      'applicationRootId', identity.application_root_id,
      'source', pg_catalog.jsonb_build_object(
        'applicationRootId', identity.application_root_id,
        'sourceRoleId', identity.source_role_id,
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', 'application',
          'definitionKey', revision.source_definition_key,
          'rootId', identity.application_root_id,
          'releaseRevision', revision.source_release_revision,
          'releaseVersion', revision.source_release_version,
          'validationContractVersion', revision.source_validation_contract_version,
          'contentFingerprint', source_release.content_fingerprint,
          'resolutionFingerprint', source_release.resolution_fingerprint
        ),
        'sourceCatalogueFingerprint', registration.permission_catalogue_fingerprint,
        'acceptedRegistrationRevision', revision.accepted_registration_revision,
        'templateContinuityRevision', revision.template_continuity_revision
      )
    )
    when identity.derived_application_root_id is not null then
      pg_catalog.jsonb_build_object(
        'derivedFromTemplate', pg_catalog.jsonb_build_object(
          'applicationRootId', identity.derived_application_root_id,
          'sourceRoleId', identity.derived_source_role_id,
          'sourceRelease', pg_catalog.jsonb_build_object(
            'kind', 'application',
            'definitionKey', identity.derived_source_definition_key,
            'rootId', identity.derived_application_root_id,
            'releaseRevision', identity.derived_source_release_revision,
            'releaseVersion', identity.derived_source_release_version,
            'validationContractVersion',
              identity.derived_source_validation_contract_version
          )
        )
      )
    else '{}'::jsonb
  end
  into role_result
  from vortex_access.organization_roles as identity
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = identity.organization_id
    and revision.role_id = identity.role_id
    and revision.revision = identity.live_revision
  left join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = revision.organization_id
    and registration.registration_kind = revision.source_registration_kind
    and registration.registration_owner_id = revision.application_root_id
    and registration.revision = revision.accepted_registration_revision
  left join vortex_definition.releases as source_release
    on source_release.root_id = revision.application_root_id
    and source_release.release_revision = revision.source_release_revision
    and source_release.release_version = revision.source_release_version
    and source_release.validation_contract_version = revision.source_validation_contract_version
  where identity.organization_id = target_organization_id
    and identity.role_id = target_role_id;

  if policy_value is not null then
    select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'organizationId', policy.organization_id,
      'roleId', policy.role_id,
      'activationPolicyId', policy.activation_policy_id,
      'revision', policy.revision,
      'maximumActivationDurationSeconds', policy.maximum_activation_duration_seconds,
      'reasonRequired', policy.reason_required,
      'recentAuthentication', case
        when policy.authentication_requirement = 'none' then
          pg_catalog.jsonb_build_object('kind', 'none')
        else pg_catalog.jsonb_build_object(
          'kind', policy.authentication_requirement,
          'maximumAgeSeconds', policy.authentication_maximum_age_seconds
        )
      end,
      'changedByActorId', policy.changed_by,
      'changedAt', policy.changed_at,
      'changeCorrelationId', policy.change_correlation_id
    )) into policy_result
    from vortex_access.organization_role_activation_policy_revisions as policy
    where policy.organization_id = target_organization_id
      and policy.role_id = target_role_id
      and policy.activation_policy_id = target_activation_policy_id
      and policy.revision = target_activation_policy_revision;
  end if;

  return query select 'changed'::text, operation_name, role_result,
    policy_result, next_access_version, p_correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value then
    raise exception using errcode = '22023',
      message = 'Organization role-change evidence is invalid';
end
$function$;

revoke execute on function
  vortex_access.coordinate_role_change_without_stewardship_internal(
    jsonb, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_role_change_without_stewardship_internal(
  jsonb, uuid, uuid
) is
  'Owner-only atomic seven-intent role governance composition. It verifies exact evidence and manifests, changes Access once, and grants no caller authority.';

grant execute on function vortex_access.coordinate_role_change_without_stewardship_internal(jsonb, uuid, uuid) to postgres;

alter function vortex_access.coordinate_role_change_without_stewardship_internal(jsonb, uuid, uuid) owner to vortex_owner;

create or replace function vortex_access.deactivate_organization_role_activation_for_administration(
  p_role_activation_id uuid, p_expected_activation_revision bigint, p_activity_id uuid
)
returns table (outcome text, organization_id uuid, activation_summary jsonb, access_version bigint, refusal_reason text)
language plpgsql volatile security definer set search_path = '' as $function$
declare
  context_value jsonb; context_organization_id uuid; context_account_id uuid;
  context_access_version bigint; context_correlation_id uuid;
  locked_access_version bigint; activation_fact vortex_access.organization_role_activations%rowtype;
  affected_permissions jsonb; decision record; changed record; summary jsonb;
  activity_result text;
begin
  if p_role_activation_id is null or p_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_activation_revision is null or p_expected_activation_revision not between 1 and 9007199254740991
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Role activation deactivation input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active' for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501', message = 'Role activation deactivation is unavailable';
  end if;
  select activation.* into activation_fact
  from vortex_access.organization_role_activations as activation
  where activation.organization_id = context_organization_id
    and activation.role_activation_id = p_role_activation_id for update;
  if not found or activation_fact.revision <> p_expected_activation_revision
    or activation_fact.state <> 'live' then
    raise exception using errcode = '40001', message = 'Role activation deactivation is stale or unavailable';
  end if;
  if activation_fact.organization_account_id <> context_account_id then
    select pg_catalog.jsonb_agg(reference.permission order by reference.application_root_id nulls first,
      reference.owner_kind, reference.owner_id, reference.permission_id) into affected_permissions
    from (select permission.application_root_id, permission.owner_kind, permission.owner_id,
      permission.permission_id, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id, 'ownerKind', permission.owner_kind,
        'ownerId', permission.owner_id, 'permissionId', permission.permission_id,
        'acceptedRegistrationRevision', permission.accepted_registration_revision)) as permission
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = context_organization_id
        and permission.role_id = activation_fact.role_id
        and permission.role_revision = activation_fact.historical_role_revision) as reference;
    if affected_permissions is null then
      raise exception using errcode = '40001', message = 'Role activation historical scope is unavailable';
    end if;
    select evaluated.* into strict decision from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object('operationKey', 'platform.organization.role_activations.revoke',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
        'authority', pg_catalog.jsonb_build_object('kind', 'delegated_management',
          'before', pg_catalog.jsonb_build_object('kind', 'bounded', 'permissions', affected_permissions),
          'after', pg_catalog.jsonb_build_object('kind', 'none')))) as evaluated;
    if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.role_activations.revoke'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revoke_role_activation',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Role activation deactivation refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.role_activations.revoke'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Role activation deactivation is unavailable';
  end if;
  end if;
  select result.* into strict changed from vortex_access.coordinate_organization_role_activation_change(
    'revoke_role_activation', context_organization_id, p_role_activation_id,
    p_expected_activation_revision, null, null, null, null, null, null, null,
    null, null, context_account_id, context_correlation_id) as result;
  summary := vortex_access.project_organization_role_activation_summary(context_organization_id, p_role_activation_id);
  if summary is null then raise exception using errcode = '40001', message = 'Changed activation projection is unavailable'; end if;
  activity_result := vortex_record.append_organization_activity_entry(context_organization_id,
    p_activity_id, (changed.activation ->> 'changedAt')::timestamptz, 'organization_account',
    context_account_id, 'revoke_role_activation', array[p_role_activation_id]::uuid[],
    array[]::uuid[], vortex_platform.channel(), context_correlation_id, 'completed');
  if activity_result is distinct from 'inserted' then raise exception using errcode = '40001', message = 'Role activation Activity is stale'; end if;
  return query select 'completed'::text, context_organization_id, summary, changed.access_version, null::text;
end $function$;

revoke execute on function vortex_access.deactivate_organization_role_activation_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.deactivate_organization_role_activation_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.deactivate_organization_role_activation_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs revoke_role_activation after fixed protected checks, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.deactivate_organization_role_activation_for_administration(p_role_activation_id uuid, p_expected_activation_revision bigint, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.deactivate_organization_role_activation_for_administration(p_role_activation_id uuid, p_expected_activation_revision bigint, p_activity_id uuid) to postgres;

create or replace function vortex_access.evaluate_organization_delegation_internal(
  context_organization_value uuid,
  context_account_value uuid,
  context_expires_value timestamptz,
  decision_checked_at timestamptz,
  declaration_authority jsonb
)
returns table (requirement_count bigint, selected_count bigint, path_valid_until timestamptz)
language sql stable security invoker set search_path = ''
as $function$
  with management_scopes as materialized (
    select declaration_authority -> 'before' as scope
    where declaration_authority ->> 'kind' = 'delegated_management'
    union all
    select declaration_authority -> 'after'
    where declaration_authority ->> 'kind' = 'delegated_management'
  ), delegation_requirements as materialized (
    -- Existing role revisions name the meaning they accepted. New authority requests use the
    -- current meaning, so an older bounded delegation cannot confer widened permission scope.
    select 'organization_catalogue'::text as requirement_kind,
      null::uuid as application_root_id, null::text as owner_kind,
      null::uuid as owner_id, null::uuid as permission_id,
      null::bigint as accepted_registration_revision
    where exists (
      select 1 from management_scopes as managed
      where managed.scope ->> 'kind' = 'organization_catalogue'
    )
    union all
    select distinct 'bounded',
      case when permission.value ? 'applicationRootId'
        then (permission.value ->> 'applicationRootId')::uuid
        else null::uuid
      end,
      permission.value ->> 'ownerKind',
      (permission.value ->> 'ownerId')::uuid,
      (permission.value ->> 'permissionId')::uuid,
      coalesce(
        (permission.value ->> 'acceptedRegistrationRevision')::bigint,
        current_entry.registration_revision
      )
    from management_scopes as managed
    cross join lateral pg_catalog.jsonb_array_elements(
      case when managed.scope ->> 'kind' = 'bounded'
        then managed.scope -> 'permissions'
        else '[]'::jsonb
      end
    ) as permission(value)
    left join lateral (
      select catalogue.registration_revision
      from vortex_access.permission_registrations as registration
      join vortex_access.permission_catalogue_entries as catalogue
        on catalogue.organization_id = registration.organization_id
        and catalogue.registration_kind = registration.registration_kind
        and catalogue.registration_owner_id is not distinct from registration.registration_owner_id
        and catalogue.registration_revision = registration.revision
      where registration.organization_id = context_organization_value
        and registration.state = 'active'
        and not permission.value ? 'acceptedRegistrationRevision'
        and catalogue.application_root_id is not distinct from
          (permission.value ->> 'applicationRootId')::uuid
        and catalogue.owner_kind = permission.value ->> 'ownerKind'
        and catalogue.owner_id = (permission.value ->> 'ownerId')::uuid
        and catalogue.permission_id = (permission.value ->> 'permissionId')::uuid
    ) as current_entry on true
  ), current_delegation_paths as materialized (
    select 1 as route_rank, delegation.delegation_authority_id,
      null::uuid as membership_id, delegation.scope_kind,
      delegation.bounded_permissions,
      least(
        context_expires_value,
        coalesce(delegation.expires_at, context_expires_value)
      ) as path_valid_until
    from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id = context_organization_value
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = context_account_value
      and delegation.state = 'live'
      and delegation.starts_at <= decision_checked_at
      and (
        delegation.expires_at is null
        or delegation.expires_at > decision_checked_at
      )

    union all

    select 2, delegation.delegation_authority_id,
      membership.membership_id, delegation.scope_kind,
      delegation.bounded_permissions,
      least(
        context_expires_value,
        coalesce(delegation.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value)
      )
    from vortex_access.organization_delegation_authorities as delegation
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = delegation.organization_id
      and organization_group.group_id = delegation.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = delegation.organization_id
      and membership.group_id = delegation.group_id
      and membership.organization_account_id = context_account_value
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where delegation.organization_id = context_organization_value
      and delegation.holder_kind = 'group'
      and delegation.state = 'live'
      and delegation.starts_at <= decision_checked_at
      and (
        delegation.expires_at is null
        or delegation.expires_at > decision_checked_at
      )
  ), current_bounded_path_permissions as materialized (
    select path.delegation_authority_id, path.membership_id,
      case when stored.value ? 'applicationRootId'
        then (stored.value ->> 'applicationRootId')::uuid
        else null::uuid
      end as application_root_id,
      stored.value ->> 'ownerKind' as owner_kind,
      (stored.value ->> 'ownerId')::uuid as owner_id,
      (stored.value ->> 'permissionId')::uuid as permission_id,
      accepted.registration_revision as accepted_registration_revision,
      accepted as accepted_entry
    from current_delegation_paths as path
    cross join lateral pg_catalog.jsonb_array_elements(
      path.bounded_permissions
    ) as stored(value)
    cross join lateral vortex_access.accepted_permission_meaning_internal(
      context_organization_value,
      case when stored.value ? 'applicationRootId'
        then (stored.value ->> 'applicationRootId')::uuid else null::uuid end,
      stored.value ->> 'ownerKind',
      (stored.value ->> 'ownerId')::uuid,
      (stored.value ->> 'permissionId')::uuid,
      (stored.value ->> 'continuityRevision')::numeric::bigint,
      (stored.value ->> 'acceptedRegistrationRevision')::numeric::bigint
    ) as accepted
    where path.scope_kind = 'bounded'
  ), delegation_path_candidates as (
    select requirement.requirement_kind, requirement.application_root_id,
      requirement.owner_kind, requirement.owner_id,
      requirement.permission_id, requirement.accepted_registration_revision,
      path.route_rank,
      path.delegation_authority_id, path.membership_id,
      path.path_valid_until,
      pg_catalog.row_number() over (
        partition by requirement.requirement_kind,
          requirement.application_root_id, requirement.owner_kind,
          requirement.owner_id, requirement.permission_id,
          requirement.accepted_registration_revision
        order by path.route_rank, path.delegation_authority_id,
          path.membership_id nulls first
      ) as path_ordinal
    from delegation_requirements as requirement
    join current_delegation_paths as path
      on path.scope_kind = 'organization_catalogue'
      or (
        requirement.requirement_kind = 'bounded'
        and exists (
          select 1
          from current_bounded_path_permissions as covered
          where covered.delegation_authority_id =
              path.delegation_authority_id
            and covered.membership_id is not distinct from path.membership_id
            and covered.application_root_id is not distinct from
              requirement.application_root_id
            and covered.owner_kind = requirement.owner_kind
            and covered.owner_id = requirement.owner_id
            and covered.permission_id = requirement.permission_id
            and requirement.accepted_registration_revision is not null
            and exists (
              select 1 from vortex_access.permission_catalogue_entries as required_entry
              where required_entry.organization_id = context_organization_value
                and required_entry.application_root_id is not distinct from requirement.application_root_id
                and required_entry.owner_kind = requirement.owner_kind
                and required_entry.owner_id = requirement.owner_id
                and required_entry.permission_id = requirement.permission_id
                and required_entry.registration_revision = requirement.accepted_registration_revision
                and required_entry.registration_kind = case
                  when requirement.application_root_id is null then 'platform' else 'application' end
                and required_entry.registration_owner_id = coalesce(
                  requirement.application_root_id, requirement.owner_id)
                and vortex_access.permission_meaning_is_same_internal(covered.accepted_entry, required_entry)
            )
        )
      )
    where requirement.requirement_kind <> 'organization_catalogue'
      or path.scope_kind = 'organization_catalogue'
  ), selected_delegation_paths as materialized (
    select candidate.requirement_kind, candidate.application_root_id,
      candidate.owner_kind, candidate.owner_id, candidate.permission_id,
      candidate.accepted_registration_revision,
      candidate.path_valid_until
    from delegation_path_candidates as candidate
    where candidate.path_ordinal = 1
  ), delegation_summary as (
    select pg_catalog.count(*) as requirement_count,
      pg_catalog.count(selected.requirement_kind) as selected_count,
      pg_catalog.min(selected.path_valid_until) as path_valid_until
    from delegation_requirements as requirement
    left join selected_delegation_paths as selected
      on selected.requirement_kind = requirement.requirement_kind
      and selected.application_root_id is not distinct from
        requirement.application_root_id
      and selected.owner_kind is not distinct from requirement.owner_kind
      and selected.owner_id is not distinct from requirement.owner_id
      and selected.permission_id is not distinct from requirement.permission_id
      and selected.accepted_registration_revision is not distinct from
        requirement.accepted_registration_revision

  )
  select summary.requirement_count, summary.selected_count, summary.path_valid_until
  from delegation_summary as summary;
$function$;

alter function vortex_access.evaluate_organization_delegation_internal(uuid, uuid, timestamptz, timestamptz, jsonb) owner to vortex_owner;
revoke all on function vortex_access.evaluate_organization_delegation_internal(uuid, uuid, timestamptz, timestamptz, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.evaluate_organization_delegation_internal(uuid, uuid, timestamptz, timestamptz, jsonb) to vortex_owner, postgres;

create or replace function vortex_access.evaluate_organization_permission_eligibility(
  p_declaration jsonb
)
returns table (
  outcome text,
  operation_key text,
  target_kind text,
  target_application_root_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint,
  checked_at timestamptz,
  valid_until timestamptz,
  correlation_id uuid,
  reason_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  declaration_action jsonb;
  declaration_target jsonb;
  declaration_permission jsonb;
  declaration_authentication jsonb;
  declaration_authority jsonb;
  scope_candidate jsonb;
  permission_candidate jsonb;
  scope_name text;
  operation_value text;
  target_kind_value text;
  target_application_value uuid;
  permission_application_value uuid;
  permission_owner_kind_value text;
  authority_kind_value text;
  context_value jsonb;
  context_organization_value uuid;
  context_account_value uuid;
  context_access_version_value bigint;
  context_application_value uuid;
  context_expires_value timestamptz;
  context_correlation_value uuid;
  authentication_deadline timestamptz;
  authentication_satisfied boolean := true;
  context_current boolean := true;
  target_context_satisfied boolean := true;
  unsupported_context boolean := false;
  decision_checked_at timestamptz;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or not p_declaration ?& array[
      'operationKey', 'action', 'target', 'requiredPermission',
      'recentAuthentication', 'authority'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_declaration) as supplied(key)
      where supplied.key <> all (array[
        'operationKey', 'action', 'target', 'requiredPermission',
        'recentAuthentication', 'authority'
      ])
    )
    or pg_catalog.jsonb_typeof(p_declaration -> 'operationKey') <> 'string'
    or pg_catalog.char_length(p_declaration ->> 'operationKey') not between 3 and 120
    or (p_declaration ->> 'operationKey') !~
      '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or (p_declaration ->> 'operationKey') ~ '(^|\.)[^.]{41,}(\.|$)' then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  declaration_action := p_declaration -> 'action';
  declaration_target := p_declaration -> 'target';
  declaration_permission := p_declaration -> 'requiredPermission';
  declaration_authentication := p_declaration -> 'recentAuthentication';
  declaration_authority := p_declaration -> 'authority';

  if pg_catalog.jsonb_typeof(declaration_action) <> 'object'
    or not declaration_action ? 'actionKind'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_action) as supplied(key)
      where supplied.key <> all (array['actionKind', 'namedAction'])
    )
    or pg_catalog.jsonb_typeof(declaration_action -> 'actionKind') <> 'string'
    or declaration_action ->> 'actionKind' not in (
      'create', 'read', 'update', 'delete', 'restore', 'export', 'share', 'manage', 'named'
    )
    or (
      (declaration_action ->> 'actionKind') = 'named'
      and (
        not declaration_action ? 'namedAction'
        or pg_catalog.jsonb_typeof(declaration_action -> 'namedAction') <> 'string'
        or pg_catalog.char_length(declaration_action ->> 'namedAction') not between 1 and 40
        or (declaration_action ->> 'namedAction') !~
          '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      )
    )
    or (
      (declaration_action ->> 'actionKind') <> 'named'
      and declaration_action ? 'namedAction'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_target) <> 'object'
    or not declaration_target ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_target -> 'kind') <> 'string'
    or declaration_target ->> 'kind' not in ('organization', 'application')
    or (
      declaration_target ->> 'kind' = 'organization'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_target ->> 'kind' = 'application'
      and (
        not declaration_target ? 'applicationRootId'
        or not vortex_platform.is_non_nil_uuid(
          declaration_target ->> 'applicationRootId'
        )
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
          where supplied.key <> all (array['kind', 'applicationRootId'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authentication) <> 'object'
    or not declaration_authentication ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authentication -> 'kind') <> 'string'
    or declaration_authentication ->> 'kind' not in ('none', 'primary', 'multi_factor')
    or (
      declaration_authentication ->> 'kind' = 'none'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
      and (
        not declaration_authentication ? 'maximumAgeSeconds'
        or pg_catalog.jsonb_typeof(
          declaration_authentication -> 'maximumAgeSeconds'
        ) <> 'number'
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
          where supplied.key <> all (array['kind', 'maximumAgeSeconds'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
    and (
      (declaration_authentication ->> 'maximumAgeSeconds')::numeric < 1
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric >
        9007199254740991
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric <>
        pg_catalog.trunc(
          (declaration_authentication ->> 'maximumAgeSeconds')::numeric
        )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authority) <> 'object'
    or not declaration_authority ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authority -> 'kind') <> 'string'
    or declaration_authority ->> 'kind' not in ('permission', 'delegated_management')
    or (
      declaration_authority ->> 'kind' = 'permission'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authority ->> 'kind' = 'delegated_management'
      and (
        not declaration_authority ?& array['before', 'after']
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
          where supplied.key <> all (array['kind', 'before', 'after'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if declaration_authority ->> 'kind' = 'delegated_management' then
    foreach scope_name in array array['before', 'after'] loop
      scope_candidate := declaration_authority -> scope_name;
      if pg_catalog.jsonb_typeof(scope_candidate) <> 'object'
        or not scope_candidate ? 'kind'
        or pg_catalog.jsonb_typeof(scope_candidate -> 'kind') <> 'string'
        or scope_candidate ->> 'kind' not in (
          'none', 'organization_catalogue', 'bounded'
        )
        or (
          scope_candidate ->> 'kind' in ('none', 'organization_catalogue')
          and exists (
            select 1
            from pg_catalog.jsonb_object_keys(scope_candidate) as supplied(key)
            where supplied.key <> 'kind'
          )
        )
        or (
          scope_candidate ->> 'kind' = 'bounded'
          and (
            not scope_candidate ? 'permissions'
            or pg_catalog.jsonb_typeof(scope_candidate -> 'permissions') <> 'array'
            or pg_catalog.jsonb_array_length(scope_candidate -> 'permissions') = 0
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(scope_candidate) as supplied(key)
              where supplied.key <> all (array['kind', 'permissions'])
            )
          )
        ) then
        raise exception using errcode = '22023',
          message = 'Organization permission declaration is invalid';
      end if;
    end loop;

    if declaration_authority -> 'before' ->> 'kind' = 'none'
      and declaration_authority -> 'after' ->> 'kind' = 'none' then
      raise exception using errcode = '22023',
        message = 'Organization permission declaration is invalid';
    end if;
  end if;

  for permission_candidate in
    select candidate.value
    from (
      select declaration_permission as value
      union all
      select scoped.value
      from pg_catalog.jsonb_array_elements(
        case
          when declaration_authority ->> 'kind' = 'delegated_management'
            and declaration_authority -> 'before' ->> 'kind' = 'bounded'
          then declaration_authority -> 'before' -> 'permissions'
          else '[]'::jsonb
        end
      ) as scoped(value)
      union all
      select scoped.value
      from pg_catalog.jsonb_array_elements(
        case
          when declaration_authority ->> 'kind' = 'delegated_management'
            and declaration_authority -> 'after' ->> 'kind' = 'bounded'
          then declaration_authority -> 'after' -> 'permissions'
          else '[]'::jsonb
        end
      ) as scoped(value)
    ) as candidate
  loop
    if pg_catalog.jsonb_typeof(permission_candidate) <> 'object'
      or not permission_candidate ?& array['ownerKind', 'ownerId', 'permissionId']
      or pg_catalog.jsonb_typeof(permission_candidate -> 'ownerKind') <> 'string'
      or permission_candidate ->> 'ownerKind' not in ('platform', 'application', 'module')
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'ownerId')
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'permissionId')
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(permission_candidate) as supplied(key)
        where supplied.key <> all (array[
          'applicationRootId', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision'
        ])
      )
      or (permission_candidate ? 'acceptedRegistrationRevision' and (
        pg_catalog.jsonb_typeof(permission_candidate -> 'acceptedRegistrationRevision') <> 'number'
        or (permission_candidate ->> 'acceptedRegistrationRevision')::numeric
          not between 1 and 9007199254740991
        or (permission_candidate ->> 'acceptedRegistrationRevision')::numeric <>
          pg_catalog.trunc((permission_candidate ->> 'acceptedRegistrationRevision')::numeric)
      ))
      or (
        permission_candidate ->> 'ownerKind' = 'platform'
        and permission_candidate ? 'applicationRootId'
      )
      or (
        permission_candidate ->> 'ownerKind' in ('application', 'module')
        and (
          not permission_candidate ? 'applicationRootId'
          or not vortex_platform.is_non_nil_uuid(
            permission_candidate ->> 'applicationRootId'
          )
        )
      )
      or (
        permission_candidate ->> 'ownerKind' = 'application'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(permission_candidate ->> 'applicationRootId')
      ) then
      raise exception using errcode = '22023',
        message = 'Organization permission declaration is invalid';
    end if;
  end loop;

  if declaration_authority ->> 'kind' = 'delegated_management' then
    foreach scope_name in array array['before', 'after'] loop
      scope_candidate := declaration_authority -> scope_name;
      if scope_candidate ->> 'kind' = 'bounded'
        and (
          select pg_catalog.count(*)
          from pg_catalog.jsonb_array_elements(scope_candidate -> 'permissions')
        ) <> (
          select pg_catalog.count(distinct pg_catalog.concat_ws(
            ':',
            pg_catalog.lower(permission.value ->> 'applicationRootId'),
            permission.value ->> 'ownerKind',
            pg_catalog.lower(permission.value ->> 'ownerId'),
            pg_catalog.lower(permission.value ->> 'permissionId'),
            permission.value ->> 'acceptedRegistrationRevision'
          ))
          from pg_catalog.jsonb_array_elements(
            scope_candidate -> 'permissions'
          ) as permission(value)
        ) then
        raise exception using errcode = '22023',
          message = 'Organization permission declaration is invalid';
      end if;
    end loop;
  end if;

  operation_value := p_declaration ->> 'operationKey';
  target_kind_value := declaration_target ->> 'kind';
  target_application_value := case
    when target_kind_value = 'application'
      then (declaration_target ->> 'applicationRootId')::uuid
    else null
  end;
  permission_application_value := case
    when declaration_permission ? 'applicationRootId'
      then (declaration_permission ->> 'applicationRootId')::uuid
    else null
  end;
  permission_owner_kind_value := declaration_permission ->> 'ownerKind';
  authority_kind_value := declaration_authority ->> 'kind';

  if (target_kind_value = 'organization' and permission_owner_kind_value <> 'platform')
    or (
      target_kind_value = 'application'
      and (
        permission_owner_kind_value = 'platform'
        or permission_application_value is distinct from target_application_value
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_value := (context_value ->> 'organizationId')::uuid;
  context_account_value := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version_value := (context_value ->> 'accessVersion')::bigint;
  context_application_value := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  context_expires_value := (context_value ->> 'expiresAt')::timestamptz;
  context_correlation_value := (context_value ->> 'correlationId')::uuid;
  decision_checked_at := pg_catalog.clock_timestamp();
  context_current := context_expires_value > decision_checked_at;

  unsupported_context := context_value ? 'delegatedContext'
    or context_value ? 'supportContext';
  target_context_satisfied := target_kind_value = 'organization'
    or coalesce(context_application_value = target_application_value, false);

  authentication_deadline := vortex_access.recent_authentication_deadline_internal(
    context_value, decision_checked_at, declaration_authentication
  );
  authentication_satisfied := authentication_deadline is not null;

  return query
  with permission_eligibility as materialized (
    select evaluated.path_valid_until
    from vortex_access.evaluate_permission_role_path_internal(
      context_value, decision_checked_at, declaration_permission,
      declaration_action, null::uuid
    ) as evaluated
  ), delegation_summary as (
    select * from vortex_access.evaluate_organization_delegation_internal(
      context_organization_value, context_account_value, context_expires_value,
      decision_checked_at, declaration_authority
    )
  ), decision as (
    select exists(select 1 from permission_eligibility) as permission_available,
      (
        select pg_catalog.min(selected.path_valid_until)
        from permission_eligibility as selected
      ) as path_valid_until,
      authority_kind_value = 'permission'
        or (
          delegation.requirement_count > 0
          and delegation.requirement_count = delegation.selected_count
        ) as delegation_satisfied,
      delegation.path_valid_until as delegation_valid_until
    from (select 1) as singleton
    cross join delegation_summary as delegation
  )
  select
    case
      when not context_current
        or unsupported_context or not target_context_satisfied then 'refused'
      when not decision.permission_available then 'refused'
      when decision.path_valid_until is null then 'refused'
      when not authentication_satisfied then 'refused'
      when not decision.delegation_satisfied then 'refused'
      else 'eligible'
    end,
    operation_value,
    target_kind_value,
    target_application_value,
    context_organization_value,
    context_account_value,
    context_access_version_value,
    decision_checked_at,
    case
      when context_current
        and not unsupported_context
        and target_context_satisfied
        and decision.permission_available
        and decision.path_valid_until is not null
        and authentication_satisfied
        and decision.delegation_satisfied
      then least(
        decision.path_valid_until,
        authentication_deadline,
        coalesce(decision.delegation_valid_until, context_expires_value)
      )
      else null
    end,
    context_correlation_value,
    case
      when not context_current
        or unsupported_context or not target_context_satisfied
        then 'target_policy_unavailable'
      when not decision.permission_available then 'permission_unavailable'
      when decision.path_valid_until is null then 'permission_not_effective'
      when not authentication_satisfied and declaration_authentication ->> 'kind' = 'multi_factor'
        then 'multi_factor_unsatisfied'
      when not authentication_satisfied then 'authentication_unsatisfied'
      when not decision.delegation_satisfied then 'delegation_insufficient'
      else null
    end
  from decision;
end
$function$;
alter function vortex_access.evaluate_organization_permission_eligibility(jsonb) owner to vortex_owner;

revoke execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_request, vortex_owner, postgres;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_owner;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_owner;
comment on function vortex_access.evaluate_organization_permission_eligibility(jsonb) is
  'Returns transaction-bound permission and current delegation eligibility from one trusted operation declaration; it is not a final protected-operation decision.';
alter function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  owner to vortex_owner;

create or replace function vortex_access.evaluate_permission_role_path_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_permission jsonb,
  p_action jsonb,
  p_record_type_id uuid
)
returns table (
  permission_entry vortex_access.permission_catalogue_entries,
  path_valid_until timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  context_organization_value uuid := (p_context ->> 'organizationId')::uuid;
  context_account_value uuid := (p_context ->> 'organizationAccountId')::uuid;
  context_expires_value timestamptz := (p_context ->> 'expiresAt')::timestamptz;
  decision_checked_at timestamptz := p_checked_at;
  permission_application_value uuid := (p_permission ->> 'applicationRootId')::uuid;
  permission_owner_kind_value text := p_permission ->> 'ownerKind';
  permission_owner_value uuid := (p_permission ->> 'ownerId')::uuid;
  permission_value uuid := (p_permission ->> 'permissionId')::uuid;
  action_kind_value text := p_action ->> 'actionKind';
  named_action_value text := p_action ->> 'namedAction';
  preview_registration record;
  preview_projection boolean := false;
  projection_live_registration boolean := false;
begin
  -- A preview request decides the permissions of the previewed Application and its own Modules
  -- from the preview's registration alone: the builder who opened the preview holds the draft's
  -- roles there. Every other permission, a used Module's included, and every permission on a
  -- system projection, the platform's live read model, is decided by the builder's own live
  -- access below; the preview's roles never apply to it.
  if permission_owner_kind_value in ('application', 'module')
    and nullif(
      pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
    ) is not null then
    select registration.* into preview_registration
    from vortex_access.request_application_registration_internal(
      context_organization_value,
      (p_context ->> 'applicationRootId')::uuid,
      context_account_value
    ) as registration;
    if preview_registration.registration_kind is distinct from 'preview' then
      return;
    end if;
    preview_projection := coalesce(
      p_record_type_id = any(preview_registration.system_projection_record_type_ids), false
    );
    if permission_owner_value = any(preview_registration.owned_owner_ids)
      and not coalesce(
        p_record_type_id = any(preview_registration.system_projection_record_type_ids), false
      ) then
      return query
      select preview_entry.entry,
        case when preview_entry.held
          then least(context_expires_value, preview_registration.valid_until)
        end
      from vortex_access.preview_permission_entries as preview_entry
      where preview_entry.preview_installation_id = preview_registration.preview_installation_id
        and (preview_entry.entry).application_root_id is not distinct from
          permission_application_value
        and (preview_entry.entry).owner_kind = permission_owner_kind_value
        and (preview_entry.entry).owner_id = permission_owner_value
        and (preview_entry.entry).permission_id = permission_value
        and (preview_entry.entry).record_type_id is not distinct from p_record_type_id
        and (preview_entry.entry).action_kind = action_kind_value
        and (preview_entry.entry).named_action is not distinct from named_action_value;
      return;
    end if;
  end if;

  -- A projection has no preview copy or draft grant. A Module's permission is registered by every
  -- installed Application that links that Module, each under its own Application root, and none of
  -- those is the address of the previewed Application: a projection of a used Module selects its
  -- permission from the caller's live registrations rather than from the address it was asked
  -- about. The common live role-path decision below still proves a current grant, and ordinary
  -- borrowed record types keep their existing refusal.
  if preview_projection and permission_owner_kind_value = 'module' then
    projection_live_registration := true;
  end if;

  return query
  with current_permission as materialized (
    select catalogue.application_root_id, catalogue.owner_kind,
      catalogue.owner_id, catalogue.permission_id,
      catalogue.registration_kind, catalogue.registration_owner_id,
      catalogue.registration_revision, continuity.continuity_revision,
      catalogue as permission_entry,
      catalogue.record_type_id is not distinct from p_record_type_id
        and catalogue.action_kind = action_kind_value
        and catalogue.named_action is not distinct from named_action_value
        as matches_request
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = registration.organization_id
      and catalogue.registration_kind = registration.registration_kind
      and catalogue.registration_owner_id = registration.registration_owner_id
      and catalogue.registration_revision = registration.revision
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = catalogue.organization_id
      and continuity.application_scope_id = coalesce(catalogue.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and continuity.owner_kind = catalogue.owner_kind
      and continuity.owner_id = catalogue.owner_id
      and continuity.permission_id = catalogue.permission_id
      and continuity.registration_kind = catalogue.registration_kind
      and continuity.registration_owner_id = catalogue.registration_owner_id
      and continuity.last_processed_registration_revision = registration.revision
      and continuity.state = 'available'
    where registration.organization_id = context_organization_value
      and registration.state = 'active'
      and (
        projection_live_registration
        or catalogue.application_root_id is not distinct from
          permission_application_value
      )
      and catalogue.owner_kind = permission_owner_kind_value
      and catalogue.owner_id = permission_owner_value
      and catalogue.permission_id = permission_value
  ), current_role_permission as materialized (
    -- The accepted registration remains historical evidence. A changed meaning
    -- advances continuity, so a role cannot retain it without fresh acceptance.
    select role.role_id, role.live_revision,
      revision.assignment_policy, revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision,
      accepted as accepted_entry,
      accepted.registration_revision as accepted_registration_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    join current_permission as available
      on available.application_root_id is not distinct from
        permission.application_root_id
      and available.owner_kind = permission.owner_kind
      and available.owner_id = permission.owner_id
      and available.permission_id = permission.permission_id
      and available.registration_kind = permission.registration_kind
      and available.registration_owner_id is not distinct from
        permission.registration_owner_id
    cross join lateral vortex_access.accepted_permission_meaning_internal(
      permission.organization_id, permission.application_root_id,
      permission.owner_kind, permission.owner_id, permission.permission_id,
      permission.continuity_revision, permission.accepted_registration_revision
    ) as accepted
    where role.organization_id = context_organization_value
      and revision.lifecycle in ('active', 'acceptance_required')
      and accepted.registration_kind = permission.registration_kind
      and accepted.registration_owner_id is not distinct from permission.registration_owner_id
      and accepted.record_type_id is not distinct from p_record_type_id
      and accepted.action_kind = action_kind_value
      and accepted.named_action is not distinct from named_action_value
  ), route_candidates as (
    select 1 as route_rank, permission.role_id,
      assignment.role_assignment_id, null::uuid as membership_id,
      null::uuid as role_activation_id,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value)
      ) as path_valid_until
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 2, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, null::uuid,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value)
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 3, permission.role_id, assignment.role_assignment_id,
      null::uuid, activation.role_activation_id,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'direct'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
    where permission.assignment_policy = 'activation_required'

    union all

    select 4, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, activation.role_activation_id,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'group'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'activation_required'
  ), granted as materialized (
    -- Every accepted meaning the caller holds through a live path is granted: a caller holding
    -- two roles with different accepted meanings of the permission has both, each with the
    -- earliest deadline of the paths that carry it. Registration revisions are local to each
    -- registration, so equal revisions under different Application addresses remain distinct.
    select distinct on (
      (route.accepted_entry).organization_id,
      (route.accepted_entry).application_root_id,
      (route.accepted_entry).owner_kind,
      (route.accepted_entry).owner_id,
      (route.accepted_entry).permission_id,
      (route.accepted_entry).registration_kind,
      (route.accepted_entry).registration_owner_id,
      route.accepted_registration_revision
    )
      route.accepted_entry as permission_entry, route.path_valid_until
    from route_candidates as route
    order by (route.accepted_entry).organization_id,
      (route.accepted_entry).application_root_id,
      (route.accepted_entry).owner_kind,
      (route.accepted_entry).owner_id,
      (route.accepted_entry).permission_id,
      (route.accepted_entry).registration_kind,
      (route.accepted_entry).registration_owner_id,
      route.accepted_registration_revision, route.path_valid_until
  ), administered as materialized (
    -- A super administrator is evaluated with the registered meaning.
    select available.permission_entry, context_expires_value as path_valid_until
    from current_permission as available
    where available.matches_request
      and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        (p_context ->> 'identityId')::uuid, decision_checked_at
      ) is not null
  )
  select granted.permission_entry, granted.path_valid_until from granted
  union all
  select administered.permission_entry, administered.path_valid_until from administered
  union all
  -- Without a live path the registered permission is returned with no deadline, so callers
  -- can tell an unavailable permission from one that is not effective.
  select available.permission_entry, null::timestamptz
  from current_permission as available
  where available.matches_request
    and not exists (select 1 from granted)
    and not exists (select 1 from administered);
end
$function$;

revoke execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) to vortex_owner;

comment on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) is
  'Private current-permission and role-path evidence; null record type selects only non-record permissions. It returns one row per accepted meaning the caller holds through a live role path (never a later registered meaning), the registered meaning for a super administrator, or the registered permission without a deadline when no path is live. A preview request decides the previewed Application''s own permissions from its preview registration, and a permission on a system projection of a used Module from the caller''s live registrations, under whichever Application links that Module. No row authority.';

alter function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) owner to vortex_owner;

grant execute on function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) to postgres;

create or replace function vortex_access.initialize_platform_permission_catalogue(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  organization_id uuid,
  registration_revision bigint,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_registration vortex_access.permission_registrations%rowtype;
  resulting_version bigint;
  expected_count bigint;
  platform_owner_id constant uuid := vortex_access.platform_permission_owner_id();
  catalogue_fingerprint constant text :=
    'sha256:60d2c42cab03723fda56198083a70e8703792587546379372334d99609b15538';
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Platform permission registration input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Platform permission registration scope is unavailable';
  end if;

  perform pg_catalog.set_config(
    'vortex_access.exclusive_organization_id', p_organization_id::text, true
  );

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
  for update;
  if found then
    if not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 6
    ) then
      raise exception using errcode = '55000',
        message = 'Platform permission registration evidence is invalid';
    end if;
    return query select p_organization_id, 6::bigint, version.current_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return;
  end if;

  select pg_catalog.count(*) into expected_count
  from vortex_access.read_platform_permission_declaration_catalogue_internal(6);
  if expected_count <> 23 then
    raise exception using errcode = '55000',
      message = 'Platform permission declarations are invalid';
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version, source_revision,
    validation_contract_version, permission_catalogue_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 6,
    'active', 'platform_initialize', null, '1.4.0', null, null,
    catalogue_fingerprint, operation_at, p_changed_by,
    p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    record_scope, field_policy, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version,
    source_revision, source_validation_contract_version,
    source_catalogue_fingerprint
  )
  select p_organization_id, 'platform', platform_owner_id, 6,
    null, 'platform', platform_owner_id, declaration.permission_id,
    declaration.permission_key, declaration.label, declaration.description,
    null, null, null, declaration.action_kind, null, true,
    'platform_catalogue', null, null, declaration.source_version,
    null, null, declaration.catalogue_fingerprint
  from vortex_access.read_platform_permission_declaration_catalogue_internal(6)
    as declaration;

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state, revision,
    source_definition_key, source_version, source_revision,
    validation_contract_version, permission_catalogue_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 'active', 6,
    null, '1.4.0', null, null, catalogue_fingerprint,
    operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision,
    last_processed_registration_revision, changed_at
  )
  select p_organization_id, null, 'platform', platform_owner_id,
    declaration.permission_id, 'platform', platform_owner_id, 'available',
    1, 6, operation_at
  from vortex_access.read_platform_permission_declaration_catalogue_internal(6)
    as declaration;

  if not vortex_access.platform_permission_catalogue_revision_is_exact(
    p_organization_id, 6
  ) then
    raise exception using errcode = '55000',
      message = 'Platform permission registration evidence is invalid';
  end if;

  select incremented.current_version into strict resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'application_access_changed'
  ) as incremented;
  return query select p_organization_id, 6::bigint, resulting_version;
end
$function$;

revoke all on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid) is
  'Owner-only initializer for the current platform permission catalogue.';

alter function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  owner to vortex_owner;

grant execute on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  to postgres;

create or replace function vortex_access.organization_group_reduction_authority(
  p_organization_id uuid,
  p_group_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  affected_permissions jsonb;
begin
  -- The protected caller already holds the organization Access-version update
  -- lock used by every supported assignment, delegation and role writer. That
  -- makes this complete retained-fact read stable without another lock order.
  if exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    left join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
    where assignment.organization_id = p_organization_id
      and assignment.assignee_kind = 'group'
      and assignment.group_id = p_group_id
      and assignment.state = 'live'
      and (role_revision.lifecycle is null
        or role_revision.lifecycle not in ('unavailable', 'acceptance_required', 'retired'))
      and not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = role.organization_id
          and permission.role_id = role.role_id
          and permission.role_revision = role.live_revision
      )
  ) then
    raise exception using errcode = '40001',
      message = 'Organization Group retained authority is stale or unavailable';
  end if;

  if exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
    where assignment.organization_id = p_organization_id
      and assignment.assignee_kind = 'group'
      and assignment.group_id = p_group_id
      and assignment.state = 'live'
      and role_revision.lifecycle in ('unavailable', 'acceptance_required', 'retired')
      and not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = role.organization_id
          and permission.role_id = role.role_id
          and permission.role_revision = role.live_revision
      )
  ) then
    return pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  end if;

  if exists (
    select 1
    from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id = p_organization_id
      and delegation.holder_kind = 'group'
      and delegation.group_id = p_group_id
      and delegation.state = 'live'
      and delegation.scope_kind = 'organization_catalogue'
  ) then
    return pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', reference.application_root_id,
      'ownerKind', reference.owner_kind,
      'ownerId', reference.owner_id,
      'permissionId', reference.permission_id,
      'acceptedRegistrationRevision', reference.accepted_registration_revision
    )) order by reference.application_root_id nulls first,
      reference.owner_kind collate "C", reference.owner_id,
      reference.permission_id
  )
  into affected_permissions
  from (
    select permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      permission.accepted_registration_revision
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = role.organization_id
      and permission.role_id = role.role_id
      and permission.role_revision = role.live_revision
    where assignment.organization_id = p_organization_id
      and assignment.assignee_kind = 'group'
      and assignment.group_id = p_group_id
      and assignment.state = 'live'
    union
    select case when permission.value ? 'applicationRootId'
        then (permission.value ->> 'applicationRootId')::uuid else null end,
      permission.value ->> 'ownerKind',
      (permission.value ->> 'ownerId')::uuid,
      (permission.value ->> 'permissionId')::uuid,
      (permission.value ->> 'acceptedRegistrationRevision')::bigint
    from vortex_access.organization_delegation_authorities as delegation
    cross join lateral pg_catalog.jsonb_array_elements(
      delegation.bounded_permissions
    ) as permission(value)
    where delegation.organization_id = p_organization_id
      and delegation.holder_kind = 'group'
      and delegation.group_id = p_group_id
      and delegation.state = 'live'
      and delegation.scope_kind = 'bounded'
  ) as reference;

  if affected_permissions is null then
    return pg_catalog.jsonb_build_object('kind', 'none');
  end if;
  return pg_catalog.jsonb_build_object(
    'kind', 'bounded', 'permissions', affected_permissions
  );
end
$function$;

comment on function
  vortex_access.organization_group_reduction_authority(uuid, uuid) is
  'Private complete retained Group assignment/delegation scope derivation for protected reductions; a zero-permission unavailable, acceptance_required or retired role contributes organisation-catalogue authority.';

revoke execute on function
  vortex_access.organization_group_reduction_authority(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

alter function vortex_access.organization_group_reduction_authority(p_organization_id uuid, p_group_id uuid) owner to vortex_owner;

grant execute on function vortex_access.organization_group_reduction_authority(p_organization_id uuid, p_group_id uuid) to postgres;

create or replace function vortex_access.organization_has_permanent_steward(
  p_organization_id uuid,
  p_checked_at timestamptz
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  with stewardship_requirement as (
    select 1
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = p_organization_id
  ), current_platform_registration as (
    select registration.revision, registration.registration_owner_id
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'platform'
      and registration.state = 'active'
      and vortex_access.platform_permission_catalogue_revision_is_exact(
        p_organization_id, registration.revision
      )
  ), required_declaration as materialized (
    select declaration.permission_id
    from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration
  ), required_platform_permission as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id,
      registration.revision as registration_revision
    from current_platform_registration as registration
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = registration.registration_owner_id
      and entry.registration_revision = registration.revision
    join required_declaration as required
      on required.permission_id = entry.permission_id
    where entry.application_root_id is null
      and entry.owner_kind = 'platform'
  ), candidate_steward as (
    select account.organization_account_id
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as identity
      on identity.identity_id = account.identity_id
      and identity.state = 'active'
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = account.organization_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = account.organization_account_id
      and assignment.group_id is null
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and assignment.expires_at is null
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
      and revision.lifecycle = 'active'
      and revision.assignment_policy = 'standing'
    join vortex_access.organization_delegation_authorities as delegation
      on delegation.organization_id = account.organization_id
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = account.organization_account_id
      and delegation.group_id is null
      and delegation.scope_kind = 'organization_catalogue'
      and delegation.state = 'live'
      and delegation.starts_at <= p_checked_at
      and delegation.expires_at is null
    where account.organization_id = p_organization_id
      and account.state = 'active'
      and not exists (
        select 1
        from required_platform_permission as required
        where not exists (
          select 1
          from vortex_access.organization_role_permission_entries as permission
          join vortex_access.permission_continuities as continuity
            on continuity.organization_id = permission.organization_id
            and continuity.application_scope_id = coalesce(permission.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
            and continuity.owner_kind = permission.owner_kind
            and continuity.owner_id = permission.owner_id
            and continuity.permission_id = permission.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision = permission.continuity_revision
            and continuity.last_processed_registration_revision =
              required.registration_revision
          where permission.organization_id = role.organization_id
            and permission.role_id = role.role_id
            and permission.role_revision = role.live_revision
            and permission.application_root_id is not distinct from required.application_root_id
            and permission.owner_kind = required.owner_kind
            and permission.owner_id = required.owner_id
            and permission.permission_id = required.permission_id
        )
      )
  )
  select (select pg_catalog.count(*) from required_declaration) > 0
    and (
      select pg_catalog.count(*)
      from (
        select distinct declaration.permission_id
        from required_declaration as declaration
      ) as distinct_declaration
    ) = (select pg_catalog.count(*) from required_declaration)
    and (
      select pg_catalog.count(*)
      from (
        select distinct required.permission_id
        from required_platform_permission as required
      ) as matched_declaration
    ) = (select pg_catalog.count(*) from required_declaration)
    and (select pg_catalog.count(*) from required_platform_permission)
      = (select pg_catalog.count(*) from required_declaration)
    and exists (
      select 1
      from candidate_steward as steward
      cross join stewardship_requirement as requirement
    )
$function$;

revoke execute on function vortex_access.organization_has_permanent_steward(uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_access.organization_has_permanent_steward(uuid, timestamptz) is
  'Checks the direct permanent steward and original platform-permission invariant for an adopted organisation.';
alter function vortex_access.organization_has_permanent_steward(p_organization_id uuid, p_checked_at timestamp with time zone) owner to vortex_owner;

create or replace function vortex_access.platform_permission_catalogue_revision_is_exact(
  p_organization_id uuid,
  p_registration_revision bigint
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  with expected as materialized (
    select declaration.*
    from vortex_access.read_platform_permission_declaration_catalogue_internal(6)
      as declaration
  ),
  entries as materialized (
    select entry.*
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = vortex_access.platform_permission_owner_id()
      and entry.registration_revision = 6
  )
  select coalesce(
    p_organization_id is not null
    and p_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and p_registration_revision = 6
    and (select pg_catalog.count(*) from expected) = 23
    and (select pg_catalog.count(*) from entries) = 23
    and exists (
      select 1
      from vortex_access.permission_registrations as registration
      join vortex_access.permission_registration_revisions as history
        on history.organization_id = registration.organization_id
        and history.registration_kind = registration.registration_kind
        and history.registration_owner_id = registration.registration_owner_id
        and history.revision = registration.revision
      where registration.organization_id = p_organization_id
        and registration.registration_kind = 'platform'
        and registration.registration_owner_id = vortex_access.platform_permission_owner_id()
        and registration.state = 'active'
        and registration.revision = 6
        and registration.source_definition_key is null
        and registration.source_version = '1.4.0'
        and registration.source_revision is null
        and registration.validation_contract_version is null
        and registration.permission_catalogue_fingerprint =
          'sha256:60d2c42cab03723fda56198083a70e8703792587546379372334d99609b15538'
        and registration.changed_by is not null
        and registration.change_correlation_id is not null
        and history.operation = 'platform_initialize'
        and row(history.state, history.source_definition_key, history.source_version,
          history.source_revision, history.validation_contract_version,
          history.permission_catalogue_fingerprint,
          history.changed_at, history.changed_by, history.change_correlation_id)
          is not distinct from row(registration.state, registration.source_definition_key,
          registration.source_version, registration.source_revision,
          registration.validation_contract_version,
          registration.permission_catalogue_fingerprint,
          registration.changed_at, registration.changed_by, registration.change_correlation_id)
    )
    and not exists (
      select 1
      from vortex_access.permission_registration_revisions as history
      where history.organization_id = p_organization_id
        and history.registration_kind = 'platform'
        and history.registration_owner_id = vortex_access.platform_permission_owner_id()
        and history.revision <> 6
    )
    and not exists (
      select entry.application_root_id, entry.owner_kind, entry.owner_id,
        entry.permission_id, entry.permission_key, entry.label, entry.description,
        entry.record_type_id, entry.record_scope, entry.field_policy,
        entry.action_kind, entry.named_action, entry.administrative,
        entry.source_kind, entry.source_definition_key, entry.source_root_id,
        entry.source_version, entry.source_revision,
        entry.source_validation_contract_version, entry.source_catalogue_fingerprint
      from entries as entry
      except all
      select null::uuid, 'platform'::text,
        vortex_access.platform_permission_owner_id(),
        expected.permission_id, expected.permission_key, expected.label,
        expected.description, null::uuid, null::jsonb, null::jsonb,
        expected.action_kind, null::text, true, 'platform_catalogue'::text,
        null::text, null::uuid, expected.source_version, null::bigint,
        null::text, expected.catalogue_fingerprint
      from expected
    )
    and (select pg_catalog.count(*) from vortex_access.permission_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.registration_kind = 'platform'
        and continuity.registration_owner_id = vortex_access.platform_permission_owner_id()) = 23
    and not exists (
      select 1 from expected
      where not exists (
        select 1 from vortex_access.permission_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id is null
          and continuity.registration_kind = 'platform'
          and continuity.registration_owner_id = vortex_access.platform_permission_owner_id()
          and continuity.owner_kind = 'platform'
          and continuity.owner_id = continuity.registration_owner_id
          and continuity.permission_id = expected.permission_id
          and continuity.state = 'available'
          and continuity.continuity_revision > 0
          and continuity.last_processed_registration_revision = 6
      )
    ), false
  )
$function$;

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint) is
  'Owner-only assertion for the current platform catalogue registration, entries and continuities.';

alter function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  owner to vortex_owner;

grant execute on function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  to postgres;

CREATE OR REPLACE FUNCTION vortex_access.private_current_role_management_scope(p_organization_id uuid, p_role_id uuid, p_role_revision bigint) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  permissions jsonb;
begin
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', permission.application_root_id,
      'ownerKind', permission.owner_kind,
      'ownerId', permission.owner_id,
      'permissionId', permission.permission_id,
      'acceptedRegistrationRevision', permission.accepted_registration_revision
    )) order by permission.application_root_id nulls first,
      permission.owner_kind collate "C", permission.owner_id,
      permission.permission_id
  ), '[]'::jsonb)
  into permissions
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = p_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = p_role_revision;

  if pg_catalog.jsonb_array_length(permissions) = 0 then
    return pg_catalog.jsonb_build_object('kind', 'none');
  end if;
  return pg_catalog.jsonb_build_object(
    'kind', 'bounded', 'permissions', permissions
  );
end
$$;

alter function vortex_access.private_current_role_management_scope(p_organization_id uuid, p_role_id uuid, p_role_revision bigint) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.private_current_role_management_scope(p_organization_id uuid, p_role_id uuid, p_role_revision bigint) FROM PUBLIC;

grant execute on function vortex_access.private_current_role_management_scope(p_organization_id uuid, p_role_id uuid, p_role_revision bigint) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.private_management_scope_from_permission(p_permissions jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  projected jsonb;
begin
  if p_permissions is null
    or pg_catalog.jsonb_typeof(p_permissions) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Private management permission evidence is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_permissions) = 0 then
    return pg_catalog.jsonb_build_object('kind', 'none');
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as item(value)
    where (
      pg_catalog.jsonb_typeof(item.value) = 'object'
      and item.value ?& array[
        'ownerKind', 'ownerId', 'permissionId',
        'acceptedRegistrationRevision'
      ]
      and pg_catalog.jsonb_typeof(item.value -> 'ownerKind') = 'string'
      and item.value ->> 'ownerKind' in ('platform', 'application', 'module')
      and pg_catalog.jsonb_typeof(item.value -> 'ownerId') = 'string'
      and vortex_platform.is_non_nil_uuid(item.value ->> 'ownerId')
      and pg_catalog.jsonb_typeof(item.value -> 'permissionId') = 'string'
      and vortex_platform.is_non_nil_uuid(item.value ->> 'permissionId')
      and pg_catalog.jsonb_typeof(item.value -> 'acceptedRegistrationRevision') = 'number'
      and (item.value ->> 'acceptedRegistrationRevision')::numeric
        between 1 and 9007199254740991
      and (item.value ->> 'acceptedRegistrationRevision')::numeric =
        pg_catalog.trunc((item.value ->> 'acceptedRegistrationRevision')::numeric)
      and (
        (
          item.value ->> 'ownerKind' = 'platform'
          and not item.value ? 'applicationRootId'
        ) or (
          item.value ->> 'ownerKind' in ('application', 'module')
          and pg_catalog.jsonb_typeof(item.value -> 'applicationRootId') = 'string'
          and vortex_platform.is_non_nil_uuid(item.value ->> 'applicationRootId')
          and (
            item.value ->> 'ownerKind' <> 'application'
            or (item.value ->> 'ownerId')::uuid =
              (item.value ->> 'applicationRootId')::uuid
          )
        )
      )
    ) is not true
  ) then
    raise exception using errcode = '22023',
      message = 'Private management permission evidence is invalid';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'applicationRootId', parsed.application_root_id,
      'ownerKind', parsed.owner_kind,
      'ownerId', parsed.owner_id,
      'permissionId', parsed.permission_id,
      'acceptedRegistrationRevision', parsed.accepted_registration_revision
    )
  ) order by parsed.application_root_id nulls first,
    parsed.owner_kind collate "C", parsed.owner_id, parsed.permission_id)
  into projected
  from (
    select distinct
      case when item.value ->> 'ownerKind' = 'platform' then null::uuid
        else (item.value ->> 'applicationRootId')::uuid end as application_root_id,
      item.value ->> 'ownerKind' as owner_kind,
      (item.value ->> 'ownerId')::uuid as owner_id,
      (item.value ->> 'permissionId')::uuid as permission_id,
      (item.value ->> 'acceptedRegistrationRevision')::bigint as accepted_registration_revision
    from pg_catalog.jsonb_array_elements(p_permissions) as item(value)
  ) as parsed;

  return pg_catalog.jsonb_build_object(
    'kind', 'bounded', 'permissions', projected
  );
end
$$;

alter function vortex_access.private_management_scope_from_permission(p_permissions jsonb) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.private_management_scope_from_permission(p_permissions jsonb) FROM PUBLIC;

grant execute on function vortex_access.private_management_scope_from_permission(p_permissions jsonb) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.protect_permission_continuity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  meaning_changed boolean := false;
  must_advance boolean;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Permission continuity cannot be deleted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.application_root_id is distinct from old.application_root_id
    or new.owner_kind is distinct from old.owner_kind
    or new.owner_id is distinct from old.owner_id
    or new.permission_id is distinct from old.permission_id
    or new.registration_kind is distinct from old.registration_kind
    or new.registration_owner_id is distinct from old.registration_owner_id
    or old.last_processed_registration_revision = 9007199254740991
    or new.last_processed_registration_revision <= old.last_processed_registration_revision then
    raise exception using errcode = '23514', message = 'Permission continuity transition is invalid';
  end if;

  if old.state = 'available' and new.state = 'available' then
    select not vortex_access.permission_meaning_is_same_internal(previous, current_entry)
    into meaning_changed
    from vortex_access.permission_catalogue_entries as previous
    join vortex_access.permission_catalogue_entries as current_entry
      on current_entry.organization_id = previous.organization_id
      and current_entry.registration_kind = previous.registration_kind
      and current_entry.registration_owner_id = previous.registration_owner_id
      and current_entry.application_root_id is not distinct from previous.application_root_id
      and current_entry.owner_kind = previous.owner_kind
      and current_entry.owner_id = previous.owner_id
      and current_entry.permission_id = previous.permission_id
      and current_entry.registration_revision = new.last_processed_registration_revision
    where previous.organization_id = old.organization_id
      and previous.registration_kind = old.registration_kind
      and previous.registration_owner_id = old.registration_owner_id
      and previous.registration_revision = old.last_processed_registration_revision
      and previous.application_root_id is not distinct from old.application_root_id
      and previous.owner_kind = old.owner_kind and previous.owner_id = old.owner_id
      and previous.permission_id = old.permission_id;
    if not found then
      raise exception using errcode = '23514', message = 'Permission continuity meaning is unavailable';
    end if;
  end if;

  must_advance := old.state is distinct from new.state or meaning_changed;
  if (must_advance and (old.continuity_revision = 9007199254740991
      or new.continuity_revision <> old.continuity_revision + 1))
    or (not must_advance and new.continuity_revision <> old.continuity_revision) then
    raise exception using errcode = '23514', message = 'Permission continuity transition is invalid';
  end if;
  return new;
end;
$$;

alter function vortex_access.protect_permission_continuity() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.protect_permission_continuity() FROM PUBLIC;

grant execute on function vortex_access.protect_permission_continuity() to postgres;

create or replace function vortex_access.protect_platform_permission_declarations()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    if old.steward_minimum then
      raise exception using errcode = '23514',
        message = 'Guarded platform permission declarations cannot be deleted';
    end if;
    return old;
  end if;

  if row(new.permission_id, new.permission_key)
    is distinct from row(old.permission_id, old.permission_key) then
    raise exception using errcode = '23514',
      message = 'Platform permission declaration identity is immutable';
  end if;

  if new.first_revision is distinct from old.first_revision then
    raise exception using errcode = '23514',
      message = 'Platform permission declaration first revision is immutable';
  end if;

  if old.steward_minimum then
    if not new.steward_minimum then
      raise exception using errcode = '23514',
        message = 'Guarded platform permission minimum cannot be cleared';
    end if;
    if row(
      new.owner_kind,
      new.owner_id,
      new.action_kind,
      new.label,
      new.description,
      new.source_module_key,
      new.steward_minimum,
      new.first_revision
    ) is distinct from row(
      old.owner_kind,
      old.owner_id,
      old.action_kind,
      old.label,
      old.description,
      old.source_module_key,
      old.steward_minimum,
      old.first_revision
    ) then
      raise exception using errcode = '23514',
        message = 'Guarded platform permission declarations are immutable';
    end if;
  end if;

  return new;
end
$function$;
alter function vortex_access.protect_platform_permission_declarations() owner to vortex_owner;


revoke all on function
  vortex_access.protect_platform_permission_declarations()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.protect_platform_permission_declarations() is
  'Rejects removal or silent substitution of a guarded platform permission declaration.';

alter function vortex_access.protect_platform_permission_declarations()
  owner to vortex_owner;

create or replace function vortex_access.read_organization_role_change_for_administration(
  p_preparation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  context_organization_id uuid;
  operation_name text;
  accepted_truth text;
  requested jsonb;
  refs jsonb;
  permissions_value jsonb;
  has_administrative_permissions boolean;
  target_application_root_id uuid;
  target_source_role_id uuid;
  application_registration vortex_access.permission_registrations%rowtype;
  selected_continuity vortex_access.application_role_template_continuities%rowtype;
  live_permissions jsonb;
  template_source jsonb;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  role_configuration jsonb;
  target_role_id uuid;
  expected_role_revision bigint;
  target_lifecycle text := 'active';
  authority_broadened boolean := false;
  manifest_required boolean := false;
  affected_assignments jsonb;
begin
  -- New-role callers supply bounded configuration only. Existing-Application-revision callers
  -- supply only the selected role identity and expected revision; this function derives that
  -- role's configuration and application source from the verified organisation's stored rows.
  -- Neither path accepts a fingerprint or organisation from its caller.
  if p_preparation is null
    or pg_catalog.jsonb_typeof(p_preparation) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_preparation -> 'operation') is distinct from 'string'
    or p_preparation ->> 'operation' not in (
      'create_custom', 'accept_new_application_role', 'accept_application_role_revision'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
  end if;
  operation_name := p_preparation ->> 'operation';

  if operation_name = 'accept_application_role_revision' then
    if p_preparation - array[
      'operation', 'roleId', 'expectedRoleRevision', 'acceptBroadenedAuthority'
    ]::text[] <> '{}'::jsonb
      or not (p_preparation ?& array[
        'operation', 'roleId', 'expectedRoleRevision', 'acceptBroadenedAuthority'
      ])
      or pg_catalog.jsonb_typeof(p_preparation -> 'roleId') is distinct from 'string'
      or vortex_platform.is_non_nil_uuid(p_preparation ->> 'roleId') is not true
      or (p_preparation ->> 'roleId') <> (p_preparation ->> 'roleId')::uuid::text
      or pg_catalog.jsonb_typeof(p_preparation -> 'expectedRoleRevision')
        is distinct from 'number'
      or (p_preparation ->> 'expectedRoleRevision')::numeric not between
        1 and 9007199254740991
      or (p_preparation ->> 'expectedRoleRevision')::numeric <>
        pg_catalog.trunc((p_preparation ->> 'expectedRoleRevision')::numeric)
      or pg_catalog.jsonb_typeof(p_preparation -> 'acceptBroadenedAuthority')
        is distinct from 'string'
      or p_preparation ->> 'acceptBroadenedAuthority' not in ('accept', 'decline') then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
  elsif pg_catalog.jsonb_typeof(p_preparation -> 'roleKey') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'label') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'description') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'privilegeClassification') is distinct from 'string'
    or p_preparation ->> 'privilegeClassification' not in ('standard', 'privileged')
    or pg_catalog.jsonb_typeof(p_preparation -> 'acceptBroadenedAuthority') is distinct from 'string'
    or p_preparation ->> 'acceptBroadenedAuthority' not in ('accept', 'decline') then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
  end if;
  accepted_truth := p_preparation ->> 'acceptBroadenedAuthority';

  -- Explicit acceptance of broadened authority is a visible choice, never inferred from a
  -- submitted form. Declining is an ordinary unavailability, not an error.
  if accepted_truth is distinct from 'accept' then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  -- The verified request context and the caller's own current authority decide the organisation;
  -- the caller never names it. A custom role needs role management. Accepting an application's
  -- role template or role revision is part of installing or upgrading that application, so it
  -- needs the installation permission instead; the writer keeps the delegated-scope and recent
  -- sign-in checks for both.
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', case when operation_name = 'create_custom'
        then 'platform.organization.roles.manage'
        else 'platform.organization.applications.manage' end,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        case when operation_name = 'create_custom'
          then 'platform.organization.roles.manage'
          else 'platform.organization.applications.manage' end
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization role-change preparation is unavailable';
  end if;
  context_organization_id := decision.organization_id;

  if operation_name = 'accept_application_role_revision' then
    target_role_id := (p_preparation ->> 'roleId')::uuid;
    expected_role_revision :=
      (p_preparation ->> 'expectedRoleRevision')::numeric::bigint;
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = context_organization_id
      and stored.role_id = target_role_id;
    if not found
      or role_identity.role_kind <> 'application'
      or role_identity.application_root_id is null
      or role_identity.application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_identity.source_role_id is null
      or role_identity.source_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_identity.live_revision <> expected_role_revision then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    if role_identity.live_revision = 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = context_organization_id
      and revision.role_id = target_role_id
      and revision.revision = expected_role_revision;
    if not found
      or current_revision.lifecycle is null
      or current_revision.lifecycle not in ('active', 'acceptance_required') then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    target_application_root_id := role_identity.application_root_id;
    target_source_role_id := role_identity.source_role_id;
    role_configuration := pg_catalog.jsonb_build_object(
      'roleId', role_identity.role_id,
      'expectedRoleRevision', current_revision.revision,
      'key', current_revision.role_key,
      'label', current_revision.label,
      'description', current_revision.description,
      'privilegeClassification', current_revision.privilege_classification,
      'assignmentPolicy', case current_revision.assignment_policy
        when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
        else pg_catalog.jsonb_build_object(
          'kind', 'activation_required',
          'activationPolicy', pg_catalog.jsonb_build_object(
            'selection', 'existing',
            'reference', pg_catalog.jsonb_build_object(
              'activationPolicyId', current_revision.activation_policy_id,
              'revision', current_revision.activation_policy_revision
            )
          )
        )
      end,
      'sourceRoleId', role_identity.source_role_id
    );
  end if;

  if operation_name = 'create_custom' then
    requested := p_preparation -> 'permissions';
    if pg_catalog.jsonb_typeof(requested) is distinct from 'array'
      or pg_catalog.jsonb_array_length(requested) = 0 then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(requested) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not (item.value ?& array['ownerKind', 'ownerId', 'permissionId'])
        or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
        or item.value ->> 'ownerKind' not in ('platform', 'application', 'module')
        or pg_catalog.jsonb_typeof(item.value -> 'ownerId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(item.value ->> 'ownerId') is not true
        or pg_catalog.jsonb_typeof(item.value -> 'permissionId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(item.value ->> 'permissionId') is not true
        or ((item.value ->> 'ownerKind' = 'platform') = (item.value ? 'applicationRootId'))
        or (
          item.value ->> 'ownerKind' <> 'platform'
          and (
            pg_catalog.jsonb_typeof(item.value -> 'applicationRootId') is distinct from 'string'
            or vortex_platform.is_non_nil_uuid(item.value ->> 'applicationRootId') is not true
            or (item.value ->> 'ownerKind' = 'application'
              and (item.value ->> 'ownerId')::uuid
                <> (item.value ->> 'applicationRootId')::uuid)
          )
        )
    ) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    select pg_catalog.jsonb_agg(distinct pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'applicationRootId', case when item.value ->> 'ownerKind' = 'platform'
          then null else (item.value ->> 'applicationRootId')::uuid end,
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', (item.value ->> 'ownerId')::uuid,
        'permissionId', (item.value ->> 'permissionId')::uuid
      )
    ))
    into refs
    from pg_catalog.jsonb_array_elements(requested) as item(value);
    if refs is null
      or pg_catalog.jsonb_array_length(refs) <> pg_catalog.jsonb_array_length(requested) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
  else
    if operation_name <> 'accept_application_role_revision' then
      if pg_catalog.jsonb_typeof(p_preparation -> 'applicationRootId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(p_preparation ->> 'applicationRootId') is not true
        or pg_catalog.jsonb_typeof(p_preparation -> 'sourceRoleId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(p_preparation ->> 'sourceRoleId') is not true then
        raise exception using errcode = '22023',
          message = 'Organization role-change preparation input is invalid';
      end if;
      target_application_root_id := (p_preparation ->> 'applicationRootId')::uuid;
      target_source_role_id := (p_preparation ->> 'sourceRoleId')::uuid;
    end if;

    select registration.* into application_registration
    from vortex_access.permission_registrations as registration
    where registration.organization_id = context_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.state = 'active';
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select continuity.* into selected_continuity
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = context_organization_id
      and continuity.application_root_id = target_application_root_id
      and continuity.source_role_id = target_source_role_id
      and continuity.state = 'available'
      and continuity.last_processed_registration_revision = application_registration.revision;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    -- The writer reads the same projection, so the evidence names the registration revision and
    -- its catalogue fingerprint instead of carrying the registered entries.
    live_permissions := vortex_access.application_role_template_live_permissions_internal(
      context_organization_id, target_application_root_id, application_registration.revision,
      target_source_role_id
    );
    if live_permissions is null then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    template_source := pg_catalog.jsonb_build_object(
      'applicationRootId', target_application_root_id,
      'registrationRevision', application_registration.revision,
      'releaseRevision', application_registration.source_revision,
      'catalogueFingerprint', application_registration.permission_catalogue_fingerprint
    );

    select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', item.value -> 'applicationRootId',
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', item.value ->> 'ownerId',
        'permissionId', item.value ->> 'permissionId'
      )))
    into refs
    from pg_catalog.jsonb_array_elements(live_permissions) as item(value);
  end if;

  -- Every requested identity must still resolve to exactly one current, available accepted
  -- permission. The returned scope is exactly the references the role entry names, never wider.
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'kind', 'exact',
      'applicationRootId', continuity.application_root_id,
      'ownerKind', continuity.owner_kind,
      'ownerId', continuity.owner_id,
      'permissionId', continuity.permission_id,
      'acceptedRegistrationRevision', registration.revision,
      'catalogueFingerprint', registration.permission_catalogue_fingerprint,
      'continuityRevision', continuity.continuity_revision
    )) order by continuity.application_root_id nulls last,
      continuity.owner_kind collate "C", continuity.owner_id, continuity.permission_id),
    pg_catalog.bool_or(catalogue.administrative)
  into permissions_value, has_administrative_permissions
  from pg_catalog.jsonb_array_elements(refs) as requested_permission(value)
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = context_organization_id
    and continuity.state = 'available'
    and continuity.application_scope_id = coalesce(case when requested_permission.value ? 'applicationRootId'
        then (requested_permission.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (requested_permission.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
    and continuity.owner_kind = requested_permission.value ->> 'ownerKind'
    and continuity.owner_id = (requested_permission.value ->> 'ownerId')::uuid
    and continuity.permission_id = (requested_permission.value ->> 'permissionId')::uuid
  join vortex_access.permission_registrations as registration
    on registration.organization_id = continuity.organization_id
    and registration.registration_kind = continuity.registration_kind
    and registration.registration_owner_id = continuity.registration_owner_id
    and registration.state = 'active'
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = continuity.organization_id
    and catalogue.registration_kind = continuity.registration_kind
    and catalogue.registration_owner_id = continuity.registration_owner_id
    and catalogue.registration_revision = registration.revision
    and catalogue.owner_kind = continuity.owner_kind
    and catalogue.owner_id = continuity.owner_id
    and catalogue.permission_id = continuity.permission_id
    and catalogue.application_root_id is not distinct from continuity.application_root_id;
  if permissions_value is null
    or pg_catalog.jsonb_array_length(permissions_value)
      <> pg_catalog.jsonb_array_length(refs) then
    raise exception using errcode = '40001',
      message = 'Organization role permission evidence is stale or unavailable';
  end if;

  -- Reject the submitted classification before sealing evidence for a write whose deferred
  -- revision constraint would reject the same administrative permissions at commit.
  if operation_name <> 'accept_application_role_revision'
    and p_preparation ->> 'privilegeClassification' = 'standard'
    and has_administrative_permissions then
    return pg_catalog.jsonb_build_object(
      'outcome', 'invalid_privilege_classification',
      'organizationId', context_organization_id
    );
  end if;

  if operation_name = 'accept_application_role_revision' then
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as proposed(value)
      where not exists (
        select 1
        from vortex_access.organization_role_permission_entries as existing
        where existing.organization_id = context_organization_id
          and existing.role_id = target_role_id
          and existing.role_revision = current_revision.revision
          and existing.application_root_id is not distinct from
            case when proposed.value ? 'applicationRootId'
              then (proposed.value ->> 'applicationRootId')::uuid else null end
          and existing.owner_kind = proposed.value ->> 'ownerKind'
          and existing.owner_id = (proposed.value ->> 'ownerId')::uuid
          and existing.permission_id = (proposed.value ->> 'permissionId')::uuid
          and existing.continuity_revision =
            (proposed.value ->> 'continuityRevision')::numeric::bigint
      )
    ) into authority_broadened;

    -- The candidate preserves the current assignment policy and either moves from
    -- acceptance_required to active or keeps an active revision active. This is the writer's
    -- manifest predicate, so the only additional true term for this operation is a broadened
    -- permission projection.
    manifest_required :=
      current_revision.assignment_policy is distinct from
        (role_configuration #>> '{assignmentPolicy,kind}')
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      )
      or authority_broadened;

    if manifest_required then
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'roleAssignmentId', assignment.role_assignment_id,
            'expectedRevision', assignment.revision,
            'assignee', case
              when assignment.assignee_kind = 'organization_account' then
                pg_catalog.jsonb_build_object(
                  'kind', 'organization_account',
                  'organizationAccountId', assignment.organization_account_id
                )
              else pg_catalog.jsonb_build_object(
                'kind', 'group',
                'groupId', assignment.group_id
              )
            end
          ) order by assignment.role_assignment_id
        ),
        '[]'::jsonb
      ) into affected_assignments
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = context_organization_id
        and assignment.role_id = target_role_id
        and assignment.state = 'live';
    end if;

    return pg_catalog.jsonb_build_object(
      'outcome', 'available',
      'organizationId', context_organization_id,
      'roleConfiguration', role_configuration,
      'permissions', permissions_value,
      'templateContinuityRevision', selected_continuity.continuity_revision,
      'templateSource', template_source,
      'manifestRequired', manifest_required,
      'affectedAssignments', affected_assignments
    );
  end if;

  if operation_name = 'create_custom' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'available',
      'organizationId', context_organization_id,
      'permissions', permissions_value,
      'templateContinuityRevision', null,
      'templateSource', null
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'available',
    'organizationId', context_organization_id,
    'permissions', permissions_value,
    'templateContinuityRevision', selected_continuity.continuity_revision,
    'templateSource', template_source
  );
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
end
$function$;

revoke execute on function vortex_access.read_organization_role_change_for_administration(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_organization_role_change_for_administration(jsonb)
to vortex_request;

comment on function vortex_access.read_organization_role_change_for_administration(jsonb) is
  'Server-side preparation read: given bounded role configuration or an existing Application role identity and expected revision, it returns complete, fingerprinted permission and template evidence for the verified caller organisation only, deriving stored role configuration, actor and organisation from protected context and including an exact live-assignment snapshot only when the writer requires it.';

alter function vortex_access.read_organization_role_change_for_administration(p_preparation jsonb) owner to vortex_owner;

grant execute on function vortex_access.read_organization_role_change_for_administration(p_preparation jsonb) to postgres;

create or replace function vortex_access.retire_organization_role_for_administration(
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_prepared_role_change jsonb,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  role_summary jsonb,
  access_version bigint, refusal_reason text
)
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
  role_fact vortex_access.organization_roles%rowtype;
  revision_fact vortex_access.organization_role_revisions%rowtype;
  expected_candidate jsonb;
  affected_permissions jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  activity_result text;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_role_revision is null
    or p_expected_role_revision not between 1 and 9007199254740991
    or p_prepared_role_change is null
    or pg_catalog.jsonb_typeof(p_prepared_role_change) is distinct from 'object'
    or p_prepared_role_change - array['contractVersion', 'candidate']::text[] <> '{}'::jsonb
    or not (p_prepared_role_change ?& array['contractVersion', 'candidate'])
    or p_prepared_role_change ->> 'contractVersion' is distinct from '1.0.0'
    or pg_catalog.jsonb_typeof(p_prepared_role_change -> 'candidate')
      is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role retirement input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

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
      message = 'Organization role retirement is unavailable';
  end if;

  select role.* into role_fact
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = p_role_id
  for update;
  if not found or role_fact.live_revision <> p_expected_role_revision then
    raise exception using errcode = '40001',
      message = 'Organization role retirement is stale or unavailable';
  end if;
  select revision.* into strict revision_fact
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = p_role_id
    and revision.revision = role_fact.live_revision;
  if revision_fact.lifecycle = 'retired' then
    raise exception using errcode = '40001',
      message = 'Organization role retirement is stale or unavailable';
  end if;

  expected_candidate := pg_catalog.jsonb_build_object(
    'operation', 'retire_role',
    'organizationId', context_organization_id,
    'roleId', p_role_id,
    'expectedRoleRevision', p_expected_role_revision
  );
  if p_prepared_role_change -> 'candidate' is distinct from expected_candidate then
    raise exception using errcode = '40001',
      message = 'Prepared organization role retirement is stale or unavailable';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', permission.application_root_id,
      'ownerKind', permission.owner_kind,
      'ownerId', permission.owner_id,
      'permissionId', permission.permission_id,
      'acceptedRegistrationRevision', permission.accepted_registration_revision
    )) order by permission.application_root_id nulls first,
      permission.owner_kind collate "C", permission.owner_id,
      permission.permission_id
  ) into affected_permissions
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = context_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = role_fact.live_revision;

  if affected_permissions is null
    and revision_fact.lifecycle not in ('unavailable', 'acceptance_required')
    and exists (
      select 1
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = context_organization_id
        and assignment.role_id = p_role_id
        and assignment.state = 'live'
  ) then
    raise exception using errcode = '40001',
      message = 'Organization role retained authority is stale or unavailable';
  end if;

  authority_requirement := case
    when affected_permissions is not null
      then pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object(
          'kind', 'bounded', 'permissions', affected_permissions
        ),
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    when revision_fact.lifecycle in ('unavailable', 'acceptance_required')
      and exists (
        select 1
        from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = context_organization_id
          and assignment.role_id = p_role_id
          and assignment.state = 'live'
      )
      then pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object(
          'kind', 'organization_catalogue'
        ),
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    else pg_catalog.jsonb_build_object('kind', 'permission')
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.retire',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.roles.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.roles.retire'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'retire_role',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role retirement refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.roles.retire'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role retirement is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_role_change(
    p_prepared_role_change, context_account_id, context_correlation_id
  ) as result;
  changed_summary := vortex_access.project_organization_role_change_summary(
    context_organization_id, p_role_id
  );
  if changed_summary is null then
    raise exception using errcode = '40001',
      message = 'Changed organization role projection is unavailable';
  end if;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.role ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, 'retire_role',
    array[p_role_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role retirement Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version, null::text;
end
$function$;

revoke execute on function vortex_access.retire_organization_role_for_administration(uuid, bigint, jsonb, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.retire_organization_role_for_administration(uuid, bigint, jsonb, uuid)
to vortex_request;

comment on function vortex_access.retire_organization_role_for_administration(uuid, bigint, jsonb, uuid) is
  'Standalone request entry: performs retire_role after fixed protected checks; a zero-entry unavailable or acceptance_required role with live assignments uses catalogue delegation, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.retire_organization_role_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_prepared_role_change jsonb, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.retire_organization_role_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_prepared_role_change jsonb, p_activity_id uuid) to postgres;

create or replace function vortex_access.revise_organization_role_metadata_for_administration(
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_label text,
  p_description text,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  role_summary jsonb,
  access_version bigint, refusal_reason text
)
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
  role_fact vortex_access.organization_roles%rowtype;
  revision_fact vortex_access.organization_role_revisions%rowtype;
  affected_permissions jsonb;
  authority_requirement jsonb;
  decision record;
  changed_summary jsonb;
  operation_at timestamptz;
  activity_result text;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_role_revision is null
    or p_expected_role_revision not between 1 and 9007199254740991
    or p_label is null or p_label <> pg_catalog.btrim(p_label)
    or pg_catalog.char_length(p_label) not between 1 and 60
    or p_description is null or p_description <> pg_catalog.btrim(p_description)
    or pg_catalog.char_length(p_description) not between 1 and 1000
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role metadata revision input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization role metadata revision is unavailable';
  end if;

  select role.* into role_fact
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = p_role_id
  for update;
  if not found or role_fact.live_revision <> p_expected_role_revision then
    raise exception using errcode = '40001',
      message = 'Organization role metadata revision is stale or unavailable';
  end if;
  select revision.* into strict revision_fact
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = p_role_id
    and revision.revision = role_fact.live_revision;
  if revision_fact.lifecycle = 'retired' then
    raise exception using errcode = '40001',
      message = 'Organization role metadata revision is stale or unavailable';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', permission.application_root_id,
      'ownerKind', permission.owner_kind,
      'ownerId', permission.owner_id,
      'permissionId', permission.permission_id,
      'acceptedRegistrationRevision', permission.accepted_registration_revision
    )) order by permission.application_root_id nulls first,
      permission.owner_kind collate "C", permission.owner_id,
      permission.permission_id
  ) into affected_permissions
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = context_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = role_fact.live_revision;

  if affected_permissions is null and exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = context_organization_id
      and assignment.role_id = p_role_id
      and assignment.state = 'live'
  ) then
    raise exception using errcode = '40001',
      message = 'Organization role retained authority is stale or unavailable';
  end if;

  authority_requirement := case when affected_permissions is null
    then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', pg_catalog.jsonb_build_object(
        'kind', 'bounded', 'permissions', affected_permissions
      ),
      'after', pg_catalog.jsonb_build_object(
        'kind', 'bounded', 'permissions', affected_permissions
      )
    )
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.revise_metadata',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.roles.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.roles.revise_metadata'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revise_role_metadata',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role metadata revision refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.roles.revise_metadata'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role metadata revision is unavailable';
  end if;

  if role_fact.live_revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization role revision is exhausted';
  end if;
  if revision_fact.label is not distinct from p_label
    and revision_fact.description is not distinct from p_description then
    raise exception using errcode = '40001',
      message = 'Organization role label and description are unchanged';
  end if;

  -- A label or description edit changes no permission, assignment policy,
  -- lifecycle or source fact, so it appends one revision that carries every
  -- other fact forward and leaves the Access version untouched.
  operation_at := greatest(
    revision_fact.changed_at, pg_catalog.clock_timestamp()
  );
  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision
  )
  select permission.organization_id, permission.role_id,
    role_fact.live_revision + 1, permission.entry_ordinal, permission.role_kind,
    permission.role_application_root_id, permission.application_root_id,
    permission.owner_kind, permission.owner_id, permission.permission_id,
    permission.registration_kind, permission.registration_owner_id,
    permission.accepted_registration_revision, permission.catalogue_fingerprint,
    permission.continuity_revision
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = context_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = role_fact.live_revision
  order by permission.entry_ordinal;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, accepted_registration_revision,
    template_continuity_revision,
    changed_by, changed_at, change_correlation_id
  ) values (
    context_organization_id, p_role_id, role_fact.live_revision + 1,
    revision_fact.role_kind, revision_fact.application_root_id,
    revision_fact.lifecycle, revision_fact.privilege_classification,
    revision_fact.assignment_policy, revision_fact.policy_continuity_revision,
    revision_fact.authority_continuity_revision,
    revision_fact.activation_policy_id, revision_fact.activation_policy_revision,
    revision_fact.role_key,
    p_label, p_description, revision_fact.source_definition_key,
    revision_fact.source_release_revision, revision_fact.source_release_version,
    revision_fact.source_validation_contract_version,
    revision_fact.accepted_registration_revision,
    revision_fact.template_continuity_revision,
    context_account_id, operation_at, context_correlation_id
  );

  update vortex_access.organization_roles as stored
  set live_revision = role_fact.live_revision + 1
  where stored.organization_id = context_organization_id
    and stored.role_id = p_role_id
    and stored.live_revision = p_expected_role_revision;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization role revision changed concurrently';
  end if;

  changed_summary := vortex_access.project_organization_role_change_summary(
    context_organization_id, p_role_id
  );
  if changed_summary is null then
    raise exception using errcode = '40001',
      message = 'Changed organization role projection is unavailable';
  end if;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    operation_at,
    'organization_account', context_account_id, 'revise_role_metadata',
    array[p_role_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role metadata Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    context_access_version, null::text;
end
$function$;

revoke execute on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid)
to vortex_request;

comment on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid) is
  'Standalone request entry: performs a display-only role label and description revision after fixed protected checks without advancing the Access version, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.revise_organization_role_metadata_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_label text, p_description text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revise_organization_role_metadata_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_label text, p_description text, p_activity_id uuid) to postgres;

create or replace function vortex_access.revoke_organization_delegation_authority_for_administration(
  p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_activity_id uuid
)
returns table (outcome text, organization_id uuid, delegation_summary jsonb, access_version bigint, refusal_reason text)
language plpgsql volatile security definer set search_path = '' as $function$
declare
  context_value jsonb; context_organization_id uuid; context_account_id uuid;
  context_access_version bigint; context_correlation_id uuid; locked_access_version bigint;
  delegation_fact vortex_access.organization_delegation_authorities%rowtype;
  authority_before jsonb; decision record; changed record; summary jsonb; activity_result text;
begin
  if p_delegation_authority_id is null or p_delegation_authority_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_delegation_revision is null or p_expected_delegation_revision not between 1 and 9007199254740991
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Delegation revocation input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  select version.current_version into locked_access_version from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id and organization.state = 'active'
    and tenant.state = 'active' for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501', message = 'Delegation revocation is unavailable'; end if;
  select delegation.* into delegation_fact from vortex_access.organization_delegation_authorities as delegation
  where delegation.organization_id = context_organization_id
    and delegation.delegation_authority_id = p_delegation_authority_id for update;
  if not found or delegation_fact.revision <> p_expected_delegation_revision or delegation_fact.state <> 'live' then
    raise exception using errcode = '40001', message = 'Delegation revocation is stale or unavailable'; end if;
  if delegation_fact.scope_kind = 'organization_catalogue' then
    authority_before := pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  else
    select pg_catalog.jsonb_build_object('kind', 'bounded', 'permissions',
      pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'applicationRootId', permission.value -> 'applicationRootId',
          'ownerKind', permission.value -> 'ownerKind',
          'ownerId', permission.value -> 'ownerId',
          'permissionId', permission.value -> 'permissionId',
          'acceptedRegistrationRevision', permission.value -> 'acceptedRegistrationRevision'))))
    into authority_before
    from pg_catalog.jsonb_array_elements(delegation_fact.bounded_permissions)
      as permission(value);
  end if;
  select evaluated.* into strict decision from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object('operationKey', 'platform.organization.delegations.revoke',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object('kind', 'delegated_management',
        'before', authority_before, 'after', pg_catalog.jsonb_build_object('kind', 'none')))) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.delegations.revoke'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revoke_delegation',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Delegation revocation refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.revoke'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Delegation revocation is unavailable';
  end if;
  select result.* into strict changed from vortex_access.coordinate_organization_delegation_authority_change(
    'revoke_delegation', context_organization_id, p_delegation_authority_id,
    p_expected_delegation_revision, null, null, null, null, null, null, null,
    context_account_id, context_correlation_id) as result;
  summary := vortex_access.project_organization_delegation_summary(context_organization_id, p_delegation_authority_id);
  if summary is null then raise exception using errcode = '40001', message = 'Changed delegation projection is unavailable'; end if;
  activity_result := vortex_record.append_organization_activity_entry(context_organization_id,
    p_activity_id, (changed.delegation ->> 'changedAt')::timestamptz, 'organization_account', context_account_id,
    'revoke_delegation', array[p_delegation_authority_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed');
  if activity_result is distinct from 'inserted' then raise exception using errcode = '40001', message = 'Delegation Activity is stale'; end if;
  return query select 'completed'::text, context_organization_id, summary, changed.access_version, null::text;
end $function$;

revoke execute on function vortex_access.revoke_organization_delegation_authority_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.revoke_organization_delegation_authority_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.revoke_organization_delegation_authority_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs revoke_delegation after fixed protected checks, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.revoke_organization_delegation_authority_for_administration(p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revoke_organization_delegation_authority_for_administration(p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_activity_id uuid) to postgres;

create or replace function vortex_access.revoke_organization_role_assignment_for_administration(
  p_role_assignment_id uuid,
  p_expected_assignment_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  assignment_summary jsonb,
  access_version bigint, refusal_reason text
)
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
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  current_role_revision bigint;
  current_role_lifecycle text;
  affected_permissions jsonb;
  affected_authority jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  activity_result text;
begin
  if p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_assignment_revision is null
    or p_expected_assignment_revision not between 1 and 9007199254740991
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment revocation input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

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
      message = 'Organization role-assignment revocation is unavailable';
  end if;

  select assignment.* into assignment_fact
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = context_organization_id
    and assignment.role_assignment_id = p_role_assignment_id
  for update;
  if not found
    or assignment_fact.revision <> p_expected_assignment_revision
    or assignment_fact.state <> 'live' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment revocation is stale or unavailable';
  end if;

  select role.live_revision, revision.lifecycle
    into strict current_role_revision, current_role_lifecycle
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  where role.organization_id = context_organization_id
    and role.role_id = assignment_fact.role_id;

  select pg_catalog.jsonb_agg(reference.permission order by
      reference.application_root_id nulls first, reference.owner_kind,
      reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind,
        'ownerId', permission.owner_id,
        'permissionId', permission.permission_id,
        'acceptedRegistrationRevision', permission.accepted_registration_revision
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = assignment_fact.role_id
      and permission.role_revision = current_role_revision
  ) as reference;
  if affected_permissions is not null then
    affected_authority := pg_catalog.jsonb_build_object(
      'kind', 'bounded', 'permissions', affected_permissions
    );
  elsif current_role_lifecycle in ('unavailable', 'acceptance_required', 'retired') then
    affected_authority := pg_catalog.jsonb_build_object(
      'kind', 'organization_catalogue'
    );
  else
    raise exception using errcode = '40001',
      message = 'Organization role-assignment authority is stale or unavailable';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.revoke',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', affected_authority,
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.role_assignments.revoke'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revoke_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment revocation refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.role_assignments.revoke'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment revocation is unavailable';
  end if;

  select assignment_change.* into strict changed
  from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', context_organization_id, p_role_assignment_id,
    p_expected_assignment_revision, null, null, null, null, null, null,
    null, null, context_account_id, context_correlation_id
  ) as assignment_change;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'roleAssignmentId', assignment.role_assignment_id,
    'role', pg_catalog.jsonb_build_object(
      'roleId', role.role_id, 'key', revision.role_key,
      'label', revision.label, 'lifecycle', revision.lifecycle
    ),
    'assignee', case assignment.assignee_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', assignment.organization_account_id,
        'displayName', account.display_name
      ) else pg_catalog.jsonb_build_object(
        'kind', 'group', 'groupId', assignment.group_id,
        'key', organization_group.group_key, 'label', organization_group.label,
        'state', organization_group.state
      ) end,
    'assignmentKind', assignment.assignment_kind,
    'revision', assignment.revision, 'startsAt', assignment.starts_at,
    'expiresAt', assignment.expires_at, 'state', assignment.state,
    'temporalState', 'revoked'
  )) into strict changed_summary
  from vortex_access.organization_role_assignments as assignment
  join vortex_access.organization_roles as role
    on role.organization_id = assignment.organization_id
    and role.role_id = assignment.role_id
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id and revision.revision = role.live_revision
  left join vortex_identity.organization_accounts as account
    on assignment.assignee_kind = 'organization_account'
    and account.organization_id = assignment.organization_id
    and account.organization_account_id = assignment.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on assignment.assignee_kind = 'group'
    and organization_group.organization_id = assignment.organization_id
    and organization_group.group_id = assignment.group_id
  where assignment.organization_id = context_organization_id
    and assignment.role_assignment_id = p_role_assignment_id;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'revoke_role_assignment',
    array[p_role_assignment_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment revocation Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version, null::text;
end
$function$;

revoke execute on function vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs revoke_role_assignment after fixed protected checks; a current zero-entry unavailable, acceptance_required or retired role uses catalogue delegation, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.revoke_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revoke_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_activity_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.validate_organization_delegation_bounded_permissions(p_organization_id uuid, p_permissions jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
declare
  canonical_permissions jsonb;
begin
  if p_permissions is null
    or pg_catalog.jsonb_typeof(p_permissions) <> 'array'
    or pg_catalog.jsonb_array_length(p_permissions) = 0 then
    raise exception using errcode = '23514',
      message = 'Bounded delegation permissions must be a nonempty array';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    where pg_catalog.jsonb_typeof(candidate.value) <> 'object'
  ) then
    raise exception using errcode = '23514',
      message = 'Every bounded delegation permission must be an object';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    where (
      (
        candidate.value ->> 'ownerKind' = 'platform'
        and candidate.value ?& array[
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'kind', 'ownerId',
          'ownerKind', 'permissionId'
        ]
        and candidate.value - array[
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'kind', 'ownerId',
          'ownerKind', 'permissionId'
        ] = '{}'::jsonb
      ) or (
        candidate.value ->> 'ownerKind' in ('application', 'module')
        and candidate.value ?& array[
          'acceptedRegistrationRevision', 'applicationRootId',
          'catalogueFingerprint', 'continuityRevision', 'kind',
          'ownerId', 'ownerKind', 'permissionId'
        ]
        and candidate.value - array[
          'acceptedRegistrationRevision', 'applicationRootId',
          'catalogueFingerprint', 'continuityRevision', 'kind',
          'ownerId', 'ownerKind', 'permissionId'
        ] = '{}'::jsonb
      )
    ) is not true
  ) then
    raise exception using errcode = '23514',
      message = 'A bounded delegation permission has missing or unknown keys';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    where (
      pg_catalog.jsonb_typeof(candidate.value -> 'kind') = 'string'
      and candidate.value ->> 'kind' = 'exact'
      and pg_catalog.jsonb_typeof(candidate.value -> 'ownerKind') = 'string'
      and candidate.value ->> 'ownerKind' in ('platform', 'application', 'module')
      and case
        when pg_catalog.jsonb_typeof(candidate.value -> 'ownerId') = 'string'
          and candidate.value ->> 'ownerId' ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then pg_catalog.lower(candidate.value ->> 'ownerId') <>
            '00000000-0000-0000-0000-000000000000'
        else false
      end
      and case
        when pg_catalog.jsonb_typeof(candidate.value -> 'permissionId') =
          'string'
          and candidate.value ->> 'permissionId' ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then pg_catalog.lower(candidate.value ->> 'permissionId') <>
            '00000000-0000-0000-0000-000000000000'
        else false
      end
      and case
        when pg_catalog.jsonb_typeof(
          candidate.value -> 'acceptedRegistrationRevision'
        ) = 'number' then
          (candidate.value ->> 'acceptedRegistrationRevision')::numeric
            between 1 and 9007199254740991
          and (candidate.value ->> 'acceptedRegistrationRevision')::numeric =
            pg_catalog.trunc(
              (candidate.value ->> 'acceptedRegistrationRevision')::numeric
            )
        else false
      end
      and case
        when pg_catalog.jsonb_typeof(candidate.value -> 'continuityRevision') =
          'number' then
          (candidate.value ->> 'continuityRevision')::numeric
            between 1 and 9007199254740991
          and (candidate.value ->> 'continuityRevision')::numeric =
            pg_catalog.trunc(
              (candidate.value ->> 'continuityRevision')::numeric
            )
        else false
      end
      and pg_catalog.jsonb_typeof(candidate.value -> 'catalogueFingerprint') =
        'string'
      and candidate.value ->> 'catalogueFingerprint' ~
        '^sha256:[a-f0-9]{64}$'
      and (
        (
          candidate.value ->> 'ownerKind' = 'platform'
          and not candidate.value ? 'applicationRootId'
        ) or (
          candidate.value ->> 'ownerKind' in ('application', 'module')
          and case
            when pg_catalog.jsonb_typeof(
              candidate.value -> 'applicationRootId'
            ) = 'string'
              and candidate.value ->> 'applicationRootId' ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then pg_catalog.lower(candidate.value ->> 'applicationRootId') <>
                '00000000-0000-0000-0000-000000000000'
            else false
          end
          and (
            candidate.value ->> 'ownerKind' <> 'application'
            or pg_catalog.lower(candidate.value ->> 'ownerId') =
              pg_catalog.lower(candidate.value ->> 'applicationRootId')
          )
        )
      )
    ) is not true
  ) then
    raise exception using errcode = '23514',
      message = 'A bounded delegation permission has invalid values';
  end if;

  if exists (
    with parsed as (
      select
        case
          when candidate.value ->> 'ownerKind' = 'platform' then null::uuid
          else (candidate.value ->> 'applicationRootId')::uuid
        end as application_root_id,
        candidate.value ->> 'ownerKind' as owner_kind,
        (candidate.value ->> 'ownerId')::uuid as owner_id,
        (candidate.value ->> 'permissionId')::uuid as permission_id
      from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    )
    select 1
    from parsed
    group by application_root_id, owner_kind, owner_id, permission_id
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '23514',
      message = 'A bounded delegation permission identity may appear only once';
  end if;

  with parsed as (
    select candidate.value,
      case
        when candidate.value ->> 'ownerKind' = 'platform' then null::uuid
        else (candidate.value ->> 'applicationRootId')::uuid
      end as application_root_id,
      candidate.value ->> 'ownerKind' as owner_kind,
      (candidate.value ->> 'ownerId')::uuid as owner_id,
      (candidate.value ->> 'permissionId')::uuid as permission_id
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
  )
  select pg_catalog.jsonb_agg(
    parsed.value order by parsed.application_root_id asc nulls last,
      parsed.owner_kind collate "C", parsed.owner_id, parsed.permission_id
  )
  into canonical_permissions
  from parsed;

  if canonical_permissions is distinct from p_permissions then
    raise exception using errcode = '23514',
      message = 'Bounded delegation permissions must use canonical order';
  end if;

  if exists (
    with parsed as (
      select
        case
          when candidate.value ->> 'ownerKind' = 'platform' then null::uuid
          else (candidate.value ->> 'applicationRootId')::uuid
        end as application_root_id,
        candidate.value ->> 'ownerKind' as owner_kind,
        (candidate.value ->> 'ownerId')::uuid as owner_id,
        (candidate.value ->> 'permissionId')::uuid as permission_id,
        (candidate.value ->> 'acceptedRegistrationRevision')::numeric::bigint as
          accepted_registration_revision,
        candidate.value ->> 'catalogueFingerprint' as catalogue_fingerprint,
        (candidate.value ->> 'continuityRevision')::numeric::bigint as
          continuity_revision
      from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    )
    select 1
    from parsed
    where not exists (
      select 1
      from vortex_access.permission_catalogue_entries as entry
      join vortex_access.permission_registration_revisions as registration
        on registration.organization_id = entry.organization_id
        and registration.registration_kind = entry.registration_kind
        and registration.registration_owner_id = entry.registration_owner_id
        and registration.revision = entry.registration_revision
        and registration.state = 'active'
        and registration.permission_catalogue_fingerprint =
          parsed.catalogue_fingerprint
      join vortex_access.permission_registrations as current_registration
        on current_registration.organization_id = entry.organization_id
        and current_registration.registration_kind = entry.registration_kind
        and current_registration.registration_owner_id = entry.registration_owner_id
        and current_registration.state = 'active'
      join vortex_access.permission_catalogue_entries as current_entry
        on current_entry.organization_id = entry.organization_id
        and current_entry.registration_kind = entry.registration_kind
        and current_entry.registration_owner_id = entry.registration_owner_id
        and current_entry.registration_revision = current_registration.revision
        and current_entry.application_root_id is not distinct from entry.application_root_id
        and current_entry.owner_kind = entry.owner_kind
        and current_entry.owner_id = entry.owner_id
        and current_entry.permission_id = entry.permission_id
        and vortex_access.permission_meaning_is_same_internal(entry, current_entry)
      join vortex_access.permission_continuities as continuity
        on continuity.last_processed_registration_revision = current_registration.revision
        and continuity.organization_id = entry.organization_id
        and continuity.application_scope_id = coalesce(entry.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
        and continuity.owner_kind = entry.owner_kind
        and continuity.owner_id = entry.owner_id
        and continuity.permission_id = entry.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = parsed.continuity_revision
      where entry.organization_id = p_organization_id
        and entry.application_root_id is not distinct from
          parsed.application_root_id
        and entry.owner_kind = parsed.owner_kind
        and entry.owner_id = parsed.owner_id
        and entry.permission_id = parsed.permission_id
        and entry.registration_revision =
          parsed.accepted_registration_revision
    )
  ) then
    raise exception using errcode = '23514',
      message = 'Bounded delegation permissions require exact current catalogue evidence';
  end if;
end
$_$;

alter function vortex_access.validate_organization_delegation_bounded_permissions(p_organization_id uuid, p_permissions jsonb) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.validate_organization_delegation_bounded_permissions(p_organization_id uuid, p_permissions jsonb) FROM PUBLIC;

grant execute on function vortex_access.validate_organization_delegation_bounded_permissions(p_organization_id uuid, p_permissions jsonb) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.validate_organization_role_activation_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  statement_started_at timestamptz := pg_catalog.statement_timestamp();
  validation_time timestamptz := pg_catalog.clock_timestamp();
  role_fact record;
  current_assignment record;
  current_membership record;
begin
  if new.revision <> 1
    or new.state <> 'live'
    or new.activated_at < statement_started_at
    or new.activated_at > validation_time
    or new.expires_at <= validation_time then
    raise exception using errcode = '23514',
      message = 'A new role activation requires a current live revision-one window';
  end if;

  if not exists (
    select 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = new.organization_id
      and account.organization_account_id = new.organization_account_id
      and account.state = 'active'
  ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires an active same-organization account';
  end if;

  select role.live_revision, revision.lifecycle, revision.assignment_policy,
    revision.authority_continuity_revision,
    revision.policy_continuity_revision, revision.activation_policy_id,
    revision.activation_policy_revision,
    policy.maximum_activation_duration_seconds
  into role_fact
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
  where role.organization_id = new.organization_id
    and role.role_id = new.role_id;

  if not found
    or role_fact.live_revision <> new.historical_role_revision
    or role_fact.lifecycle not in ('active', 'acceptance_required')
    or role_fact.assignment_policy <> 'activation_required'
    or role_fact.authority_continuity_revision <>
      new.authority_continuity_revision
    or role_fact.policy_continuity_revision <> new.policy_continuity_revision
    or role_fact.activation_policy_id <> new.activation_policy_id
    or role_fact.activation_policy_revision <> new.activation_policy_revision
    or extract(epoch from (new.expires_at - new.activated_at)) >
      role_fact.maximum_activation_duration_seconds then
    raise exception using errcode = '23514',
      message = 'A role activation requires exact current role and policy evidence';
  end if;

  if not exists (
    select 1
    from vortex_access.organization_role_permission_entries as permission
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = permission.organization_id
      and continuity.application_scope_id = coalesce(permission.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and continuity.owner_kind = permission.owner_kind
      and continuity.owner_id = permission.owner_id
      and continuity.permission_id = permission.permission_id
      and continuity.state = 'available'
      and continuity.continuity_revision = permission.continuity_revision
    where permission.organization_id = new.organization_id
      and permission.role_id = new.role_id
      and permission.role_revision = new.historical_role_revision
  ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires nonempty current retained authority';
  end if;

  select assignment.role_id, assignment.assignee_kind,
    assignment.organization_account_id, assignment.group_id,
    assignment.assignment_kind, assignment.revision, assignment.starts_at,
    assignment.expires_at, assignment.state
  into current_assignment
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = new.organization_id
    and assignment.role_assignment_id = new.role_assignment_id;

  if not found
    or current_assignment.role_id <> new.role_id
    or current_assignment.assignment_kind <> 'eligible'
    or current_assignment.revision <> new.role_assignment_revision
    or current_assignment.state <> 'live'
    or current_assignment.starts_at > validation_time
    or (
      current_assignment.expires_at is not null
      and current_assignment.expires_at <= validation_time
    )
    or (
      current_assignment.expires_at is not null
      and new.expires_at > current_assignment.expires_at
    ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires exact current eligible assignment evidence';
  end if;

  if new.eligibility_source_kind = 'direct' then
    if current_assignment.assignee_kind <> 'organization_account'
      or current_assignment.organization_account_id <>
        new.organization_account_id then
      raise exception using errcode = '23514',
        message = 'A direct activation requires matching account eligibility';
    end if;
  elsif new.eligibility_source_kind = 'group' then
    if current_assignment.assignee_kind <> 'group' then
      raise exception using errcode = '23514',
        message = 'A Group activation requires Group eligibility';
    end if;

    select membership.group_id, membership.organization_account_id,
      membership.revision, membership.starts_at, membership.expires_at,
      membership.state
    into current_membership
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = membership.organization_id
      and organization_group.group_id = membership.group_id
      and organization_group.state = 'active'
    where membership.organization_id = new.organization_id
      and membership.membership_id = new.membership_id;

    if not found
      or current_membership.group_id <> current_assignment.group_id
      or current_membership.organization_account_id <>
        new.organization_account_id
      or current_membership.revision <> new.membership_revision
      or current_membership.state <> 'live'
      or current_membership.starts_at > validation_time
      or (
        current_membership.expires_at is not null
        and current_membership.expires_at <= validation_time
      )
      or (
        current_membership.expires_at is not null
        and new.expires_at > current_membership.expires_at
      ) then
      raise exception using errcode = '23514',
        message = 'A Group activation requires exact current membership evidence';
    end if;
  end if;

  return new;
end
$$;

alter function vortex_access.validate_organization_role_activation_insert() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.validate_organization_role_activation_insert() FROM PUBLIC;

grant execute on function vortex_access.validate_organization_role_activation_insert() to postgres;

create or replace function vortex_access.validate_organization_role_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  target_organization_id uuid;
  target_role_id uuid;
  target_role_revision bigint;
  target_role_kind text;
  target_lifecycle text;
  target_privilege_classification text;
  target_assignment_policy text;
  target_policy_continuity_revision bigint;
  target_authority_continuity_revision bigint;
  target_activation_policy_id uuid;
  target_activation_policy_revision bigint;
  target_application_root_id uuid;
  target_registration_revision bigint;
  previous_lifecycle text;
  previous_assignment_policy text;
  previous_policy_continuity_revision bigint;
  previous_authority_continuity_revision bigint;
  previous_activation_policy_id uuid;
  previous_activation_policy_revision bigint;
  policy_unchanged boolean;
  authority_broadened boolean;
  permission_count bigint;
  administrative_permission_count bigint;
  inconsistent_permission_count bigint;
  inconsistent_source_count bigint;
begin
  target_organization_id := new.organization_id;
  target_role_id := new.role_id;
  target_role_revision := new.revision;

  select revision.role_kind, revision.lifecycle, revision.privilege_classification,
    revision.assignment_policy, revision.policy_continuity_revision,
    revision.authority_continuity_revision, revision.activation_policy_id,
    revision.activation_policy_revision,
    revision.application_root_id,
    revision.accepted_registration_revision
  into target_role_kind, target_lifecycle, target_privilege_classification,
    target_assignment_policy, target_policy_continuity_revision,
    target_authority_continuity_revision, target_activation_policy_id,
    target_activation_policy_revision,
    target_application_root_id,
    target_registration_revision
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = target_organization_id
    and revision.role_id = target_role_id
    and revision.revision = target_role_revision;

  if not found then
    return null;
  end if;

  if target_role_revision = 1 then
    if target_policy_continuity_revision <> 1 then
      raise exception using errcode = '23514',
        message = 'An initial organization role policy continuity revision must be one';
    end if;
    if target_authority_continuity_revision <> 1 then
      raise exception using errcode = '23514',
        message = 'An initial organization role authority continuity revision must be one';
    end if;
  else
    select revision.lifecycle, revision.assignment_policy,
      revision.policy_continuity_revision,
      revision.authority_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision
    into previous_lifecycle, previous_assignment_policy,
      previous_policy_continuity_revision,
      previous_authority_continuity_revision, previous_activation_policy_id,
      previous_activation_policy_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision - 1;

    if not found then
      raise exception using errcode = '23514',
        message = 'An organization role revision requires its immediate predecessor';
    end if;

    policy_unchanged :=
      target_assignment_policy = previous_assignment_policy
      and target_activation_policy_id is not distinct from previous_activation_policy_id
      and target_activation_policy_revision is not distinct
        from previous_activation_policy_revision;

    if policy_unchanged and
      target_policy_continuity_revision <> previous_policy_continuity_revision then
      raise exception using errcode = '23514',
        message = 'Unchanged role policy must preserve policy continuity';
    end if;

    if not policy_unchanged and (
      previous_policy_continuity_revision = 9007199254740991
      or target_policy_continuity_revision <> previous_policy_continuity_revision + 1
    ) then
      raise exception using errcode = '23514',
        message = 'Changed role policy must advance policy continuity exactly once';
    end if;

    select exists (
      select 1
      from vortex_access.organization_role_permission_entries as current_permission
      where current_permission.organization_id = target_organization_id
        and current_permission.role_id = target_role_id
        and current_permission.role_revision = target_role_revision
        and not exists (
          select 1
          from vortex_access.organization_role_permission_entries as previous_permission
          where previous_permission.organization_id = current_permission.organization_id
            and previous_permission.role_id = current_permission.role_id
            and previous_permission.role_revision = target_role_revision - 1
            and previous_permission.application_root_id is not distinct
              from current_permission.application_root_id
            and previous_permission.owner_kind = current_permission.owner_kind
            and previous_permission.owner_id = current_permission.owner_id
            and previous_permission.permission_id = current_permission.permission_id
            and previous_permission.continuity_revision =
              current_permission.continuity_revision
        )
    ) into authority_broadened;

    if authority_broadened
      or (
        previous_lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      ) then
      if previous_authority_continuity_revision = 9007199254740991
        or target_authority_continuity_revision <>
          previous_authority_continuity_revision + 1 then
        raise exception using errcode = '23514',
          message = 'Broadened or restored role authority must advance continuity exactly once';
      end if;
    elsif target_authority_continuity_revision <>
      previous_authority_continuity_revision then
      raise exception using errcode = '23514',
        message = 'Preserved or narrowed role authority must preserve continuity';
    end if;
  end if;

  select pg_catalog.count(*) into permission_count
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision;

  if (target_role_kind = 'custom' or target_lifecycle = 'active')
    and permission_count = 0 then
    raise exception using errcode = '23514',
      message = 'This organization role lifecycle requires accepted permissions';
  end if;

  select pg_catalog.count(*) into inconsistent_source_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = permission.organization_id
    and registration.registration_kind = permission.registration_kind
    and registration.registration_owner_id = permission.registration_owner_id
    and registration.revision = permission.accepted_registration_revision
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and (
      permission.catalogue_fingerprint <> registration.permission_catalogue_fingerprint
    );

  if inconsistent_source_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Role permissions must retain exact catalogue evidence';
  end if;

  select pg_catalog.count(*) into administrative_permission_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and catalogue.administrative;

  if target_privilege_classification = 'standard'
    and administrative_permission_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Administrative permissions require privileged role classification';
  end if;

  if target_role_kind = 'application' then
    select pg_catalog.count(*) into inconsistent_source_count
    from vortex_access.organization_role_revisions as revision
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = revision.organization_id
      and registration.registration_kind = revision.source_registration_kind
      and registration.registration_owner_id = revision.application_root_id
      and registration.revision = revision.accepted_registration_revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision
      and (
        revision.source_definition_key <> registration.source_definition_key
        or revision.source_release_revision <> registration.source_revision
        or revision.source_release_version <> registration.source_version
        or revision.source_validation_contract_version <>
          registration.validation_contract_version
      );

    if inconsistent_source_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role source must match exact registration evidence';
    end if;

    select pg_catalog.count(*) into inconsistent_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = target_role_revision
      and (
        permission.application_root_id is distinct from target_application_root_id
        or permission.accepted_registration_revision <> target_registration_revision
      );

    if inconsistent_permission_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role permissions must match accepted registration evidence';
    end if;
  end if;

  return null;
end
$function$;
alter function vortex_access.validate_organization_role_revision() owner to vortex_owner;


revoke execute on function vortex_access.validate_organization_role_revision()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.validate_organization_role_revision() is
  'Deferred evidence check of one organisation role revision and its accepted permission entries. Definer, because it fires at commit under the request role, which has no table access.';

alter function vortex_access.validate_organization_role_revision()
  owner to vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.withdraw_application_permission_registration_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  operation_at timestamptz;
  current_registration vortex_access.permission_registrations%rowtype;
  next_revision bigint;
  resulting_version bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Application permission withdrawal input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501', message = 'Application permission withdrawal scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id;
  if not found
    or current_registration.state <> 'active'
    or current_registration.revision <> p_expected_revision
    or current_registration.revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Application permission registration revision is stale or unavailable';
  end if;
  next_revision := current_registration.revision + 1;
  operation_at := greatest(
    current_registration.changed_at,
    pg_catalog.clock_timestamp()
  );

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'application', p_application_root_id, next_revision, 'withdrawn', 'withdraw', current_registration.source_definition_key, current_registration.source_version, current_registration.source_revision, current_registration.validation_contract_version, current_registration.permission_catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_catalogue_fingerprint,
    record_scope, field_policy
  )
  select entry.organization_id, entry.registration_kind, entry.registration_owner_id,
    next_revision, entry.application_root_id, entry.owner_kind, entry.owner_id,
    entry.permission_id, entry.permission_key, entry.label, entry.description,
    entry.record_type_id, entry.action_kind, entry.named_action, entry.administrative,
    entry.source_kind, entry.source_definition_key, entry.source_root_id,
    entry.source_version, entry.source_revision, entry.source_validation_contract_version,
    entry.source_catalogue_fingerprint, entry.record_scope,
    entry.field_policy
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id
    and entry.registration_revision = current_registration.revision;

  update vortex_access.permission_registrations as registration
  set state = 'withdrawn', revision = next_revision, changed_at = operation_at,
      changed_by = p_changed_by, change_correlation_id = p_correlation_id
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id;

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;
  return query select 'withdraw'::text, p_organization_id, p_application_root_id,
    'withdrawn'::text, next_revision, resulting_version, p_correlation_id;
end
$$;

ALTER FUNCTION vortex_access.withdraw_application_permission_registration_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.withdraw_application_permission_registration_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) IS 'The registration withdrawal of the coordinated application-access change; owner-only.';

REVOKE ALL ON FUNCTION vortex_access.withdraw_application_permission_registration_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.withdraw_application_permission_registration_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_revision bigint, p_changed_by uuid, p_correlation_id uuid) to postgres;

create or replace function vortex_definition.write_preview_shape_internal(
  p_preview_installation_id uuid,
  p_evolve boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_row vortex_definition.preview_installations%rowtype;
  module_pin record;
  owned_release record;
  application_content_value jsonb;
  system_projection_ids_value uuid[] := array[]::uuid[];
  resolved_modules_value jsonb := '[]'::jsonb;
  storage_identities_value jsonb := '[]'::jsonb;
begin
  select preview.* into strict preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
  for no key update;

  -- The exact Module pins of the previewed Application release, through every Module dependency,
  -- each read from this preview's rehearsed releases first and the stored releases otherwise.
  for module_pin in
    with recursive edges as (
      select dependency.root_id, dependency.release_revision,
        dependency.target_root_id, dependency.target_release_revision
      from vortex_definition.release_dependencies as dependency
      where dependency.dependency_kind = 'module'
        and not exists (
          select 1 from vortex_definition.preview_releases as preview
          where preview.preview_installation_id = p_preview_installation_id
            and preview.root_id = dependency.root_id
            and preview.release_revision = dependency.release_revision
        )
      union all
      select preview.root_id, preview.release_revision,
        (dependency.value ->> 'target_root_id')::uuid,
        (dependency.value ->> 'target_release_revision')::bigint
      from vortex_definition.preview_releases as preview
      cross join lateral pg_catalog.jsonb_array_elements(preview.dependencies) as dependency(value)
      where preview.preview_installation_id = p_preview_installation_id
        and dependency.value ->> 'dependency_kind' = 'module'
    ), closure(module_root_id, module_release_revision) as (
      select edge.target_root_id, edge.target_release_revision
      from edges as edge
      where edge.root_id = preview_row.application_root_id
        and edge.release_revision = preview_row.application_release_revision
      union
      select edge.target_root_id, edge.target_release_revision
      from closure
      join edges as edge
        on edge.root_id = closure.module_root_id
        and edge.release_revision = closure.module_release_revision
    )
    select closure.module_root_id, closure.module_release_revision,
      coalesce(
        (select preview.release ->> 'release_version'
          from vortex_definition.preview_releases as preview
          where preview.preview_installation_id = p_preview_installation_id
            and preview.root_id = closure.module_root_id
            and preview.release_revision = closure.module_release_revision),
        (select release.release_version
          from vortex_definition.releases as release
          join vortex_definition.roots as root on root.root_id = release.root_id
          where release.root_id = closure.module_root_id
            and release.release_revision = closure.module_release_revision
            and root.kind = 'module'
            and root.organization_id = preview_row.organization_id)
      ) as release_version
    from closure
    order by closure.module_root_id, closure.module_release_revision
  loop
    if module_pin.module_root_id is null
      or module_pin.module_release_revision not between 1 and 9007199254740991
      or module_pin.release_version is null
      or resolved_modules_value @> pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('moduleRootId', module_pin.module_root_id)
      ) then
      raise exception using errcode = '23514',
        message = 'Preview Module pins are unavailable or ambiguous';
    end if;
    resolved_modules_value := resolved_modules_value || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', module_pin.module_root_id,
        'moduleReleaseRevision', module_pin.module_release_revision,
        'releaseVersion', module_pin.release_version
      )
    );
    storage_identities_value := storage_identities_value || case when p_evolve
      then vortex_record.evolve_preview_module_storage(
        p_preview_installation_id, module_pin.module_root_id, module_pin.module_release_revision
      )
      else vortex_record.provision_preview_module_storage(
        p_preview_installation_id, module_pin.module_root_id, module_pin.module_release_revision
      )
    end;
  end loop;
  if pg_catalog.jsonb_array_length(resolved_modules_value) = 0 then
    raise exception using errcode = '23514', message = 'Previewed Application binds no Module';
  end if;

  -- The preview's own permission registration: what the previewed Application and its own
  -- Modules declare, at the releases the preview runs, and the draft's roles, which only the
  -- builder who opened the preview holds. A used Module's permissions are not part of it.
  insert into vortex_access.preview_permission_registrations (
    preview_installation_id, organization_id, application_root_id, organization_account_id,
    system_projection_record_type_ids, owned_owner_ids, role_ids
  )
  select p_preview_installation_id, preview_row.organization_id, preview_row.application_root_id,
    preview_row.previewer_organization_account_id,
    array[]::uuid[],
    pg_catalog.array_append(
      coalesce(pg_catalog.array_agg(owned.module_root_id order by owned.module_root_id), array[]::uuid[]),
      preview_row.application_root_id
    ),
    array[]::uuid[]
  from (
    select (pin.value ->> 'moduleRootId')::uuid as module_root_id
    from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
    join vortex_definition.roots as root
      on root.root_id = (pin.value ->> 'moduleRootId')::uuid
    where root.organization_id = preview_row.organization_id
      and root.kind = 'module'
      and root.owner_application_root_id = preview_row.application_root_id
  ) as owned;

  for owned_release in
    select pinned.root_id, root.key, pinned.owner_kind,
      coalesce(preview.release, pg_catalog.to_jsonb(stored.*)) as release
    from (
      select preview_row.application_root_id as root_id,
        preview_row.application_release_revision as release_revision,
        'application'::text as owner_kind
      union all
      select (pin.value ->> 'moduleRootId')::uuid, (pin.value ->> 'moduleReleaseRevision')::bigint,
        'module'
      from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
    ) as pinned
    join vortex_definition.roots as root
      on root.root_id = pinned.root_id
      and root.organization_id = preview_row.organization_id
      and root.kind = pinned.owner_kind
      and (root.root_id = preview_row.application_root_id
        or root.owner_application_root_id = preview_row.application_root_id)
    left join vortex_definition.preview_releases as preview
      on preview.preview_installation_id = p_preview_installation_id
      and preview.root_id = pinned.root_id
      and preview.release_revision = pinned.release_revision
    left join vortex_definition.releases as stored
      on preview.root_id is null
      and stored.root_id = pinned.root_id
      and stored.release_revision = pinned.release_revision
    order by pinned.owner_kind, pinned.root_id
  loop
    if owned_release.release is null
      or pg_catalog.jsonb_typeof(
        owned_release.release #> '{compilation_output,canonical,content,permissions}'
      ) is distinct from 'array' then
      raise exception using errcode = '23514',
        message = 'Previewed permission declarations are unavailable';
    end if;
    if owned_release.owner_kind = 'application' then
      application_content_value := owned_release.release #> '{compilation_output,canonical,content}';
    end if;
    insert into vortex_access.preview_permission_entries (
      preview_installation_id, entry, held
    )
    select p_preview_installation_id,
      pg_catalog.jsonb_populate_record(
        null::vortex_access.permission_catalogue_entries,
        pg_catalog.jsonb_build_object(
          'organization_id', preview_row.organization_id,
          'registration_kind', 'application',
          'registration_owner_id', preview_row.application_root_id,
          'registration_revision', 1,
          'application_root_id', preview_row.application_root_id,
          'owner_kind', owned_release.owner_kind,
          'owner_id', owned_release.root_id,
          'permission_id', permission.value ->> 'permissionId',
          'permission_key', permission.value ->> 'key',
          'label', permission.value ->> 'label',
          'description', permission.value ->> 'description',
          'record_type_id', permission.value ->> 'recordTypeId',
          'action_kind', permission.value ->> 'actionKind',
          'named_action', permission.value ->> 'namedAction',
          'administrative', permission.value -> 'administrative',
          'source_kind', owned_release.owner_kind,
          'source_definition_key', owned_release.key,
          'source_root_id', owned_release.root_id,
          'source_version', owned_release.release ->> 'release_version',
          'source_revision', owned_release.release -> 'release_revision',
          'source_validation_contract_version',
            owned_release.release ->> 'validation_contract_version',
          'record_scope', permission.value -> 'recordScope',
          'field_policy', permission.value -> 'fieldPolicy'
        )
      ),
      false
    from pg_catalog.jsonb_array_elements(
      owned_release.release #> '{compilation_output,canonical,content,permissions}'
    ) as permission(value);
  end loop;
  if application_content_value is null
    or pg_catalog.jsonb_typeof(application_content_value -> 'roles') is distinct from 'array' then
    raise exception using errcode = '23514',
      message = 'Previewed permission declarations are unavailable';
  end if;

  -- A system projection, of an own Module or a used one, is the platform's live read model: every
  -- permission on it is decided by the builder's own live access, never by a preview role.
  select coalesce(pg_catalog.array_agg(distinct (record_type.value ->> 'recordTypeId')::uuid), array[]::uuid[])
  into system_projection_ids_value
  from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
  left join vortex_definition.preview_releases as preview
    on preview.preview_installation_id = p_preview_installation_id
    and preview.root_id = (pin.value ->> 'moduleRootId')::uuid
    and preview.release_revision = (pin.value ->> 'moduleReleaseRevision')::bigint
  left join vortex_definition.releases as stored
    on preview.root_id is null
    and stored.root_id = (pin.value ->> 'moduleRootId')::uuid
    and stored.release_revision = (pin.value ->> 'moduleReleaseRevision')::bigint
  cross join lateral pg_catalog.jsonb_array_elements(
    coalesce(
      coalesce(preview.release -> 'compilation_output', stored.compilation_output)
        #> '{canonical,content,recordTypes}',
      '[]'::jsonb
    )
  ) as record_type(value)
  where record_type.value ? 'systemProjection';
  update vortex_access.preview_permission_registrations as registration
  set system_projection_record_type_ids = system_projection_ids_value
  where registration.preview_installation_id = p_preview_installation_id;

  -- The builder holds every role of the draft: a permission is held when a role selects it, an
  -- Application-wide selection taking only the Application's ordinary permissions, as it does
  -- at installation. A permission on a system projection is never held in a preview.
  update vortex_access.preview_permission_entries as preview_entry
  set held = true
  where preview_entry.preview_installation_id = p_preview_installation_id
    and not coalesce((preview_entry.entry).record_type_id = any(system_projection_ids_value), false)
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(application_content_value -> 'roles') as role(value)
      where role.value -> 'permissionKeys' ? (preview_entry.entry).permission_key
        and (
          role.value #>> '{permissionSelection,kind}' = 'exact'
          or (
            role.value #>> '{permissionSelection,kind}' = 'application_wildcard'
            and (preview_entry.entry).owner_kind = 'application'
            and not (preview_entry.entry).administrative
            and (preview_entry.entry).action_kind <> 'export'
          )
        )
    );
  update vortex_access.preview_permission_registrations as registration
  set role_ids = coalesce((
    select pg_catalog.array_agg(distinct (role.value ->> 'roleId')::uuid)
    from pg_catalog.jsonb_array_elements(application_content_value -> 'roles') as role(value)
  ), array[]::uuid[])
  where registration.preview_installation_id = p_preview_installation_id;

  update vortex_definition.preview_installations as preview
  set resolved_modules = resolved_modules_value,
      storage_identities = storage_identities_value
  where preview.preview_installation_id = p_preview_installation_id;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview installation is unavailable';
end
$function$;

alter function vortex_definition.write_preview_shape_internal(uuid, boolean) owner to vortex_owner;

revoke all on function vortex_definition.write_preview_shape_internal(uuid, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.write_preview_shape_internal(uuid, boolean)
  to vortex_owner;
comment on function vortex_definition.write_preview_shape_internal(uuid, boolean) is
  'Writes what a preview runs from its rehearsed releases: the exact Module pins, its isolated Record storage (new, or moved in place to the new releases keeping its records), and its own permission registration with the draft''s roles, which only its builder holds.';

commit;

reset role;
