-- One Application publication writes the Application and its inline Modules (#2727, P5b).
-- A Module root is internal: an Application owns it, only that Application's publication
-- creates it or writes its draft, and the Application's release pins its exact releases.
set local role vortex_owner;

alter table vortex_definition.roots
  add column owner_application_root_id uuid;
alter table vortex_definition.roots
  add constraint roots_owner_application_fk
  foreign key (organization_id, owner_application_root_id)
  references vortex_definition.roots (organization_id, root_id);
alter table vortex_definition.roots
  add constraint roots_module_owner_required
  check ((kind = 'module') = (owner_application_root_id is not null));
create index roots_owner_application_idx
  on vortex_definition.roots (owner_application_root_id)
  where owner_application_root_id is not null;

drop function vortex_definition.create_root(text, text, jsonb, text, jsonb, text);

create or replace function vortex_definition.protect_root_identity() returns trigger
    language plpgsql
    set search_path to ''
    as $$
begin
  if new.root_id is distinct from old.root_id
    or new.organization_id is distinct from old.organization_id
    or new.kind is distinct from old.kind
    or new.key is distinct from old.key
    or new.owner_application_root_id is distinct from old.owner_application_root_id
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by then
    raise exception using
      errcode = '23514',
      message = 'Definition root identity, ownership, kind, key, owning Application and creation evidence are permanent';
  end if;

  return new;
end
$$;

alter function vortex_definition.protect_root_identity() owner to vortex_owner;

revoke all on function vortex_definition.protect_root_identity() from public;

grant execute on function vortex_definition.protect_root_identity() to postgres;
create or replace function vortex_definition.is_owned_module_source_internal(
  p_owner_application_root_id uuid,
  p_organization_id uuid,
  p_source jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  -- A Module source is the lowering of one inline Module of its owning Application's current
  -- draft: the same alias, key and body, naming that Application as its owner, plus the
  -- dependencies derived from its references.
  select exists (
    select 1
    from vortex_definition.roots as owner_root
    join vortex_definition.drafts as owner_draft on owner_draft.root_id = owner_root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(owner_draft.draft_source #> '{body,modules}', '[]'::jsonb)
    ) as inline_module(value)
    where owner_root.root_id = p_owner_application_root_id
      and owner_root.organization_id = p_organization_id
      and owner_root.kind = 'application'
      and p_source ->> 'kind' = 'module'
      and inline_module.value ->> 'key' = p_source ->> 'key'
      and inline_module.value ->> 'id' = p_source ->> 'root_alias'
      and p_source #>> '{body,owner_application}' = owner_root.key
      and (inline_module.value - 'id' - 'key')
        = ((p_source -> 'body') - 'dependencies' - 'owner_application')
  );
$function$;

revoke all on function vortex_definition.is_owned_module_source_internal(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_definition.is_owned_module_source_internal(uuid, uuid, jsonb) is
  'Whether a Module source is exactly one inline Module of its owning Application''s current draft.';

alter function vortex_definition.is_owned_module_source_internal(uuid, uuid, jsonb) owner to vortex_owner;
create or replace function vortex_definition.read_owned_module_roots(
  p_application_root_id uuid
)
returns table (
  root_id uuid,
  definition_key text,
  draft_revision bigint,
  current_release_revision bigint,
  source_fingerprint text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  if p_application_root_id is null or not exists (
    select 1
    from vortex_definition.roots as owner_root
    where owner_root.root_id = p_application_root_id
      and owner_root.kind = 'application'
      and owner_root.organization_id = (checked_context ->> 'organizationId')::uuid
  ) then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  return query
  select root.root_id, root.key, draft.draft_revision, root.current_release_revision,
    draft.source_fingerprint
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.owner_application_root_id = p_application_root_id
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'module'
  order by root.key collate "C", root.root_id
  limit 200;
end
$function$;

revoke all on function vortex_definition.read_owned_module_roots(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_owned_module_roots(uuid) to vortex_request;

comment on function vortex_definition.read_owned_module_roots(uuid) is
  'Lists the internal Module roots one Application owns, with their draft and current release revisions, for its publication.';

alter function vortex_definition.read_owned_module_roots(uuid) owner to vortex_owner;
create or replace function vortex_definition.create_root(
  p_kind text,
  p_key text,
  p_draft_source jsonb,
  p_source_fingerprint text,
  p_identity_requirements jsonb,
  p_application_origin_kind text,
  p_owner_application_root_id uuid
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
  new_root_id uuid;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  actor_id uuid;
  human_write boolean;
  system_projection_value boolean;
  owner_origin_kind text;
begin
  human_write := vortex_platform.current_context() ->> 'callerKind' = 'human';
  if human_write then
    -- A person creates an Application root, or an internal Module root owned by an ordinary
    -- Application they may draft: only that Application's publication creates one.
    checked_context := vortex_definition.validated_builder_draft_write_context_internal(
      case when p_kind = 'module' then p_owner_application_root_id end
    );
    if (p_kind = 'application' and p_application_origin_kind is distinct from 'ordinary')
      or (p_kind = 'module' and p_owner_application_root_id is null)
      or p_draft_source ->> 'kind' is distinct from p_kind
      or p_draft_source ->> 'key' is distinct from p_key then
      raise exception using errcode = '22023',
        message = 'Definition draft write source is invalid';
    end if;
    actor_id := (checked_context ->> 'organizationAccountId')::uuid;
  else
    checked_context := vortex_definition.validated_system_context();
    actor_id := (checked_context ->> 'systemActorId')::uuid;
  end if;

  if p_draft_source ->> 'kind' is distinct from p_kind
    or p_draft_source ->> 'key' is distinct from p_key
    or p_kind is null
    or p_kind not in ('application', 'module')
    or (p_kind = 'application' and (
      p_application_origin_kind is null
      or p_application_origin_kind not in ('ordinary', 'platform_system_application')
      or p_owner_application_root_id is not null
    ))
    or (p_kind = 'module' and (
      p_application_origin_kind is not null
      or p_owner_application_root_id is null
    )) then
    raise exception using errcode = '22023',
      message = 'Definition root source or provenance is invalid';
  end if;

  if p_kind = 'module' then
    select owner_root.application_origin_kind into owner_origin_kind
    from vortex_definition.roots as owner_root
    where owner_root.root_id = p_owner_application_root_id
      and owner_root.organization_id = (checked_context ->> 'organizationId')::uuid
      and owner_root.kind = 'application';
    if not found
      or (human_write and owner_origin_kind is distinct from 'ordinary')
      or not vortex_definition.is_owned_module_source_internal(
        p_owner_application_root_id,
        (checked_context ->> 'organizationId')::uuid,
        p_draft_source
      ) then
      raise exception using errcode = '22023',
        message = 'A Module root must be an inline Module of its owning Application';
    end if;
  end if;

  loop
    new_root_id := pg_catalog.gen_random_uuid();
    exit when new_root_id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end loop;

  system_projection_value := p_kind = 'module' and exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(p_draft_source #> '{body,record_types}', '[]'::jsonb)
    ) as record_type(value)
    where record_type.value ? 'system_projection'
  );

  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by,
    application_origin_kind, system_projection, owner_application_root_id
  ) values (
    new_root_id,
    (checked_context ->> 'organizationId')::uuid,
    p_kind,
    p_key,
    operation_at,
    actor_id,
    p_application_origin_kind,
    system_projection_value,
    p_owner_application_root_id
  );

  perform vortex_definition.record_source_identities(
    new_root_id, p_identity_requirements, actor_id, operation_at
  );

  insert into vortex_definition.drafts (
    root_id, draft_revision, draft_source, source_contract_version,
    identity_requirements, source_fingerprint, updated_at, updated_by
  ) values (
    new_root_id,
    1,
    p_draft_source,
    p_draft_source ->> 'source_contract_version',
    p_identity_requirements,
    p_source_fingerprint,
    operation_at,
    actor_id
  );

  if human_write and p_kind = 'application' then
    perform vortex_definition.validated_builder_draft_write_context_internal(new_root_id);
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
  where root.root_id = new_root_id;
end
$function$;

revoke execute on function vortex_definition.create_root(text, text, jsonb, text, jsonb, text, uuid) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.create_root(text, text, jsonb, text, jsonb, text, uuid) to vortex_request;

comment on function vortex_definition.create_root(text, text, jsonb, text, jsonb, text, uuid) is
  'Creates a Definition root with permanent component identities and initial draft atomically: an Application with explicit provenance, or an internal Module owned by the Application whose inline Module it is.';

alter function vortex_definition.create_root(p_kind text, p_key text, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb, p_application_origin_kind text, p_owner_application_root_id uuid) owner to vortex_owner;

grant execute on function vortex_definition.create_root(p_kind text, p_key text, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb, p_application_origin_kind text, p_owner_application_root_id uuid) to postgres;
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
  human_write := vortex_platform.current_context() ->> 'callerKind' = 'human';
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

  -- A Module is never authored: its draft is only ever the current lowering of the inline Module
  -- its owning Application's draft holds.
  if exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = p_root_id
      and root.kind = 'module'
      and not vortex_definition.is_owned_module_source_internal(
        root.owner_application_root_id, root.organization_id, p_draft_source
      )
  ) then
    raise exception using errcode = '22023',
      message = 'A Module draft must be an inline Module of its owning Application';
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

  if human_write and (
    checked_context ->> 'draftWriteDeadline' is null
    or (checked_context ->> 'draftWriteDeadline')::timestamptz
      <= pg_catalog.clock_timestamp()
  ) then
    raise exception using errcode = '42501',
      message = 'Definition draft write authority is unavailable';
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

alter function vortex_definition.save_draft(p_root_id uuid, p_expected_revision bigint, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb) owner to vortex_owner;

grant execute on function vortex_definition.save_draft(p_root_id uuid, p_expected_revision bigint, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb) to postgres;
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
    -- Access precedes root/draft locks, as in ordinary draft creation and saving.
    select version.current_version into locked_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = (checked_context ->> 'organizationId')::uuid
    for update;
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
create or replace function vortex_definition.list_organization_builder_roots()
returns table (
  root_id uuid,
  kind text,
  definition_key text,
  display_name text,
  draft_revision bigint,
  current_release_revision bigint,
  application_origin_kind text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or checked_context ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Definition builder root listing requires a human organization context';
  end if;

  return query
  select
    root.root_id,
    root.kind,
    root.key,
    coalesce(
      nullif(pg_catalog.btrim(draft.draft_source -> 'body' ->> 'name'), ''),
      nullif(pg_catalog.btrim(release.authored_source -> 'body' ->> 'name'), '')
    ),
    draft.draft_revision,
    root.current_release_revision,
    root.application_origin_kind
  from vortex_definition.roots as root
  left join vortex_definition.drafts as draft on draft.root_id = root.root_id
  left join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = root.current_release_revision
  where root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'application'
  order by coalesce(
    nullif(pg_catalog.btrim(draft.draft_source -> 'body' ->> 'name'), ''),
    nullif(pg_catalog.btrim(release.authored_source -> 'body' ->> 'name'), ''),
    root.key
  ), root.key, root.root_id
  limit 200;
end
$function$;

revoke all on function vortex_definition.list_organization_builder_roots()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.list_organization_builder_roots()
  to vortex_request;

comment on function vortex_definition.list_organization_builder_roots() is
  'Lists at most 200 Application roots in the validated human request organization for a permitted builder; Modules are internal to the Application that owns them.';

alter function vortex_definition.list_organization_builder_roots() owner to vortex_owner;

reset role;
