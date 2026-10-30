set role vortex_owner;

-- Record access is decided for a set of targets: the facts loaders and the
-- organisation record access decision take a set and return one result per
-- target. The single-record decision and its eligibility wrapper are removed.
drop function vortex_access.evaluate_organization_record_access_internal(jsonb, uuid, jsonb);
drop function vortex_access.evaluate_organization_record_access_with_eligibility_internal(jsonb, uuid, jsonb, jsonb);

-- The installed-contribution pins of every facts load start from the storage
-- catalogue rows of the installation's Modules. The catalogue is small enough
-- never to be analysed automatically, so without this index the planner walks
-- every field mapping instead.
create index storage_catalogue_active_module_idx
  on vortex_record.storage_catalogue (module_root_id)
  where state = 'active';

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
  condition_item jsonb;
  record_item jsonb;
  record_scope_item jsonb;
  edge_item jsonb;
  scope_key_count integer;
  seen_type_ids text[] := array[]::text[];
  record_types_invalid boolean;
  seen_relationship_ids text[] := array[]::text[];
  relationships_invalid boolean;
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
  -- several record types. The whole set is checked in one statement, like the
  -- type set: every relationship receives the same shape, identity and
  -- duplicate checks without a PL/pgSQL round trip for each one.
  select coalesce(pg_catalog.array_agg(
      pg_catalog.lower(relationship_item.value ->> 'relationshipId')
      order by relationship_item.ordinality
    ), array[]::text[]),
    coalesce(pg_catalog.bool_or(
      pg_catalog.jsonb_typeof(relationship_item.value) <> 'object'
      or not (relationship_item.value ?& array[
        'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
      ])
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(case
          when pg_catalog.jsonb_typeof(relationship_item.value) = 'object'
            then relationship_item.value else '{}'::jsonb end
        ) as supplied(key)
        where supplied.key <> all (array[
          'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
        ])
      )
      or not vortex_platform.is_non_nil_uuid(relationship_item.value ->> 'relationshipId')
      or not vortex_platform.is_non_nil_uuid(relationship_item.value ->> 'fromModuleRootId')
      or not vortex_platform.is_non_nil_uuid(relationship_item.value ->> 'fromRecordTypeId')
      or pg_catalog.jsonb_typeof(relationship_item.value -> 'toRecordTypes') is distinct from 'array'
      or pg_catalog.jsonb_array_length(case
        when pg_catalog.jsonb_typeof(relationship_item.value -> 'toRecordTypes') = 'array'
          then relationship_item.value -> 'toRecordTypes' else '[]'::jsonb end
      ) = 0
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(case
          when pg_catalog.jsonb_typeof(relationship_item.value -> 'toRecordTypes') = 'array'
            then relationship_item.value -> 'toRecordTypes' else '[]'::jsonb end
        ) as target(value)
        where pg_catalog.jsonb_typeof(target.value) <> 'object'
          or not (target.value ?& array['moduleRootId', 'recordTypeId'])
          or exists (
            select 1
            from pg_catalog.jsonb_object_keys(case
              when pg_catalog.jsonb_typeof(target.value) = 'object'
                then target.value else '{}'::jsonb end
            ) as supplied(key)
            where supplied.key <> all (array['moduleRootId', 'recordTypeId'])
          )
          or not vortex_platform.is_non_nil_uuid(target.value ->> 'moduleRootId')
          or not vortex_platform.is_non_nil_uuid(target.value ->> 'recordTypeId')
      )
    ), false)
      or pg_catalog.count(*) <> pg_catalog.count(distinct
        pg_catalog.lower(relationship_item.value ->> 'relationshipId'))
  into seen_relationship_ids, relationships_invalid
  from pg_catalog.jsonb_array_elements(p_facts -> 'relationships')
    with ordinality as relationship_item(value, ordinality);
  if relationships_invalid then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

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
    -- Only the fixed record adapter supplies eligibility it decided once for a
    -- page or a set of targets; a refusal is supplied as decided. The request
    -- role cannot execute this variant or supply a forged decision.
    eligibility := p_eligibility;
    if coalesce(eligibility ->> 'outcome', '') not in ('eligible', 'refused')
      or eligibility -> 'recordBinding' is distinct from p_declaration -> 'recordBinding'
      or eligibility -> 'target' is distinct from p_declaration -> 'target'
      or eligibility ->> 'organizationId' is distinct from ctx ->> 'organizationId'
      or eligibility ->> 'organizationAccountId' is distinct from ctx ->> 'organizationAccountId'
      or eligibility ->> 'accessVersion' is distinct from ctx ->> 'accessVersion'
      or eligibility ->> 'correlationId' is distinct from ctx ->> 'correlationId'
      or (eligibility ->> 'outcome' = 'eligible'
        and (eligibility ->> 'validUntil')::timestamptz <= checked_at) then
      raise exception using errcode = '22023', message = 'Supplied record eligibility is invalid';
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
  'Exact record access evaluation of one target, with eligibility computed here or supplied by the fixed record adapter (decided once per declaration for a set of targets or a page); validates each record fact set and composes each record scope independently.';

create or replace function vortex_access.evaluate_organization_record_access_internal(
  p_targets jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb;
  checked_at timestamptz;
  target_item record;
  eligibility_by_declaration jsonb := '[]'::jsonb;
  eligibility jsonb;
  validated_record_types jsonb[] := array[]::jsonb[];
  validated jsonb;
  decisions jsonb[] := array[]::jsonb[];
begin
  -- Each target is one exact record under one action declaration and its
  -- facts; the result holds one complete decision per target in the same
  -- order. Eligibility is decided once per distinct declaration and a record
  -- type set is validated once per call; every target still receives its own
  -- facts checks, target row check and row-scope composition.
  if pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) not between 1 and 200
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_targets) as target(value)
      where pg_catalog.jsonb_typeof(target.value) is distinct from 'object'
        or not (target.value ?& array['declaration', 'recordId', 'facts'])
        or exists (
          select 1 from pg_catalog.jsonb_object_keys(case
            when pg_catalog.jsonb_typeof(target.value) = 'object' then target.value
            else '{}'::jsonb end) as supplied(key)
          where supplied.key <> all (array['declaration', 'recordId', 'facts'])
        )
        or pg_catalog.jsonb_typeof(target.value -> 'declaration') is distinct from 'object'
        or pg_catalog.jsonb_typeof(target.value -> 'facts') is distinct from 'object'
        or not vortex_platform.is_non_nil_uuid(target.value ->> 'recordId')
    ) then
    raise exception using errcode = '22023', message = 'Record access targets are invalid';
  end if;

  -- One Access-version observation and one time sample for every eligibility
  -- decision of the call.
  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();

  for target_item in
    select target.value
    from pg_catalog.jsonb_array_elements(p_targets) with ordinality as target(value, ordinality)
    order by target.ordinality
  loop
    select decided.value -> 'eligibility' into eligibility
    from pg_catalog.jsonb_array_elements(eligibility_by_declaration) as decided(value)
    where decided.value -> 'declaration' = target_item.value -> 'declaration';
    if eligibility is null then
      eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
        target_item.value -> 'declaration', ctx, checked_at
      );
      eligibility_by_declaration := eligibility_by_declaration || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'declaration', target_item.value -> 'declaration', 'eligibility', eligibility
        )
      );
    end if;

    validated := case
      when target_item.value -> 'facts' -> 'recordTypes' = any (validated_record_types)
        then target_item.value -> 'facts' -> 'recordTypes'
      else null end;
    decisions := decisions || vortex_access.evaluate_record_access_with_validated_types_internal(
      target_item.value -> 'declaration', (target_item.value ->> 'recordId')::uuid,
      target_item.value -> 'facts', eligibility, validated
    );
    if validated is null then
      validated_record_types := validated_record_types || (target_item.value -> 'facts' -> 'recordTypes');
    end if;
  end loop;

  return pg_catalog.to_jsonb(decisions);
end
$function$;

revoke execute on function vortex_access.evaluate_organization_record_access_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_record_access_internal(jsonb)
  to vortex_record_adapter;
comment on function vortex_access.evaluate_organization_record_access_internal(jsonb) is
  'The complete exact-record access decision for a set of targets, one per target in order: unions every eligible alternative''s own complete row scope and always carries the exact recordId. Eligibility once per distinct declaration and each record type set validated once per call. Owner-only except for the fixed record adapter.';

alter function vortex_access.evaluate_organization_record_access_internal(p_targets jsonb) owner to vortex_owner;

grant execute on function vortex_access.evaluate_organization_record_access_internal(p_targets jsonb) to postgres;

