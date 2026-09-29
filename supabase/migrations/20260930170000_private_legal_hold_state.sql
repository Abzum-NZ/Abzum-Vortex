-- Private, append-only legal-hold versions and their protected current projection.

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
grant execute on function vortex_context.validated_service_context()
  to vortex_connection_owner;
grant execute on function vortex_context.validated_service_context()
  to vortex_file_owner;
grant execute on function vortex_context.validated_service_context()
  to vortex_record_owner;

comment on function vortex_context.validated_service_context() is
  'Dispatches an established request context through the authoritative human or system validator.';

grant usage on schema vortex_context to vortex_record_owner;
grant usage on schema vortex_record to vortex_file_owner;

set local role vortex_record_owner;
create table vortex_record.legal_hold_versions (
  tenant_id uuid not null,
  organization_id uuid not null,
  hold_id uuid not null,
  hold_revision bigint not null,
  scope_revision bigint not null,
  scope_kind text not null,
  application_root_id uuid,
  record_type_id uuid,
  record_id uuid,
  file_id uuid,
  status text not null,
  reason text not null,
  created_by_kind text not null,
  created_by_id uuid not null,
  created_at timestamptz not null,
  starts_at timestamptz not null,
  review_at timestamptz not null,
  release_decision_id uuid,
  release_reason text,
  released_by_kind text,
  released_by_id uuid,
  released_at timestamptz,
  constraint legal_hold_versions_pkey
    primary key (tenant_id, organization_id, hold_id, hold_revision),
  constraint legal_hold_versions_tenant_id_valid
    check (tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  constraint legal_hold_versions_organization_id_valid
    check (organization_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  constraint legal_hold_versions_hold_id_valid
    check (hold_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  constraint legal_hold_versions_hold_revision_valid
    check (hold_revision between 1 and 9007199254740990),
  constraint legal_hold_versions_scope_revision_valid
    check (scope_revision between 1 and hold_revision),
  constraint legal_hold_versions_scope_valid
    check (
      (
        scope_kind = 'all_organization_data'
        and application_root_id is null
        and record_type_id is null
        and record_id is null
        and file_id is null
      )
      or (
        scope_kind = 'application'
        and application_root_id is not null
        and application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
        and record_type_id is null
        and record_id is null
        and file_id is null
      )
      or (
        scope_kind = 'record_type'
        and application_root_id is null
        and record_type_id is not null
        and record_type_id <> '00000000-0000-0000-0000-000000000000'::uuid
        and record_id is null
        and file_id is null
      )
      or (
        scope_kind = 'record'
        and application_root_id is null
        and record_type_id is not null
        and record_type_id <> '00000000-0000-0000-0000-000000000000'::uuid
        and record_id is not null
        and record_id <> '00000000-0000-0000-0000-000000000000'::uuid
        and file_id is null
      )
      or (
        scope_kind = 'file'
        and application_root_id is null
        and record_type_id is null
        and record_id is null
        and file_id is not null
        and file_id <> '00000000-0000-0000-0000-000000000000'::uuid
      )
    ),
  constraint legal_hold_versions_status_valid
    check (status in ('active', 'released')),
  constraint legal_hold_versions_reason_valid
    check (pg_catalog.char_length(pg_catalog.btrim(reason)) between 1 and 4000),
  constraint legal_hold_versions_creator_valid
    check (
      created_by_kind in ('human', 'system')
      and created_by_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  constraint legal_hold_versions_dates_valid
    check (review_at > starts_at),
  constraint legal_hold_versions_release_valid
    check (
      (
        status = 'active'
        and release_decision_id is null
        and release_reason is null
        and released_by_kind is null
        and released_by_id is null
        and released_at is null
      )
      or (
        status = 'released'
        and release_decision_id is not null
        and release_decision_id <> '00000000-0000-0000-0000-000000000000'::uuid
        and release_reason is not null
        and pg_catalog.char_length(pg_catalog.btrim(release_reason)) between 1 and 4000
        and released_by_kind is not null
        and released_by_kind in ('human', 'system')
        and released_by_id is not null
        and released_by_id <> '00000000-0000-0000-0000-000000000000'::uuid
        and released_at is not null
      )
    )
);

alter table vortex_record.legal_hold_versions owner to vortex_record_owner;
alter table vortex_record.legal_hold_versions enable row level security;
alter table vortex_record.legal_hold_versions force row level security;

revoke all on table vortex_record.legal_hold_versions
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_file_owner, vortex_module_owner;

create policy legal_hold_versions_validated_scope
  on vortex_record.legal_hold_versions
  for select
  to vortex_record_owner
  using (
    tenant_id = (vortex_context.validated_service_context() ->> 'tenantId')::uuid
    and organization_id =
      (vortex_context.validated_service_context() ->> 'organizationId')::uuid
  );

create or replace function vortex_record.read_current_legal_holds(p_candidate jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_tenant_id uuid;
  context_organization_id uuid;
  context_application_root_id uuid;
  candidate_kind text;
  candidate_tenant_id uuid;
  candidate_organization_id uuid;
  candidate_application_root_id uuid;
  candidate_application_known boolean := false;
  candidate_record_type_id uuid;
  candidate_record_id uuid;
  candidate_file_id uuid;
  candidate_owner_record_type_id uuid;
  candidate_owner_record_id uuid;
  allowed_keys text[];
  required_keys text[];
  hold_values jsonb;
begin
  begin
    context_value := vortex_context.validated_service_context();
  exception
    when insufficient_privilege
      or foreign_key_violation
      or object_not_in_prerequisite_state
      or invalid_text_representation then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end;

  if context_value is null
    or pg_catalog.jsonb_typeof(context_value) is distinct from 'object'
    or context_value ->> 'callerKind' is null
    or context_value ->> 'callerKind' not in ('human', 'system')
    or not vortex_context.is_non_nil_uuid(context_value ->> 'tenantId')
    or not vortex_context.is_non_nil_uuid(context_value ->> 'organizationId') then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  context_tenant_id := (context_value ->> 'tenantId')::uuid;
  context_organization_id := (context_value ->> 'organizationId')::uuid;

  if p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) is distinct from 'object'
    or not (p_candidate ?& array['kind', 'tenantId', 'organizationId']) then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  candidate_kind := p_candidate ->> 'kind';
  if candidate_kind = 'record' then
    allowed_keys := array[
      'kind', 'tenantId', 'organizationId', 'applicationRootId', 'recordTypeId', 'recordId'
    ];
    required_keys := array['kind', 'tenantId', 'organizationId', 'recordTypeId', 'recordId'];
  elsif candidate_kind = 'file' then
    allowed_keys := array[
      'kind', 'tenantId', 'organizationId', 'applicationRootId', 'fileId',
      'ownerRecordTypeId', 'ownerRecordId'
    ];
    required_keys := array['kind', 'tenantId', 'organizationId', 'fileId'];
  else
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  if not (p_candidate ?& required_keys)
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_candidate) as candidate_key(key)
      where not (candidate_key.key = any (allowed_keys))
    )
    or not vortex_context.is_non_nil_uuid(p_candidate ->> 'tenantId')
    or not vortex_context.is_non_nil_uuid(p_candidate ->> 'organizationId') then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  candidate_tenant_id := (p_candidate ->> 'tenantId')::uuid;
  candidate_organization_id := (p_candidate ->> 'organizationId')::uuid;
  if candidate_tenant_id <> context_tenant_id
    or candidate_organization_id <> context_organization_id then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  if p_candidate ? 'applicationRootId' then
    if pg_catalog.jsonb_typeof(p_candidate -> 'applicationRootId') = 'null'
      and candidate_kind = 'record' then
      candidate_application_known := true;
    elsif vortex_context.is_non_nil_uuid(p_candidate ->> 'applicationRootId') then
      candidate_application_root_id := (p_candidate ->> 'applicationRootId')::uuid;
      candidate_application_known := true;
      if not vortex_context.is_non_nil_uuid(context_value ->> 'applicationRootId') then
        return pg_catalog.jsonb_build_object('outcome', 'unavailable');
      end if;
      context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
      if candidate_application_root_id <> context_application_root_id then
        return pg_catalog.jsonb_build_object('outcome', 'unavailable');
      end if;
    else
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
  end if;

  if candidate_kind = 'record' then
    if not vortex_context.is_non_nil_uuid(p_candidate ->> 'recordTypeId')
      or not vortex_context.is_non_nil_uuid(p_candidate ->> 'recordId') then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    candidate_record_type_id := (p_candidate ->> 'recordTypeId')::uuid;
    candidate_record_id := (p_candidate ->> 'recordId')::uuid;
  else
    if not vortex_context.is_non_nil_uuid(p_candidate ->> 'fileId') then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    candidate_file_id := (p_candidate ->> 'fileId')::uuid;

    if p_candidate ? 'ownerRecordTypeId' or p_candidate ? 'ownerRecordId' then
      if not (p_candidate ?& array['ownerRecordTypeId', 'ownerRecordId'])
        or not vortex_context.is_non_nil_uuid(p_candidate ->> 'ownerRecordTypeId')
        or not vortex_context.is_non_nil_uuid(p_candidate ->> 'ownerRecordId') then
        return pg_catalog.jsonb_build_object('outcome', 'unavailable');
      end if;
      candidate_owner_record_type_id := (p_candidate ->> 'ownerRecordTypeId')::uuid;
      candidate_owner_record_id := (p_candidate ->> 'ownerRecordId')::uuid;
      candidate_record_type_id := candidate_owner_record_type_id;
      candidate_record_id := candidate_owner_record_id;
    end if;
  end if;

  if exists (
    select 1
    from (
      select
        hold_id,
        pg_catalog.count(*)::bigint as version_count,
        pg_catalog.min(hold_revision) as first_revision,
        pg_catalog.max(hold_revision) as current_revision
      from vortex_record.legal_hold_versions
      where tenant_id = context_tenant_id
        and organization_id = context_organization_id
      group by hold_id
    ) as history
    where history.first_revision <> 1
      or history.version_count <> history.current_revision
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  if exists (
    select 1
    from (
      select
        version.*,
        pg_catalog.lag(hold_revision) over hold_history as previous_hold_revision,
        pg_catalog.lag(scope_revision) over hold_history as previous_scope_revision,
        pg_catalog.lag(scope_kind) over hold_history as previous_scope_kind,
        pg_catalog.lag(application_root_id) over hold_history as previous_application_root_id,
        pg_catalog.lag(record_type_id) over hold_history as previous_record_type_id,
        pg_catalog.lag(record_id) over hold_history as previous_record_id,
        pg_catalog.lag(file_id) over hold_history as previous_file_id,
        pg_catalog.lag(status) over hold_history as previous_status,
        pg_catalog.lag(release_decision_id) over hold_history as previous_release_decision_id,
        pg_catalog.lag(release_reason) over hold_history as previous_release_reason,
        pg_catalog.lag(released_by_kind) over hold_history as previous_released_by_kind,
        pg_catalog.lag(released_by_id) over hold_history as previous_released_by_id,
        pg_catalog.lag(released_at) over hold_history as previous_released_at
      from vortex_record.legal_hold_versions as version
      where tenant_id = context_tenant_id
        and organization_id = context_organization_id
      window hold_history as (partition by hold_id order by hold_revision)
    ) as lineage
    where lineage.previous_hold_revision is not null
      and (
        lineage.hold_revision <> lineage.previous_hold_revision + 1
        or (
          (
            lineage.scope_kind is distinct from lineage.previous_scope_kind
            or lineage.application_root_id is distinct from lineage.previous_application_root_id
            or lineage.record_type_id is distinct from lineage.previous_record_type_id
            or lineage.record_id is distinct from lineage.previous_record_id
            or lineage.file_id is distinct from lineage.previous_file_id
          )
          and lineage.scope_revision <> lineage.previous_scope_revision + 1
        )
        or (
          lineage.scope_kind is not distinct from lineage.previous_scope_kind
          and lineage.application_root_id is not distinct from lineage.previous_application_root_id
          and lineage.record_type_id is not distinct from lineage.previous_record_type_id
          and lineage.record_id is not distinct from lineage.previous_record_id
          and lineage.file_id is not distinct from lineage.previous_file_id
          and lineage.scope_revision <> lineage.previous_scope_revision
        )
        or (
          lineage.previous_status = 'released'
          and (
            lineage.status is distinct from 'released'
            or lineage.release_decision_id is distinct from lineage.previous_release_decision_id
            or lineage.release_reason is distinct from lineage.previous_release_reason
            or lineage.released_by_kind is distinct from lineage.previous_released_by_kind
            or lineage.released_by_id is distinct from lineage.previous_released_by_id
            or lineage.released_at is distinct from lineage.previous_released_at
          )
        )
      )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  if (
    not candidate_application_known
    or (
      candidate_kind = 'file'
      and candidate_record_type_id is null
    )
  ) and exists (
    with current_revision as (
      select hold_id, pg_catalog.max(hold_revision) as hold_revision
      from vortex_record.legal_hold_versions
      where tenant_id = context_tenant_id
        and organization_id = context_organization_id
      group by hold_id
    )
    select 1
    from vortex_record.legal_hold_versions as current
    join current_revision
      on current_revision.hold_id = current.hold_id
      and current_revision.hold_revision = current.hold_revision
    where current.tenant_id = context_tenant_id
      and current.organization_id = context_organization_id
      and (
        (not candidate_application_known and current.scope_kind = 'application')
        or (
          candidate_kind = 'file'
          and candidate_record_type_id is null
          and current.scope_kind in ('record_type', 'record')
        )
      )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  with current_revision as (
    select hold_id, pg_catalog.max(hold_revision) as hold_revision
    from vortex_record.legal_hold_versions
    where tenant_id = context_tenant_id
      and organization_id = context_organization_id
    group by hold_id
  ),
  current_version as (
    select version.*
    from vortex_record.legal_hold_versions as version
    join current_revision as current
      on current.hold_id = version.hold_id
      and current.hold_revision = version.hold_revision
    where version.tenant_id = context_tenant_id
      and version.organization_id = context_organization_id
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'tenantId', current.tenant_id,
        'holdId', current.hold_id,
        'organizationId', current.organization_id,
        'scope',
          case current.scope_kind
            when 'all_organization_data' then
              pg_catalog.jsonb_build_object('kind', current.scope_kind)
            when 'application' then
              pg_catalog.jsonb_build_object(
                'kind', current.scope_kind,
                'applicationRootId', current.application_root_id
              )
            when 'record_type' then
              pg_catalog.jsonb_build_object(
                'kind', current.scope_kind,
                'recordTypeId', current.record_type_id
              )
            when 'record' then
              pg_catalog.jsonb_build_object(
                'kind', current.scope_kind,
                'recordTypeId', current.record_type_id,
                'recordId', current.record_id
              )
            when 'file' then
              pg_catalog.jsonb_build_object(
                'kind', current.scope_kind,
                'fileId', current.file_id
              )
          end,
        'status', current.status,
        'holdRevision', current.hold_revision,
        'scopeRevision', current.scope_revision
      )
      order by current.hold_id
    ),
    '[]'::jsonb
  )
  into hold_values
  from current_version as current
  where current.scope_kind = 'all_organization_data'
    or (
      current.scope_kind = 'application'
      and candidate_application_known
      and candidate_application_root_id is not null
      and current.application_root_id = candidate_application_root_id
    )
    or (
      current.scope_kind = 'record_type'
      and candidate_record_type_id is not null
      and current.record_type_id = candidate_record_type_id
    )
    or (
      current.scope_kind = 'record'
      and candidate_record_type_id is not null
      and candidate_record_id is not null
      and current.record_type_id = candidate_record_type_id
      and current.record_id = candidate_record_id
    )
    or (
      current.scope_kind = 'file'
      and candidate_kind = 'file'
      and current.file_id = candidate_file_id
    );

  return pg_catalog.jsonb_build_object(
    'outcome', 'complete',
    'holds', hold_values
  );
exception
  when others then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
end
$function$;

revoke all on function vortex_record.read_current_legal_holds(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_file_owner, vortex_module_owner;
grant execute on function vortex_record.read_current_legal_holds(jsonb)
  to vortex_record_adapter, vortex_file_owner, vortex_runtime;
comment on function vortex_record.read_current_legal_holds(jsonb) is
  'Returns only current versioned legal-hold references relevant to one candidate in validated protected scope.';
alter function vortex_record.read_current_legal_holds(jsonb) owner to vortex_record_owner;
reset role;
