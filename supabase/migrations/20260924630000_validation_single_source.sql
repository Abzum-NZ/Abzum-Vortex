-- #1076: keep each validation rule in one place.
--
-- Semantic lists that SQL must enforce at the storage boundary are read from
-- one reference table instead of a hand-copied literal inside each function.
-- The TypeScript contracts stay the authored source; every seed row below names
-- the symbol it is generated from, so a contract change is a single seed edit
-- and never a second list to keep in step.
--
-- Moved into the reference table:
--   * metering_forbidden_dimension_word
--       contracts/src/operation-contracts.ts: meteringForbiddenDimensionWords
--   * private_invalidation_topic_prefix
--       runtime/event/src/invalidation-channel.ts: privateInvalidationTopicPrefix
--   * private_invalidation_change_kind
--       contracts/src/operation-contracts.ts: liveInvalidationSchema.changeKind
--
-- Removed from SQL because SQL does not need to enforce it:
--   * the search-entry priority/weight mapping in
--     vortex_search.document_entries_are_valid (runtime/search/src/document-store.ts
--     is the only producer, which derives weight from priority).
--
-- Removed unreachable and stale checks:
--   * the connection destination-key keyword blacklist in
--     connection_instances_destination_key_valid: the identifier pattern on the
--     same constraint already rejects every value containing a colon, slash or
--     space, so the blacklist can never match.
--   * the stale parity comment in
--     vortex_access.resolve_record_field_bounds_internal that named the deleted
--     contracts/src/record-field-access.ts.

begin;

-- ----------------------------------------------------------------------------
-- One reference table for every semantic list SQL still enforces.
-- ----------------------------------------------------------------------------
create table vortex_access.validation_reference_values (
  reference_list text not null,
  reference_value text not null,
  reference_ordinal integer not null,
  constraint validation_reference_values_key
    primary key (reference_list, reference_value),
  constraint validation_reference_values_ordinal_unique
    unique (reference_list, reference_ordinal),
  constraint validation_reference_values_list_shape check (
    reference_list = pg_catalog.btrim(reference_list)
    and pg_catalog.char_length(reference_list) between 1 and 80
    and reference_list ~ '^[a-z][a-z0-9_]*$'
  ),
  constraint validation_reference_values_value_shape check (
    reference_value = pg_catalog.btrim(reference_value)
    and pg_catalog.char_length(reference_value) between 1 and 200
  ),
  constraint validation_reference_values_ordinal_range check (
    reference_ordinal between 1 and 10000
  )
);

alter table vortex_access.validation_reference_values enable row level security;

alter table vortex_access.validation_reference_values owner to postgres;

revoke all on table vortex_access.validation_reference_values
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- Seeded from the TypeScript symbols named above; the list is the single SQL
-- home for each value and no function repeats a literal.
insert into vortex_access.validation_reference_values (
  reference_list, reference_value, reference_ordinal
) values
  ('metering_forbidden_dimension_word', 'amount', 1),
  ('metering_forbidden_dimension_word', 'billing', 2),
  ('metering_forbidden_dimension_word', 'charge', 3),
  ('metering_forbidden_dimension_word', 'chargeable', 4),
  ('metering_forbidden_dimension_word', 'cost', 5),
  ('metering_forbidden_dimension_word', 'credential', 6),
  ('metering_forbidden_dimension_word', 'currency', 7),
  ('metering_forbidden_dimension_word', 'customer', 8),
  ('metering_forbidden_dimension_word', 'invoice', 9),
  ('metering_forbidden_dimension_word', 'password', 10),
  ('metering_forbidden_dimension_word', 'payment', 11),
  ('metering_forbidden_dimension_word', 'plan', 12),
  ('metering_forbidden_dimension_word', 'price', 13),
  ('metering_forbidden_dimension_word', 'pricing', 14),
  ('metering_forbidden_dimension_word', 'secret', 15),
  ('metering_forbidden_dimension_word', 'subscription', 16),
  ('private_invalidation_topic_prefix', 'vortex:invalidation', 1),
  ('private_invalidation_change_kind', 'created', 1),
  ('private_invalidation_change_kind', 'changed', 2),
  ('private_invalidation_change_kind', 'deleted', 3),
  ('private_invalidation_change_kind', 'restored', 4),
  ('private_invalidation_change_kind', 'access_changed', 5);

