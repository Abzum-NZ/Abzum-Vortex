-- #1139: the Application installation draining state and the first protected uninstall step.
--
-- An installation now moves from active to draining before it is removed. While draining no new
-- flow starts, tool call or navigation load resolves the installation, because every active
-- installation reader selects only state = 'active'; callbacks for work already running stay
-- bound to the exact revision they started against, so those runs finish. This migration:
--
-- 1. admits 'draining' in vortex_module.installation_bindings.state;
-- 2. adds vortex_module.drain_installation, the uninstall command's first step. Under the
--    caller's own protected application-management authority it moves one exact active
--    installation to draining in one transaction, refuses a Module an installed Application
--    depends on, refuses the organisation's access-management application, and appends
--    content-free Activity from the trusted request channel;
-- 3. exposes the Access-owned management-application fact that refusal needs through
--    vortex_access.application_is_stewardship_management_application;
-- 4. extends the existing protected installation Activity composer with the drain action.
-- 5. refuses re-provisioning a draining binding, exactly as an active one is refused, so no
--    prepare or upgrade returns a draining installation to service.
--
-- Removing registrations and handling data are the next uninstall steps and own their changes.

-- The binding table is owned by the Module schema owner.
set local role vortex_module_owner;
alter table vortex_module.installation_bindings
  drop constraint installation_bindings_state_check;
alter table vortex_module.installation_bindings
  add constraint installation_bindings_state_check
  check (state in ('provisioned', 'active', 'draining', 'detached'));
reset role;

-- The postgres-owned protected composer and Access reader below live in the Module and Access
-- schemas. The Module schema owner lends postgres USAGE and CREATE for this migration only;
-- revoked again at the end.
set local role vortex_module_owner;
grant usage, create on schema vortex_module to postgres;
reset role;

