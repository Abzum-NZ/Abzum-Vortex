-- #598: protected Application install, upgrade and withdrawal composition.
--
-- The fixed Module lifecycle (20260913010000) and storage provisioning
-- (20260924002000) are already request-visible and authority-checked. The
-- Access application-registration coordinator (20260905060006, guarded by the
-- stewardship safeguard in 20260906033309) is owner-only because it accepts the
-- actor and correlation as inputs; its test handoff notes that #64 must expose
-- an authority-checking wrapper. This migration adds only that missing
-- composition, derived entirely from the validated human request context:
--
-- 1. vortex_module.read_application_installation_bindings: the installer's
--    view of one Application's current binding revisions, so the App
--    coordinator can build exact revision-checked lifecycle commands.
-- 2. vortex_access.change_application_installation_access: registers, updates,
--    reactivates or withdraws the Application permission registration through
--    the existing coordinator, then appends content-free Activity.
-- 3. vortex_module.record_application_installation_outcome: appends the
--    lifecycle Activity for a binding change this transaction just made.
--
-- Every function is new; no existing function body is replaced. All three
-- derive organisation, actor and correlation from
-- vortex_access.lock_application_installation_authority(), which requires the
-- declared application-management operation and its delegated organisation
-- catalogue scope. Registration grants nobody access: the coordinator creates
-- no assignment and preserves final-steward and continuity safeguards.

set local role vortex_module_owner;