comment on table vortex_access.validation_reference_values is
  'Single SQL home for the semantic lists SQL must enforce; each row is generated from the named TypeScript contract symbol, so a contract change is one seed edit.';

-- The ordered values of one list. Security definer so callers never hold direct
-- table access, and stable because it reads the reference table.
create function vortex_access.validation_reference_list(p_list text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.array_agg(reference.reference_value order by reference.reference_ordinal),
    array[]::text[]
  )
  from vortex_access.validation_reference_values as reference
  where reference.reference_list = p_list;
$function$;

alter function vortex_access.validation_reference_list(text) owner to postgres;

revoke all on function vortex_access.validation_reference_list(text)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.validation_reference_list(text)
to vortex_request, vortex_runtime, vortex_record_owner, vortex_record_adapter;

-- ----------------------------------------------------------------------------
-- 1. Metering dimensions: forbidden words now come from the reference table.
-- Complete live body from 20260923210000_metering_events.sql, with the literal
-- word array replaced by the list read, and IMMUTABLE/PARALLEL SAFE dropped
-- because the function now reads a table.
-- ----------------------------------------------------------------------------
create or replace function vortex_access.metering_event_dimensions_are_valid(p_dimensions jsonb)
returns boolean
language sql
stable
strict
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_typeof(p_dimensions) = 'object'
    and pg_catalog.pg_column_size(p_dimensions) <= 4096
    and (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_dimensions)
    ) <= 16
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_dimensions) as entry(key, value)
      where pg_catalog.length(entry.key) > 40
        or entry.key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
        or pg_catalog.string_to_array(entry.key, '_')
          && vortex_access.validation_reference_list('metering_forbidden_dimension_word')
        or not (
          (pg_catalog.jsonb_typeof(entry.value) = 'string'
            and pg_catalog.length(entry.value #>> '{}') between 1 and 120
            and (entry.value #>> '{}') ~ '^[a-z0-9](?:[a-z0-9_.:-]*[a-z0-9])?$')
          or pg_catalog.jsonb_typeof(entry.value) = 'boolean'
          or (pg_catalog.jsonb_typeof(entry.value) = 'number'
            and (entry.value #>> '{}') ~ '^-?[0-9]+$'
            and (entry.value #>> '{}')::numeric
              between -9007199254740991 and 9007199254740991)
        )
    );
$function$;

-- ----------------------------------------------------------------------------
-- 2. Private invalidation topic: prefix now comes from the reference table.
-- Complete live bodies from 20260924380000_private_invalidation_channels.sql,
-- with the literal prefix replaced by the list read on the formatter and both
-- parsers. IMMUTABLE is dropped because the functions now read a table.
-- ----------------------------------------------------------------------------
create or replace function vortex_invalidation.change_topic(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when p_organization_id is null or p_application_root_id is null then null
    else (
      vortex_access.validation_reference_list('private_invalidation_topic_prefix')
    )[1]
      || ':' || p_organization_id::text || ':' || p_application_root_id::text
  end
$function$;

create or replace function vortex_invalidation.topic_organization_id(p_topic text)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when p_topic ~ (
      '^'
      || (
        vortex_access.validation_reference_list('private_invalidation_topic_prefix')
      )[1]
      || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
      || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
      then pg_catalog.split_part(p_topic, ':', 3)::uuid
    else null
  end
$function$;

create or replace function vortex_invalidation.topic_application_root_id(p_topic text)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when p_topic ~ (
      '^'
      || (
        vortex_access.validation_reference_list('private_invalidation_topic_prefix')
      )[1]
      || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
      || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
      then pg_catalog.split_part(p_topic, ':', 4)::uuid
    else null
  end
$function$;

create or replace function vortex_invalidation.publish_change_notice(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_record_version bigint,
  p_change_kind text,
  p_data_version bigint,
  p_sequence bigint,
  p_correlation_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  selected_topic text;
  selected_payload jsonb;
  stored_context text;
begin
  if p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_record_type_id is null
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or (p_record_id is not null and not vortex_context.is_non_nil_uuid(p_record_id::text))
    or (p_record_version is not null
      and p_record_version not between 1 and 9007199254740991)
    or p_change_kind is null
    or not (
      p_change_kind = any (
        vortex_access.validation_reference_list('private_invalidation_change_kind')
      )
    )
    or p_data_version is null
    or p_data_version not between 1 and 9007199254740991
    or p_sequence is null
    or p_sequence not between 1 and 9007199254740991
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text) then
    raise exception using errcode = '22023',
      message = 'Invalidation notice command is invalid';
  end if;

  stored_context := pg_catalog.current_setting('vortex.request_context', true);
  if stored_context is not null and stored_context <> ''
    and (vortex_context.current_context() ->> 'organizationId')::uuid
      is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Invalidation notice scope is unavailable';
  end if;

  if not exists (
    select 1
    from vortex_identity.organizations as organization
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where organization.organization_id = p_organization_id
      and organization.state = 'active'
      and tenant.state = 'active'
  ) or not vortex_invalidation.application_is_installed(
    p_organization_id, p_application_root_id
  ) then
    raise exception using errcode = 'P0002',
      message = 'Invalidation notice scope is unavailable';
  end if;

  selected_topic := vortex_invalidation.change_topic(p_organization_id, p_application_root_id);

  selected_payload := pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'recordTypeId', p_record_type_id,
    'changeKind', p_change_kind,
    'dataVersion', p_data_version,
    'sequence', p_sequence,
    'occurredAt', pg_catalog.to_char(operation_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', p_correlation_id
  )
  || case when p_record_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('recordId', p_record_id) end
  || case when p_record_version is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('recordVersion', p_record_version) end;

  perform realtime.send(selected_payload, 'invalidation', selected_topic, true);

  return selected_topic;
end
$function$;

-- ----------------------------------------------------------------------------
-- 3. Search entries: the priority/weight mapping is removed. Complete live body
-- from 20260924020000_organisation_search_documents.sql, unchanged except that
-- the mapping clause is gone; runtime/search/src/document-store.ts is the only
-- producer and already derives weight from priority, so SQL keeps only the
-- entry shape, type, size and uniqueness invariants.
-- ----------------------------------------------------------------------------
create or replace function vortex_search.document_entries_are_valid(p_entries jsonb)
returns boolean
language sql immutable strict parallel safe security invoker set search_path = ''
as $function$
  select case
    when pg_catalog.jsonb_typeof(p_entries) <> 'array' then false
    else pg_catalog.jsonb_array_length(p_entries) <= 100
      and pg_catalog.pg_column_size(p_entries) <= 262144
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_entries) as entry(value)
        where pg_catalog.jsonb_typeof(entry.value) <> 'object'
          or not (entry.value ?& array['fieldId', 'priority', 'weight', 'text'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(entry.value)) <> 4
          or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') <> 'string'
          or (entry.value ->> 'fieldId') !~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          or pg_catalog.jsonb_typeof(entry.value -> 'priority') <> 'string'
          or pg_catalog.jsonb_typeof(entry.value -> 'weight') <> 'number'
          or pg_catalog.jsonb_typeof(entry.value -> 'text') <> 'string'
          or pg_catalog.length(entry.value ->> 'text') not between 1 and 4000
      )
      and (
        select pg_catalog.count(distinct entry.value ->> 'fieldId') = pg_catalog.count(*)
          and coalesce(pg_catalog.sum(pg_catalog.length(entry.value ->> 'text')), 0) <= 20000
        from pg_catalog.jsonb_array_elements(p_entries) as entry(value)
      )
  end;
$function$;

-- ----------------------------------------------------------------------------
-- 4. Field-bounds resolver: the stale parity comment is removed. Complete live
-- body from 20260910094534_resolve_record_field_bounds.sql with the in-place
-- change from 20260924200000_refuse_null_inputs_and_inactive_people.sql
-- (outcome is distinct from 'allowed') carried over, and the comment no longer
-- names the deleted contracts/src/record-field-access.ts.
-- ----------------------------------------------------------------------------
create or replace function vortex_access.resolve_record_field_bounds_internal(
  p_decision jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  decision_organization_id uuid := (p_decision ->> 'organizationId')::uuid;
  contribution jsonb;
  contribution_permission jsonb;
  contribution_source jsonb;
  contribution_route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  policy_changeable text[];
  readable_ids text[] := array[]::text[];
  changeable_ids text[] := array[]::text[];
begin
  if p_decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode = '22023',
      message = 'Record field bounds require an allowed decision';
  end if;

  for contribution in
    select value
    from pg_catalog.jsonb_array_elements(p_decision -> 'matchedContributions') as item(value)
  loop
    contribution_permission := contribution -> 'permission';
    contribution_source := contribution -> 'source';
    contribution_route := contribution -> 'route';

    -- The current catalogue entry for this contribution's exact permission.
    -- Mirrors vortex_access.read_available_permission's own current-entry
    -- join: entry joined to its owning registration, filtered to 'active'.
    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = decision_organization_id
      and entry.application_root_id = (contribution_permission ->> 'applicationRootId')::uuid
      and entry.owner_kind = contribution_permission ->> 'ownerKind'
      and entry.owner_id = (contribution_permission ->> 'ownerId')::uuid
      and entry.permission_id = (contribution_permission ->> 'permissionId')::uuid;

    -- The decision just used this exact permission; a missing catalogue
    -- entry now is an internal inconsistency, not an ordinary refusal.
    if not found then
      raise exception using errcode = '22023',
        message = 'Record field bounds found no catalogue entry';
    end if;

    -- A superseded release would otherwise silently supply the policy. Eight
    -- fields are compared: the five identity/release fields plus
    -- validationContractVersion, contentFingerprint and
    -- resolutionFingerprint, so a release that changed only its content or
    -- resolution evidence (revision and version unchanged) is caught too.
    if catalogue_entry.source_kind is distinct from (contribution_source ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (contribution_source ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (contribution_source ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (contribution_source ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (contribution_source ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (contribution_source ->> 'validationContractVersion')
      or catalogue_entry.source_content_fingerprint
        is distinct from (contribution_source ->> 'contentFingerprint')
      or catalogue_entry.source_resolution_fingerprint
        is distinct from (contribution_source ->> 'resolutionFingerprint') then
      raise exception using errcode = '22023',
        message = 'Record field bounds found a superseded permission source';
    end if;

    -- No declared field policy means this contribution contributes no
    -- fields; it must not veto a different contribution that has one.
    if catalogue_entry.field_policy is null then
      continue;
    end if;

    -- A direct_share route can only narrow the permission's own policy, so
    -- readable/changeable fields are kept only when the route also names
    -- them; every other route kind contributes the policy as declared.
    select pg_catalog.array_agg(pg_catalog.lower(field.value))
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'readableFieldIds'
    ) as field(value)
    where contribution_route ->> 'kind' is distinct from 'direct_share'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          contribution_route -> 'readableFieldIds'
        ) as shared(value)
        where pg_catalog.lower(shared.value) = pg_catalog.lower(field.value)
      );

    select pg_catalog.array_agg(pg_catalog.lower(field.value))
    into policy_changeable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'changeableFieldIds'
    ) as field(value)
    where contribution_route ->> 'kind' is distinct from 'direct_share'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          contribution_route -> 'changeableFieldIds'
        ) as shared(value)
        where pg_catalog.lower(shared.value) = pg_catalog.lower(field.value)
      );

    readable_ids := readable_ids || coalesce(policy_readable, array[]::text[]);
    changeable_ids := changeable_ids || coalesce(policy_changeable, array[]::text[]);
  end loop;

  readable_ids := array(
    select distinct field.value
    from pg_catalog.unnest(readable_ids) as field(value)
    order by field.value
  );
  -- Changeable never exceeds readable, because every contribution's own
  -- changeable set already sits inside its own readable set: the policy
  -- validator enforces that for a permission, and the direct-share table
  -- enforces it for a share. Unioning subsets preserves it, so this only
  -- canonicalises.
  changeable_ids := array(
    select distinct field.value
    from pg_catalog.unnest(changeable_ids) as field(value)
    order by field.value
  );

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(readable_ids),
    'changeableFieldIds', pg_catalog.to_jsonb(changeable_ids)
  );
end
$function$;

-- ----------------------------------------------------------------------------
-- 5. Connection destination key: drop the keyword blacklist that can never
-- match. Every other clause of the constraint is unchanged.
-- ----------------------------------------------------------------------------
alter table vortex_connection.connection_instances
  drop constraint connection_instances_destination_key_valid;

alter table vortex_connection.connection_instances
  add constraint connection_instances_destination_key_valid check (
    destination_key = pg_catalog.btrim(destination_key)
    and pg_catalog.char_length(destination_key) between 1 and 80
    and destination_key ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'
  );

commit;
