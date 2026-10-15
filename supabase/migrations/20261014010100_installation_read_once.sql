set local role vortex_owner;

create or replace function vortex_definition.read_active_installation_for_scope_internal(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_application_release_revision bigint;
  selected_bindings jsonb;
  bindings_incomplete boolean;
begin
  if p_organization_id is null or p_application_root_id is null then
    raise exception using errcode = '22023', message = 'Active Application context is required';
  end if;
  selected_organization_id := p_organization_id;
  selected_application_root_id := p_application_root_id;

  select pg_catalog.min(binding.application_release_revision)
  into selected_application_release_revision
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.state = 'active';
  if selected_application_release_revision is null then
    raise exception using errcode = 'P0002', message = 'Active Application installation is unavailable';
  end if;
  if exists (
    select 1 from vortex_definition.installation_bindings as binding
    where binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.state = 'active'
      and binding.application_release_revision <> selected_application_release_revision
  ) then
    raise exception using errcode = '55000', message = 'Active Application installation is mixed';
  end if;

  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = selected_application_release_revision
    where root.root_id = selected_application_root_id
      and root.kind = 'application'
      and root.organization_id = selected_organization_id
      and release.application_address ->> 'kind' = 'application'
  ) then
    raise exception using errcode = '23514', message = 'Active Application release evidence is invalid';
  end if;

  -- The same exact pin set is used by all three completeness checks. Materialize
  -- it within this statement so a read never traverses the release graph three
  -- times; no caller-writable state or cross-request cache is involved.
  with pins as materialized (
    select node.target_root_id, node.target_release_revision
    from vortex_definition.reachable_module_dependency_edges(
      selected_application_root_id, selected_application_release_revision
    ) as node
  )
  select not exists (select 1 from pins)
    or exists (
      select 1
      from pins as node
      left join vortex_definition.installation_bindings as binding
        on binding.organization_id = selected_organization_id
        and binding.application_root_id = selected_application_root_id
        and binding.module_root_id = node.target_root_id
      where binding.state is distinct from 'active'
        or binding.application_release_revision is distinct from selected_application_release_revision
        or binding.module_release_revision is distinct from node.target_release_revision
    ) or exists (
      select 1
      from vortex_definition.installation_bindings as binding
      where binding.organization_id = selected_organization_id
        and binding.application_root_id = selected_application_root_id
        and binding.state = 'active'
        and not exists (
          select 1 from pins as node
          where node.target_root_id = binding.module_root_id
            and node.target_release_revision = binding.module_release_revision
        )
    )
  into bindings_incomplete;
  if bindings_incomplete then
    raise exception using errcode = '55000', message = 'Active Application Module bindings are incomplete';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'organizationId', binding.organization_id,
      'applicationRootId', binding.application_root_id,
      'moduleRootId', binding.module_root_id,
      'bindingRevision', binding.binding_revision,
      'applicationReleaseRevision', binding.application_release_revision,
      'moduleReleaseRevision', binding.module_release_revision,
      'state', binding.state
    ) order by binding.module_root_id
  ) into selected_bindings
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.application_release_revision = selected_application_release_revision
    and binding.state = 'active';

  return pg_catalog.jsonb_build_object(
    'organizationId', selected_organization_id,
    'applicationRootId', selected_application_root_id,
    'applicationReleaseRevision', selected_application_release_revision,
    'moduleBindings', selected_bindings
  );
end
$function$;