create or replace function vortex_record.read_record_projection_with_validated_types_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_page_declaration jsonb,
  p_page_eligibility jsonb,
  p_validated_record_types jsonb,
  p_projection_row jsonb,
  p_loaded jsonb,
  p_decision jsonb,
  p_bounds jsonb,
  p_page jsonb
)
returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  loaded jsonb;
  -- The page-wide part of the facts (the envelope) when this record arrives
  -- as a compact record scope; otherwise the record's own complete facts.
  shared jsonb;
  compact boolean;
  decision jsonb;
  bounds jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
  field_values jsonb;
  read_time_fields jsonb;
  read_time_clock jsonb;
  read_time_expression jsonb;
  read_time_value jsonb;
  preview_meta jsonb;
  preview_bounds jsonb;
  due_key text;
  status_key text;
  due_value jsonb;
  status_value jsonb;
  batched boolean := false;
  requested_field_ids jsonb := nullif(p_page -> 'requestedFieldIds', 'null'::jsonb);
  projected_field_ids jsonb;
  stored_field_ids jsonb;
  selected_fields jsonb;
  selected_value_expression text;
  selected_values jsonb;
  selected_loaded jsonb;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    projection := pg_catalog.jsonb_build_object('outcome', 'refused');
    return next;
    return;
  end if;
  -- A page passes the page-wide part of the facts once (p_page.envelope) and
  -- each decided record as its compact record scope; the complete facts are
  -- rebuilt only on the paths that read more than this record's own values.
  compact := p_loaded is not null and p_loaded ? 'record'
    and pg_catalog.jsonb_typeof(p_page -> 'envelope') = 'object';
  if p_loaded is not null and p_loaded ? 'record' and not compact then
    raise exception using errcode = '22023', message = 'Page record facts are invalid';
  end if;
  loaded := case when compact then null else p_loaded end;
  if loaded is null and not compact then
    if p_page ? 'installation' then
      -- The installation and access plan this invocation's caller read,
      -- validated and resolved once for the whole page.
      loaded := (vortex_record.load_record_access_facts_with_plan_internal(
        'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', p_record_id,
          'projectionRow', p_projection_row,
          'requestedFieldIds', case when requested_field_ids is null then null else '[]'::jsonb end
        )),
        p_page -> 'installation', p_page -> 'plan'
      ) -> 0);
    else
      loaded := (vortex_record.load_record_access_facts_internal(
        'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', p_record_id,
          'projectionRow', p_projection_row,
          'requestedFieldIds', case when requested_field_ids is null then null else '[]'::jsonb end
        ))
      ) -> 0);
    end if;
  end if;
  shared := case when compact then p_page -> 'envelope' else loaded end;
  if p_loaded is not null and shared ->> 'outcome' = 'loaded' and (
    shared -> 'facts' -> 'binding' ->> 'recordTypeId' is distinct from
      pg_catalog.lower(p_record_type_id::text)
    or case when compact
      then p_loaded -> 'record' -> 'recordScope' ->> 'recordId' is distinct from pg_catalog.lower(p_record_id::text)
      else not exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
        where item.value -> 'recordScope' ->> 'recordId' = pg_catalog.lower(p_record_id::text)
      ) end
  ) then
    raise exception using errcode = '22023', message = 'Page record facts are invalid';
  end if;
  if shared ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(shared -> 'declaration') <> 'object' then
    projection := pg_catalog.jsonb_build_object('outcome', 'refused');
    return next;
    return;
  end if;
  if shared ? 'previewInstallationId' then
    if p_page -> 'envelope' -> 'previewInstallationId' = shared -> 'previewInstallationId'
      and pg_catalog.jsonb_typeof(p_page -> 'previewBounds') = 'object' then
      preview_bounds := p_page -> 'previewBounds';
    else
      loaded := coalesce(loaded, vortex_record.read_record_page_row_facts_internal(shared, p_loaded));
      preview_meta := vortex_record.resolve_record_action_context_internal(
        p_record_type_id, 'read'
      );
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (preview_meta ->> 'storageContractId')::uuid,
        preview_meta -> 'recordType'
      );
    end if;
    if preview_bounds is null then
      projection := pg_catalog.jsonb_build_object('outcome', 'refused');
      return next;
      return;
    end if;
    bounds := preview_bounds;
  else
    if p_decision is not null then
      -- The page's set pass decided this exact record in this invocation from
      -- these facts; only the fixed record adapter can pass it.
      if p_loaded is null
        or p_decision ->> 'recordId' is distinct from pg_catalog.lower(p_record_id::text) then
        raise exception using errcode = '22023', message = 'Page record decision is invalid';
      end if;
      -- It is used only while it is still current now: an allowed decision
      -- whose own deadline (every matched permission path, share and group
      -- membership) and the page eligibility are both still in the future.
      -- Anything else is decided again exactly, at this row's own time.
      batched := coalesce(p_decision ->> 'outcome' = 'allowed'
        and (p_decision ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp()
        and p_page_eligibility ->> 'outcome' = 'eligible'
        and (p_page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp(), false);
    end if;
    if batched then
      decision := p_decision;
    else
      loaded := coalesce(loaded, vortex_record.read_record_page_row_facts_internal(shared, p_loaded));
      if p_page_eligibility ->> 'outcome' = 'eligible'
        and loaded -> 'declaration' = p_page_declaration
        and (p_page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp() then
        decision := vortex_access.evaluate_record_access_with_validated_types_internal(
          loaded -> 'declaration', p_record_id, loaded -> 'facts', p_page_eligibility,
          p_validated_record_types
        );
      else
        decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'declaration', loaded -> 'declaration',
            'recordId', p_record_id,
            'facts', loaded -> 'facts'
          )
        )) -> 0);
      end if;
    end if;
    if decision ->> 'outcome' <> 'allowed' then
      projection := pg_catalog.jsonb_build_object('outcome', 'refused');
      -- A decision, even a refusal, means the record types passed validation;
      -- the page reuses them. Callers read read_facts only for allowed rows.
      read_facts := pg_catalog.jsonb_build_object(
        'validatedRecordTypes', shared -> 'facts' -> 'recordTypes'
      );
      return next;
      return;
    end if;
    bounds := coalesce(case when batched then p_bounds end,
      vortex_record.decide_record_field_bounds_internal(decision));
  end if;
  -- Keep full access bounds for capabilities; intersect only the values requested by the screen.
  projected_field_ids := bounds -> 'readableFieldIds';
  if requested_field_ids is not null then
    select coalesce(pg_catalog.jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into projected_field_ids
    from pg_catalog.jsonb_array_elements(projected_field_ids) with ordinality as item(value, ordinality)
    where requested_field_ids ? (item.value #>> '{}');
  end if;
  if requested_field_ids is not null and not compact then
    if (loaded ->> 'isSystemProjection')::boolean then
      -- Protected projections keep their bounded reader; never scan their composite view.
      selected_loaded := (vortex_record.load_record_access_facts_internal(
        'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', p_record_id,
          'projectionRow', p_projection_row,
          'requestedFieldIds', projected_field_ids
        ))
      ) -> 0);
      if selected_loaded ->> 'concurrencyNumber' is distinct from loaded ->> 'concurrencyNumber' then
        projection := pg_catalog.jsonb_build_object('outcome', 'refused');
        return next;
        return;
      end if;
      selected_values := selected_loaded -> 'fieldValues';
    else
      -- Decide access from condition operands first, then fetch only requested readable values.
      -- A concurrent record change cannot splice new values into the earlier access decision.
      select coalesce(pg_catalog.jsonb_agg(distinct item.value), '[]'::jsonb)
      into stored_field_ids
      from (
        select value from pg_catalog.jsonb_array_elements(projected_field_ids)
        union all
        select dependency.value
        from pg_catalog.jsonb_array_elements(loaded #> '{recordTypeMeta,fields}') as field(value)
        cross join lateral (values
          (field.value #> '{settings,expression,due,reference,fieldId}'),
          (field.value #> '{settings,expression,status,reference,fieldId}')
        ) as dependency(value)
        where projected_field_ids ? pg_catalog.lower(field.value ->> 'fieldId')
          and field.value ->> 'type' = 'calculation' and dependency.value is not null
      ) as item(value);
      select coalesce(pg_catalog.jsonb_agg(field.value), '[]'::jsonb) into selected_fields
      from pg_catalog.jsonb_array_elements(loaded #> '{recordTypeMeta,fields}') as field(value)
      where stored_field_ids ? pg_catalog.lower(field.value ->> 'fieldId');
      selected_value_expression := coalesce(vortex_record.named_action_storage_columns_internal(
        (loaded #>> '{recordTypeMeta,storageContractId}')::uuid, selected_fields
      ) ->> 'valueExpression', '');
      execute pg_catalog.format(
        'select pg_catalog.jsonb_build_object(%s) from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.concurrency_number = $3',
        selected_value_expression, loaded ->> 'table'
      ) into selected_values using (loaded #>> '{context,organizationId}')::uuid,
        p_record_id, (loaded ->> 'concurrencyNumber')::bigint;
      if selected_values is null then
        projection := pg_catalog.jsonb_build_object('outcome', 'refused');
        return next;
        return;
      end if;
    end if;
    loaded := pg_catalog.jsonb_set(loaded, '{fieldValues}', selected_values);
  end if;
  field_values := case when compact then p_loaded -> 'record' -> 'fieldValues'
    else loaded -> 'fieldValues' end;
  -- Read-time calculations are worked out here, at one statement timestamp in
  -- the organisation's time zone, from the record's stored values. They are
  -- never read from storage. A page works out the record type's read-time
  -- fields and the statement's clock once and passes them here.
  if compact and p_page ? 'readTimeFields' then
    read_time_fields := p_page -> 'readTimeFields';
  else
    select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value), '{}'::jsonb)
    into read_time_fields
    from pg_catalog.jsonb_array_elements(shared -> 'facts' -> 'recordTypes') as record_type(value)
    cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
    where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      and field.value ->> 'type' = 'calculation'
      and (field.value #>> '{settings,evaluation}' = 'read_time'
        or field.value #>> '{settings,expression,op}' = 'deadline_passed');
  end if;
  if read_time_fields <> '{}'::jsonb then
    read_time_clock := case when compact and p_page ? 'readTimeClock' then p_page -> 'readTimeClock'
      else vortex_record.read_time_clock_internal() end;
  end if;
  if read_time_fields = '{}'::jsonb then
    -- Without read-time fields every readable stored value is projected as
    -- stored: one statement instead of one step per field.
    select coalesce(pg_catalog.jsonb_object_agg(item.value #>> '{}', field_values -> (item.value #>> '{}')
        order by item.ordinality), '{}'::jsonb)
    into values_value
    from pg_catalog.jsonb_array_elements(projected_field_ids) with ordinality as item(value, ordinality)
    where shared -> 'columns' ? (item.value #>> '{}');
  end if;
  for field_id in
    select item.value #>> '{}' from pg_catalog.jsonb_array_elements(projected_field_ids) as item(value)
    where read_time_fields <> '{}'::jsonb
  loop
    if not (shared -> 'columns' ? field_id) then
      continue;
    end if;
    if read_time_fields ? pg_catalog.lower(field_id) then
      read_time_expression := read_time_fields -> pg_catalog.lower(field_id) #> '{settings,expression}';
      -- Only the deadline-passed form is defined; another read-time form is
      -- withheld rather than disclosed from a stored column.
      if read_time_expression ->> 'op' is distinct from 'deadline_passed' then
        continue;
      end if;
      due_key := pg_catalog.lower(read_time_expression #>> '{due,reference,fieldId}');
      status_key := pg_catalog.lower(read_time_expression #>> '{status,reference,fieldId}');
      due_value := field_values -> due_key;
      status_value := case when status_key is null then null else field_values -> status_key end;
      if status_value is not null and status_value <> 'null'::jsonb and exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(read_time_expression -> 'terminalStatusValues', '[]'::jsonb))
          as terminal(value)
        where terminal.value = status_value
      ) then
        read_time_value := 'false'::jsonb;
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and shared -> 'columns' -> due_key ->> 'databaseValueType' = 'date' then
        -- Without the organisation's time zone the local date is unknown.
        if read_time_clock ->> 'organizationLocalDate' is null then
          continue;
        end if;
        read_time_value := pg_catalog.to_jsonb((read_time_clock ->> 'organizationLocalDate') > (due_value #>> '{}'));
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and shared -> 'columns' -> due_key ->> 'databaseValueType' = 'timestamp_with_time_zone' then
        read_time_value := pg_catalog.to_jsonb(
          (read_time_clock ->> 'instant')::timestamp with time zone
            >= (due_value #>> '{}')::timestamp with time zone
        );
      else
        read_time_value := 'null'::jsonb;
      end if;
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, read_time_value);
    else
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, field_values -> field_id);
    end if;
  end loop;
  projection := pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', p_record_id,
    'concurrencyNumber', case when compact then p_loaded -> 'concurrencyNumber'
      else loaded -> 'concurrencyNumber' end,
    'values', values_value);
  -- A compact record keeps its compact scope; the caller holds the envelope.
  read_facts := case when compact then p_loaded else loaded end;
  read_bounds := bounds;
  return next;
end
$function$;

alter function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  to vortex_record_adapter;

reset role;

set role vortex_record_adapter;

-- The single-record facts loaders are removed; the set forms replace them.
drop function vortex_record.load_record_access_facts_internal(uuid, text, uuid, bigint, jsonb, jsonb);
drop function vortex_record.load_record_access_facts_from_installation_internal(uuid, text, uuid, bigint, jsonb, jsonb, jsonb);
drop function vortex_record.load_record_access_facts_with_plan_internal(uuid, text, uuid, bigint, jsonb, jsonb, jsonb, jsonb);

create or replace function vortex_record.load_record_access_facts_with_plan_internal(
  p_action_kind text,
  p_targets jsonb,
  p_installation jsonb,
  p_plan jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  plan jsonb;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  target_count integer;
  -- Per target (1-based, in the caller's order).
  target_type_ids uuid[];
  target_record_ids uuid[];
  target_expected_numbers bigint[];
  target_results jsonb[];
  target_facts jsonb[];
  target_reached text[];
  target_edges jsonb[];
  -- Per record type of the call: the declaration and the projection source.
  declarations jsonb := '{}'::jsonb;
  required_by_type jsonb := '{}'::jsonb;
  sources jsonb := '{}'::jsonb;
  type_item record;
  group_item record;
  target_meta jsonb;
  target_scope text;
  target_module_root_id uuid;
  target_is_system_projection boolean;
  preview_target boolean;
  target_source_sql text;
  target_projection_definition jsonb;
  target_projection_sort_key text;
  projection_reader_sql text;
  required_permissions jsonb;
  declaration jsonb;
  selected_field_ids jsonb;
  selected_fields jsonb;
  selected_value_expression text;
  load_sql text;
  loaded_row record;
  target_index integer;
  -- The closure: one shared cache of the related rows it loads, and per wave
  -- one edge query for every (target, record, permission) pair still to expand.
  closure_records jsonb := '{}'::jsonb;
  seen_pairs text[] := array[]::text[];
  wave_targets integer[] := array[]::integer[];
  wave_records uuid[] := array[]::uuid[];
  wave_permissions uuid[] := array[]::uuid[];
  next_targets integer[];
  next_records uuid[];
  next_permissions uuid[];
  load_contracts uuid[] := array[]::uuid[];
  load_records uuid[] := array[]::uuid[];
  current_contract uuid;
  current_meta jsonb;
  edge_item record;
  loaded_records jsonb;
  record_types_fact jsonb;
  relationships_fact jsonb;
  results jsonb;
  closure_needed boolean := false;
begin
  -- Step 1: the targets. One record type, record identity, optional expected
  -- revision, optional protected projection row and optional requested fields
  -- each; a record is named once per call.
  if p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore', 'transfer')
    or pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) not between 1 and 200
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_targets) as target(value)
      where pg_catalog.jsonb_typeof(target.value) is distinct from 'object'
        or not (target.value ?& array['recordTypeId', 'recordId'])
        or exists (
          select 1 from pg_catalog.jsonb_object_keys(case
            when pg_catalog.jsonb_typeof(target.value) = 'object' then target.value
            else '{}'::jsonb end) as supplied(key)
          where supplied.key <> all (array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'projectionRow',
            'requestedFieldIds'
          ])
        )
        or not vortex_platform.is_non_nil_uuid(target.value ->> 'recordTypeId')
        or not vortex_platform.is_non_nil_uuid(target.value ->> 'recordId')
        or (pg_catalog.jsonb_typeof(target.value -> 'expectedConcurrencyNumber')
            not in ('null', 'number')
          or (pg_catalog.jsonb_typeof(target.value -> 'expectedConcurrencyNumber') = 'number'
            and ((target.value ->> 'expectedConcurrencyNumber') !~ '^[1-9][0-9]{0,15}$'
              or (target.value ->> 'expectedConcurrencyNumber')::bigint > 9007199254740991)))
        or pg_catalog.jsonb_typeof(target.value -> 'projectionRow') not in ('null', 'object')
        or (pg_catalog.jsonb_typeof(target.value -> 'requestedFieldIds') = 'array'
          and exists (
            select 1 from pg_catalog.jsonb_array_elements(target.value -> 'requestedFieldIds') as item(value)
            where pg_catalog.jsonb_typeof(item.value) <> 'string'
              or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
          ))
        or pg_catalog.jsonb_typeof(target.value -> 'requestedFieldIds') not in ('null', 'array')
    )
    or (
      select pg_catalog.count(*) <> pg_catalog.count(distinct pg_catalog.lower(target.value ->> 'recordId'))
      from pg_catalog.jsonb_array_elements(p_targets) as target(value)
    ) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;
  target_count := pg_catalog.jsonb_array_length(p_targets);
  select pg_catalog.array_agg((target.value ->> 'recordTypeId')::uuid order by target.ordinality),
    pg_catalog.array_agg((target.value ->> 'recordId')::uuid order by target.ordinality),
    pg_catalog.array_agg((target.value ->> 'expectedConcurrencyNumber')::bigint order by target.ordinality)
  into target_type_ids, target_record_ids, target_expected_numbers
  from pg_catalog.jsonb_array_elements(p_targets) with ordinality as target(value, ordinality);
  target_results := pg_catalog.array_fill(null::jsonb, array[target_count]);
  target_facts := pg_catalog.array_fill(null::jsonb, array[target_count]);
  target_reached := pg_catalog.array_fill(null::text, array[target_count]);
  target_edges := pg_catalog.array_fill('[]'::jsonb, array[target_count]);

  -- Step 2: the verified request context, once for the call. The adapter never
  -- reads `current_user`, which is its own owner inside a definer function.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  -- Step 3: the exact installation and its access plan, both supplied by the
  -- trusted caller (this internal is not executable by request roles) and
  -- checked once against the verified request context.
  plan := p_plan;
  if plan is null or pg_catalog.jsonb_typeof(plan) <> 'object' then
    raise exception using errcode = '22023',
      message = 'Record adapter access plan is invalid';
  end if;
  if (plan ->> 'organizationId')::uuid is distinct from context_organization_id
    or (plan ->> 'applicationRootId')::uuid is distinct from context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  type_meta := plan -> 'recordTypes';
  relationship_by_id := plan -> 'relationships';
  condition_list := plan -> 'sharingConditions';
  permission_by_id := plan -> 'permissions';

  -- Step 4: per record type of the call, once: its meta, the protected
  -- projection source and the declaration. Every record-scoped permission of
  -- this action kind declared for the exact record type, owned by the context
  -- Application or by the record type's own Module, in the canonical order the
  -- eligibility core requires.
  for type_item in
    select distinct type_id from pg_catalog.unnest(target_type_ids) as type_id
  loop
    target_meta := type_meta -> pg_catalog.lower(type_item.type_id::text);
    if target_meta is null then
      raise exception using errcode = '55000',
        message = 'Record type is not part of the active installation';
    end if;
    if pg_catalog.jsonb_typeof(target_meta -> 'isSystemProjection')
      is distinct from 'boolean' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;
    target_scope := target_meta ->> 'storageScope';
    target_module_root_id := (target_meta ->> 'moduleRootId')::uuid;
    target_is_system_projection := (target_meta ->> 'isSystemProjection')::boolean;

    if target_is_system_projection then
      select storage.record_type_definition into target_projection_definition
      from vortex_record.storage_catalogue as storage
      where storage.storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and storage.physical_schema_token = 'system_projection'
        and storage.state = 'active';
      if not found then
        raise exception using errcode = '55000',
          message = 'Protected projection reader is unavailable';
      end if;
      if pg_catalog.jsonb_typeof(target_projection_definition -> 'fields') is distinct from 'array'
        or pg_catalog.jsonb_typeof(target_projection_definition -> 'systemProjection')
          is distinct from 'object' then
        raise exception using errcode = '55000',
          message = 'Protected projection definition is invalid';
      end if;
      target_projection_sort_key := null;
      select field.value ->> 'key' into target_projection_sort_key
      from pg_catalog.jsonb_array_elements(target_projection_definition -> 'fields')
        as field(value)
      where field.value ->> 'fieldId'
        = target_projection_definition #>> '{systemProjection,sortableFieldIds,0}';
      if target_projection_definition #> '{systemProjection,sortableFieldIds,0}' is not null
        and target_projection_sort_key is null then
        raise exception using errcode = '55000',
          message = 'Protected projection sort field is invalid';
      end if;
      target_projection_sort_key := coalesce(target_projection_sort_key, 'record_id');
      -- Shape protected reader values with explicit definition-derived columns.
      -- The projection row source is chosen per group below: the reader for
      -- the group's identities, or the rows the caller already read.
      sources := sources || pg_catalog.jsonb_build_object(
        pg_catalog.lower(type_item.type_id::text), pg_catalog.jsonb_build_object(
          'reader', pg_catalog.format(
            'vortex_record.read_system_projection_rows_internal(%L::uuid, $2, %L, ''ascending'', null::jsonb, pg_catalog.cardinality($2), null::jsonb) as projection',
            (target_meta ->> 'storageContractId')::uuid, target_projection_sort_key
          ),
          'source', pg_catalog.format($source$
            /*projection rows*/
            cross join lateral pg_catalog.jsonb_to_record(
              pg_catalog.jsonb_build_object(
                'organisation_id', projection.organization_id,
                'module_root_id', %L::uuid,
                'record_type_id', %L::uuid,
                'storage_contract_id', %L::uuid,
                'record_id', projection.record_id,
                'definition_revision', %L::bigint,
                'lifecycle_state', 'active',
                'concurrency_number', projection.revision
              ) || coalesce((
                select pg_catalog.jsonb_object_agg(
                  'f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''),
                  case
                    when field.value ->> 'fieldId' = %L
                      then pg_catalog.to_jsonb(projection.organization_id::text)
                    when field.value ->> 'fieldId' = %L
                      then pg_catalog.to_jsonb(projection.revision)
                    else projection.attribute_values -> (field.value ->> 'key')
                  end
                )
                from pg_catalog.jsonb_array_elements(%L::jsonb -> 'fields') as field(value)
              ), '{}'::jsonb)
            ) as stored(%s)$source$,
            target_module_root_id, type_item.type_id,
            (target_meta ->> 'storageContractId')::uuid,
            (target_meta ->> 'releaseRevision')::bigint,
            target_projection_definition #>> '{systemProjection,organizationFieldId}',
            target_projection_definition #>> '{systemProjection,revisionFieldId}',
            target_projection_definition,
            vortex_record.system_projection_columns_internal(target_projection_definition)
          )
        )
      );
    end if;

    -- A preview reads its own copy of every record type except a system
    -- projection: that is the platform's live read model, which a preview reads
    -- on the live path under the reader's own live access, never as the
    -- preview's owner.
    preview_target := p_installation ? 'previewInstallationId' and not target_is_system_projection;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'applicationRootId', context_application_root_id,
        'ownerKind', declared.value ->> 'ownerKind',
        'ownerId', (declared.value ->> 'ownerId')::uuid,
        'permissionId', declared.key::uuid
      )
      order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
    )
    into required_permissions
    from pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
    where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(type_item.type_id::text)
      and declared.value ->> 'actionKind' = p_action_kind
      -- `->>` and not `->`: a permission that declares no named action is stored
      -- here as JSON null, which `-> 'namedAction' is null` would never match, so
      -- that test would leave every declaration empty and refuse every record.
      and (declared.value ->> 'namedAction') is null
      and (
        (declared.value ->> 'ownerKind') = 'application'
        or (declared.value ->> 'ownerId')::uuid = target_module_root_id
      );

    declaration := case
      when required_permissions is null
        and not preview_target then null
      else pg_catalog.jsonb_build_object(
        'operationKey', 'record.' || p_action_kind,
        'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
        'target', pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', context_application_root_id
        ),
        'requiredPermissions', coalesce(required_permissions, '[]'::jsonb),
        'recordBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', target_module_root_id,
          'recordTypeId', type_item.type_id,
          'storageContractId', (target_meta ->> 'storageContractId')::uuid,
          'storageScope', target_scope
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object(
          'kind', case when preview_target
            then 'preview_owner' else 'permission' end
        )
      )
    end;
    declarations := declarations || pg_catalog.jsonb_build_object(
      pg_catalog.lower(type_item.type_id::text), coalesce(declaration, 'null'::jsonb)
    );
    required_by_type := required_by_type || pg_catalog.jsonb_build_object(
      pg_catalog.lower(type_item.type_id::text),
      case when declaration is null then '[]'::jsonb else required_permissions end
    );
    -- A closure starts only from an inherited owner under an ownership route
    -- or from a relationship route; without either nothing is expanded.
    closure_needed := closure_needed or (declaration is not null and exists (
      select 1
      from pg_catalog.jsonb_array_elements(required_permissions) as required(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        permission_by_id -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes'
      ) as route(value)
      where route.value ->> 'kind' = 'relationship'
        or (route.value ->> 'kind' = 'ownership'
          and target_meta ->> 'ownershipMode' = 'inherited'
          and target_meta ? 'ownershipRelationshipId')
    ));
  end loop;

  -- Step 5: the target rows, one query per record type, requested field set and
  -- projection source. The change path locks them here, in record identity
  -- order, before any other row is read. Organisation and application
  -- isolation is the scope policy's, which is what makes a foreign row
  -- indistinguishable from a missing one.
  for group_item in
    select (target.value ->> 'recordTypeId')::uuid as type_id,
      target.value -> 'requestedFieldIds' as requested_field_ids,
      pg_catalog.jsonb_typeof(target.value -> 'projectionRow') = 'object' as supplied_projection,
      pg_catalog.bool_or(pg_catalog.jsonb_typeof(target.value -> 'expectedConcurrencyNumber') = 'number')
        as locking,
      pg_catalog.array_agg((target.value ->> 'recordId')::uuid order by (target.value ->> 'recordId')::uuid)
        as record_ids,
      pg_catalog.jsonb_agg(target.value -> 'projectionRow') as projection_rows
    from pg_catalog.jsonb_array_elements(p_targets) as target(value)
    group by 1, 2, 3
  loop
    target_meta := type_meta -> pg_catalog.lower(group_item.type_id::text);
    target_scope := target_meta ->> 'storageScope';
    target_is_system_projection := (target_meta ->> 'isSystemProjection')::boolean;
    if target_is_system_projection then
      projection_reader_sql := case when group_item.supplied_projection
        then 'pg_catalog.jsonb_to_recordset($3) as projection(organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb)'
        else sources -> pg_catalog.lower(group_item.type_id::text) ->> 'reader' end;
      target_source_sql := pg_catalog.replace(
        sources -> pg_catalog.lower(group_item.type_id::text) ->> 'source',
        '/*projection rows*/', projection_reader_sql
      );
    else
      target_source_sql := pg_catalog.format('record_data.%I as stored', target_meta ->> 'table');
    end if;

    selected_value_expression := target_meta ->> 'valueExpression';
    if pg_catalog.jsonb_typeof(group_item.requested_field_ids) = 'array' then
      -- Access conditions must see the same operands even when no visible placement consumes them.
      -- Read-time calculations also need their stored dependencies, without disclosing those values.
      select coalesce(pg_catalog.jsonb_agg(distinct pg_catalog.lower(item.value)), '[]'::jsonb)
      into selected_field_ids
      from (
        select value from pg_catalog.jsonb_array_elements_text(group_item.requested_field_ids)
        union all
        select value #>> '{}' from pg_catalog.jsonb_path_query(condition_list, 'lax $.**.declaredFieldIds[*]') as dependency(value)
        union all
        select dependency.value #>> '{}'
        from pg_catalog.jsonb_array_elements(target_meta -> 'fields') as field(value)
        cross join lateral (values
          (field.value #> '{settings,expression,due,reference,fieldId}'),
          (field.value #> '{settings,expression,status,reference,fieldId}')
        ) as dependency(value)
        where group_item.requested_field_ids ? pg_catalog.lower(field.value ->> 'fieldId')
          and field.value ->> 'type' = 'calculation'
      ) as item(value);
      select coalesce(pg_catalog.jsonb_agg(field.value), '[]'::jsonb) into selected_fields
      from pg_catalog.jsonb_array_elements(target_meta -> 'fields') as field(value)
      where selected_field_ids ? pg_catalog.lower(field.value ->> 'fieldId');
      selected_value_expression := coalesce(vortex_record.named_action_storage_columns_internal(
        (target_meta ->> 'storageContractId')::uuid, selected_fields
      ) ->> 'valueExpression', '');
    end if;

    load_sql := pg_catalog.format(
      'select stored.record_id, pg_catalog.jsonb_build_object(
         ''recordScope'', pg_catalog.jsonb_build_object(
           ''storageScope'', %L,
           ''organizationId'', stored.organisation_id,
           ''moduleRootId'', %L::uuid,
           ''recordTypeId'', %L::uuid,
           ''storageContractId'', %L::uuid,
           ''recordId'', stored.record_id
         ) || case when %L = ''application_contained''
           then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
           else ''{}''::jsonb end,
         ''lifecycleState'', stored.lifecycle_state,
         ''fieldValues'', pg_catalog.jsonb_build_object(%s)
       ) || case
         when stored.owner_organisation_account_id is not null
           then pg_catalog.jsonb_build_object(
             ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
         when stored.owner_group_id is not null
           then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
         else ''{}''::jsonb end as fact,
       stored.concurrency_number, stored.definition_revision
       from %s
       where stored.organisation_id = $1 and stored.record_id = any ($2)%s',
      target_scope, (target_meta ->> 'moduleRootId')::uuid, group_item.type_id,
      (target_meta ->> 'storageContractId')::uuid, target_scope,
      selected_value_expression, target_source_sql,
      case when group_item.locking
        then ' order by stored.record_id for update' else '' end
    );

    for loaded_row in execute load_sql
      using context_organization_id, group_item.record_ids, group_item.projection_rows
    loop
      target_index := pg_catalog.array_position(target_record_ids, loaded_row.record_id);
      if target_index is null
        or target_type_ids[target_index] is distinct from group_item.type_id then
        continue;
      end if;
      if target_expected_numbers[target_index] is not null
        and loaded_row.concurrency_number <> target_expected_numbers[target_index] then
        target_results[target_index] := pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'concurrencyNumber', loaded_row.concurrency_number
        );
        continue;
      end if;
      target_facts[target_index] := loaded_row.fact;
      target_reached[target_index] := pg_catalog.lower(loaded_row.record_id::text);
      -- A compatible reprovision can advance the catalogue definition while an
      -- older release remains installed. Report that exact projection
      -- definition; generated records keep their persisted last-written
      -- definition revision.
      target_results[target_index] := pg_catalog.jsonb_build_object(
        'concurrencyNumber', loaded_row.concurrency_number,
        'definitionRevision', case when target_is_system_projection
          then (target_meta ->> 'releaseRevision')::bigint
          else loaded_row.definition_revision end
      );
    end loop;
  end loop;

  -- Step 6: the fact closure, per target. Every loaded target with a
  -- declaration starts one pair per required permission. A (record,
  -- permission) pair of a target is expanded at most once, which bounds the
  -- walk; an inherited-ownership chain is expanded by pushing the parent under
  -- the same permission, so the chase and the relationship routes use the same
  -- mechanism. Each wave reads the edges of all its pairs in one query, and the
  -- related rows it reaches in one query per storage contract.
  if closure_needed then
    select coalesce(pg_catalog.array_agg(started.target_index order by started.target_index, started.ordinality), array[]::integer[]),
      coalesce(pg_catalog.array_agg(target_record_ids[started.target_index] order by started.target_index, started.ordinality), array[]::uuid[]),
      coalesce(pg_catalog.array_agg(started.permission_id order by started.target_index, started.ordinality), array[]::uuid[])
    into wave_targets, wave_records, wave_permissions
    from (
      select indexed.target_index, item.ordinality, (item.value ->> 'permissionId')::uuid as permission_id
      from pg_catalog.generate_subscripts(target_record_ids, 1) as indexed(target_index)
      cross join lateral pg_catalog.jsonb_array_elements(
        required_by_type -> pg_catalog.lower(target_type_ids[indexed.target_index]::text)
      ) with ordinality as item(value, ordinality)
      where target_facts[indexed.target_index] is not null
    ) as started;

    while pg_catalog.cardinality(wave_targets) > 0 loop
      next_targets := array[]::integer[];
      next_records := array[]::uuid[];
      next_permissions := array[]::uuid[];
      for edge_item in
        with wave as (
          select distinct pair.target_position, pair.record_id, pair.permission_id
          from rows from (
            pg_catalog.unnest(wave_targets), pg_catalog.unnest(wave_records),
            pg_catalog.unnest(wave_permissions)
          ) as pair(target_position, record_id, permission_id)
          where pg_catalog.format('%s:%s:%s', pair.target_position,
            pg_catalog.lower(pair.record_id::text), pg_catalog.lower(pair.permission_id::text))
            <> all (seen_pairs)
        ),
        expanded as (
          select wave.target_position, wave.record_id, wave.permission_id,
            type_meta -> pg_catalog.lower(fact.value -> 'recordScope' ->> 'recordTypeId') as meta,
            permission_by_id -> pg_catalog.lower(wave.permission_id::text) -> 'recordScope' as scope
          from wave
          cross join lateral (
            select case when wave.record_id = target_record_ids[wave.target_position]
              then target_facts[wave.target_position]
              else closure_records -> pg_catalog.lower(wave.record_id::text) end as value
          ) as fact
          where fact.value is not null
        )
        -- Inherited ownership: the declared parent under the same permission,
        -- which repeats for the grandparent when that pair is expanded.
        select expanded.target_position, edge.relationship_id,
          edge.from_record_id, edge.to_record_id,
          edge.to_storage_contract_id as reached_contract, edge.to_record_id as reached_record,
          expanded.permission_id as reached_permission
        from expanded
        join vortex_record.relationship_edges as edge
          on edge.relationship_id = (expanded.meta ->> 'ownershipRelationshipId')::uuid
          and edge.from_storage_contract_id = (expanded.meta ->> 'storageContractId')::uuid
          and edge.from_record_id = expanded.record_id
        where expanded.meta is not null and expanded.scope is not null
          and expanded.meta ->> 'ownershipMode' = 'inherited'
          and expanded.meta ? 'ownershipRelationshipId'
          and exists (
            select 1 from pg_catalog.jsonb_array_elements(expanded.scope -> 'routes') as route(value)
            where route.value ->> 'kind' = 'ownership'
          )
        union all
        -- Relationship routes: the target is always the `to` endpoint, so the
        -- sources this permission can reach it through are the `from` rows of
        -- that relationship's edges, each expanded under its own source permission.
        select expanded.target_position, edge.relationship_id,
          edge.from_record_id, edge.to_record_id,
          edge.from_storage_contract_id, edge.from_record_id,
          (route.value ->> 'sourcePermissionId')::uuid
        from expanded
        cross join lateral pg_catalog.jsonb_array_elements(expanded.scope -> 'routes') as route(value)
        join vortex_record.relationship_edges as edge
          on edge.relationship_id = (route.value ->> 'relationshipId')::uuid
          and edge.to_storage_contract_id = (expanded.meta ->> 'storageContractId')::uuid
          and edge.to_record_id = expanded.record_id
        where expanded.meta is not null and expanded.scope is not null
          and route.value ->> 'kind' = 'relationship'
          and relationship_by_id ? pg_catalog.lower(route.value ->> 'relationshipId')
      loop
        if edge_item.reached_record <> target_record_ids[edge_item.target_position]
          and not closure_records ? pg_catalog.lower(edge_item.reached_record::text) then
          load_contracts := load_contracts || edge_item.reached_contract;
          load_records := load_records || edge_item.reached_record;
        end if;
        target_reached[edge_item.target_position] := target_reached[edge_item.target_position]
          || ',' || pg_catalog.lower(edge_item.reached_record::text);
        target_edges[edge_item.target_position] := target_edges[edge_item.target_position]
          || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'relationshipId', edge_item.relationship_id,
            'fromRecordId', edge_item.from_record_id,
            'toRecordId', edge_item.to_record_id
          ));
        next_targets := next_targets || edge_item.target_position;
        next_records := next_records || edge_item.reached_record;
        next_permissions := next_permissions || edge_item.reached_permission;
      end loop;

      -- Every pair of this wave is expanded now, including those that reached nothing.
      select seen_pairs || coalesce(pg_catalog.array_agg(distinct pg_catalog.format('%s:%s:%s',
          pair.target_position, pg_catalog.lower(pair.record_id::text),
          pg_catalog.lower(pair.permission_id::text))), array[]::text[])
      into seen_pairs
      from rows from (
        pg_catalog.unnest(wave_targets), pg_catalog.unnest(wave_records),
        pg_catalog.unnest(wave_permissions)
      ) as pair(target_position, record_id, permission_id);

      -- The related rows this wave reached, one query per storage contract.
      for current_contract in
        select distinct queued.contract_id
        from rows from (pg_catalog.unnest(load_contracts), pg_catalog.unnest(load_records))
          as queued(contract_id, record_id)
      loop
        select meta.value into current_meta
        from pg_catalog.jsonb_each(type_meta) as meta(key, value)
        where (meta.value ->> 'storageContractId')::uuid = current_contract
        limit 1;
        if current_meta is null then
          continue;
        end if;
        load_sql := pg_catalog.format(
          'select coalesce(pg_catalog.jsonb_object_agg(
             pg_catalog.lower(stored.record_id::text), pg_catalog.jsonb_build_object(
             ''recordScope'', pg_catalog.jsonb_build_object(
               ''storageScope'', %L,
               ''organizationId'', stored.organisation_id,
               ''moduleRootId'', %L::uuid,
               ''recordTypeId'', %L::uuid,
               ''storageContractId'', %L::uuid,
               ''recordId'', stored.record_id
             ) || case when %L = ''application_contained''
               then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
               else ''{}''::jsonb end,
             ''lifecycleState'', stored.lifecycle_state,
             ''fieldValues'', pg_catalog.jsonb_build_object(%s)
           ) || case
             when stored.owner_organisation_account_id is not null
               then pg_catalog.jsonb_build_object(
                 ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
             when stored.owner_group_id is not null
               then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
             else ''{}''::jsonb end), ''{}''::jsonb)
           from record_data.%I as stored
           where stored.organisation_id = $1 and stored.record_id = any ($2)',
          current_meta ->> 'storageScope', (current_meta ->> 'moduleRootId')::uuid,
          (current_meta ->> 'recordTypeId')::uuid, current_contract,
          current_meta ->> 'storageScope', current_meta ->> 'valueExpression',
          current_meta ->> 'table'
        );
        execute load_sql into loaded_records using context_organization_id, array(
          select distinct queued.record_id
          from rows from (pg_catalog.unnest(load_contracts), pg_catalog.unnest(load_records))
            as queued(contract_id, record_id)
          where queued.contract_id = current_contract
        );
        closure_records := closure_records || loaded_records;
      end loop;
      load_contracts := array[]::uuid[];
      load_records := array[]::uuid[];

      wave_targets := next_targets;
      wave_records := next_records;
      wave_permissions := next_permissions;
    end loop;
  end if;

  -- Step 7: the facts. Every record type, relationship and saved condition of
  -- the installed definitions, built once for the call; per target the records
  -- its own closure reached and exactly the edges whose endpoints are both
  -- present, deduplicated.
  record_types_fact := coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'moduleRootId', meta.value -> 'moduleRootId',
        'recordTypeId', meta.value -> 'recordTypeId',
        'storageContractId', meta.value -> 'storageContractId',
        'storageScope', meta.value -> 'storageScope',
        'ownershipMode', meta.value -> 'ownershipMode',
        'validationContractVersion', meta.value -> 'validationContractVersion',
        'fields', meta.value -> 'fields'
      ) || case
        when meta.value ? 'ownershipRelationshipId'
          then pg_catalog.jsonb_build_object(
            'ownershipRelationshipId', meta.value -> 'ownershipRelationshipId'
          )
        else '{}'::jsonb
      end
      order by meta.key collate "C"
    )
    from pg_catalog.jsonb_each(type_meta) as meta(key, value)
  ), '[]'::jsonb);
  relationships_fact := coalesce((
    select pg_catalog.jsonb_agg(declared.value order by declared.key collate "C")
    from pg_catalog.jsonb_each(relationship_by_id) as declared(key, value)
  ), '[]'::jsonb);

  select coalesce(pg_catalog.jsonb_agg(outcome.value order by outcome.target_index), '[]'::jsonb)
  into results
  from (
    select indexed.target_index, case
      when target_results[indexed.target_index] is null
        then pg_catalog.jsonb_build_object('outcome', 'missing')
      when target_results[indexed.target_index] ->> 'outcome' = 'conflict'
        then target_results[indexed.target_index]
      else pg_catalog.jsonb_build_object(
        'outcome', 'loaded',
        'context', context_value,
        'declaration', typed.declaration,
        'facts', pg_catalog.jsonb_build_object(
          'binding', typed.declaration -> 'recordBinding',
          'recordTypes', record_types_fact,
          'relationships', relationships_fact,
          'sharingConditions', condition_list,
          'records', reached.records,
          'edges', present_edges.edges
        ),
        'accessPermissions', permission_by_id,
        'recordTypeMeta', typed.meta - 'isSystemProjection',
        'isSystemProjection', (typed.meta ->> 'isSystemProjection')::boolean,
        'table', typed.meta ->> 'table',
        'columns', typed.meta -> 'columns',
        'concurrencyNumber', target_results[indexed.target_index] -> 'concurrencyNumber',
        'definitionRevision', target_results[indexed.target_index] -> 'definitionRevision',
        'moduleReleaseRevision', (typed.meta ->> 'releaseRevision')::bigint,
        'fieldValues', target_facts[indexed.target_index] -> 'fieldValues'
      ) || case when p_installation ? 'previewInstallationId'
          and not (typed.meta ->> 'isSystemProjection')::boolean
        then pg_catalog.jsonb_build_object(
          'previewInstallationId', p_installation -> 'previewInstallationId'
        )
        else '{}'::jsonb end
    end as value
    from pg_catalog.generate_subscripts(target_record_ids, 1) as indexed(target_index)
    cross join lateral (
      select type_meta -> pg_catalog.lower(target_type_ids[indexed.target_index]::text) as meta,
        nullif(
          declarations -> pg_catalog.lower(target_type_ids[indexed.target_index]::text), 'null'::jsonb
        ) as declaration
    ) as typed
    cross join lateral (
      select coalesce(pg_catalog.jsonb_agg(present.fact order by present.record_key collate "C"), '[]'::jsonb)
          as records,
        coalesce(pg_catalog.array_agg(present.record_key), array[]::text[]) as record_keys
      from (
        select distinct record_key.value as record_key,
          case when record_key.value = pg_catalog.lower(target_record_ids[indexed.target_index]::text)
            then target_facts[indexed.target_index]
            else closure_records -> record_key.value end as fact
        from pg_catalog.unnest(pg_catalog.string_to_array(target_reached[indexed.target_index], ','))
          as record_key(value)
      ) as present
      where present.fact is not null
    ) as reached
    cross join lateral (
      select coalesce(pg_catalog.jsonb_agg(distinct edge.value), '[]'::jsonb) as edges
      from pg_catalog.jsonb_array_elements(target_edges[indexed.target_index]) as edge(value)
      where pg_catalog.lower(edge.value ->> 'fromRecordId') = any (reached.record_keys)
        and pg_catalog.lower(edge.value ->> 'toRecordId') = any (reached.record_keys)
    ) as present_edges
  ) as outcome;

  return results;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_record_access_facts_with_plan_internal(text,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_with_plan_internal(
  text, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_record_access_facts_with_plan_internal(text,jsonb,jsonb,jsonb) to vortex_owner;

comment on function vortex_record.load_record_access_facts_with_plan_internal(text,jsonb,jsonb,jsonb) is
  'Private record access facts for a set of targets under one supplied installation and access plan: one result per target in the caller''s order; record types, declarations and the request context once per call, target rows in one query per record type, and the closure one edge query per wave.';

create or replace function vortex_record.load_record_access_facts_from_installation_internal(
  p_action_kind text,
  p_targets jsonb,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  -- The access plan is resolved here, once for this call, and the one facts
  -- body consumes it for every target of the call.
  return vortex_record.load_record_access_facts_with_plan_internal(
    p_action_kind, p_targets, p_installation,
    vortex_record.resolve_installation_access_plan_internal(p_installation)
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_record_access_facts_from_installation_internal(text,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_from_installation_internal(
  text, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_record_access_facts_from_installation_internal(text,jsonb,jsonb) to vortex_owner;

create or replace function vortex_record.load_record_access_facts_internal(
  p_action_kind text,
  p_targets jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_application_root_id uuid;
  installation jsonb;
  preview_installation jsonb;
begin
  -- Each target names a record type, a record, and optionally an expected
  -- revision, a protected projection row and requested fields; the result holds
  -- one facts outcome per target in the same order. The facts body checks each
  -- target.
  if p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore')
    or pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) not between 1 and 200 then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  -- Step 1: the verified request context, checked here so the active reader
  -- and the shared loader refuse an absent Application context identically.
  context_value := vortex_access.validated_human_request_context();
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  -- Step 2: resolve only the explicitly addressed preview for its owner, or
  -- preserve the active installation reader for an ordinary live request.
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('outcome', 'refused'))
      from pg_catalog.jsonb_array_elements(p_targets)
    );
  end if;
  installation := case when preview_installation is null
    then vortex_definition.read_current_active_installation()
    else preview_installation end;

  return vortex_record.load_record_access_facts_from_installation_internal(
    p_action_kind, p_targets, installation
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_record_access_facts_internal(text,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_internal(
  text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_record_access_facts_internal(text,jsonb) to vortex_owner;

create or replace function vortex_record.apply_lifecycle_record_changes_internal(
  p_operation text,
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  root_snapshot jsonb;
  deletion_result jsonb;
  current_revision bigint;
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  preparation jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  event_kind text;
  event_result jsonb;
  subject_ids uuid[];
  revisions jsonb;
  restored_revision bigint;
  target_kind text;
  target_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  receipt_claim jsonb;
  installation jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  ownership_mode text;
  previous_owner_id uuid;
  updated_record_id uuid;
  updated_concurrency_number bigint;
  changed_rows integer;
  notice_sequence bigint;
  context_after jsonb;
  shared_consumers_initial jsonb;
  shared_consumers_final jsonb;
  target_item jsonb;
  module_item jsonb;
  target_application_root_id uuid;
  previous_target_application_root_id uuid;
  target_module_root_id uuid;
  previous_target_module_root_id uuid;
  target_module_binding_count integer;
  origin_application_is_consumer boolean;
begin
  -- Delete has two calls in one request transaction: null mutations claim the
  -- receipt and traverse, then calculated parent mutations complete the command.
  -- Both calls enter through apply_record_changes; a non-final outcome rolls
  -- back the request transaction, including every traversal write.
  if p_operation = 'delete' then
    if p_mutations is null then
      if p_command_id is null or p_command_id = nil_uuid
        or p_record_type_id is null or p_record_type_id = nil_uuid
        or p_record_id is null or p_record_id = nil_uuid
        or p_activity_id is null or p_activity_id = nil_uuid
        or p_occurrence_id is null or p_occurrence_id = nil_uuid
        or p_expected_concurrency_number is null
        or p_expected_concurrency_number not between 1 and 9007199254740990 then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      context_value := vortex_access.validated_human_request_context();
      if not context_value ? 'applicationRootId' then
        raise exception using errcode = '42501',
          message = 'Record delete requires an Application context';
      end if;
      receipt_claim := vortex_record.claim_command_receipt_internal(
        'record_delete', p_command_id, false
      );
      if receipt_claim ->> 'status' is distinct from 'claimed' then
        if receipt_claim ->> 'status' = 'identity_conflict' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
            'correlationId', context_value -> 'correlationId'
          );
        end if;
        if receipt_claim ->> 'status' is distinct from 'completed' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
          );
        end if;
        return pg_catalog.jsonb_build_object(
          'outcome', 'deleted',
          'recordId', receipt_claim -> 'recordId',
          'concurrencyNumber', receipt_claim -> 'concurrencyNumber',
          'correlationId', context_value -> 'correlationId',
          'replayed', true
        );
      end if;

      -- The evaluator needs the root's last active values. They are captured
      -- before the traversal and only used if that traversal deletes exactly the
      -- revision they were read at.
      root_snapshot := vortex_record.relationship_total_record_snapshot_internal(
        vortex_record.relationship_total_catalogue_internal(),
        p_record_type_id, p_record_id, false
      );

      perform pg_catalog.set_config(
        'vortex_record.lifecycle_command_id', p_command_id::text, true
      );
      begin
        perform vortex_record.soft_delete_record_recursive_internal(
          p_record_type_id, p_record_id, p_expected_concurrency_number, array[]::text[]
        );
        deletion_result := pg_catalog.jsonb_build_object('outcome', 'completed');
      exception
        when serialization_failure or deadlock_detected then
          deletion_result := pg_catalog.jsonb_build_object('outcome', 'conflict');
        when no_data_found or insufficient_privilege or object_not_in_prerequisite_state then
          deletion_result := pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'record_unavailable'
          );
        when check_violation then
          deletion_result := pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_refused'
          );
      end;
      perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);

      if deletion_result ->> 'outcome' = 'conflict' then
        current_revision := vortex_record.record_lifecycle_current_revision_internal(
          p_record_type_id, p_record_id
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
        ) || case when current_revision is null then '{}'::jsonb
          else pg_catalog.jsonb_build_object('concurrencyNumber', current_revision) end;
      end if;
      if deletion_result ->> 'outcome' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', coalesce(deletion_result ->> 'reasonCode', 'record_unavailable'),
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if root_snapshot is null then
        raise exception using errcode = '55000',
          message = 'Protected record delete root is not installed';
      end if;
      if (root_snapshot ->> 'concurrencyNumber')::bigint
          is distinct from p_expected_concurrency_number then
        raise exception using errcode = '40001',
          message = 'Protected record delete root changed before deletion';
      end if;

      return vortex_record.prepare_record_lifecycle_totals_internal(
        'delete', p_record_type_id, p_record_id, p_command_id, root_snapshot
      );
    end if;
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_delete', p_command_id);
    if receipt.command_id is null
      or receipt.result is not null then
      raise exception using errcode = '55000',
        message = 'Protected record delete is not prepared';
    end if;
    if p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Protected record delete identities are invalid';
    end if;

    -- The journaled effects prove the preflight that ran was this delete.
    if exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id and effect.effect_kind = 'restored'
    ) or not exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id
        and effect.effect_kind = 'soft_deleted'
        and effect.record_type_id = p_record_type_id
        and effect.record_id = p_record_id
    ) then
      raise exception using errcode = '55000',
        message = 'Protected record delete is not prepared';
    end if;

    -- Closure identity and revisions are re-derived under the held locks rather
    -- than taken from the caller.
    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'delete', p_record_type_id, p_record_id, p_command_id, null
    );
    if preparation ->> 'outcome' is distinct from 'prepared' then
      raise exception using errcode = '40001',
        message = 'Protected record delete closure changed';
    end if;
    perform vortex_record.apply_record_lifecycle_generated_values_internal(
      preparation, false, p_mutations
    );

    for effect_row in
      select effect.*
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = (context_value ->> 'organizationId')::uuid
        and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
        and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
        and effect.command_id = receipt.command_id
      order by effect.effect_sequence
    loop
      if effect_row.effect_kind = 'soft_deleted' then
        event_kind := 'deleted';
      else
        event_kind := 'unlinked';
      end if;
      event_result := vortex_platform.append_record_occurrences(
        effect_row.storage_contract_id, effect_row.record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', case
            when event_kind = 'deleted' and effect_row.record_id = p_record_id
              and effect_row.record_type_id = p_record_type_id
              then p_occurrence_id
            else pg_catalog.gen_random_uuid() end,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', event_kind,
            'recordTypeId', effect_row.record_type_id
          ),
          'payload', pg_catalog.jsonb_build_object('kind', event_kind)
        ))
      );
      if pg_catalog.jsonb_array_length(event_result) <> 1 then
        raise exception using errcode = '55000',
          message = 'Protected record delete Event append failed';
      end if;
    end loop;

    select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id)
      into subject_ids
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = receipt.command_id;
    if subject_ids is null or not (p_record_id = any (subject_ids)) then
      raise exception using errcode = '55000',
        message = 'Protected record delete effects are unavailable';
    end if;
    perform vortex_record.append_record_activity_internal(p_activity_id, 'delete_record', subject_ids, array[]::uuid[], 'completed');

    perform vortex_record.complete_command_receipt_internal(
      'record_delete', p_command_id, p_record_id, p_expected_concurrency_number + 1,
      'Protected record delete receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'deleted',
      'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'restore' then
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_restore', p_command_id);
    if receipt.command_id is null
      or receipt.result is not null then
      raise exception using errcode = '55000',
        message = 'Protected record restore is not prepared';
    end if;
    if p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Protected record restore identities are invalid';
    end if;

    -- The journaled effects prove the preflight that ran was this restore.
    if exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id and effect.effect_kind <> 'restored'
    ) or not exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id
        and effect.effect_kind = 'restored'
        and effect.record_type_id = p_record_type_id
        and effect.record_id = p_record_id
    ) then
      raise exception using errcode = '55000',
        message = 'Protected record restore is not prepared';
    end if;

    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'restore', p_record_type_id, p_record_id, p_command_id, null
    );
    if preparation ->> 'outcome' is distinct from 'prepared'
      or (
        select (item.value ->> 'concurrencyNumber')::bigint
        from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
        where item.value ->> 'recordKey' = 'root'
      ) is distinct from p_expected_concurrency_number + 1 then
      raise exception using errcode = '40001',
        message = 'Protected record restore closure changed';
    end if;
    revisions := vortex_record.apply_record_lifecycle_generated_values_internal(
      preparation, true, p_mutations
    );
    select (item.value ->> 'concurrencyNumber')::bigint into strict restored_revision
    from pg_catalog.jsonb_array_elements(revisions) as item(value)
    where item.value ->> 'recordKey' = 'root';

    perform vortex_record.append_record_activity_internal(p_activity_id, 'restore_record', array[p_record_id]::uuid[], array[]::uuid[], 'completed');

    perform vortex_record.complete_command_receipt_internal(
      'record_restore', p_command_id, p_record_id, restored_revision,
      'Protected record restore receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'restored',
      'recordId', p_record_id,
      'concurrencyNumber', restored_revision,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'transfer_ownership' then
    -- The transfer's target is the command's ordered mutation list; it carries
    -- one transfer_ownership mutation with the exact installed target kind and
    -- identifier, never an authority.
    if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or not ((p_mutations -> 0) ?& array['kind', 'targetKind', 'targetId'])
      or (p_mutations -> 0) - array['kind', 'targetKind', 'targetId']::text[] <> '{}'::jsonb
      or (p_mutations -> 0 ->> 'kind') is distinct from 'transfer_ownership'
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetKind') is distinct from 'string'
      or (p_mutations -> 0 ->> 'targetKind') not in ('organization_account', 'group')
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_mutations -> 0 ->> 'targetId', 'uuid') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    target_kind := p_mutations -> 0 ->> 'targetKind';
    target_id := (p_mutations -> 0 ->> 'targetId')::uuid;
    if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_type_id is null or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or target_kind is null
      or target_kind not in ('organization_account', 'group')
      or target_id is null or target_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    context_value := vortex_access.lock_human_request_access_version_internal();
    if not context_value ? 'applicationRootId' then
      raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
    end if;
    organization_id_value := (context_value ->> 'organizationId')::uuid;
    application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
    actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', p_command_id, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
        );
      end if;
      -- A replay reprojects from current access and intentionally never returns
      -- owner metadata (including the prior target).
      loaded := (vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      )) -> 'record';
      if loaded ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'transferred', 'recordId', loaded -> 'recordId',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId', 'replayed', true
      );
    end if;
    -- The closed transfer authority is its own exact record permission decision;
    -- it is evaluated under the record lock, while owner columns remain
    -- unavailable to the ordinary update writer.
    -- Public transfer is active-installation-only.  It deliberately never calls
    -- the retained/detached reader, so a detached record cannot leak its current
    -- revision through the ordinary conflict response.
    begin
      installation := vortex_definition.read_current_active_installation();
    exception
      when no_data_found then
        perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
    end;
    loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, installation
    );
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
    select item.value into record_type_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    if record_fact is null or record_type_fact is null
      or record_fact ->> 'lifecycleState' <> 'active' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    ownership_mode := record_type_fact ->> 'ownershipMode';
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', loaded -> 'declaration',
        'recordId', p_record_id,
        'facts', loaded -> 'facts'
      )
    )) -> 0);
    if decision ->> 'outcome' = 'refused' then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Record ownership transfer authority is unavailable';
    end if;
    if ownership_mode = 'organization_account' then
      previous_owner_id := (record_fact ->> 'ownerOrganizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      previous_owner_id := (record_fact ->> 'ownerGroupId')::uuid;
    else
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'ownership_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if (ownership_mode = 'organization_account' and target_kind <> 'organization_account')
      or (ownership_mode = 'group' and target_kind <> 'group')
      or previous_owner_id is null or previous_owner_id = target_id
      or not vortex_access.lock_active_record_ownership_target_internal(target_kind, target_id) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'owner_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    execute pg_catalog.format(
      'update record_data.%I as stored set owner_organisation_account_id = $3,
         owner_group_id = $4, concurrency_number = concurrency_number + 1,
         updated_at = pg_catalog.statement_timestamp(), updated_by = $5
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.concurrency_number = $6 returning stored.record_id, stored.concurrency_number',
      loaded ->> 'table'
    ) into updated_record_id, updated_concurrency_number using organization_id_value, p_record_id,
      case when target_kind = 'organization_account' then target_id else null end,
      case when target_kind = 'group' then target_id else null end,
      actor_id_value, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record ownership transfer revision changed';
    end if;
    if updated_record_id is distinct from p_record_id
      or updated_concurrency_number is null
      or updated_concurrency_number not between 1 and 9007199254740991 then
      raise exception using errcode = '55000', message = 'Record ownership transfer saved identity is unavailable';
    end if;
    perform vortex_access.invalidate_preview_installations_internal(organization_id_value);
    perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[p_record_id]::uuid[], array[]::uuid[], 'completed');
    event_result := vortex_platform.append_record_occurrences(
      (record_type_fact ->> 'storageContractId')::uuid,
      p_record_id, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
        ), 'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    perform vortex_record.complete_command_receipt_internal(
      'record_save', p_command_id, p_record_id, updated_concurrency_number,
      'Record ownership transfer receipt is stale'
    );
    if record_fact #>> '{recordScope,storageScope}' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          updated_record_id, updated_concurrency_number, 'changed',
          notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        -- Invalidation is advisory after the protected transfer is complete.
        null;
      end;
    elsif record_fact #>> '{recordScope,storageScope}' = 'organization_shared' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Shared ownership transfer notice sequence is unavailable';
        end if;

        if record_fact -> 'recordScope' ->> 'moduleRootId'
            is distinct from record_type_fact ->> 'moduleRootId'
          or record_fact -> 'recordScope' ->> 'storageContractId'
            is distinct from record_type_fact ->> 'storageContractId'
          or not vortex_platform.is_non_nil_uuid(record_fact -> 'recordScope' ->> 'moduleRootId')
          or not vortex_platform.is_non_nil_uuid(record_type_fact ->> 'storageContractId') then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer record lineage is unavailable';
        end if;

        shared_consumers_initial := vortex_definition.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if pg_catalog.jsonb_typeof(shared_consumers_initial) is distinct from 'object'
          or not (shared_consumers_initial ?& array['organizationId', 'accessVersion', 'targets'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(shared_consumers_initial)) <> 3
          or shared_consumers_initial ->> 'organizationId' is distinct from organization_id_value::text
          or not pg_catalog.pg_input_is_valid(shared_consumers_initial ->> 'accessVersion', 'bigint')
          or (shared_consumers_initial ->> 'accessVersion')::bigint
            is distinct from (context_value ->> 'accessVersion')::bigint
          or pg_catalog.jsonb_typeof(shared_consumers_initial -> 'targets') is distinct from 'array'
          or pg_catalog.jsonb_array_length(shared_consumers_initial -> 'targets') = 0 then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer consumer selection is malformed';
        end if;

        previous_target_application_root_id := null;
        origin_application_is_consumer := false;
        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          if pg_catalog.jsonb_typeof(target_item) is distinct from 'object'
            or not (target_item ?& array[
              'applicationRootId', 'applicationReleaseRevision', 'moduleRootId',
              'moduleReleaseRevision', 'bindingRevision', 'recordTypeId',
              'storageContractId', 'registrationRevision', 'definitionKey',
              'releaseVersion', 'validationContractVersion', 'contentFingerprint',
              'resolutionFingerprint', 'catalogueFingerprint', 'moduleBindings'
            ])
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(target_item)) <> 15
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'applicationRootId')
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'moduleRootId')
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'storageContractId')
            or not pg_catalog.pg_input_is_valid(target_item ->> 'applicationReleaseRevision', 'bigint')
            or (target_item ->> 'applicationReleaseRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'moduleRootId' is distinct from record_fact -> 'recordScope' ->> 'moduleRootId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'moduleReleaseRevision', 'bigint')
            or (target_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
            or not pg_catalog.pg_input_is_valid(target_item ->> 'bindingRevision', 'bigint')
            or (target_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'recordTypeId' is distinct from p_record_type_id::text
            or target_item ->> 'storageContractId'
              is distinct from record_type_fact ->> 'storageContractId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'registrationRevision', 'bigint')
            or (target_item ->> 'registrationRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'definitionKey' is null or target_item ->> 'definitionKey' = ''
            or target_item ->> 'releaseVersion' is null or target_item ->> 'releaseVersion' = ''
            or target_item ->> 'validationContractVersion' is null
            or target_item ->> 'validationContractVersion' = ''
            or target_item ->> 'contentFingerprint' is null
            or target_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'resolutionFingerprint' is null
            or target_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'catalogueFingerprint' is null
            or target_item ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or pg_catalog.jsonb_typeof(target_item -> 'moduleBindings') is distinct from 'array'
            or pg_catalog.jsonb_array_length(target_item -> 'moduleBindings') = 0 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer evidence is malformed';
          end if;

          target_application_root_id := (target_item ->> 'applicationRootId')::uuid;
          if previous_target_application_root_id is not null
            and target_application_root_id <= previous_target_application_root_id then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer set is not unique and ordered';
          end if;
          previous_target_application_root_id := target_application_root_id;
          if target_application_root_id = application_root_id_value then
            origin_application_is_consumer := true;
          end if;

          previous_target_module_root_id := null;
          target_module_binding_count := 0;
          for module_item in
            select binding.value
            from pg_catalog.jsonb_array_elements(target_item -> 'moduleBindings') as binding(value)
            order by (binding.value ->> 'moduleRootId')::uuid
          loop
            if pg_catalog.jsonb_typeof(module_item) is distinct from 'object'
              or not (module_item ?& array[
                'moduleRootId', 'bindingRevision', 'applicationReleaseRevision',
                'moduleReleaseRevision', 'state', 'contentFingerprint',
                'resolutionFingerprint', 'generatorContractVersion', 'storageContractIds'
              ])
              or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(module_item)) <> 9
              or not vortex_platform.is_non_nil_uuid(module_item ->> 'moduleRootId')
              or not pg_catalog.pg_input_is_valid(module_item ->> 'bindingRevision', 'bigint')
              or (module_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
              or not pg_catalog.pg_input_is_valid(module_item ->> 'applicationReleaseRevision', 'bigint')
              or (module_item ->> 'applicationReleaseRevision')::bigint
                is distinct from (target_item ->> 'applicationReleaseRevision')::bigint
              or not pg_catalog.pg_input_is_valid(module_item ->> 'moduleReleaseRevision', 'bigint')
              or (module_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
              or module_item ->> 'state' is distinct from 'active'
              or module_item ->> 'contentFingerprint' is null
              or module_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'resolutionFingerprint' is null
              or module_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'generatorContractVersion' is distinct from '1.0.0'
              or pg_catalog.jsonb_typeof(module_item -> 'storageContractIds') is distinct from 'array'
              or pg_catalog.jsonb_array_length(module_item -> 'storageContractIds') = 0
              or exists (
                select 1
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                where pg_catalog.jsonb_typeof(contract.value) is distinct from 'string'
                  or not vortex_platform.is_non_nil_uuid(contract.value #>> '{}')
              )
              or exists (
                select contract.value
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                group by contract.value having pg_catalog.count(*) <> 1
              )
              or module_item -> 'storageContractIds' is distinct from (
                select pg_catalog.jsonb_agg(contract.value order by (contract.value #>> '{}')::uuid)
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
              ) then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module binding evidence is malformed';
            end if;

            target_module_root_id := (module_item ->> 'moduleRootId')::uuid;
            if previous_target_module_root_id is not null
              and target_module_root_id <= previous_target_module_root_id then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module bindings are not unique and ordered';
            end if;
            previous_target_module_root_id := target_module_root_id;
            if target_module_root_id = (target_item ->> 'moduleRootId')::uuid then
              target_module_binding_count := target_module_binding_count + 1;
              if (module_item ->> 'moduleReleaseRevision')::bigint
                  is distinct from (target_item ->> 'moduleReleaseRevision')::bigint
                or (module_item ->> 'bindingRevision')::bigint
                  is distinct from (target_item ->> 'bindingRevision')::bigint
                or not exists (
                  select 1
                  from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                  where contract.value #>> '{}' = target_item ->> 'storageContractId'
                ) then
                raise exception using errcode = '55000',
                  message = 'Shared ownership transfer target binding does not match its complete Module lineage';
              end if;
            end if;
          end loop;
          if target_module_binding_count <> 1 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer target Module binding is ambiguous';
          end if;
        end loop;

        if not origin_application_is_consumer then
          raise exception using errcode = '42501',
            message = 'Origin Application is not a proved shared record consumer';
        end if;

        shared_consumers_final := vortex_definition.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if shared_consumers_final is distinct from shared_consumers_initial then
          raise exception using errcode = '40001',
            message = 'Shared ownership transfer consumer snapshot changed before publication';
        end if;
        context_after := vortex_access.validated_human_request_context();
        if context_after is distinct from context_value then
          raise exception using errcode = '40001',
            message = 'Human ownership transfer context changed before publication';
        end if;

        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          perform vortex_platform.publish_change_notice(
            organization_id_value, (target_item ->> 'applicationRootId')::uuid,
            p_record_type_id, updated_record_id, updated_concurrency_number, 'changed',
            notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
          );
        end loop;
      exception when others then
        -- The completed transfer is structural. All App-scoped notices are one
        -- advisory subtransaction, so a failure rolls back every send together.
        null;
      end;
    else
      raise exception using errcode = '55000',
        message = 'Ownership transfer storage scope is unavailable';
    end if;
    -- This is deliberately an undisclosed result: an authorised transfer may
    -- remove the operator's read path.  A post-write projection would turn that
    -- valid committed mutation into a rollback.  Exact replay still applies
    -- current disclosure separately above.
    return pg_catalog.jsonb_build_object(
      'outcome', 'transferred', 'recordId', updated_record_id,
      'concurrencyNumber', updated_concurrency_number,
      'correlationId', context_value -> 'correlationId', 'replayed', false
    );
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
end
$function$;

alter function vortex_record.apply_lifecycle_record_changes_internal(text,uuid,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_record_adapter;
comment on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Private lifecycle implementation reached only through apply_record_changes. Delete claims, traverses and finalises in two calls within one request transaction; restore and ownership transfer retain their own receipt, Activity and Event handling.';

create or replace function vortex_record.apply_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_action jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := case when p_action is not null then 'named_action' else 'record_save' end;
  action_owner_kind text;
  action_owner_id uuid;
  action_release_revision bigint;
  action_id_value uuid;
  action_inputs jsonb;
  action_context jsonb;
  original_context_value jsonb;
  action_final_values jsonb := '{}'::jsonb;
  action_creations jsonb := '[]'::jsonb;
  action_creation_occurrence_ids jsonb := '[]'::jsonb;
  action_parents jsonb := '[]'::jsonb;
  action_declared_occurrence_ids jsonb := '[]'::jsonb;
  action_set_field_ids jsonb;
  action_set_fields_seen boolean := false;
  action_events_seen boolean := false;
  subject_write boolean := true;
  subject_written boolean := false;
  result_value jsonb;
  creation_plan jsonb;
  create_targets jsonb;
  creation_count integer := 0;
  preparation_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  creation jsonb;
  copy_plan jsonb;
  preview_installation jsonb;
  effective_command_id uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  mutation_value jsonb;
  projection jsonb;
  relationship_value jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  final_values jsonb := '{}'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  relationship_change jsonb;
  increment_for_relationship boolean;
  update_bounds jsonb;
  proposed_field_values jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  notice_sequence bigint;
  named_relationship_subject_saved boolean := false;
  named_action_receipt_pending boolean := false;
  named_action_receipt_subject_write boolean := false;
  changed_rows integer;
  changed_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
  event_kind text;
  event_payload jsonb;
  event_result jsonb;
  classification_value jsonb;
  delete_effect record;
  offboarding_scope record;
  offboarding_transfer jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  if preview_installation is not null
    and (p_action is not null
      or p_operation in ('delete', 'restore', 'transfer_ownership', 'settings')) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'preview_effect_refused'
    );
  end if;

  -- An account offboarding transfer of a retained row or of a detached installation's record has
  -- its own facts and the accounts.manage authority of the offboarding inventory, rechecked here
  -- for every record against the access version the inventory was disclosed at.
  if p_operation = 'transfer_ownership'
    and pg_catalog.jsonb_typeof(p_mutations) = 'array'
    and pg_catalog.jsonb_array_length(p_mutations) = 1
    and p_mutations -> 0 ->> 'kind' = 'offboarding_transfer' then
    offboarding_transfer := p_mutations -> 0;
    if p_action is not null
      or p_selected_group_id is not null
      or p_submitted_values is distinct from '{}'::jsonb
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'expectedAccessVersion') is distinct from 'number'
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'sourceOrganizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'targetId') is distinct from 'string' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    select authorized.* into strict offboarding_scope
    from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;
    if offboarding_scope.access_version
      is distinct from (offboarding_transfer ->> 'expectedAccessVersion')::bigint then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
    end if;
    return vortex_record.transfer_record_ownership_for_offboarding_internal(
      p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
      offboarding_transfer ->> 'targetKind', (offboarding_transfer ->> 'targetId')::uuid,
      p_activity_id, p_occurrence_id,
      (offboarding_transfer ->> 'sourceOrganizationAccountId')::uuid
    );
  end if;

  -- Every lifecycle write, including the delete traversal and its finalisation,
  -- enters here. Delete preparation uses null mutations; calculated parent
  -- mutations complete the same receipt within the same request transaction.
  if p_operation in ('delete', 'restore', 'transfer_ownership') then
    if p_action is not null
      or p_selected_group_id is not null
      or p_submitted_values is distinct from '{}'::jsonb then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    result_value := vortex_record.apply_lifecycle_record_changes_internal(
      p_operation, p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_mutations, p_activity_id, p_occurrence_id
    );
    if p_operation = 'delete' and result_value ->> 'outcome' = 'deleted'
      and result_value ->> 'replayed' = 'false' then
      context_value := vortex_access.validated_human_request_context();
      -- Publish once per deleted record after totals, Activity, Events and the
      -- receipt are complete. Replays and preparations publish nothing.
      for delete_effect in
        select effect.*
        from vortex_record.record_lifecycle_command_effects as effect
        join vortex_record.storage_catalogue as storage
          on storage.storage_contract_id = effect.storage_contract_id
        where effect.command_id = p_command_id
          and effect.organization_id = (context_value ->> 'organizationId')::uuid
          and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
          and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
          and effect.effect_kind = 'soft_deleted'
          and storage.storage_scope = 'application_contained'
        order by effect.effect_sequence
      loop
        begin
          notice_sequence := pg_catalog.nextval(
            'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
          );
          perform vortex_platform.publish_change_notice(
            delete_effect.organization_id, delete_effect.application_root_id,
            delete_effect.record_type_id, delete_effect.record_id,
            delete_effect.post_concurrency_number, 'deleted',
            notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
          );
        exception when others then
          raise warning 'Record delete notice failed: [%] %', sqlstate, sqlerrm;
        end;
      end loop;
    end if;
    return result_value;
  end if;

  -- Settings use the same command entry and one settings mutation. Their
  -- physical row belongs to Identity, so the protected implementation below
  -- performs the specialised write and the common Record effects once.
  if p_operation = 'settings' then
    if p_action is not null
      or p_selected_group_id is not null
      or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or (p_mutations -> 0 ->> 'kind') is distinct from 'settings'
      or (p_mutations -> 0) - array['kind', 'values']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'values') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    return vortex_record.apply_settings_record_changes_internal(
      p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values,
      p_mutations -> 0 -> 'values', p_activity_id, p_occurrence_id
    );
  end if;

  -- The command is closed: one operation, one subject, one ordered mutation list
  -- of the kinds this operation supports. A create is one create_subject; an
  -- update is one or more set_fields applied in list order.
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_mutations) = 0
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    ))
    or (p_action is not null and p_operation is distinct from 'update') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  if p_action is not null then
    -- A named action names its exact installed action and carries its typed
    -- inputs; the field rules and the facts all follow
    -- from that identity. Nothing about the actor or the organization is read
    -- from it: both come from the verified request context below.
    if pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
      or not (p_action ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs'])
      or p_action - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs']::text[]
        <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_action -> 'ownerKind') is distinct from 'string'
      or (p_action ->> 'ownerKind') not in ('application', 'module')
      or pg_catalog.jsonb_typeof(p_action -> 'ownerId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'ownerId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'actionId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'actionId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'releaseRevision') is distinct from 'number'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'releaseRevision', 'bigint')
      or pg_catalog.jsonb_typeof(p_action -> 'inputs') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    action_owner_kind := p_action ->> 'ownerKind';
    action_owner_id := (p_action ->> 'ownerId')::uuid;
    action_id_value := (p_action ->> 'actionId')::uuid;
    action_release_revision := (p_action ->> 'releaseRevision')::bigint;
    action_inputs := p_action -> 'inputs';
    if action_release_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  if p_action is null then
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or not (mutation ?& array['kind', 'values'])
        or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string'
        or (mutation ->> 'kind') not in ('create_subject', 'set_fields')
        or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;

    if p_operation = 'create' then
      if pg_catalog.jsonb_array_length(p_mutations) <> 1
        or (p_mutations -> 0 ->> 'kind') is distinct from 'create_subject' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    elsif exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
      where item.value ->> 'kind' = 'create_subject'
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  else
    -- A named action's mutation list is closed too: exactly one set_fields on
    -- the subject (possibly empty), the action's creations in authored order,
    -- its relationship copies, the revision-checked derived-total updates of
    -- the other records it moves, and its declared Event identities. Only the
    -- subject-write, creation and parent mutations carry values; a relationship
    -- copy is a statement of intent the database re-derives from the installed
    -- action and its inputs, never an authority it trusts.
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      if mutation ->> 'kind' = 'set_fields' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or action_set_fields_seen then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_set_fields_seen := true;
        action_final_values := mutation -> 'values';
      elsif mutation ->> 'kind' = 'create_record' then
        if not (mutation ?& array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ])
          or mutation - array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'ordinal') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'ordinal', 'integer')
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'occurrenceId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_creations := action_creations || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'ordinal', mutation -> 'ordinal',
            'recordTypeId', mutation -> 'recordTypeId',
            'values', mutation -> 'values',
            'finalValues', mutation -> 'finalValues'
          )
        );
        action_creation_occurrence_ids := action_creation_occurrence_ids
          || pg_catalog.jsonb_build_array(mutation -> 'occurrenceId');
      elsif mutation ->> 'kind' = 'copy_relationships' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or mutation -> 'values' is distinct from '{}'::jsonb then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
      elsif mutation ->> 'kind' = 'set_derived_fields' then
        if not (mutation ?& array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ])
          or mutation - array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'recordId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'expectedConcurrencyNumber') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'expectedConcurrencyNumber', 'bigint')
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_parents := action_parents || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'recordTypeId', mutation -> 'recordTypeId',
            'recordId', mutation -> 'recordId',
            'expectedConcurrencyNumber', mutation -> 'expectedConcurrencyNumber',
            'finalValues', mutation -> 'finalValues'
          )
        );
      elsif mutation ->> 'kind' = 'announce_events' then
        if not (mutation ?& array['kind', 'occurrenceIds'])
          or mutation - array['kind', 'occurrenceIds']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceIds') is distinct from 'array'
          or action_events_seen
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(mutation -> 'occurrenceIds') as item(value)
            where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
              or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
          ) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_events_seen := true;
        action_declared_occurrence_ids := mutation -> 'occurrenceIds';
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;
    if not action_set_fields_seen then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  original_context_value := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'organizationAccountId', actor_id_value,
    'correlationId', correlation_id_value
  );

  creation_count := pg_catalog.jsonb_array_length(action_creations);

  if action_mode then
    -- A replay never re-prepares: an existing receipt short-circuits the
    -- creation plan, the relationship-total preparation and the copy plan, and
    -- the subject step below answers from the stored receipt.
    action_context := vortex_record.resolve_named_action_context_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id
    );
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      creation_plan := vortex_record.named_action_creation_plan_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, action_creations, action_context
      );
      if creation_plan ->> 'outcome' = 'unsupported' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode'
        );
      end if;
      if creation_plan ->> 'outcome' <> 'planned' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', coalesce(creation_plan ->> 'reasonCode', 'command_invalid')
        );
      end if;
      create_targets := creation_plan -> 'createTargets';

      preparation_value := vortex_record.prepare_named_action_command_totals(
        p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
        p_submitted_values, action_creations, p_activity_id, action_owner_kind,
        action_owner_id, action_release_revision, action_id_value
      );
      if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
        return preparation_value;
      end if;
      if preparation_value ->> 'outcome' = 'defer'
        and vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
        preparation_value := null;
      elsif preparation_value ->> 'outcome' = 'defer' then
        -- With an installed BeforeSave flow the closure is not computed, so a command that
        -- would move a total must refuse rather than silently skip it. A
        -- create-bearing command already refused inside the preparation, so only
        -- the set/announce shape reaches here.
        catalogue := vortex_record.relationship_total_catalogue_internal();
        if coalesce((catalogue ->> 'hasBeforeSaveFlows')::boolean, false) then
          closure_value := vortex_record.discover_relationship_total_closure_internal(
            catalogue, 'update', p_record_type_id, p_record_id, p_submitted_values
          );
          select item.value into root_type
          from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
          where pg_catalog.lower(item.value ->> 'recordTypeId') =
            pg_catalog.lower(p_record_type_id::text);
          select item.value into root_snapshot
          from pg_catalog.jsonb_array_elements(closure_value -> 'records') item(value)
          where item.value ->> 'recordKey' = 'root';
          if root_type is null or root_snapshot is null then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
          for relationship_value, target_type in
            select item.value, target.value
            from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
            join pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') target(value)
              on vortex_record.relationship_declares_target_internal(
                item.value, (target.value ->> 'recordTypeId')::uuid
              )
            where item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
            order by item.value ->> 'relationshipId', target.value ->> 'recordTypeId'
          loop
            relationship_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
            old_relationship_target := root_snapshot -> 'existingValues' -> relationship_field_id;
            proposed_relationship_target := old_relationship_target;
            if p_submitted_values ? relationship_field_id then
              proposed_relationship_target := p_submitted_values -> relationship_field_id;
            end if;
            if not (
              (pg_catalog.jsonb_typeof(old_relationship_target) = 'object' and
                pg_catalog.lower(old_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
              or
              (pg_catalog.jsonb_typeof(proposed_relationship_target) = 'object' and
                pg_catalog.lower(proposed_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
            ) then
              continue;
            end if;
            for total_field in
              select field.value
              from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
              where field.value ->> 'type' = 'total'
                and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
                  pg_catalog.lower(relationship_value ->> 'relationshipId')
            loop
              if p_submitted_values ? relationship_field_id and
                p_submitted_values -> relationship_field_id is distinct from
                  coalesce(root_snapshot -> 'existingValues' -> relationship_field_id, 'null'::jsonb) then
                contributes_to_total := true;
                exit;
              end if;
              dependency_contract := vortex_record.total_dependency_contract_internal(
                catalogue -> 'recordTypes',
                pg_catalog.jsonb_build_array(relationship_value),
                (target_type ->> 'recordTypeId')::uuid, total_field
              );
              for dependency_field_id in
                select item.value
                from pg_catalog.jsonb_array_elements_text(
                  dependency_contract -> 'sourceFieldIds'
                ) item(value)
              loop
                if action_final_values ? dependency_field_id and
                  action_final_values -> dependency_field_id is distinct from
                    coalesce(root_snapshot -> 'existingValues' -> dependency_field_id, 'null'::jsonb) then
                  contributes_to_total := true;
                  exit;
                end if;
              end loop;
              exit when contributes_to_total;
            end loop;
            exit when contributes_to_total;
          end loop;
          if contributes_to_total then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
        end if;
      end if;

      if preparation_value ->> 'outcome' is distinct from 'prepared' then
        if pg_catalog.jsonb_array_length(action_parents) = 0 then
          preparation_value := null;
        else
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      else
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.lower(field.value ->> 'fieldId')
                order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
              )
              from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
              where field.value ->> 'type' in ('total', 'calculation')
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into expected_parents
        from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
        where item.value ->> 'recordKey' <> 'root'
          and pg_catalog.left(item.value ->> 'recordKey', 7) <> 'create:';
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(field_id order by field_id collate "C")
              from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') field(field_id)
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into supplied_parents
        from pg_catalog.jsonb_array_elements(action_parents) item(value)
        where pg_catalog.jsonb_typeof(item.value) = 'object'
          and item.value ?& array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]
          and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
        if supplied_parents is distinct from expected_parents
          or pg_catalog.jsonb_array_length(supplied_parents) <>
            pg_catalog.jsonb_array_length(action_parents) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;

    -- The target row and every linked row of a relationship copy are locked
    -- here, before the counters and data versions below and before any edge
    -- identity, so the lock classes keep their order. A replay copies nothing.
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, action_inputs, action_context
      );
      if copy_plan ->> 'outcome' = 'refused' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode'
        );
      end if;
    end if;
    -- Take every created record's reference-number counter (L4), then the data
    -- version of the subject's and every created record's storage scope, before
    -- the subject step writes the subject's relationship edges (L6), matching
    -- ordinary create's row, counter, data version, edge order.
    if creation_count > 0 and create_targets is not null then
      perform vortex_record.reserve_named_action_creation_locks_internal(
        p_record_type_id, action_creations
      );
    end if;

    if pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(
          action_context -> 'action' -> 'tasks'
        ) task(value)
        where task.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'unsupported');
    end if;
    select coalesce(pg_catalog.jsonb_agg(field_id order by field_id collate "C"), '[]'::jsonb)
    into action_set_field_ids
    from (
      select distinct pg_catalog.lower(key.field_key) as field_id
      from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
      cross join lateral pg_catalog.jsonb_object_keys(
        task.value -> 'properties' -> 'values'
      ) key(field_key)
      where task.value ->> 'type' = 'record.set_fields'
    ) fields;
    if action_set_field_ids is distinct from coalesce((
        select pg_catalog.jsonb_agg(key order by key collate "C")
        from pg_catalog.jsonb_object_keys(p_submitted_values) key
      ), '[]'::jsonb)
      or pg_catalog.jsonb_array_length(action_context -> 'eventDescriptors') <>
        pg_catalog.jsonb_array_length(action_declared_occurrence_ids)
      or pg_catalog.jsonb_array_length(action_creation_occurrence_ids) <> creation_count then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    -- A create-only action whose created record moves one of the subject's own
    -- totals still has to write the subject, so the subject is written whenever
    -- a record.set_fields task exists or the final-value map is non-empty.
    subject_write := pg_catalog.jsonb_array_length(action_set_field_ids) > 0
      or action_final_values <> '{}'::jsonb;
  end if;

  <<subject_step>>
  begin
  if action_mode and not subject_write then
    -- The announce-only shape: the action writes nothing to the subject, so its
    -- receipt, Activity and declared Events are the whole subject step.
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', loaded -> 'declaration',
        'recordId', p_record_id,
        'facts', loaded -> 'facts'
      )
    )) -> 0);
    if decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object('outcome', 'conflict');
      end if;
      return vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end if;
    perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'completed');
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if creation_count = 0 then
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, p_record_id, p_expected_concurrency_number,
        'Named action receipt is stale'
      );
    else
      named_action_receipt_pending := true;
    end if;
    result_value := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id
    );
    if result_value ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    result_value := result_value || pg_catalog.jsonb_build_object('replayed', false);
    exit subject_step;
  end if;

  if action_mode then
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
    );
  else
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', effective_command_id, false
    );
  end if;
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if action_mode then
      projection := vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    else
      projection := (vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      )) -> 'record';
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  if action_mode then
    meta := action_context;
  else
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, p_operation
    );
  end if;
  -- Recheck the ordinary operation at persistence. A named action has its own authority.
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (not action_mode
      and not coalesce((meta #> '{recordType,standardActions}') ? p_operation, false)) then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Collapse the ordered mutation list into one final value map. A create_subject
  -- starts the map; each set_fields in list order overrides the fields it names.
  -- A named action already carries its single subject set_fields as the map.
  if action_mode then
    final_values := action_final_values;
  else
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      mutation_value := mutation -> 'values';
      if mutation ->> 'kind' = 'create_subject' then
        final_values := mutation_value;
      else
        final_values := final_values || mutation_value;
      end if;
    end loop;
  end if;

  classification_value := vortex_record.classify_record_change_values_internal(
    p_record_type_id, final_values, meta, p_submitted_values,
    organization_id_value, application_root_id_value, receipt_kind, effective_command_id
  );
  if classification_value ->> 'outcome' <> 'classified' then
    return classification_value;
  end if;
  relationship_changes := classification_value -> 'relationshipChanges';
  value_final_values := classification_value -> 'valueFinalValues';
  select coalesce(pg_catalog.array_agg(item.value::uuid order by item.ordinality), array[]::uuid[])
  into value_submitted_field_ids
  from pg_catalog.jsonb_array_elements_text(classification_value -> 'valueSubmittedFieldIds')
    with ordinality item(value, ordinality);

  if p_operation = 'update' then
    if action_mode then
      loaded := vortex_record.load_named_action_facts_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
      );
    else
      loaded := (vortex_record.load_record_access_facts_internal(
        'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', p_record_id,
          'expectedConcurrencyNumber', p_expected_concurrency_number
        ))
      ) -> 0);
    end if;
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object') then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    if preview_installation is null then
      decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'declaration', meta -> 'declaration',
          'recordId', p_record_id,
          'facts', (loaded -> 'facts') || pg_catalog.jsonb_build_object( 'binding', meta -> 'declaration' -> 'recordBinding' )
        )
      )) -> 0);
      if decision ->> 'outcome' = 'refused' then
        if action_mode then
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
        else
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
        );
      elsif decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '42501',
          message = 'Record save authority is unavailable';
      end if;
      update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      update_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if update_bounds is null then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          update_bounds -> 'changeableFieldIds'
        ) as allowed(value)
        where pg_catalog.lower(allowed.value) =
          pg_catalog.lower(relationship_change ->> 'fieldId')
      ) then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'field_not_changeable'
        );
      end if;
    end loop;

    -- Build the complete proposed source facts before the first mutation. A
    -- changed fixed relationship replaces its old edge; the exact validated
    -- target's private facts are loaded only inside this operation and are
    -- never returned. The same current update declaration must still allow the
    -- source under the complete proposed values and graph.
    proposed_field_values := (loaded -> 'fieldValues') || final_values;
    proposed_records := loaded -> 'facts' -> 'records';
    proposed_edges := loaded -> 'facts' -> 'edges';

    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
        if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'object'
          or not ((relationship_change -> 'value') ?& array['recordTypeId', 'recordId'])
          or (relationship_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordTypeId', 'uuid'
          )
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordId', 'uuid'
          )
          or (relationship_change -> 'value' ->> 'recordTypeId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid
          or (relationship_change -> 'value' ->> 'recordId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
        target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(
          relationship_change -> 'relationship', target_record_type_id
        ) then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        target_loaded := (vortex_record.load_record_access_facts_internal(
          'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordTypeId', target_record_type_id,
            'recordId', target_record_id
          ))
        ) -> 0);
        if target_loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        -- Only a record of this application's own Module uses preview-owner authority.
        -- Borrowed records and live projections still need the builder's current permission.
        if preview_installation is not null
          and target_loaded ->> 'previewInstallationId' = preview_installation ->> 'previewInstallationId'
          and exists (
            select 1 from vortex_definition.roots as root
            where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
              and root.owner_application_root_id = application_root_id_value
          ) then
          target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
        else
          if pg_catalog.jsonb_array_length(
            target_loaded #> '{declaration,requiredPermissions}'
          ) = 0 then
            perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
            );
          end if;
          target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'declaration', pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}', '{"kind":"permission"}'::jsonb),
              'recordId', target_record_id,
              'facts', target_loaded -> 'facts'
            )
          )) -> 0);
        end if;
        if target_decision ->> 'outcome' <> 'allowed' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
      end if;
    end loop;

    -- The one canonical lock prelude: every changed link's target row is
    -- share-locked in relationship identity order here, after each target has
    -- passed the same access decision the writer re-checks and before any
    -- source data version or relationship edge identity is taken. Keeping all
    -- target row locks in one place means no writer orders them on its own.
    perform vortex_record.lock_record_change_targets_internal(
      meta -> 'recordType', organization_id_value, final_values
    );

    -- Target closures may reach the source through a currently permitted
    -- relationship route. Assemble all trusted closures first, then make the
    -- source authoritative exactly once so an old source copy cannot compete
    -- with the proposed values. Other repeated closure records are collapsed by
    -- their permanent Record identity.
    proposed_records := coalesce((
      select pg_catalog.jsonb_agg(
        case when unique_record.record_id = p_record_id
          then unique_record.value || pg_catalog.jsonb_build_object(
            'fieldValues', proposed_field_values
          )
          else unique_record.value end
        order by unique_record.record_id
      )
      from (
        select distinct on (
          (record.value -> 'recordScope' ->> 'recordId')::uuid
        )
          (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
          record.value
        from pg_catalog.jsonb_array_elements(proposed_records) as record(value)
        order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
          record.value::text collate "C"
      ) as unique_record
    ), '[]'::jsonb);

    -- Apply every changed fixed relationship after closure assembly. This one
    -- replacement pass removes old source edges even when a target closure
    -- contained them, then adds only the submitted non-null replacements.
    proposed_edges := coalesce((
      with retained_edges as (
        select edge.value
        from pg_catalog.jsonb_array_elements(proposed_edges) as edge(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
          where (changed.value ->> 'relationshipId')::uuid =
              (edge.value ->> 'relationshipId')::uuid
            and (edge.value ->> 'fromRecordId')::uuid = p_record_id
        )
      ), replacement_edges as (
        select pg_catalog.jsonb_build_object(
          'relationshipId', changed.value -> 'relationshipId',
          'fromRecordId', p_record_id,
          'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
        ) as value
        from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
        where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
      ), unique_edges as (
        select distinct candidate.value
        from (
          select retained.value from retained_edges as retained
          union all
          select replacement.value from replacement_edges as replacement
        ) as candidate(value)
      )
      select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
      from unique_edges as unique_edge
    ), '[]'::jsonb);

    proposed_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'records', proposed_records,
      'edges', proposed_edges
    );
    if preview_installation is null then
      decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'declaration', loaded -> 'declaration',
          'recordId', p_record_id,
          'facts', proposed_facts
        )
      )) -> 0);
      if decision ->> 'outcome' <> 'allowed' then
        if action_mode then
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
        else
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
        );
      end if;
    end if;
  end if;

  if p_operation = 'create' then
    mutation := vortex_record.create_record_internal(
      p_record_type_id, final_values,
      array(
        select key::uuid from pg_catalog.jsonb_object_keys(p_submitted_values) as key
        order by key::uuid
      ), p_selected_group_id
    );
  else
    if final_values = '{}'::jsonb then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if value_final_values <> '{}'::jsonb then
      if action_mode then
        mutation := vortex_record.change_record_by_named_action_internal(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids,
          action_owner_kind, action_owner_id, action_release_revision, action_id_value
        );
      else
        mutation := vortex_record.change_record(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids
        );
      end if;
      increment_for_relationship := false;
    elsif not action_mode
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
      mutation := vortex_record.change_record(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids
      );
      increment_for_relationship := false;
    elsif action_mode
      and p_operation = 'update'
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0
      and creation_count = 0
      and pg_catalog.jsonb_typeof(action_parents) = 'array'
      and pg_catalog.jsonb_array_length(action_parents) = 0
      and (case
        when copy_plan is null then true
        when pg_catalog.jsonb_typeof(copy_plan) = 'object'
          and copy_plan ->> 'outcome' = 'planned'
          and pg_catalog.jsonb_typeof(copy_plan -> 'copies') = 'array'
          then pg_catalog.jsonb_array_length(copy_plan -> 'copies') = 0
        else false
      end)
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
        where task.value ->> 'type' = 'record.delete'
      ) then
      -- The named declaration and proposed graph already passed their protected
      -- decisions and target locks. Save one actual subject tuple before edges.
      execute pg_catalog.format(
        'update record_data.%I as stored
         set concurrency_number = stored.concurrency_number + 1,
           updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
           definition_revision = $4
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.concurrency_number = $5
         returning stored.record_id, stored.concurrency_number',
        loaded ->> 'table'
      ) into saved_record_id, saved_concurrency_number
      using organization_id_value, p_record_id, actor_id_value,
        (loaded ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
      get diagnostics changed_rows = row_count;
      if changed_rows <> 1 then
        raise exception using errcode = '40001',
          message = 'Named relationship change did not apply to exactly one row';
      end if;
      if saved_record_id is distinct from p_record_id
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named relationship saved identity is unavailable';
      end if;
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', saved_record_id,
        'concurrencyNumber', saved_concurrency_number
      );
      named_relationship_subject_saved := true;
      increment_for_relationship := false;
    else
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', p_record_id,
        'concurrencyNumber', p_expected_concurrency_number + 1
      );
      increment_for_relationship := true;
    end if;

    if mutation ->> 'outcome' in ('completed', 'allowed') then
      for relationship_change in
        select item.value
        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by (item.value ->> 'relationshipId')::uuid
      loop
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, p_record_id,
          (relationship_change ->> 'relationshipId')::uuid,
          relationship_change -> 'value', increment_for_relationship
        );
        increment_for_relationship := false;
      end loop;
    end if;
  end if;

  if mutation ->> 'outcome' not in ('completed', 'allowed') then
    if preview_installation is null
      and p_operation = 'create' and mutation ->> 'reasonCode' = 'access_refused' then
      activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'create_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return mutation;
  end if;
  saved_record_id := (mutation ->> 'recordId')::uuid;
  saved_concurrency_number := (mutation ->> 'concurrencyNumber')::bigint;
  perform vortex_platform.attach_record_files_internal(p_record_type_id, saved_record_id, meta -> 'recordType', final_values);
  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(
    case when p_operation = 'create' then mutation -> 'values'
      else final_values end
  ) as key;

  if action_mode then
    activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[saved_record_id]::uuid[], changed_field_ids, 'completed');
  elsif preview_installation is null then
    activity_time := vortex_record.append_record_activity_internal(p_activity_id, case when p_operation = 'create' then 'create_record' else 'update_record' end, array[saved_record_id]::uuid[], changed_field_ids, 'completed');
  end if;

  if preview_installation is null then
    event_kind := case when p_operation = 'create' then 'created' else 'changed' end;
    event_payload := case when p_operation = 'create'
      then pg_catalog.jsonb_build_object('kind', 'created')
      else pg_catalog.jsonb_build_object(
        'kind', 'changed',
        'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      ) end;
    event_result := vortex_platform.append_record_occurrences(
      (meta ->> 'storageContractId')::uuid,
      saved_record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', event_kind,
          'recordTypeId', p_record_type_id
        ),
        'payload', event_payload
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
  end if;

  if action_mode and creation_count > 0 then
    named_action_receipt_pending := true;
    named_action_receipt_subject_write := true;
  else
    perform vortex_record.complete_command_receipt_internal(
      receipt_kind, effective_command_id, saved_record_id, saved_concurrency_number,
      'Record save receipt is stale'
    );
  end if;

  if action_mode then
    projection := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, saved_record_id
    );
    if projection ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    subject_written := true;
  else
    projection := (vortex_record.read_record(p_record_type_id, saved_record_id)) -> 'record';
    if projection ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '55000',
        message = 'Saved Record projection is unavailable';
    end if;
  end if;
  result_value := pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', case when preview_installation is null
      then 'pending' else 'none' end,
    'replayed', false
  );
  end subject_step;

  if not action_mode then
    if preview_installation is null
      and p_operation = 'update'
      and (
        value_final_values <> '{}'::jsonb
        or pg_catalog.jsonb_array_length(relationship_changes) > 0
      )
      and meta ->> 'storageScope' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          saved_record_id, saved_concurrency_number, 'changed',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception
        when others then
          -- Invalidation is advisory; a lost notice must not refuse the save.
          null;
      end;
    end if;
    return result_value;
  end if;

  return vortex_record.complete_named_action_changes_internal(
    action_owner_kind, action_owner_id, action_release_revision,
    action_id_value, p_record_type_id, p_record_id,
    p_expected_concurrency_number, result_value, subject_written,
    action_context, action_declared_occurrence_ids, creation_count,
    create_targets, action_creations, organization_id_value,
    action_creation_occurrence_ids, original_context_value, copy_plan,
    action_parents, preparation_value, named_action_receipt_pending,
    named_action_receipt_subject_write, effective_command_id, saved_record_id,
    saved_concurrency_number, application_root_id_value, correlation_id_value,
    named_relationship_subject_saved
  );
