-- Publication rehearsal must not block every request in the organisation (#2866).
--
-- Every request that relies on an organisation's current Access version, a read or an ordinary
-- change (record saves, Studio saves, preparation, rehearsal and publication), now holds that
-- version with a shared lock until commit, so no such request waits for another. Only a change
-- that advances the version holds it exclusively, from its first statement, through the access
-- change scopes, which replace the old change scopes. The functions that pinned authority with an
-- exclusive lock without advancing the version now pin it with a shared one: an access change
-- still waits for them, so a decision checked at a version stays valid until commit.
--
-- Preview storage never locks a platform table: a preview's record tables reference no platform
-- row (a foreign key to organisations, accounts or Groups made creating and dropping them take
-- locks on those tables, ACCESS EXCLUSIVE on drop, which stopped every request of every
-- organisation). A replaced or expired preview's storage is retired with its preview row and
-- dropped in the background, one storage identity per short transaction with a short lock timeout,
-- never inside a builder's request.
set local role vortex_owner;

drop function vortex_access.resolve_human_application_change_scope(uuid, uuid, uuid);
drop function vortex_access.resolve_human_organization_change_scope(uuid, uuid);
drop function vortex_record.drop_preview_installation_storage(uuid);
drop function vortex_record.create_record_storage_table_internal(uuid, uuid, uuid, text, text);

-- vortex_access/resolve_human_organization_scope.sql
create or replace function vortex_access.resolve_human_organization_scope(
  p_identity_id uuid,
  p_organization_id uuid
)
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  eligible_tenant_id uuid;
  eligible_organization_id uuid;
  eligible_account_id uuid;
  resolved_access_version bigint;
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_account_id uuid;
begin
  if p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text) then
    raise exception using errcode = '22023',
      message = 'Organisation selection is invalid';
  end if;

  select tenant.tenant_id, organization.organization_id,
    account.organization_account_id, version.current_version
  into eligible_tenant_id, eligible_organization_id,
    eligible_account_id, resolved_access_version
  from vortex_identity.identity_projections as identity
  join vortex_identity.organizations as organization
    on organization.organization_id = p_organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  left join vortex_identity.organization_accounts as account
    on account.organization_id = organization.organization_id
    and account.identity_id = identity.identity_id
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
    and (
      account.state = 'active'
      or (account.organization_account_id is null
        and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          p_identity_id, pg_catalog.statement_timestamp()
        ) is not null)
    )
  for share of version;

  if not found then
    if exists (
      select 1
      from vortex_identity.identity_projections as identity
      join vortex_identity.organizations as organization
        on organization.organization_id = p_organization_id
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      join vortex_identity.organization_accounts as account
        on account.organization_id = organization.organization_id
        and account.identity_id = identity.identity_id
      where identity.identity_id = p_identity_id
        and identity.state = 'active'
        and organization.state = 'active'
        and tenant.state = 'active'
        and account.state = 'suspended'
        and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          p_identity_id, pg_catalog.statement_timestamp()
        ) is not null
    ) then
      raise exception using errcode = 'V3140',
        message = 'This super-administrator organisation account is suspended';
    end if;
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id
  into resolved_tenant_id, resolved_organization_id, resolved_account_id
  from vortex_identity.resolve_active_organization_account(
    p_identity_id, p_organization_id
  ) as scope;
  if not found
    or resolved_tenant_id is distinct from eligible_tenant_id
    or resolved_organization_id is distinct from eligible_organization_id
    or (eligible_account_id is not null
      and resolved_account_id is distinct from eligible_account_id) then
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_account_id, resolved_access_version;
end
$function$;

revoke execute on function vortex_access.resolve_human_organization_scope(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.resolve_human_organization_scope(uuid, uuid)
  to vortex_runtime;

comment on function vortex_access.resolve_human_organization_scope(uuid, uuid) is
  'Resolves one active account-bound organisation scope for every request that relies on the current Access version, reads and ordinary changes alike, holding that version with a shared lock (FOR SHARE) until commit: requests never wait for each other, and only a change that advances the version waits for them. Provisions missing local accounts only for assigned Vortex super administrators.';

alter function vortex_access.resolve_human_organization_scope(p_identity_id uuid, p_organization_id uuid) owner to vortex_owner;

grant execute on function vortex_access.resolve_human_organization_scope(p_identity_id uuid, p_organization_id uuid) to postgres;

-- vortex_access/resolve_human_application_scope.sql
CREATE OR REPLACE FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) RETURNS TABLE(tenant_id uuid, organization_id uuid, organization_account_id uuid, application_root_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_organization_account_id uuid;
  resolved_access_version bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application selection is invalid';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id, scope.access_version
  into resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, resolved_access_version
  from vortex_access.resolve_human_organization_scope(
    p_identity_id,
    p_organization_id
  ) as scope;

  -- The registration the request runs under: the installed one, or the preview's own.
  if not exists (
    select 1
    from vortex_access.request_application_registration_internal(
      resolved_organization_id, p_application_root_id, resolved_organization_account_id
    )
  ) then
    raise exception using errcode = '42501',
      message = 'Application selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, p_application_root_id,
    resolved_access_version;
end
$$;

alter function vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) IS 'Resolves one exact active human organisation scope and active application registration under the organisation''s shared Access lock, for reads and ordinary changes alike.';

REVOKE ALL ON FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) TO vortex_runtime;

grant execute on function vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) to postgres;

-- vortex_access/resolve_human_organization_access_change_scope.sql
create or replace function vortex_access.resolve_human_organization_access_change_scope(
  p_identity_id uuid,
  p_organization_id uuid
)
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  eligible_tenant_id uuid;
  eligible_organization_id uuid;
  eligible_account_id uuid;
  locked_access_version bigint;
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_account_id uuid;
begin
  if p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text) then
    raise exception using errcode = '22023',
      message = 'Organisation access change selection is invalid';
  end if;

  select tenant.tenant_id, organization.organization_id,
    account.organization_account_id, version.current_version
  into eligible_tenant_id, eligible_organization_id,
    eligible_account_id, locked_access_version
  from vortex_identity.identity_projections as identity
  join vortex_identity.organizations as organization
    on organization.organization_id = p_organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  left join vortex_identity.organization_accounts as account
    on account.organization_id = organization.organization_id
    and account.identity_id = identity.identity_id
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
    and (
      account.state = 'active'
      or (account.organization_account_id is null
        and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          p_identity_id, pg_catalog.statement_timestamp()
        ) is not null)
    )
  for update of version;

  if not found then
    if exists (
      select 1
      from vortex_identity.identity_projections as identity
      join vortex_identity.organizations as organization
        on organization.organization_id = p_organization_id
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      join vortex_identity.organization_accounts as account
        on account.organization_id = organization.organization_id
        and account.identity_id = identity.identity_id
      where identity.identity_id = p_identity_id
        and identity.state = 'active'
        and organization.state = 'active'
        and tenant.state = 'active'
        and account.state = 'suspended'
        and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          p_identity_id, pg_catalog.statement_timestamp()
        ) is not null
    ) then
      raise exception using errcode = 'V3140',
        message = 'This super-administrator organisation account is suspended';
    end if;
    raise exception using errcode = '42501',
      message = 'Organisation access change selection is unavailable';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id
  into resolved_tenant_id, resolved_organization_id, resolved_account_id
  from vortex_identity.resolve_active_organization_account(
    p_identity_id, p_organization_id
  ) as scope;
  if not found
    or resolved_tenant_id is distinct from eligible_tenant_id
    or resolved_organization_id is distinct from eligible_organization_id
    or (eligible_account_id is not null
      and resolved_account_id is distinct from eligible_account_id) then
    raise exception using errcode = '42501',
      message = 'Organisation access change selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_account_id, locked_access_version;
end
$function$;

revoke execute on function vortex_access.resolve_human_organization_access_change_scope(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.resolve_human_organization_access_change_scope(uuid, uuid)
  to vortex_runtime;

comment on function vortex_access.resolve_human_organization_access_change_scope(uuid, uuid) is
  'Resolves one active account-bound scope for a change that advances the organisation Access version, holding that version exclusively (FOR UPDATE) until commit, so access changes queue behind every request that relies on the current version and never deadlock with each other. Provisions missing local accounts only for assigned Vortex super administrators.';

alter function vortex_access.resolve_human_organization_access_change_scope(p_identity_id uuid, p_organization_id uuid) owner to vortex_owner;

grant execute on function vortex_access.resolve_human_organization_access_change_scope(p_identity_id uuid, p_organization_id uuid) to postgres;

-- vortex_access/resolve_human_application_access_change_scope.sql
CREATE OR REPLACE FUNCTION vortex_access.resolve_human_application_access_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) RETURNS TABLE(tenant_id uuid, organization_id uuid, organization_account_id uuid, application_root_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_organization_account_id uuid;
  resolved_access_version bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application access change selection is invalid';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id, scope.access_version
  into resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, resolved_access_version
  from vortex_access.resolve_human_organization_access_change_scope(
    p_identity_id,
    p_organization_id
  ) as scope;

  -- The registration the request runs under: the installed one, or the preview's own.
  if not exists (
    select 1
    from vortex_access.request_application_registration_internal(
      resolved_organization_id, p_application_root_id, resolved_organization_account_id
    )
  ) then
    raise exception using errcode = '42501',
      message = 'Application access change selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, p_application_root_id,
    resolved_access_version;
end
$$;

alter function vortex_access.resolve_human_application_access_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.resolve_human_application_access_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) IS 'Resolves one active human application scope for a change that advances the organisation Access version, holding that version exclusively until commit.';

REVOKE ALL ON FUNCTION vortex_access.resolve_human_application_access_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.resolve_human_application_access_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) TO vortex_runtime;

grant execute on function vortex_access.resolve_human_application_access_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) to postgres;