create function vortex_module.read_application_installation_bindings(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  binding_evidence jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application installation read command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  if not exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = p_application_root_id
      and root.organization_id = authority.organization_id
      and root.kind = 'application'
  ) then
    raise exception using errcode = 'P0002',
      message = 'Application installation is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'organizationId', binding.organization_id,
      'applicationRootId', binding.application_root_id,
      'moduleRootId', binding.module_root_id,
      'bindingRevision', binding.binding_revision,
      'applicationReleaseRevision', binding.application_release_revision,
      'moduleReleaseRevision', binding.module_release_revision,
      'state', binding.state
    ) order by binding.module_root_id), '[]'::jsonb)
  into binding_evidence
  from vortex_module.installation_bindings as binding
  where binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id;

  return pg_catalog.jsonb_build_object(
    'organizationId', authority.organization_id,
    'applicationRootId', p_application_root_id,
    'moduleBindings', binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation evidence is ambiguous';
end
$function$;

revoke all on function vortex_module.read_application_installation_bindings(uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.read_application_installation_bindings(uuid)
  to vortex_request;
comment on function vortex_module.read_application_installation_bindings(uuid) is
  'Installer-only read of one Application''s current Module binding revisions under application-management authority.';

reset role;

-- Closed composer, owned like the other private Activity composers
-- (20260923080000_record_lifecycle_policy_storage.sql): it accepts only the
-- fixed lifecycle facts and derives actor, organisation, correlation and time
-- from the validated human context.
create function vortex_module.append_application_installation_activity_internal(
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
    or p_action not in ('activate_application_installation', 'withdraw_application_installation') then
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
    'web',
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

set local role vortex_module_owner;

create function vortex_module.record_application_installation_outcome(
  p_activity_id uuid,
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_state text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  pin_count integer;
  changed_count integer;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or p_state is null
    or p_state not in ('active', 'detached') then
    raise exception using errcode = '22023',
      message = 'Application installation outcome command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );

  -- Activity records only a change this transaction made: every pinned binding
  -- must be in the reported state for this exact release and changed since this
  -- transaction began. The fixed activate/detach operations stamp changed_at
  -- with their statement time and keep the rows locked until commit, so a
  -- binding they changed here satisfies this and an untouched one does not.
  select pg_catalog.count(*)::integer into changed_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  join vortex_module.installation_bindings as binding
    on binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id
  where binding.state = p_state
    and binding.application_release_revision = p_application_release_revision
    and binding.module_release_revision = required.target_release_revision
    and binding.changed_at >= pg_catalog.transaction_timestamp();

  if pin_count = 0 or changed_count <> pin_count then
    raise exception using errcode = '40001',
      message = 'Application installation outcome is not a change of this transaction';
  end if;

  perform vortex_module.append_application_installation_activity_internal(
    p_activity_id,
    p_application_root_id,
    case p_state
      when 'active' then 'activate_application_installation'
      else 'withdraw_application_installation'
    end
  );
end
$function$;

revoke all on function vortex_module.record_application_installation_outcome(
  uuid, uuid, bigint, text
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.record_application_installation_outcome(
  uuid, uuid, bigint, text
) to vortex_request;
comment on function vortex_module.record_application_installation_outcome(
  uuid, uuid, bigint, text
) is
  'Appends content-free Activity for an Application activation or withdrawal made earlier in the same protected transaction.';

reset role;

create function vortex_access.change_application_installation_access(
  p_activity_id uuid,
  p_application_root_id uuid,
  p_change text,
  p_prepared_templates jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  current_registration vortex_access.permission_registrations%rowtype;
  registration_found boolean;
  coordinated_operation text;
  expected_revision bigint;
  changed record;
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_change is null
    or p_change not in ('prepare', 'withdraw')
    or (p_change = 'prepare' and p_prepared_templates is null)
    or (p_change = 'withdraw' and p_prepared_templates is not null) then
    raise exception using errcode = '22023',
      message = 'Application installation access command is invalid';
  end if;

  -- Locks the organisation Access version and proves current installation
  -- authority. Every registration writer takes that lock first, so the
  -- registration read below cannot change before the coordinator rechecks it.
  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = authority.organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id;
  registration_found := found;

  if p_change = 'withdraw' then
    if not registration_found then
      raise exception using errcode = 'P0002',
        message = 'Application permission registration is unavailable';
    end if;
    if current_registration.state = 'withdrawn' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unchanged',
        'operation', 'withdraw',
        'organizationId', authority.organization_id,
        'applicationRootId', p_application_root_id,
        'registrationState', current_registration.state,
        'registrationRevision', current_registration.revision
      );
    end if;
    coordinated_operation := 'withdraw';
    expected_revision := current_registration.revision;
  elsif not registration_found then
    coordinated_operation := 'register';
    expected_revision := null;
  elsif current_registration.state = 'withdrawn' then
    coordinated_operation := 'reactivate';
    expected_revision := current_registration.revision;
  else
    coordinated_operation := 'update';
    expected_revision := current_registration.revision;
  end if;

  -- The coordinator validates the prepared candidate against the stored
  -- Application and Module releases and this organisation, applies continuity
  -- narrowing, never assigns a role, and asserts the permanent-steward
  -- invariant before it returns.
  select result.* into strict changed
  from vortex_access.coordinate_application_access_change(
    coordinated_operation,
    expected_revision,
    p_prepared_templates,
    authority.organization_id,
    p_application_root_id,
    authority.organization_account_id,
    authority.correlation_id
  ) as result;

  if changed.organization_id <> authority.organization_id
    or changed.application_root_id <> p_application_root_id
    or changed.correlation_id <> authority.correlation_id then
    raise exception using errcode = '55000',
      message = 'Application installation access result is inconsistent';
  end if;

  if changed.outcome = 'changed' then
    append_result := vortex_activity.append_organization_activity_entry(
      authority.organization_id,
      p_activity_id,
      pg_catalog.statement_timestamp(),
      'organization_account',
      authority.organization_account_id,
      coordinated_operation || '_application_access',
      array[p_application_root_id]::uuid[],
      array[]::uuid[],
      'web',
      authority.correlation_id,
      'completed'
    );
    if append_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Application installation access Activity is stale';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', changed.outcome,
    'operation', changed.operation,
    'organizationId', changed.organization_id,
    'applicationRootId', changed.application_root_id,
    'registrationState', changed.registration_state,
    'registrationRevision', changed.registration_revision
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation access evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation access evidence is ambiguous';
end
$function$;

revoke all on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) to vortex_request;
comment on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) is
  'Authority-checked Application permission registration change for installation; derives actor and correlation from validated human context and grants no access.';