end
$function$;

alter function vortex_record.apply_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) to vortex_record_adapter;

comment on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) is
  'The one protected Record-change operation: claims one command receipt (a preview command carries its own preview-scoped id) and applies an ordered mutation list under one canonical lock order. Live changes keep their access decisions, Activity, Event and background effects; preview changes belong only to the validated preview owner and append no live effects. Named-action and lifecycle commands are refused in previews.';

create or replace function vortex_record.apply_settings_record_changes_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  record_type_value jsonb;
  field_item jsonb;
  field_id text;
  field_key text;
  field_type text;
  database_type text;
  field_value jsonb;
  candidate_values jsonb;
  core_values jsonb := '{}'::jsonb;
  extension_values jsonb := '{}'::jsonb;
  changed_field_ids uuid[] := array[]::uuid[];
  receipt_claim jsonb;
  access_result jsonb;
  projection jsonb;
  event_result jsonb;
  correlation_id_value uuid;
  application_root_id_value uuid;
  notice_sequence bigint;
  failure_sqlstate text;
  failure_message text;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
    if p_command_id is not null then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  record_type_value := meta -> 'recordType';
  if record_type_value #>> '{systemProjection,protectedView}' is distinct from
      'organization_runtime_settings'
    or not coalesce((record_type_value -> 'standardActions') ? 'update', false)
    or not vortex_definition.is_platform_system_module_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta -> 'context' ->> 'organizationId')::uuid
    ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;

  correlation_id_value := (meta -> 'context' ->> 'correlationId')::uuid;
  application_root_id_value := (meta -> 'context' ->> 'applicationRootId')::uuid;
  if p_record_id is distinct from (meta -> 'context' ->> 'organizationId')::uuid then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;

  loaded := (vortex_record.load_record_access_facts_internal(
    'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id,
      'recordId', p_record_id
    ))
  ) -> 0);
  if loaded ->> 'outcome' <> 'loaded' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', loaded -> 'declaration',
      'recordId', p_record_id,
      'facts', loaded -> 'facts'
    )
  )) -> 0);
  if read_decision ->> 'outcome' is distinct from 'allowed' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_bounds := vortex_record.decide_record_field_bounds_internal(read_decision);
  if exists (
    select 1
    from (
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
      union
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    ) as supplied
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        read_bounds -> 'readableFieldIds'
      ) as readable(field_id)
      where pg_catalog.lower(readable.field_id) = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'field_refused',
      'correlationId', correlation_id_value
    );
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) or exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  candidate_values := (loaded -> 'fieldValues') || p_final_values;
  for field_item in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    field_id := pg_catalog.lower(field_item ->> 'fieldId');
    field_key := field_item ->> 'key';
    field_type := field_item ->> 'type';
    database_type := meta #>> array['columns', field_id, 'databaseValueType'];
    if database_type is null then
      raise exception using errcode = '55000',
        message = 'Organization settings field storage is unavailable';
    end if;

    if (field_item ->> 'required')::boolean
      and (not (candidate_values ? field_id)
        or pg_catalog.jsonb_typeof(candidate_values -> field_id) = 'null') then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'required_field_missing',
        'correlationId', correlation_id_value
      );
    end if;
    if not (p_final_values ? field_id) then
      continue;
    end if;

    field_value := p_final_values -> field_id;
    if field_key in ('organization_id', 'revision')
      or field_type in (
        'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
        'attachment', 'calculation'
      )
      or not vortex_record.canonical_record_value_matches(
        field_value, field_type, database_type
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_type = 'choice'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
        where option.value ->> 'value' = field_value #>> '{}'
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type = 'several_choices'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(field_value) as selected(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
          where option.value ->> 'value' = selected.value
        )
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type in ('text', 'long_text', 'choice', 'email_address', 'phone_number', 'web_address')
      and field_item #> '{settings,maxLength}' is not null
      and pg_catalog.jsonb_typeof(field_value) = 'string'
      and pg_catalog.char_length(field_value #>> '{}') >
        (field_item #>> '{settings,maxLength}')::integer then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_key in (
      'language', 'time_zone', 'currency', 'date_format', 'number_format',
      'default_application_root_id'
    ) then
      core_values := core_values || pg_catalog.jsonb_build_object(field_key, field_value);
    else
      extension_values := extension_values || pg_catalog.jsonb_build_object(field_key, field_value);
    end if;
  end loop;

  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(p_final_values) as key;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' = 'completed' then
      projection := (vortex_record.read_record(p_record_type_id, p_record_id)) -> 'record';
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', correlation_id_value
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'saved',
        'recordId', projection -> 'recordId',
        'concurrencyNumber', projection -> 'concurrencyNumber',
        'values', projection -> 'values',
        'correlationId', correlation_id_value,
        'backgroundDelivery', 'pending',
        'replayed', true
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'none' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'reasonCode', 'command_pending',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'reasonCode', 'record_revision_conflict',
      'concurrencyNumber', loaded -> 'concurrencyNumber',
      'correlationId', correlation_id_value
    );
  end if;

  access_result := vortex_access.change_organization_settings_record_internal(
    p_record_id, p_expected_concurrency_number, core_values, extension_values
  );
  if access_result ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return access_result || pg_catalog.jsonb_build_object(
      'reasonCode', coalesce(access_result ->> 'reasonCode', 'access_conflict'),
      'correlationId', correlation_id_value
    );
  end if;
  if access_result ->> 'outcome' <> 'saved' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(access_result ->> 'reasonCode', 'access_refused'),
      'correlationId', correlation_id_value
    );
  end if;

  perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[p_record_id]::uuid[], changed_field_ids, 'completed');
  event_result := vortex_platform.append_record_occurrences(
    (meta ->> 'storageContractId')::uuid,
    p_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', p_record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Organization settings Event append failed';
  end if;

  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, p_record_id,
    (access_result ->> 'concurrencyNumber')::bigint,
    'Organization settings record save receipt is stale'
  );
  projection := (vortex_record.read_record(p_record_type_id, p_record_id)) -> 'record';
  if projection ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '55000',
      message = 'Saved organisation settings projection is unavailable';
  end if;
  begin
    notice_sequence := pg_catalog.nextval(
      'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
    );
    perform vortex_platform.publish_change_notice(
      p_record_id, application_root_id_value, p_record_type_id,
      p_record_id, (access_result ->> 'concurrencyNumber')::bigint, 'changed',
      notice_sequence, notice_sequence, correlation_id_value
    );
  exception when others then
    -- Invalidation is advisory after the protected settings change completes,
    -- but its failure is logged with the cause so a stale view can be diagnosed.
    raise warning 'RECORD_INVALIDATION_FAILED settings record %: % %',
      p_record_id, sqlstate, sqlerrm;
  end;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', 'pending',
    'replayed', false
  );
