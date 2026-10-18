-- #2811: a named action reads the installed definitions in set-based statements. The facts loader
-- checks every record type's storage in one statement per release and builds a type's column map only
-- when it loads one of its rows; the action resolver gathers only the permissions the action names;
-- the access evaluator checks the relationship set in one statement. Results and refusals are unchanged.
set local role vortex_owner;

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

set local role vortex_record_adapter;

create or replace function vortex_record.named_action_storage_columns_internal(
  p_storage_contract_id uuid,
  p_fields jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  columns_value jsonb;
  storage_disagrees boolean;
  value_expression text;
begin
  -- The column map of one record type's storage: every declared field's active
  -- physical column, keyed by its lower-case field identity.
  select coalesce(pg_catalog.bool_or(
      mapping.storage_contract_id is null or mapping.state <> 'active'
    ), false),
    coalesce(pg_catalog.jsonb_object_agg(
      pg_catalog.lower(field_item.value ->> 'fieldId'),
      pg_catalog.jsonb_build_object(
        'token', mapping.physical_column_token,
        'databaseValueType', mapping.database_value_type,
        'type', field_item.value ->> 'type'
      )
      order by field_item.ordinality
    ) filter (where mapping.storage_contract_id is not null), '{}'::jsonb)
  into storage_disagrees, columns_value
  from pg_catalog.jsonb_array_elements(p_fields) with ordinality as field_item(value, ordinality)
  left join vortex_record.field_storage_mappings as mapping
    on mapping.storage_contract_id = p_storage_contract_id
    and mapping.field_id = (field_item.value ->> 'fieldId')::uuid;
  if storage_disagrees then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the installed definition';
  end if;

  -- The one value expression that reads this record type's row.
  select pg_catalog.string_agg(
    field_chunk.pairs_text,
    ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
  )
  into value_expression
  from (
    select (ordered_fields.field_number - 1) / 50 as chunk_index,
      pg_catalog.string_agg(
        pg_catalog.format(
          '%L, %s',
          ordered_fields.key,
          case ordered_fields.value ->> 'databaseValueType'
            when 'decimal' then
              pg_catalog.format('pg_catalog.to_jsonb(%I::text)', ordered_fields.value ->> 'token')
            when 'timestamp_with_time_zone' then
              pg_catalog.format(
                'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', %I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
                ordered_fields.value ->> 'token'
              )
            when 'date' then
              pg_catalog.format(
                'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
                ordered_fields.value ->> 'token'
              )
            else pg_catalog.format('pg_catalog.to_jsonb(%I)', ordered_fields.value ->> 'token')
          end
        ),
        ', ' order by ordered_fields.key collate "C"
      ) as pairs_text
    from (
      select column_entry.key, column_entry.value,
        pg_catalog.row_number() over (
          order by column_entry.key collate "C"
        ) as field_number
      from pg_catalog.jsonb_each(columns_value) as column_entry(key, value)
    ) as ordered_fields
    group by (ordered_fields.field_number - 1) / 50
  ) as field_chunk;

  return pg_catalog.jsonb_build_object(
    'columns', columns_value,
    'valueExpression', value_expression
  );
end
$function$;

alter function vortex_record.named_action_storage_columns_internal(uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.named_action_storage_columns_internal(uuid,jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.named_action_storage_columns_internal(uuid,jsonb) to vortex_record_adapter;

comment on function vortex_record.named_action_storage_columns_internal(uuid,jsonb) is
  'Private column map and row value expression of one record type storage, built only for the record types a named-action facts load reads.';

create or replace function vortex_record.resolve_named_action_context_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  base_context jsonb;
  context_value jsonb;
  installation jsonb;
  binding_value jsonb;
  release_content jsonb;
  release_validation_version text;
  application_content jsonb;
  action_content jsonb;
  action_owner_content jsonb;
  permission_candidates jsonb := '[]'::jsonb;
  permission_keys jsonb;
  permission_key text;
  matched_permission jsonb;
  required_permissions jsonb := '[]'::jsonb;
  named_action_value text;
  event_value jsonb;
  event_descriptor jsonb;
  event_descriptors jsonb := '[]'::jsonb;
  task_value jsonb;
  rules_unsupported boolean := false;
  matched_count integer;
begin
  if p_action_owner_kind is null
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_owner_id = nil_uuid
    or p_action_release_revision is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_action_id is null or p_action_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid then
    raise exception using errcode = '22023', message = 'Named action selector is invalid';
  end if;

  -- This existing fixed resolver owns active installation, target Module,
  -- storage/provision and field-map agreement. It decides no update authority.
  base_context := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, 'update'
  );
  context_value := base_context -> 'context';
  installation := vortex_definition.read_current_active_installation();

  if p_action_owner_kind = 'application' then
    if p_action_owner_id <> (context_value ->> 'applicationRootId')::uuid
      or p_action_release_revision <>
        (installation ->> 'applicationReleaseRevision')::bigint then
      raise exception using errcode = '55000', message = 'Named action owner is not installed';
    end if;
    select release.record_content,
      release.validation_contract_version
    into strict action_owner_content, release_validation_version
    from vortex_definition.releases as release
    where release.root_id = p_action_owner_id
      and release.release_revision = p_action_release_revision;
  else
    select item.value into strict binding_value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
    where (item.value ->> 'moduleRootId')::uuid = p_action_owner_id
      and (item.value ->> 'moduleReleaseRevision')::bigint = p_action_release_revision;
    select release.record_content,
      release.validation_contract_version
    into strict action_owner_content, release_validation_version
    from vortex_definition.releases as release
    where release.root_id = p_action_owner_id
      and release.release_revision = p_action_release_revision;
  end if;

  select item.value into strict action_content
  from pg_catalog.jsonb_array_elements(
    coalesce(action_owner_content -> 'actions', '[]'::jsonb)
  ) as item(value)
  where (item.value ->> 'actionId')::uuid = p_action_id
    and (item.value ->> 'subjectRecordTypeId')::uuid = p_record_type_id;

  permission_keys := case when action_content ? 'permissionKeys'
    then action_content -> 'permissionKeys'
    else pg_catalog.jsonb_build_array(action_content -> 'permissionKey') end;
  if pg_catalog.jsonb_typeof(permission_keys) <> 'array'
    or pg_catalog.jsonb_array_length(permission_keys) = 0 then
    raise exception using errcode = '55000', message = 'Named action permission is unavailable';
  end if;

  -- Collect the exact permission declarations of the active pin set that carry
  -- one of the action's permission keys; only those can match below. Access
  -- remains authoritative for current registrations, assignments and scopes.
  for binding_value in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    select release.record_content into strict release_content
    from vortex_definition.releases as release
    where release.root_id = (binding_value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding_value ->> 'moduleReleaseRevision')::bigint;
    permission_candidates := permission_candidates || coalesce((
      select pg_catalog.jsonb_agg(
        item.value || pg_catalog.jsonb_build_object(
          'ownerKind', 'module',
          'ownerId', (binding_value ->> 'moduleRootId')::uuid
        )
        order by item.ordinality
      )
      from pg_catalog.jsonb_array_elements(
        coalesce(release_content -> 'permissions', '[]'::jsonb)
      ) with ordinality as item(value, ordinality)
      where pg_catalog.jsonb_typeof(item.value -> 'recordScope') = 'object'
        and item.value ->> 'key' in (
          select declared.value #>> '{}'
          from pg_catalog.jsonb_array_elements(permission_keys) as declared(value)
        )
    ), '[]'::jsonb);
    -- #578: the owning Module release's rules are evaluated by Record
    -- (`beforeSaveRules`); a rule for the subject in any other release is not.
    if (binding_value ->> 'moduleRootId')::uuid <>
        (base_context ->> 'moduleRootId')::uuid
      and exists (
        select 1 from pg_catalog.jsonb_array_elements(
          coalesce(release_content -> 'rules', '[]'::jsonb)
        ) as item(value)
        where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text)
      ) then
      rules_unsupported := true;
    end if;
  end loop;

  select release.record_content into strict application_content
  from vortex_definition.releases as release
  where release.root_id = (context_value ->> 'applicationRootId')::uuid
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  permission_candidates := permission_candidates || coalesce((
    select pg_catalog.jsonb_agg(
      item.value || pg_catalog.jsonb_build_object(
        'ownerKind', 'application',
        'ownerId', (context_value ->> 'applicationRootId')::uuid
      )
      order by item.ordinality
    )
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'permissions', '[]'::jsonb)
    ) with ordinality as item(value, ordinality)
    where pg_catalog.jsonb_typeof(item.value -> 'recordScope') = 'object'
      and item.value ->> 'key' in (
        select declared.value #>> '{}'
        from pg_catalog.jsonb_array_elements(permission_keys) as declared(value)
      )
  ), '[]'::jsonb);
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  ) then
    rules_unsupported := true;
  end if;

  for permission_key in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(permission_keys) as item(value)
  loop
    select pg_catalog.count(*), pg_catalog.min(item.value::text)::jsonb
    into matched_count, matched_permission
    from pg_catalog.jsonb_array_elements(permission_candidates) as item(value)
    where item.value ->> 'key' = permission_key;
    if matched_count <> 1
      or matched_permission ->> 'actionKind' <> 'named'
      or (matched_permission ->> 'recordTypeId')::uuid <> p_record_type_id
      or (matched_permission ->> 'namedAction') is null then
      raise exception using errcode = '55000', message = 'Named action permission is ambiguous';
    end if;
    if named_action_value is null then
      named_action_value := matched_permission ->> 'namedAction';
    elsif named_action_value is distinct from matched_permission ->> 'namedAction' then
      raise exception using errcode = '55000', message = 'Named action permission alternatives disagree';
    end if;
    required_permissions := required_permissions || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', (context_value ->> 'applicationRootId')::uuid,
        'ownerKind', matched_permission ->> 'ownerKind',
        'ownerId', (matched_permission ->> 'ownerId')::uuid,
        'permissionId', (matched_permission ->> 'permissionId')::uuid
      )
    );
  end loop;
  select pg_catalog.jsonb_agg(item.value order by
    item.value ->> 'ownerKind' collate "C",
    item.value ->> 'ownerId' collate "C",
    item.value ->> 'permissionId' collate "C")
  into required_permissions
  from pg_catalog.jsonb_array_elements(required_permissions) as item(value);

  for task_value in
    select item.value from pg_catalog.jsonb_array_elements(action_content -> 'tasks')
      with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    if task_value ->> 'type' <> 'event.announce' then continue; end if;
    select item.value into strict event_value
    from pg_catalog.jsonb_array_elements(
      coalesce(action_owner_content -> 'events', '[]'::jsonb)
    ) as item(value)
    where item.value ->> 'key' = task_value #>> '{properties,eventKey}'
      and (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    event_descriptor := pg_catalog.jsonb_build_object(
      'kind', 'declared',
      'owner', case when p_action_owner_kind = 'application'
        then pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', p_action_owner_id
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'module', 'moduleRootId', p_action_owner_id
        ) end,
      'declarationId', event_value -> 'eventId',
      'key', event_value -> 'key',
      'recordTypeId', event_value -> 'recordTypeId',
      'carriedFieldIds', event_value -> 'carriedFieldIds'
    );
    event_descriptors := event_descriptors || pg_catalog.jsonb_build_array(event_descriptor);
  end loop;

  return base_context || pg_catalog.jsonb_build_object(
    'actionOwner', pg_catalog.jsonb_build_object(
      'ownerKind', p_action_owner_kind,
      'ownerId', p_action_owner_id,
      'releaseRevision', p_action_release_revision
    ),
    'action', action_content,
    -- Action values follow the subject Record's owning Module contract. An
    -- Application version cannot reinterpret exact Module field values.
    'validationContractVersion', (
      select release.validation_contract_version
      from vortex_definition.releases as release
      where release.root_id = (base_context ->> 'moduleRootId')::uuid
        and release.release_revision = (base_context ->> 'moduleReleaseRevision')::bigint
    ),
    'eventDescriptors', event_descriptors,
    'rulesUnsupported', rules_unsupported,
    'declaration', pg_catalog.jsonb_build_object(
      'operationKey', action_content -> 'key',
      'action', pg_catalog.jsonb_build_object(
        'actionKind', 'named', 'namedAction', named_action_value
      ),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', (context_value ->> 'applicationRootId')::uuid
      ),
      'requiredPermissions', required_permissions,
      'recordBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', (base_context ->> 'moduleRootId')::uuid,
        'recordTypeId', p_record_type_id,
        'storageContractId', (base_context ->> 'storageContractId')::uuid,
        'storageScope', base_context ->> 'storageScope'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  );
