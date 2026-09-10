-- Single Definition-owned Module dependency reachability walk. The
-- installation reader carried three separate copies of this recursive walk
-- and the storage provisioner carried a fourth, direct-edge-only copy that
-- disagreed with the other three. Extract the walk once and have all four
-- sites use it; nothing about what the reader returns changes.

create function vortex_definition.reachable_module_dependency_edges(
  p_root_id uuid,
  p_release_revision bigint
)
returns table (
  target_root_id uuid,
  target_release_revision bigint,
  dependency_reference text,
  dependency_version text,
  dependency_content_fingerprint text,
  evidence_fingerprint text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with recursive module_edges as (
    select dependency.target_root_id, dependency.target_release_revision,
      dependency.dependency_reference, dependency.dependency_version,
      dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
    from vortex_definition.release_dependencies as dependency
    where dependency.root_id = p_root_id
      and dependency.release_revision = p_release_revision
      and dependency.dependency_kind = 'module'
    union
    select dependency.target_root_id, dependency.target_release_revision,
      dependency.dependency_reference, dependency.dependency_version,
      dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
    from module_edges as parent
    join vortex_definition.release_dependencies as dependency
      on dependency.root_id = parent.target_root_id
      and dependency.release_revision = parent.target_release_revision
      and dependency.dependency_kind = 'module'
  )
  select target_root_id, target_release_revision, dependency_reference,
    dependency_version, dependency_content_fingerprint, evidence_fingerprint
  from module_edges
$function$;

revoke all on function vortex_definition.reachable_module_dependency_edges(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.reachable_module_dependency_edges(uuid, bigint)
  to vortex_module_owner;
comment on function vortex_definition.reachable_module_dependency_edges(uuid, bigint) is
  'Owner-private recursive Module dependency closure from one exact release; the one reachability walk shared by the Definition reader and Record storage provisioning.';

-- vortex_definition.read_application_bound_release_set: the three inline
-- recursive walks are replaced by calls to the shared resolver above.
-- Signature, volatility, security mode, search path, validation order and
-- returned evidence are otherwise unchanged.
create or replace function vortex_definition.read_application_bound_release_set(
  p_application_release_revision bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  application_root_id uuid;
  application_evidence jsonb;
  module_evidence jsonb;
begin
  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId'
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Application release-set context is invalid';
  end if;
  application_root_id := (checked_context ->> 'applicationRootId')::uuid;

  select vortex_definition.project_consumer_release_evidence(
    'application', root.root_id, p_application_release_revision
  ) into application_evidence
  from vortex_definition.roots as root
  where root.root_id = application_root_id
    and root.kind = 'application'
    and root.organization_id = (checked_context ->> 'organizationId')::uuid;
  if application_evidence is null then
    raise exception using errcode = 'P0002', message = 'Exact bound Application release is unavailable';
  end if;

  select pg_catalog.jsonb_agg(
    vortex_definition.project_consumer_release_evidence(
      'module', selected.target_root_id, selected.target_release_revision
    ) order by selected.target_root_id
  ) into module_evidence
  from (
    select distinct edge.target_root_id, edge.target_release_revision
    from vortex_definition.reachable_module_dependency_edges(
      application_root_id, p_application_release_revision
    ) as edge
  ) as selected;

  if module_evidence is null then
    raise exception using errcode = '23514', message = 'Application has no exact Module dependency set';
  end if;

  if exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      application_root_id, p_application_release_revision
    ) as edge
    left join vortex_definition.roots as root on root.root_id = edge.target_root_id
    left join vortex_definition.releases as release
      on release.root_id = edge.target_root_id
      and release.release_revision = edge.target_release_revision
    where root.kind is distinct from 'module'
      or root.key is distinct from edge.dependency_reference
      or release.release_version is distinct from edge.dependency_version
      or release.content_fingerprint is distinct from edge.dependency_content_fingerprint
      or release.resolution_fingerprint is distinct from edge.evidence_fingerprint
  ) or exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      application_root_id, p_application_release_revision
    ) as edge
    group by edge.target_root_id
    having pg_catalog.count(distinct edge.target_release_revision) <> 1
  ) then
    raise exception using errcode = '23514', message = 'Exact bound Module dependency evidence is inconsistent';
  end if;

  return pg_catalog.jsonb_build_object(
    'correlationId', checked_context ->> 'correlationId',
    'application', application_evidence,
    'modules', module_evidence
  );
end
$function$;

revoke all on function vortex_definition.read_application_bound_release_set(bigint)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_application_bound_release_set(bigint)
  to vortex_request;
comment on function vortex_definition.read_application_bound_release_set(bigint) is
  'Returns the exact local Application and complete exact Module dependency closure selected by validated human application context.';

-- vortex_module.provision_module_installation_storage: the direct-edge-only
-- dependency check is replaced by a reachable-set membership check against
-- the same shared resolver. Every other check, lock, and retry/idempotency
-- path below is byte-identical to the delivered function. postgres does not
-- retain CREATE on vortex_module between migrations (it is granted and
-- revoked inside the owning migration's own transaction), so the replace
-- runs as the function's existing owner, which always has rights on its own
-- schema and object.
set local role vortex_module_owner;
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
  content_fingerprint text,
  resolution_fingerprint text,
  generator_contract_version text,
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
  if application_release.validation_contract_version <> '1.0.0'
    or application_release.compilation_output #>> '{kind}' <> 'application'
    or application_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> p_application_root_id::text
    or application_release.compilation_output #>> '{validationContractVersion}' <> '1.0.0' then
    raise exception using errcode = '23514', message = 'Exact Application V1 release is unavailable';
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
    if stored_binding.state = 'active'
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
    if stored_binding.content_fingerprint <> provision.content_fingerprint
      or stored_binding.resolution_fingerprint <> provision.resolution_fingerprint
      or stored_binding.generator_contract_version <> provision.generator_contract_version
      or stored_binding.storage_contract_ids <> provision.storage_contract_ids then
      raise exception using errcode = '55000', message = 'Stored Module installation evidence is incompatible';
    end if;
    return query select stored_binding.state, false, stored_binding.binding_revision,
      stored_binding.application_root_id, stored_binding.application_release_revision,
      stored_binding.module_root_id, stored_binding.module_release_revision,
      stored_binding.content_fingerprint, stored_binding.resolution_fingerprint,
      stored_binding.generator_contract_version, stored_binding.storage_contract_ids;
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
        content_fingerprint = provision.content_fingerprint,
        resolution_fingerprint = provision.resolution_fingerprint,
        generator_contract_version = provision.generator_contract_version,
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
      content_fingerprint, resolution_fingerprint, generator_contract_version,
      storage_contract_ids
    ) values (
      permission_decision.organization_id, p_application_root_id, p_module_root_id, 1,
      p_application_release_revision, p_module_release_revision, 'provisioned',
      provision.content_fingerprint, provision.resolution_fingerprint,
      provision.generator_contract_version, provision.storage_contract_ids
    );
  end if;

  return query select 'provisioned'::text, true, next_binding_revision,
    p_application_root_id, p_application_release_revision, p_module_root_id,
    p_module_release_revision, provision.content_fingerprint,
    provision.resolution_fingerprint, provision.generator_contract_version,
    provision.storage_contract_ids;
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