exception
  when serialization_failure or deadlock_detected then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings record save conflicted: % (%)', failure_message, failure_sqlstate;
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'database_conflict_' || failure_sqlstate,
      'correlationId', correlation_id_value
    );
  when no_data_found or too_many_rows or insufficient_privilege or check_violation
    or object_not_in_prerequisite_state or invalid_text_representation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings record save refused: % (%)', failure_message, failure_sqlstate;
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'database_refused_' || failure_sqlstate,
      'correlationId', correlation_id_value
    );
end
$function$;
alter function vortex_record.apply_settings_record_changes_internal(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid) owner to vortex_record_adapter;


revoke all on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) is
  'Internal settings change reached only through apply_record_changes: rechecks the installed system projection, protected permission and revision, then writes once with one Activity, Event and change notice.';

alter function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) owner to vortex_record_adapter;

create or replace function vortex_record.authorize_created_records_for_command_internal(
  p_creations jsonb,
  p_created_records jsonb,
  p_original_context jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  safe_integer_max constant bigint := 9007199254740991;
  current_context jsonb;
  meta jsonb;
  meta_context jsonb;
  loaded jsonb;
  loaded_context jsonb;
  facts jsonb;
  record_fact jsonb;
  record_scope jsonb;
  decision jsonb;
  bounds jsonb;
  creation jsonb;
  created_value jsonb;
  saved_tuple jsonb;
  submitted_field text;
  returned_field text;
  submitted_id uuid;
  changeable_id text;
  ordinal_key text;
  ordinal_value integer;
  record_type_id_value uuid;
  record_id_value uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  account_id_value uuid;
  correlation_id_value uuid;
  module_root_id_value uuid;
  storage_contract_id_value uuid;
  module_release_revision_value bigint;
  definition_revision_value bigint;
  storage_scope_value text;
  actual_concurrency_number bigint;
  expected_record_scope jsonb;
  ordinals integer[] := array[]::integer[];
  seen_map_ordinals integer[] := array[]::integer[];
  seen_record_ids uuid[] := array[]::uuid[];
  result_tuples jsonb := '[]'::jsonb;
  matching_target_count integer;
  eligible_value boolean;
begin
  if pg_catalog.jsonb_typeof(p_creations) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_created_records) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_original_context) is distinct from 'object'
    or not (p_original_context ?& array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ])
    or p_original_context - array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ]::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023',
      message = 'Named action creation authority input is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_creations) = 0
    or (select pg_catalog.count(*)
        from pg_catalog.jsonb_object_keys(p_created_records)) <>
      pg_catalog.jsonb_array_length(p_creations) then
    raise exception using errcode = '22023',
      message = 'Named action creation authority input is invalid';
  end if;
  if pg_catalog.jsonb_typeof(p_original_context -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'applicationRootId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'organizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'correlationId') is distinct from 'string'
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'organizationId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'applicationRootId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'organizationAccountId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'correlationId', 'uuid'), true) then
    raise exception using errcode = '42501',
      message = 'Named action creation context is unavailable';
  end if;
  organization_id_value := (p_original_context ->> 'organizationId')::uuid;
  application_root_id_value := (p_original_context ->> 'applicationRootId')::uuid;
  account_id_value := (p_original_context ->> 'organizationAccountId')::uuid;
  correlation_id_value := (p_original_context ->> 'correlationId')::uuid;
  if organization_id_value = nil_uuid or application_root_id_value = nil_uuid
    or account_id_value = nil_uuid or correlation_id_value = nil_uuid then
    raise exception using errcode = '42501',
      message = 'Named action creation context is unavailable';
  end if;

  current_context := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(current_context) is distinct from 'object'
    or pg_catalog.jsonb_typeof(current_context -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'applicationRootId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'organizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'correlationId') is distinct from 'string'
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'organizationId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'applicationRootId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'organizationAccountId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'correlationId', 'uuid'), true)
    or (current_context ->> 'organizationId')::uuid is distinct from organization_id_value
    or (current_context ->> 'applicationRootId')::uuid is distinct from application_root_id_value
    or (current_context ->> 'organizationAccountId')::uuid is distinct from account_id_value
    or (current_context ->> 'correlationId')::uuid is distinct from correlation_id_value then
    raise exception using errcode = '42501',
      message = 'Named action creation context changed';
  end if;

  -- Validate and retain each canonical ordinal before using it as an object key.
  for creation in
    select item.value from pg_catalog.jsonb_array_elements(p_creations) item(value)
  loop
    if pg_catalog.jsonb_typeof(creation) is distinct from 'object'
      or not (creation ?& array['ordinal', 'recordTypeId', 'values', 'finalValues'])
      or creation - array['ordinal', 'recordTypeId', 'values', 'finalValues']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(creation -> 'ordinal') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(creation ->> 'ordinal', 'integer'), true)
      or pg_catalog.jsonb_typeof(creation -> 'recordTypeId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(creation ->> 'recordTypeId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(creation -> 'values') is distinct from 'object'
      or pg_catalog.jsonb_typeof(creation -> 'finalValues') is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Named action creation authority input is invalid';
    end if;
    ordinal_value := (creation ->> 'ordinal')::integer;
    record_type_id_value := (creation ->> 'recordTypeId')::uuid;
    if ordinal_value < 0 or record_type_id_value = nil_uuid
      or ordinal_value = any (ordinals) then
      raise exception using errcode = '22023',
        message = 'Named action creation ordinal is invalid';
    end if;
    ordinals := pg_catalog.array_append(ordinals, ordinal_value);
  end loop;

  -- A JSON object can contain text keys such as "01" and "1" that cast to the
  -- same integer. Admit only the exact decimal form of each declared ordinal.
  for ordinal_key in
    select item.key from pg_catalog.jsonb_object_keys(p_created_records) item(key)
  loop
    if coalesce(not pg_catalog.pg_input_is_valid(ordinal_key, 'integer'), true) then
      raise exception using errcode = '22023',
        message = 'Named action creation result key is invalid';
    end if;
    ordinal_value := ordinal_key::integer;
    if ordinal_value < 0 or ordinal_key is distinct from ordinal_value::text
      or not (ordinal_value = any (ordinals))
      or ordinal_value = any (seen_map_ordinals) then
      raise exception using errcode = '22023',
        message = 'Named action creation result key is invalid';
    end if;
    seen_map_ordinals := pg_catalog.array_append(seen_map_ordinals, ordinal_value);
  end loop;
  if pg_catalog.cardinality(seen_map_ordinals) <> pg_catalog.cardinality(ordinals) then
    raise exception using errcode = '22023',
      message = 'Named action creation result set is incomplete';
  end if;

  for creation in
    select item.value
    from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
    order by (item.value ->> 'ordinal')::integer
  loop
    ordinal_value := (creation ->> 'ordinal')::integer;
    record_type_id_value := (creation ->> 'recordTypeId')::uuid;
    created_value := p_created_records -> ordinal_value::text;
    if pg_catalog.jsonb_typeof(created_value) is distinct from 'object'
      or not (created_value ?& array['recordId', 'storageContractId', 'values', '_savedTuple'])
      or created_value - array['recordId', 'storageContractId', 'values', '_savedTuple']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(created_value -> 'recordId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(created_value ->> 'recordId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(created_value -> 'storageContractId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(created_value ->> 'storageContractId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(created_value -> 'values') is distinct from 'object'
      or pg_catalog.jsonb_typeof(created_value -> '_savedTuple') is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Named action creation result is invalid';
    end if;
    record_id_value := (created_value ->> 'recordId')::uuid;
    storage_contract_id_value := (created_value ->> 'storageContractId')::uuid;
    saved_tuple := created_value -> '_savedTuple';
    if record_id_value = nil_uuid or storage_contract_id_value = nil_uuid
      or pg_catalog.jsonb_typeof(saved_tuple) is distinct from 'object'
      or not (saved_tuple ?& array[
        'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
        'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
        'storageScope', 'actorId', 'correlationId', 'eligible'
      ])
      or saved_tuple - array[
        'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
        'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
        'storageScope', 'actorId', 'correlationId', 'eligible'
      ]::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(saved_tuple -> 'recordId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'recordId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'concurrencyNumber') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'concurrencyNumber', 'bigint'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'organizationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'organizationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'applicationRootId') not in ('string', 'null')
      or (pg_catalog.jsonb_typeof(saved_tuple -> 'applicationRootId') = 'string'
        and coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'applicationRootId', 'uuid'), true))
      or pg_catalog.jsonb_typeof(saved_tuple -> 'moduleRootId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'moduleRootId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'recordTypeId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'recordTypeId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'storageContractId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'storageContractId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'moduleReleaseRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'moduleReleaseRevision', 'bigint'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'storageScope') is distinct from 'string'
      or pg_catalog.jsonb_typeof(saved_tuple -> 'actorId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'actorId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'correlationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'correlationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'eligible') is distinct from 'boolean' then
      raise exception using errcode = '22023',
        message = 'Named action creation tuple is invalid';
    end if;

    if (saved_tuple ->> 'recordId')::uuid is distinct from record_id_value
      or (saved_tuple ->> 'recordTypeId')::uuid is distinct from record_type_id_value
      or (saved_tuple ->> 'storageContractId')::uuid is distinct from storage_contract_id_value
      or (saved_tuple ->> 'organizationId')::uuid is distinct from organization_id_value
      or (saved_tuple ->> 'actorId')::uuid is distinct from account_id_value
      or (saved_tuple ->> 'correlationId')::uuid is distinct from correlation_id_value
      or (saved_tuple ->> 'concurrencyNumber')::bigint not between 1 and safe_integer_max
      or (saved_tuple ->> 'moduleReleaseRevision')::bigint not between 1 and safe_integer_max
      or (saved_tuple ->> 'moduleRootId')::uuid = nil_uuid
      or (saved_tuple ->> 'storageScope') not in ('application_contained', 'organization_shared')
      or ((saved_tuple ->> 'storageScope') = 'application_contained'
        and (saved_tuple ->> 'applicationRootId')::uuid is distinct from application_root_id_value)
      or ((saved_tuple ->> 'storageScope') = 'organization_shared'
        and saved_tuple -> 'applicationRootId' is distinct from 'null'::jsonb)
      or (saved_tuple ->> 'eligible')::boolean is distinct from
        ((saved_tuple ->> 'storageScope') = 'application_contained') then
      raise exception using errcode = '42501',
        message = 'Named action creation tuple context changed';
    end if;
    if record_id_value = any (seen_record_ids) then
      raise exception using errcode = '22023',
        message = 'Named action creation identity is duplicated';
    end if;
    seen_record_ids := pg_catalog.array_append(seen_record_ids, record_id_value);

    meta := vortex_record.resolve_record_action_context_internal(record_type_id_value, 'create');
    if pg_catalog.jsonb_typeof(meta) is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'context') is distinct from 'object'
      or meta ? 'previewInstallationId'
      or pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'columns') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'moduleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'storageContractId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'moduleReleaseRevision') is distinct from 'number'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'organizationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'applicationRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'organizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'correlationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'recordType' -> 'recordTypeId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'recordType' -> 'storageScope') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'table') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'declaration' -> 'recordBinding') is distinct from 'object'
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'organizationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'applicationRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'organizationAccountId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'correlationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'recordType' ->> 'recordTypeId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'moduleRootId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'recordTypeId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'storageContractId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'moduleRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'storageContractId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'moduleReleaseRevision', 'bigint'), true)
      or meta ->> 'storageScope' is distinct from saved_tuple ->> 'storageScope'
      or (meta ->> 'moduleRootId')::uuid is distinct from (saved_tuple ->> 'moduleRootId')::uuid
      or (meta ->> 'storageContractId')::uuid is distinct from storage_contract_id_value
      or (meta ->> 'moduleReleaseRevision')::bigint is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint
      or (meta -> 'context' ->> 'organizationId')::uuid is distinct from organization_id_value
      or (meta -> 'context' ->> 'applicationRootId')::uuid is distinct from application_root_id_value
      or (meta -> 'context' ->> 'organizationAccountId')::uuid is distinct from account_id_value
      or (meta -> 'context' ->> 'correlationId')::uuid is distinct from correlation_id_value
      or (meta -> 'recordType' ->> 'recordTypeId')::uuid is distinct from record_type_id_value
      or (meta -> 'recordType' ->> 'storageScope') is distinct from saved_tuple ->> 'storageScope'
      or (meta -> 'declaration' -> 'recordBinding' ->> 'moduleRootId')::uuid is distinct from
        (saved_tuple ->> 'moduleRootId')::uuid
      or (meta -> 'declaration' -> 'recordBinding' ->> 'recordTypeId')::uuid is distinct from
        record_type_id_value
      or (meta -> 'declaration' -> 'recordBinding' ->> 'storageContractId')::uuid is distinct from
        storage_contract_id_value
      or meta -> 'declaration' -> 'recordBinding' ->> 'storageScope' is distinct from
        saved_tuple ->> 'storageScope' then
      raise exception using errcode = '42501',
        message = 'Named action creation installation is unavailable';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_each(creation -> 'finalValues') expected(key, value)
      where not (created_value -> 'values' ? expected.key)
        or (created_value -> 'values' -> expected.key) is distinct from expected.value
    ) then
      raise exception using errcode = '55000',
        message = 'Named action creation values changed';
    end if;
    for returned_field in
      select key from pg_catalog.jsonb_object_keys(created_value -> 'values') as field(key)
    loop
      if coalesce(not pg_catalog.pg_input_is_valid(returned_field, 'uuid'), true)
        or not (meta -> 'columns' ? pg_catalog.lower(returned_field)) then
        raise exception using errcode = '55000',
          message = 'Named action creation values are unavailable';
      end if;
      if not (creation -> 'finalValues' ? returned_field)
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') field(value)
          where pg_catalog.lower(field.value ->> 'fieldId') =
              pg_catalog.lower(returned_field)
            and field.value ->> 'type' = 'reference_number'
        ) then
        raise exception using errcode = '55000',
          message = 'Named action creation generated value is unavailable';
      end if;
    end loop;

    loaded := (vortex_record.load_record_access_facts_internal(
      'create', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', record_type_id_value,
        'recordId', record_id_value
      ))
    ) -> 0);
    if pg_catalog.jsonb_typeof(loaded) is distinct from 'object'
      or loaded ->> 'outcome' is distinct from 'loaded'
      or loaded ? 'previewInstallationId'
      or pg_catalog.jsonb_typeof(loaded -> 'context') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'organizationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'applicationRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'organizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'correlationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'organizationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'applicationRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'organizationAccountId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'correlationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration' -> 'recordBinding') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'facts') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'records') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'recordTypes') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'relationships') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'sharingConditions') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'edges') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'binding') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'columns') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'table') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'concurrencyNumber') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'concurrencyNumber', 'bigint'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'definitionRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'definitionRevision', 'bigint'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'moduleReleaseRevision') is distinct from 'number'
      or pg_catalog.jsonb_typeof(loaded -> 'moduleReleaseRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'moduleReleaseRevision', 'bigint'), true)
      or (loaded -> 'context' ->> 'organizationId')::uuid is distinct from organization_id_value
      or (loaded -> 'context' ->> 'applicationRootId')::uuid is distinct from application_root_id_value
      or (loaded -> 'context' ->> 'organizationAccountId')::uuid is distinct from account_id_value
      or (loaded -> 'context' ->> 'correlationId')::uuid is distinct from correlation_id_value
      or loaded -> 'facts' -> 'binding' is distinct from
        meta -> 'declaration' -> 'recordBinding'
      or loaded -> 'declaration' -> 'recordBinding' is distinct from
        meta -> 'declaration' -> 'recordBinding'
      or loaded ->> 'table' is distinct from meta ->> 'table'
      or (loaded ->> 'moduleReleaseRevision')::bigint is distinct from
        (meta ->> 'moduleReleaseRevision')::bigint
      or (loaded ->> 'moduleReleaseRevision')::bigint is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint then
      raise exception using errcode = '42501',
        message = 'Named action creation facts are unavailable';
    end if;
    if exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'relationships') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'sharingConditions') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'edges') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) then
      raise exception using errcode = '55000',
        message = 'Named action creation graph facts are malformed';
    end if;
    actual_concurrency_number := (loaded ->> 'concurrencyNumber')::bigint;
    definition_revision_value := (loaded ->> 'definitionRevision')::bigint;
    if actual_concurrency_number not between 1 and safe_integer_max then
      raise exception using errcode = '55000',
        message = 'Named action creation revision is unavailable';
    end if;
    if definition_revision_value not between 1 and safe_integer_max
      or definition_revision_value is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint then
      raise exception using errcode = '42501',
        message = 'Named action creation definition changed';
    end if;

    matching_target_count := 0;
    record_fact := null;
    for record_fact in
      select item.value from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') item(value)
    loop
      if pg_catalog.jsonb_typeof(record_fact) is distinct from 'object'
        or pg_catalog.jsonb_typeof(record_fact -> 'recordScope') is distinct from 'object'
        or pg_catalog.jsonb_typeof(record_fact -> 'fieldValues') is distinct from 'object' then
        raise exception using errcode = '55000',
          message = 'Named action creation target facts are malformed';
      end if;
      if pg_catalog.jsonb_typeof(record_fact -> 'recordScope' -> 'recordId') = 'string'
        and coalesce(pg_catalog.pg_input_is_valid(
          record_fact -> 'recordScope' ->> 'recordId', 'uuid'
        ), false)
        and (record_fact -> 'recordScope' ->> 'recordId')::uuid = record_id_value then
        matching_target_count := matching_target_count + 1;
      end if;
    end loop;
    if matching_target_count <> 1 then
      raise exception using errcode = '42501',
        message = 'Named action creation target is unavailable';
    end if;

    -- Re-read the one exact saved target from the returned fact set and compare
    -- its complete loader-produced scope; related graph facts never substitute.
    select item.value into strict record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') item(value)
    where item.value -> 'recordScope' ->> 'recordId' = record_id_value::text;
    record_scope := record_fact -> 'recordScope';
    expected_record_scope := pg_catalog.jsonb_build_object(
      'storageScope', saved_tuple ->> 'storageScope',
      'organizationId', organization_id_value,
      'moduleRootId', (saved_tuple ->> 'moduleRootId')::uuid,
      'recordTypeId', record_type_id_value,
      'storageContractId', storage_contract_id_value,
      'recordId', record_id_value
    ) || case when saved_tuple ->> 'storageScope' = 'application_contained'
      then pg_catalog.jsonb_build_object('applicationRootId', application_root_id_value)
      else '{}'::jsonb end;
    if record_scope is distinct from expected_record_scope
      or pg_catalog.jsonb_typeof(record_fact -> 'fieldValues') is distinct from 'object'
      or record_fact ->> 'lifecycleState' is distinct from 'active' then
      raise exception using errcode = '42501',
        message = 'Named action creation target scope changed';
    end if;

    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding'
    );
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', meta -> 'declaration',
        'recordId', record_id_value,
        'facts', facts
      )
    )) -> 0);
    if pg_catalog.jsonb_typeof(decision) is distinct from 'object'
      or decision ->> 'outcome' is distinct from 'allowed' then
      raise exception using errcode = '42501',
        message = 'Named action creation authority is unavailable';
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
    if pg_catalog.jsonb_typeof(bounds) is distinct from 'object'
      or pg_catalog.jsonb_typeof(bounds -> 'readableFieldIds') is distinct from 'array'
      or pg_catalog.jsonb_typeof(bounds -> 'changeableFieldIds') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
          or coalesce(not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid'), true)
      )
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
          or coalesce(not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid'), true)
          or not (bounds -> 'readableFieldIds' ? (item.value #>> '{}'))
      ) then
      raise exception using errcode = '55000',
        message = 'Named action creation field bounds are unavailable';
    end if;
    for submitted_field in
      select key from pg_catalog.jsonb_object_keys(creation -> 'values') as field(key)
    loop
      if coalesce(not pg_catalog.pg_input_is_valid(submitted_field, 'uuid'), true) then
        raise exception using errcode = '22023',
          message = 'Named action creation field is invalid';
      end if;
      submitted_id := submitted_field::uuid;
      changeable_id := pg_catalog.lower(submitted_id::text);
      if not (meta -> 'columns' ? changeable_id)
        or not exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(bounds -> 'changeableFieldIds') item(value)
          where pg_catalog.lower(item.value) = changeable_id
        ) then
        raise exception using errcode = '42501',
          message = 'Named action creation field is not changeable';
      end if;
    end loop;

    eligible_value := (saved_tuple ->> 'eligible')::boolean;
    result_tuples := result_tuples || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', ordinal_value,
        'recordId', record_id_value,
        'concurrencyNumber', actual_concurrency_number,
        'organizationId', organization_id_value,
        'applicationRootId', saved_tuple -> 'applicationRootId',
        'moduleRootId', (saved_tuple ->> 'moduleRootId')::uuid,
        'recordTypeId', record_type_id_value,
        'storageContractId', storage_contract_id_value,
        'moduleReleaseRevision', (loaded ->> 'moduleReleaseRevision')::bigint,
        'storageScope', saved_tuple ->> 'storageScope',
        'correlationId', correlation_id_value,
        'eligible', eligible_value
      )
    );
  end loop;

  if pg_catalog.jsonb_array_length(result_tuples) <> pg_catalog.cardinality(ordinals)
    or pg_catalog.cardinality(seen_record_ids) <> pg_catalog.cardinality(ordinals) then
    raise exception using errcode = '55000',
      message = 'Named action creation authority result is incomplete';
  end if;
  return result_tuples;
end
$function$;
alter function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb) owner to vortex_record_adapter;


alter function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb) is
  'Private named-action whole-graph ordinary CREATE authorization barrier over the complete inserted set; revalidates the original HUMAN context, installed scope, actual loader target and revision, current Access decision and submitted field bounds, returning ordered final saved tuples for the terminal receipt and created-notice seam.';

create or replace function vortex_record.change_record(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  meta jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  assignments text[] := array[]::text[];
  update_sql text;
  changed_rows integer;
  new_concurrency_number bigint;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := (vortex_record.load_record_access_facts_internal(
    'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id,
      'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number
    ))
  ) -> 0);
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or (not (loaded ? 'previewInstallationId')
      and pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  if loaded ? 'previewInstallationId' then
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if bounds is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
  else
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', loaded -> 'declaration',
        'recordId', p_record_id,
        'facts', loaded -> 'facts'
      )
    )) -> 0);
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
  end if;
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;
    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    assignments := pg_catalog.array_append(
      assignments,
      pg_catalog.format(
        '%I = %s',
        column_entry ->> 'token',
        case
          when pg_catalog.jsonb_typeof(entry_value) = 'null' then 'null'
          else case storage_type
            when 'decimal' then pg_catalog.format('%L::numeric', entry_value #>> '{}')
            when 'timestamp_with_time_zone' then
              pg_catalog.format('%L::timestamptz', entry_value #>> '{}')
            when 'date' then pg_catalog.format('%L::date', entry_value #>> '{}')
            when 'integer' then pg_catalog.format('%L::bigint', entry_value #>> '{}')
            when 'boolean' then pg_catalog.format('%L::boolean', entry_value #>> '{}')
            when 'json' then pg_catalog.format('%L::jsonb', entry_value::text)
            else pg_catalog.format('%L::text', entry_value #>> '{}')
          end
        end
      )
    );
  end loop;

  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  if not (loaded ? 'previewInstallationId') then
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', loaded -> 'declaration',
        'recordId', p_record_id,
        'facts', proposed_facts
      )
    )) -> 0);
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
      );
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
  end if;

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %s%sconcurrency_number = stored.concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $4
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $5
     returning stored.concurrency_number',
    loaded ->> 'table',
    pg_catalog.array_to_string(assignments, ','),
    case when pg_catalog.cardinality(assignments) = 0 then '' else ', ' end
  );

  execute update_sql
  into new_concurrency_number
  using (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (loaded ->> 'moduleReleaseRevision')::bigint,
    p_expected_concurrency_number;

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001',
      message = 'Record change did not apply to exactly one row';
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', new_concurrency_number,
    'values', values_value
  );
end
$function$;
alter function vortex_record.change_record(uuid,uuid,bigint,jsonb,uuid[]) owner to vortex_record_adapter;


alter function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[])
  owner to vortex_record_adapter;

revoke all on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[]) is
  'Fixed owner-only record update primitive. It checks one live record decision or the exact owner preview address, validates values and field bounds before writing, enforces concurrency, and returns only its permitted field projection.';

create or replace function vortex_record.change_record_by_named_action_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  assignments text[] := array[]::text[];
  update_sql text;
  changed_rows integer;
  saved_record_id uuid;
  new_concurrency_number bigint;
  notice_sequence bigint;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  -- The next number must still fit the column's own range, so the highest
  -- accepted expected number is one below its maximum.
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  -- The old row's own update decision, and the changeable set it carries.
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', loaded -> 'declaration',
      'recordId', p_record_id,
      'facts', loaded -> 'facts'
    )
  )) -> 0);
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  -- Every submitted field must be a field of the exact installed definition and
  -- inside that changeable set. The first one outside it refuses the whole
  -- change, before any value is cast and before any statement writes.
  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  -- Every final value must name a field of that same definition: an unknown
  -- identifier and a system column are the same refusal, because neither is a
  -- field of this record type.
  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';

    -- Link fields carry relationship edges, and edge writes are S2's. Refusing
    -- with a fixed code keeps a link change from being silently dropped.
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;

    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    assignments := pg_catalog.array_append(
      assignments,
      pg_catalog.format(
        '%I = %s',
        column_entry ->> 'token',
        case
          when pg_catalog.jsonb_typeof(entry_value) = 'null' then 'null'
          else case storage_type
            when 'decimal' then pg_catalog.format('%L::numeric', entry_value #>> '{}')
            when 'timestamp_with_time_zone' then
              pg_catalog.format('%L::timestamptz', entry_value #>> '{}')
            when 'date' then pg_catalog.format('%L::date', entry_value #>> '{}')
            when 'integer' then pg_catalog.format('%L::bigint', entry_value #>> '{}')
            when 'boolean' then pg_catalog.format('%L::boolean', entry_value #>> '{}')
            when 'json' then pg_catalog.format('%L::jsonb', entry_value::text)
            else pg_catalog.format('%L::text', entry_value #>> '{}')
          end
        end
      )
    );
  end loop;

  -- The proposed row's own update decision. Values that move the record out of
  -- every route the caller holds are refused here, after the old row admitted
  -- them and before anything is written.
  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', loaded -> 'declaration',
      'recordId', p_record_id,
      'facts', proposed_facts
    )
  )) -> 0);
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);

  -- The write: the typed columns, the next concurrency number, and the change
  -- stamp from the verified context and the installed binding. Owner columns
  -- and lifecycle state are not writable here.
  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %s%sconcurrency_number = stored.concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $4
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $5
     returning stored.record_id, stored.concurrency_number',
    loaded ->> 'table',
    pg_catalog.array_to_string(assignments, ', '),
    case when pg_catalog.cardinality(assignments) = 0 then '' else ', ' end
  );

  execute update_sql
  into saved_record_id, new_concurrency_number
  using (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (loaded ->> 'moduleReleaseRevision')::bigint,
    p_expected_concurrency_number;

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001',
      message = 'Record change did not apply to exactly one row';
  end if;

  if loaded #>> '{actionContext,storageScope}' = 'application_contained' then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid,
        p_record_type_id, saved_record_id, new_concurrency_number, 'changed',
        notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
      );
    exception
      when others then
        -- Invalidation is advisory; a lost notice must not refuse the scalar write.
        null;
    end;
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', saved_record_id,
    'concurrencyNumber', new_concurrency_number,
    'values', values_value
  );
end
$function$;

alter function vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) to vortex_record_adapter;
comment on function vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) is null;

create or replace function vortex_record.change_record_relationship_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_relationship_id uuid,
  p_target_value jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  meta jsonb;
  decision jsonb;
  bounds jsonb;
  field_id_value uuid;
  relationship_value jsonb;
  new_concurrency bigint;
  saved_record_id uuid;
  exact_copy_notice boolean := false;
  preview_installation jsonb;
  refusal_reason text := 'relationship_change_refused';
begin
  if p_record_type_id is null or p_record_id is null or p_relationship_id is null
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_value is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'update');
    loaded := (vortex_record.load_record_access_facts_internal(
      'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id,
        'expectedConcurrencyNumber', p_expected_concurrency_number
      ))
    ) -> 0);
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', meta -> 'declaration',
        'recordId', p_record_id,
        'facts', (loaded -> 'facts') || pg_catalog.jsonb_build_object( 'binding', meta -> 'declaration' -> 'recordBinding' )
      )
    )) -> 0);
    if decision ->> 'outcome' <> 'allowed' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    select item.value into relationship_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
    where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
    if not found then
      refusal_reason := 'relationship_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements_text(
        bounds -> 'changeableFieldIds'
      ) as allowed(value)
      where pg_catalog.lower(allowed.value) = pg_catalog.lower(field_id_value::text)
    ) then
      refusal_reason := 'field_not_changeable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    preview_installation :=
      vortex_record.read_current_preview_installation_internal();
    exact_copy_notice := preview_installation is null
      and meta ->> 'storageScope' = 'application_contained';
    if exact_copy_notice then
      perform vortex_record.write_relationship_value_internal(
        p_record_type_id, p_record_id, p_relationship_id, p_target_value, false
      );
      execute pg_catalog.format(
        'update record_data.%I as stored
         set concurrency_number = stored.concurrency_number + 1,
           updated_at = pg_catalog.statement_timestamp(), updated_by = $6
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.record_type_id = $3 and stored.application_root_id = $4
           and stored.lifecycle_state = ''active''
           and stored.concurrency_number = $5
         returning stored.record_id, stored.concurrency_number', meta ->> 'table'
      ) into strict saved_record_id, new_concurrency using
        (meta -> 'context' ->> 'organizationId')::uuid, p_record_id,
        p_record_type_id, (meta -> 'context' ->> 'applicationRootId')::uuid,
        p_expected_concurrency_number,
        (meta -> 'context' ->> 'organizationAccountId')::uuid;
      if saved_record_id is distinct from p_record_id
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or new_concurrency is null
        or new_concurrency not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Relationship copy saved identity is unavailable';
      end if;
    else
      perform vortex_record.write_relationship_value_internal(
        p_record_type_id, p_record_id, p_relationship_id, p_target_value, true
      );
      execute pg_catalog.format(
        'select concurrency_number from record_data.%I
         where organisation_id = $1 and record_id = $2', meta ->> 'table'
      ) into new_concurrency using
        (meta -> 'context' ->> 'organizationId')::uuid, p_record_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', case when exact_copy_notice
        then saved_record_id else p_record_id end,
      'concurrencyNumber', new_concurrency
    );
  exception
    when sqlstate 'P4020' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', refusal_reason);
    when serialization_failure or deadlock_detected then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    when no_data_found or check_violation or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
      );
  end;
end
$function$;
alter function vortex_record.change_record_relationship_internal(uuid,uuid,bigint,uuid,jsonb) owner to vortex_record_adapter;