exception
  when no_data_found then
    raise exception using errcode = '55000', message = 'Installed named action is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Installed named action is ambiguous';
end
$function$;

alter function vortex_record.resolve_named_action_context_internal(text,uuid,bigint,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_named_action_context_internal(
  text, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_named_action_context_internal(
  text, uuid, bigint, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.resolve_named_action_context_internal(
  text, uuid, bigint, uuid, uuid
) is
  'Private exact active installed action, permission-alternative and declared-Event resolver for protected named actions.';

CREATE OR REPLACE FUNCTION vortex_record.load_named_action_facts_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  p_action_kind text := 'named';
  action_context jsonb;
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  installation jsonb;
  binding_item jsonb;
  release_content jsonb;
  release_revision_value bigint;
  release_validation_contract_version text;
  module_root_value uuid;
  type_meta jsonb := '{}'::jsonb;
  module_type_meta jsonb;
  storage_disagrees boolean;
  type_columns jsonb;
  target_columns jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  required_permissions jsonb;
  declaration jsonb;
  target_meta jsonb;
  target_table text;
  target_scope text;
  target_module_root_id uuid;
  target_release_revision bigint;
  records_by_id jsonb := '{}'::jsonb;
  candidate_edges jsonb := '[]'::jsonb;
  load_contracts uuid[] := array[]::uuid[];
  load_records uuid[] := array[]::uuid[];
  pair_records uuid[] := array[]::uuid[];
  pair_permissions uuid[] := array[]::uuid[];
  seen_pairs text[] := array[]::text[];
  pair_identity text;
  current_contract uuid;
  current_record uuid;
  current_permission uuid;
  current_meta jsonb;
  current_scope jsonb;
  route_item jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  load_sql text;
  record_fact jsonb;
  target_fact jsonb;
  target_concurrency_number bigint;
  target_definition_revision bigint;
  facts jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_owner_id = nil_uuid
    or p_action_release_revision not between 1 and 9007199254740991
    or p_action_id is null or p_action_id = nil_uuid
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  -- Step 1: the verified request context. The adapter never reads
  -- `current_user`, which is its own owner inside a definer function.
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

  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );

  -- Step 2: the exact active installation. Its reader owns the pin-set and
  -- active-binding rules; this adapter consumes them and adds none.
  installation := vortex_definition.read_current_active_installation();

  -- Step 3: the pinned definitions. Record types, relationships and saved
  -- conditions of every bound Module, plus the declared permissions of the
  -- Application release and of each Module release. Each release is read in a
  -- few set-based statements instead of a PL/pgSQL round trip for every type,
  -- field and permission. Physical tokens are resolved here; a type's column
  -- map and value expression are built only when one of its rows is loaded.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    module_root_value := (binding_item ->> 'moduleRootId')::uuid;
    release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;

    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict release_content, release_validation_contract_version
    from vortex_definition.releases as release
    where release.root_id = module_root_value
      and release.release_revision = release_revision_value;

    if pg_catalog.jsonb_typeof(release_content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;

    -- Every record type must agree with its storage: an active catalogue entry
    -- for this Module and type, provisioned by this release, with an active
    -- column for each declared field.
    select coalesce(pg_catalog.bool_or(
        catalogue.storage_contract_id is null
        or catalogue.state <> 'active'
        or catalogue.module_root_id <> module_root_value
        or catalogue.record_type_id <> (record_type_item.value ->> 'recordTypeId')::uuid
        or catalogue.storage_scope is distinct from (record_type_item.value ->> 'storageScope')
        or not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and catalogue.storage_contract_id = any (provision.storage_contract_ids)
        )
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(record_type_item.value -> 'fields') as field_item(value)
          left join vortex_record.field_storage_mappings as mapping
            on mapping.storage_contract_id = catalogue.storage_contract_id
            and mapping.field_id = (field_item.value ->> 'fieldId')::uuid
          where mapping.storage_contract_id is null or mapping.state <> 'active'
        )
      ), false),
      pg_catalog.jsonb_object_agg(
        pg_catalog.lower(record_type_item.value ->> 'recordTypeId'),
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_root_value,
          'recordTypeId', (record_type_item.value ->> 'recordTypeId')::uuid,
          'storageContractId', (record_type_item.value ->> 'storageContractId')::uuid,
          'storageScope', record_type_item.value ->> 'storageScope',
          'physicalSchemaToken', catalogue.physical_schema_token,
          'ownershipMode', record_type_item.value ->> 'ownershipMode',
          'releaseRevision', release_revision_value,
          'validationContractVersion', release_validation_contract_version,
          'table', catalogue.physical_table_token,
          'fields', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'fieldId', declared.value -> 'fieldId',
                'type', declared.value -> 'type'
              ) || case
                when pg_catalog.jsonb_typeof(declared.value -> 'settings') = 'object'
                  then pg_catalog.jsonb_build_object('settings', declared.value -> 'settings')
                else '{}'::jsonb
              end
              order by declared.ordinality
            )
            from pg_catalog.jsonb_array_elements(record_type_item.value -> 'fields')
              with ordinality as declared(value, ordinality)
          ), '[]'::jsonb)
        ) || case
          when record_type_item.value ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', record_type_item.value -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
        order by record_type_item.ordinality
      )
    into storage_disagrees, module_type_meta
    from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes')
      with ordinality as record_type_item(value, ordinality)
    left join vortex_record.storage_catalogue as catalogue
      on catalogue.storage_contract_id = (record_type_item.value ->> 'storageContractId')::uuid;
    if storage_disagrees then
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    type_meta := type_meta || coalesce(module_type_meta, '{}'::jsonb);

    -- Every declared target, single or polymorphic, as one uniform list;
    -- Access proves a concrete edge target a member of it.
    relationship_by_id := relationship_by_id || coalesce((
      select pg_catalog.jsonb_object_agg(
        pg_catalog.lower(relationship_item.value ->> 'relationshipId'),
        pg_catalog.jsonb_build_object(
          'relationshipId', relationship_item.value -> 'relationshipId',
          'fromModuleRootId', module_root_value,
          'fromRecordTypeId', record_type_item.value -> 'recordTypeId',
          'toRecordTypes', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'moduleRootId', target.value -> 'moduleRootId',
              'recordTypeId', target.value -> 'recordTypeId'
            ) order by target.ordinality)
            from pg_catalog.jsonb_array_elements(
              case when relationship_item.value ? 'toRecordType'
                then pg_catalog.jsonb_build_array(relationship_item.value -> 'toRecordType')
                else relationship_item.value -> 'toRecordTypes'
              end
            ) with ordinality as target(value, ordinality)
          ), '[]'::jsonb)
        )
        order by record_type_item.ordinality, relationship_item.ordinality
      )
      from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes')
        with ordinality as record_type_item(value, ordinality)
      cross join lateral pg_catalog.jsonb_array_elements(record_type_item.value -> 'relationships')
        with ordinality as relationship_item(value, ordinality)
    ), '{}'::jsonb);

    condition_list := condition_list || coalesce((
      select pg_catalog.jsonb_agg(condition_item.value order by condition_item.ordinality)
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'sharingConditions') = 'array'
            then release_content -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) with ordinality as condition_item(value, ordinality)
    ), '[]'::jsonb);

    permission_by_id := permission_by_id || coalesce((
      select pg_catalog.jsonb_object_agg(
        pg_catalog.lower(permission_item.value ->> 'permissionId'),
        pg_catalog.jsonb_build_object(
          'ownerKind', 'module',
          'ownerId', module_root_value,
          'recordTypeId', permission_item.value -> 'recordTypeId',
          'actionKind', permission_item.value -> 'actionKind',
          'namedAction', permission_item.value -> 'namedAction',
          'recordScope', permission_item.value -> 'recordScope'
        )
        order by permission_item.ordinality
      )
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
            then release_content -> 'permissions'
          else '[]'::jsonb
        end
      ) with ordinality as permission_item(value, ordinality)
      where pg_catalog.jsonb_typeof(permission_item.value -> 'recordScope') = 'object'
    ), '{}'::jsonb);
  end loop;

  select release.compilation_output #> '{canonical,content}'
  into strict release_content
  from vortex_definition.releases as release
  where release.root_id = context_application_root_id
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;

  permission_by_id := permission_by_id || coalesce((
    select pg_catalog.jsonb_object_agg(
      pg_catalog.lower(permission_item.value ->> 'permissionId'),
      pg_catalog.jsonb_build_object(
        'ownerKind', 'application',
        'ownerId', context_application_root_id,
        'recordTypeId', permission_item.value -> 'recordTypeId',
        'actionKind', permission_item.value -> 'actionKind',
        'namedAction', permission_item.value -> 'namedAction',
        'recordScope', permission_item.value -> 'recordScope'
      )
      order by permission_item.ordinality
    )
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
          then release_content -> 'permissions'
        else '[]'::jsonb
      end
    ) with ordinality as permission_item(value, ordinality)
    where pg_catalog.jsonb_typeof(permission_item.value -> 'recordScope') = 'object'
  ), '{}'::jsonb);

  target_meta := type_meta -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  if target_meta ->> 'physicalSchemaToken' is distinct from 'record_data' then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the installed definition';
  end if;
  target_columns := vortex_record.named_action_storage_columns_internal(
    (target_meta ->> 'storageContractId')::uuid, target_meta -> 'fields'
  );
  type_columns := pg_catalog.jsonb_build_object(
    target_meta ->> 'storageContractId', target_columns
  );
  target_table := target_meta ->> 'table';
  target_scope := target_meta ->> 'storageScope';
  target_module_root_id := (target_meta ->> 'moduleRootId')::uuid;
  target_release_revision := (target_meta ->> 'releaseRevision')::bigint;

  -- Step 4: the exact named declaration resolved from the installed owner.
  required_permissions := action_context #> '{declaration,requiredPermissions}';
  declaration := action_context -> 'declaration';

  -- Step 5: the target row. The change path locks it here, before any other
  -- row is read, and refuses a stale number without doing the closure work.
  -- Organisation and application isolation is the scope policy's, which is what
  -- makes a foreign row indistinguishable from a missing one.
  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
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
       else ''{}''::jsonb end,
     stored.concurrency_number, stored.definition_revision
     from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2%s',
    target_scope, target_module_root_id, p_record_type_id,
    (target_meta ->> 'storageContractId')::uuid, target_scope,
    target_columns ->> 'valueExpression', target_table,
    case when p_expected_concurrency_number is null then '' else ' for update' end
  );

  execute load_sql
  into record_fact, target_concurrency_number, target_definition_revision
  using context_organization_id, p_record_id;

  if record_fact is null then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;

  if p_expected_concurrency_number is not null
    and target_concurrency_number <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', target_concurrency_number
    );
  end if;

  records_by_id := pg_catalog.jsonb_build_object(
    pg_catalog.lower(p_record_id::text), record_fact
  );
  target_fact := record_fact;

  -- Step 6: the fact closure. Two queues drain into one loop: rows still to
  -- load, and (record, permission) pairs still to expand. A pair is expanded at
  -- most once, which bounds the walk; an inherited-ownership chain is expanded
  -- by pushing the parent under the same permission, so the chase and the
  -- relationship routes use the same mechanism.
  if declaration is not null then
    for route_item in
      select item.value from pg_catalog.jsonb_array_elements(required_permissions) as item(value)
    loop
      pair_records := pg_catalog.array_append(pair_records, p_record_id);
      pair_permissions := pg_catalog.array_append(
        pair_permissions, (route_item ->> 'permissionId')::uuid
      );
    end loop;
  end if;

  while coalesce(pg_catalog.array_length(load_records, 1), 0) > 0
    or coalesce(pg_catalog.array_length(pair_records, 1), 0) > 0
  loop
    if coalesce(pg_catalog.array_length(load_records, 1), 0) > 0 then
      current_contract := load_contracts[pg_catalog.array_length(load_contracts, 1)];
      current_record := load_records[pg_catalog.array_length(load_records, 1)];
      load_contracts := load_contracts[1:pg_catalog.array_length(load_contracts, 1) - 1];
      load_records := load_records[1:pg_catalog.array_length(load_records, 1) - 1];

      if records_by_id ? pg_catalog.lower(current_record::text) then
        continue;
      end if;

      select meta.value into current_meta
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
      where (meta.value ->> 'storageContractId')::uuid = current_contract
      limit 1;
      if current_meta is null then
        continue;
      end if;
      if current_meta ->> 'physicalSchemaToken' is distinct from 'record_data' then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      if not (type_columns ? (current_meta ->> 'storageContractId')) then
        type_columns := type_columns || pg_catalog.jsonb_build_object(
          current_meta ->> 'storageContractId',
          vortex_record.named_action_storage_columns_internal(
            (current_meta ->> 'storageContractId')::uuid, current_meta -> 'fields'
          )
        );
      end if;

      load_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(
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
           else ''{}''::jsonb end
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2',
        current_meta ->> 'storageScope', (current_meta ->> 'moduleRootId')::uuid,
        (current_meta ->> 'recordTypeId')::uuid, current_contract,
        current_meta ->> 'storageScope',
        type_columns #>> array[current_meta ->> 'storageContractId', 'valueExpression'],
        current_meta ->> 'table'
      );

      execute load_sql into record_fact using context_organization_id, current_record;
      if record_fact is not null then
        records_by_id := records_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(current_record::text), record_fact
        );
      end if;
      continue;
    end if;

    current_record := pair_records[pg_catalog.array_length(pair_records, 1)];
    current_permission := pair_permissions[pg_catalog.array_length(pair_permissions, 1)];
    pair_records := pair_records[1:pg_catalog.array_length(pair_records, 1) - 1];
    pair_permissions := pair_permissions[1:pg_catalog.array_length(pair_permissions, 1) - 1];

    pair_identity := pg_catalog.lower(current_record::text) || ':'
      || pg_catalog.lower(current_permission::text);
    if pair_identity = any (seen_pairs) then
      continue;
    end if;
    seen_pairs := pg_catalog.array_append(seen_pairs, pair_identity);

    record_fact := records_by_id -> pg_catalog.lower(current_record::text);
    if record_fact is null then
      continue;
    end if;
    current_meta := type_meta -> pg_catalog.lower(
      record_fact -> 'recordScope' ->> 'recordTypeId'
    );
    current_scope := permission_by_id -> pg_catalog.lower(current_permission::text)
      -> 'recordScope';
    if current_meta is null or current_scope is null then
      continue;
    end if;

    -- Inherited ownership: push the declared parent under the same permission,
    -- which repeats for the grandparent when that pair is expanded.
    if current_meta ->> 'ownershipMode' = 'inherited'
      and current_meta ? 'ownershipRelationshipId'
      and exists (
        select 1 from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
        where route.value ->> 'kind' = 'ownership'
      ) then
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (current_meta ->> 'ownershipRelationshipId')::uuid
          and edge.from_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.from_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(load_contracts, edge_row.to_storage_contract_id);
        load_records := pg_catalog.array_append(load_records, edge_row.to_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.to_record_id);
        pair_permissions := pg_catalog.array_append(pair_permissions, current_permission);
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end if;

    -- Relationship routes: the target is always the `to` endpoint, so the
    -- sources this permission can reach it through are the `from` rows of that
    -- relationship's edges, each expanded under its own source permission.
    for route_item in
      select route.value
      from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
      where route.value ->> 'kind' = 'relationship'
    loop
      if not (relationship_by_id ? pg_catalog.lower(route_item ->> 'relationshipId')) then
        continue;
      end if;
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (route_item ->> 'relationshipId')::uuid
          and edge.to_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.to_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(
          load_contracts, edge_row.from_storage_contract_id
        );
        load_records := pg_catalog.array_append(load_records, edge_row.from_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.from_record_id);
        pair_permissions := pg_catalog.array_append(
          pair_permissions, (route_item ->> 'sourcePermissionId')::uuid
        );
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end loop;
  end loop;

  -- Step 7: the facts. Every record type, relationship and saved condition of
  -- the installed definitions; the records the closure reached; and exactly the
  -- edges whose endpoints are both present, deduplicated.
  facts := pg_catalog.jsonb_build_object(
    'binding', declaration -> 'recordBinding',
    'recordTypes', coalesce((
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
    ), '[]'::jsonb),
    'relationships', coalesce((
      select pg_catalog.jsonb_agg(declared.value order by declared.key collate "C")
      from pg_catalog.jsonb_each(relationship_by_id) as declared(key, value)
    ), '[]'::jsonb),
    'sharingConditions', condition_list,
    'records', coalesce((
      select pg_catalog.jsonb_agg(stored.value order by stored.key collate "C")
      from pg_catalog.jsonb_each(records_by_id) as stored(key, value)
    ), '[]'::jsonb),
    'edges', coalesce((
      select pg_catalog.jsonb_agg(distinct edge.value)
      from pg_catalog.jsonb_array_elements(candidate_edges) as edge(value)
      where records_by_id ? pg_catalog.lower(edge.value ->> 'fromRecordId')
        and records_by_id ? pg_catalog.lower(edge.value ->> 'toRecordId')
    ), '[]'::jsonb)
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'loaded',
    'context', context_value,
    'declaration', declaration,
    'facts', facts,
    'table', target_table,
    'columns', target_columns -> 'columns',
    'concurrencyNumber', target_concurrency_number,
    'definitionRevision', target_definition_revision,
    'moduleReleaseRevision', target_release_revision,
    'actionContext', action_context,
    'fieldValues', target_fact -> 'fieldValues'
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

alter function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) owner to vortex_record_adapter;

revoke all on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) to vortex_record_adapter;

comment on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) is
  'Private static named-action facts loader reusing the complete existing Access record-scope closure without requiring ordinary read or update authority.';

reset role;
