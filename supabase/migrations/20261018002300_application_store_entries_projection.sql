-- App Store (#2736): the organisation's application catalogue is a protected read model. Its one
-- reader lists every ordinary Application the organisation owns with a published version: the
-- latest version, its release note and the version installed now, if any. Installing and upgrading
-- stay registered platform operations; this read changes nothing.
-- Installing and upgrading need only the installation authority, never a right on the
-- Application's draft: an install is anchored to the latest published version, which
-- read_application_latest_release returns to a person who may manage applications, and the
-- first-install release read asks for that same permission instead of draft management.
set local role vortex_owner;

-- The organisation's application catalogue: every ordinary Application it owns with a published
-- version, the latest version and its release note, and the version installed now, if any.
create or replace function vortex_access.list_application_store_entries_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer
set search_path = ''
set max_parallel_workers_per_gather = 0
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  sort_sql text;
  keyset_sql text := '';
  after_text text;
  after_record_id uuid;
  comparison text;
begin
  if p_sort_key not in ('record_id', 'key')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023',
      message = 'Application catalogue projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key = 'key' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
    exception when invalid_text_representation then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end;
  end if;

  begin
    context_value := vortex_access.validated_human_request_context();
  exception when insufficient_privilege then
    return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform 1 from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    );
  exception when sqlstate '42501' or sqlstate 'P0002' then
    return;
  end;

  comparison := case when p_direction = 'ascending' then '>' else '<' end;
  if p_after is not null then
    keyset_sql := case p_sort_key
      when 'key' then pg_catalog.format(
        ' and (root.key collate "C", root.root_id) %s ($3 collate "C", $4)', comparison)
      else pg_catalog.format(' and root.root_id %s $4', comparison) end;
  end if;
  sort_sql := case p_sort_key
    when 'key' then pg_catalog.format('root.key collate "C" %1$s, root.root_id %1$s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('root.root_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;

  return query execute $scan$
    select $1, root.root_id, root.current_release_revision,
      pg_catalog.jsonb_build_object(
        'key', root.key,
        'name', latest.application_address ->> 'name',
        'description', latest.compilation_output #>> '{canonical,content,description}',
        'latest_version', latest.release_version,
        'latest_release_note', latest.release_note,
        'published_at', latest.published_at,
        'installed_version', installed.release_version,
        'status', case
          when installed.release_revision is null then 'available'
          when installed.release_revision < root.current_release_revision then 'update_available'
          else 'installed' end
      )
    from vortex_definition.roots as root
    join vortex_definition.releases as latest
      on latest.root_id = root.root_id
      and latest.release_revision = root.current_release_revision
    left join lateral (
      select release.release_revision, release.release_version
      from vortex_access.permission_registrations as registration
      join vortex_definition.releases as release
        on release.root_id = root.root_id
        and release.release_revision = registration.source_revision
        and release.release_version = registration.source_version
        and release.validation_contract_version = registration.validation_contract_version
      where registration.organization_id = root.organization_id
        and registration.registration_owner_id = root.root_id
        and registration.registration_kind = 'application'
        and registration.state = 'active'
        and registration.source_definition_key = root.key
        and exists (
          select 1 from vortex_definition.installation_bindings as binding
          where binding.organization_id = root.organization_id
            and binding.application_root_id = root.root_id
            and binding.application_release_revision = registration.source_revision
            and binding.state = 'active'
        )
      limit 1
    ) as installed on true
    where root.organization_id = $1
      and root.kind = 'application'
      and root.application_origin_kind = 'ordinary'
      and root.current_release_revision is not null
      and ($2 is null or root.root_id = any($2))
      and latest.application_address ->> 'kind' = 'application'
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $5', sort_sql)
  using visible_organization_id, p_record_ids, after_text, after_record_id, p_limit;
end
$function$;

comment on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer
) is 'The organisation''s application catalogue: its ordinary Applications with a published version, the latest version and the installed one.';