-- vortex_definition/append_release.sql
create or replace function vortex_definition.append_release(
  p_root_id uuid,
  p_expected_draft_revision bigint,
  p_expected_source_fingerprint text,
  p_release jsonb
)
returns table (
  root_id uuid,
  release_revision bigint,
  release_version text,
  content_fingerprint text,
  resolution_fingerprint text,
  dependency_manifest jsonb,
  published_at timestamptz,
  published_by uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  human_publication boolean;
  original_context jsonb;
  locked_access_version bigint;
  permission_key text;
  permission_id uuid;
  permission_decision record;
  checked_at timestamptz;
  permission_deadline timestamptz;
  context_organization_id uuid;
  context_actor_id uuid;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  supplied_dependency jsonb;
  supplied_kind text;
  supplied_reference text;
  supplied_version text;
  supplied_content_fingerprint text;
  supplied_target_root_id uuid;
  supplied_target_release_revision bigint;
  supplied_catalogue_item_id uuid;
  supplied_entry jsonb;
  supplied_owner_kind text;
  supplied_owner_id_key text;
  supplied_expected_keys text[];
  dependency_count integer := 0;
  inserted_dependency_count integer := 0;
  expected_history_revision bigint;
  release_version_value text;
  compilation_output_value jsonb;
  application_address_value jsonb;
  application_experience_value jsonb;
  record_content_value jsonb;
  resolution_snapshot_value jsonb;
  content_fingerprint_value text;
  resolution_fingerprint_value text;
  validation_contract_version_value text;
  impact_reasons_value jsonb;
  release_note_value text;
  dependency_manifest_value jsonb;
  permissions_value jsonb;
begin
  human_publication := vortex_platform.current_context() ->> 'callerKind' = 'human';
  if human_publication then
    checked_context := vortex_access.validated_human_request_context();
    if checked_context ->> 'callerKind' is distinct from 'human'
      or checked_context ? 'applicationRootId'
      or checked_context ? 'delegatedContext' or checked_context ? 'supportContext' then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
    original_context := checked_context;
    permission_deadline := (checked_context ->> 'expiresAt')::timestamptz;
    -- Access precedes root/draft locks, as in ordinary draft creation and saving. A shared lock
    -- pins the authority checked below until commit (an access change must wait for it) while
    -- other requests of the organisation, concurrent publications included, go on; the root
    -- lock below orders publications of one root.
    select version.current_version into locked_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = (checked_context ->> 'organizationId')::uuid
    for share;
    if not found or locked_access_version
      is distinct from (checked_context ->> 'accessVersion')::bigint then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  else
    checked_context := vortex_definition.validated_system_context();
  end if;
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_actor_id := case when human_publication
    then (checked_context ->> 'organizationAccountId')::uuid
    else (checked_context ->> 'systemActorId')::uuid end;

  if human_publication then
    foreach permission_key in array array[
      'platform.organization.definition_drafts.manage',
      'platform.organization.definition_releases.manage'
    ] loop
      permission_id := case permission_key
        when 'platform.organization.definition_drafts.manage'
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
          then '0548c061-b1a9-48e5-a04a-eb1d0dae0644'::uuid
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        else 'dfdd5aba-2b85-4169-b570-92be284e7b5c'::uuid
      end;
      select evaluated.* into strict permission_decision
      from vortex_access.evaluate_organization_permission_eligibility(
        pg_catalog.jsonb_build_object(
          'operationKey', permission_key,
          'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
          'target', pg_catalog.jsonb_build_object('kind', 'organization'),
          'requiredPermission', pg_catalog.jsonb_build_object(
            -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
            'ownerKind', 'platform', 'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
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
        or permission_decision.reason_code is not null
        or permission_decision.organization_id
          is distinct from (checked_context ->> 'organizationId')::uuid
        or permission_decision.organization_account_id
          is distinct from (checked_context ->> 'organizationAccountId')::uuid
        or permission_decision.access_version is distinct from locked_access_version
        or permission_decision.correlation_id
          is distinct from (checked_context ->> 'correlationId')::uuid
        or permission_decision.checked_at is null or permission_decision.checked_at > checked_at
        or permission_decision.valid_until is null or permission_decision.valid_until <= checked_at
        or (checked_context ->> 'issuedAt')::timestamptz > checked_at
        or (checked_context ->> 'expiresAt')::timestamptz <= checked_at then
        raise exception using errcode = '42501',
          message = 'Definition publication authority is unavailable';
      end if;
      permission_deadline := least(permission_deadline, permission_decision.valid_until);
    end loop;
    if permission_deadline <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  if p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_source_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_release) is distinct from 'object'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_release) as supplied(key)
      where supplied.key not in (
        'releaseVersion', 'compilationOutput', 'resolutionSnapshot', 'contentFingerprint',
        'resolutionFingerprint', 'validationContractVersion',
        'impactReasons', 'releaseNote', 'dependencies'
      )
    )
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_release)
    ) <> 9 then
    raise exception using
      errcode = '22023',
      message = 'Definition release append has an invalid request shape';
  end if;

  release_version_value := p_release ->> 'releaseVersion';
  compilation_output_value := p_release -> 'compilationOutput';
  resolution_snapshot_value := p_release -> 'resolutionSnapshot';
  content_fingerprint_value := p_release ->> 'contentFingerprint';
  resolution_fingerprint_value := p_release ->> 'resolutionFingerprint';
  validation_contract_version_value := p_release ->> 'validationContractVersion';
  impact_reasons_value := p_release -> 'impactReasons';
  release_note_value := p_release ->> 'releaseNote';
  dependency_manifest_value := p_release -> 'dependencies';

  if release_version_value !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or pg_catalog.jsonb_typeof(compilation_output_value) is distinct from 'object'
    or pg_catalog.jsonb_typeof(resolution_snapshot_value) is distinct from 'object'
    or content_fingerprint_value !~ '^sha256:[a-f0-9]{64}$'
    or resolution_fingerprint_value !~ '^sha256:[a-f0-9]{64}$'
    or validation_contract_version_value !~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
    or pg_catalog.jsonb_typeof(impact_reasons_value) is distinct from 'array'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(impact_reasons_value) as reason(value)
      where pg_catalog.jsonb_typeof(reason.value) is distinct from 'object'
    )
    or release_note_value is null
    or release_note_value <> pg_catalog.btrim(release_note_value)
    or pg_catalog.char_length(release_note_value) not between 1 and 2000
    or pg_catalog.jsonb_typeof(dependency_manifest_value) is distinct from 'array'
    or pg_catalog.jsonb_array_length(dependency_manifest_value) > 10000 then
    raise exception using
      errcode = '22023',
      message = 'Definition release append has invalid release evidence';
  end if;

  select root.* into root_row
  from vortex_definition.roots as root
  where root.root_id = p_root_id
  for update;

  if not found then
    return;
  end if;

  select draft.* into draft_row
  from vortex_definition.drafts as draft
  where draft.root_id = p_root_id
  for update;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'A Definition root requires its current draft';
  end if;

  if root_row.organization_id <> context_organization_id then
    raise exception using
      errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  -- A Module release is internal to its owning Application's publication: a person publishes
  -- only an ordinary Application, and the Modules an ordinary Application owns.
  if human_publication and (root_row.kind not in ('application', 'module')
    or (root_row.kind = 'application'
      and root_row.application_origin_kind is distinct from 'ordinary')
    or (root_row.kind = 'module' and not exists (
      select 1
      from vortex_definition.roots as owner_root
      where owner_root.root_id = root_row.owner_application_root_id
        and owner_root.organization_id = root_row.organization_id
        and owner_root.kind = 'application'
        and owner_root.application_origin_kind = 'ordinary'
    ))) then
    raise exception using errcode = '42501',
      message = 'Definition publication authority is unavailable';
  end if;

  if compilation_output_value ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'key' is distinct from root_row.key
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'rootId' is distinct from p_root_id::text
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'organizationId'
      is distinct from root_row.organization_id::text then
    raise exception using
      errcode = '23514',
      message = 'Definition canonical release content does not belong to the locked root';
  end if;

  if compilation_output_value ->> 'resolutionFingerprint' is distinct from resolution_fingerprint_value
    or compilation_output_value -> 'artifact' ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'artifact' ->> 'rootId' is distinct from p_root_id::text
    or compilation_output_value -> 'artifact' ->> 'definitionKey' is distinct from root_row.key
    or compilation_output_value -> 'artifact' ->> 'exactVersion' is distinct from release_version_value
    or compilation_output_value -> 'artifact' ->> 'contentFingerprint'
      is distinct from content_fingerprint_value
    or compilation_output_value -> 'artifact' ->> 'resolutionFingerprint'
      is distinct from resolution_fingerprint_value then
    raise exception using
      errcode = '23514',
      message = 'Definition compilation output does not match immutable release evidence';
  end if;

  if resolution_snapshot_value ->> 'fingerprint' is distinct from resolution_fingerprint_value
    or pg_catalog.jsonb_typeof(resolution_snapshot_value -> 'definitions') is distinct from 'array'
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(resolution_snapshot_value -> 'definitions') as definition(value)
      where definition.value ->> 'kind' = root_row.kind
        and definition.value ->> 'key' = root_row.key
        and definition.value ->> 'rootId' = p_root_id::text
        and definition.value ->> 'exactVersion' = release_version_value
    ) then
    raise exception using
      errcode = '23514',
      message = 'Definition resolution snapshot does not match release evidence';
  end if;

  if draft_row.draft_revision <> p_expected_draft_revision
    or draft_row.source_fingerprint <> p_expected_source_fingerprint then
    raise exception using
      errcode = '40001',
      message = 'Definition release append is stale or source evidence was substituted';
  end if;

  expected_history_revision := root_row.current_release_revision;
  if expected_history_revision is null then
    if exists (select 1 from vortex_definition.releases as release where release.root_id = p_root_id) then
      raise exception using errcode = '23514', message = 'Definition root current release pointer does not match immutable release history';
    end if;
  elsif not exists (
    select 1 from vortex_definition.releases as release
    where release.root_id = p_root_id and release.release_revision = expected_history_revision
  ) or exists (
    select 1 from vortex_definition.releases as release
    where release.root_id = p_root_id and release.release_revision > expected_history_revision
  ) then
    raise exception using errcode = '23514', message = 'Definition root current release pointer does not match immutable release history';
  end if;

  if root_row.current_release_revision is distinct from expected_history_revision then
    raise exception using
      errcode = '23514',
      message = 'Definition root current release pointer does not match immutable release history';
  end if;


  if exists (
    select 1
    from vortex_definition.releases as release
    where release.root_id = p_root_id
      and release.release_revision = draft_row.draft_revision
  ) then
    raise exception using
      errcode = '23505',
      message = 'Definition draft revision is already published';
  end if;

  for supplied_dependency in
    select item.value
    from pg_catalog.jsonb_array_elements(dependency_manifest_value) as item(value)
  loop
    dependency_count := dependency_count + 1;
    if pg_catalog.jsonb_typeof(supplied_dependency) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Definition dependency has an invalid shape';
    end if;

    supplied_kind := supplied_dependency ->> 'kind';
    if supplied_kind = 'module' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'key', 'rootId', 'releaseRevision', 'releaseVersion',
          'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 6 then
        raise exception using errcode = '22023', message = 'Module dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'key';
      supplied_target_root_id := (supplied_dependency ->> 'rootId')::uuid;
      supplied_target_release_revision := (supplied_dependency ->> 'releaseRevision')::bigint;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_catalogue_item_id := null;
      if supplied_reference !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
        or pg_catalog.char_length(supplied_reference) not between 3 and 120
        or supplied_target_root_id is null
        or supplied_target_root_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_target_release_revision not between 1 and 9007199254740991
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or supplied_target_root_id = p_root_id
        or not exists (
          select 1
          from vortex_definition.releases as target_release
          join vortex_definition.roots as target_root on target_root.root_id = target_release.root_id
          where target_release.root_id = supplied_target_root_id
            and target_release.release_revision = supplied_target_release_revision
            and target_release.release_version = supplied_version
            and target_release.content_fingerprint = supplied_content_fingerprint
            and target_root.organization_id = context_organization_id
            and target_root.kind = 'module'
            and target_root.key = supplied_reference
        ) then
        raise exception using errcode = '23514', message = 'Module dependency does not identify an exact same-organization module release';
      end if;
    elsif supplied_kind = 'connection_type' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'key', 'rootId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 5 then
        raise exception using errcode = '22023', message = 'Connection type dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'key';
      supplied_catalogue_item_id := (supplied_dependency ->> 'rootId')::uuid;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      if supplied_reference !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
        or pg_catalog.char_length(supplied_reference) not between 3 and 120
        or supplied_catalogue_item_id is null
        or supplied_catalogue_item_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Connection type dependency has invalid evidence';
      end if;
    elsif supplied_kind = 'platform_block' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'blockId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 4 then
        raise exception using errcode = '22023', message = 'Platform block dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'blockId';
      supplied_catalogue_item_id := case
        when supplied_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then supplied_reference::uuid
        else null
      end;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      if supplied_catalogue_item_id is null
        or supplied_catalogue_item_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Platform block dependency has invalid evidence';
      end if;
    elsif supplied_kind = 'platform_theme' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'catalogueThemeId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 4 then
        raise exception using errcode = '22023', message = 'Platform theme dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'catalogueThemeId';
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      supplied_catalogue_item_id := null;
      if supplied_reference !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or supplied_reference = '00000000-0000-0000-0000-000000000000'
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Platform theme dependency has invalid evidence';
      end if;
    elsif supplied_kind in (
      'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'application_form', 'application_workflow', 'application_action',
      'protected_operation'
    ) then
      -- Flow targets are contained by, or pinned for, one exact Application
      -- release. Each entry has exactly its contract shape, and its owner is
      -- this release, an exact pinned Module release in this same manifest, or
      -- a protected platform service operation verified before append.
      if root_row.kind is distinct from 'application' then
        raise exception using errcode = '23514',
          message = 'Flow target dependencies belong only to an Application release';
      end if;
      supplied_owner_kind := case supplied_kind
        when 'protected_operation' then supplied_dependency #>> '{operation,owner,kind}'
        when 'module_query' then 'module'
        else 'application'
      end;
      supplied_expected_keys := pg_catalog.array_cat(
        array['kind', 'releaseVersion', 'contentFingerprint']::text[],
        case supplied_kind
          when 'application_flow' then
            array['applicationRootId', 'flowId', 'resolutionFingerprint']::text[]
          when 'application_flow_node' then
            array[
              'applicationRootId', 'flowId', 'nodeId', 'operations', 'grantable',
              'resolutionFingerprint'
            ]::text[]
          when 'application_query' then
            array['applicationRootId', 'queryId', 'resolutionFingerprint']::text[]
          when 'module_query' then
            array['moduleRootId', 'queryId', 'declaredRequirement', 'resolutionFingerprint']::text[]
          when 'application_form' then
            array['applicationRootId', 'formId', 'resolutionFingerprint']::text[]
          when 'application_workflow' then
            array['applicationRootId', 'workflowId', 'resolutionFingerprint']::text[]
          when 'application_action' then
            array['applicationRootId', 'actionId', 'resolutionFingerprint']::text[]
          when 'protected_operation' then array['operation', 'resolutionFingerprint']::text[]
        end
      );
      if exists (
          select 1
          from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
          where supplied.key <> all (supplied_expected_keys)
        )
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency))
          <> pg_catalog.cardinality(supplied_expected_keys)
        or exists (
          select 1
          from pg_catalog.unnest(supplied_expected_keys) as expected(key)
          where expected.key not in (
            'operation', 'declaredRequirement', 'operations', 'grantable'
          )
            and pg_catalog.jsonb_typeof(supplied_dependency -> expected.key) is distinct from 'string'
        )
        or (
          supplied_kind = 'module_query'
          and pg_catalog.jsonb_typeof(supplied_dependency -> 'declaredRequirement')
            is distinct from 'object'
        )
        or (
          supplied_kind = 'protected_operation'
          and (
            pg_catalog.jsonb_typeof(supplied_dependency -> 'operation') is distinct from 'object'
            or pg_catalog.jsonb_typeof(supplied_dependency #> '{operation,owner}')
              is distinct from 'object'
            or supplied_owner_kind is null
            or supplied_owner_kind not in ('application', 'module', 'platform_service')
          )
        )
        or (
          supplied_kind = 'application_flow_node'
          and (
            pg_catalog.jsonb_typeof(supplied_dependency -> 'operations') is distinct from 'array'
            or pg_catalog.jsonb_typeof(supplied_dependency -> 'grantable') is distinct from 'boolean'
          )
        ) then
        raise exception using errcode = '22023',
          message = 'Definition flow target dependency has an invalid shape';
      end if;
      if supplied_kind = 'protected_operation' then
        supplied_owner_id_key := case supplied_owner_kind
          when 'application' then 'applicationRootId'
          when 'module' then 'moduleRootId'
          else 'serviceId'
        end;
        if exists (
            select 1
            from pg_catalog.jsonb_object_keys(supplied_dependency -> 'operation') as operation_key(key)
            where operation_key.key not in ('owner', 'operationId')
          )
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency -> 'operation')) <> 2
          or pg_catalog.jsonb_typeof(supplied_dependency #> '{operation,operationId}')
            is distinct from 'string'
          or exists (
            select 1
            from pg_catalog.jsonb_object_keys(supplied_dependency #> '{operation,owner}') as owner_key(key)
            where owner_key.key not in ('kind', supplied_owner_id_key)
          )
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency #> '{operation,owner}')) <> 2
          or pg_catalog.jsonb_typeof(
            supplied_dependency -> 'operation' -> 'owner' -> supplied_owner_id_key
          ) is distinct from 'string' then
          raise exception using errcode = '22023',
            message = 'Definition flow target dependency has an invalid shape';
        end if;
      end if;

      if supplied_kind = 'application_flow_node' then
        if (supplied_dependency ->> 'grantable')::boolean is distinct from
            (pg_catalog.jsonb_array_length(supplied_dependency -> 'operations') > 0) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation references have an invalid grantability shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          where pg_catalog.jsonb_typeof(operation.value) is distinct from 'object'
            or pg_catalog.jsonb_typeof(operation.value -> 'owner') is distinct from 'object'
            or pg_catalog.jsonb_typeof(operation.value -> 'operationId') is distinct from 'string'
            or pg_catalog.jsonb_typeof(operation.value #> '{owner,kind}') is distinct from 'string'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          where (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(operation.value)) <> 2
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(operation.value) as operation_key(key)
              where operation_key.key not in ('owner', 'operationId')
            )
            or operation.value #>> '{owner,kind}' not in ('application', 'module')
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(operation.value -> 'owner')) <> 2
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(operation.value -> 'owner') as owner_key(key)
              where owner_key.key not in (
                'kind',
                case operation.value #>> '{owner,kind}'
                  when 'application' then 'applicationRootId'
                  else 'moduleRootId'
                end
              )
            )
            or pg_catalog.jsonb_typeof(
              operation.value -> 'owner' -> case operation.value #>> '{owner,kind}'
                when 'application' then 'applicationRootId'
                else 'moduleRootId'
              end
            ) is distinct from 'string'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid owner shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          cross join lateral (
            select case operation.value #>> '{owner,kind}'
              when 'application' then operation.value #>> '{owner,applicationRootId}'
              else operation.value #>> '{owner,moduleRootId}'
            end as owner_id
          ) as owner
          where owner.owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or owner.owner_id = '00000000-0000-0000-0000-000000000000'
            or (operation.value ->> 'operationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or operation.value ->> 'operationId' = '00000000-0000-0000-0000-000000000000'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid identifier';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          cross join lateral (
            select case operation.value #>> '{owner,kind}'
              when 'application' then operation.value #>> '{owner,applicationRootId}'
              else operation.value #>> '{owner,moduleRootId}'
            end as owner_id
          ) as owner
          where (
              operation.value #>> '{owner,kind}' = 'application'
              and owner.owner_id is distinct from p_root_id::text
            )
            or (
              operation.value #>> '{owner,kind}' = 'module'
              and not exists (
                select 1
                from pg_catalog.jsonb_array_elements(dependency_manifest_value) as pinned(value)
                where pinned.value ->> 'kind' = 'module'
                  and pg_catalog.lower(pinned.value ->> 'rootId') = owner.owner_id
              )
            )
        ) then
          raise exception using errcode = '23514',
            message = 'Definition flow node operation reference does not belong to this release or a pinned Module';
        end if;

        if exists (
          select 1
          from (
            select
              pg_catalog.lag(ordered.reference_key) over (order by ordered.ordinality) as previous_reference_key,
              ordered.reference_key
            from (
              select
                operation.ordinality,
                (operation.value #>> '{owner,kind}') || ':' ||
                  case operation.value #>> '{owner,kind}'
                    when 'application' then operation.value #>> '{owner,applicationRootId}'
                    else operation.value #>> '{owner,moduleRootId}'
                  end || ':' || (operation.value ->> 'operationId') as reference_key
              from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations')
                with ordinality as operation(value, ordinality)
            ) as ordered
          ) as adjacent
          where adjacent.previous_reference_key is not null
            and adjacent.previous_reference_key collate "C" >= adjacent.reference_key collate "C"
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation references must be unique and canonically sorted';
        end if;
      end if;

      supplied_reference := vortex_definition.flow_target_dependency_reference(supplied_dependency);
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      supplied_catalogue_item_id := null;
      if supplied_reference is null
        or pg_catalog.char_length(supplied_reference) not between 1 and 500
        or supplied_reference ~ '[[:space:]]'
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or (
          supplied_dependency ? 'resolutionFingerprint'
          and supplied_dependency ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        ) then
        raise exception using errcode = '22023',
          message = 'Definition flow target dependency has invalid evidence';
      end if;

      if (
          supplied_owner_kind = 'application'
          and (
            case when supplied_kind = 'protected_operation'
              then supplied_dependency #>> '{operation,owner,applicationRootId}'
              else supplied_dependency ->> 'applicationRootId'
            end is distinct from p_root_id::text
            or supplied_version is distinct from release_version_value
            or supplied_dependency ->> 'resolutionFingerprint'
              is distinct from resolution_fingerprint_value
          )
        )
        or (
          supplied_owner_kind = 'module'
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(dependency_manifest_value) as pinned(value)
            where pinned.value ->> 'kind' = 'module'
              and pinned.value ->> 'rootId' = case when supplied_kind = 'protected_operation'
                then supplied_dependency #>> '{operation,owner,moduleRootId}'
                else supplied_dependency ->> 'moduleRootId'
              end
              and pinned.value ->> 'releaseVersion' = supplied_version
              and pinned.value ->> 'resolutionFingerprint' =
                supplied_dependency ->> 'resolutionFingerprint'
          )
        ) then
        raise exception using errcode = '23514',
          message = 'Flow target dependency does not identify this release or an exact pinned module release';
      end if;
    else
      raise exception using errcode = '22023', message = 'Definition dependency has an unknown kind';
    end if;

    if exists (
      select 1
      from vortex_definition.release_dependencies as existing
      where existing.root_id = p_root_id
        and existing.release_revision = draft_row.draft_revision
        and existing.dependency_kind = supplied_kind
        and existing.dependency_reference = supplied_reference
        and (
          supplied_kind <> 'platform_block'
          or existing.dependency_version = supplied_version
        )
    ) then
      raise exception using errcode = '23505', message = 'Definition dependency manifest repeats a subject';
    end if;
  end loop;

  if exists (
    select 1
    from (
      select
        supplied.value ->> 'kind' as dependency_kind,
        case supplied.value ->> 'kind'
          when 'platform_theme' then supplied.value ->> 'catalogueThemeId'
          when 'platform_block' then
            (supplied.value ->> 'blockId') || '@' || (supplied.value ->> 'releaseVersion')
          when 'module' then supplied.value ->> 'key'
          when 'connection_type' then supplied.value ->> 'key'
          else vortex_definition.flow_target_dependency_reference(supplied.value)
        end as dependency_reference,
        pg_catalog.count(*) as duplicate_count
      from pg_catalog.jsonb_array_elements(dependency_manifest_value) as supplied(value)
      group by 1, 2
    ) as grouped
    where grouped.dependency_reference is null or grouped.duplicate_count <> 1
  ) then
    raise exception using errcode = '22023', message = 'Definition dependency manifest repeats or omits a subject';
  end if;

  -- An Application release is written last in its publication. It pins every inline Module it
  -- owns at that Module's current release, appended earlier in the same publication when it
  -- changed, and every Module it uses at the release its owning Application's current release
  -- pins, so one Application's publication never moves another's.
  if root_row.kind = 'application' and (
    exists (
      select 1
      from pg_catalog.jsonb_array_elements(dependency_manifest_value) as dependency(value)
      join vortex_definition.roots as target_root
        on target_root.root_id = (dependency.value ->> 'rootId')::uuid
      where dependency.value ->> 'kind' = 'module'
        and case
          when target_root.owner_application_root_id = p_root_id then
            target_root.current_release_revision
              is distinct from (dependency.value ->> 'releaseRevision')::bigint
          else not exists (
            select 1
            from vortex_definition.roots as owner_root
            join vortex_definition.release_dependencies as pin
              on pin.root_id = owner_root.root_id
              and pin.release_revision = owner_root.current_release_revision
            where owner_root.root_id = target_root.owner_application_root_id
              and pin.dependency_kind = 'module'
              and pin.target_root_id = target_root.root_id
              and pin.target_release_revision = (dependency.value ->> 'releaseRevision')::bigint
          )
        end
    )
    or exists (
      select 1
      from vortex_definition.roots as owned_root
      join pg_catalog.jsonb_array_elements(
        coalesce(draft_row.draft_source #> '{body,modules}', '[]'::jsonb)
      ) as inline_module(value) on inline_module.value ->> 'key' = owned_root.key
      where owned_root.owner_application_root_id = p_root_id
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(dependency_manifest_value) as dependency(value)
          where dependency.value ->> 'kind' = 'module'
            and (dependency.value ->> 'rootId')::uuid = owned_root.root_id
        )
    )
  ) then
    raise exception using errcode = '23514',
      message = 'An Application release must pin its own Modules at their current release and used Modules at their owner''s current pin';
  end if;

  -- Field policy is an immutable part of a newly published permission. Validate
  -- it at the one supported release-write boundary so trusted callers cannot
  -- store a release the compiler would refuse. Existing releases are untouched.
  if root_row.kind in ('module', 'application') then
    permissions_value := coalesce(
      compilation_output_value #> '{canonical,content,permissions}',
      '[]'::jsonb
    );

    if pg_catalog.jsonb_typeof(permissions_value) is distinct from 'array' then
      raise exception using
        errcode = '23514',
        message = 'Definition release permissions are unavailable for field-policy validation';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
      where (
        permission.value ->> 'recordTypeId' is null
        and permission.value ? 'fieldPolicy'
      ) or (
        permission.value ->> 'recordTypeId' is not null
        and (
          not permission.value ? 'fieldPolicy'
          or not vortex_access.permission_field_policy_is_valid(
            permission.value -> 'fieldPolicy'
          )
        )
      )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Definition release field policy has invalid record ownership or shape';
    end if;

    if exists (
      with module_record_types as (
        select record_type.value
        from pg_catalog.jsonb_array_elements(
          case
            when root_row.kind = 'module'
              and pg_catalog.jsonb_typeof(
                compilation_output_value #> '{canonical,content,recordTypes}'
              ) = 'array'
            then compilation_output_value #> '{canonical,content,recordTypes}'
            else '[]'::jsonb
          end
        ) as record_type(value)
      ), pinned_module_record_types as (
        select record_type.value
        from pg_catalog.jsonb_array_elements(dependency_manifest_value) as dependency(value)
        join vortex_definition.releases as module_release
          on module_release.root_id = (dependency.value ->> 'rootId')::uuid
          and module_release.release_revision =
            (dependency.value ->> 'releaseRevision')::bigint
        cross join lateral pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(
              module_release.compilation_output #> '{canonical,content,recordTypes}'
            ) = 'array'
            then module_release.compilation_output #> '{canonical,content,recordTypes}'
            else '[]'::jsonb
          end
        ) as record_type(value)
        where root_row.kind = 'application'
          and dependency.value ->> 'kind' = 'module'
      ), available_record_types as (
        select value from module_record_types
        union all
        select value from pinned_module_record_types
      ), available_record_type_counts as (
        select
          pg_catalog.lower(record_type.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.count(*) as record_type_count
        from available_record_types as record_type(value)
        group by pg_catalog.lower(record_type.value ->> 'recordTypeId')
      ), available_fields as (
        select
          pg_catalog.lower(record_type.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.lower(field.value ->> 'fieldId') as field_id
        from available_record_types as record_type(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(record_type.value -> 'fields') = 'array'
            then record_type.value -> 'fields'
            else '[]'::jsonb
          end
        ) as field(value)
      ), policy_fields as (
        select
          pg_catalog.lower(permission.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.lower(field.value) as field_id
        from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
        cross join lateral pg_catalog.jsonb_array_elements_text(
          (permission.value #> '{fieldPolicy,readableFieldIds}')
          || (permission.value #> '{fieldPolicy,changeableFieldIds}')
        ) as field(value)
        where permission.value ->> 'recordTypeId' is not null
      )
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
      left join available_record_type_counts as record_type_count
        on record_type_count.record_type_id =
          pg_catalog.lower(permission.value ->> 'recordTypeId')
      where permission.value ->> 'recordTypeId' is not null
        and (
          record_type_count.record_type_count is distinct from 1
          or exists (
            select 1
            from policy_fields as policy_field
            where policy_field.record_type_id =
                pg_catalog.lower(permission.value ->> 'recordTypeId')
              and not exists (
                select 1
                from available_fields as available_field
                where available_field.record_type_id = policy_field.record_type_id
                  and available_field.field_id = policy_field.field_id
              )
          )
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Definition release field policy names a field outside its exact record type';
    end if;
  end if;

  if root_row.kind = 'application' then
    if pg_catalog.jsonb_typeof(compilation_output_value #> '{canonical,content,pages}')
        is distinct from 'array'
      or pg_catalog.jsonb_typeof(compilation_output_value #> '{canonical,content,roles}')
        is distinct from 'array' then
      raise exception using errcode = 'XX001',
        message = 'Published Application address metadata is malformed';
    end if;
    application_address_value := pg_catalog.jsonb_build_object(
      'kind', compilation_output_value -> 'kind',
      'name', compilation_output_value #> '{canonical,content,name}',
      'icon', compilation_output_value #> '{canonical,content,icon}',
      'homePageId', compilation_output_value #> '{canonical,content,homePageId}',
      'pages', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'pageId', page.value -> 'pageId',
            'key', page.value -> 'key',
            'accessPermissionKey', page.value -> 'accessPermissionKey'
          ) order by page.ordinality
        )
        from pg_catalog.jsonb_array_elements(
          compilation_output_value #> '{canonical,content,pages}'
        ) with ordinality as page(value, ordinality)
      ), '[]'::jsonb),
      'roles', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'roleId', role.value -> 'roleId',
            'key', role.value -> 'key',
            'homePageId', role.value -> 'homePageId'
          ) order by role.ordinality
        )
        from pg_catalog.jsonb_array_elements(
          compilation_output_value #> '{canonical,content,roles}'
        ) with ordinality as role(value, ordinality)
      ), '[]'::jsonb)
    );
    application_experience_value := pg_catalog.jsonb_build_object(
      'experiences', coalesce(
        compilation_output_value #> '{canonical,content,experiences}', '[]'::jsonb
      ),
      'resolvedExperiences', case
        when pg_catalog.jsonb_typeof(
          compilation_output_value #> '{canonical,content,experiences}'
        ) = 'array' then coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'state', experience.value ->> 'state', 'page', page.value
            ) order by experience.value ->> 'state' collate "C"
          )
          from pg_catalog.jsonb_array_elements(
            compilation_output_value #> '{canonical,content,experiences}'
          ) as experience(value)
          join pg_catalog.jsonb_array_elements(
            compilation_output_value #> '{canonical,content,pages}'
          ) as page(value)
            on page.value ->> 'pageId' = experience.value ->> 'pageId'
        ), '[]'::jsonb)
        else '[]'::jsonb
      end,
      'shells', compilation_output_value #> '{canonical,content,shells}',
      'theme', compilation_output_value #> '{canonical,content,theme}'
    );
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(item.key, item.value), '{}'::jsonb)
  into record_content_value
  from pg_catalog.jsonb_each(
    compilation_output_value #> '{canonical,content}'
  ) as item(key, value)
  where item.key in ('recordTypes', 'permissions', 'rules', 'actions', 'events');

  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output, resolution_snapshot,
    content_fingerprint, resolution_fingerprint, validation_contract_version,
    impact_reasons, release_note, published_at, published_by,
    application_address, application_experience, record_content
  ) values (
    p_root_id, draft_row.draft_revision, release_version_value, draft_row.draft_source,
    draft_row.source_fingerprint, draft_row.source_contract_version, compilation_output_value,
    resolution_snapshot_value,
    content_fingerprint_value, resolution_fingerprint_value, validation_contract_version_value,
    impact_reasons_value, release_note_value, operation_at,
    context_actor_id, application_address_value, application_experience_value,
    record_content_value
  );

  for supplied_dependency in
    select item.value
    from pg_catalog.jsonb_array_elements(dependency_manifest_value) as item(value)
  loop
    supplied_kind := supplied_dependency ->> 'kind';
    supplied_reference := case supplied_kind
      when 'platform_theme' then supplied_dependency ->> 'catalogueThemeId'
      when 'platform_block' then supplied_dependency ->> 'blockId'
      else supplied_dependency ->> 'key'
    end;
    supplied_version := supplied_dependency ->> 'releaseVersion';
    supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
    supplied_target_root_id := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'rootId')::uuid else null end;
    supplied_target_release_revision := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'releaseRevision')::bigint else null end;
    supplied_catalogue_item_id := case supplied_kind
      when 'connection_type' then (supplied_dependency ->> 'rootId')::uuid
      when 'platform_block' then (supplied_dependency ->> 'blockId')::uuid
      else null
    end;
    supplied_entry := null;
    if supplied_kind in (
      'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'application_form', 'application_workflow', 'application_action',
      'protected_operation'
    ) then
      supplied_entry := supplied_dependency;
      supplied_reference := vortex_definition.flow_target_dependency_reference(supplied_dependency);
    end if;

    insert into vortex_definition.release_dependencies (
      root_id, release_revision, dependency_kind, dependency_reference,
      dependency_version, dependency_content_fingerprint,
      target_root_id, target_release_revision, catalogue_item_id, dependency_entry
    ) values (
      p_root_id, draft_row.draft_revision, supplied_kind, supplied_reference,
      supplied_version, supplied_content_fingerprint,
      supplied_target_root_id, supplied_target_release_revision, supplied_catalogue_item_id,
      supplied_entry
    );
    inserted_dependency_count := inserted_dependency_count + 1;
  end loop;

  if inserted_dependency_count <> dependency_count then
    raise exception using errcode = '23514', message = 'Definition dependency manifest was not stored one-for-one';
  end if;

  perform 1
  from vortex_definition.reachable_module_dependency_edges(
    p_root_id, draft_row.draft_revision
  );

  update vortex_definition.roots as root
  set current_release_revision = draft_row.draft_revision
  where root.root_id = p_root_id
    and root.current_release_revision is not distinct from expected_history_revision;

  if not found then
    raise exception using errcode = '40001', message = 'Definition current release pointer changed during publication';
  end if;

  if human_publication then
    checked_context := vortex_access.validated_human_request_context();
    if checked_context is distinct from original_context then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  if human_publication then
    foreach permission_key in array array[
      'platform.organization.definition_drafts.manage',
      'platform.organization.definition_releases.manage'
    ] loop
      permission_id := case permission_key
        when 'platform.organization.definition_drafts.manage'
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
          then '0548c061-b1a9-48e5-a04a-eb1d0dae0644'::uuid
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        else 'dfdd5aba-2b85-4169-b570-92be284e7b5c'::uuid
      end;
      select evaluated.* into strict permission_decision
      from vortex_access.evaluate_organization_permission_eligibility(
        pg_catalog.jsonb_build_object(
          'operationKey', permission_key,
          'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
          'target', pg_catalog.jsonb_build_object('kind', 'organization'),
          'requiredPermission', pg_catalog.jsonb_build_object(
            -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
            'ownerKind', 'platform', 'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
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
        or permission_decision.reason_code is not null
        or permission_decision.organization_id
          is distinct from (checked_context ->> 'organizationId')::uuid
        or permission_decision.organization_account_id
          is distinct from (checked_context ->> 'organizationAccountId')::uuid
        or permission_decision.access_version is distinct from locked_access_version
        or permission_decision.correlation_id
          is distinct from (checked_context ->> 'correlationId')::uuid
        or permission_decision.checked_at is null or permission_decision.checked_at > checked_at
        or permission_decision.valid_until is null or permission_decision.valid_until <= checked_at
        or (checked_context ->> 'issuedAt')::timestamptz > checked_at
        or (checked_context ->> 'expiresAt')::timestamptz <= checked_at then
        raise exception using errcode = '42501',
          message = 'Definition publication authority is unavailable';
      end if;
      permission_deadline := least(permission_deadline, permission_decision.valid_until);
    end loop;
    if permission_deadline <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  return query
  select
    release.root_id,
    release.release_revision,
    release.release_version,
    release.content_fingerprint,
    release.resolution_fingerprint,
    coalesce((
      select pg_catalog.jsonb_agg(
        case dependency.dependency_kind
          when 'module' then pg_catalog.jsonb_build_object(
            'kind', 'module', 'key', dependency.dependency_reference,
            'rootId', dependency.target_root_id,
            'releaseRevision', dependency.target_release_revision,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type', 'key', dependency.dependency_reference,
            'rootId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_block' then pg_catalog.jsonb_build_object(
            'kind', 'platform_block',
            'blockId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', 'platform_theme', 'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          else dependency.dependency_entry
        end order by
          dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C",
          dependency.dependency_version collate "C"
      )
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
    ), '[]'::jsonb),
    release.published_at,
    release.published_by
  from vortex_definition.releases as release
  where release.root_id = p_root_id
    and release.release_revision = draft_row.draft_revision;
end
$function$;

revoke execute on function vortex_definition.append_release(uuid, bigint, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.append_release(uuid, bigint, text, jsonb)
  to vortex_request;
comment on function vortex_definition.append_release(uuid, bigint, text, jsonb) is
  'Atomically validates and records one compiled Definition release with exact field-policy ownership, pinned dependencies and canonical flow operations; retains System publication and permits ordinary human Application and Module publication only under locked current draft/release permissions and original account attribution, then advances only its root pointer.';

alter function vortex_definition.append_release(p_root_id uuid, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_release jsonb) owner to vortex_owner;

grant execute on function vortex_definition.append_release(p_root_id uuid, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_release jsonb) to postgres;

-- vortex_definition/validated_builder_draft_write_context_internal.sql
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

  -- A shared lock pins the authority checked below until commit; the root lock orders writes.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = (checked_context ->> 'organizationId')::uuid
  for share;
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
    -- Only an Application is drafted: a Module is edited inside its owning Application.
    if not found or root_kind is distinct from 'application'
      or origin_kind is null
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
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        then '0548c061-b1a9-48e5-a04a-eb1d0dae0644'::uuid
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
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
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
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

  -- The caller can enforce this captured deadline after its writes without repeating permission
  -- evaluation. Access-version and root locks prevent the underlying grants from changing.
  return checked_context || pg_catalog.jsonb_build_object(
    'draftWriteDeadline', permission_deadline
  );
end
$function$;
alter function vortex_definition.validated_builder_draft_write_context_internal(uuid) owner to vortex_owner;


revoke all on function vortex_definition.validated_builder_draft_write_context_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.validated_builder_draft_write_context_internal(uuid)
  to postgres;

comment on function vortex_definition.validated_builder_draft_write_context_internal(uuid) is
  'Private live human Application draft guard for the existing create/save function owner; locks Access and classified roots and rechecks exact current permissions and deadlines.';

alter function vortex_definition.validated_builder_draft_write_context_internal(uuid)
  owner to vortex_owner;

-- vortex_access/change_organization_settings_record_internal.sql
create or replace function vortex_access.change_organization_settings_record_internal(
  p_record_id uuid,
  p_expected_revision bigint,
  p_core_values jsonb,
  p_extension_values jsonb
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
  context_correlation_id uuid;
  saved record;
  default_application_root_id_value uuid;
  failure_sqlstate text;
  failure_message text;
begin
  if p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_core_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_extension_values) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'invalid_request');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Organization settings record save requires an Application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  if p_record_id is distinct from context_organization_id then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'organization_mismatch');
  end if;

  perform 1
  from vortex_access.organization_access_versions as access_version
  where access_version.organization_id = context_organization_id
  for share;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'organization_access_missing');
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  if not vortex_access.organization_runtime_settings_manage_is_current() then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'settings_permission_unavailable');
  end if;

  if p_core_values ? 'default_application_root_id'
    and pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') <> 'null' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') <> 'string'
      or not pg_catalog.pg_input_is_valid(
        p_core_values ->> 'default_application_root_id', 'uuid'
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'default_application_unavailable');
    end if;
    default_application_root_id_value :=
      (p_core_values ->> 'default_application_root_id')::uuid;
    if default_application_root_id_value = '00000000-0000-0000-0000-000000000000'::uuid
      or not exists (
        select 1
        from vortex_access.permission_registrations as registration
        join vortex_definition.roots as root
          on root.root_id = registration.registration_owner_id
          and root.organization_id = registration.organization_id
          and root.kind = 'application'
          and root.key = registration.source_definition_key
        where registration.organization_id = context_organization_id
          and registration.registration_kind = 'application'
          and registration.registration_owner_id = default_application_root_id_value
          and registration.state = 'active'
          and exists (
            select 1
            from vortex_definition.releases as release
            where release.root_id = root.root_id
              and release.release_revision = registration.source_revision
              and release.release_version = registration.source_version
              and release.validation_contract_version = registration.validation_contract_version
              and release.compilation_output ->> 'kind' = 'application'
          )
          and exists (
            select 1
            from vortex_definition.installation_bindings as binding
            where binding.organization_id = context_organization_id
              and binding.application_root_id = default_application_root_id_value
              and binding.application_release_revision = registration.source_revision
              and binding.state = 'active'
          )
      ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'default_application_unavailable'
      );
    end if;
  end if;

  select updated.* into strict saved
  from vortex_identity.save_organization_runtime_settings_record_internal(
    context_organization_id, p_expected_revision, p_core_values, p_extension_values
  ) as updated;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', saved.organization_id,
    'concurrencyNumber', saved.revision,
    'correlationId', context_correlation_id
  );