alter function vortex_record.change_record_relationship_internal(uuid,uuid,bigint,uuid,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.change_record_relationship_internal(uuid, uuid, bigint, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.change_record_relationship_internal(uuid, uuid, bigint, uuid, jsonb) is
  'Private revision-checked relationship primitive: decides source update and target eligibility, changes the edge atomically, and returns the actual saved identity, revision for the live application-contained copy owner to publish.';

create or replace function vortex_record.copy_live_records_to_preview_internal(
  p_preview_installation_id uuid,
  p_record_type_id uuid,
  p_live_storage_contract_id uuid,
  p_preview_storage_contract_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  -- The deliberate preview bound: a preview holds at most this many records of one record type,
  -- the first the builder can read in record order. The seed says when the bound was reached, and
  -- the preview tells the builder so.
  copy_limit constant integer := 2000;
  -- A table the builder can mostly not read is scanned only this far. That is a silent
  -- performance bound: it says nothing about how many live records exist.
  scan_limit constant integer := 20000;
  counter_mapping record;
  copied_maximum numeric;
  scanned_count integer := 0;
  bounded boolean := false;
  live_table_token text;
  source_module_root_id uuid;
  checked_context jsonb;
  live_type jsonb;
  preview_table_token text;
  record_columns text[];
  field_columns text[];
  copied_columns text;
  copied_count bigint := 0;
  row_read record;
  -- Page decisions take at most 201 candidates; a batch is the round number below that.
  batch_size constant integer := 200;
  after_id uuid;
  batch_ids uuid[];
  candidate_id uuid;
  page_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_envelope jsonb;
  page_narrowed boolean;
  decided_ids uuid[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  readable_bounds jsonb;
  readable_field_ids jsonb;
  readable_ids uuid[];
  readable_columns_by_record text[];
  column_sets jsonb := '{}'::jsonb;
  bounds_key text;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_live_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_preview_storage_contract_id::text) then
    raise exception using errcode = '22023', message = 'Preview record copy selector is invalid';
  end if;
  -- The copy reads as the builder reads the installed Application: never in a preview.
  if nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '')
    is not null then
    raise exception using errcode = '42501', message = 'Preview record copy must read live records';
  end if;
  select catalogue.physical_table_token, catalogue.module_root_id
  into strict live_table_token, source_module_root_id
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_live_storage_contract_id
    and catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  checked_context := vortex_access.validated_human_request_context();
  live_type := vortex_record.resolve_preview_seed_source_internal(
    (checked_context ->> 'organizationId')::uuid,
    (checked_context ->> 'applicationRootId')::uuid,
    source_module_root_id, p_record_type_id, p_live_storage_contract_id
  );
  if live_type is null or live_type ->> 'table' is distinct from live_table_token then
    raise exception using errcode = '42501', message = 'Preview seed source is not installed';
  end if;
  -- The caller passes the preview's own storage identities; both tables hold this record type.
  select catalogue.physical_table_token into strict preview_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_preview_storage_contract_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active'
    and catalogue.record_type_id = p_record_type_id;

  -- The columns both tables declare with the same type, except the storage identity each table
  -- fixes for itself: the record columns, and each field the live release and the draft share.
  select
    coalesce(pg_catalog.array_agg(preview_column.attname::text order by preview_column.attnum)
      filter (where preview_column.attname !~ '^f_[0-9a-f]{32}$'), array[]::text[]),
    coalesce(pg_catalog.array_agg(preview_column.attname::text order by preview_column.attnum)
      filter (where preview_column.attname ~ '^f_[0-9a-f]{32}$'), array[]::text[])
  into record_columns, field_columns
  from pg_catalog.pg_attribute as preview_column
  join pg_catalog.pg_class as preview_table on preview_table.oid = preview_column.attrelid
  join pg_catalog.pg_namespace as preview_schema
    on preview_schema.oid = preview_table.relnamespace
  where preview_schema.nspname = 'record_data'
    and preview_table.relname = preview_table_token
    and preview_column.attnum > 0
    and not preview_column.attisdropped
    and preview_column.attname <> 'storage_contract_id'
    and exists (
      select 1
      from pg_catalog.pg_attribute as live_column
      join pg_catalog.pg_class as live_table on live_table.oid = live_column.attrelid
      join pg_catalog.pg_namespace as live_schema on live_schema.oid = live_table.relnamespace
      where live_schema.nspname = 'record_data'
        and live_table.relname = live_table_token
        and live_column.attname = preview_column.attname
        and live_column.attnum > 0
        and not live_column.attisdropped
        and live_column.atttypid = preview_column.atttypid
    );
  if pg_catalog.cardinality(record_columns) = 0
    or not ('record_id' = any(record_columns)) then
    raise exception using errcode = '55000', message = 'Preview record copy has no columns';
  end if;

  -- Only the records the builder reads in the installed Application, each with only the fields
  -- the builder reads there; every other field of a copied record is left empty. Row security
  -- limits the live table to the request's organisation and Application. The bound counts only
  -- readable records, in record order, so the builder gets the first records they can see.
  -- Candidates are scanned in record order in keyset batches. Each batch is decided together by
  -- the page read pass, with the page facts, eligibility and envelope built inside this
  -- invocation from the request's own context, and the readable records of a batch are copied by
  -- one statement per distinct set of readable fields.
  loop
    execute pg_catalog.format(
      'select coalesce(pg_catalog.array_agg(candidate.record_id order by candidate.record_id), array[]::uuid[]) from (select record_id from record_data.%I where $1::uuid is null or record_id > $1 order by record_id limit $2) as candidate',
      live_table_token
    ) into batch_ids using after_id, least(batch_size, scan_limit - scanned_count);
    exit when pg_catalog.cardinality(batch_ids) = 0;
    after_id := batch_ids[pg_catalog.cardinality(batch_ids)];
    scanned_count := scanned_count + pg_catalog.cardinality(batch_ids);

    -- The page facts come from the batch's first record, loaded by the exact loader. A record
    -- type the page pass cannot decide (a protected projection, or readable through another
    -- record) leaves its records to the exact single-record decision.
    decided_ids := array[]::uuid[];
    decided_decisions := array[]::jsonb[];
    decided_bounds := array[]::jsonb[];
    page_eligibility := null;
    page_loaded := (vortex_record.load_record_access_facts_from_installation_internal(
      'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', batch_ids[1]
      )),
      vortex_definition.read_current_active_installation()
    ) -> 0);
    if page_loaded ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(page_loaded -> 'declaration') = 'object' then
      page_declaration := page_loaded -> 'declaration';
      -- The row decisions and the raw values must refer to the same authoritative storage,
      -- including if the installed pin set changed since the source was resolved.
      if (page_loaded #>> '{facts,binding,storageContractId}')::uuid
          is distinct from p_live_storage_contract_id
        or page_loaded #>> '{recordTypeMeta,table}' is distinct from live_table_token then
        raise exception using errcode = '42501', message = 'Preview seed authorization storage changed';
      end if;
      page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
        page_declaration, checked_context, pg_catalog.clock_timestamp()
      );
      select page.envelope, page.narrowed into page_envelope, page_narrowed
      from vortex_record.read_record_page_envelope_internal(p_record_type_id, page_loaded) as page;
      select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
        coalesce(pg_catalog.array_agg(decided.decision), array[]::jsonb[]),
        coalesce(pg_catalog.array_agg(decided.bounds), array[]::jsonb[])
      into decided_ids, decided_decisions, decided_bounds
      from vortex_record.read_record_page_decisions_internal(
        p_record_type_id, page_loaded, page_declaration, page_eligibility,
        batch_ids, page_envelope, page_narrowed
      ) as decided;
    end if;

    readable_ids := array[]::uuid[];
    readable_columns_by_record := array[]::text[];
    foreach candidate_id in array batch_ids loop
      decided_index := pg_catalog.array_position(decided_ids, candidate_id);
      if decided_index is not null
        and decided_decisions[decided_index] ->> 'outcome' is distinct from 'allowed' then
        continue;
      end if;
      if decided_index is not null
        and (decided_decisions[decided_index] ->> 'validUntil')::timestamptz
          > pg_catalog.clock_timestamp()
        and page_eligibility ->> 'outcome' = 'eligible'
        and (page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp() then
        readable_bounds := decided_bounds[decided_index];
      else
        -- A record the page pass did not decide, or decided only for a moment that has passed,
        -- keeps the exact single-record decision.
        select projected.projection, projected.read_bounds, projected.read_facts into row_read
        from vortex_record.read_record_projection_internal(p_record_type_id, candidate_id) as projected;
        continue when row_read.projection ->> 'outcome' is distinct from 'allowed';
        if (row_read.read_facts #>> '{facts,binding,storageContractId}')::uuid
          is distinct from p_live_storage_contract_id then
          raise exception using errcode = '42501', message = 'Preview seed authorization storage changed';
        end if;
        readable_bounds := row_read.read_bounds;
      end if;
      if copied_count + pg_catalog.cardinality(readable_ids) = copy_limit then
        bounded := true;
        exit;
      end if;
      readable_field_ids := coalesce(readable_bounds -> 'readableFieldIds', '[]'::jsonb);
      bounds_key := readable_field_ids::text;
      if not column_sets ? bounds_key then
        select pg_catalog.string_agg(pg_catalog.quote_ident(copied.value), ', ')
        into copied_columns
        from pg_catalog.unnest(record_columns || coalesce((
          select pg_catalog.array_agg(field_column.value order by field_column.value)
          from pg_catalog.unnest(field_columns) as field_column(value)
          where field_column.value in (
            select 'f_' || pg_catalog.replace(pg_catalog.lower(readable.value #>> '{}'), '-', '')
            from pg_catalog.jsonb_array_elements(readable_field_ids) as readable(value)
          )
        ), array[]::text[])) as copied(value);
        column_sets := column_sets || pg_catalog.jsonb_build_object(bounds_key, copied_columns);
      end if;
      readable_ids := readable_ids || candidate_id;
      readable_columns_by_record := readable_columns_by_record || (column_sets ->> bounds_key);
    end loop;

    for copied_columns in
      select distinct set_columns.value
      from pg_catalog.unnest(readable_columns_by_record) as set_columns(value)
    loop
      execute pg_catalog.format(
        'insert into record_data.%I (storage_contract_id, %s) select %L::uuid, %s from record_data.%I where record_id = any ($1)',
        preview_table_token, copied_columns, p_preview_storage_contract_id, copied_columns,
        live_table_token
      ) using (
        select pg_catalog.array_agg(member.record_id)
        from rows from (pg_catalog.unnest(readable_ids), pg_catalog.unnest(readable_columns_by_record))
          as member(record_id, columns)
        where member.columns = copied_columns
      );
    end loop;
    copied_count := copied_count + pg_catalog.cardinality(readable_ids);
    exit when bounded or scanned_count >= scan_limit;
  end loop;

  -- Each reference-number counter continues after the highest number among the copied records,
  -- never from the live counter, which would reveal how many live records exist.
  for counter_mapping in
    select mapping.field_id, mapping.physical_column_token
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = p_preview_storage_contract_id
      and mapping.state = 'active'
      and mapping.field_definition ->> 'type' = 'reference_number'
      and mapping.physical_column_token = any(field_columns)
    order by mapping.field_id
  loop
    execute pg_catalog.format(
      'select pg_catalog.max(pg_catalog.substring(%I, ''([0-9]+)[^0-9]*$'')::numeric) from record_data.%I where storage_contract_id = %L::uuid',
      counter_mapping.physical_column_token, preview_table_token, p_preview_storage_contract_id
    ) into copied_maximum;
    if copied_maximum is not null then
      insert into vortex_record.preview_reference_counters (
        preview_installation_id, storage_contract_id, field_id, next_number
      ) values (
        p_preview_installation_id, p_preview_storage_contract_id, counter_mapping.field_id,
        copied_maximum + 1
      );
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('copied', copied_count, 'bounded', bounded);
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview record copy storage is unavailable';
end
$function$;

alter function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  to vortex_owner;
comment on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid) is
  'Seeds one preview record table with the live records of the same record type that the request''s builder reads in the installed Application, each with only the fields they read there, and reference counters that continue after the copied records: the first 2,000 they read, in record order, and whether they read more.';

create or replace function vortex_record.create_record_internal(
  p_record_type_id uuid,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_selected_group_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  context_value jsonb;
  record_type_value jsonb;
  record_id_value uuid := pg_catalog.gen_random_uuid();
  ownership_mode text;
  owner_account_id uuid;
  owner_group_id uuid;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := coalesce(p_final_values, '{}'::jsonb);
  column_names text[] := array[]::text[];
  column_values text[] := array[]::text[];
  insert_sql text;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  bounds jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  changeable text[];
  submitted_id uuid;
  relationship_value jsonb;
  app_scope uuid;
  refusal_reason text := 'record_create_refused';
  exact_create_notice boolean := false;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  notice_sequence bigint;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null
    or pg_catalog.cardinality(p_submitted_field_ids) <>
      (select pg_catalog.count(distinct value) from pg_catalog.unnest(p_submitted_field_ids) as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
    preview_installation :=
      vortex_record.read_current_preview_installation_internal();
    if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object')
      or (preview_installation is not null
        and (preview_installation ->> 'outcome' = 'refused'
          or meta -> 'recordType' ? 'systemProjection')) then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    context_value := meta -> 'context';
    record_type_value := meta -> 'recordType';
    ownership_mode := record_type_value ->> 'ownershipMode';
    app_scope := case when meta ->> 'storageScope' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end;
    exact_create_notice := preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and case when pg_catalog.jsonb_typeof(record_type_value -> 'relationships') = 'array'
        then true
        else false end;

    if ownership_mode = 'organization_account' then
      if p_selected_group_id is not null then
        refusal_reason := 'owner_invalid';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_account_id := (context_value ->> 'organizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      if not vortex_access.lock_current_record_owner_group_internal(p_selected_group_id) then
        refusal_reason := 'owner_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_group_id := p_selected_group_id;
    elsif p_selected_group_id is not null then
      refusal_reason := 'owner_invalid';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    -- Every supplied value names one exact field.  Reference numbers are
    -- generated here and cannot be supplied by a form or caller.
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(final_values) as supplied(key)
      where not (meta -> 'columns' ? pg_catalog.lower(supplied.key))
    ) then
      refusal_reason := 'unknown_field';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      field_id_value := (field_item ->> 'fieldId')::uuid;
      column_value := meta -> 'columns' -> pg_catalog.lower(field_id_value::text);
      if field_item ->> 'type' = 'reference_number' then
        if final_values ? pg_catalog.lower(field_id_value::text)
          or field_id_value = any (p_submitted_field_ids) then
          refusal_reason := 'generated_field_not_submittable';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        input_value := pg_catalog.to_jsonb(case when preview_installation is null
          then vortex_record.allocate_reference_number_internal(
            (context_value ->> 'organizationId')::uuid,
            (meta ->> 'storageContractId')::uuid,
            field_id_value, app_scope, field_item -> 'settings'
          )
          else vortex_record.allocate_preview_reference_number_internal(
            (preview_installation ->> 'previewInstallationId')::uuid,
            (meta ->> 'storageContractId')::uuid,
            field_id_value, field_item -> 'settings'
          ) end);
        final_values := final_values || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_id_value::text), input_value
        );
      elsif final_values ? pg_catalog.lower(field_id_value::text) then
        input_value := final_values -> pg_catalog.lower(field_id_value::text);
        if (field_item ->> 'required')::boolean
          and pg_catalog.jsonb_typeof(input_value) = 'null' then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        if not vortex_record.canonical_record_value_matches(
          input_value, field_item ->> 'type', column_value ->> 'databaseValueType'
        ) then
          refusal_reason := 'value_invalid';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
      else
        if (field_item ->> 'required')::boolean then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        continue;
      end if;

      column_names := pg_catalog.array_append(
        column_names, pg_catalog.format('%I', column_value ->> 'token')
      );
      column_values := pg_catalog.array_append(column_values,
        case when pg_catalog.jsonb_typeof(input_value) = 'null' then 'null'
        else case column_value ->> 'databaseValueType'
          when 'decimal' then pg_catalog.format('%L::numeric', input_value #>> '{}')
          when 'timestamp_with_time_zone' then
            pg_catalog.format('%L::timestamptz', input_value #>> '{}')
          when 'date' then pg_catalog.format('%L::date', input_value #>> '{}')
          when 'integer' then pg_catalog.format('%L::bigint', input_value #>> '{}')
          when 'boolean' then pg_catalog.format('%L::boolean', input_value #>> '{}')
          when 'json' then pg_catalog.format('%L::jsonb', input_value::text)
          else pg_catalog.format('%L::text', input_value #>> '{}')
        end end
      );
    end loop;

    insert_sql := pg_catalog.format(
      'insert into record_data.%I (
         organisation_id, module_root_id, record_type_id, storage_contract_id,
         record_id, application_root_id, definition_revision,
         owner_organisation_account_id, owner_group_id, lifecycle_state,
         concurrency_number, created_at, created_by, updated_at, updated_by%s
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, ''active'', 1,
         pg_catalog.statement_timestamp(), $10, pg_catalog.statement_timestamp(), $10%s)',
      meta ->> 'table',
      case when pg_catalog.cardinality(column_names) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_names, ', ') end,
      case when pg_catalog.cardinality(column_values) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_values, ', ') end
    );
    if exact_create_notice then
      execute insert_sql || ' returning record_id, concurrency_number'
        into strict saved_record_id, saved_concurrency_number
        using
          (context_value ->> 'organizationId')::uuid,
          (meta ->> 'moduleRootId')::uuid, p_record_type_id,
          (meta ->> 'storageContractId')::uuid, record_id_value, app_scope,
          (meta ->> 'moduleReleaseRevision')::bigint,
          owner_account_id, owner_group_id,
          (context_value ->> 'organizationAccountId')::uuid;
      record_id_value := saved_record_id;
    else
      execute insert_sql using
        (context_value ->> 'organizationId')::uuid,
        (meta ->> 'moduleRootId')::uuid, p_record_type_id,
        (meta ->> 'storageContractId')::uuid, record_id_value, app_scope,
        (meta ->> 'moduleReleaseRevision')::bigint,
        owner_account_id, owner_group_id,
        (context_value ->> 'organizationAccountId')::uuid;
    end if;

    -- The canonical link-target share-lock prelude is written once in
    -- lock_record_change_targets_internal. Every created link's target row is
    -- locked here, before the data-version bump and edge pass below, so a
    -- multi-link create takes all its row locks before its data version and any
    -- edge identity, as the update writer does. A malformed or undeclared link
    -- is left to the writer's own validation.
    perform vortex_record.lock_record_change_targets_internal(
      record_type_value, (context_value ->> 'organizationId')::uuid, final_values
    );
    -- The new record's data version is taken before any relationship edge
    -- identity, as every other relationship writer takes it.
    if exact_create_notice then
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
    else
      perform vortex_record.bump_record_data_version_internal(
        (context_value ->> 'organizationId')::uuid,
        (meta ->> 'storageContractId')::uuid, app_scope
      );
    end if;
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      if final_values ? pg_catalog.lower(field_id_value::text) then
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, record_id_value,
          (relationship_value ->> 'relationshipId')::uuid,
          final_values -> pg_catalog.lower(field_id_value::text), false
        );
      elsif ownership_mode = 'inherited'
        and (record_type_value ->> 'ownershipRelationshipId')::uuid =
          (relationship_value ->> 'relationshipId')::uuid then
        refusal_reason := 'required_owner_relationship_missing';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    loaded := (vortex_record.load_record_access_facts_internal(
      'create', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', record_id_value
      ))
    ) -> 0);
    if loaded ->> 'outcome' <> 'loaded' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding'
    );
    if preview_installation is null then
      decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'declaration', meta -> 'declaration',
          'recordId', record_id_value,
          'facts', facts
        )
      )) -> 0);
      if decision ->> 'outcome' <> 'allowed' then
        refusal_reason := 'access_refused';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        refusal_reason := 'record_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      bounds := preview_bounds;
    end if;
    select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
    into changeable
    from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);
    foreach submitted_id in array p_submitted_field_ids loop
      if not (meta -> 'columns' ? pg_catalog.lower(submitted_id::text)) then
        refusal_reason := 'unknown_field';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
        refusal_reason := 'field_not_changeable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    if exact_create_notice then
      begin
        perform vortex_platform.publish_change_notice(
          (context_value ->> 'organizationId')::uuid, app_scope, p_record_type_id,
          saved_record_id, saved_concurrency_number, 'created',
          notice_sequence, notice_sequence,
          (context_value ->> 'correlationId')::uuid
        );
      exception
        when others then
          -- Invalidation is advisory; a lost notice must not refuse the create.
          null;
      end;
    end if;

    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', record_id_value,
      'concurrencyNumber', case when exact_create_notice
        then saved_concurrency_number else 1 end, 'values', final_values
    );
  exception
    when sqlstate 'P4020' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', refusal_reason
      );
    when no_data_found or too_many_rows or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
  end;
end
$function$;

alter function vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.create_record_internal(uuid, jsonb, uuid[], uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.create_record_internal(uuid, jsonb, uuid[], uuid) is
  'Private fixed create primitive: derives scope, definition and human ownership, generates references, writes typed values and relationships, and decides create authority over the proposed record in one rollback-safe transaction.';

create or replace function vortex_record.decide_choice_option_permission(
  p_record_type_id uuid,
  p_permission_id uuid,
  p_record_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  meta jsonb;
  entry_count integer;
  entry record;
  declaration jsonb;
  eligibility jsonb;
  loaded jsonb;
  decision jsonb;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_permission_id is null
    or p_permission_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Choice option permission selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'A choice option permission requires an Application context';
  end if;

  -- The record-owning Module and the record's exact storage identity come from the installed
  -- release, never from the caller.
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'update');
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object' then
    return false;
  end if;

  -- The option permission is a record-type permission the record-owning Module declares in its
  -- installed release; its action is whatever the release declares, so one decision serves a named
  -- action and a standard one.
  select pg_catalog.count(*) into entry_count
  from vortex_definition.runtime_releases as release
  cross join lateral pg_catalog.jsonb_array_elements(
    coalesce(release.record_content -> 'permissions', '[]'::jsonb)
  ) as item(value)
  where release.root_id = (meta ->> 'moduleRootId')::uuid
    and release.release_revision = (meta ->> 'moduleReleaseRevision')::bigint
    and (item.value ->> 'permissionId')::uuid = p_permission_id
    and (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  if entry_count <> 1 then
    raise log 'Choice option permission refused: % declarations of permission % for record type %',
      entry_count, p_permission_id, p_record_type_id;
    return false;
  end if;
  select item.value ->> 'actionKind' as action_kind, item.value ->> 'namedAction' as named_action
  into strict entry
  from vortex_definition.runtime_releases as release
  cross join lateral pg_catalog.jsonb_array_elements(release.record_content -> 'permissions') as item(value)
  where release.root_id = (meta ->> 'moduleRootId')::uuid
    and release.release_revision = (meta ->> 'moduleReleaseRevision')::bigint
    and (item.value ->> 'permissionId')::uuid = p_permission_id
    and (item.value ->> 'recordTypeId')::uuid = p_record_type_id;

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.choice_option',
    'action', case when entry.named_action is null
      then pg_catalog.jsonb_build_object('actionKind', entry.action_kind)
      else pg_catalog.jsonb_build_object(
        'actionKind', entry.action_kind, 'namedAction', entry.named_action
      ) end,
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'applicationRootId', (context_value ->> 'applicationRootId')::uuid
    ),
    'requiredPermissions', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', (context_value ->> 'applicationRootId')::uuid,
        'ownerKind', 'module',
        'ownerId', (meta ->> 'moduleRootId')::uuid,
        'permissionId', p_permission_id
      )
    ),
    'recordBinding', pg_catalog.jsonb_build_object(
      'moduleRootId', (meta ->> 'moduleRootId')::uuid,
      'recordTypeId', p_record_type_id,
      'storageContractId', (meta ->> 'storageContractId')::uuid,
      'storageScope', meta ->> 'storageScope'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    declaration, context_value, pg_catalog.clock_timestamp()
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    raise log 'Choice option permission refused for permission % on record type %: %',
      p_permission_id, p_record_type_id, eligibility ->> 'reasonCode';
    return false;
  end if;

  -- A role that grants the permission on every record, with no saved condition, decides it for any
  -- record, a new one included.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as alternative(value)
    where pg_catalog.jsonb_typeof(alternative.value -> 'recordScope') = 'object'
      and not (alternative.value -> 'recordScope' ? 'savedCondition')
      and coalesce(
        alternative.value -> 'recordScope' -> 'routes' @> '[{"kind":"all_records"}]'::jsonb,
        false
      )
  ) then
    return true;
  end if;

  -- A narrower record scope is decided only against the stored record it applies to, through the
  -- same record access evaluation every record action uses. A new record has none yet, and a scope
  -- that needs facts beyond the record itself (a relationship or a saved condition) is not offered.
  if p_record_id is null then
    raise log 'Choice option permission refused for permission % on record type %: record scope needs a stored record',
      p_permission_id, p_record_type_id;
    return false;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as alternative(value)
    where pg_catalog.jsonb_typeof(alternative.value -> 'recordScope' -> 'routes') is distinct from 'array'
      or alternative.value -> 'recordScope' ? 'savedCondition'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(alternative.value -> 'recordScope' -> 'routes') = 'array'
            then alternative.value -> 'recordScope' -> 'routes' else '[]'::jsonb end
        ) as route(value)
        where coalesce(route.value ->> 'kind', '') not in ('all_records', 'ownership', 'direct_share')
      )
  ) then
    raise log 'Choice option permission refused for permission % on record type %: record scope is not decided by the record alone',
      p_permission_id, p_record_type_id;
    return false;
  end if;

  loaded := (vortex_record.load_record_access_facts_internal(
    'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id,
      'recordId', p_record_id
    ))
  ) -> 0);
  if loaded ->> 'outcome' is distinct from 'loaded' then
    raise log 'Choice option permission refused for permission % on record %: record facts %',
      p_permission_id, p_record_id, coalesce(loaded ->> 'outcome', 'unavailable');
    return false;
  end if;
  decision := vortex_access.evaluate_record_access_with_validated_types_internal(
    declaration, p_record_id, loaded -> 'facts', null, null
  );
  if decision ->> 'outcome' is distinct from 'allowed' then
    raise log 'Choice option permission refused for permission % on record %: %',
      p_permission_id, p_record_id, decision ->> 'reasonCode';
    return false;
  end if;
  return true;
end
$function$;

alter function vortex_record.decide_choice_option_permission(uuid, uuid, uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.decide_choice_option_permission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.decide_choice_option_permission(uuid, uuid, uuid)
  to vortex_runtime, vortex_request;
comment on function vortex_record.decide_choice_option_permission(uuid, uuid, uuid) is
  'The one decision whether the signed-in person may use a choice option gated by a record-type permission, for one stored record or (with no record) a new one; the offered list and the form save both ask it.';

create or replace function vortex_record.list_offboarding_owned_records_internal(
  p_source_organization_account_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_after_storage_contract_id uuid,
  p_after_record_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  installation jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  candidate_record_id uuid;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  lifecycle_state_value text;
  classification_value text;
  item_value jsonb;
  items jsonb := '[]'::jsonb;
  counts jsonb := '{}'::jsonb;
  item_count integer := 0;
  has_more boolean := false;
  last_storage_contract_id uuid;
  last_record_id uuid;
  candidate_sql text;
begin
  if p_source_organization_account_id is null
    or p_source_organization_account_id = nil_uuid
    or p_target_id is null
    or p_target_id = nil_uuid
    or p_target_kind is null
    or p_target_kind not in ('organization_account', 'group')
    or p_limit is null
    or p_limit not between 1 and 50
    or ((p_after_storage_contract_id is null) <> (p_after_record_id is null)) then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory requires an application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  installation := vortex_definition.read_current_offboarding_inventory_installation_internal();

  for catalogue_row in
    select catalogue.*
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id in (
      select (value #>> '{}')::uuid
      from pg_catalog.jsonb_array_elements(installation -> 'storageContractIds') as item(value)
    )
      and catalogue.state = 'active'
      and catalogue.storage_scope = 'application_contained'
      and catalogue.record_type_definition ->> 'ownershipMode' = 'organization_account'
      and (
        p_after_storage_contract_id is null
        or catalogue.storage_contract_id >= p_after_storage_contract_id
      )
    order by catalogue.storage_contract_id
  loop
    if p_after_storage_contract_id is not null
      and catalogue_row.storage_contract_id = p_after_storage_contract_id
      and p_after_record_id is null then
      continue;
    end if;

    candidate_sql := pg_catalog.format(
      'select stored.record_id
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.application_root_id = $2
         and stored.owner_organisation_account_id = $3%s
       order by stored.record_id',
      catalogue_row.physical_table_token,
      case
        when p_after_storage_contract_id = catalogue_row.storage_contract_id
          then ' and stored.record_id > $4'
        else ''
      end
    );

    for candidate_record_id in execute candidate_sql
      using organization_id_value, application_root_id_value,
        p_source_organization_account_id, p_after_record_id
    loop
      -- Once the page is full, continue only until a further disclosed record
      -- establishes that the returned keyset cursor has another visible page.
      begin
        loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
          catalogue_row.record_type_id, candidate_record_id, null, installation
        );
        if loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
          continue;
        end if;

        decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'declaration', loaded -> 'declaration',
            'recordId', candidate_record_id,
            'facts', loaded -> 'facts'
          )
        )) -> 0);
        if decision ->> 'outcome' <> 'allowed' then
          continue;
        end if;

        select item.value into record_fact
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
        where (item.value -> 'recordScope' ->> 'recordId')::uuid = candidate_record_id;
        select item.value into record_type_fact
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
        where (item.value ->> 'recordTypeId')::uuid = catalogue_row.record_type_id;
        if record_fact is null or record_type_fact is null
          or record_type_fact ->> 'ownershipMode' <> 'organization_account' then
          continue;
        end if;

        lifecycle_state_value := record_fact ->> 'lifecycleState';
        classification_value := case
          when p_target_kind <> 'organization_account'
            or lifecycle_state_value = 'removal_pending'
            then 'refused_incompatible'
          else 'transferable'
        end;
      exception
        when others then
          -- Candidate failures carry record-specific detail. They are treated
          -- exactly like a refused access decision: absent from the response.
          -- Cancellation, resource, operator and internal failures are not
          -- record specific: swallowing one would present a truncated scan as a
          -- complete page, so those classes keep propagating to the caller.
          if pg_catalog.left(returned_sqlstate, 2)
            in ('40', '53', '57', '58', 'XX') then
            raise;
          end if;
          continue;
      end;

      if item_count >= p_limit then
        has_more := true;
        exit;
      end if;

      item_value := pg_catalog.jsonb_build_object(
        'storageContractId', catalogue_row.storage_contract_id,
        'recordTypeId', catalogue_row.record_type_id,
        'recordId', candidate_record_id,
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'lifecycleState', lifecycle_state_value,
        'installationState', installation -> 'installationState',
        'classification', classification_value
      );
      items := items || pg_catalog.jsonb_build_array(item_value);
      counts := counts || pg_catalog.jsonb_build_object(
        pg_catalog.lower(catalogue_row.record_type_id::text),
        coalesce(counts -> pg_catalog.lower(catalogue_row.record_type_id::text),
          pg_catalog.jsonb_build_object(
            'recordTypeId', catalogue_row.record_type_id,
            'transferable', 0,
            'refusedIncompatible', 0
          )) || pg_catalog.jsonb_build_object(
            case classification_value
              when 'transferable' then 'transferable'
              else 'refusedIncompatible'
            end,
            coalesce((counts -> pg_catalog.lower(catalogue_row.record_type_id::text)
              ->> case classification_value
                when 'transferable' then 'transferable'
                else 'refusedIncompatible'
              end)::integer, 0) + 1
          )
      );
      item_count := item_count + 1;
      last_storage_contract_id := catalogue_row.storage_contract_id;
      last_record_id := candidate_record_id;
    end loop;
    exit when has_more;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'listed',
    'section', pg_catalog.jsonb_build_object(
      'kind', 'application', 'applicationRootId', application_root_id_value
    ),
    'installationState', installation -> 'installationState',
    'items', items,
    'perRecordType', coalesce((
      select pg_catalog.jsonb_agg(entry.value order by entry.value ->> 'recordTypeId')
      from pg_catalog.jsonb_each(counts) as entry(key, value)
    ), '[]'::jsonb)
  ) || case when has_more then pg_catalog.jsonb_build_object(
    'next', pg_catalog.jsonb_build_object(
      'storageContractId', last_storage_contract_id,
      'recordId', last_record_id
    )
  ) else '{}'::jsonb end;
end
$function$;

alter function vortex_record.list_offboarding_owned_records_internal(uuid, text, uuid, uuid, uuid, integer) owner to vortex_record_adapter;

revoke all on function vortex_record.list_offboarding_owned_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.list_offboarding_owned_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) is
  'Private application-contained account-offboarding inventory; denied candidate records are omitted without identity or count disclosure, and a non-record failure propagates instead of truncating a page silently.';

create or replace function vortex_record.list_offboarding_owned_shared_records_internal(
  p_source_organization_account_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_after_storage_contract_id uuid,
  p_after_record_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  organization_id_value uuid;
  installation jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  candidate_record_id uuid;
  contract_affected_applications jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  lifecycle_state_value text;
  classification_value text;
  item_value jsonb;
  items jsonb := '[]'::jsonb;
  counts jsonb := '{}'::jsonb;
  item_count integer := 0;
  has_more boolean := false;
  last_storage_contract_id uuid;
  last_record_id uuid;
  candidate_sql text;
begin
  if p_source_organization_account_id is null
    or p_source_organization_account_id = nil_uuid
    or p_target_id is null
    or p_target_id = nil_uuid
    or p_target_kind is null
    or p_target_kind not in ('organization_account', 'group')
    or p_limit is null
    or p_limit not between 1 and 50
    or ((p_after_storage_contract_id is null) <> (p_after_record_id is null)) then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory requires an application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  installation := vortex_definition.read_current_offboarding_inventory_installation_internal();

  for catalogue_row in
    select catalogue.*
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id in (
      select (value #>> '{}')::uuid
      from pg_catalog.jsonb_array_elements(installation -> 'storageContractIds') as item(value)
    )
      and catalogue.state = 'active'
      and catalogue.storage_scope = 'organization_shared'
      and catalogue.record_type_definition ->> 'ownershipMode' = 'organization_account'
      and (
        p_after_storage_contract_id is null
        or catalogue.storage_contract_id >= p_after_storage_contract_id
      )
    order by catalogue.storage_contract_id
  loop
    if p_after_storage_contract_id is not null
      and catalogue_row.storage_contract_id = p_after_storage_contract_id
      and p_after_record_id is null then
      continue;
    end if;

    -- The affected applications of a contract are a property of the contract,
    -- not of the page: every record disclosed from it carries the complete set.
    contract_affected_applications :=
      vortex_definition.read_offboarding_inventory_contract_applications_internal(
        catalogue_row.storage_contract_id
      );

    -- A shared row has no application column value: the storage scope's own
    -- check constraint requires it to be null.
    candidate_sql := pg_catalog.format(
      'select stored.record_id
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.application_root_id is null
         and stored.owner_organisation_account_id = $2%s
       order by stored.record_id',
      catalogue_row.physical_table_token,
      case
        when p_after_storage_contract_id = catalogue_row.storage_contract_id
          then ' and stored.record_id > $3'
        else ''
      end
    );

    for candidate_record_id in execute candidate_sql
      using organization_id_value, p_source_organization_account_id, p_after_record_id
    loop
      -- Once the page is full, continue only until a further disclosed record
      -- establishes that the returned keyset cursor has another visible page.
      begin
        loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
          catalogue_row.record_type_id, candidate_record_id, null, installation
        );
        if loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
          continue;
        end if;

        decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'declaration', loaded -> 'declaration',
            'recordId', candidate_record_id,
            'facts', loaded -> 'facts'
          )
        )) -> 0);
        if decision ->> 'outcome' <> 'allowed' then
          continue;
        end if;

        select item.value into record_fact
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
        where (item.value -> 'recordScope' ->> 'recordId')::uuid = candidate_record_id;
        select item.value into record_type_fact
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
        where (item.value ->> 'recordTypeId')::uuid = catalogue_row.record_type_id;
        if record_fact is null or record_type_fact is null
          or record_type_fact ->> 'ownershipMode' <> 'organization_account' then
          continue;
        end if;

        lifecycle_state_value := record_fact ->> 'lifecycleState';
        classification_value := case
          when p_target_kind <> 'organization_account'
            or lifecycle_state_value = 'removal_pending'
            then 'refused_incompatible'
          else 'transferable'
        end;
      exception
        when others then
          -- Candidate failures carry record-specific detail. They are treated
          -- exactly like a refused access decision: absent from the response.
          -- Cancellation, resource, operator and internal failures are not
          -- record specific: swallowing one would present a truncated scan as a
          -- complete page, so those classes keep propagating to the caller.
          if pg_catalog.left(returned_sqlstate, 2)
            in ('40', '53', '57', '58', 'XX') then
            raise;
          end if;
          continue;
      end;

      if item_count >= p_limit then
        has_more := true;
        exit;
      end if;

      item_value := pg_catalog.jsonb_build_object(
        'storageContractId', catalogue_row.storage_contract_id,
        'recordTypeId', catalogue_row.record_type_id,
        'recordId', candidate_record_id,
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'lifecycleState', lifecycle_state_value,
        'installationState', installation -> 'installationState',
        'classification', classification_value,
        'storageScope', 'organization_shared',
        'affectedApplications', contract_affected_applications
      );
      items := items || pg_catalog.jsonb_build_array(item_value);
      counts := counts || pg_catalog.jsonb_build_object(
        pg_catalog.lower(catalogue_row.record_type_id::text),
        coalesce(counts -> pg_catalog.lower(catalogue_row.record_type_id::text),
          pg_catalog.jsonb_build_object(
            'recordTypeId', catalogue_row.record_type_id,
            'storageScope', 'organization_shared',
            'transferable', 0,
            'refusedIncompatible', 0,
            'affectedApplications', contract_affected_applications
          )) || pg_catalog.jsonb_build_object(
            case classification_value
              when 'transferable' then 'transferable'
              else 'refusedIncompatible'
            end,
            coalesce((counts -> pg_catalog.lower(catalogue_row.record_type_id::text)
              ->> case classification_value
                when 'transferable' then 'transferable'
                else 'refusedIncompatible'
              end)::integer, 0) + 1
          )
      );
      item_count := item_count + 1;
      last_storage_contract_id := catalogue_row.storage_contract_id;
      last_record_id := candidate_record_id;
    end loop;
    exit when has_more;
  end loop;

  -- `perRecordType` and `pageAffectedApplications` describe the records
  -- disclosed on this page only. A section-wide total would have to count
  -- records the caller may not read, so the inventory never presents one.
  return pg_catalog.jsonb_build_object(
    'outcome', 'listed',
    'section', pg_catalog.jsonb_build_object('kind', 'organization_shared'),
    'installationState', installation -> 'installationState',
    'items', items,
    'perRecordType', coalesce((
      select pg_catalog.jsonb_agg(entry.value order by entry.value ->> 'recordTypeId')
      from pg_catalog.jsonb_each(counts) as entry(key, value)
    ), '[]'::jsonb),
    'pageAffectedApplications', coalesce((
      select pg_catalog.jsonb_agg(distinct application.value order by application.value)
      from pg_catalog.jsonb_each(counts) as entry(key, value),
      lateral pg_catalog.jsonb_array_elements_text(
        entry.value -> 'affectedApplications'
      ) as application(value)
    ), '[]'::jsonb)
  ) || case when has_more then pg_catalog.jsonb_build_object(
    'next', pg_catalog.jsonb_build_object(
      'storageContractId', last_storage_contract_id,
      'recordId', last_record_id
    )
  ) else '{}'::jsonb end;
end
$function$;

alter function vortex_record.list_offboarding_owned_shared_records_internal(uuid, text, uuid, uuid, uuid, integer) owner to vortex_record_adapter;

revoke all on function vortex_record.list_offboarding_owned_shared_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.list_offboarding_owned_shared_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) is
  'Private organisation-shared account-offboarding inventory; denied candidate records are omitted without identity or count disclosure, and a non-record failure propagates instead of truncating a page silently.';

create or replace function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  return (vortex_record.load_record_access_facts_from_installation_internal(
    'transfer', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id,
      'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number
    )),
    p_installation
  ) -> 0);
end
$function$;

alter function vortex_record.load_record_access_facts_for_transfer_installation_internal(uuid,uuid,bigint,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) to vortex_record_adapter;
comment on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) is
  'Private complete record-scope fact loader for transfer, parameterised only by an exact trusted installation.';