alter function vortex_definition.read_active_installation_for_scope_internal(uuid,uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_active_installation_for_scope_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
-- This fixed reader serves Definition and PostgreSQL callers, and the Record
-- adapter's system-only search snapshot read, which passes only the Application
-- of its validated system context. The adapter never receives direct Module
-- table authority.
grant execute on function vortex_definition.read_active_installation_for_scope_internal(uuid, uuid)
  to postgres;
grant execute on function vortex_definition.read_active_installation_for_scope_internal(uuid, uuid)
  to vortex_owner;
grant execute on function vortex_definition.read_active_installation_for_scope_internal(uuid, uuid)
  to vortex_record_adapter;
comment on function vortex_definition.read_active_installation_for_scope_internal(uuid, uuid) is
  'Resolves the complete exact active Module binding set for one already-validated organisation/Application scope.';

create or replace function vortex_access.evaluate_record_access_with_validated_types_internal(
  p_declaration jsonb,
  p_target_record_id uuid,
  p_facts jsonb,
  p_eligibility jsonb,
  p_validated_record_types jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  declaration_binding jsonb := p_declaration -> 'recordBinding';
  facts_binding jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  record_item jsonb;
  record_scope_item jsonb;
  edge_item jsonb;
  scope_key_count integer;
  seen_type_ids text[] := array[]::text[];
  record_types_invalid boolean;
  seen_relationship_ids text[] := array[]::text[];
  seen_condition_ids text[] := array[]::text[];
  seen_record_ids text[] := array[]::text[];
  ctx jsonb;
  checked_at timestamptz;
  auth_deadline timestamptz;
  eligibility jsonb;
  decision_evidence jsonb;
  target_application_root_id uuid;
  target_record_row jsonb;
  target_ok boolean;
  matched jsonb;
  decision_valid_until text;
begin
  -- Facts shape: a closed object with exactly the declared top-level keys.
  if p_facts is null or pg_catalog.jsonb_typeof(p_facts) <> 'object'
    or not (p_facts ?& array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_facts) as supplied(key)
      where supplied.key <> all (array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    )
    or pg_catalog.jsonb_typeof(p_facts -> 'binding') <> 'object'
    or pg_catalog.jsonb_typeof(p_facts -> 'recordTypes') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'relationships') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'sharingConditions') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'records') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'edges') <> 'array' then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  facts_binding := p_facts -> 'binding';
  if not (facts_binding ?& array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(facts_binding) as supplied(key)
      where supplied.key <> all (array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    )
    or not vortex_platform.is_non_nil_uuid(facts_binding ->> 'moduleRootId')
    or not vortex_platform.is_non_nil_uuid(facts_binding ->> 'recordTypeId')
    or not vortex_platform.is_non_nil_uuid(facts_binding ->> 'storageContractId')
    or facts_binding ->> 'storageScope' not in ('organization_shared', 'application_contained') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  if pg_catalog.lower(facts_binding ->> 'moduleRootId') <> pg_catalog.lower(declaration_binding ->> 'moduleRootId')
    or pg_catalog.lower(facts_binding ->> 'recordTypeId') <> pg_catalog.lower(declaration_binding ->> 'recordTypeId')
    or pg_catalog.lower(facts_binding ->> 'storageContractId') <> pg_catalog.lower(declaration_binding ->> 'storageContractId')
    or (facts_binding ->> 'storageScope') <> (declaration_binding ->> 'storageScope') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Only the fixed record adapter can pass a type set validated earlier in
  -- this invocation. Request writable settings never authorize this shortcut.
  if p_validated_record_types is not null
    and p_validated_record_types = p_facts -> 'recordTypes' then
    select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value ->> 'recordTypeId')), array[]::text[])
    into seen_type_ids
    from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value);
  else
  -- Check the complete type and field set in one statement. Every row still
  -- receives the same shape, identity and duplicate checks; only the repeated
  -- PL/pgSQL-to-SQL call for each type and field is removed.
  select coalesce(pg_catalog.array_agg(
      pg_catalog.lower(record_type_item.value ->> 'recordTypeId')
      order by record_type_item.ordinality
    ), array[]::text[]),
    coalesce(pg_catalog.bool_or(
      pg_catalog.jsonb_typeof(record_type_item.value) <> 'object'
      or not (record_type_item.value ?& array[
        'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope', 'ownershipMode', 'fields'
      ])
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(case
          when pg_catalog.jsonb_typeof(record_type_item.value) = 'object'
            then record_type_item.value else '{}'::jsonb end
        ) as supplied(key)
        where supplied.key <> all (array[
          'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope',
          'ownershipMode', 'ownershipRelationshipId', 'validationContractVersion', 'fields'
        ])
      )
      or not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'moduleRootId')
      or not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'recordTypeId')
      or not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'storageContractId')
      or record_type_item.value ->> 'storageScope' not in ('organization_shared', 'application_contained')
      or record_type_item.value ->> 'ownershipMode' not in ('none', 'organization_account', 'group', 'inherited')
      or ((record_type_item.value ? 'ownershipRelationshipId') <>
        (record_type_item.value ->> 'ownershipMode' = 'inherited'))
      or (record_type_item.value ? 'ownershipRelationshipId'
        and not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'ownershipRelationshipId'))
      or (record_type_item.value ? 'validationContractVersion' and (
        pg_catalog.jsonb_typeof(record_type_item.value -> 'validationContractVersion') <> 'string'
        or record_type_item.value ->> 'validationContractVersion'
          <> all (vortex_definition.accepted_contract_version('record_type'))
      ))
      or pg_catalog.jsonb_typeof(record_type_item.value -> 'fields') <> 'array'
      or fields.invalid
      or fields.duplicate_ids
    ), false)
      or pg_catalog.count(*) <> pg_catalog.count(distinct
        pg_catalog.lower(record_type_item.value ->> 'recordTypeId'))
  into seen_type_ids, record_types_invalid
  from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes')
    with ordinality as record_type_item(value, ordinality)
  cross join lateral (
    select coalesce(pg_catalog.bool_or(
      pg_catalog.jsonb_typeof(field_item.value) <> 'object'
      or not (field_item.value ?& array['fieldId', 'type'])
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(case
          when pg_catalog.jsonb_typeof(field_item.value) = 'object'
            then field_item.value else '{}'::jsonb end
        ) as supplied(key)
        where supplied.key <> all (array['fieldId', 'type', 'settings'])
      )
      or not vortex_platform.is_non_nil_uuid(field_item.value ->> 'fieldId')
      or pg_catalog.jsonb_typeof(field_item.value -> 'type') <> 'string'
      or (field_item.value ? 'settings'
        and pg_catalog.jsonb_typeof(field_item.value -> 'settings') <> 'object')
    ), false) as invalid,
    pg_catalog.count(*) <> pg_catalog.count(distinct
      pg_catalog.lower(field_item.value ->> 'fieldId')) as duplicate_ids
    from pg_catalog.jsonb_array_elements(case
      when pg_catalog.jsonb_typeof(record_type_item.value -> 'fields') = 'array'
        then record_type_item.value -> 'fields' else '[]'::jsonb end
    ) as field_item(value)
  ) as fields;
  if record_types_invalid then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  end if;

  if not (pg_catalog.lower(facts_binding ->> 'recordTypeId') = any (seen_type_ids)) then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Relationships: unique identity, well-formed endpoints. `toRecordTypes`
  -- is every declared target: one for a link, several for a link to one of
  -- several record types.
  for relationship_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
  loop
    if pg_catalog.jsonb_typeof(relationship_item) <> 'object'
      or not (relationship_item ?& array[
        'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
      ])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(relationship_item) as supplied(key)
        where supplied.key <> all (array[
          'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
        ])
      )
      or not vortex_platform.is_non_nil_uuid(relationship_item ->> 'relationshipId')
      or not vortex_platform.is_non_nil_uuid(relationship_item ->> 'fromModuleRootId')
      or not vortex_platform.is_non_nil_uuid(relationship_item ->> 'fromRecordTypeId')
      or pg_catalog.jsonb_typeof(relationship_item -> 'toRecordTypes') is distinct from 'array'
      or pg_catalog.jsonb_array_length(relationship_item -> 'toRecordTypes') = 0
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(relationship_item -> 'toRecordTypes') as target(value)
        where pg_catalog.jsonb_typeof(target.value) <> 'object'
          or not (target.value ?& array['moduleRootId', 'recordTypeId'])
          or exists (
            select 1 from pg_catalog.jsonb_object_keys(target.value) as supplied(key)
            where supplied.key <> all (array['moduleRootId', 'recordTypeId'])
          )
          or not vortex_platform.is_non_nil_uuid(target.value ->> 'moduleRootId')
          or not vortex_platform.is_non_nil_uuid(target.value ->> 'recordTypeId')
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(relationship_item ->> 'relationshipId') = any (seen_relationship_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_relationship_ids := pg_catalog.array_append(
      seen_relationship_ids, pg_catalog.lower(relationship_item ->> 'relationshipId')
    );
  end loop;

  -- Sharing conditions: unique identity, the fields the row-scope composition
  -- and the saved-condition predicate actually consume. Extra compiled-release
  -- fields (key, publicationTests, ...) are passed through untouched.
  for condition_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'sharingConditions') as item(value)
  loop
    if pg_catalog.jsonb_typeof(condition_item) <> 'object'
      or not (condition_item ?& array[
        'conditionId', 'sourceRecordTypeId', 'publishedRevision', 'contractFingerprint',
        'parameters', 'condition', 'declaredFieldIds'
      ])
      or not vortex_platform.is_non_nil_uuid(condition_item ->> 'conditionId')
      or not vortex_platform.is_non_nil_uuid(condition_item ->> 'sourceRecordTypeId')
      or pg_catalog.jsonb_typeof(condition_item -> 'publishedRevision') <> 'number'
      or pg_catalog.jsonb_typeof(condition_item -> 'contractFingerprint') <> 'string'
      or pg_catalog.jsonb_typeof(condition_item -> 'parameters') <> 'array'
      or pg_catalog.jsonb_typeof(condition_item -> 'condition') <> 'object'
      or pg_catalog.jsonb_typeof(condition_item -> 'declaredFieldIds') <> 'array' then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(condition_item ->> 'conditionId') = any (seen_condition_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_condition_ids := pg_catalog.array_append(
      seen_condition_ids, pg_catalog.lower(condition_item ->> 'conditionId')
    );
  end loop;

  -- Records: unique identity, well-formed record-identity scope, known type.
  for record_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_item) <> 'object'
      or not (record_item ?& array['recordScope', 'lifecycleState', 'fieldValues'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(record_item) as supplied(key)
        where supplied.key <> all (array[
          'recordScope', 'ownerOrganizationAccountId', 'ownerGroupId', 'lifecycleState', 'fieldValues'
        ])
      )
      or pg_catalog.jsonb_typeof(record_item -> 'recordScope') <> 'object'
      or record_item ->> 'lifecycleState' not in ('active', 'soft_deleted', 'removal_pending')
      or pg_catalog.jsonb_typeof(record_item -> 'fieldValues') <> 'object'
      or (record_item ? 'ownerOrganizationAccountId'
        and not vortex_platform.is_non_nil_uuid(record_item ->> 'ownerOrganizationAccountId'))
      or (record_item ? 'ownerGroupId'
        and not vortex_platform.is_non_nil_uuid(record_item ->> 'ownerGroupId'))
      or (record_item ? 'ownerOrganizationAccountId' and record_item ? 'ownerGroupId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    record_scope_item := record_item -> 'recordScope';
    select pg_catalog.count(*) into scope_key_count
    from pg_catalog.jsonb_object_keys(record_scope_item) as supplied(key);

    if not (record_scope_item ?& array[
        'storageScope', 'organizationId', 'moduleRootId', 'recordTypeId', 'storageContractId', 'recordId'
      ])
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'organizationId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'moduleRootId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'recordTypeId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'storageContractId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'recordId')
      or (record_scope_item ->> 'storageScope') not in ('organization_shared', 'application_contained')
      or (
        (record_scope_item ->> 'storageScope') = 'organization_shared'
        and (scope_key_count <> 6 or record_scope_item ? 'applicationRootId')
      )
      or (
        (record_scope_item ->> 'storageScope') = 'application_contained'
        and (scope_key_count <> 7 or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'applicationRootId'))
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(record_scope_item ->> 'recordTypeId') = any (seen_type_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(record_scope_item ->> 'recordId') = any (seen_record_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_record_ids := pg_catalog.array_append(seen_record_ids, pg_catalog.lower(record_scope_item ->> 'recordId'));
  end loop;

  -- Edges: well-formed, no dangling relationship or missing endpoint record.
  -- Duplicate/ambiguous edges are a functional refusal inside the row-scope
  -- composition, not a facts-shape violation, so they are not rejected here.
  for edge_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
  loop
    if pg_catalog.jsonb_typeof(edge_item) <> 'object'
      or not (edge_item ?& array['relationshipId', 'fromRecordId', 'toRecordId'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(edge_item) as supplied(key)
        where supplied.key <> all (array['relationshipId', 'fromRecordId', 'toRecordId'])
      )
      or not vortex_platform.is_non_nil_uuid(edge_item ->> 'relationshipId')
      or not vortex_platform.is_non_nil_uuid(edge_item ->> 'fromRecordId')
      or not vortex_platform.is_non_nil_uuid(edge_item ->> 'toRecordId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(edge_item ->> 'relationshipId') = any (seen_relationship_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    if not (pg_catalog.lower(edge_item ->> 'fromRecordId') = any (seen_record_ids))
      or not (pg_catalog.lower(edge_item ->> 'toRecordId') = any (seen_record_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
  end loop;

  -- One Access-version observation, one time sample, shared by the eligibility
  -- call and every row-scope composition below.
  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();

  if p_eligibility is null then
    eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
      p_declaration, ctx, checked_at
    );
  else
    -- Only the fixed record adapter supplies page-local eligibility. The
    -- request role cannot execute this variant or supply a forged decision.
    eligibility := p_eligibility;
    if eligibility ->> 'outcome' is distinct from 'eligible'
      or eligibility -> 'recordBinding' is distinct from p_declaration -> 'recordBinding'
      or eligibility -> 'target' is distinct from p_declaration -> 'target'
      or eligibility ->> 'organizationId' is distinct from ctx ->> 'organizationId'
      or eligibility ->> 'organizationAccountId' is distinct from ctx ->> 'organizationAccountId'
      or eligibility ->> 'accessVersion' is distinct from ctx ->> 'accessVersion'
      or eligibility ->> 'correlationId' is distinct from ctx ->> 'correlationId'
      or (eligibility ->> 'validUntil')::timestamptz <= checked_at then
      raise exception using errcode = '22023', message = 'Page record eligibility is invalid';
    end if;
  end if;

  decision_evidence := (eligibility - 'outcome' - 'validUntil' - 'eligiblePermissions' - 'reasonCode')
    || pg_catalog.jsonb_build_object(
      'recordId', p_target_record_id, 'action', p_declaration -> 'action',
      'checkedAt', pg_catalog.to_char(pg_catalog.timezone('UTC', checked_at),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    );

  if eligibility ->> 'outcome' = 'refused' then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', eligibility ->> 'reasonCode'
    );
  end if;

  target_application_root_id := (p_declaration -> 'target' ->> 'applicationRootId')::uuid;

  -- Target row check: fail closed, never raise. This is the cross-organisation
  -- and cross-application isolation path.
  select value into target_record_row
  from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  where (value -> 'recordScope' ->> 'recordId')::uuid = p_target_record_id
  limit 1;

  target_ok := target_record_row is not null
    and (target_record_row -> 'recordScope' ->> 'organizationId')::uuid = (ctx ->> 'organizationId')::uuid
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'moduleRootId') = pg_catalog.lower(facts_binding ->> 'moduleRootId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'recordTypeId') = pg_catalog.lower(facts_binding ->> 'recordTypeId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'storageContractId') = pg_catalog.lower(facts_binding ->> 'storageContractId')
    and (target_record_row -> 'recordScope' ->> 'storageScope') = (facts_binding ->> 'storageScope')
    and (
      (facts_binding ->> 'storageScope') = 'organization_shared'
      or (target_record_row -> 'recordScope' ->> 'applicationRootId')::uuid = target_application_root_id
    )
    and target_record_row ->> 'lifecycleState' = 'active';

  if not target_ok then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  auth_deadline := vortex_access.recent_authentication_deadline_internal(
    ctx, checked_at, p_declaration -> 'recentAuthentication'
  );

  select coalesce(
    pg_catalog.jsonb_agg(
      contribution.value
      order by
        alt.ordinality,
        case contribution.value -> 'route' ->> 'kind'
          when 'all_records' then 0
          when 'ownership' then 1
          when 'direct_share' then 2
          when 'relationship' then 3
        end,
        coalesce(
          contribution.value -> 'route' ->> 'directShareId',
          contribution.value -> 'route' ->> 'sourceRecordId',
          ''
        )
    ),
    '[]'::jsonb
  )
  into matched
  from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions')
    with ordinality as alt(value, ordinality)
  cross join lateral pg_catalog.jsonb_array_elements(
    vortex_access.evaluate_record_permission_row_scope_internal(
      ctx,
      checked_at,
      auth_deadline,
      target_application_root_id,
      p_declaration -> 'action',
      alt.value,
      p_target_record_id,
      p_facts,
      array[(alt.value -> 'permission' ->> 'permissionId')::uuid]
    )
  ) as contribution(value);

  if pg_catalog.jsonb_array_length(matched) = 0 then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  select vortex_platform.format_timestamp_utc(
    pg_catalog.min((elem.value ->> 'validUntil')::timestamptz)
  )
  into decision_valid_until
  from pg_catalog.jsonb_array_elements(matched) as elem(value);

  return decision_evidence || pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'validUntil', decision_valid_until,
    'matchedContributions', matched
  );
end
$function$;

alter function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb)
  to vortex_record_adapter, postgres;
comment on function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb) is
  'Exact record access evaluation for the ordinary wrapper or page-local eligibility supplied by the fixed record adapter; validates each record fact set and composes each record scope independently.';

reset role;