exception
  when serialization_failure or deadlock_detected then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings persistence conflicted: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'persistence_conflict_' || failure_sqlstate
    );
  when no_data_found or too_many_rows or insufficient_privilege or check_violation
    or object_not_in_prerequisite_state or invalid_text_representation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings persistence refused: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'persistence_refused_' || failure_sqlstate
    );
end
$function$;

revoke all on function vortex_access.change_organization_settings_record_internal(
  uuid, bigint, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.change_organization_settings_record_internal(
  uuid, bigint, jsonb, jsonb
) to vortex_record_adapter;

comment on function vortex_access.change_organization_settings_record_internal(
  uuid, bigint, jsonb, jsonb
) is
  'Protected organisation settings record writer requiring runtime-settings.manage and an exact current revision; the request organisation supplies the singleton identity and extensions are merged with the invariant settings in one transaction.';

alter function vortex_access.change_organization_settings_record_internal(p_record_id uuid, p_expected_revision bigint, p_core_values jsonb, p_extension_values jsonb) owner to vortex_owner;

grant execute on function vortex_access.change_organization_settings_record_internal(p_record_id uuid, p_expected_revision bigint, p_core_values jsonb, p_extension_values jsonb) to postgres;

-- vortex_access/lock_application_installation_authority.sql
CREATE OR REPLACE FUNCTION vortex_access.lock_application_installation_authority() RETURNS TABLE(organization_id uuid, organization_account_id uuid, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
  permission_decision record;
  delegation_decision record;
  current_version bigint;
begin
  context_value := vortex_access.validated_human_request_context();

  select version.current_version into current_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = (context_value ->> 'organizationId')::uuid
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Application installation scope is unavailable';
  end if;
  if current_version <> (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Application installation authority changed';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Application installation authority is unavailable';
  end if;

  select evaluated.* into strict delegation_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
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
    raise exception using errcode = '42501',
      message = 'Application installation delegation is unavailable';
  end if;

  return query select permission_decision.organization_id,
    permission_decision.organization_account_id, permission_decision.access_version,
    permission_decision.correlation_id;
end
$$;

alter function vortex_access.lock_application_installation_authority() owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.lock_application_installation_authority() IS 'Access-owned lock and current authority decision for one protected Application installation lifecycle transaction.';

REVOKE ALL ON FUNCTION vortex_access.lock_application_installation_authority() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.lock_application_installation_authority() TO vortex_owner;

grant execute on function vortex_access.lock_application_installation_authority() to postgres;

-- vortex_access/lock_record_lifecycle_policy_authority.sql
CREATE OR REPLACE FUNCTION vortex_access.lock_record_lifecycle_policy_authority() RETURNS TABLE(organization_id uuid, organization_account_id uuid, access_version bigint, correlation_id uuid, application_root_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
  decision record;
  current_version bigint;
begin
  context_value := vortex_access.validated_human_request_context();

  select version.current_version into current_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = (context_value ->> 'organizationId')::uuid
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record lifecycle policy administration is unavailable';
  end if;
  if current_version <> (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Record lifecycle policy authority changed';
  end if;

  context_value := vortex_access.validated_human_request_context();

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.record_lifecycle.manage_policy',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.record_lifecycle.manage_policy'
    or decision.organization_id is distinct from (context_value ->> 'organizationId')::uuid
    or decision.organization_account_id is distinct from
      (context_value ->> 'organizationAccountId')::uuid
    or decision.access_version is distinct from (context_value ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (context_value ->> 'correlationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Record lifecycle policy administration is unavailable';
  end if;

  return query select decision.organization_id, decision.organization_account_id,
    decision.access_version, decision.correlation_id,
    case
      when context_value ? 'applicationRootId'
        then (context_value ->> 'applicationRootId')::uuid
      else null
    end;
end
$$;

alter function vortex_access.lock_record_lifecycle_policy_authority() owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.lock_record_lifecycle_policy_authority() IS 'Access-owned lock and current authority decision for one protected record-type lifecycle policy transaction.';

REVOKE ALL ON FUNCTION vortex_access.lock_record_lifecycle_policy_authority() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.lock_record_lifecycle_policy_authority() TO vortex_owner;

grant execute on function vortex_access.lock_record_lifecycle_policy_authority() to postgres;

-- vortex_access/update_own_profile.sql
create or replace function vortex_access.update_own_profile(
  p_organization_account_id uuid,
  p_expected_revision bigint,
  p_display_name text,
  p_language text,
  p_time_zone text,
  p_activity_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  organization_account_id uuid,
  account_summary jsonb,
  correlation_id uuid,
  accepted_at timestamptz,
  access_version bigint
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
  decision record;
  changed record;
  activity_result text;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_display_name is null
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization account profile command is invalid';
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
      message = 'Organization account profile update is unavailable';
  end if;

  if p_organization_account_id = context_account_id then
    -- The own-account path needs no permission, so it is only for the person themself: a
    -- delegated or support context acting for them is refused like any unavailable change.
    if context_value ? 'delegatedContext' or context_value ? 'supportContext' then
      raise exception using errcode = '42501',
        message = 'Organization account profile update is unavailable';
    end if;
  else
    select evaluated.* into strict decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.accounts.update_profile',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
          'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
          'permissionId', '630a980c-0ff5-40b1-a329-7326a2122395'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;

    if decision.outcome = 'refused'
      and decision.operation_key = 'platform.organization.accounts.update_profile'
      and decision.target_kind = 'organization'
      and decision.target_application_root_id is null
      and decision.organization_id = context_organization_id
      and decision.organization_account_id = context_account_id
      and decision.access_version = context_access_version
      and decision.correlation_id = context_correlation_id
      and decision.reason_code in (
        'permission_unavailable', 'permission_not_effective',
        'authentication_unsatisfied', 'delegation_insufficient'
      ) then
      activity_result := vortex_record.append_organization_activity_entry(
        context_organization_id, p_activity_id, decision.checked_at,
        'organization_account', context_account_id, 'update_organization_account_profile',
        array[p_organization_account_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
        context_correlation_id, 'refused'
      );
      if activity_result is distinct from 'inserted' then
        raise exception using errcode = '40001',
          message = 'Organization account profile refusal Activity is stale';
      end if;
      return query select 'refused'::text, 'update_own_profile'::text,
        context_organization_id, p_organization_account_id, null::jsonb,
        context_correlation_id, decision.checked_at, context_access_version;
      return;
    end if;

    if decision.outcome is distinct from 'eligible'
      or decision.operation_key is distinct from
        'platform.organization.accounts.update_profile'
      or decision.target_kind is distinct from 'organization'
      or decision.target_application_root_id is not null
      or decision.organization_id is distinct from context_organization_id
      or decision.organization_account_id is distinct from context_account_id
      or decision.access_version is distinct from context_access_version
      or decision.correlation_id is distinct from context_correlation_id then
      raise exception using errcode = '42501',
        message = 'Organization account profile update is unavailable';
    end if;
  end if;

  select updated.* into strict changed
  from vortex_identity.update_organization_account_profile_internal(
    context_organization_id, p_organization_account_id, p_expected_revision,
    p_display_name, p_language, p_time_zone
  ) as updated;
  if changed.organization_id is distinct from context_organization_id
    or changed.organization_account_id is distinct from p_organization_account_id
    or changed.revision is distinct from p_expected_revision + 1 then
    raise exception using errcode = '42501',
      message = 'Organization account profile result is unavailable';
  end if;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'update_organization_account_profile',
    array[p_organization_account_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization account profile Activity is stale';
  end if;

  return query select 'accepted'::text, 'update_own_profile'::text,
    context_organization_id, p_organization_account_id,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'organizationAccountId', changed.organization_account_id,
      'displayName', changed.display_name,
      'state', changed.state,
      'language', changed.language,
      'timeZone', changed.time_zone,
      'revision', changed.revision
    )),
    context_correlation_id, changed.changed_at, context_access_version;
end
$function$;

revoke all on function vortex_access.update_own_profile(
  uuid, bigint, text, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.update_own_profile(
  uuid, bigint, text, text, text, uuid
) to vortex_request;

comment on function vortex_access.update_own_profile(
  uuid, bigint, text, text, text, uuid
) is
  'Protected profile update for one active organisation account: a person may change their own display name, language and time zone, and may change another account only with platform.organization.accounts.manage. The actor and organisation come only from the validated request context; the account revision is exact and Access version is never changed.';

alter function vortex_access.update_own_profile(p_organization_account_id uuid, p_expected_revision bigint, p_display_name text, p_language text, p_time_zone text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.update_own_profile(p_organization_account_id uuid, p_expected_revision bigint, p_display_name text, p_language text, p_time_zone text, p_activity_id uuid) to postgres;

-- vortex_access/propose_record_share_grant_for_administration.sql
create or replace function vortex_access.propose_record_share_grant_for_administration(
  p_grant_id uuid,
  p_consent_request_id uuid,
  p_terms jsonb,
  p_proposal_fingerprint text,
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
    or p_proposal_fingerprint is null or p_proposal_fingerprint !~ '^sha256:[a-f0-9]{64}$'
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
    proposal_fingerprint, revision, created_at, changed_at
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
    p_terms ->> 'definitionMappingFingerprint', p_proposal_fingerprint, 1,
    now_value, now_value
  );

  -- The grant's foreign key to its consent request is deferred, so the request
  -- follows the grant it names.
  if cross_organization then
    insert into vortex_access.record_share_grant_consent_requests (
      request_id, grant_id, source_organization_id, source_cluster_id,
      recipient_organization_id, recipient_cluster_id, proposed_grant_fingerprint,
      status, requested_by_organization_account_id, requested_at,
      source_authorizing_role_ids, recipient_accepting_role_ids, expires_at,
      revision, changed_at
    ) values (
      p_consent_request_id, p_grant_id, context_organization_id,
      (p_terms ->> 'sourceClusterId')::uuid,
      (p_terms ->> 'recipientOrganizationId')::uuid,
      (p_terms ->> 'recipientClusterId')::uuid, p_proposal_fingerprint,
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
  uuid, uuid, jsonb, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, text, uuid
) to vortex_request;

comment on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, text, uuid
) is
  'Fixed protected proposer: stores one exact record-share grant proposal for the context organisation after re-checking its current share authority; cross-organisation proposals stop at pending_consent with a consent request bound to the proposal fingerprint.';

alter function vortex_access.propose_record_share_grant_for_administration(p_grant_id uuid, p_consent_request_id uuid, p_terms jsonb, p_proposal_fingerprint text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.propose_record_share_grant_for_administration(p_grant_id uuid, p_consent_request_id uuid, p_terms jsonb, p_proposal_fingerprint text, p_activity_id uuid) to postgres;

-- vortex_access/revise_record_share_grant_for_administration.sql
create or replace function vortex_access.revise_record_share_grant_for_administration(
  p_grant_id uuid,
  p_expected_revision bigint,
  p_terms jsonb,
  p_proposal_fingerprint text,
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
    or p_proposal_fingerprint is null or p_proposal_fingerprint !~ '^sha256:[a-f0-9]{64}$'
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
      proposal_fingerprint = p_proposal_fingerprint,
      revision = grants.revision + 1,
      changed_at = now_value
  where grants.grant_id = p_grant_id;

  -- The consent request follows the new fingerprint and roles; any earlier
  -- consent would have named the old fingerprint and is superseded.
  if cross_organization then
    update vortex_access.record_share_grant_consent_requests as requests
    set recipient_organization_id = (p_terms ->> 'recipientOrganizationId')::uuid,
        recipient_cluster_id = (p_terms ->> 'recipientClusterId')::uuid,
        source_cluster_id = (p_terms ->> 'sourceClusterId')::uuid,
        proposed_grant_fingerprint = p_proposal_fingerprint,
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
  uuid, bigint, jsonb, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, text, uuid
) to vortex_request;

comment on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, text, uuid
) is
  'Fixed protected reviser: replaces the terms and fingerprints of a draft or pending_consent proposal under an exact expected revision, re-checking current share authority and resetting its consent request.';

alter function vortex_access.revise_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_terms jsonb, p_proposal_fingerprint text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revise_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_terms jsonb, p_proposal_fingerprint text, p_activity_id uuid) to postgres;

-- vortex_access/withdraw_record_share_grant_for_administration.sql
create or replace function vortex_access.withdraw_record_share_grant_for_administration(
  p_grant_id uuid,
  p_expected_revision bigint,
  p_reason text,
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
  now_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_reason is null or pg_catalog.char_length(p_reason) not between 1 and 500
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record-share grant withdrawal is invalid';
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
      message = 'Record-share grant withdrawal requires an application context';
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
      message = 'Record-share grant withdrawal is unavailable';
  end if;

  select grants.* into stored
  from vortex_access.record_share_grants as grants
  where grants.grant_id = p_grant_id
    and grants.source_organization_id = context_organization_id
    and grants.source_application_root_id = context_application_root_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal is unavailable';
  end if;
  if stored.revision <> p_expected_revision or stored.status not in ('draft', 'pending_consent') then
    raise exception using errcode = '40001',
      message = 'Record-share grant is stale or no longer a proposal';
  end if;

  -- Withdrawing only narrows, so it needs no field ceiling. The proposer may
  -- always withdraw its own proposal; anyone else needs the same current
  -- row-independent share authority over the proposal's scope that proposing
  -- it would need (the protected share revocation rule, 20260910114716 F2).
  if (stored.created_by_organization_account_id <> context_account_id
      or context_value ? 'delegatedContext' or context_value ? 'supportContext')
    and pg_catalog.jsonb_array_length(
      vortex_access.record_share_grant_source_authority_internal(
        context_value, stored.module_root_id, stored.record_type_id
      ) -> 'recordTypeIds'
    ) = 0 then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal is unavailable';
  end if;

  update vortex_access.record_share_grants as grants
  set status = 'revoked',
      revoked_at = now_value,
      revoked_by_organization_account_id = context_account_id,
      revocation_reason = p_reason,
      revision = grants.revision + 1,
      changed_at = now_value
  where grants.grant_id = p_grant_id;

  if stored.consent_request_id is not null then
    update vortex_access.record_share_grant_consent_requests as requests
    set status = 'withdrawn', revision = requests.revision + 1, changed_at = now_value
    where requests.request_id = stored.consent_request_id;
  end if;

  append_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'withdraw_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], vortex_platform.channel(), context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant withdrawal Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

revoke all on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) to vortex_request;

comment on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) is
  'Fixed protected withdrawal: its proposer, or a holder of current row-independent share authority over its scope, revokes a draft or pending_consent proposal of the context organisation and application under an exact expected revision and withdraws its consent request.';

alter function vortex_access.withdraw_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_reason text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.withdraw_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_reason text, p_activity_id uuid) to postgres;

-- vortex_access/revise_organization_role_metadata_for_administration.sql
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
  access_version bigint
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
      'permissionId', permission.permission_id
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
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
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
      'authentication_unsatisfied', 'delegation_insufficient'
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
      null::jsonb, context_access_version;
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
    continuity_revision, meaning_fingerprint
  )
  select permission.organization_id, permission.role_id,
    role_fact.live_revision + 1, permission.entry_ordinal, permission.role_kind,
    permission.role_application_root_id, permission.application_root_id,
    permission.owner_kind, permission.owner_id, permission.permission_id,
    permission.registration_kind, permission.registration_owner_id,
    permission.accepted_registration_revision, permission.catalogue_fingerprint,
    permission.continuity_revision, permission.meaning_fingerprint
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
    context_access_version;
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

-- vortex_access/record_share_grant_consent_decision_for_administration.sql
create or replace function vortex_access.record_share_grant_consent_decision_for_administration(
  p_decision_id uuid,
  p_request_id uuid,
  p_expected_revision bigint,
  p_expected_proposal_fingerprint text,
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
  context_expires_at timestamptz;
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
    or p_expected_proposal_fingerprint is null
    or p_expected_proposal_fingerprint !~ '^sha256:[a-f0-9]{64}$'
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
  context_expires_at := (context_value ->> 'expiresAt')::timestamptz;
  context_multi_factor_at :=
    (context_value ->> 'multiFactorAuthenticatedAt')::timestamptz;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_value ->> 'authenticationStrength' is distinct from 'multi_factor'
    or context_multi_factor_at is null
    or context_application_root_id is null then
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
    or stored_grant.proposal_fingerprint is distinct from
      stored_request.proposed_grant_fingerprint
    or stored_grant.proposal_fingerprint is distinct from
      p_expected_proposal_fingerprint
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
  if context_expires_at is null
    or context_expires_at <= path_checked_at
    or context_multi_factor_at > path_checked_at
    or context_multi_factor_at < path_checked_at - interval '300 seconds'
    or stored_grant.expires_at is null
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
  if context_expires_at <= checked_at
    or context_multi_factor_at > checked_at
    or context_multi_factor_at < checked_at - interval '300 seconds'
    or stored_grant.expires_at <= checked_at
    or stored_request.expires_at <= checked_at
    or path_valid_until <= checked_at then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision evidence is stale or unavailable';
  end if;

  authentication_expires_at := least(
    context_expires_at,
    context_multi_factor_at + interval '300 seconds'
  );
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
    proposed_grant_fingerprint,
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
    stored_grant.proposal_fingerprint,
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
    'proposedGrantFingerprint', stored_grant.proposal_fingerprint,
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
  uuid, uuid, bigint, text, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.record_share_grant_consent_decision_for_administration(
  uuid, uuid, bigint, text, text, text, uuid
) to vortex_request;

comment on function vortex_access.record_share_grant_consent_decision_for_administration(
  uuid, uuid, bigint, text, text, text, uuid
) is
  'Fixed protected same-cluster consent writer: records one immutable side decision for the locked current proposal, requiring current named role-path evidence, source share and field authority where applicable and MFA no older than 300 seconds; it never activates a grant.';

alter function vortex_access.record_share_grant_consent_decision_for_administration(p_decision_id uuid, p_request_id uuid, p_expected_revision bigint, p_expected_proposal_fingerprint text, p_decision text, p_note text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.record_share_grant_consent_decision_for_administration(p_decision_id uuid, p_request_id uuid, p_expected_revision bigint, p_expected_proposal_fingerprint text, p_decision text, p_note text, p_activity_id uuid) to postgres;

-- vortex_record/create_record_storage_table_internal.sql
create or replace function vortex_record.create_record_storage_table_internal(
  p_storage_contract_id uuid,
  p_module_root_id uuid,
  p_record_type_id uuid,
  p_storage_scope text,
  p_ownership_mode text,
  p_platform_references boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  table_token text;
  scope_index_columns text;
  scope_check text;
  owner_check text;
  organization_reference text := '';
  owner_references text := '';
begin
  if not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or p_storage_scope not in ('organization_shared', 'application_contained')
    or p_ownership_mode not in ('none', 'organization_account', 'group', 'inherited')
    or p_platform_references is null then
    raise exception using errcode = '22023', message = 'Record storage identity is invalid';
  end if;

  table_token := 'rt_' || pg_catalog.replace(
    pg_catalog.lower(p_storage_contract_id::text), '-', ''
  );
  scope_index_columns := case p_storage_scope
    when 'organization_shared' then 'organisation_id'
    else 'organisation_id, application_root_id'
  end;
  scope_check := case p_storage_scope
    when 'organization_shared' then 'application_root_id is null'
    else 'application_root_id is not null'
  end;
  owner_check := case p_ownership_mode
    when 'organization_account' then
      'owner_organisation_account_id is not null and owner_group_id is null'
    when 'group' then
      'owner_organisation_account_id is null and owner_group_id is not null'
    else 'owner_organisation_account_id is null and owner_group_id is null'
  end;
  -- Installed storage references the platform's organisation, account and Group rows. A
  -- preview's storage references none: a foreign key would lock those platform tables whenever
  -- the preview's table is created or dropped (dropping takes ACCESS EXCLUSIVE on every table it
  -- references), stopping every request of every organisation. The preview's own write paths
  -- keep its records inside the preview.
  if p_platform_references then
    organization_reference := ' references vortex_identity.organizations (organization_id)';
    owner_references := ',
      foreign key (organisation_id, owner_organisation_account_id)
        references vortex_identity.organization_accounts (organization_id, organization_account_id),
      foreign key (organisation_id, owner_group_id)
        references vortex_access.organization_groups (organization_id, group_id)';
  end if;

  execute pg_catalog.format(
    'create table record_data.%I (
      organisation_id uuid not null%s,
      module_root_id uuid not null check (module_root_id = %L::uuid),
      record_type_id uuid not null check (record_type_id = %L::uuid),
      storage_contract_id uuid not null check (storage_contract_id = %L::uuid),
      record_id uuid not null,
      application_root_id uuid,
      definition_revision bigint not null check (definition_revision between 1 and 9007199254740991),
      owner_organisation_account_id uuid,
      owner_group_id uuid,
      lifecycle_state text not null check (lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')),
      concurrency_number bigint not null check (concurrency_number between 1 and 9007199254740991),
      created_at timestamptz not null,
      created_by uuid not null,
      updated_at timestamptz not null,
      updated_by uuid not null,
      deleted_at timestamptz,
      deleted_by uuid,
      removal_due_at timestamptz,
      primary key (%s, record_id)%s,
      check (%s), check (%s),
      check ((deleted_at is null) = (deleted_by is null)),
      check ((lifecycle_state = ''active'') = (deleted_at is null and deleted_by is null)),
      check (updated_at >= created_at)
    )', table_token, organization_reference, p_module_root_id, p_record_type_id,
    p_storage_contract_id, scope_index_columns, owner_references, scope_check, owner_check
  );
  execute pg_catalog.format('alter table record_data.%I enable row level security', table_token);
  execute pg_catalog.format('alter table record_data.%I force row level security', table_token);
  execute pg_catalog.format(
    'create policy record_select on record_data.%I for select to vortex_record_adapter using (
      organisation_id = (select vortex_platform.organization_id())
      and case when application_root_id is null then true
        else application_root_id = (select vortex_platform.application_root_id(true)) end
    )', table_token
  );
  execute pg_catalog.format(
    'create policy record_insert on record_data.%I for insert to vortex_record_adapter with check (
      organisation_id = (select vortex_platform.organization_id())
      and case when application_root_id is null then true
        else application_root_id = (select vortex_platform.application_root_id(true)) end
    )', table_token
  );
  execute pg_catalog.format(
    'create policy record_update on record_data.%I for update to vortex_record_adapter using (
      organisation_id = (select vortex_platform.organization_id())
      and case when application_root_id is null then true
        else application_root_id = (select vortex_platform.application_root_id(true)) end
    ) with check (
      organisation_id = (select vortex_platform.organization_id())
      and case when application_root_id is null then true
        else application_root_id = (select vortex_platform.application_root_id(true)) end
    )', table_token
  );
  execute pg_catalog.format(
    'create policy record_delete on record_data.%I for delete to vortex_record_adapter using (
      organisation_id = (select vortex_platform.organization_id())
      and case when application_root_id is null then true
        else application_root_id = (select vortex_platform.application_root_id(true)) end
    )', table_token
  );
  execute pg_catalog.format(
    'grant select, insert, update, delete on record_data.%I to vortex_record_adapter',
    table_token
  );
end
$function$;

alter function vortex_record.create_record_storage_table_internal(uuid,uuid,uuid,text,text,boolean) owner to vortex_owner;

revoke all on function vortex_record.create_record_storage_table_internal(uuid, uuid, uuid, text, text, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.create_record_storage_table_internal(uuid, uuid, uuid, text, text, boolean)
  to vortex_owner;
comment on function vortex_record.create_record_storage_table_internal(uuid, uuid, uuid, text, text, boolean) is
  'Creates one generated Record storage table with its fixed scope checks and request-adapter policies; installed storage references the platform organisation, account and Group rows, preview storage references no platform table.';

-- vortex_record/provision_preview_module_storage.sql
create or replace function vortex_record.provision_preview_module_storage(
  p_preview_installation_id uuid,
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  record_type jsonb;
  storage_identities jsonb := '[]'::jsonb;
begin
  -- A system projection is the platform's own read model, which a preview reads as it is: it
  -- has no storage of its own to isolate.
  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(vortex_record.preview_module_record_types_internal(
      p_preview_installation_id, p_module_root_id, p_module_release_revision
    )) as item(value)
    where not item.value ? 'systemProjection'
    order by item.value ->> 'storageContractId'
  loop
    storage_identities := storage_identities || pg_catalog.jsonb_build_array(
      vortex_record.provision_preview_record_storage_internal(
        p_preview_installation_id, p_module_root_id, p_module_release_revision, record_type
      )
    );
  end loop;
  return storage_identities;
end
$function$;

alter function vortex_record.provision_preview_module_storage(uuid,uuid,bigint) owner to vortex_owner;

revoke all on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint)
  to vortex_owner;
comment on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint) is
  'Creates empty isolated Record storage for every record type of one exact Module release of a preview, its rehearsed release or a stored one, without provisioning its live release identities.';

-- vortex_record/provision_preview_record_storage_internal.sql
create or replace function vortex_record.provision_preview_record_storage_internal(
  p_preview_installation_id uuid,
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_record_type jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_record_type jsonb;
  field_value jsonb;
  storage_id uuid;
  preview_storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  shape_fingerprint text;
  scope_index_columns text;
  index_token text;
  live_table_token text;
  preview_scope record;
  live_type jsonb;
begin
  begin
    storage_id := (p_record_type ->> 'storageContractId')::uuid;
    record_type_id_value := (p_record_type ->> 'recordTypeId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
  end;
  storage_scope_value := p_record_type ->> 'storageScope';
  ownership_mode_value := p_record_type ->> 'ownershipMode';
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991
    or not vortex_platform.is_non_nil_uuid(storage_id::text)
    or not vortex_platform.is_non_nil_uuid(record_type_id_value::text)
    or p_record_type ? 'systemProjection'
    or storage_scope_value not in ('organization_shared', 'application_contained')
    or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
    or pg_catalog.jsonb_typeof(p_record_type -> 'fields') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_record_type -> 'fields') < 1
    or pg_catalog.jsonb_typeof(p_record_type -> 'relationships') is distinct from 'array' then
    raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
  end if;

  preview_storage_id := pg_catalog.gen_random_uuid();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex_record.storage:' || preview_storage_id::text, 0)
  );
  table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(preview_storage_id::text), '-', '');
  preview_record_type := pg_catalog.jsonb_set(
    p_record_type,
    '{storageContractId}',
    pg_catalog.to_jsonb(preview_storage_id::text),
    true
  );
  shape_fingerprint := vortex_record.storage_meaning_fingerprint(preview_record_type);

  select preview.organization_id, preview.application_root_id into strict preview_scope
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id;
  live_type := vortex_record.resolve_preview_seed_source_internal(
    preview_scope.organization_id, preview_scope.application_root_id,
    p_module_root_id, record_type_id_value, storage_id
  );
  live_table_token := live_type ->> 'table';
  perform vortex_record.create_record_storage_table_internal(
    preview_storage_id, p_module_root_id, record_type_id_value,
    storage_scope_value, ownership_mode_value, false
  );
  insert into vortex_record.storage_catalogue (
    storage_contract_id, physical_schema_token, physical_table_token,
    module_root_id, record_type_id, storage_scope,
    first_compatible_release_revision, last_compatible_release_revision,
    state, content_fingerprint, record_type_definition, protected_read_model_key
  ) values (
    preview_storage_id, 'record_data', table_token,
    p_module_root_id, record_type_id_value, storage_scope_value,
    p_module_release_revision, p_module_release_revision,
    'active', shape_fingerprint, preview_record_type, null
  );

  for field_value in
    select item.value
    from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    begin
      field_id_value := (field_value ->> 'fieldId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
    end;
    if not vortex_platform.is_non_nil_uuid(field_id_value::text)
      or field_value ->> 'type' is null
      or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
      or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
      or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
      or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
      or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
      raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
    end if;
    column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
    database_type := vortex_record.database_value_type(field_value);
    if database_type is null then
      raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
    end if;
    sql_type := vortex_record.sql_value_type(database_type);
    execute pg_catalog.format(
      'alter table record_data.%I add column %I %s%s',
      table_token, column_token, sql_type,
      -- Copied live records have no value for a field the draft adds, so only fresh storage
      -- enforces a required field in the table; the save path enforces it for every record.
      case when (field_value ->> 'required')::boolean and live_table_token is null
        then ' not null' else '' end
    );
    insert into vortex_record.field_storage_mappings (
      storage_contract_id, field_id, physical_column_token, database_value_type,
      field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
    ) values (
      preview_storage_id, field_id_value, column_token, database_type, field_value,
      p_module_root_id, p_module_release_revision, 'active'
    );
    if (field_value ->> 'unique')::boolean then
      scope_index_columns := case storage_scope_value
        when 'organization_shared' then 'organisation_id'
        else 'organisation_id, application_root_id'
      end;
      index_token := 'pux_' || pg_catalog.md5(
        preview_storage_id::text || ':' || field_id_value::text
      );
      execute pg_catalog.format(
        'create unique index %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
        index_token, table_token, scope_index_columns, column_token
      );
    end if;
  end loop;

  insert into vortex_record.preview_storage_bindings (
    preview_installation_id, storage_contract_id, module_root_id,
    module_release_revision, record_type_id, release_storage_contract_id
  ) values (
    p_preview_installation_id, preview_storage_id, p_module_root_id,
    p_module_release_revision, record_type_id_value, storage_id
  );
  return pg_catalog.jsonb_build_object(
    'moduleRootId', p_module_root_id,
    'moduleReleaseRevision', p_module_release_revision,
    'recordTypeId', record_type_id_value,
    'releaseStorageContractId', storage_id,
    'previewStorageContractId', preview_storage_id
  );
end
$function$;

alter function vortex_record.provision_preview_record_storage_internal(uuid, uuid, bigint, jsonb) owner to vortex_owner;

revoke all on function vortex_record.provision_preview_record_storage_internal(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_preview_record_storage_internal(uuid, uuid, bigint, jsonb)
  to vortex_owner;
comment on function vortex_record.provision_preview_record_storage_internal(uuid, uuid, bigint, jsonb) is
  'Creates empty isolated Record storage for one record type of an exact Module release a preview runs, and returns its storage identity: the release storage it stands for and its own.';

-- vortex_record/provision_exact_module_storage.sql
create or replace function vortex_record.provision_exact_module_storage(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  storage_contract_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
  record_type jsonb;
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  projection_expression_pair record;
  field_value jsonb;
  relationship_value jsonb;
  target_value jsonb;
  target_ids uuid[];
  storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  relationship_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  stored_projection_role text;
  requested_projection_role text;
  stored_database_type text;
  requested_database_type text;
  stored_sql_type text;
  requested_sql_type text;
  stored_expression jsonb;
  requested_expression jsonb;
  shape_fingerprint text;
  scope_index_columns text;
  result_storage_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
  is_projection boolean;
  protected_view_key text;
  reader_schema_value text;
  reader_function_value text;
  reader_sort_key_value text;
  field_columns_sql text;
  projection_view_sql text;
  existing_columns text[];
  expected_columns text[];
begin
  if not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Record storage release selector is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  -- Module V3 reuses the Module V2 record-type content, so both validation
  -- contracts allocate identical storage. The source contract must agree with
  -- the validation contract, and the embedded identity is compared with
  -- IS DISTINCT FROM so an absent JSON member cannot evade the gate.
  if release_row.validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514', message = 'Exact Module release is incompatible';
  end if;

  record_types := release_row.compilation_output #> '{canonical,content,recordTypes}';
  -- A Module may hold no record types yet; its release is provisioned with no storage.
  if pg_catalog.jsonb_typeof(record_types) is distinct from 'array' then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;

  perform 1 from vortex_record.release_provisions as provision
  where provision.module_root_id = p_module_root_id
    and provision.release_revision = p_module_release_revision
  for update;
  if found then
    select provision.storage_contract_ids into result_storage_ids
    from vortex_record.release_provisions as provision
    where provision.module_root_id = p_module_root_id
      and provision.release_revision = p_module_release_revision;
    if result_storage_ids is distinct from coalesce((
      select pg_catalog.array_agg((item.value ->> 'storageContractId')::uuid order by item.value ->> 'storageContractId')
      from pg_catalog.jsonb_array_elements(record_types) as item(value)
    ), array[]::uuid[]) then
      raise exception using errcode = '55000', message = 'Stored release provision identities are incompatible';
    end if;
    result_storage_ids := array[]::uuid[];
  end if;

  if (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    where (
      select pg_catalog.count(*) <> pg_catalog.count(distinct field_item.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(record_item.value -> 'fields') as field_item(value)
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct relationship_item.value ->> 'relationshipId')
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'relationships'
    ) as relationship_item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module field or relationship identities are duplicated';
  end if;

  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    order by item.value ->> 'storageContractId'
  loop
    begin
      storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    storage_scope_value := record_type ->> 'storageScope';
    ownership_mode_value := record_type ->> 'ownershipMode';
    if not vortex_platform.is_non_nil_uuid(storage_id::text)
      or not vortex_platform.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;
    -- The eight-sortable-field limit is a publish rule; an older release may declare more and
    -- simply gets an index per sortable field.
    -- The record-type loop is ordered by storage identity, so overlapping
    -- provisions acquire absent and existing lineage locks deterministically.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
    table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', '');
    shape_fingerprint := vortex_record.storage_meaning_fingerprint(record_type);
    result_storage_ids := result_storage_ids || storage_id;
    scope_index_columns := case storage_scope_value
      when 'organization_shared' then 'organisation_id'
      else 'organisation_id, application_root_id'
    end;

    -- A system projection record type has no generated storage. It is read
    -- through one registered protected view, created here as an ordinary
    -- record_data relation so the fixed read adapters resolve it unchanged,
    -- while the projection itself keeps every row-visibility rule inside the
    -- registered function. The view exposes exactly the record type's declared
    -- fields as record-data columns, plus the protected row identity and
    -- revision, and is read-only: the projection has no ordinary write path.
    -- Every projection value is reset per record type, so a generated record
    -- type provisioned after a projection never inherits its protected key.
    is_projection := record_type ? 'systemProjection';
    protected_view_key := null;
    reader_schema_value := null;
    reader_function_value := null;
    reader_sort_key_value := null;
    projection_view_sql := null;
    if is_projection then
      protected_view_key := record_type #>> '{systemProjection,protectedView}';
      -- The view reads every row in the reader's first registered cursor order, which each
      -- reader accepts without a page limit.
      select registered.reader_schema, registered.reader_function,
        registered.cursor_sort_keys[1]
      into reader_schema_value, reader_function_value, reader_sort_key_value
      from vortex_record.protected_read_model_views as registered
      where registered.protected_read_model_key = protected_view_key;
      if not found then
        raise exception using errcode = '42501',
          message = 'Protected projection view is unavailable';
      end if;
      if storage_scope_value <> 'organization_shared' then
        raise exception using errcode = '42501',
          message = 'Protected projection storage must be organisation shared';
      end if;
      field_columns_sql := '';
      expected_columns := array[]::text[];
      for field_value in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
        order by item.value ->> 'fieldId'
      loop
        begin
          field_id_value := (field_value ->> 'fieldId')::uuid;
        exception when invalid_text_representation then
          raise exception using errcode = '42501',
            message = 'Record field storage identity is invalid';
        end;
        column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
        database_type := vortex_record.database_value_type(field_value);
        if database_type is null then
          raise exception using errcode = '23514',
            message = 'Record field storage type is unsupported';
        end if;
        sql_type := vortex_record.sql_value_type(database_type);
        expected_columns := expected_columns || column_token;
        if field_value ->> 'fieldId' = record_type #>> '{systemProjection,organizationFieldId}' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format('projection.organization_id::text as %I, ', column_token);
        elsif field_value ->> 'fieldId' = record_type #>> '{systemProjection,revisionFieldId}' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format('projection.revision::%s as %I, ', sql_type, column_token);
        elsif database_type = 'json' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format(
              '(projection.attribute_values -> %L) as %I, ', field_value ->> 'key', column_token
            );
        else
          field_columns_sql := field_columns_sql
            || pg_catalog.format(
              '(projection.attribute_values ->> %L)::%s as %I, ',
              field_value ->> 'key', sql_type, column_token
            );
        end if;
      end loop;
      select pg_catalog.array_agg(item.column_name order by item.column_name)
      into expected_columns
      from pg_catalog.unnest(expected_columns) as item(column_name);
      field_columns_sql := pg_catalog.left(
        field_columns_sql, pg_catalog.length(field_columns_sql) - 2
      );
      projection_view_sql := pg_catalog.format(
        'create view record_data.%I as select
           projection.organization_id as organisation_id,
           %L::uuid as module_root_id,
           %L::uuid as record_type_id,
           %L::uuid as storage_contract_id,
           projection.record_id,
           null::uuid as application_root_id,
           %L::bigint as definition_revision,
           null::uuid as owner_organisation_account_id,
           null::uuid as owner_group_id,
           ''active''::text as lifecycle_state,
           projection.revision as concurrency_number,
           null::timestamptz as created_at,
           null::uuid as created_by,
           null::timestamptz as updated_at,
           null::uuid as updated_by,
           null::timestamptz as deleted_at,
           null::uuid as deleted_by,
           null::timestamptz as removal_due_at,
           %s
         from %I.%I(null::uuid[], %L, ''ascending'', null, null) as projection',
        table_token, p_module_root_id, record_type_id_value, storage_id,
        p_module_release_revision, field_columns_sql,
        reader_schema_value, reader_function_value, reader_sort_key_value
      );
    end if;

    select catalogue.* into stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
    for update;

    if not found then
      if is_projection then
        execute projection_view_sql;
        execute pg_catalog.format(
          'grant select on record_data.%I to vortex_record_adapter', table_token
        );
      else
        perform vortex_record.create_record_storage_table_internal(
          storage_id, p_module_root_id, record_type_id_value,
          storage_scope_value, ownership_mode_value, true
        );
      end if;

      insert into vortex_record.storage_catalogue (
        storage_contract_id, physical_schema_token, physical_table_token,
        module_root_id, record_type_id, storage_scope,
        first_compatible_release_revision, last_compatible_release_revision,
        state, content_fingerprint, record_type_definition, protected_read_model_key
      ) values (
        storage_id,
        case when is_projection then 'system_projection' else 'record_data' end,
        table_token, p_module_root_id, record_type_id_value, storage_scope_value,
        p_module_release_revision, p_module_release_revision, 'active',
        shape_fingerprint, record_type, protected_view_key
      );
      any_change := true;
    else
      if is_projection then
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'system_projection'
          or stored_catalogue.protected_read_model_key is distinct from protected_view_key
          or stored_catalogue.physical_table_token <> table_token
          or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
        if pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition) is distinct from 'object'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'fields') is distinct from 'array'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'systemProjection') is distinct from 'object'
          or pg_catalog.jsonb_typeof(record_type -> 'systemProjection') is distinct from 'object' then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;

        -- The catalogue keeps the newest compatible exact definition. Compare
        -- only shared field identities so an older subset and newer additions
        -- retain their existing release-order behavior. These descriptors
        -- mirror the source expressions assembled above, including the
        -- protected attribute key, JSON/text extraction, and cast.
        for projection_expression_pair in
          select requested_item.value as requested_field,
            stored_item.value as stored_field
          from pg_catalog.jsonb_array_elements(record_type -> 'fields') as requested_item(value)
          join pg_catalog.jsonb_array_elements(
            stored_catalogue.record_type_definition -> 'fields'
          ) as stored_item(value)
            on stored_item.value ->> 'fieldId' = requested_item.value ->> 'fieldId'
          order by requested_item.value ->> 'fieldId'
        loop
          stored_projection_role := case
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          requested_projection_role := case
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          stored_database_type := vortex_record.database_value_type(
            projection_expression_pair.stored_field
          );
          requested_database_type := vortex_record.database_value_type(
            projection_expression_pair.requested_field
          );
          if stored_projection_role is distinct from requested_projection_role
            or stored_database_type is null
            or requested_database_type is null then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
          stored_sql_type := vortex_record.sql_value_type(stored_database_type);
          requested_sql_type := vortex_record.sql_value_type(requested_database_type);
          stored_expression := case stored_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.revision',
              'cast', stored_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.stored_field ->> 'key',
              'extraction', case when stored_database_type = 'json' then '->' else '->>' end,
              'cast', case when stored_database_type = 'json' then null else stored_sql_type end
            )
          end;
          requested_expression := case requested_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.revision',
              'cast', requested_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.requested_field ->> 'key',
              'extraction', case when requested_database_type = 'json' then '->' else '->>' end,
              'cast', case when requested_database_type = 'json' then null else requested_sql_type end
            )
          end;
          if stored_expression is distinct from requested_expression then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
        end loop;

        select coalesce(
            pg_catalog.array_agg(attribute.attname order by attribute.attname),
            array[]::text[]
          )
        into existing_columns
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(
            pg_catalog.format('%I.%I', 'record_data', table_token)
          )
          and attribute.attnum > 0
          and not attribute.attisdropped
          and attribute.attname like 'f\_%';
        -- The view always carries the newest compatible release's shape, as a
        -- generated table keeps every column a newer release added. A newer
        -- release, or the newest one with a different field set, recreates it
        -- exactly; an older release, which the field checks below prove is a
        -- compatible subset, leaves the newer view alone. The projection has no
        -- indexes or dependent objects.
        if p_module_release_revision > stored_catalogue.last_compatible_release_revision
          or (p_module_release_revision = stored_catalogue.last_compatible_release_revision
            and existing_columns is distinct from expected_columns) then
          execute pg_catalog.format('drop view record_data.%I', table_token);
          execute projection_view_sql;
          execute pg_catalog.format(
            'grant select on record_data.%I to vortex_record_adapter', table_token
          );
          any_change := true;
        end if;
      else
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'record_data'
          or stored_catalogue.physical_table_token <> table_token
          or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
      end if;
    end if;

    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      begin
        field_id_value := (field_value ->> 'fieldId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
      end;
      if not vortex_platform.is_non_nil_uuid(field_id_value::text)
        or field_value ->> 'type' is null
        or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
        raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
      end if;
      column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
      database_type := vortex_record.database_value_type(field_value);
      if database_type is null then
        raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
      end if;
      sql_type := vortex_record.sql_value_type(database_type);

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.state <> 'active'
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(field_value)
          or not exists (
            select 1
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('%I.%I', 'record_data', table_token)
              )
              and attribute.attname = column_token
              and attribute.attnum > 0
              and not attribute.attisdropped
          ) then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;
      else
        if not is_projection then
          if stored_catalogue.storage_contract_id is not null
            and (field_value ->> 'required')::boolean then
            raise exception using errcode = '55000', message = 'Compatible storage upgrades may add only nullable fields';
          end if;
          execute pg_catalog.format(
            'alter table record_data.%I add column %I %s%s',
            table_token, column_token, sql_type,
            case when (field_value ->> 'required')::boolean then ' not null' else '' end
          );
        end if;
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          storage_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
        -- A projection field lives in the protected view, which carries no
        -- indexes; the projection's own protected function applies visibility,
        -- ordering and filtering, so no generated index is provisioned.
        if is_projection then
          null;
        elsif (field_value ->> 'unique')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'uniqueness', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'performance', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end loop;

    -- Only a field this Module itself introduced can prove a removed field. A
    -- field another Module contributed keeps its retained lineage and never
    -- refuses this Module's own storage.
    if exists (
      select 1 from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.state = 'active'
        and mapping.introduced_by_module_root_id = p_module_root_id
        and mapping.introduced_at_release_revision <= p_module_release_revision
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
          where item.value ->> 'fieldId' = mapping.field_id::text
        )
    ) then
      raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove fields';
    end if;

    if stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision < p_module_release_revision then
      update vortex_record.storage_catalogue
      set last_compatible_release_revision = greatest(
            last_compatible_release_revision, p_module_release_revision
          ),
          content_fingerprint = shape_fingerprint,
          record_type_definition = record_type,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
      any_change := true;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.first_compatible_release_revision > p_module_release_revision then
      -- A newer release may have created the shared table first. The loops above
      -- prove the older release is a compatible subset; retain the newer shape.
      update vortex_record.storage_catalogue
      set first_compatible_release_revision = p_module_release_revision,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision = p_module_release_revision
      and stored_catalogue.content_fingerprint <> shape_fingerprint then
      raise exception using errcode = '55000', message = 'Stored record storage meaning is incompatible';
    end if;
  end loop;

  if exists (
    select 1
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.module_root_id = p_module_root_id
      and mapping.release_revision <= p_module_release_revision
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          record_item.value -> 'relationships'
        ) as relationship_item(value)
        where relationship_item.value ->> 'relationshipId' = mapping.relationship_id::text
      )
  ) then
    raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove relationships';
  end if;

  for record_type in select item.value from pg_catalog.jsonb_array_elements(record_types) as item(value)
  loop
    storage_id := (record_type ->> 'storageContractId')::uuid;
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'relationships') as item(value)
    loop
      relationship_id_value := (relationship_value ->> 'relationshipId')::uuid;
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      target_ids := array[]::uuid[];
      if relationship_value ? 'toRecordType' then
        target_ids := array[(relationship_value #>> '{toRecordType,recordTypeId}')::uuid];
      else
        for target_value in select item.value
          from pg_catalog.jsonb_array_elements(relationship_value -> 'toRecordTypes') as item(value)
        loop
          target_ids := target_ids || (target_value ->> 'recordTypeId')::uuid;
        end loop;
      end if;
      if pg_catalog.cardinality(target_ids) < 1 or array_position(target_ids, null) is not null then
        raise exception using errcode = '42501', message = 'Relationship target evidence is unresolved';
      end if;
      insert into vortex_record.relationship_storage_mappings (
        relationship_id, module_root_id, release_revision, source_storage_contract_id,
        source_field_id, target_record_type_ids, cardinality, on_parent_delete, definition
      ) values (
        relationship_id_value, p_module_root_id, p_module_release_revision, storage_id,
        field_id_value, target_ids, relationship_value ->> 'cardinality',
        relationship_value ->> 'onParentDelete', relationship_value
      )
      on conflict (relationship_id) do update
      set release_revision = greatest(
            vortex_record.relationship_storage_mappings.release_revision,
            excluded.release_revision
          )
      where vortex_record.relationship_storage_mappings.module_root_id = excluded.module_root_id
        and vortex_record.relationship_storage_mappings.source_storage_contract_id = excluded.source_storage_contract_id
        and vortex_record.relationship_storage_mappings.source_field_id = excluded.source_field_id
        and vortex_record.relationship_storage_mappings.target_record_type_ids = excluded.target_record_type_ids
        and vortex_record.relationship_storage_mappings.cardinality = excluded.cardinality
        and vortex_record.relationship_storage_mappings.on_parent_delete = excluded.on_parent_delete
        and vortex_record.relationship_storage_mappings.definition = excluded.definition;
      if not found then
        raise exception using errcode = '55000', message = 'Existing relationship storage is incompatible';
      end if;
    end loop;
  end loop;

  -- The release declares each legacy Person field paired with its new link.
  -- Both field columns and relationship mappings now exist for every record type.
  perform vortex_record.backfill_person_links_internal(
    p_module_root_id, p_module_release_revision
  );

  select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[]) into result_storage_ids
  from pg_catalog.unnest(result_storage_ids) as item(value);
  insert into vortex_record.release_provisions (
    module_root_id, release_revision, storage_contract_ids
  ) values (
    p_module_root_id, p_module_release_revision, result_storage_ids
  ) on conflict on constraint release_provisions_pkey do nothing;

  return query select p_module_root_id, p_module_release_revision,
    result_storage_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module storage evidence is ambiguous';
end
$function$;

alter function vortex_record.provision_exact_module_storage(uuid,bigint) owner to vortex_owner;

revoke all on function vortex_record.provision_exact_module_storage(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_exact_module_storage(uuid, bigint)
  to vortex_owner;
comment on function vortex_record.provision_exact_module_storage(uuid, bigint) is
  'Private exact-release Module storage provisioner: creates or evolves the generated record_data storage, or the read-only record_data view over one registered protected projection reader for a system projection record type, for one published Module release and records its immutable provision evidence.';

-- vortex_record/read_retired_preview_storage_internal.sql
create or replace function vortex_record.read_retired_preview_storage_internal(
  p_limit integer
)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  -- Storage whose preview row is gone: no request reaches it, and the background drops it.
  select binding.storage_contract_id
  from vortex_record.preview_storage_bindings as binding
  where not exists (
    select 1 from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = binding.preview_installation_id
  )
  order by binding.storage_contract_id
  limit greatest(1, least(coalesce(p_limit, 1), 100));
$function$;

alter function vortex_record.read_retired_preview_storage_internal(integer) owner to vortex_owner;

revoke all on function vortex_record.read_retired_preview_storage_internal(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.read_retired_preview_storage_internal(integer)
  to vortex_runtime;
comment on function vortex_record.read_retired_preview_storage_internal(integer) is
  'Lists a bounded batch of retired preview storage identities (their preview is gone) for the background drop.';

-- vortex_record/drop_retired_preview_storage_internal.sql
create or replace function vortex_record.drop_retired_preview_storage_internal(
  p_storage_contract_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  storage_row record;
begin
  if not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text) then
    raise exception using errcode = '22023', message = 'Preview storage identity is invalid';
  end if;
  -- Background maintenance only: waiting for a lock would hold this transaction behind a reader
  -- of the retired table, so a held lock fails fast (55P03) and the next run retries.
  perform pg_catalog.set_config('lock_timeout', '200ms', true);

  -- Retired: its preview row is gone, so no request reaches this storage any more. Another run
  -- dropping the same storage holds these rows; this one leaves it to that run.
  select binding.storage_contract_id, catalogue.physical_table_token into storage_row
  from vortex_record.preview_storage_bindings as binding
  join vortex_record.storage_catalogue as catalogue
    on catalogue.storage_contract_id = binding.storage_contract_id
  where binding.storage_contract_id = p_storage_contract_id
    and not exists (
      select 1 from vortex_definition.preview_installations as preview
      where preview.preview_installation_id = binding.preview_installation_id
    )
  for update of binding, catalogue skip locked;
  if not found then
    return false;
  end if;

  if storage_row.physical_table_token <> (
      'rt_' || pg_catalog.replace(pg_catalog.lower(storage_row.storage_contract_id::text), '-', '')
    )
    or not exists (
      select 1 from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = storage_row.storage_contract_id
        and catalogue.physical_schema_token = 'record_data'
        and catalogue.state = 'active'
    ) then
    raise exception using errcode = '55000', message = 'Preview storage lineage is incompatible';
  end if;

    delete from vortex_record.relationship_edges as edge
    where edge.from_storage_contract_id = storage_row.storage_contract_id
      or edge.to_storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.record_reference_counters as counter
    where counter.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.index_catalogue as index_row
    where index_row.storage_contract_id = storage_row.storage_contract_id;

    delete from vortex_record.preview_storage_bindings as binding
    where binding.storage_contract_id = storage_row.storage_contract_id;

    execute pg_catalog.format('drop table if exists record_data.%I', storage_row.physical_table_token);
    delete from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_row.storage_contract_id;
  return true;
end
$function$;

alter function vortex_record.drop_retired_preview_storage_internal(uuid) owner to vortex_owner;

revoke all on function vortex_record.drop_retired_preview_storage_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.drop_retired_preview_storage_internal(uuid)
  to vortex_runtime;
comment on function vortex_record.drop_retired_preview_storage_internal(uuid) is
  'Drops one retired preview storage identity (its preview is gone), including its preview records and record metadata, in its own short background transaction: a held lock fails fast and the next run retries. Preview storage references no platform table, so the drop locks only its own table.';

-- vortex_definition/create_preview_installation.sql
create or replace function vortex_definition.create_preview_installation(
  p_application_root_id uuid,
  p_expected_draft_revision bigint,
  p_releases jsonb,
  p_shape_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_lifetime constant interval := interval '24 hours';
  checked_context jsonb;
  organization_id_value uuid;
  organization_account_id_value uuid;
  identity_id_value uuid;
  preview_installation_id_value uuid;
  draft_revision_value bigint;
  application_release_revision_value bigint;
  created_at_value timestamptz;
  expires_at_value timestamptz;
  previous_preview record;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_shape_fingerprint is null
    or p_shape_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  organization_id_value := (checked_context ->> 'organizationId')::uuid;
  organization_account_id_value := (checked_context ->> 'organizationAccountId')::uuid;
  identity_id_value := (checked_context ->> 'identityId')::uuid;
  -- A preview is provisioned in the organisation's context: the Application it previews may have
  -- no installation, and so no Application context, yet.
  if checked_context ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;

  select draft.draft_revision
  into draft_revision_value
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = organization_id_value
    and root.kind = 'application'
  for share of draft;
  if not found or draft_revision_value <> p_expected_draft_revision then
    raise exception using errcode = '40001', message = 'Application draft revision changed';
  end if;
  application_release_revision_value := vortex_definition.assert_preview_releases_internal(
    organization_id_value, p_application_root_id, p_releases
  );

  -- One preview per Application and builder: a new preview replaces this builder's previous one
  -- and its storage, never another builder's.
  for previous_preview in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    where preview.organization_id = organization_id_value
      and preview.application_root_id = p_application_root_id
      and preview.previewer_organization_account_id = organization_account_id_value
    order by preview.preview_installation_id
    for update
  loop
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = previous_preview.preview_installation_id;
  end loop;
  perform vortex_definition.expire_preview_installations(100);

  preview_installation_id_value := pg_catalog.gen_random_uuid();
  created_at_value := pg_catalog.statement_timestamp();
  expires_at_value := created_at_value + preview_lifetime;
  insert into vortex_definition.preview_installations (
    preview_installation_id, organization_id, application_root_id,
    draft_revision, application_release_revision, previewer_identity_id,
    previewer_organization_account_id, resolved_modules, storage_identities,
    created_at, expires_at, draft_shape_fingerprint
  ) values (
    preview_installation_id_value, organization_id_value, p_application_root_id,
    p_expected_draft_revision, application_release_revision_value, identity_id_value,
    organization_account_id_value, '[]'::jsonb, '[]'::jsonb,
    created_at_value, expires_at_value, p_shape_fingerprint
  );
  insert into vortex_definition.preview_releases (
    preview_installation_id, root_id, release_revision, release, dependencies
  )
  select preview_installation_id_value, (item.value #>> '{release,root_id}')::uuid,
    (item.value #>> '{release,release_revision}')::bigint,
    item.value -> 'release', item.value -> 'dependencies'
  from pg_catalog.jsonb_array_elements(p_releases) as item(value);
  perform vortex_definition.write_preview_shape_internal(preview_installation_id_value, false);

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_installation_id_value,
    'organizationId', organization_id_value,
    'applicationRootId', p_application_root_id,
    'draftRevision', p_expected_draft_revision,
    'applicationReleaseRevision', application_release_revision_value,
    'createdAt', created_at_value,
    'expiresAt', expires_at_value,
    -- The builder's live records reach the preview only through the installed Application.
    'seedable', exists (
      select 1
      from vortex_access.permission_registrations as registration
      where registration.organization_id = organization_id_value
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and registration.state = 'active'
    )
  );
end
$function$;

alter function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text) owner to vortex_owner;

revoke all on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text)
  to vortex_request;
comment on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text) is
  'Replaces the builder''s 24-hour preview of one Application with a preview of its current draft: the releases its publication rehearsed, the exact Module pins they and the used Module releases name, the preview''s own permission registration whose draft roles only its builder holds, empty isolated storage for every bound record type, and the fingerprint of the draft''s data shape.';

-- vortex_definition/expire_preview_installations.sql
create or replace function vortex_definition.expire_preview_installations(
  p_limit integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  preview_row record;
  expired_count integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Preview expiry batch size is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  for preview_row in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    where preview.organization_id = (checked_context ->> 'organizationId')::uuid
      and preview.expires_at <= pg_catalog.statement_timestamp()
    order by preview.expires_at, preview.preview_installation_id
    limit p_limit
    for update skip locked
  loop
    -- Its storage is retired with it and dropped in the background.
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = preview_row.preview_installation_id;
    expired_count := expired_count + 1;
  end loop;
  return expired_count;
end
$function$;

alter function vortex_definition.expire_preview_installations(integer) owner to vortex_owner;

revoke all on function vortex_definition.expire_preview_installations(integer)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.expire_preview_installations(integer)
  to vortex_request, vortex_owner;
comment on function vortex_definition.expire_preview_installations(integer) is
  'Removes a bounded batch of expired preview installations in the current human organisation; their isolated Record storage is retired with them and dropped in the background.';

-- vortex_definition/expire_abandoned_preview_installations_internal.sql
create or replace function vortex_definition.expire_abandoned_preview_installations_internal(
  p_limit integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_row record;
  expired_count integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Preview expiry batch size is invalid';
  end if;

  for preview_row in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    where preview.expires_at <= pg_catalog.statement_timestamp()
    order by preview.expires_at, preview.preview_installation_id
    limit p_limit
    -- Overlapping runs (a recovered schedule and the nightly one) never purge the same preview.
    for update of preview skip locked
    for update skip locked
  loop
    -- Its storage is retired with it and dropped in the background.
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = preview_row.preview_installation_id;
    expired_count := expired_count + 1;
  end loop;

  return expired_count;
end
$function$;

alter function vortex_definition.expire_abandoned_preview_installations_internal(integer)
  owner to vortex_owner;

revoke all on function vortex_definition.expire_abandoned_preview_installations_internal(integer)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_definition.expire_abandoned_preview_installations_internal(integer)
  to vortex_runtime;
comment on function vortex_definition.expire_abandoned_preview_installations_internal(integer) is
  'Removes a bounded batch of expired preview installations across organisations, for scheduled runtime maintenance only; their isolated Record storage is retired with them and dropped in the background.';

reset role;