create or replace function vortex_module.append_application_installation_activity_internal(
  p_activity_id uuid,
  p_application_root_id uuid,
  p_action text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action is null
    or p_action not in (
      'activate_application_installation', 'withdraw_application_installation',
      'drain_application_installation'
    ) then
    raise exception using errcode = '22023',
      message = 'Application installation Activity input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id,
    pg_catalog.statement_timestamp(),
    'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    p_action,
    array[p_application_root_id]::uuid[],
    array[]::uuid[],
    vortex_context.channel(),
    (context_value ->> 'correlationId')::uuid,
    'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Application installation Activity is stale';
  end if;
end
$function$;

revoke all on function vortex_module.append_application_installation_activity_internal(
  uuid, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_module.append_application_installation_activity_internal(
  uuid, uuid, text
) to vortex_module_owner;

comment on function vortex_module.append_application_installation_activity_internal(
  uuid, uuid, text
) is
  'Private content-free Activity composer for one protected Application installation lifecycle change.';

create or replace function vortex_access.application_is_stewardship_management_application(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = p_organization_id
      and requirement.management_application_root_id = p_application_root_id
  )
$function$;

revoke all on function vortex_access.application_is_stewardship_management_application(
  uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.application_is_stewardship_management_application(
  uuid, uuid
) to vortex_module_owner;

comment on function vortex_access.application_is_stewardship_management_application(
  uuid, uuid
) is
  'Whether one Application is the organisation''s active access-management application, whose uninstall would leave the steward without a working way to manage access.';

set local role vortex_module_owner;

create or replace function vortex_module.drain_installation(
  p_activity_id uuid,
  p_root_id uuid,
  p_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_authority record;
  current_authority record;
  target_kind text;
  application_release vortex_definition.releases%rowtype;
  pin record;
  expected_count integer;
  pin_count integer;
  all_active boolean;
  all_draining boolean;
  changed_value boolean;
  binding_evidence jsonb;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) = 0
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or not item.value ?& array['moduleRootId', 'bindingRevision']
        or item.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
        or (item.value ->> 'moduleRootId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
        or (item.value ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      group by (item.value ->> 'moduleRootId')::uuid
      having pg_catalog.count(*) <> 1
    )
    or p_expected_module_bindings is distinct from (
      select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'moduleRootId')::uuid)
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
    ) then
    raise exception using errcode = '22023',
      message = 'Installation drain command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  select root.kind into target_kind
  from vortex_definition.roots as root
  where root.root_id = p_root_id
    and root.organization_id = initial_authority.organization_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Installation is unavailable';
  end if;

  -- A Module is never installed on its own; its storage and records exist because an
  -- installed Application binds that exact release. Uninstalling a Module an installed
  -- Application still depends on is refused.
  if target_kind = 'module' then
    if exists (
      select 1 from vortex_module.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.module_root_id = p_root_id
        and binding.state in ('provisioned', 'active', 'draining')
    ) then
      raise exception using errcode = '42501',
        message = 'Installation is required by an installed application';
    end if;
    raise exception using errcode = 'P0002',
      message = 'Installation is unavailable';
  end if;

  -- The organisation's access-management application is the steward's working way to
  -- manage access. Any uninstall step that would remove it is refused.
  if vortex_access.application_is_stewardship_management_application(
    initial_authority.organization_id, p_root_id
  ) then
    raise exception using errcode = '42501',
      message = 'Installation is required for access management';
  end if;

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.root_id = p_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application'
    and release.release_revision = p_release_revision
    and release.validation_contract_version = any (vortex_definition.accepted_contract_version('application'))
    and release.compilation_output #>> '{kind}' = 'application'
    and release.compilation_output #>> '{canonical,envelope,rootId}' = p_root_id::text
    and release.compilation_output #>> '{validationContractVersion}' = any (vortex_definition.accepted_contract_version('application'));

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision);
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if pin_count = 0 or expected_count <> pin_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Installation binding set is incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
    order by required.target_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_module.binding:' || initial_authority.organization_id::text || ':' ||
          p_root_id::text || ':' || pin.target_root_id::text,
        0
      )
    );
    perform 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_root_id
      and binding.module_root_id = pin.target_root_id
    for update;
  end loop;

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  if current_authority.organization_id <> initial_authority.organization_id
    or current_authority.organization_account_id <> initial_authority.organization_account_id
    or current_authority.access_version <> initial_authority.access_version
    or current_authority.correlation_id <> initial_authority.correlation_id then
    raise exception using errcode = '40001',
      message = 'Installation authority changed';
  end if;

  select pg_catalog.bool_and(coalesce(
      binding.state = 'active'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'draining'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    ))
  into all_active, all_draining
  from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
  left join vortex_module.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_root_id
    and binding.module_root_id = required.target_root_id
  left join lateral (
    select (expected.value ->> 'bindingRevision')::bigint as binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
  ) as expected on true;
  if all_active is null or (not all_active and not all_draining)
    or exists (
      select 1 from vortex_module.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_root_id
        and binding.state <> 'detached'
        and not exists (
          select 1
          from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
          where required.target_root_id = binding.module_root_id
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Installation bindings changed or are incomplete';
  end if;

  changed_value := all_active;
  if changed_value then
    if exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
      join vortex_module.installation_bindings as binding
        on binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_root_id
        and binding.module_root_id = required.target_root_id
      where binding.binding_revision = 9007199254740991
    ) then
      raise exception using errcode = '22003',
        message = 'Installation binding revision is exhausted';
    end if;
    update vortex_module.installation_bindings as binding
    set state = 'draining', binding_revision = binding.binding_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
    from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_root_id
      and binding.module_root_id = required.target_root_id
      and binding.state = 'active';
    if not found then
      raise exception using errcode = '40001',
        message = 'Installation bindings changed';
    end if;
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'organizationId', binding.organization_id,
    'applicationRootId', binding.application_root_id,
    'moduleRootId', binding.module_root_id,
    'bindingRevision', binding.binding_revision,
    'applicationReleaseRevision', binding.application_release_revision,
    'moduleReleaseRevision', binding.module_release_revision,
    'state', binding.state
  ) order by binding.module_root_id) into binding_evidence
  from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
  join vortex_module.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_root_id
    and binding.module_root_id = required.target_root_id;

  if changed_value then
    perform vortex_module.append_application_installation_activity_internal(
      p_activity_id, p_root_id, 'drain_application_installation'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_root_id,
    'applicationReleaseRevision', p_release_revision,
    'state', 'draining', 'changed', changed_value,
    'moduleBindings', binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installation evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Installation drain command is invalid';
end
$function$;

revoke all on function vortex_module.drain_installation(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.drain_installation(uuid, uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_module.drain_installation(uuid, uuid, bigint, jsonb) is
  'Protected first uninstall step: moves one exact active Application installation to draining, or refuses a Module an installed Application depends on or the organisation access-management Application, recording Activity from the trusted channel.';

-- A draining installation is being uninstalled: like an active one, its bindings are never
-- re-provisioned, so a prepare or upgrade cannot silently return it to service mid-drain.
create or replace function vortex_module.provision_module_installation_storage(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_expected_binding_revision bigint
)
returns table (
  state text,
  changed boolean,
  binding_revision bigint,
  application_root_id uuid,
  application_release_revision bigint,
  module_root_id uuid,
  module_release_revision bigint,
  storage_contract_ids uuid[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  permission_decision record;
  delegation_decision record;
  checked_context jsonb;
  application_release vortex_definition.releases%rowtype;
  stored_binding vortex_module.installation_bindings%rowtype;
  provision record;
  next_binding_revision bigint;
  binding_exists boolean;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_release_revision not between 1 and 9007199254740991
    or (p_expected_binding_revision is not null
      and p_expected_binding_revision not between 1 and 9007199254740991) then
    raise exception using errcode = '22023', message = 'Module installation storage command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501', message = 'Module installation authority is unavailable';
  end if;

  select evaluated.* into strict delegation_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  if delegation_decision.outcome is distinct from 'eligible'
    or delegation_decision.organization_id <> permission_decision.organization_id
    or delegation_decision.organization_account_id <> permission_decision.organization_account_id
    or delegation_decision.access_version <> permission_decision.access_version
    or delegation_decision.correlation_id <> permission_decision.correlation_id then
    raise exception using errcode = '42501', message = 'Module installation delegation is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001', message = 'Module installation context changed';
  end if;

  -- The binding identity is locked before its row can exist. Storage lineage
  -- locks are acquired later by the Record helper in canonical UUID order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_module.binding:' || permission_decision.organization_id::text || ':' ||
        p_application_root_id::text || ':' || p_module_root_id::text,
      0
    )
  );

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_application_root_id
    and release.release_revision = p_application_release_revision
    and root.kind = 'application'
    and root.organization_id = permission_decision.organization_id;
  if application_release.validation_contract_version <> all (vortex_definition.accepted_contract_version('application'))
    or application_release.compilation_output #>> '{kind}' <> 'application'
    or application_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> p_application_root_id::text
    or application_release.compilation_output #>> '{validationContractVersion}' <> all (vortex_definition.accepted_contract_version('application')) then
    raise exception using errcode = '23514', message = 'Exact Application release is unavailable';
  end if;
  if not exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as edge
    where edge.target_root_id = p_module_root_id
      and edge.target_release_revision = p_module_release_revision
  ) then
    raise exception using errcode = '23514', message = 'Exact application Module binding is unavailable';
  end if;

  select binding.* into stored_binding
  from vortex_module.installation_bindings as binding
  where binding.organization_id = permission_decision.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = p_module_root_id
  for update;
  binding_exists := found;

  if binding_exists then
    if stored_binding.state in ('active', 'draining')
      or (
        p_expected_binding_revision is null
        and (
          stored_binding.application_release_revision <> p_application_release_revision
          or stored_binding.module_release_revision <> p_module_release_revision
          or stored_binding.state <> 'provisioned'
        )
      )
      or (
        p_expected_binding_revision is not null
        and stored_binding.binding_revision <> p_expected_binding_revision
      ) then
      raise exception using errcode = '40001', message = 'Module installation binding changed';
    end if;
  end if;
  if not binding_exists and p_expected_binding_revision is not null then
    raise exception using errcode = '40001', message = 'Module installation binding is unavailable';
  end if;

  select storage.* into strict provision
  from vortex_record.provision_exact_module_storage(
    p_module_root_id, p_module_release_revision
  ) as storage;

  if binding_exists
    and stored_binding.application_release_revision = p_application_release_revision
    and stored_binding.module_release_revision = p_module_release_revision
    and stored_binding.state = 'provisioned' then
    if stored_binding.storage_contract_ids <> provision.storage_contract_ids then
      raise exception using errcode = '55000', message = 'Stored Module installation evidence is incompatible';
    end if;
    return query select stored_binding.state, false, stored_binding.binding_revision,
      stored_binding.application_root_id, stored_binding.application_release_revision,
      stored_binding.module_root_id, stored_binding.module_release_revision,
      stored_binding.storage_contract_ids;
    return;
  end if;

  if binding_exists then
    if stored_binding.binding_revision = 9007199254740991 then
      raise exception using errcode = '22003', message = 'Module installation binding revision is exhausted';
    end if;
    next_binding_revision := stored_binding.binding_revision + 1;
    update vortex_module.installation_bindings as binding
    set binding_revision = next_binding_revision,
        application_release_revision = p_application_release_revision,
        module_release_revision = p_module_release_revision,
        state = 'provisioned',
        storage_contract_ids = provision.storage_contract_ids,
        changed_at = pg_catalog.statement_timestamp()
    where binding.organization_id = permission_decision.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = p_module_root_id
      and binding.binding_revision = p_expected_binding_revision;
    if not found then
      raise exception using errcode = '40001', message = 'Module installation binding changed';
    end if;
  else
    next_binding_revision := 1;
    insert into vortex_module.installation_bindings (
      organization_id, application_root_id, module_root_id, binding_revision,
      application_release_revision, module_release_revision, state,
      storage_contract_ids
    ) values (
      permission_decision.organization_id, p_application_root_id, p_module_root_id, 1,
      p_application_release_revision, p_module_release_revision, 'provisioned',
      provision.storage_contract_ids
    );
  end if;

  return query select 'provisioned'::text, true, next_binding_revision,
    p_application_root_id, p_application_release_revision, p_module_root_id,
    p_module_release_revision, provision.storage_contract_ids;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Module installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module installation evidence is ambiguous';
end
$function$;

revoke all on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) to vortex_request;
comment on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) is 'Protected exact-release storage provisioning; commits only an inactive Module binding.';

reset role;

set local role vortex_module_owner;
revoke usage, create on schema vortex_module from postgres;
reset role;