create or replace function vortex_record.module_query_scan_internal(
  p_plan jsonb,
  p_member jsonb,
  p_prior_decision jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  -- A page ending at this candidate budget still returns its position for the next request.
  scan_limit constant integer := 500;
  member_kind text := p_member ->> 'kind';
  page_size integer := (p_plan ->> 'pageSize')::integer;
  direction text := p_plan ->> 'direction';
  record_type_id_value uuid := (p_plan ->> 'recordTypeId')::uuid;
  v_storage_contract_id uuid := (p_plan ->> 'storageContractId')::uuid;
  context_organization_id uuid := (p_plan ->> 'organizationId')::uuid;
  context_application_root_id uuid := (p_plan ->> 'applicationRootId')::uuid;
  preview_mode boolean := (p_plan ->> 'preview')::boolean;
  fields_by_id jsonb := p_plan -> 'fieldsById';
  storage_plan jsonb := p_plan -> 'storagePlan';
  requested_ids text[];
  system_field_keys text[];
  filter_ids text[];
  search_field_ids text[];
  user_search text := p_plan #>> '{searchPlan,search}';
  filter_condition jsonb := nullif(p_plan -> 'filterCondition', 'null'::jsonb);
  filter_exact boolean := (p_plan ->> 'filterExact')::boolean;
  filter_types jsonb := p_plan -> 'filterTypes';
  parameter_types jsonb := p_plan -> 'inputTypes';
  parameter_values jsonb := p_plan -> 'inputs';
  after_sort_key text[];
  after_record_id uuid := (p_plan ->> 'afterRecordId')::uuid;
  exact_record_ids uuid[];
  access_owner_account_id uuid := nullif(p_plan #>> '{storagePlan,access,ownerAccountId}', '')::uuid;
  access_owner_group_ids uuid[];
  access_shared_record_ids uuid[];
  segment_predicates text[];
  segment_sql text;
  scan_sql text;
  scan_record record;
  scan_cursor refcursor;
  cursor_position integer;
  lookahead_record record;
  lookahead_ids uuid[];
  read_row record;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  -- The one bounded system projection reader, when the plan chose it.
  projection_page_scan boolean := (p_plan ->> 'projectionPageScan')::boolean;
  projection_sort_key text := p_plan ->> 'projectionSortKey';
  projection_direction text := p_plan ->> 'projectionDirection';
  projection_predicate jsonb := p_plan -> 'projectionPredicate';
  projection_batch jsonb;
  projection_after jsonb := nullif(p_plan -> 'after', 'null'::jsonb);
  projection_batch_size integer;
  projection_candidate_count integer := 0;
  projection_reader_exhausted boolean := false;
  projection_batch_exhausted boolean := false;
  projection_last_record_id uuid;
  projection_last_sort_key text[];
  projection_failure text;
  -- The page's access facts, eligibility and validated record types stay those of this one scan.
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_eligibility_checked boolean := false;
  validated_record_types jsonb;
  page_first_loaded jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  page_batching boolean := true;
  examined integer := 0;
  budget_exhausted boolean := false;
  every_bucket_more boolean := false;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  -- Page state by bucket: one bucket, except a board's shared first pages, where each readable row
  -- goes to the column its readable choice value names.
  bucket_count integer := case when p_member ->> 'kind' = 'choice'
    then pg_catalog.jsonb_array_length(p_member -> 'columns') else 1 end;
  bucket integer;
  bucket_rows jsonb[];
  bucket_capabilities jsonb[];
  bucket_counts integer[];
  bucket_more boolean[];
  bucket_first_keys jsonb[];
  bucket_first_ids uuid[];
  bucket_last_keys jsonb[];
  bucket_last_ids uuid[];
  page_capabilities jsonb;
  rows_value jsonb;
  next_value jsonb;
  opposite_value jsonb;
  pages jsonb := '[]'::jsonb;
  key_value jsonb;
  -- Membership of the closed mode value.
  choice_field_id text := p_member ->> 'choiceFieldId';
  choice_option_values text[];
  group_by_ids text[];
  group_selector_values jsonb := p_member -> 'groupValues';
  group_link_field_id text := p_member ->> 'linkFieldId';
  group_link_cache jsonb := coalesce(p_member -> 'linkCache', '{}'::jsonb);
  group_link_values jsonb[];
  group_candidate_values jsonb;
  member_matches boolean;
  tree_field_id text := p_member ->> 'fieldId';
  tree_parent_id uuid := (p_member ->> 'parentRecordId')::uuid;
  tree_item jsonb;
  tree_root_child_ids uuid[] := array[]::uuid[];
  tree_root_nonroot_ids uuid[];
  tree_root_readable_parent_ids uuid[];
begin
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into requested_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'requestedFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into system_field_keys
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'systemFieldKeys') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into filter_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{searchPlan,fieldIds}') as item(value);
  select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality) into after_sort_key
  from pg_catalog.jsonb_array_elements(coalesce(nullif(p_plan -> 'afterSortKey', 'null'::jsonb), '[]'::jsonb))
    with ordinality as item(value, ordinality);
  if p_plan -> 'exactRecordIds' <> 'null'::jsonb then
    select pg_catalog.array_agg(item.value::uuid) into exact_record_ids
    from pg_catalog.jsonb_array_elements_text(p_plan -> 'exactRecordIds') as item(value);
  end if;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{storagePlan,access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{storagePlan,access,sharedRecordIds}') as item(value);
  select pg_catalog.array_agg(item.value) into segment_predicates
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'segmentPredicates') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into choice_option_values
  from pg_catalog.jsonb_array_elements_text(coalesce(p_member -> 'optionValues', '[]'::jsonb)) as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into group_by_ids
  from pg_catalog.jsonb_array_elements_text(coalesce(p_member -> 'groupByFieldIds', '[]'::jsonb)) as item(value);
  -- A later scan of the same invocation (the next narrowed board column) reuses the first scan's
  -- page decision exactly as one scan reuses it for its next candidates.
  if p_prior_decision is not null then
    page_eligibility_checked := (p_prior_decision ->> 'checked')::boolean;
    page_first_loaded := nullif(p_prior_decision -> 'firstLoaded', 'null'::jsonb);
    page_declaration := nullif(p_prior_decision -> 'declaration', 'null'::jsonb);
    page_eligibility := nullif(p_prior_decision -> 'eligibility', 'null'::jsonb);
    page_shared := nullif(p_prior_decision -> 'shared', 'null'::jsonb);
    page_narrowed := (p_prior_decision ->> 'narrowed')::boolean;
    validated_record_types := nullif(p_prior_decision -> 'validatedRecordTypes', 'null'::jsonb);
  end if;
  bucket_rows := pg_catalog.array_fill('[]'::jsonb, array[bucket_count]);
  bucket_capabilities := bucket_rows;
  bucket_counts := pg_catalog.array_fill(0, array[bucket_count]);
  bucket_more := pg_catalog.array_fill(false, array[bucket_count]);
  bucket_first_keys := pg_catalog.array_fill('null'::jsonb, array[bucket_count]);
  bucket_first_ids := pg_catalog.array_fill(null::uuid, array[bucket_count]);
  bucket_last_keys := bucket_first_keys;
  bucket_last_ids := bucket_first_ids;
  if projection_page_scan then
    projection_batch_size := least(page_size, scan_limit);
    begin
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
      into projection_batch
      from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
        exact_record_ids, projection_sort_key, projection_direction, projection_after,
        projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
        record_id, revision, attribute_values, ordinality);
    exception when sqlstate '22023' then
      get stacked diagnostics projection_failure = message_text;
      if projection_failure in ('filter_field_not_declared', 'predicate_unsupported') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', projection_failure);
      end if;
      raise;
    end;
  end if;
  foreach segment_sql in array segment_predicates loop
  loop
  if projection_page_scan then
    projection_candidate_count := projection_candidate_count + pg_catalog.jsonb_array_length(projection_batch);
    projection_reader_exhausted := pg_catalog.jsonb_array_length(projection_batch) < projection_batch_size;
    if pg_catalog.jsonb_array_length(projection_batch) = 0 then
      exit;
    end if;
    projection_last_record_id := (projection_batch -> -1 ->> 'record_id')::uuid;
    projection_last_sort_key := array[projection_batch -> -1 -> 'attribute_values' ->> projection_sort_key];
    projection_after := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(projection_last_sort_key),
      'phase', case when projection_last_sort_key[1] is null then 'null' else 'value' end,
      'recordId', projection_last_record_id);
    projection_batch_exhausted := projection_candidate_count >= scan_limit;
  end if;
  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values,
       %s as projection_row,
       %s as group_link_value
     from %s
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and ($12::uuid[] is null or stored.record_id = any ($12))
       and %s
       and (%s)
        and (case when (%s) then true else false end)
        and (%s)%s
        and (%s)
     order by %s
     limit $5',
    p_plan ->> 'sortKeySql',
    p_plan ->> 'filterValuesSql',
    p_plan ->> 'systemColumnsSql',
    p_plan ->> 'scanProjectionSql',
    coalesce(p_member ->> 'linkValueSql', 'null::jsonb'),
    p_plan ->> 'scanSourceSql',
    case when p_plan #>> '{storagePlan,storage,storageScope}' = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    p_plan #>> '{storagePlan,access,predicate}',
    p_plan ->> 'filterPredicate',
    coalesce(p_member ->> 'predicate', 'true'),
    segment_sql,
    p_plan ->> 'searchPrefilterSql',
    p_plan ->> 'orderBySql'
  );
  -- A validated type set stays local to this invocation and is passed only to
  -- the fixed record adapter's private evaluator.
  open scan_cursor scroll for execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      p_plan -> 'filterParameters', coalesce(p_plan #> '{storagePlan,access,parameters}', '[]'::jsonb),
      projection_batch, exact_record_ids,
      p_member ->> 'columnValue', choice_option_values, group_selector_values, tree_parent_id,
      search_field_ids, user_search;
  cursor_position := 0;
  loop
    fetch scan_cursor into scan_record;
    exit when not found;
    cursor_position := cursor_position + 1;
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;
    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    -- Preparation has already validated the inputs. An exact SQL predicate
    -- has decided this condition over fields every candidate reader can see.
    if filter_condition is null or filter_exact then
      passes := true;
    else
      begin
        passes := vortex_access.evaluate_query_condition_internal(
          filter_condition, filter_types, scan_record.filter_values,
          parameter_types, parameter_values, false
        );
      exception when invalid_parameter_value then
        passes := true;
        needs_refusal_check := true;
      end;
    end if;
    if passes then
      page_access_loaded := null;
      if not page_eligibility_checked then
        -- Keep the reusable decision in this invocation; the request role cannot
        -- write it or pass it to the owner-only exact-record evaluator.
        page_eligibility_checked := true;
        -- The installation and its access plan are resolved once for the page;
        -- every exact record decision below consumes this local plan.
        page_shared := pg_catalog.jsonb_build_object(
          'installation', case when preview_mode
            then vortex_record.read_current_preview_installation_internal()
            else vortex_definition.read_current_active_installation() end);
        page_shared := page_shared || pg_catalog.jsonb_build_object('plan',
          vortex_record.resolve_installation_access_plan_internal(page_shared -> 'installation'));
        page_access_loaded := (vortex_record.load_record_access_facts_with_plan_internal(
          'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordTypeId', record_type_id_value,
            'recordId', scan_record.record_id,
            'projectionRow', scan_record.projection_row
          )),
          page_shared -> 'installation', page_shared -> 'plan'
        ) -> 0);
        if page_access_loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
          page_declaration := page_access_loaded -> 'declaration';
          if preview_mode then
            -- Owner authority and the exact storage binding were validated by
            -- preparation and the first loader in this invocation. Bounds are
            -- identical for every copied row of this record type.
            page_shared := page_shared || pg_catalog.jsonb_build_object(
              'previewBounds', vortex_record.preview_record_field_bounds_internal(
                record_type_id_value, v_storage_contract_id, p_plan -> 'recordType'));
          else
            page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
              page_declaration, vortex_access.validated_human_request_context(),
              pg_catalog.clock_timestamp()
            );
          end if;
          page_first_loaded := page_access_loaded;
          select page_shared || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
            page.narrowed
          into page_shared, page_narrowed
          from vortex_record.read_record_page_envelope_internal(record_type_id_value, page_first_loaded) as page;
        end if;
      end if;
      -- Decide this candidate and the page's next ones together in one set
      -- pass; the cursor returns to this row, so the scan order, budget and
      -- every later check stay those of the row-by-row walk.
      if page_batching and page_first_loaded is not null
        and not (scan_record.record_id = any (decided_ids)) then
        lookahead_ids := array[scan_record.record_id];
        while pg_catalog.cardinality(lookahead_ids) <= page_size loop
          fetch scan_cursor into lookahead_record;
          exit when not found;
          lookahead_ids := pg_catalog.array_append(lookahead_ids, lookahead_record.record_id);
        end loop;
        move absolute cursor_position from scan_cursor;
        select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
          pg_catalog.array_agg(decided.bounds)
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          record_type_id_value, page_first_loaded, page_declaration, page_eligibility,
          lookahead_ids, page_shared -> 'envelope', page_narrowed
        ) as decided;
        page_batching := pg_catalog.cardinality(decided_ids) > 0;
      end if;
      -- The page's first record keeps the exact decision, which also validates
      -- the installation-wide facts every decided record shares.
      decided_index := case when page_access_loaded is null
        then pg_catalog.array_position(decided_ids, scan_record.record_id) end;
      select row_read.* into read_row
      from vortex_record.read_record_projection_with_validated_types_internal(
        record_type_id_value, scan_record.record_id, page_declaration, page_eligibility,
        validated_record_types, scan_record.projection_row,
        coalesce(decided_loaded[decided_index], page_access_loaded),
        decided_decisions[decided_index], decided_bounds[decided_index], page_shared
      ) as row_read;
      projection := read_row.projection;
      -- Only the exact evaluator validates record types for reuse.
      if validated_record_types is null and decided_index is null then
        validated_record_types := coalesce(
          read_row.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then read_row.read_facts #> '{facts,recordTypes}' end
        );
      end if;
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if member_kind = 'tree_roots' then
          -- Root membership uses exact batched parent decisions, never the access superset.
          if not (scan_record.record_id = any (tree_root_child_ids)) then
            tree_root_child_ids := array[scan_record.record_id];
            while pg_catalog.cardinality(tree_root_child_ids) <= page_size loop
              fetch scan_cursor into lookahead_record;
              exit when not found;
              tree_root_child_ids := pg_catalog.array_append(tree_root_child_ids, lookahead_record.record_id);
            end loop;
            move absolute cursor_position from scan_cursor;
            tree_item := vortex_record.read_query_tree_relatives_internal(
              true, tree_root_child_ids, (p_member ->> 'relationshipId')::uuid, context_organization_id,
              context_application_root_id, storage_plan, record_type_id_value, page_first_loaded,
              page_declaration, page_eligibility, page_shared, page_narrowed, validated_record_types,
              p_member -> 'filter');
            if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
            select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
            into tree_root_nonroot_ids
            from pg_catalog.jsonb_array_elements_text(tree_item -> 'recordIds') as item(value);
            select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
            into tree_root_readable_parent_ids
            from pg_catalog.jsonb_array_elements_text(tree_item -> 'readableParentRecordIds') as item(value);
          end if;
          if scan_record.record_id = any (tree_root_nonroot_ids) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          -- A readable parent outside the filter/search still keeps its link value.
          -- Only an unreadable or absent parent is hidden, using the same exact batch decision.
          if not (scan_record.record_id = any (tree_root_readable_parent_ids)) then
            readable_values := pg_catalog.jsonb_set(readable_values, array[tree_field_id], 'null'::jsonb);
          end if;
        end if;
        -- Filters decide membership, so every referenced value must be readable.
        -- Sorts only decide order: the scan already drops unguaranteed sort keys
        -- and ends with record identity. A withheld published sort field must
        -- neither remove a readable row nor expose its value through ordering.
        if not exists (
          select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) and not exists (
          select 1 from pg_catalog.unnest(search_field_ids) as searched(id)
          where projection_page_scan and user_search is not null
            and not (readable_values ? searched.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          bucket := 1;
          if member_kind = 'choice' then
            -- A board row belongs to the column its readable choice value names, or to the
            -- unassigned column when it names no option. A column that already holds its page
            -- and the card after it does not read the row again.
            bucket := (
              select requested.ordinality::integer
              from pg_catalog.jsonb_array_elements(p_member -> 'columns') with ordinality
                as requested(value, ordinality)
              where case when (readable_values ? choice_field_id)
                  and pg_catalog.jsonb_typeof(readable_values -> choice_field_id) = 'string'
                  and (readable_values ->> choice_field_id) collate "C"
                    = any (choice_option_values)
                then requested.value ->> 'kind' = 'option'
                  and (requested.value ->> 'value') collate "C"
                    = (readable_values ->> choice_field_id) collate "C"
                else requested.value ->> 'kind' = 'unassigned' end
              limit 1
            );
            if bucket is null or bucket_more[bucket] then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          elsif member_kind = 'group' then
            member_matches := not exists (
              select 1 from pg_catalog.unnest(group_by_ids) as grouped(id)
              where not (readable_values ? grouped.id)
            );
            if member_matches and group_link_field_id is not null
              and group_selector_values -> group_link_field_id = '"not_available"'::jsonb then
              -- The group of unreadable targets: one protected title batch decides the targets of this
              -- row and the page's next candidates together; the cache holds each target once per call.
              if pg_catalog.jsonb_typeof(readable_values -> group_link_field_id) = 'object'
                and not (group_link_cache ? (readable_values -> group_link_field_id ->> 'recordId')) then
                group_link_values := array[readable_values -> group_link_field_id];
                while pg_catalog.cardinality(group_link_values) <= page_size loop
                  fetch scan_cursor into lookahead_record;
                  exit when not found;
                  group_link_values := pg_catalog.array_append(group_link_values, lookahead_record.group_link_value);
                end loop;
                move absolute cursor_position from scan_cursor;
                group_link_cache := vortex_record.group_link_unreadable_internal(
                  group_link_cache, group_link_values, fields_by_id -> group_link_field_id);
              end if;
              member_matches := coalesce(
                (group_link_cache ->> (readable_values -> group_link_field_id ->> 'recordId'))::boolean, false);
            elsif member_matches then
              select pg_catalog.jsonb_object_agg(grouped.id, vortex_record.grouping_value_internal(
                readable_values -> grouped.id, fields_by_id -> grouped.id ->> 'type', nullif(p_member -> 'dateBucket', 'null'::jsonb)
              ))
              into group_candidate_values
              from pg_catalog.unnest(group_by_ids) as grouped(id);
              member_matches := group_candidate_values = group_selector_values;
            end if;
            if not member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          elsif member_kind = 'tree_children' and not (
            pg_catalog.jsonb_typeof(readable_values -> tree_field_id) = 'object'
            and pg_catalog.lower(readable_values -> tree_field_id ->> 'recordId') = pg_catalog.lower(tree_parent_id::text)
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if user_search is not null and not projection_page_scan
            and not vortex_record.query_search_matches_internal(
            readable_values, search_field_ids, user_search
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if bucket_counts[bucket] = page_size then
            -- A full bucket with a matching row after it has more rows; the scan ends only when
            -- every bucket has.
            bucket_more[bucket] := true;
            if pg_catalog.array_position(bucket_more, false) is null then
              every_bucket_more := true;
              exit;
            end if;
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if bucket_counts[bucket] = 0 then
            bucket_first_keys[bucket] := pg_catalog.to_jsonb(scan_record.sort_key);
            bucket_first_ids[bucket] := scan_record.record_id;
          end if;
          -- Keep the read facts and field bounds for one page-level capability
          -- decision after the readable page has been selected.
          bucket_capabilities[bucket] := bucket_capabilities[bucket] || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id, 'readBounds', read_row.read_bounds
            ) || case
              -- The page pass's compact record scope when it has one, also for
              -- the first record; its page-wide facts are the page envelope.
              when scan_record.record_id = any (decided_ids) then pg_catalog.jsonb_build_object('record',
                decided_loaded[pg_catalog.array_position(decided_ids, scan_record.record_id)])
              else pg_catalog.jsonb_build_object('readFacts', read_row.read_facts) end
          );
          bucket_rows[bucket] := bucket_rows[bucket] || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'revision', projection -> 'concurrencyNumber',
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ) || case when pg_catalog.cardinality(system_field_keys) > 0
            then pg_catalog.jsonb_build_object('systemValues', scan_record.system_values)
            else '{}'::jsonb end);
          bucket_counts[bucket] := bucket_counts[bucket] + 1;
          bucket_last_keys[bucket] := pg_catalog.to_jsonb(scan_record.sort_key);
          bucket_last_ids[bucket] := scan_record.record_id;
        end if;
      end if;
    end if;
    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;
  close scan_cursor;
  exit when not projection_page_scan or every_bucket_more or projection_batch_exhausted
    or projection_reader_exhausted;
  projection_batch_size := least(page_size, scan_limit - projection_candidate_count);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
  into projection_batch
  from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
    exact_record_ids, projection_sort_key, projection_direction, projection_after,
    projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
    record_id, revision, attribute_values, ordinality);
  end loop;
  exit when every_bucket_more or budget_exhausted;
  end loop;
  if projection_batch_exhausted and not bucket_more[1] then
    budget_exhausted := true;
    last_examined_sort_key := projection_last_sort_key;
    last_examined_record_id := projection_last_record_id;
  end if;
  -- Each bucket's page: its rows with their capabilities, in one pass over the page, and its own
  -- continuations, never another bucket's.
  for bucket in 1 .. bucket_count loop
    rows_value := bucket_rows[bucket];
    if bucket_counts[bucket] > 0 then
      page_capabilities := vortex_record.read_record_capabilities_page_internal(
        record_type_id_value, bucket_capabilities[bucket], page_shared -> 'envelope'
      );
      if pg_catalog.jsonb_typeof(page_capabilities) is distinct from 'array'
        or pg_catalog.jsonb_array_length(page_capabilities) <> bucket_counts[bucket] then
        raise exception using errcode = '55000', message = 'Page capabilities are unavailable';
      end if;
      if exists (
        select 1 from pg_catalog.jsonb_array_elements(page_capabilities) as item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) then
        raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
      end if;
      select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
          'capabilities', page_capabilities -> (item.ordinality::integer - 1)) order by item.ordinality)
      into rows_value
      from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
    end if;
    next_value := null;
    opposite_value := null;
    key_value := case when bucket_more[bucket] then bucket_last_keys[bucket]
      when budget_exhausted then pg_catalog.to_jsonb(last_examined_sort_key) end;
    if bucket_more[bucket] or budget_exhausted then
      next_value := pg_catalog.jsonb_build_object(
        'sort', p_plan -> 'cursorSort',
        'sortKey', key_value,
        'phase', case when pg_catalog.jsonb_array_length(key_value) > 0
          and key_value -> 0 = 'null'::jsonb then 'null' else 'value' end,
        'recordId', case when bucket_more[bucket] then bucket_last_ids[bucket]
          else last_examined_record_id end
      );
    end if;
    if bucket_first_ids[bucket] is not null then
      opposite_value := pg_catalog.jsonb_build_object(
        'sort', p_plan -> 'cursorSort',
        'sortKey', bucket_first_keys[bucket],
        'phase', case when pg_catalog.jsonb_array_length(bucket_first_keys[bucket]) > 0
          and bucket_first_keys[bucket] -> 0 = 'null'::jsonb then 'null' else 'value' end,
        'recordId', bucket_first_ids[bucket]
      );
    end if;
    if direction = 'backward' and bucket_counts[bucket] > 1 then
      select pg_catalog.jsonb_agg(item.value order by item.ordinality desc)
      into rows_value
      from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
    end if;
    pages := pages || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'rows', rows_value, 'next', next_value, 'opposite', opposite_value));
  end loop;
  -- The scanned pages and the one page decision a later scan or tree read of this invocation reuses.
  return pg_catalog.jsonb_build_object(
    'outcome', 'scanned',
    'pages', pages,
    'decision', pg_catalog.jsonb_build_object(
      'checked', page_eligibility_checked, 'firstLoaded', page_first_loaded, 'declaration', page_declaration,
      'eligibility', page_eligibility, 'shared', page_shared, 'narrowed', page_narrowed,
      'validatedRecordTypes', validated_record_types)
  );
end
$function$;

alter function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb) is
  'Adapter-only candidate scan of every Module query page read: runs the planned scan of one organisation''s active records (application scope, access predicate, pushed filter, the mode''s stored-value predicate, keyset segment, search pre-predicate) within a 500-candidate budget, decides each candidate through the exact read_record projection with batched page decisions, then admits it only when every filtered field is readable, the closed membership value matches its readable values (all rows, a board column classified from its readable choice value, a generic group equal to its typed selector, the children of one parent, or the roots, decided from exact batched parent reads) and the search matches a readable searchable field. It returns one page per bucket with per-row capabilities and its own keyset continuations, never a hidden value.';

create or replace function vortex_record.prepare_base_record_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  context_value jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  projection jsonb;
  decision jsonb;
  bounds jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', effective_command_id, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_id_value
      );
    end if;
    projection := (vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    )) -> 'record';
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (preview_installation is not null and meta ? 'recordType'
      and meta -> 'recordType' ? 'systemProjection') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  -- Ordinary saves require the explicit operation; named actions use their own preparation.
  if not coalesce((meta #> '{recordType,standardActions}') ? p_operation, false) then
    raise log 'Record save preparation refused: standard operation % is not declared', p_operation;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'correlationId', correlation_id_value
    );
  end if;
  if meta -> 'recordType' ? 'systemProjection' then
    if p_operation <> 'update'
      or meta #>> '{recordType,systemProjection,protectedView}' <>
        'organization_runtime_settings'
      or not coalesce(
        (meta #> '{recordType,standardActions}') ? 'update', false
      )
      or not vortex_definition.is_platform_system_module_internal(
        (meta ->> 'moduleRootId')::uuid, organization_id_value
      )
      or p_record_id is distinct from
        (meta -> 'context' ->> 'organizationId')::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;

    -- Do not execute application before-save rules for this projection until
    -- the platform settings-manage permission has passed its own current check.
    if not vortex_access.organization_runtime_settings_manage_is_current() then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;

    -- The writable system projection is prepared through its protected read
    -- model. Its final write remains inside apply_record_changes.
    loaded := (vortex_record.load_record_access_facts_internal(
      'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id
      ))
    ) -> 0);
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if preview_installation is null then
      decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'declaration', loaded -> 'declaration',
          'recordId', p_record_id,
          'facts', loaded -> 'facts'
        )
      )) -> 0);
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.decide_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'recordType', meta -> 'recordType',
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        (meta ->> 'moduleRootId')::uuid,
        (meta ->> 'moduleReleaseRevision')::bigint,
        p_record_type_id
      ),
      'correlationId', correlation_id_value,
      'readableFieldIds', bounds -> 'readableFieldIds',
      'existingValues', loaded -> 'fieldValues'
    );
  end if;

  if p_operation = 'update' then
    loaded := (vortex_record.load_record_access_facts_internal(
      'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id,
        'expectedConcurrencyNumber', p_expected_concurrency_number
      ))
    ) -> 0);
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if loaded ? 'previewInstallationId' then
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    else
      decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'declaration', loaded -> 'declaration',
          'recordId', p_record_id,
          'facts', loaded -> 'facts'
        )
      )) -> 0);
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.decide_record_field_bounds_internal(decision);
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- The owning Module release's BeforeSave flows for this record type, run by Record.
    'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'correlationId', meta -> 'context' -> 'correlationId',
    'readableFieldIds', case when p_operation = 'update'
      then bounds -> 'readableFieldIds' else '[]'::jsonb end,
    'existingValues', case when p_operation = 'update'
      then loaded -> 'fieldValues' else '{}'::jsonb end
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Record save preparation refused: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_request;
comment on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Server-only operation-scoped preparation read for one exact active installed or owner-validated preview base Record save.';

create or replace function vortex_record.prepare_named_action_command_totals(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_creations jsonb,
  p_activity_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid
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
  context_application_id uuid;
  catalogue jsonb;
  root_type jsonb;
  creation_count integer;
  before_closure jsonb;
  after_closure jsonb;
  link_targets jsonb;
  lock_plan jsonb;
  lock_entry jsonb;
  locked_value jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  source_field_id text;
  proposed_target jsonb;
  creation jsonb;
  rule_module_root_id uuid;
  rule_release_revision bigint;
  access_loaded jsonb;
  access_decision jsonb;
  parent_read jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object'
    or pg_catalog.jsonb_typeof(coalesce(p_creations, '[]'::jsonb)) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  creation_count := pg_catalog.jsonb_array_length(coalesce(p_creations, '[]'::jsonb));
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;
  -- A set-only action still uses the terminal writer's total probe. A command
  -- with creations carries the exact release's BeforeSave flows for every closure record
  -- to the existing Record evaluator before any row is written.
  if creation_count = 0
    and coalesce((catalogue ->> 'hasBeforeSaveFlows')::boolean, false) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  -- Authorize the subject without a row lock before discovering or locking any
  -- concrete dependency, through the installed named declaration. Executing a
  -- permitted action still requires no ordinary read or update authority.
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, null
  );
  if access_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(access_loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if (access_loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  access_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', access_loaded -> 'declaration',
      'recordId', p_record_id,
      'facts', access_loaded -> 'facts'
    )
  )) -> 0);
  if access_decision ->> 'outcome' <> 'allowed' then
    perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
    return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
  end if;
  access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);

  before_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  link_targets := vortex_record.named_action_command_link_targets_internal(
    catalogue, p_record_type_id, p_submitted_values, p_creations
  );
  if before_closure is null or link_targets is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;

  -- One canonical row pass over the union of closure records (`for update`) and
  -- concrete link targets (`for share`). Taking both here, in one ascending
  -- concrete identity order, is what keeps a later `for share` inside the edge
  -- writer from queueing behind an exclusive waiter while this command already
  -- holds a resource that waiter needs.
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'storageContractId', grouped.storage_contract_id,
      'recordId', grouped.record_id,
      'recordTypeId', grouped.record_type_id,
      'mode', case when grouped.exclusive then 'update' else 'share' end
    ) order by grouped.storage_contract_id, grouped.record_id
  ), '[]'::jsonb)
  into lock_plan
  from (
    select entry.storage_contract_id, entry.record_id, entry.record_type_id,
      pg_catalog.bool_or(entry.exclusive) as exclusive
    from (
      select (item.value ->> 'storageContractId')::uuid as storage_contract_id,
        (item.value ->> 'recordId')::uuid as record_id,
        (item.value ->> 'recordTypeId')::uuid as record_type_id,
        true as exclusive
      from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
      where item.value ? 'recordId'
      union all
      select (item.value ->> 'storageContractId')::uuid,
        (item.value ->> 'recordId')::uuid,
        (item.value ->> 'recordTypeId')::uuid,
        false
      from pg_catalog.jsonb_array_elements(link_targets) item(value)
    ) entry
    group by entry.storage_contract_id, entry.record_id, entry.record_type_id
  ) grouped;

  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(lock_plan) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if lock_entry ->> 'mode' = 'update' then
      locked_value := vortex_record.relationship_total_record_snapshot_internal(
        catalogue, (lock_entry ->> 'recordTypeId')::uuid,
        (lock_entry ->> 'recordId')::uuid, true
      );
      if locked_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'restart');
      end if;
    elsif not vortex_record.share_lock_named_action_target_internal(
      catalogue, (lock_entry ->> 'recordTypeId')::uuid, (lock_entry ->> 'recordId')::uuid
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  -- A creation's link target is an ordinary record and keeps the ordinary read
  -- requirement. Deciding it here, under the lock and before any write, turns
  -- an unreadable target into a clean refusal instead of a late rollback. The
  -- command's own subject is excluded: the named authority decided above is
  -- sufficient for it, and requiring ordinary read would contradict that authority.
  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(link_targets) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if (lock_entry ->> 'recordTypeId')::uuid = p_record_type_id
      and (lock_entry ->> 'recordId')::uuid = p_record_id then
      continue;
    end if;
    target_loaded := (vortex_record.load_record_access_facts_internal(
      'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', (lock_entry ->> 'recordTypeId')::uuid,
        'recordId', (lock_entry ->> 'recordId')::uuid
      ))
    ) -> 0);
    if target_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
    target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', target_loaded -> 'declaration',
        'recordId', (lock_entry ->> 'recordId')::uuid,
        'facts', target_loaded -> 'facts'
      )
    )) -> 0);
    if target_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  after_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  if after_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if access_loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  access_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', access_loaded -> 'declaration',
      'recordId', p_record_id,
      'facts', access_loaded -> 'facts'
    )
  )) -> 0);
  if access_decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);

  -- `not_required` is decided over the union of the subject type and every
  -- creation target type, and only after the locks above, so a command that
  -- needs no total still acquires its resources in the canonical order.
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    join pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
      on true
    where field.value ->> 'type' = 'total'
  ) and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where pg_catalog.jsonb_array_length(
      coalesce(item.value -> 'recordType' -> 'relationships', '[]'::jsonb)
    ) > 0
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    begin
      select storage.module_root_id into strict rule_module_root_id
      from vortex_record.storage_catalogue storage
      where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
        and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
        and storage.state = 'active';
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_STORAGE_LOOKUP_FAILED',
          detail = pg_catalog.format('storage=%s type=%s cause=%s',
            prepared_record ->> 'storageContractId',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    begin
      select (item.value ->> 'moduleReleaseRevision')::bigint
        into strict rule_release_revision
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where (item.value ->> 'recordTypeId')::uuid =
        (prepared_record ->> 'recordTypeId')::uuid;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('type=%s cause=%s',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    if prepared_record ->> 'recordKey' <> 'root' and prepared_record ? 'recordId' then
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid,
        (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    else
      parent_read := null;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', prepared_record ->> 'recordKey' = 'root'
        or not (prepared_record ? 'recordId')
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        rule_module_root_id,
        rule_release_revision,
        (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      source_records := '[]'::jsonb;
      if prepared_record ? 'recordId' then
        for edge_value in
          select edge.* from vortex_record.relationship_edges edge
          where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
            and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
            and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
            and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
            and edge.from_organisation_id = context_organization_id
            and edge.to_organisation_id = context_organization_id
            and edge.from_application_root_id is not distinct from case
              when source_type ->> 'storageScope' = 'application_contained'
                then context_application_id else null end
            and edge.to_application_root_id is not distinct from case
              when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
                then context_application_id else null end
          order by edge.from_storage_contract_id, edge.from_record_id
        loop
          source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, false
          );
          if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then
            return pg_catalog.jsonb_build_object('outcome', 'restart');
          end if;
          select item.value ->> 'recordKey' into source_key
          from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
          where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
            and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'fieldValues', source_snapshot -> 'existingValues'
            ) || case when source_key is null then '{}'::jsonb
              else pg_catalog.jsonb_build_object('recordKey', source_key) end
          );
        end loop;
      end if;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then
          proposed_target := p_submitted_values -> source_field_id;
        end if;
        source_records := coalesce((
          select pg_catalog.jsonb_agg(item.value order by item.ordinality)
          from pg_catalog.jsonb_array_elements(source_records) with ordinality item(value, ordinality)
          where item.value ->> 'recordKey' is distinct from 'root'
        ), '[]'::jsonb);
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and proposed_target ->> 'recordTypeId' = prepared_record ->> 'recordTypeId'
          and proposed_target ->> 'recordId' = prepared_record ->> 'recordId' then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('recordKey', 'root', 'fieldValues', '{}'::jsonb)
          );
        end if;
      end if;

      -- Each creation that links to this parent through this relationship joins
      -- its membership. A created record has no edges yet, so nothing is
      -- removed; the evaluator substitutes its computed values by record key.
      for creation in
        select item.value
        from pg_catalog.jsonb_array_elements(coalesce(p_creations, '[]'::jsonb))
          with ordinality item(value, ordinality)
        order by item.ordinality
      loop
        if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') <>
          pg_catalog.lower((creation ->> 'recordTypeId')::uuid::text) then
          continue;
        end if;
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        proposed_target := creation -> 'values' -> source_field_id;
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and pg_catalog.lower(proposed_target ->> 'recordTypeId') =
            pg_catalog.lower(prepared_record ->> 'recordTypeId')
          and pg_catalog.lower(proposed_target ->> 'recordId') =
            pg_catalog.lower(prepared_record ->> 'recordId') then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'recordKey', 'create:' || (creation ->> 'ordinal'),
              'fieldValues', '{}'::jsonb
            )
          );
        end if;
      end loop;

      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', access_bounds -> 'readableFieldIds',
    'records', prepared_records
  );
exception
  when check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) to vortex_request;
comment on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) is
  'Private named-action command preflight: one merged total closure over the subject and every creation, locked once in canonical concrete identity order. Writes nothing.';

create or replace function vortex_record.prepare_named_action_relationship_copies_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_subject_record_type_id uuid,
  p_subject_record_id uuid,
  p_inputs jsonb,
  p_action_context jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  action_context jsonb;
  subject_meta jsonb;
  loaded jsonb;
  decision jsonb;
  readable_field_ids jsonb;
  catalogue jsonb;
  change_value jsonb;
  task_ordinal bigint;
  input_candidate jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_concurrency bigint;
  relationship_text text;
  relationship_value jsonb;
  edge_row record;
  existing_row record;
  edge_type_id uuid;
  planned_keys text[] := array[]::text[];
  copies jsonb := '[]'::jsonb;
  lock_row record;