revoke all on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;

-- The latest published version of one ordinary Application of the request's organisation, for a
-- person who may manage the organisation's application installations. Installing and upgrading are
-- anchored to it; no draft right is needed.
create or replace function vortex_definition.read_application_latest_release(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  permission_decision record;
  latest jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application latest release selector is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if checked_context is null
    or checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Application latest release authority is unavailable';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity; the owner role has no read access to the declarations table
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity; the owner role has no read access to the declarations table
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible'
    or (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Application latest release authority is unavailable';
  end if;

  select pg_catalog.jsonb_build_object(
    'definitionKey', root.key,
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'releaseNote', release.release_note
  ) into latest
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = root.current_release_revision
  where root.root_id = p_application_root_id
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'application'
    and root.application_origin_kind = 'ordinary';
  return latest;
end
$function$;

revoke all on function vortex_definition.read_application_latest_release(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.read_application_latest_release(uuid)
  to vortex_request, postgres;
comment on function vortex_definition.read_application_latest_release(uuid) is
  'Returns the latest published version of one ordinary Application of the request organisation to a caller holding platform.organization.applications.manage, or null when it has none.';
alter function vortex_definition.read_application_latest_release(uuid) owner to vortex_owner;

create or replace function vortex_definition.read_first_install_application_release_set(
  p_application_root_id uuid,
  p_application_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  initial_context jsonb;
  permission_decision record;
  locked_access_version bigint;
  origin_kind text;
  application_evidence jsonb;
  module_evidence jsonb;
  pin_count bigint;
  completion_time timestamptz;
  permission_deadline timestamptz;
  pass integer;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'First installation release selector is invalid';
  end if;

  initial_context := vortex_access.validated_human_request_context();
  if initial_context is null
    or initial_context ->> 'callerKind' is distinct from 'human'
    or initial_context ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'First installation release authority is unavailable';
  end if;

  -- The normal HUMAN org request has acquired Access before this store read.
  -- Retain the same lock even for a direct protected request-role invocation.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = (initial_context ->> 'organizationId')::uuid
  for share;
  if not found or locked_access_version
    is distinct from (initial_context ->> 'accessVersion')::bigint then
    raise exception using errcode = '42501',
      message = 'First installation release authority is unavailable';
  end if;
  permission_deadline := (initial_context ->> 'expiresAt')::timestamptz;

  for pass in 1..2 loop
    select evaluated.* into strict permission_decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.applications.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          -- guard-allow: function-uuid fixed platform permission identity; the owner role has no read access to the declarations table
          'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          -- guard-allow: function-uuid fixed platform permission identity; the owner role has no read access to the declarations table
          'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;
    checked_context := vortex_access.validated_human_request_context();
    completion_time := pg_catalog.clock_timestamp();
    if checked_context is distinct from initial_context
      or permission_decision.outcome is distinct from 'eligible'
      or permission_decision.operation_key
        is distinct from 'platform.organization.applications.manage'
      or permission_decision.target_kind is distinct from 'organization'
      or permission_decision.target_application_root_id is not null
      or permission_decision.organization_id
        is distinct from (initial_context ->> 'organizationId')::uuid
      or permission_decision.organization_account_id
        is distinct from (initial_context ->> 'organizationAccountId')::uuid
      or permission_decision.access_version is distinct from locked_access_version
      or permission_decision.correlation_id
        is distinct from (initial_context ->> 'correlationId')::uuid
      or permission_decision.checked_at is null
      or not pg_catalog.isfinite(permission_decision.checked_at)
      or permission_decision.checked_at > completion_time
      or permission_decision.valid_until is null
      or not pg_catalog.isfinite(permission_decision.valid_until)
      or permission_decision.valid_until <= completion_time
      or permission_deadline is null
      or not pg_catalog.isfinite(permission_deadline)
      or permission_deadline <= completion_time
      or (initial_context ->> 'issuedAt')::timestamptz > completion_time then
      raise exception using errcode = '42501',
        message = 'First installation release authority is unavailable';
    end if;
    permission_deadline := least(permission_deadline, permission_decision.valid_until);

    if pass = 1 then
      select root.application_origin_kind into origin_kind
      from vortex_definition.roots as root
      where root.root_id = p_application_root_id
        and root.organization_id = (initial_context ->> 'organizationId')::uuid
        and root.kind = 'application'
      for share;
      if not found or origin_kind is distinct from 'ordinary' then
        raise exception using errcode = 'P0002',
          message = 'First installation release is unavailable';
      end if;

      application_evidence := vortex_definition.project_consumer_release_evidence(
        'application', p_application_root_id, p_application_release_revision
      );
      if application_evidence is null then
        raise exception using errcode = 'P0002',
          message = 'First installation release is unavailable';
      end if;

      -- One authoritative immutable closure; no caller pins or current/latest lookup.
      select pg_catalog.count(*), coalesce(pg_catalog.jsonb_agg(
        vortex_definition.project_consumer_release_evidence(
          'module', pin.target_root_id, pin.target_release_revision
        ) order by pin.target_root_id
      ), '[]'::jsonb)
      into pin_count, module_evidence
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as pin;
      if pin_count > 10000
        or exists (
          select 1 from pg_catalog.jsonb_array_elements(module_evidence) as entry(value)
          where entry.value is null or entry.value = 'null'::jsonb
            or entry.value ->> 'kind' is distinct from 'module'
            or (entry.value ->> 'organizationId')::uuid
              is distinct from (initial_context ->> 'organizationId')::uuid
        ) then
        raise exception using errcode = '23514',
          message = 'First installation release evidence is incomplete';
      end if;
    end if;
  end loop;

  if permission_deadline <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'First installation release authority is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'correlationId', initial_context -> 'correlationId',
    'application', application_evidence,
    'modules', module_evidence
  );
end
$function$;

revoke all on function vortex_definition.read_first_install_application_release_set(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.read_first_install_application_release_set(uuid, bigint)
  to vortex_request;
comment on function vortex_definition.read_first_install_application_release_set(uuid, bigint) is
  'Returns the exact same-organization ordinary published Application and complete immutable Module pin closure to an org-only HUMAN who may manage application installations, before Application permission registration; grants no installation or mutation authority.';

alter function vortex_definition.read_first_install_application_release_set(p_application_root_id uuid, p_application_release_revision bigint) owner to vortex_owner;

alter table vortex_record.protected_read_model_views
  drop constraint protected_read_model_views_protected_read_model_key_check;
alter table vortex_record.protected_read_model_views
  add constraint protected_read_model_views_protected_read_model_key_check
  check (protected_read_model_key = any (array[
    'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
    'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
    'permissions', 'role_activations', 'delegations', 'tenants',
    'tenant_administrators', 'installed_applications', 'application_role_templates',
    'activity_entry', 'application_store_entries'
  ]));

alter table vortex_record.storage_catalogue
  drop constraint storage_catalogue_protected_read_model_key_check;
alter table vortex_record.storage_catalogue
  add constraint storage_catalogue_protected_read_model_key_check
  check (
    (physical_schema_token = 'system_projection') = (protected_read_model_key is not null)
    and (protected_read_model_key is null or protected_read_model_key = any (array[
    'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
    'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
    'permissions', 'role_activations', 'delegations', 'tenants',
    'tenant_administrators', 'installed_applications', 'application_role_templates',
    'activity_entry', 'application_store_entries'
    ]))
  );

insert into vortex_record.protected_read_model_views (
  protected_read_model_key, reader_schema, reader_function, changed_at, cursor_sort_keys
) values (
  'application_store_entries', 'vortex_access',
  'list_application_store_entries_projection', pg_catalog.statement_timestamp(),
  array['record_id', 'key']::text[]
);

reset role;
