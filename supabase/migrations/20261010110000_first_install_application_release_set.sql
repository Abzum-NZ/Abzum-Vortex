-- Add the protected exact published release supplier for first installation.

begin;

set local role postgres;

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
        'operationKey', 'platform.organization.definition_drafts.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          'permissionId', '0548c061-b1a9-48e5-a04a-eb1d0dae0644'
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
        is distinct from 'platform.organization.definition_drafts.manage'
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

alter function vortex_definition.read_first_install_application_release_set(uuid, bigint)
  owner to postgres;
revoke all on function vortex_definition.read_first_install_application_release_set(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_definition_owner, vortex_module_owner, vortex_record_owner, vortex_record_adapter,
    vortex_connection_owner;
grant execute on function vortex_definition.read_first_install_application_release_set(uuid, bigint)
  to vortex_request;
comment on function vortex_definition.read_first_install_application_release_set(uuid, bigint) is
  'Returns the exact same-organization ordinary published Application and complete immutable Module pin closure to an org-only HUMAN draft manager before Application permission registration; grants no installation or mutation authority.';

reset role;

commit;