begin
  if p_subject_record_type_id is null or p_subject_record_id is null
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Relationship copy is invalid';
  end if;
  -- The caller resolved this exact installed action once for its whole step.
  action_context := p_action_context;
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(
      action_context -> 'action' -> 'tasks'
    ) item(value)
    where item.value ->> 'type' = 'record.changes'
  ) then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  subject_meta := vortex_record.resolve_record_action_context_internal(
    p_subject_record_type_id, 'update'
  );

  -- What the actor can currently read of the subject under this named action.
  -- The subject is authorised by the installed action, never by ordinary
  -- update authority, exactly as its own writer decides it.
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_subject_record_type_id, p_subject_record_id, null
  );
  if loaded ->> 'outcome' is distinct from 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', loaded -> 'declaration',
      'recordId', p_subject_record_id,
      'facts', loaded -> 'facts'
    )
  )) -> 0);
  if decision ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  readable_field_ids := vortex_record.decide_record_field_bounds_internal(decision)
    -> 'readableFieldIds';
  if pg_catalog.jsonb_typeof(readable_field_ids) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'Relationship copy field bounds are unavailable';
  end if;

  -- Discover every target and copy first, then lock: a target row lock is the
  -- first lock class, so it is taken as soon as the target is known.
  for change_value, task_ordinal in
    select change.value, task.ordinality
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks')
      with ordinality as task(value, ordinality)
    cross join lateral pg_catalog.jsonb_array_elements(
      task.value -> 'properties' -> 'changes'
    ) with ordinality as change(value, ordinality)
    where task.value ->> 'type' = 'record.changes'
    order by task.ordinality, change.ordinality
  loop
    -- The target is the declared `record_reference` input's record link, the
    -- one value shape that input accepts.
    input_candidate := p_inputs -> (change_value ->> 'targetInputKey');
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'inputs') item(value)
      where item.value ->> 'key' = change_value ->> 'targetInputKey'
        and item.value ->> 'type' = 'record_reference'
    ) or pg_catalog.jsonb_typeof(input_candidate) is distinct from 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;
    if not (input_candidate ?& array['recordTypeId', 'recordId'])
      or input_candidate - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
      or not coalesce(pg_catalog.pg_input_is_valid(input_candidate ->> 'recordTypeId', 'uuid'), false)
      or not coalesce(pg_catalog.pg_input_is_valid(input_candidate ->> 'recordId', 'uuid'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;
    target_type_id := (input_candidate ->> 'recordTypeId')::uuid;
    target_record_id := (input_candidate ->> 'recordId')::uuid;
    -- The copied relationships are the subject's own, so only another record of
    -- the subject's record type can hold them.
    if target_type_id <> p_subject_record_type_id
      or target_record_id = p_subject_record_id then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable'
      );
    end if;

    -- L1: the target row, exclusively, before any linked row or edge identity.
    target_concurrency := null;
    execute pg_catalog.format(
      'select stored.concurrency_number from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      subject_meta ->> 'table'
    ) into target_concurrency using organization_id_value, target_record_id;
    if target_concurrency is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable'
      );
    end if;

    for relationship_text in
      select distinct pg_catalog.lower(item.value #>> '{}')
      from pg_catalog.jsonb_array_elements(change_value -> 'relationshipIds') item(value)
      order by 1
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(
        action_context -> 'recordType' -> 'relationships'
      ) item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') = relationship_text
        and pg_catalog.lower(item.value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_subject_record_type_id::text);
      if relationship_value is null
        or relationship_value ->> 'cardinality' is distinct from 'many_to_one'
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements_text(readable_field_ids) readable(value)
          where pg_catalog.lower(readable.value) =
            pg_catalog.lower(relationship_value ->> 'fromFieldId')
        )
        -- The plan copies the subject's edge as it stands before this command
        -- writes the subject, which is only the authored order's edge when no
        -- earlier record.set_fields task sets that same link.
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks')
            with ordinality as earlier(value, ordinality)
          cross join lateral pg_catalog.jsonb_object_keys(
            earlier.value -> 'properties' -> 'values'
          ) key(field_key)
          where earlier.ordinality < task_ordinal
            and earlier.value ->> 'type' = 'record.set_fields'
            and pg_catalog.lower(key.field_key) =
              pg_catalog.lower(relationship_value ->> 'fromFieldId')
        ) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_copy_unavailable'
        );
      end if;

      catalogue := coalesce(catalogue, vortex_record.relationship_total_catalogue_internal());
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') type_item(value)
        cross join pg_catalog.jsonb_array_elements(type_item.value -> 'fields') field_item(value)
        where field_item.value ->> 'type' = 'total'
          and pg_catalog.lower(field_item.value #>> '{settings,relationshipId}') = relationship_text
      ) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;

      -- Two changes may name the same target and relationship; it is copied once.
      if (target_record_id::text || ':' || relationship_text) = any (planned_keys) then
        continue;
      end if;
      planned_keys := pg_catalog.array_append(
        planned_keys, target_record_id::text || ':' || relationship_text
      );

      select edge.to_storage_contract_id, edge.to_record_id into edge_row
      from vortex_record.relationship_edges as edge
      where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
        and edge.from_organisation_id = organization_id_value
        and edge.from_storage_contract_id = (subject_meta ->> 'storageContractId')::uuid
        and edge.from_record_id = p_subject_record_id;
      -- A relationship the subject has not set has nothing to copy.
      if not found then continue; end if;
      select catalogue_row.record_type_id into edge_type_id
      from vortex_record.storage_catalogue as catalogue_row
      where catalogue_row.storage_contract_id = edge_row.to_storage_contract_id;
      if edge_type_id is null
        or not vortex_record.relationship_declares_target_internal(
          relationship_value, edge_type_id
        ) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_copy_unavailable'
        );
      end if;

      select edge.to_storage_contract_id, edge.to_record_id into existing_row
      from vortex_record.relationship_edges as edge
      where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
        and edge.from_organisation_id = organization_id_value
        and edge.from_storage_contract_id = (subject_meta ->> 'storageContractId')::uuid
        and edge.from_record_id = target_record_id;
      if found then
        -- Never delete or re-point an existing edge: the same edge is already
        -- the desired state, any other refuses the whole command.
        if existing_row.to_storage_contract_id = edge_row.to_storage_contract_id
          and existing_row.to_record_id = edge_row.to_record_id then
          continue;
        end if;
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_copy_would_replace'
        );
      end if;

      copies := copies || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'targetRecordTypeId', target_type_id,
        'targetRecordId', target_record_id,
        'relationshipId', (relationship_value ->> 'relationshipId')::uuid,
        'fromFieldId', (relationship_value ->> 'fromFieldId')::uuid,
        'value', pg_catalog.jsonb_build_object(
          'recordTypeId', edge_type_id, 'recordId', edge_row.to_record_id
        )
      ));
    end loop;
  end loop;

  -- Every linked row's share lock, in one canonical order, still ahead of
  -- every counter, data version and edge identity.
  for lock_row in
    select distinct
      (copy.value #>> '{value,recordTypeId}')::uuid as record_type_id,
      (copy.value #>> '{value,recordId}')::uuid as record_id
    from pg_catalog.jsonb_array_elements(copies) copy(value)
    order by 1, 2
  loop
    perform vortex_record.lock_relationship_target_row_internal(
      lock_row.record_type_id, lock_row.record_id, organization_id_value
    );
  end loop;

  return pg_catalog.jsonb_build_object('outcome', 'planned', 'copies', copies);
end
$function$;

alter function vortex_record.prepare_named_action_relationship_copies_internal(text,uuid,bigint,uuid,uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_relationship_copies_internal(
  text, uuid, bigint, uuid, uuid, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_named_action_relationship_copies_internal(
  text, uuid, bigint, uuid, uuid, uuid, jsonb, jsonb
) to vortex_record_adapter;
comment on function vortex_record.prepare_named_action_relationship_copies_internal(
  text, uuid, bigint, uuid, uuid, uuid, jsonb, jsonb
) is
  'Private named-action step: re-derives every record.changes task from the installed action its caller resolved and the supplied inputs, locks every target row and then every linked row in canonical order before any counter, data version or edge identity, and plans only the selected, declared, readable many-to-one subject edges the target does not already hold. Returns null when the action has no such task, a refused outcome for a request it cannot honour, and raises only on a broken invariant.';

create or replace function vortex_record.prepare_named_action_set_announce_internal(
  p_preview boolean,
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_inputs jsonb,
  p_activity_id uuid,
  p_read_loaded jsonb,
  p_action_context jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt_claim jsonb;
  action_context jsonb;
  creation_plan jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  projection jsonb;
  copy_plan jsonb;
  copy_targets jsonb := '[]'::jsonb;
  copy_target record;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  record_type_meta jsonb;
  reused_read_facts boolean := false;
begin
  if p_preview is null or p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'named_action', p_command_id, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    projection := vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
    -- A deleting action's subject is soft-deleted, so it cannot be
    -- projected; its replay is the delete's own stored outcome.
    if projection ->> 'outcome' <> 'completed' then
      projection := coalesce(
        vortex_record.named_action_deleted_subject_replay_internal(
          p_command_id, p_action_owner_kind, p_action_owner_id,
          p_action_release_revision, p_action_id, p_record_type_id
        ),
        projection
      );
    end if;
    if projection ->> 'outcome' <> 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    return projection;
  end if;

  -- The context depends only on the action and the record type: a page that previews
  -- one action for many records resolves it once and passes it here; null resolves it now.
  action_context := coalesce(p_action_context, vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  ));
  if pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
    or pg_catalog.jsonb_array_length(action_context -> 'action' -> 'tasks') not between 1 and 10
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(
        action_context -> 'action' -> 'tasks'
      ) item(value)
      where item.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
    ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  creation_plan := vortex_record.named_action_creation_plan_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, null, action_context
  );
  if creation_plan ->> 'outcome' <> 'planned' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- A preview of a record its caller has just read in this invocation reuses
  -- that read's facts when they are exactly the facts the named loader would
  -- build: the record alone, with no inherited owner, no edge and no
  -- relationship route on any of the action's permissions. Only the fixed
  -- record adapter can pass them; the action's own decision is still made below.
  record_type_meta := p_read_loaded -> 'recordTypeMeta';
  if p_preview and p_read_loaded ->> 'outcome' = 'loaded'
    and not (p_read_loaded ? 'previewInstallationId')
    and (p_read_loaded ->> 'isSystemProjection')::boolean is false
    and p_read_loaded -> 'context' = context_value
    and pg_catalog.jsonb_typeof(record_type_meta) = 'object'
    and pg_catalog.lower(record_type_meta ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and coalesce(record_type_meta ->> 'ownershipMode', '') <> 'inherited'
    and p_read_loaded #> '{facts,binding}' = action_context #> '{declaration,recordBinding}'
    and pg_catalog.jsonb_array_length(p_read_loaded #> '{facts,records}') = 1
    and p_read_loaded #>> '{facts,records,0,recordScope,recordId}' = pg_catalog.lower(p_record_id::text)
    and p_read_loaded #> '{facts,edges}' = '[]'::jsonb
    and pg_catalog.jsonb_typeof(action_context #> '{declaration,requiredPermissions}') = 'array'
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(action_context #> '{declaration,requiredPermissions}') as required(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_read_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes') = 'array'
          then p_read_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes'
          else '[{"kind": "relationship"}]'::jsonb end
      ) as route(value)
      where route.value ->> 'kind' = 'relationship'
    ) then
    loaded := pg_catalog.jsonb_build_object(
      'outcome', 'loaded',
      'declaration', action_context -> 'declaration',
      'facts', p_read_loaded -> 'facts',
      'concurrencyNumber', p_read_loaded -> 'concurrencyNumber',
      'fieldValues', p_read_loaded -> 'fieldValues'
    );
    reused_read_facts := true;
  else
    loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id,
      case when p_preview then null else p_expected_concurrency_number end
    );
  end if;
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  if p_preview and (loaded ->> 'concurrencyNumber')::bigint <>
      p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- Read facts reused above keep the record types their read decision
  -- validated in this invocation; the named loader's own facts are validated in full.
  decision := vortex_access.evaluate_record_access_with_validated_types_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts', null,
    case when reused_read_facts then loaded #> '{facts,recordTypes}' end
  );
  if decision ->> 'outcome' <> 'allowed' then
    if p_preview then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused_recorded', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  -- Use the same locked copy plan the writer re-derives. Only rows with an
  -- actual new edge are evaluated; a no-op copy does not save its target.
  copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_inputs, action_context
  );
  if copy_plan ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  for copy_target in
    select (item.value ->> 'targetRecordId')::uuid as record_id,
      pg_catalog.jsonb_object_agg(
        item.value ->> 'fromFieldId', item.value -> 'value'
      ) as submitted_values
    from pg_catalog.jsonb_array_elements(
      coalesce(copy_plan -> 'copies', '[]'::jsonb)
    ) item(value)
    group by 1
    order by 1
  loop
    target_meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    target_loaded := (vortex_record.load_record_access_facts_internal(
      'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', copy_target.record_id
      ))
    ) -> 0);
    if target_loaded ->> 'outcome' is distinct from 'loaded' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', target_meta -> 'declaration',
        'recordId', copy_target.record_id,
        'facts', (target_loaded -> 'facts') || pg_catalog.jsonb_build_object( 'binding', target_meta -> 'declaration' -> 'recordBinding' )
      )
    )) -> 0);
    if target_decision ->> 'outcome' is distinct from 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(copy_target.submitted_values) field_id
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements_text(
          vortex_record.decide_record_field_bounds_internal(target_decision)
            -> 'changeableFieldIds'
        ) allowed(value)
        where pg_catalog.lower(allowed.value) = pg_catalog.lower(field_id)
      )
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    copy_targets := copy_targets || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordId', copy_target.record_id,
        'existingValues', target_loaded -> 'fieldValues',
        'submittedValues', copy_target.submitted_values
      )
    );
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', case when p_preview then 'previewed' else 'prepared' end,
    'action', action_context -> 'action',
    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',
    -- The owning Module release's rules for the subject, evaluated by Record.
    'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
      (action_context ->> 'moduleRootId')::uuid,
      (action_context ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'createTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'ordinal', item.value -> 'ordinal',
          'recordTypeId', item.value -> 'recordTypeId',
          'recordType', item.value -> 'recordType',
          'beforeSaveFlows', item.value -> 'beforeSaveFlows'
        ) order by (item.value ->> 'ordinal')::integer
      )
      from pg_catalog.jsonb_array_elements(creation_plan -> 'createTargets') item(value)
    ), '[]'::jsonb),
    'copyTargets', copy_targets,
    'recordId', p_record_id,
    'existingValues', loaded -> 'fieldValues',
    -- A singleton required permission was decided by the named-action access
    -- check above. The Record port may use it for a choice gated by that exact
    -- permission; a multi-permission declaration grants no such shortcut.
    'singleRequiredPermissionId', case
      when pg_catalog.jsonb_array_length(
        loaded #> '{declaration,requiredPermissions}'
      ) = 1 then loaded #> '{declaration,requiredPermissions,0,permissionId}'
      else 'null'::jsonb
    end,
    'readableFieldIds', bounds -> 'readableFieldIds',
    'changeableFieldIds', bounds -> 'changeableFieldIds',
    'eventDescriptors', action_context -> 'eventDescriptors',
    'actorOrganizationAccountId', context_value -> 'organizationAccountId',
    'correlationId', context_value -> 'correlationId'
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid, jsonb, jsonb
) is
  'Private named-action preparation: replays or refuses by command receipt, then returns the facts, permission decision and bounds of the exact installed action, writing nothing; a preview may reuse the read facts its fixed adapter caller loaded for the same record in this invocation when they are exactly the facts the named loader would build.';

create or replace function vortex_record.prepare_relationship_total_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
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
  catalogue jsonb;
  root_type jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  locked_value jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  source_field_id text;
  proposed_target jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  access_loaded jsonb;
  access_decision jsonb;
  parent_read jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
  rule_module_root_id uuid;
  rule_release_revision bigint;
begin
  if p_operation not in ('create', 'update')
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'update' and p_selected_group_id is not null)
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  -- Receipt resolution remains owned by prepare_base_record_save. Merely seeing
  -- an existing identity here avoids dependency reads or locks on replays and
  -- changed-input duplicates.
  if vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(root_type -> 'fields') field(value)
    where field.value ->> 'type' = 'total'
  ) and pg_catalog.jsonb_array_length(root_type -> 'relationships') = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

  -- Authorize the old source without a row lock before discovering or locking
  -- any concrete dependency. A denied update is deferred to the base prepare,
  -- which owns the existing content-free refusal Activity.
  if p_operation = 'update' then
    access_loaded := (vortex_record.load_record_access_facts_internal(
      'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id
      ))
    ) -> 0);
    if access_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(access_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'defer');
    end if;
    if (access_loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    access_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', access_loaded -> 'declaration',
        'recordId', p_record_id,
        'facts', access_loaded -> 'facts'
      )
    )) -> 0);
    if access_decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[context_organization_id]::uuid[], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);
  end if;

  before_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if before_closure is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;
  -- Dynamic physical rows are locked in one canonical concrete identity order.
  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid,
      (item.value ->> 'recordId')::uuid
  loop
    locked_value := vortex_record.relationship_total_record_snapshot_internal(
      catalogue,
      (record_value ->> 'recordTypeId')::uuid,
      (record_value ->> 'recordId')::uuid,
      true
    );
    if locked_value is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  end loop;

  after_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if after_closure is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  -- A concurrent exact or changed-input duplicate may have completed while
  -- this transaction waited for the source/parent locks. Let the existing
  -- receipt owner distinguish replay from command-identity conflict.
  if vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if p_operation = 'update' and (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;

  if p_operation = 'update' then
    access_loaded := (vortex_record.load_record_access_facts_internal(
      'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id,
        'expectedConcurrencyNumber', p_expected_concurrency_number
      ))
    ) -> 0);
    if access_loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', access_loaded -> 'declaration',
        'recordId', p_record_id,
        'facts', access_loaded -> 'facts'
      )
    )) -> 0);
    if access_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);
  end if;

  -- Materialize only the declared aggregate sources for each locked affected
  -- record. The initial source's proposed move replaces its old membership in
  -- this transaction-visible snapshot.
  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    begin
      select storage.module_root_id into strict rule_module_root_id
      from vortex_record.storage_catalogue storage
      where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
        and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
        and storage.state = 'active';
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_STORAGE_LOOKUP_FAILED',
          detail = pg_catalog.format('storage=%s type=%s cause=%s',
            prepared_record ->> 'storageContractId',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    begin
      select (item.value ->> 'moduleReleaseRevision')::bigint
        into strict rule_release_revision
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where (item.value ->> 'recordTypeId')::uuid =
        (prepared_record ->> 'recordTypeId')::uuid;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('type=%s cause=%s',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    if prepared_record ->> 'recordKey' <> 'root' then
      -- Use the established exact-record read path while the parent is locked.
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid,
        (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    else
      parent_read := null;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', prepared_record ->> 'recordKey' = 'root'
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        rule_module_root_id, rule_release_revision,
        (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      source_records := '[]'::jsonb;
      for edge_value in
        select edge.* from vortex_record.relationship_edges edge
        where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
          and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
          and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
          and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
          and edge.from_organisation_id = context_organization_id
          and edge.to_organisation_id = context_organization_id
          and edge.from_application_root_id is not distinct from case
            when source_type ->> 'storageScope' = 'application_contained'
              then context_application_id else null end
          and edge.to_application_root_id is not distinct from case
            when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
              then context_application_id else null end
        order by edge.from_storage_contract_id, edge.from_record_id
      loop
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
          edge_value.from_record_id, false
        );
        if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
        select item.value ->> 'recordKey' into source_key
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
          and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'fieldValues', source_snapshot -> 'existingValues'
          ) || case when source_key is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', source_key) end
        );
      end loop;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then proposed_target := p_submitted_values -> source_field_id; end if;
        source_records := coalesce((
          select pg_catalog.jsonb_agg(item.value order by item.ordinality)
          from pg_catalog.jsonb_array_elements(source_records) with ordinality item(value, ordinality)
          where item.value ->> 'recordKey' is distinct from 'root'
        ), '[]'::jsonb);
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and proposed_target ->> 'recordTypeId' = prepared_record ->> 'recordTypeId'
          and proposed_target ->> 'recordId' = prepared_record ->> 'recordId' then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('recordKey', 'root', 'fieldValues', '{}'::jsonb)
          );
        end if;
      end if;
      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', access_bounds -> 'readableFieldIds',
    'records', prepared_records
  );
exception
  when check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_request;
comment on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Private Stage 2B preflight: discovers old/proposed concrete total closure, locks it canonically, re-reads it, and returns only declared evaluator inputs.';

CREATE OR REPLACE FUNCTION vortex_record.project_named_action_record_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, null
  );
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', loaded -> 'declaration',
      'recordId', p_record_id,
      'facts', loaded -> 'facts'
    )
  )) -> 0);
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') item(value)
  loop
    if loaded -> 'columns' ? field_id and loaded -> 'fieldValues' ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, loaded -> 'fieldValues' -> field_id
      );
    end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed', 'recordId', p_record_id,
    'concurrencyNumber', loaded -> 'concurrencyNumber',
    'values', values_value,
    'correlationId', loaded -> 'context' -> 'correlationId',
    'backgroundDelivery', 'pending', 'replayed', true
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$$;
alter function vortex_record.project_named_action_record_internal(text,uuid,bigint,uuid,uuid,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.project_named_action_record_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid) FROM PUBLIC;

create or replace function vortex_record.read_attachment_upload_authority(
  p_record_type_id uuid, p_record_id uuid, p_field_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  field_value jsonb;
  eligible jsonb;
begin
  -- Live uploads cannot escape into preview storage. A create admission is provisional:
  -- the final proposed record must still pass the ordinary create writer at Save.
  if vortex_record.read_current_preview_installation_internal() is not null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, case when p_record_id is null then 'create' else 'update' end
  );
  if meta ->> 'outcome' = 'refused' or meta -> 'declaration' is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') item(value)
  where (item.value ->> 'fieldId')::uuid = p_field_id
    and item.value ->> 'type' = 'attachment';
  if not found then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
  if p_record_id is null then
    eligible := vortex_access.evaluate_organization_record_permission_eligibility_internal(
      meta -> 'declaration', context_value, pg_catalog.clock_timestamp()
    );
    if eligible ->> 'outcome' is distinct from 'eligible' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(pg_catalog.jsonb_build_object(
      'outcome', 'allowed', 'organizationId', context_value -> 'organizationId',
      'matchedContributions', eligible -> 'eligiblePermissions'
    ));
  else
    loaded := (vortex_record.load_record_access_facts_internal(
      'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id
      ))
    ) -> 0);
    if loaded ->> 'outcome' is distinct from 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', loaded -> 'declaration',
        'recordId', p_record_id,
        'facts', loaded -> 'facts'
      )
    )) -> 0);
    if decision ->> 'outcome' is distinct from 'allowed' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  end if;
  if not coalesce(bounds -> 'readableFieldIds' @> pg_catalog.jsonb_build_array(p_field_id::text), false)
    or not coalesce(bounds -> 'changeableFieldIds' @> pg_catalog.jsonb_build_array(p_field_id::text), false) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed', 'sessionContext', context_value,
    'readableFieldIds', bounds -> 'readableFieldIds', 'changeableFieldIds', bounds -> 'changeableFieldIds',
    'attachmentSettings', field_value -> 'settings',
    'existingAttachmentCount', case when p_record_id is null then 0
      else coalesce(pg_catalog.jsonb_array_length(nullif(loaded -> 'fieldValues' -> p_field_id::text, 'null'::jsonb)), 0) end
  );
end
$function$;
alter function vortex_record.read_attachment_upload_authority(uuid,uuid,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.read_attachment_upload_authority(uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_attachment_upload_authority(uuid,uuid,uuid) to vortex_request, vortex_owner;

create or replace function vortex_record.read_record_batch_internal(
  p_record_type_id uuid,
  p_record_ids uuid[],
  p_preview boolean,
  p_storage_contract_id uuid,
  p_record_type_item jsonb
)
returns table (record_id uuid, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  batch_size constant integer := 201;
  record_count integer := coalesce(pg_catalog.cardinality(p_record_ids), 0);
  record_position integer;
  current_id uuid;
  page_shared jsonb;
  page_first_loaded jsonb;
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_narrowed boolean;
  page_batching boolean := true;
  validated_record_types jsonb;
  lookahead_ids uuid[];
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  read_row record;
begin
  -- The readable projection of every listed record, as read_record gives it, with the page's
  -- installation, access plan, eligibility and envelope loaded once from the first record and
  -- every record decided together, one set pass per batch, as a page read decides its rows.
  for record_position in 1..record_count loop
    current_id := p_record_ids[record_position];
    page_access_loaded := null;
    if record_position = 1 then
      page_shared := pg_catalog.jsonb_build_object(
        'installation', case when p_preview
          then vortex_record.read_current_preview_installation_internal()
          else vortex_definition.read_current_active_installation() end);
      page_shared := page_shared || pg_catalog.jsonb_build_object('plan',
        vortex_record.resolve_installation_access_plan_internal(page_shared -> 'installation'));
      page_access_loaded := (vortex_record.load_record_access_facts_with_plan_internal(
        'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', current_id
        )),
        page_shared -> 'installation', page_shared -> 'plan'
      ) -> 0);
      if page_access_loaded ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
        page_declaration := page_access_loaded -> 'declaration';
        if p_preview then
          page_shared := page_shared || pg_catalog.jsonb_build_object(
            'previewBounds', vortex_record.preview_record_field_bounds_internal(
              p_record_type_id, p_storage_contract_id, p_record_type_item));
        else
          page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
            page_declaration, vortex_access.validated_human_request_context(),
            pg_catalog.clock_timestamp()
          );
        end if;
        page_first_loaded := page_access_loaded;
        select page_shared || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
          page.narrowed
        into page_shared, page_narrowed
        from vortex_record.read_record_page_envelope_internal(p_record_type_id, page_first_loaded) as page;
      end if;
    end if;
    if page_batching and page_first_loaded is not null and not (current_id = any (decided_ids)) then
      lookahead_ids := p_record_ids[record_position:least(record_position + batch_size - 1, record_count)];
      select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
        pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
        pg_catalog.array_agg(decided.bounds)
      into decided_ids, decided_loaded, decided_decisions, decided_bounds
      from vortex_record.read_record_page_decisions_internal(
        p_record_type_id, page_first_loaded, page_declaration, page_eligibility,
        lookahead_ids, page_shared -> 'envelope', page_narrowed
      ) as decided;
      page_batching := pg_catalog.cardinality(decided_ids) > 0;
    end if;
    -- The first record keeps the exact decision, which also validates the installation-wide
    -- facts every decided record shares.
    decided_index := case when record_position > 1
      then pg_catalog.array_position(decided_ids, current_id) end;
    select row_read.* into read_row
    from vortex_record.read_record_projection_with_validated_types_internal(
      p_record_type_id, current_id, page_declaration, page_eligibility,
      validated_record_types, null,
      coalesce(decided_loaded[decided_index], page_access_loaded),
      decided_decisions[decided_index], decided_bounds[decided_index], page_shared
    ) as row_read;
    if validated_record_types is null and decided_index is null then
      validated_record_types := coalesce(
        read_row.read_facts -> 'validatedRecordTypes',
        case when read_row.projection ->> 'outcome' = 'allowed'
          then read_row.read_facts #> '{facts,recordTypes}' end
      );
    end if;
    record_id := current_id;
    result := read_row.projection;
    return next;
  end loop;
end
$function$;

alter function vortex_record.read_record_batch_internal(uuid,uuid[],boolean,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_batch_internal(uuid,uuid[],boolean,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_batch_internal(uuid,uuid[],boolean,uuid,jsonb) to vortex_owner;

comment on function vortex_record.read_record_batch_internal(uuid,uuid[],boolean,uuid,jsonb) is
  'Private batch record read for owner-side aggregation: returns each listed record''s readable projection exactly as read_record gives it, loading the installation, access plan, eligibility and page envelope once from the first record and deciding the records together, one set pass per batch of 201, through the page decision the paged query read uses.';

create or replace function vortex_record.read_record_capabilities_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_read_facts jsonb,
  p_read_bounds jsonb,
  p_action_meta jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  readable_field_ids jsonb := p_read_bounds -> 'readableFieldIds';
  meta jsonb;
  changeable_field_ids jsonb := '[]'::jsonb;
  actions text[] := array[]::text[];
  action_kind text;
  action_loaded jsonb;
  action_decision jsonb;
  update_bounds jsonb;
  read_declaration jsonb;
  permission_by_id jsonb;
  target_meta jsonb;
  required_permissions jsonb;
  simple_action boolean;
begin
  -- The row is already known readable: the caller passes the read facts and
  -- field bounds its read decision used. Simple action routes can use these
  -- facts; actions with a wider closure still load their writer's own facts.
  if p_read_facts ? 'previewInstallationId' then
    select coalesce(
      pg_catalog.jsonb_agg(projected.value order by projected.value), '[]'::jsonb
    )
    into changeable_field_ids
    from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        p_read_bounds -> 'changeableFieldIds'
      ) as changeable(value)
      where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
    );
    if pg_catalog.jsonb_array_length(changeable_field_ids) > 0 then
      actions := array['update'];
    end if;
    return pg_catalog.jsonb_build_object(
      'changeableFieldIds', changeable_field_ids,
      'actions', pg_catalog.to_jsonb(actions)
    );
  end if;

  if pg_catalog.jsonb_typeof(p_read_facts -> 'isSystemProjection') is distinct from 'boolean' then
    raise exception using errcode = '55000',
      message = 'Record capability metadata is unavailable';
  end if;
  -- Ordinary stored rows already passed the read loader's catalogue checks.
  -- Only a protected projection needs the extra action-context lookup.
  -- A page passes the context it resolved once for this record type.
  if (p_read_facts ->> 'isSystemProjection')::boolean then
    meta := coalesce(p_action_meta,
      vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read'));
  end if;
  if meta #>> '{recordType,systemProjection,protectedView}' =
      'organization_runtime_settings'
    and coalesce((meta #> '{recordType,standardActions}') ? 'update', false)
    and vortex_definition.is_platform_system_module_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta -> 'context' ->> 'organizationId')::uuid
    ) then
    if vortex_access.organization_runtime_settings_manage_is_current() then
      select coalesce(
        pg_catalog.jsonb_agg(projected.value order by projected.value), '[]'::jsonb
      )
      into changeable_field_ids
      from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
      join pg_catalog.jsonb_array_elements(meta #> '{recordType,fields}') as field(value)
        on pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(projected.value)
      where field.value ->> 'key' not in ('organization_id', 'revision')
        and field.value ->> 'type' not in (
          'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
          'attachment', 'calculation'
        );
      if pg_catalog.jsonb_array_length(changeable_field_ids) > 0 then
        actions := array['update'];
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'changeableFieldIds', changeable_field_ids,
      'actions', pg_catalog.to_jsonb(actions)
    );
  end if;

  -- The read loader has already checked this installation's access plan and
  -- pinned record type; use those exact permissions for the action declarations.
  -- An action whose routes use only this target row can reuse the read facts.
  -- Relationship routes and inherited ownership still use the action's own
  -- fact closure, so no source row or edge needed by the writer is omitted.
  read_declaration := p_read_facts -> 'declaration';
  permission_by_id := p_read_facts -> 'accessPermissions';
  target_meta := p_read_facts -> 'recordTypeMeta';
  if pg_catalog.jsonb_typeof(read_declaration) is distinct from 'object'
    or pg_catalog.jsonb_typeof(permission_by_id) is distinct from 'object'
    or pg_catalog.jsonb_typeof(target_meta) is distinct from 'object'
    or (target_meta ->> 'recordTypeId')::uuid is distinct from p_record_type_id
    or coalesce(target_meta ->> 'ownershipMode', '') not in
      ('none', 'organization_account', 'group')
    or read_declaration -> 'recordBinding' is distinct from
      pg_catalog.jsonb_build_object(
        'moduleRootId', target_meta -> 'moduleRootId',
        'recordTypeId', target_meta -> 'recordTypeId',
        'storageContractId', target_meta -> 'storageContractId',
        'storageScope', target_meta -> 'storageScope'
      ) then
    permission_by_id := null;
  end if;

  -- Every action still receives its own declaration and exact-record decision.
  -- A missing declaration contributes no action.
  foreach action_kind in array array['update', 'delete', 'restore'] loop
    action_loaded := null;
    if permission_by_id is not null then
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'applicationRootId', (p_read_facts -> 'context' ->> 'applicationRootId')::uuid,
          'ownerKind', declared.value ->> 'ownerKind',
          'ownerId', (declared.value ->> 'ownerId')::uuid,
          'permissionId', declared.key::uuid
        )
        order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
      )
      into required_permissions
      from pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
      where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
        and declared.value ->> 'actionKind' = action_kind
        and (declared.value ->> 'namedAction') is null
        and (
          declared.value ->> 'ownerKind' = 'application'
          or (declared.value ->> 'ownerId')::uuid = (target_meta ->> 'moduleRootId')::uuid
        );
      select not exists (
        select 1
        from pg_catalog.jsonb_array_elements(required_permissions) as required(value)
        join pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
          on declared.key = pg_catalog.lower(required.value ->> 'permissionId')
        where pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}')
            is distinct from 'array'
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') = 'array'
                then declared.value #> '{recordScope,routes}'
                else '[]'::jsonb end
            ) as route(value)
            where coalesce(route.value ->> 'kind', '') not in
              ('all_records', 'ownership', 'direct_share')
          )
      ) into simple_action;
      if simple_action then
        action_loaded := pg_catalog.jsonb_build_object(
          'outcome', 'loaded',
          'declaration', read_declaration || pg_catalog.jsonb_build_object(
            'operationKey', 'record.' || action_kind,
            'action', pg_catalog.jsonb_build_object('actionKind', action_kind),
            'requiredPermissions', coalesce(required_permissions, '[]'::jsonb)
          ),
          'facts', p_read_facts -> 'facts'
        );
        if required_permissions is null then
          action_loaded := pg_catalog.jsonb_set(action_loaded, '{declaration}', 'null'::jsonb);
        end if;
      end if;
    end if;
    if action_loaded is null then
      action_loaded := (vortex_record.load_record_access_facts_internal(
        action_kind, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', p_record_id
        ))
      ) -> 0);
    end if;
    if action_loaded ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(action_loaded -> 'declaration') = 'object' then
      -- An action decided over the read facts reuses their record types, which
      -- the read decision validated in this invocation; an action that loaded
      -- its writer's own facts validates them in full.
      action_decision := vortex_access.evaluate_record_access_with_validated_types_internal(
        action_loaded -> 'declaration', p_record_id, action_loaded -> 'facts', null,
        case when action_loaded -> 'facts' is not distinct from p_read_facts -> 'facts'
          then p_read_facts -> 'facts' -> 'recordTypes' end
      );
      if action_decision ->> 'outcome' = 'allowed' then
        actions := pg_catalog.array_append(actions, action_kind);
        -- The changeable fields are the update decision's own field bounds, the
        -- set the record save enforces, narrowed to the fields read_record
        -- projects for this row, so no hidden field is ever reported.
        if action_kind = 'update' then
          update_bounds := vortex_access.resolve_record_field_bounds_internal(action_decision);
          changeable_field_ids := coalesce((
            select pg_catalog.jsonb_agg(projected.value order by projected.value)
            from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
            where exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                update_bounds -> 'changeableFieldIds'
              ) as changeable(value)
              where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
            )
          ), '[]'::jsonb);
        end if;
      end if;
    end if;
  end loop;

  -- Changing a row needs at least one field it may change, so update is never
  -- reported without one.
  if pg_catalog.jsonb_array_length(changeable_field_ids) = 0 then
    actions := pg_catalog.array_remove(actions, 'update');
  end if;

  return pg_catalog.jsonb_build_object(
    'changeableFieldIds', changeable_field_ids,
    'actions', pg_catalog.to_jsonb(actions)
  );
end
$function$;

alter function vortex_record.read_record_capabilities_internal(uuid,uuid,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_capabilities_internal(uuid, uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_capabilities_internal(uuid, uuid, jsonb, jsonb, jsonb) is
  'Private record capabilities: returns the permitted update, delete and restore actions and changeable fields of one readable record, reusing the read facts and field bounds of its read decision, and the protected projection action context its caller resolved once in this invocation for the same record type when there is one.';

create or replace function vortex_record.read_record_titles_internal(
  p_targets jsonb
)
returns table (record_type_id uuid, record_id uuid, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  target_item jsonb;
  target_type_id uuid;
  target_title_field_id uuid;
  target_record_ids uuid[];
  title_key text;
  context_value jsonb;
  installation jsonb;
  plan jsonb;
  preview_installation jsonb;
  preview_installation_id uuid;
  refused_installation boolean := false;
  requested_id uuid;
  loaded jsonb;
  first_loaded_id uuid;
  first_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  candidate_ids uuid[];
  chunk_start integer;
  decided_ids uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  validated_record_types jsonb;
  row_read record;
  projection jsonb;
  readable_values jsonb;
  preview_meta jsonb;
begin
  if p_targets is null or pg_catalog.jsonb_typeof(p_targets) <> 'array' then
    raise exception using errcode = '22023', message = 'Title targets are invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_targets) = 0 then
    return;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'recordTypeId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'titleFieldId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'recordIds') is distinct from 'array'
  ) or (
    select pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
  ) <> pg_catalog.jsonb_array_length(p_targets) then
    raise exception using errcode = '22023', message = 'Title targets are invalid';
  end if;

  -- The verified request context and the current installation (the explicitly
  -- addressed preview for its owner, otherwise the active installation) are read
  -- once, and the installation access plan is resolved ONCE for the whole call:
  -- every record of every target type below decides against this one plan.
  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  begin
    preview_installation := vortex_record.read_current_preview_installation_internal();
    if preview_installation is not null
      and preview_installation ->> 'outcome' = 'refused' then
      refused_installation := true;
    else
      installation := case when preview_installation is null
        then vortex_definition.read_current_active_installation()
        else preview_installation end;
      plan := vortex_record.resolve_installation_access_plan_internal(installation);
      if preview_installation is not null then
        preview_installation_id := (installation ->> 'previewInstallationId')::uuid;
      end if;
    end if;
  exception
    when no_data_found then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    when too_many_rows then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is ambiguous';
  end;

  for target_item in
    select item.value from pg_catalog.jsonb_array_elements(p_targets) as item(value)
  loop
    target_type_id := (target_item ->> 'recordTypeId')::uuid;
    target_title_field_id := (target_item ->> 'titleFieldId')::uuid;
    select coalesce(pg_catalog.array_agg(id.value::uuid order by id.ordinality), array[]::uuid[])
    into target_record_ids
    from pg_catalog.jsonb_array_elements_text(target_item -> 'recordIds')
      with ordinality as id(value, ordinality)
    where id.value is not null;
    title_key := pg_catalog.lower(target_title_field_id::text);
    first_loaded_id := null;
    first_loaded := null;
    page_declaration := null;
    page_eligibility := null;
    page_narrowed := null;
    candidate_ids := null;
    validated_record_types := null;
    decided_ids := array[]::uuid[];
    decided_loaded := array[]::jsonb[];
    decided_decisions := array[]::jsonb[];
    decided_bounds := array[]::jsonb[];
    -- Records the page read pass does not decide use the same installation and plan.
    page_shared := case when refused_installation then null
      else pg_catalog.jsonb_build_object('installation', installation, 'plan', plan) end;

    -- The eligibility is local to this invocation. It narrows work only when the
    -- per-record projection confirms the same declaration and a live deadline.
    if not refused_installation and target_type_id <> nil_uuid then
      foreach requested_id in array target_record_ids loop
        if requested_id = nil_uuid then
          continue;
        end if;
        loaded := (vortex_record.load_record_access_facts_with_plan_internal(
          'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordTypeId', target_type_id,
            'recordId', requested_id
          )),
          installation, plan
        ) -> 0);
        if loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object' then
          page_declaration := loaded -> 'declaration';
          if loaded ? 'previewInstallationId' then
            preview_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
            page_shared := page_shared || pg_catalog.jsonb_build_object('previewBounds',
              vortex_record.preview_record_field_bounds_internal(
                target_type_id, (preview_meta ->> 'storageContractId')::uuid,
                preview_meta -> 'recordType'));
          else
            page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
              page_declaration, vortex_access.validated_human_request_context(),
              pg_catalog.clock_timestamp()
            );
          end if;
          first_loaded_id := requested_id;
          first_loaded := loaded;
          exit;
        end if;
      end loop;
    end if;

    -- The other ids are decided together by the page read pass, from
    -- the first record's exact facts, in sets of at most 200. The pass returns
    -- only the records it decided; every other id keeps the exact path below.
    if first_loaded is not null then
      select pg_catalog.array_agg(distinct candidate.id)
      into candidate_ids
      from pg_catalog.unnest(target_record_ids) as candidate(id)
      where candidate.id <> nil_uuid and candidate.id <> first_loaded_id;
    end if;
    if candidate_ids is not null then
      select page_shared
        || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
        page.narrowed
      into page_shared, page_narrowed
      from vortex_record.read_record_page_envelope_internal(target_type_id, first_loaded) as page;
      chunk_start := 1;
      while chunk_start <= coalesce(pg_catalog.cardinality(candidate_ids), 0) loop
        select decided_ids || coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          decided_loaded || coalesce(pg_catalog.array_agg(decided.loaded), array[]::jsonb[]),
          decided_decisions || coalesce(pg_catalog.array_agg(decided.decision), array[]::jsonb[]),
          decided_bounds || coalesce(pg_catalog.array_agg(decided.bounds), array[]::jsonb[])
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          target_type_id, first_loaded, page_declaration, page_eligibility,
          candidate_ids[chunk_start:chunk_start + 199], page_shared -> 'envelope', page_narrowed
        ) as decided;
        chunk_start := chunk_start + 200;
      end loop;
    end if;

    foreach requested_id in array target_record_ids loop
      record_type_id := target_type_id;
      record_id := requested_id;
      if refused_installation then
        result := pg_catalog.jsonb_build_object('outcome', 'refused');
        return next;
        continue;
      end if;
      decided_index := case when requested_id is distinct from first_loaded_id
        then pg_catalog.array_position(decided_ids, requested_id) end;
      select row_projection.* into row_read
      from vortex_record.read_record_projection_with_validated_types_internal(
        target_type_id, requested_id, page_declaration, page_eligibility,
        validated_record_types, null::jsonb,
        coalesce(decided_loaded[decided_index],
          case when requested_id = first_loaded_id then first_loaded end),
        decided_decisions[decided_index], decided_bounds[decided_index], page_shared
      ) as row_projection;
      if requested_id = first_loaded_id then
        first_loaded := null;
      end if;
      projection := row_read.projection;
      -- Only the exact evaluator validates record types for reuse.
      if validated_record_types is null and decided_index is null then
        validated_record_types := coalesce(
          row_read.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then row_read.read_facts #> '{facts,recordTypes}' end
        );
      end if;

      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        result := (projection - 'values') || pg_catalog.jsonb_build_object(
          'values', case when readable_values ? title_key
            then pg_catalog.jsonb_build_object(title_key, readable_values -> title_key)
            else '{}'::jsonb end
        );
      else
        result := projection;
      end if;
      return next;
    end loop;
  end loop;
  -- PL/pgSQL materializes this set before returning it. Revalidate after all
  -- projections so invocation-local preview facts cannot extend a builder's
  -- expiring role/group authority and disclose any part of the result.
  if preview_installation_id is not null
    and vortex_record.read_current_preview_installation_internal() ->> 'previewInstallationId'
      is distinct from preview_installation_id::text then
    raise exception using errcode = '42501', message = 'Preview title authority is unavailable';
  end if;
