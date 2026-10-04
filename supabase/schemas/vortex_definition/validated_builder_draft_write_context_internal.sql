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
    select root.application_origin_kind into origin_kind
    from vortex_definition.roots as root
    where root.root_id = p_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'application'
    for update;
    if not found or origin_kind is null
      or origin_kind not in ('ordinary', 'platform_system_application') then
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
  'Private live human Application draft guard for the existing create/save function owner; locks Access and classified roots and rechecks exact current permissions and deadlines.';

alter function vortex_definition.validated_builder_draft_write_context_internal(uuid)
  owner to vortex_definition_owner;
