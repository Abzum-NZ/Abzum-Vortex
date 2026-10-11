-- Save one existing Module draft through the initiating HUMAN Definition transaction.

begin;

set local role vortex_definition_owner;

create or replace function vortex_definition.validated_builder_draft_write_context_internal(
  p_root_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  checked_context jsonb;
  locked_access_version bigint;
  origin_kind text := 'ordinary';
  root_kind text;
  permission_key text;
  permission_keys text[] := array['platform.organization.definition_drafts.manage'];
  permission_id uuid;
  permission_decision record;
  checked_at timestamptz;
  permission_deadline timestamptz;
begin
  -- Only the existing trusted create/save definers can call this private guard.
  checked_context := vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or checked_context ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Definition draft write authority is unavailable';
  end if;
  permission_deadline := (checked_context ->> 'expiresAt')::timestamptz;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = (checked_context ->> 'organizationId')::uuid
  for update;
  if not found or locked_access_version
    is distinct from (checked_context ->> 'accessVersion')::bigint then
    raise exception using errcode = '42501',
      message = 'Definition draft write authority is unavailable';
  end if;

  if p_root_id is not null then
    select root.kind, root.application_origin_kind into root_kind, origin_kind
    from vortex_definition.roots as root
    where root.root_id = p_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
    for update;
    if not found or root_kind is null
      or root_kind not in ('application', 'module')
      or (root_kind = 'application' and (
        origin_kind is null or origin_kind not in ('ordinary', 'platform_system_application')
      ))
      or (root_kind = 'module' and origin_kind is not null) then
      raise exception using errcode = '42501',
        message = 'Definition draft write authority is unavailable';
    end if;
  end if;

  if origin_kind = 'platform_system_application' then
    permission_keys := array[
      'platform.organization.definition_drafts.manage',
      'platform.organization.system_applications.manage'
    ];
  end if;
  foreach permission_key in array permission_keys loop
    permission_id := case permission_key
      when 'platform.organization.definition_drafts.manage'
        then '0548c061-b1a9-48e5-a04a-eb1d0dae0644'::uuid
      else 'eaade6fd-7390-44d2-a7ef-343324c7384a'::uuid
    end;
    select evaluated.* into strict permission_decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', permission_key,
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          'permissionId', permission_id
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;

    checked_at := pg_catalog.clock_timestamp();
    if permission_decision.outcome is distinct from 'eligible'
      or permission_decision.operation_key is distinct from permission_key
      or permission_decision.target_kind is distinct from 'organization'
      or permission_decision.target_application_root_id is not null
      or permission_decision.organization_id
        is distinct from (checked_context ->> 'organizationId')::uuid
      or permission_decision.organization_account_id
        is distinct from (checked_context ->> 'organizationAccountId')::uuid
      or permission_decision.access_version is distinct from locked_access_version
      or permission_decision.correlation_id
        is distinct from (checked_context ->> 'correlationId')::uuid
      or permission_decision.checked_at is null
      or permission_decision.checked_at > checked_at
      or permission_decision.valid_until is null
      or permission_decision.valid_until <= checked_at
      or (checked_context ->> 'issuedAt')::timestamptz > checked_at
      or (checked_context ->> 'expiresAt')::timestamptz <= checked_at then
      raise exception using errcode = '42501',
        message = 'Definition draft write authority is unavailable';
    end if;
    permission_deadline := least(permission_deadline, permission_decision.valid_until);
  end loop;

  if permission_deadline <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'Definition draft write authority is unavailable';
  end if;

  return checked_context;
end
$function$;

revoke all on function vortex_definition.validated_builder_draft_write_context_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.validated_builder_draft_write_context_internal(uuid)
  to postgres;

comment on function vortex_definition.validated_builder_draft_write_context_internal(uuid) is
  'Private live human Application and Module draft guard for the existing create/save function owner; locks Access and classified roots and rechecks exact current permissions and deadlines.';

alter function vortex_definition.validated_builder_draft_write_context_internal(uuid)
  owner to vortex_definition_owner;

reset role;

-- The public canonical save retains its effective postgres owner.
-- Schema CREATE is available only while replacing that existing function.
grant create on schema vortex_definition to postgres;
set local role postgres;

create or replace function vortex_definition.save_draft(
  p_root_id uuid,
  p_expected_revision bigint,
  p_draft_source jsonb,
  p_source_fingerprint text,
  p_identity_requirements jsonb
)
returns table (
  root_id uuid,
  organization_id uuid,
  kind text,
  definition_key text,
  draft_revision bigint,
  published_revision bigint,
  authored_source jsonb,
  source_contract_version text,
  source_fingerprint text,
  created_at timestamptz,
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  expected_organization_id uuid;
  root_organization_id uuid;
  saved_revision bigint;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  actor_id uuid;
  human_write boolean;
  root_key text;
  root_kind text;
begin
  human_write := vortex_context.current_context() ->> 'callerKind' = 'human';
  if human_write then
    checked_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    actor_id := (checked_context ->> 'organizationAccountId')::uuid;
  else
    checked_context := vortex_definition.validated_system_context();
    actor_id := (checked_context ->> 'systemActorId')::uuid;
  end if;
  expected_organization_id := (checked_context ->> 'organizationId')::uuid;

  if p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Definition draft save has an invalid root or expected revision';
  end if;

  select root.organization_id
  into root_organization_id
  from vortex_definition.roots as root
  where root.root_id = p_root_id;

  if not found then
    return;
  end if;

  if root_organization_id <> expected_organization_id then
    raise exception using
      errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  if human_write then
    select root.key, root.kind into strict root_key, root_kind
    from vortex_definition.roots as root
    where root.root_id = p_root_id;
    if root_kind is null or root_kind not in ('application', 'module')
      or p_draft_source ->> 'kind' is distinct from root_kind
      or p_draft_source ->> 'key' is distinct from root_key then
      raise exception using errcode = '22023',
        message = 'Definition draft write source is invalid';
    end if;
  end if;

  update vortex_definition.drafts as draft
  set
    draft_revision = draft.draft_revision + 1,
    draft_source = p_draft_source,
    identity_requirements = p_identity_requirements,
    source_contract_version = p_draft_source ->> 'source_contract_version',
    source_fingerprint = p_source_fingerprint,
    restored_from_release_revision = null,
    restored_from_source_fingerprint = null,
    restored_by = null,
    restored_at = null,
    restore_correlation_id = null,
    updated_at = operation_at,
    updated_by = actor_id
  where draft.root_id = p_root_id
    and draft.draft_revision = p_expected_revision
  returning draft.draft_revision into saved_revision;

  if saved_revision is null then
    return;
  end if;

  perform vortex_definition.record_source_identities(
    p_root_id,
    p_identity_requirements,
    actor_id,
    operation_at
  );

  if human_write then
    perform vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
  end if;

  return query
  select
    root.root_id,
    root.organization_id,
    root.kind,
    root.key,
    draft.draft_revision,
    root.current_release_revision,
    draft.draft_source,
    draft.source_contract_version,
    draft.source_fingerprint,
    root.created_at,
    root.created_by,
    draft.updated_at,
    draft.updated_by
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_root_id;
end
$function$;

grant execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) to vortex_request;

revoke execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) to vortex_request;

comment on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) is
  'Conditionally saves a draft and records new permanent identities and aliases atomically.';

reset role;
revoke create on schema vortex_definition from postgres;

commit;