end
$function$;

alter function vortex_record.read_record_titles_internal(jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_titles_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_titles_internal(jsonb) to vortex_owner;

comment on function vortex_record.read_record_titles_internal(jsonb) is
  'Private adapter batch of record titles for many target record types: the request context, current installation and access plan are resolved once for the whole call; per type the first record is decided exactly, the others together by the page read pass with a local page eligibility, and any record the pass does not decide (missing, inaccessible or relationship-routed) by the exact single-record path with the same refusal.';

create or replace function vortex_record.read_records_with_action_previews(
  p_record_type_id uuid,
  p_targets jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_ids uuid[];
  requested_id uuid;
  target_position integer;
  action_item jsonb;
  loaded jsonb;
  first_loaded_id uuid;
  first_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  candidate_ids uuid[];
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[] := array[]::jsonb[];
  decided_decisions jsonb[] := array[]::jsonb[];
  decided_bounds jsonb[] := array[]::jsonb[];
  decided_index integer;
  validated_record_types jsonb;
  row_read record;
  projection jsonb;
  read_facts jsonb;
  preview_meta jsonb;
  preview_installation_id uuid;
  previews jsonb[];
  results jsonb[] := array[]::jsonb[];
  action_contexts jsonb := '{}'::jsonb;
  context_key text;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) > 200
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_targets) as target(value)
      where pg_catalog.jsonb_typeof(target.value) is distinct from 'object'
        or not coalesce(pg_catalog.pg_input_is_valid(target.value ->> 'recordId', 'uuid'), false)
        or pg_catalog.jsonb_typeof(target.value -> 'actions') is distinct from 'array'
        or pg_catalog.jsonb_array_length(target.value -> 'actions') > 20
        or exists (
          select 1 from pg_catalog.jsonb_array_elements(target.value -> 'actions') as item(value)
          where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
            or item.value ->> 'ownerKind' is null
            or item.value ->> 'ownerKind' not in ('application', 'module')
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'commandId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'activityId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'ownerId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'actionId', 'uuid'), false)
            or not coalesce(case when pg_catalog.pg_input_is_valid(item.value ->> 'releaseRevision', 'bigint')
              then (item.value ->> 'releaseRevision')::bigint between 1 and 9007199254740991 end, false)
        )
    ) then
    raise exception using errcode = '22023', message = 'Named action previews are invalid';
  end if;
  select coalesce(pg_catalog.array_agg((target.value ->> 'recordId')::uuid order by target.ordinality),
    array[]::uuid[])
  into target_ids
  from pg_catalog.jsonb_array_elements(p_targets) with ordinality as target(value, ordinality);

  -- The page read pass the list read uses: the first readable record
  -- is decided exactly and supplies the installation-wide facts; the other
  -- records are decided together from them. A record the pass does not decide
  -- (missing, inaccessible or relationship-routed) keeps the exact
  -- single-record path with the same refusal. The eligibility is local to this
  -- invocation and narrows work only when each record's projection confirms
  -- the same declaration and a live deadline.
  if p_record_type_id <> '00000000-0000-0000-0000-000000000000'::uuid then
    foreach requested_id in array target_ids loop
      if requested_id = '00000000-0000-0000-0000-000000000000'::uuid then
        continue;
      end if;
      loaded := (vortex_record.load_record_access_facts_internal(
        'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', requested_id
        ))
      ) -> 0);
      if loaded ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object' then
        page_declaration := loaded -> 'declaration';
        if loaded ? 'previewInstallationId' then
          preview_installation_id := (loaded ->> 'previewInstallationId')::uuid;
          preview_meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
          page_shared := pg_catalog.jsonb_build_object('previewBounds',
            vortex_record.preview_record_field_bounds_internal(
              p_record_type_id, (preview_meta ->> 'storageContractId')::uuid,
              preview_meta -> 'recordType'));
        else
          page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
            page_declaration, vortex_access.validated_human_request_context(),
            pg_catalog.clock_timestamp()
          );
        end if;
        first_loaded_id := requested_id;
        first_loaded := loaded;
        exit;
      end if;
    end loop;
  end if;
  if first_loaded is not null then
    select pg_catalog.array_agg(distinct candidate.id)
    into candidate_ids
    from pg_catalog.unnest(target_ids) as candidate(id)
    where candidate.id <> first_loaded_id
      and candidate.id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end if;
  if candidate_ids is not null then
    select coalesce(page_shared, '{}'::jsonb)
      || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
      page.narrowed
    into page_shared, page_narrowed
    from vortex_record.read_record_page_envelope_internal(p_record_type_id, first_loaded) as page;
    -- At most 199 candidates (200 targets, the first decided exactly).
    select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
      coalesce(pg_catalog.array_agg(decided.loaded), array[]::jsonb[]),
      coalesce(pg_catalog.array_agg(decided.decision), array[]::jsonb[]),
      coalesce(pg_catalog.array_agg(decided.bounds), array[]::jsonb[])
    into decided_ids, decided_loaded, decided_decisions, decided_bounds
    from vortex_record.read_record_page_decisions_internal(
      p_record_type_id, first_loaded, page_declaration, page_eligibility,
      candidate_ids, page_shared -> 'envelope', page_narrowed
    ) as decided;
  end if;

  for target_position in 1 .. pg_catalog.cardinality(target_ids) loop
    requested_id := target_ids[target_position];
    decided_index := case when requested_id is distinct from first_loaded_id
      then pg_catalog.array_position(decided_ids, requested_id) end;
    select row_projection.* into row_read
    from vortex_record.read_record_projection_with_validated_types_internal(
      p_record_type_id, requested_id, page_declaration, page_eligibility,
      validated_record_types, null::jsonb,
      coalesce(decided_loaded[decided_index],
        case when requested_id = first_loaded_id then first_loaded end),
      decided_decisions[decided_index], decided_bounds[decided_index], page_shared
    ) as row_projection;
    if requested_id = first_loaded_id then
      first_loaded := null;
    end if;
    projection := row_read.projection;
    -- Only the exact evaluator validates record types for reuse.
    if validated_record_types is null and decided_index is null then
      validated_record_types := coalesce(
        row_read.read_facts -> 'validatedRecordTypes',
        case when projection ->> 'outcome' = 'allowed'
          then row_read.read_facts #> '{facts,recordTypes}' end
      );
    end if;
    previews := array[]::jsonb[];
    if projection ->> 'outcome' = 'allowed' then
      -- A decided record carries its compact scope; its complete read facts are
      -- the page envelope with that scope. Each bound action is still decided
      -- against its own declaration, never by the record's read decision.
      read_facts := case when decided_index is not null
        then vortex_record.read_record_page_row_facts_internal(page_shared -> 'envelope', row_read.read_facts)
        else row_read.read_facts end;
      for action_item in
        select item.value
        from pg_catalog.jsonb_array_elements(p_targets -> (target_position - 1) -> 'actions')
          with ordinality as item(value, ordinality)
        order by item.ordinality
      loop
        -- An action's context depends only on the action and the record type, not on the
        -- record: it is resolved once per page. A resolution that fails is not cached as a
        -- context: each record's preview then decides it (and its replay) itself.
        context_key := pg_catalog.lower(action_item ->> 'ownerKind') || ':'
          || pg_catalog.lower(action_item ->> 'ownerId') || ':'
          || ((action_item ->> 'releaseRevision')::bigint)::text || ':'
          || pg_catalog.lower(action_item ->> 'actionId');
        if not action_contexts ? context_key then
          begin
            action_contexts := action_contexts || pg_catalog.jsonb_build_object(context_key,
              vortex_record.resolve_named_action_context_internal(
                action_item ->> 'ownerKind', (action_item ->> 'ownerId')::uuid,
                (action_item ->> 'releaseRevision')::bigint, (action_item ->> 'actionId')::uuid,
                p_record_type_id));
          exception
            when no_data_found or too_many_rows or insufficient_privilege
              or object_not_in_prerequisite_state or check_violation then
              action_contexts := action_contexts || pg_catalog.jsonb_build_object(context_key, false);
          end;
        end if;
        previews := pg_catalog.array_append(previews, pg_catalog.jsonb_build_object(
          'actionId', action_item -> 'actionId',
          -- An unresolvable context passes null, so the preview resolves it itself after its
          -- command-receipt replay check and refuses exactly as the single preview does.
          'preview', vortex_record.prepare_named_action_set_announce_internal(
            true, (action_item ->> 'commandId')::uuid, action_item ->> 'ownerKind',
            (action_item ->> 'ownerId')::uuid, (action_item ->> 'releaseRevision')::bigint,
            (action_item ->> 'actionId')::uuid, p_record_type_id, requested_id,
            (projection ->> 'concurrencyNumber')::bigint, '{}'::jsonb,
            (action_item ->> 'activityId')::uuid, read_facts,
            nullif(action_contexts -> context_key, 'false'::jsonb)
          )
        ));
      end loop;
    end if;
    results := pg_catalog.array_append(results, pg_catalog.jsonb_build_object(
      'recordId', requested_id,
      'record', case when projection ->> 'outcome' = 'allowed'
        then pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', projection -> 'recordId',
          'concurrencyNumber', projection -> 'concurrencyNumber')
        else projection end,
      'previews', pg_catalog.to_jsonb(previews)
    ));
  end loop;
  -- PL/pgSQL materializes the result before returning it. Revalidate after all
  -- reads so invocation-local preview facts cannot extend a builder's expiring
  -- role/group authority and disclose any part of the result.
  if preview_installation_id is not null
    and vortex_record.read_current_preview_installation_internal() ->> 'previewInstallationId'
      is distinct from preview_installation_id::text then
    raise exception using errcode = '42501', message = 'Preview authority is unavailable';
  end if;
  return pg_catalog.to_jsonb(results);
end
$function$;

alter function vortex_record.read_records_with_action_previews(uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_records_with_action_previews(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_record.read_records_with_action_previews(uuid, jsonb) to vortex_request;

comment on function vortex_record.read_records_with_action_previews(uuid, jsonb) is
  'Fixed record adapter for a grid page of records and the named actions bound to each: reads every target through the page read pass the list read uses (the first readable record decided exactly, the others together, any record the pass does not decide by the exact single-record path), and, only for a readable record, returns each action''s preview exactly as vortex_record.preview_named_action_set_announce returns it for the record''s current concurrency number and no inputs (previews, in the order given), under the caller''s current authority and writing nothing; a readable record is reported by its recordId and concurrencyNumber, an unreadable one as refused.';

CREATE OR REPLACE FUNCTION vortex_record.record_lifecycle_current_revision_internal(p_record_type_id uuid, p_record_id uuid) RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  loaded jsonb;
  decision jsonb;
begin
  begin
    loaded := (vortex_record.load_record_access_facts_internal(
      'delete', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id
      ))
    ) -> 0);
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
      return null;
    end if;
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', loaded -> 'declaration',
        'recordId', p_record_id,
        'facts', loaded -> 'facts'
      )
    )) -> 0);
    if decision ->> 'outcome' is distinct from 'allowed' then
      return null;
    end if;
    return (loaded ->> 'concurrencyNumber')::bigint;
  exception
    when others then
      return null;
  end;
end
$$;
alter function vortex_record.record_lifecycle_current_revision_internal(uuid,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.record_lifecycle_current_revision_internal(p_record_type_id uuid, p_record_id uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION vortex_record.record_named_action_precondition_refusal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_activity_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  loaded jsonb;
  decision jsonb;
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', loaded -> 'declaration',
      'recordId', p_record_id,
      'facts', loaded -> 'facts'
    )
  )) -> 0);
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
  return pg_catalog.jsonb_build_object(
    'outcome', 'refused_recorded', 'correlationId', context_value -> 'correlationId'
  );
end
$$;
alter function vortex_record.record_named_action_precondition_refusal(text,uuid,bigint,uuid,uuid,uuid,bigint,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.record_named_action_precondition_refusal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_activity_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.record_named_action_precondition_refusal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_activity_id uuid) TO vortex_request;

create or replace function vortex_record.soft_delete_record_recursive_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_visited text[]
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  context_value jsonb;
  record_fact jsonb;
  identity_value text;
  incoming record;
  relationship_value jsonb;
  source_field_id uuid;
  on_parent_delete text;
  source_catalogue vortex_record.storage_catalogue%rowtype;
  source_meta jsonb;
  source_loaded jsonb;
  source_decision jsonb;
  source_record_type jsonb;
  source_concurrency bigint;
  source_link_column text;
  source_link_value jsonb;
  source_identity text;
  source_action_kind text;
  changed_rows integer;
  application_scope uuid;
  saved_record_id uuid;
  saved_concurrency_number bigint;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'delete');
  context_value := meta -> 'context';
  identity_value := pg_catalog.lower((meta ->> 'storageContractId')) || ':'
    || pg_catalog.lower(p_record_id::text);
  if identity_value = any (p_visited) then
    raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
  end if;
  p_visited := pg_catalog.array_append(p_visited, identity_value);

  loaded := (vortex_record.load_record_access_facts_internal(
    'delete', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id,
      'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number
    ))
  ) -> 0);
  if loaded ->> 'outcome' = 'conflict' then
    raise exception using errcode = '40001', message = 'Record delete revision is stale';
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  if record_fact ->> 'lifecycleState' <> 'active' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'binding', meta -> 'declaration' -> 'recordBinding'
  );
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', meta -> 'declaration',
      'recordId', p_record_id,
      'facts', facts
    )
  )) -> 0);
  if decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;

  -- Incoming edges are canonicalised before any child lock.  Every affected
  -- child is then reloaded and locked by the fixed record loader.
  for incoming in
    select edge.*
    from vortex_record.relationship_edges as edge
    where edge.to_organisation_id = (context_value ->> 'organizationId')::uuid
      and edge.to_storage_contract_id = (meta ->> 'storageContractId')::uuid
      and edge.to_record_id = p_record_id
    order by edge.from_storage_contract_id, edge.from_record_id, edge.relationship_id
  loop
    select catalogue.* into strict source_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = incoming.from_storage_contract_id;
    -- Preview-only relationships have no installed mapping. The edge's exact source
    -- storage declares the field and deletion policy, just as it declares edge integrity.
    select relationship.value into strict relationship_value
    from pg_catalog.jsonb_array_elements(
      source_catalogue.record_type_definition -> 'relationships'
    ) as relationship(value)
    where (relationship.value ->> 'relationshipId')::uuid = incoming.relationship_id;
    source_field_id := (relationship_value ->> 'fromFieldId')::uuid;
    on_parent_delete := relationship_value ->> 'onParentDelete';
    source_identity := pg_catalog.lower(incoming.from_storage_contract_id::text) || ':'
      || pg_catalog.lower(incoming.from_record_id::text);
    if source_identity = any (p_visited) then
      raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
    end if;

    -- A child retained by another Application cannot be silently modified
    -- under this Application's request context.  It is therefore a safe
    -- blocking relationship, not an authority bypass.
    source_action_kind := case
      when on_parent_delete = 'empty_optional' then 'update'
      when on_parent_delete = 'soft_delete_dependent' then 'delete'
      else 'read'
    end;
    begin
      source_meta := vortex_record.resolve_record_action_context_internal(
        source_catalogue.record_type_id, source_action_kind
      );
    exception when others then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end;
    if (source_meta ->> 'storageContractId')::uuid is distinct from
      incoming.from_storage_contract_id then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;

    select field_mapping.physical_column_token into strict source_link_column
    from vortex_record.field_storage_mappings as field_mapping
    where field_mapping.storage_contract_id = incoming.from_storage_contract_id
      and field_mapping.field_id = source_field_id
      and field_mapping.state = 'active'
      and field_mapping.introduced_at_release_revision <=
        (source_meta ->> 'moduleReleaseRevision')::bigint;

    execute pg_catalog.format(
      'select concurrency_number, %I from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      source_link_column, source_meta ->> 'table'
    ) into source_concurrency, source_link_value using
      (context_value ->> 'organizationId')::uuid, incoming.from_record_id;
    if not found then
      continue;
    end if;
    -- The incoming-edge cursor may have been opened before a concurrent link
    -- change committed. The source row lock returns the current tuple, so
    -- re-check its exact field before applying parent-delete behaviour. This
    -- prevents a stale edge snapshot from clearing or revising the source a
    -- second time after that link was already removed or redirected.
    if pg_catalog.jsonb_typeof(source_link_value) <> 'object'
      or source_link_value ->> 'recordId' is distinct from p_record_id::text then
      continue;
    end if;
    source_loaded := (vortex_record.load_record_access_facts_internal(
      source_action_kind, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', source_catalogue.record_type_id,
        'recordId', incoming.from_record_id,
        'expectedConcurrencyNumber', source_concurrency
      ))
    ) -> 0);
    if source_loaded ->> 'outcome' <> 'loaded' then
      continue;
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(source_loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = incoming.from_record_id;
    if record_fact ->> 'lifecycleState' <> 'active' then
      continue;
    end if;
    if on_parent_delete = 'refuse' then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;
    if pg_catalog.jsonb_typeof(source_meta -> 'declaration') <> 'object' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;
    source_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', source_meta -> 'declaration',
        'recordId', incoming.from_record_id,
        'facts', (source_loaded -> 'facts') || pg_catalog.jsonb_build_object( 'binding', source_meta -> 'declaration' -> 'recordBinding' )
      )
    )) -> 0);
    if source_decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;

    if on_parent_delete = 'empty_optional' then
      perform vortex_record.write_relationship_value_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        incoming.relationship_id, 'null'::jsonb, true
      );
      perform vortex_record.append_record_lifecycle_effect_internal(
        'optional_cleared', incoming.from_storage_contract_id,
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, incoming.relationship_id
      );
    elsif on_parent_delete = 'soft_delete_dependent' then
      source_record_type := source_meta -> 'recordType';
      if source_record_type ->> 'ownershipMode' <> 'inherited'
        or not source_record_type ? 'ownershipRelationshipId'
        or (source_record_type ->> 'ownershipRelationshipId')::uuid <>
          incoming.relationship_id then
        raise exception using errcode = '23514', message = 'Dependent deletion is not declared';
      end if;
      perform vortex_record.soft_delete_record_recursive_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, p_visited
      );
    else
      raise exception using errcode = '23514', message = 'Parent deletion behavior is invalid';
    end if;
  end loop;

  execute pg_catalog.format(
    'update record_data.%I as stored
     set lifecycle_state = ''soft_deleted'',
       concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       deleted_at = pg_catalog.statement_timestamp(), deleted_by = $3,
       removal_due_at = null, definition_revision = $4
     where organisation_id = $1 and record_id = $2
       and lifecycle_state = ''active'' and concurrency_number = $5
     returning stored.record_id, stored.concurrency_number',
    meta ->> 'table'
  ) into saved_record_id, saved_concurrency_number using
    (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (meta ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Record delete revision changed';
  end if;
  if saved_record_id is distinct from p_record_id
    or saved_concurrency_number is null
    or saved_concurrency_number not between 1 and 9007199254740991 then
    raise exception using errcode = '55000', message = 'Record delete saved identity is unavailable';
  end if;
  perform vortex_record.append_record_lifecycle_effect_internal(
    'soft_deleted', (meta ->> 'storageContractId')::uuid,
    p_record_type_id, p_record_id, p_expected_concurrency_number, null
  );
  application_scope := case when meta ->> 'storageScope' = 'application_contained'
    then (context_value ->> 'applicationRootId')::uuid else null end;
  if meta ->> 'storageScope' <> 'application_contained' then
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, application_scope
    );
  end if;
end
$function$;

alter function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[]) owner to vortex_record_adapter;

revoke all on function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[]) is null;

create or replace function vortex_record.transfer_record_ownership_for_offboarding_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_source_organization_account_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb; organization_id_value uuid; application_root_id_value uuid;
  actor_id_value uuid; receipt_claim jsonb;
  loaded jsonb; decision jsonb; record_fact jsonb; type_fact jsonb;
  previous_owner uuid; updated_concurrency bigint; changed_rows integer; event_result jsonb;
  evaluation_facts jsonb;
  updated_record_id uuid; updated_organization_id uuid; updated_application_root_id uuid;
  storage_scope_value text; preview_installation jsonb;
  exact_notice boolean := false; notice_sequence bigint;
  correlation_id_value uuid;
begin
  if p_command_id is null or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind is distinct from 'organization_account' or p_target_id is null
    or p_activity_id is null or p_occurrence_id is null
    or p_source_organization_account_id is null
    or p_source_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.lock_human_request_access_version_internal();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Offboarding ownership transfer requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  if correlation_id_value is null or not vortex_platform.is_non_nil_uuid(correlation_id_value::text) then
    raise exception using errcode='42501',message='Offboarding ownership transfer authority is unavailable';
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','command_identity_conflict','correlationId',context_value -> 'correlationId');
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome','conflict','correlationId',context_value -> 'correlationId');
    end if;
    return pg_catalog.jsonb_build_object('outcome','transferred','recordId',(receipt_claim ->> 'recordId')::uuid,
      'concurrencyNumber',(receipt_claim ->> 'concurrencyNumber')::bigint,'correlationId',context_value -> 'correlationId','replayed',true);
  end if;
  loaded := vortex_record.load_offboarding_ownership_transfer_facts_internal(
    p_record_type_id,p_record_id,p_expected_concurrency_number);
  if loaded ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','conflict','concurrencyNumber',loaded -> 'concurrencyNumber','correlationId',context_value -> 'correlationId');
  end if;
  if loaded ->> 'outcome' is distinct from 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object'
    or loaded ->> 'installationState' is null
    or loaded ->> 'installationState' not in ('active', 'detached')
    or pg_catalog.jsonb_typeof(loaded -> 'facts') is distinct from 'object'
    or pg_catalog.jsonb_typeof(loaded #> '{facts,records}') is distinct from 'array'
    or pg_catalog.jsonb_typeof(loaded #> '{facts,recordTypes}') is distinct from 'array' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  select item.value into record_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  select item.value into type_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  storage_scope_value := record_fact #>> '{recordScope,storageScope}';
  if pg_catalog.jsonb_typeof(record_fact) is distinct from 'object'
    or pg_catalog.jsonb_typeof(type_fact) is distinct from 'object'
    or record_fact ->> 'lifecycleState' is null
    or record_fact ->> 'lifecycleState' not in ('active','soft_deleted')
    or (loaded ->> 'installationState' = 'active' and record_fact ->> 'lifecycleState' is distinct from 'soft_deleted')
    or type_fact ->> 'ownershipMode' is distinct from 'organization_account'
    or storage_scope_value is null
    or storage_scope_value not in ('application_contained', 'organization_shared')
    or (record_fact #>> '{recordScope,organizationId}')::uuid is distinct from organization_id_value
    or (record_fact #>> '{recordScope,recordTypeId}')::uuid is distinct from p_record_type_id
    or (record_fact #>> '{recordScope,storageContractId}')::uuid is distinct from (type_fact ->> 'storageContractId')::uuid
    or type_fact ->> 'storageContractId' is null
    or not vortex_platform.is_non_nil_uuid(type_fact ->> 'storageContractId')
    or (storage_scope_value = 'application_contained'
      and (record_fact #>> '{recordScope,applicationRootId}')::uuid is distinct from application_root_id_value)
    or (record_fact ->> 'ownerOrganizationAccountId')::uuid is distinct from p_source_organization_account_id then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  -- Retained rows are never restored.  The unchanged complete Access
  -- evaluator sees only this locked target as active in an in-memory facts
  -- view, preserving every existing transfer route and condition.
  evaluation_facts := loaded -> 'facts';
  if record_fact ->> 'lifecycleState' = 'soft_deleted' then
    evaluation_facts := evaluation_facts || pg_catalog.jsonb_build_object(
      'records',
      (
        select pg_catalog.jsonb_agg(
          case
            when (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
              then pg_catalog.jsonb_set(
                item.value, '{lifecycleState}', '"active"'::jsonb, false
              )
            else item.value
          end
          order by item.ordinal
        )
        from pg_catalog.jsonb_array_elements(evaluation_facts -> 'records')
          with ordinality as item(value, ordinal)
      )
    );
  end if;
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', loaded -> 'declaration',
      'recordId', p_record_id,
      'facts', evaluation_facts
    )
  )) -> 0);
  if decision ->> 'outcome' = 'refused' then
    perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused_recorded','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  elsif decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode='42501', message='Offboarding ownership transfer authority is unavailable';
  end if;
  if not vortex_access.lock_active_record_ownership_target_internal('organization_account',p_target_id)
    or p_target_id = p_source_organization_account_id then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  execute pg_catalog.format(
    'update record_data.%I as stored set owner_organisation_account_id=$3,owner_group_id=null,concurrency_number=concurrency_number+1,updated_at=pg_catalog.statement_timestamp(),updated_by=$4 where stored.organisation_id=$1 and stored.record_id=$2 and stored.concurrency_number=$5 returning stored.record_id,stored.concurrency_number,stored.organisation_id,%s',
    loaded ->> 'table',
    case when storage_scope_value = 'application_contained'
      then 'stored.application_root_id' else 'null::uuid' end
  ) into updated_record_id,updated_concurrency,updated_organization_id,updated_application_root_id
    using organization_id_value,p_record_id,p_target_id,actor_id_value,p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then raise exception using errcode='40001',message='Offboarding ownership transfer revision changed'; end if;
  if updated_record_id is distinct from p_record_id
    or not vortex_platform.is_non_nil_uuid(updated_record_id::text)
    or updated_organization_id is distinct from organization_id_value
    or updated_concurrency is null
    or updated_concurrency not between 1 and 9007199254740991
    or (storage_scope_value = 'application_contained'
      and updated_application_root_id is distinct from application_root_id_value) then
    raise exception using errcode='40001',message='Offboarding ownership transfer revision changed';
  end if;
  perform vortex_access.invalidate_preview_installations_internal(organization_id_value);
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation ->> 'outcome' = 'refused' then
    raise exception using errcode='42501',message='Preview Record context is unavailable';
  end if;
  exact_notice := preview_installation is null
    and loaded ->> 'installationState' = 'active'
    and storage_scope_value = 'application_contained';
  if exact_notice then
    -- Defer the exact notice until the protected transfer is complete.
    null;
  else
    perform vortex_record.bump_record_data_version_internal(
      organization_id_value, (type_fact ->> 'storageContractId')::uuid,
      case when storage_scope_value = 'application_contained'
        then application_root_id_value else null end
    );
  end if;
  perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[p_record_id]::uuid[], array[]::uuid[], 'completed');
  if loaded ->> 'installationState' = 'detached' then
    event_result := vortex_platform.append_detached_offboarding_reassignment_internal(
      (type_fact ->> 'storageContractId')::uuid, p_record_id, p_record_type_id, p_occurrence_id
    );
  else
    event_result := vortex_platform.append_record_occurrences(
      (type_fact ->> 'storageContractId')::uuid, p_record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId',p_occurrence_id,
        'descriptor',pg_catalog.jsonb_build_object(
          'kind','standard','eventKind','reassigned','recordTypeId',p_record_type_id
        ),
        'payload',pg_catalog.jsonb_build_object('kind','reassigned')
      ))
    );
  end if;
  if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
    raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed';
  end if;
  if pg_catalog.jsonb_array_length(event_result) <> 1 then raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed'; end if;
  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, updated_record_id, updated_concurrency,
    'Offboarding ownership transfer receipt is stale'
  );
  if exact_notice then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
        raise exception using errcode='22023',message='Invalidation notice command is invalid';
      end if;
      perform vortex_platform.publish_change_notice(
        updated_organization_id, updated_application_root_id, p_record_type_id,
        updated_record_id, updated_concurrency, 'changed',
        notice_sequence, notice_sequence, correlation_id_value
      );
    exception when others then
      -- Notice allocation and publication are advisory after the protected transfer is complete.
      null;
    end;
  end if;
  return pg_catalog.jsonb_build_object('outcome','transferred','recordId',updated_record_id,
    'concurrencyNumber',updated_concurrency,'correlationId',context_value -> 'correlationId','replayed',false);
end
$function$;

alter function vortex_record.transfer_record_ownership_for_offboarding_internal(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) is
  'Private offboarding single-record ownership transfer: the public transfer contract, with the command receipt, Activity and Event, for a named source owner.';

-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.write_named_action_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_subject_record_type_id uuid,
  p_subject_record_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  application_root_required boolean;
  existing_other boolean;
  update_sql text;
  changed_rows integer;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_subject_record_type_id is null or p_subject_record_id is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  select mapping.* into mapping_row
  from vortex_record.relationship_storage_mappings as mapping
  where mapping.relationship_id = p_relationship_id
    and mapping.source_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
    and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
  if not found
    or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
    or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
    raise exception using errcode = '55000',
      message = 'Relationship storage disagrees with the active definition';
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    delete from vortex_record.relationship_edges as edge
    where edge.relationship_id = p_relationship_id
      and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
      and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
      and edge.from_record_id = p_source_record_id;
    update_sql := pg_catalog.format(
      'update record_data.%I as stored set %I = null
       where stored.organisation_id = $1 and stored.record_id = $2',
      source_meta ->> 'table', field_column ->> 'token'
    );
    execute update_sql using (source_context ->> 'organizationId')::uuid, p_source_record_id;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Relationship source record changed';
    end if;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;
  application_root_required := coalesce(
    (field_value #>> '{settings,applicationRootIdRequired}')::boolean, false
  );
  if application_root_required
    and (target_meta #>> '{recordType,systemProjection,protectedView}')
      is distinct from 'organization_accounts' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  perform vortex_record.lock_relationship_target_row_internal(
    target_type_id, target_record_id,
    (source_context ->> 'organizationId')::uuid
  );

  -- The one substitution. Executing a permitted named action must not require
  -- ordinary read authority on its own subject, so when the
  -- selected target is exactly this command's subject the decision is taken on
  -- the installed named declaration instead. The loader re-resolves the active
  -- installation, the owner kind/id/release revision, the action id and the
  -- action's declared subject record type, and the Access evaluation binds the
  -- organization, application, record type, record and the actor's current
  -- authority. Every other target keeps the ordinary read check unchanged.
  if target_type_id = p_subject_record_type_id and target_record_id = p_subject_record_id then
    target_loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, target_type_id, target_record_id, null
    );
  else
    target_loaded := (vortex_record.load_record_access_facts_internal(
      'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', target_type_id,
        'recordId', target_record_id
      ))
    ) -> 0);
  end if;
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', target_loaded -> 'declaration',
      'recordId', target_record_id,
      'facts', target_loaded -> 'facts'
    )
  )) -> 0);
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if application_root_required
    and not vortex_access.organization_account_has_current_application_access_internal(
      (source_context ->> 'organizationId')::uuid,
      target_record_id,
      (source_context ->> 'applicationRootId')::uuid
    ) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked (the command preflight already holds every
  -- link target) and eligible; the shared edge identities are taken last,
  -- exactly as `write_relationship_value_internal` takes them.
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  if mapping_row.cardinality = 'many_to_one' and target_type_id = p_source_record_type_id then
    -- A record type's one-record link to itself is a parent link: it must never make a cycle.
    perform vortex_record.assert_relationship_acyclic_internal(
      p_relationship_id, (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid, (field_value ->> 'fieldId')::uuid,
      p_source_record_id, target_record_id
    );
  end if;

  delete from vortex_record.relationship_edges as edge
  where edge.relationship_id = p_relationship_id
    and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
    and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and edge.from_record_id = p_source_record_id;
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    p_relationship_id,
    (source_context ->> 'organizationId')::uuid,
    (source_context ->> 'organizationId')::uuid,
    source_application_root_id, target_application_root_id,
    (source_meta ->> 'storageContractId')::uuid, p_source_record_id,
    (target_meta ->> 'storageContractId')::uuid, target_record_id
  );

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb
     where stored.organisation_id = $1 and stored.record_id = $2',
    source_meta ->> 'table', field_column ->> 'token'
  );
  execute update_sql using (source_context ->> 'organizationId')::uuid,
    p_source_record_id, p_target_value;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

alter function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) to vortex_record_adapter;

comment on function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) is
  'Private named-action edge writer: checks current application access for flagged Person links, uses the ordinary or protected projection target lock and edge flow, and authorises the command subject by re-evaluating the exact installed named action rather than ordinary read.';

-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.write_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_increment_source_revision boolean
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  application_root_required boolean;
  existing_other boolean;
  update_sql text;
  changed_rows integer;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null or p_increment_source_revision is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  if source_meta ? 'previewInstallationId' then
    -- The exact owner-validated preview definition is its mapping. A live mapping's single
    -- relationship identity must never be repointed at a preview's isolated storage.
    mapping_row.source_storage_contract_id := (source_meta ->> 'storageContractId')::uuid;
    mapping_row.cardinality := relationship_value ->> 'cardinality';
    mapping_row.on_parent_delete := relationship_value ->> 'onParentDelete';
    select pg_catalog.array_agg((target.value ->> 'recordTypeId')::uuid)
    into mapping_row.target_record_type_ids
    from pg_catalog.jsonb_array_elements(case when relationship_value ? 'toRecordType'
      then pg_catalog.jsonb_build_array(relationship_value -> 'toRecordType')
      else relationship_value -> 'toRecordTypes' end) as target(value);
  else
    select mapping.* into mapping_row
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.relationship_id = p_relationship_id
      and mapping.source_storage_contract_id =
        (source_meta ->> 'storageContractId')::uuid
      and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
      and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
    if not found
      or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
      or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
      raise exception using errcode = '55000',
        message = 'Relationship storage disagrees with the active definition';
    end if;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    if p_increment_source_revision then
      perform vortex_record.bump_record_data_version_internal(
        (source_context ->> 'organizationId')::uuid,
        (source_meta ->> 'storageContractId')::uuid,
        case when source_meta ->> 'storageScope' = 'application_contained'
          then (source_context ->> 'applicationRootId')::uuid else null end
      );
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    delete from vortex_record.relationship_edges as edge
    where edge.relationship_id = p_relationship_id
      and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
      and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
      and edge.from_record_id = p_source_record_id;
    update_sql := pg_catalog.format(
      'update record_data.%I as stored set %I = null%s
       where stored.organisation_id = $1 and stored.record_id = $2',
      source_meta ->> 'table', field_column ->> 'token',
      case when p_increment_source_revision then
        ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $3'
      else '' end
    );
    if p_increment_source_revision then
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id, (source_context ->> 'organizationAccountId')::uuid;
    else
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id;
    end if;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Relationship source record changed';
    end if;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;
  application_root_required := coalesce(
    (field_value #>> '{settings,applicationRootIdRequired}')::boolean, false
  );
  if application_root_required
    and (target_meta #>> '{recordType,systemProjection,protectedView}')
      is distinct from 'organization_accounts' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- Lock the protected row behind either ordinary record storage or a
  -- registered system projection before rebuilding eligibility from current
  -- facts. The lock is held until commit, so the target cannot disappear while
  -- the unconstrainted relationship edge is installed.
  perform vortex_record.lock_relationship_target_row_internal(
    target_type_id, target_record_id,
    (source_context ->> 'organizationId')::uuid
  );

  target_loaded := (vortex_record.load_record_access_facts_internal(
    'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', target_type_id,
      'recordId', target_record_id
    ))
  ) -> 0);
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if source_meta ? 'previewInstallationId'
    and target_loaded ->> 'previewInstallationId' = source_meta ->> 'previewInstallationId'
    and exists (
      select 1 from vortex_definition.roots as root
      where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
        and root.owner_application_root_id = (source_context ->> 'applicationRootId')::uuid
    ) then
    target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
  else
    if pg_catalog.jsonb_array_length(
      target_loaded #> '{declaration,requiredPermissions}'
    ) = 0 then
      raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
    end if;
    target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}', '{"kind":"permission"}'::jsonb),
        'recordId', target_record_id,
        'facts', target_loaded -> 'facts'
      )
    )) -> 0);
  end if;
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if application_root_required
    and not vortex_access.organization_account_has_current_application_access_internal(
      (source_context ->> 'organizationId')::uuid,
      target_record_id,
      (source_context ->> 'applicationRootId')::uuid
    ) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked and eligible. The source data version is
  -- taken next, then the shared edge identities last.
  if p_increment_source_revision then
    perform vortex_record.bump_record_data_version_internal(
      (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid,
      source_application_root_id
    );
  end if;
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  if mapping_row.cardinality = 'many_to_one' and target_type_id = p_source_record_type_id then
    -- A record type's one-record link to itself is a parent link: it must never make a cycle.
    perform vortex_record.assert_relationship_acyclic_internal(
      p_relationship_id, (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid, (field_value ->> 'fieldId')::uuid,
      p_source_record_id, target_record_id
    );
  end if;

  delete from vortex_record.relationship_edges as edge
  where edge.relationship_id = p_relationship_id
    and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
    and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and edge.from_record_id = p_source_record_id;
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    p_relationship_id,
    (source_context ->> 'organizationId')::uuid,
    (source_context ->> 'organizationId')::uuid,
    source_application_root_id, target_application_root_id,
    (source_meta ->> 'storageContractId')::uuid, p_source_record_id,
    (target_meta ->> 'storageContractId')::uuid, target_record_id
  );

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb%s
     where stored.organisation_id = $1 and stored.record_id = $2',
    source_meta ->> 'table', field_column ->> 'token',
    case when p_increment_source_revision then
      ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $4'
    else '' end
  );
  if p_increment_source_revision then
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value,
      (source_context ->> 'organizationAccountId')::uuid;
  else
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value;
  end if;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

alter function vortex_record.write_relationship_value_internal(uuid,uuid,uuid,jsonb,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean) is
  'Private relationship writer: validates the declared relationship and target eligibility, checks current application access for flagged Person links, share-locks the record or protected projection target, then takes the source data version and the shared edge identities before replacing the source link edge and typed value atomically. Owner-only.';

reset role;
