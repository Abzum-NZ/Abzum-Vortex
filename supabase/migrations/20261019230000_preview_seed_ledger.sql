-- Seed a preview by demand through a per-record-type seed ledger (#3078, part of #3061).
-- seed_preview_installation no longer copies every record type of a preview at once: it takes a
-- demand (the record types visible readers need, the fields they show and the relationship paths
-- they follow), lets the database decide the closure from the preview's own releases and the
-- builder's live access plan, and seeds each closure record type not yet in the new ledger
-- vortex_definition.preview_installation_seeds. Demanding seeded record types again is a no-op.
-- The ledger replaces preview_installations.seeded_at and seed_bounded_record_type_ids; the new
-- seedable flag records whether the installed Application can seed the preview. The derived-field
-- backfill of a preview lists only ledger record types whose derived fields are not worked out
-- yet, and its last page per record type marks them worked out. A refresh keeps the ledger and
-- marks a seeded record type whose totals or stored calculations changed as not worked out.
-- Existing previews are removed: they are rebuilt on the next Studio read.
set local role vortex_owner;

delete from vortex_definition.preview_installations;

alter table vortex_definition.preview_installations
  drop column seeded_at,
  drop column seed_bounded_record_type_ids,
  add column seedable boolean not null;

create table vortex_definition.preview_installation_seeds (
  preview_installation_id uuid not null
    references vortex_definition.preview_installations (preview_installation_id) on delete cascade,
  record_type_id uuid not null,
  seeded_at timestamptz not null,
  -- Whether the seed reached the preview bound of 2,000 readable records.
  bounded boolean not null,
  -- When its totals and stored calculations were worked out; null while they are pending.
  derived_ready_at timestamptz,
  constraint preview_installation_seeds_pkey primary key (preview_installation_id, record_type_id)
);
alter table vortex_definition.preview_installation_seeds enable row level security;
alter table vortex_definition.preview_installation_seeds force row level security;
create policy preview_installation_seeds_owner
  on vortex_definition.preview_installation_seeds
  to vortex_owner using (true) with check (true);
revoke all on table vortex_definition.preview_installation_seeds
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
comment on table vortex_definition.preview_installation_seeds is
  'The seed ledger of one preview: each record type seeded with its builder''s live records, whether that seed reached the preview bound, and when its derived fields were worked out.';

create or replace function vortex_definition.preview_demand_closure_internal(
  p_preview_installation_id uuid,
  p_demand jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_row vortex_definition.preview_installations%rowtype;
  live_plan jsonb;
  module_item jsonb;
  record_type_item jsonb;
  relationship_item jsonb;
  field_item jsonb;
  demand_item jsonb;
  path_item jsonb;
  step_item jsonb;
  permission_item jsonb;
  route_item jsonb;
  ends jsonb;
  storage_ids text[];
  definitions jsonb := '{}'::jsonb;
  -- Every relationship of the preview's record types and of the live plan, by id: the record type
  -- that declares it and each record type it may point to.
  relationships jsonb := '{}'::jsonb;
  derived_ids text[] := array[]::text[];
  totals_over jsonb := '{}'::jsonb;
  pending text[] := array[]::text[];
  closure text[] := array[]::text[];
  current_id text;
  demanded_id text;
begin
  select preview.* into strict preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id;
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(identity.value ->> 'recordTypeId')),
      array[]::text[])
  into storage_ids
  from pg_catalog.jsonb_array_elements(preview_row.storage_identities) as identity(value);

  if pg_catalog.jsonb_typeof(p_demand) is distinct from 'object'
    or exists (select 1 from pg_catalog.jsonb_object_keys(p_demand) as key(value)
      where key.value <> 'recordTypes')
    or pg_catalog.jsonb_typeof(p_demand -> 'recordTypes') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_demand -> 'recordTypes') not between 1 and 201 then
    raise exception using errcode = '22023', message = 'Preview demand is invalid';
  end if;
  for demand_item in
    select item.value from pg_catalog.jsonb_array_elements(p_demand -> 'recordTypes') as item(value)
  loop
    -- A demand names one of the preview's own record types, the fields its visible readers show
    -- and the relationship paths their predicates and sorts follow.
    if pg_catalog.jsonb_typeof(demand_item) is distinct from 'object'
      or exists (select 1 from pg_catalog.jsonb_object_keys(demand_item) as key(value)
        where key.value not in ('recordTypeId', 'fieldIds', 'relationshipPaths'))
      or not vortex_platform.is_non_nil_uuid(demand_item ->> 'recordTypeId')
      or pg_catalog.jsonb_typeof(demand_item -> 'fieldIds') is distinct from 'array'
      or pg_catalog.jsonb_array_length(demand_item -> 'fieldIds') > 500
      or exists (select 1 from pg_catalog.jsonb_array_elements(demand_item -> 'fieldIds') as id(value)
        where not vortex_platform.is_non_nil_uuid(id.value #>> '{}'))
      or pg_catalog.jsonb_typeof(demand_item -> 'relationshipPaths') is distinct from 'array'
      or pg_catalog.jsonb_array_length(demand_item -> 'relationshipPaths') > 50
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(demand_item -> 'relationshipPaths') as path(value)
        where pg_catalog.jsonb_typeof(path.value) is distinct from 'array'
          or pg_catalog.jsonb_array_length(path.value) not between 1 and 8
          or exists (select 1 from pg_catalog.jsonb_array_elements(path.value) as step(value)
            where not vortex_platform.is_non_nil_uuid(step.value #>> '{}'))
      )
      or not pg_catalog.lower(demand_item ->> 'recordTypeId') = any (storage_ids) then
      raise exception using errcode = '22023', message = 'Preview demand is invalid';
    end if;
  end loop;

  -- The record types the preview runs, read from its own releases.
  for module_item in
    select item.value
    from pg_catalog.jsonb_array_elements(preview_row.resolved_modules) as item(value)
    order by item.value ->> 'moduleRootId'
  loop
    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(vortex_record.preview_module_record_types_internal(
        p_preview_installation_id, (module_item ->> 'moduleRootId')::uuid,
        (module_item ->> 'moduleReleaseRevision')::bigint
      )) as item(value)
      where not item.value ? 'systemProjection'
    loop
      current_id := pg_catalog.lower(record_type_item ->> 'recordTypeId');
      definitions := definitions || pg_catalog.jsonb_build_object(current_id, record_type_item);
      -- The same fields a derived-field backfill works out: totals and stored calculations.
      if exists (
        select 1 from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
        where field.value ->> 'type' = 'total'
          or (field.value ->> 'type' = 'calculation'
            and field.value #>> '{settings,evaluation}' is distinct from 'read_time')
      ) then
        derived_ids := derived_ids || current_id;
      end if;
      for relationship_item in
        select item.value
        from pg_catalog.jsonb_array_elements(coalesce(record_type_item -> 'relationships', '[]'::jsonb))
          as item(value)
      loop
        relationships := relationships || pg_catalog.jsonb_build_object(
          pg_catalog.lower(relationship_item ->> 'relationshipId'),
          pg_catalog.jsonb_build_object(
            'from', current_id,
            'fromFieldId', pg_catalog.lower(relationship_item ->> 'fromFieldId'),
            'to', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.lower(target.value ->> 'recordTypeId'))
              from pg_catalog.jsonb_array_elements(
                case when relationship_item ? 'toRecordType'
                  then pg_catalog.jsonb_build_array(relationship_item -> 'toRecordType')
                  else coalesce(relationship_item -> 'toRecordTypes', '[]'::jsonb)
                end
              ) as target(value)
            ), '[]'::jsonb)
          )
        );
      end loop;
    end loop;
  end loop;

  -- The builder's live access plan decides which records are copied; the relationships it follows
  -- to decide a record type's records bring their other record types along.
  live_plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_definition.read_current_active_installation()
  );
  for relationship_item in
    select item.value from pg_catalog.jsonb_each(coalesce(live_plan -> 'relationships', '{}'::jsonb))
      as item(key, value)
    where not relationships ? item.key
  loop
    relationships := relationships || pg_catalog.jsonb_build_object(
      pg_catalog.lower(relationship_item ->> 'relationshipId'),
      pg_catalog.jsonb_build_object(
        'from', pg_catalog.lower(relationship_item ->> 'fromRecordTypeId'),
        'to', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.lower(target.value ->> 'recordTypeId'))
          from pg_catalog.jsonb_array_elements(relationship_item -> 'toRecordTypes') as target(value)
        ), '[]'::jsonb)
      )
    );
  end loop;

  -- Which record types total over each record type, for the seed to work their totals out again.
  for current_id, record_type_item in
    select item.key, item.value from pg_catalog.jsonb_each(definitions) as item(key, value)
  loop
    for field_item in
      select field.value
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      where field.value ->> 'type' = 'total'
    loop
      demanded_id := relationships -> pg_catalog.lower(field_item #>> '{settings,relationshipId}')
        ->> 'from';
      if demanded_id is not null then
        totals_over := totals_over || pg_catalog.jsonb_build_object(demanded_id,
          coalesce(totals_over -> demanded_id, '[]'::jsonb) || pg_catalog.to_jsonb(current_id));
      end if;
    end loop;
  end loop;

  -- Each demanded type, the targets of its demanded relationship fields, and the record types on
  -- the relationship paths its visible query follows.
  for demand_item in
    select item.value from pg_catalog.jsonb_array_elements(p_demand -> 'recordTypes') as item(value)
  loop
    demanded_id := pg_catalog.lower(demand_item ->> 'recordTypeId');
    pending := pending || demanded_id;
    for relationship_item in
      select item.value from pg_catalog.jsonb_each(relationships) as item(key, value)
      where item.value ->> 'from' = demanded_id
        and item.value ->> 'fromFieldId' in (
          select pg_catalog.lower(id.value #>> '{}')
          from pg_catalog.jsonb_array_elements(demand_item -> 'fieldIds') as id(value)
        )
    loop
      pending := pending || array(
        select target.value from pg_catalog.jsonb_array_elements_text(relationship_item -> 'to')
          as target(value));
    end loop;
    for path_item in
      select item.value from pg_catalog.jsonb_array_elements(demand_item -> 'relationshipPaths')
        as item(value)
    loop
      for step_item in
        select step.value from pg_catalog.jsonb_array_elements(path_item) as step(value)
      loop
        ends := relationships -> pg_catalog.lower(step_item #>> '{}');
        if ends is not null then
          pending := pending || (ends ->> 'from') || array(
            select target.value from pg_catalog.jsonb_array_elements_text(ends -> 'to') as target(value));
        end if;
      end loop;
    end loop;
  end loop;

  -- Then, transitively: the source types of every total, and every relationship the builder's
  -- access follows to decide a record type's records (its owner and each relationship route).
  while pg_catalog.cardinality(pending) > 0 loop
    current_id := pending[1];
    pending := pending[2:];
    continue when current_id is null or current_id = any (closure)
      or not current_id = any (storage_ids);
    closure := closure || current_id;
    record_type_item := definitions -> current_id;
    for field_item in
      select field.value
      from pg_catalog.jsonb_array_elements(coalesce(record_type_item -> 'fields', '[]'::jsonb))
        as field(value)
      where field.value ->> 'type' = 'total'
    loop
      pending := pending || (relationships
        -> pg_catalog.lower(field_item #>> '{settings,relationshipId}') ->> 'from');
    end loop;
    for ends in
      select relationships -> pg_catalog.lower(owner.value)
      from (values (record_type_item ->> 'ownershipRelationshipId'),
        (live_plan -> 'recordTypes' -> current_id ->> 'ownershipRelationshipId')) as owner(value)
      where owner.value is not null
      union all
      select relationships -> pg_catalog.lower(route.value ->> 'relationshipId')
      from pg_catalog.jsonb_each(coalesce(live_plan -> 'permissions', '{}'::jsonb))
        as permission(key, value)
      cross join lateral pg_catalog.jsonb_array_elements(
        coalesce(permission.value #> '{recordScope,routes}', '[]'::jsonb)
      ) as route(value)
      where pg_catalog.lower(permission.value ->> 'recordTypeId') = current_id
        and route.value ->> 'kind' = 'relationship'
    loop
      continue when ends is null;
      pending := pending || (ends ->> 'from') || array(
        select target.value from pg_catalog.jsonb_array_elements_text(ends -> 'to') as target(value));
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'closure', pg_catalog.to_jsonb(closure),
    'derivedRecordTypeIds', pg_catalog.to_jsonb(derived_ids),
    'totalsOver', totals_over
  );
end
$function$;

alter function vortex_definition.preview_demand_closure_internal(uuid, jsonb) owner to vortex_owner;

revoke all on function vortex_definition.preview_demand_closure_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.preview_demand_closure_internal(uuid, jsonb)
  to vortex_owner;
comment on function vortex_definition.preview_demand_closure_internal(uuid, jsonb) is
  'The record types one demand on a preview needs, decided from the preview''s own releases and its builder''s live access plan, never from the caller: each demanded type, the targets of its demanded relationship fields and query relationship paths, and transitively every total''s source type and every relationship the builder''s access follows to decide a type''s records. Also lists the preview''s record types with derived fields and, by record type, the types that total over it. Runs in the installed Application''s own context.';

create or replace function vortex_definition.read_preview_pending_derived_internal(
  p_preview_installation_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
      order by seed.record_type_id), '[]'::jsonb)
  from vortex_definition.preview_installation_seeds as seed
  where seed.preview_installation_id = p_preview_installation_id
    and seed.derived_ready_at is null
$function$;

alter function vortex_definition.read_preview_pending_derived_internal(uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_preview_pending_derived_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_preview_pending_derived_internal(uuid)
  to vortex_record_adapter;
comment on function vortex_definition.read_preview_pending_derived_internal(uuid) is
  'The record types of a preview''s seed ledger whose derived fields are not worked out yet, for the derived-field backfill scope of the request''s validated preview.';

create or replace function vortex_definition.mark_preview_derived_ready_internal(
  p_preview_installation_id uuid,
  p_record_type_id uuid
)
returns void
language sql
volatile
security definer
set search_path = ''
as $function$
  update vortex_definition.preview_installation_seeds as seed
  set derived_ready_at = pg_catalog.statement_timestamp()
  where seed.preview_installation_id = p_preview_installation_id
    and seed.record_type_id = p_record_type_id
    and seed.derived_ready_at is null
$function$;

alter function vortex_definition.mark_preview_derived_ready_internal(uuid, uuid) owner to vortex_owner;

revoke all on function vortex_definition.mark_preview_derived_ready_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.mark_preview_derived_ready_internal(uuid, uuid)
  to vortex_record_adapter;
comment on function vortex_definition.mark_preview_derived_ready_internal(uuid, uuid) is
  'Records in a preview''s seed ledger that one record type''s derived fields are worked out, in the transaction of the backfill''s last page for the request''s validated preview.';

drop function vortex_definition.seed_preview_installation(uuid);

create or replace function vortex_definition.seed_preview_installation(
  p_preview_installation_id uuid,
  p_demand jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  preview_row vortex_definition.preview_installations;
  closure_value jsonb;
  storage_identity jsonb;
  copy_result jsonb;
  record_type_id_value uuid;
  bounded_value boolean;
  seeded_ids text[] := array[]::text[];
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  -- The seed reads the installed Application as its builder reads it: the request runs in the
  -- installed Application's own context, never in the preview.
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  if not checked_context ? 'applicationRootId'
    or nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '')
      is not null then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.application_root_id = (checked_context ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Preview installation is unavailable';
  end if;
  closure_value := vortex_definition.preview_demand_closure_internal(
    p_preview_installation_id, p_demand
  );

  -- Each record type of the closure is seeded once, whole: every field its builder reads live.
  -- Demanding a seeded record type again seeds nothing.
  for storage_identity in
    select identity.value
    from pg_catalog.jsonb_array_elements(preview_row.storage_identities) as identity(value)
    where closure_value -> 'closure' ? pg_catalog.lower(identity.value ->> 'recordTypeId')
      and not exists (
        select 1
        from vortex_definition.preview_installation_seeds as seed
        where seed.preview_installation_id = p_preview_installation_id
          and seed.record_type_id = (identity.value ->> 'recordTypeId')::uuid
      )
    order by identity.value ->> 'previewStorageContractId'
  loop
    record_type_id_value := (storage_identity ->> 'recordTypeId')::uuid;
    bounded_value := false;
    -- Only an installed live type is seedable. New draft types start empty; an existing
    -- catalogue entry alone never makes a source readable through this installation.
    if preview_row.seedable and vortex_record.resolve_preview_seed_source_internal(
      preview_row.organization_id, preview_row.application_root_id,
      (storage_identity ->> 'moduleRootId')::uuid, record_type_id_value,
      (storage_identity ->> 'releaseStorageContractId')::uuid
    ) is not null then
      copy_result := vortex_record.copy_live_records_to_preview_internal(
        p_preview_installation_id, record_type_id_value,
        (storage_identity ->> 'releaseStorageContractId')::uuid,
        (storage_identity ->> 'previewStorageContractId')::uuid
      );
      bounded_value := (copy_result ->> 'bounded')::boolean;
    end if;
    -- A record type with no totals or stored calculations is ready as copied.
    insert into vortex_definition.preview_installation_seeds (
      preview_installation_id, record_type_id, seeded_at, bounded, derived_ready_at
    ) values (
      p_preview_installation_id, record_type_id_value, pg_catalog.statement_timestamp(),
      bounded_value,
      case when closure_value -> 'derivedRecordTypeIds' ? pg_catalog.lower(record_type_id_value::text)
        then null else pg_catalog.statement_timestamp() end
    );
    seeded_ids := seeded_ids || pg_catalog.lower(record_type_id_value::text);
  end loop;

  -- Records new to a total's source change its total: those record types are worked out again.
  update vortex_definition.preview_installation_seeds as seed
  set derived_ready_at = null
  where seed.preview_installation_id = p_preview_installation_id
    and seed.derived_ready_at is not null
    and exists (
      select 1
      from pg_catalog.unnest(seeded_ids) as source(id)
      where closure_value -> 'totalsOver' -> source.id ? pg_catalog.lower(seed.record_type_id::text)
    );
  -- A seeded record type the preview no longer runs, or that no longer has totals or stored
  -- calculations, has nothing left to work out.
  update vortex_definition.preview_installation_seeds as seed
  set derived_ready_at = pg_catalog.statement_timestamp()
  where seed.preview_installation_id = p_preview_installation_id
    and seed.derived_ready_at is null
    and not closure_value -> 'derivedRecordTypeIds' ? pg_catalog.lower(seed.record_type_id::text);

  return pg_catalog.jsonb_build_object(
    'draftRevision', preview_row.draft_revision,
    'closure', closure_value -> 'closure',
    'seeded', pg_catalog.to_jsonb(seeded_ids),
    'pendingDerived', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
        order by seed.record_type_id)
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = p_preview_installation_id
        and seed.derived_ready_at is null
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_definition.seed_preview_installation(uuid, jsonb) owner to vortex_owner;

revoke all on function vortex_definition.seed_preview_installation(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.seed_preview_installation(uuid, jsonb) to vortex_request;
comment on function vortex_definition.seed_preview_installation(uuid, jsonb) is
  'Seeds a preview''s storage with what one demand needs, decided by the database: each record type of the demand''s closure not yet seeded gets the live records its builder reads in the installed Application and only the fields they read there, at most 2,000, and a seed ledger row saying whether it reached that bound and whether its derived fields are worked out. Demanding seeded record types again seeds nothing. A preview never shows more than its builder sees live, plus what they create in it.';

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
  seedable_value boolean;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_releases #>> '{application,draftRevision}' is distinct from p_expected_draft_revision::text
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
;
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

  -- The builder's live records reach the preview only through the installed Application.
  seedable_value := exists (
    select 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = organization_id_value
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = p_application_root_id
      and registration.state = 'active'
  );
  preview_installation_id_value := pg_catalog.gen_random_uuid();
  created_at_value := pg_catalog.statement_timestamp();
  expires_at_value := created_at_value + preview_lifetime;
  insert into vortex_definition.preview_installations (
    preview_installation_id, organization_id, application_root_id,
    draft_revision, application_release_revision, previewer_identity_id,
    previewer_organization_account_id, resolved_modules, storage_identities,
    created_at, expires_at, draft_shape_fingerprint, seedable
  ) values (
    preview_installation_id_value, organization_id_value, p_application_root_id,
    p_expected_draft_revision, application_release_revision_value, identity_id_value,
    organization_account_id_value, '[]'::jsonb, '[]'::jsonb,
    created_at_value, expires_at_value, p_shape_fingerprint, seedable_value
  );
  insert into vortex_definition.preview_releases (
    preview_installation_id, root_id, release_revision, release, dependencies
  )
  select preview_installation_id_value, (item.value #>> '{release,root_id}')::uuid,
    (item.value #>> '{release,release_revision}')::bigint,
    item.value -> 'release', item.value -> 'dependencies'
  from pg_catalog.jsonb_array_elements(p_releases -> 'releases') as item(value);
  perform vortex_definition.write_preview_shape_internal(preview_installation_id_value, false);

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_installation_id_value,
    'organizationId', organization_id_value,
    'applicationRootId', p_application_root_id,
    'draftRevision', p_expected_draft_revision,
    'applicationReleaseRevision', application_release_revision_value,
    'createdAt', created_at_value,
    'expiresAt', expires_at_value,
    'seedable', seedable_value,
    -- Every record type it has storage for: the record types a demand may name.
    'recordTypeIds', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(identity.value ->> 'recordTypeId')
          order by identity.value ->> 'previewStorageContractId'), '[]'::jsonb)
      from vortex_definition.preview_installations as preview
      cross join lateral pg_catalog.jsonb_array_elements(preview.storage_identities)
        as identity(value)
      where preview.preview_installation_id = preview_installation_id_value
    ),
    -- The seeded record types whose derived fields are worked out.
    'derivedReadyRecordTypeIds', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
          order by seed.record_type_id), '[]'::jsonb)
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = preview_installation_id_value
        and seed.derived_ready_at is not null
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
  'Replaces the builder''s 24-hour preview of one Application with a preview of its current draft: the server-compiled release plan, the exact Module pins they and the used Module releases name, the preview''s own permission registration whose draft roles only its builder holds, empty isolated storage for every bound record type, whether the installed Application can seed it with its builder''s live records, and the fingerprint of the draft''s data shape.';

create or replace function vortex_definition.refresh_preview_installation(
  p_preview_installation_id uuid,
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
  preview_row vortex_definition.preview_installations%rowtype;
  draft_revision_value bigint;
  application_release_revision_value bigint;
  expires_at_value timestamptz;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_releases #>> '{application,draftRevision}' is distinct from p_expected_draft_revision::text
    or p_shape_fingerprint is null
    or p_shape_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  -- A preview follows its draft in its own request: its builder, its Application, its address.
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  if not checked_context ? 'applicationRootId'
    or vortex_definition.current_preview_installation_id_internal()
      is distinct from p_preview_installation_id then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.application_root_id = (checked_context ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  -- Reads of the preview (for key share) go on while it moves; a second move waits.
  for no key update;
  if not found then
    raise exception using errcode = '42501', message = 'Preview installation is unavailable';
  end if;
  select draft.draft_revision into draft_revision_value
  from vortex_definition.drafts as draft
  where draft.root_id = preview_row.application_root_id
;
  -- A preview only moves forward, to the current draft revision.
  if not found or draft_revision_value <> p_expected_draft_revision
    or p_expected_draft_revision < preview_row.draft_revision then
    raise exception using errcode = '40001', message = 'Application draft revision changed';
  end if;
  application_release_revision_value := vortex_definition.assert_preview_releases_internal(
    preview_row.organization_id, preview_row.application_root_id, p_releases
  );

  delete from vortex_definition.preview_releases as release
  where release.preview_installation_id = p_preview_installation_id;
  insert into vortex_definition.preview_releases (
    preview_installation_id, root_id, release_revision, release, dependencies
  )
  select p_preview_installation_id, (item.value #>> '{release,root_id}')::uuid,
    (item.value #>> '{release,release_revision}')::bigint,
    item.value -> 'release', item.value -> 'dependencies'
  from pg_catalog.jsonb_array_elements(p_releases -> 'releases') as item(value);
  -- Its registration is written again from the new releases and draft roles.
  delete from vortex_access.preview_permission_entries as entry
  where entry.preview_installation_id = p_preview_installation_id;
  delete from vortex_access.preview_permission_registrations as registration
  where registration.preview_installation_id = p_preview_installation_id;
  expires_at_value := pg_catalog.statement_timestamp() + preview_lifetime;
  -- The release set it runs is written again, in this same request, after the new pins.
  update vortex_definition.preview_installations as preview
  set draft_revision = p_expected_draft_revision,
      application_release_revision = application_release_revision_value,
      draft_shape_fingerprint = p_shape_fingerprint,
      runtime_release_set = null,
      expires_at = expires_at_value
  where preview.preview_installation_id = p_preview_installation_id;
  perform vortex_definition.write_preview_shape_internal(p_preview_installation_id, true);

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', p_preview_installation_id,
    'organizationId', preview_row.organization_id,
    'applicationRootId', preview_row.application_root_id,
    'draftRevision', p_expected_draft_revision,
    'applicationReleaseRevision', application_release_revision_value,
    'createdAt', preview_row.created_at,
    'expiresAt', expires_at_value,
    'seedable', preview_row.seedable,
    -- Every record type it has storage for: the record types a demand may name.
    'recordTypeIds', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(identity.value ->> 'recordTypeId')
          order by identity.value ->> 'previewStorageContractId'), '[]'::jsonb)
      from vortex_definition.preview_installations as preview
      cross join lateral pg_catalog.jsonb_array_elements(preview.storage_identities)
        as identity(value)
      where preview.preview_installation_id = p_preview_installation_id
    ),
    -- The seeded record types whose derived fields are worked out.
    'derivedReadyRecordTypeIds', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
          order by seed.record_type_id), '[]'::jsonb)
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = p_preview_installation_id
        and seed.derived_ready_at is not null
    )
  );
end
$function$;

alter function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text) owner to vortex_owner;

revoke all on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text)
  to vortex_request;
comment on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text) is
  'Moves the builder''s preview, in its own request, to the current draft revision in place: the server-compiled release plan, the Module pins, its permission registration and its Record storage, keeping the records it holds and its seed ledger, and another 24 hours. Its release set is written again in the same request. A change the stored records cannot take raises V3201.';

create or replace function vortex_definition.reconcile_preview_installation(
  p_preview_installation_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  reconcile_interval constant interval := interval '5 minutes';
  checked_context jsonb;
  preview_row vortex_definition.preview_installations;
  storage_identity jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  -- Like the seed, the check runs in the installed Application's own context, never the preview.
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  if not checked_context ? 'applicationRootId'
    or nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '')
      is not null then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.application_root_id = (checked_context ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Preview installation is unavailable';
  end if;
  -- A preview with nothing seeded has nothing to check; a recent check is not repeated.
  if not exists (
      select 1
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = p_preview_installation_id
    )
    or preview_row.reconciled_at > pg_catalog.statement_timestamp() - reconcile_interval then
    return false;
  end if;
  for storage_identity in
    select identity.value
    from pg_catalog.jsonb_array_elements(preview_row.storage_identities) as identity(value)
    -- Only the record types the preview was seeded with hold copies of live records.
    where exists (
      select 1
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = p_preview_installation_id
        and seed.record_type_id = (identity.value ->> 'recordTypeId')::uuid
    )
    and exists (
      select 1
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = (identity.value ->> 'releaseStorageContractId')::uuid
        and catalogue.physical_schema_token = 'record_data'
        and catalogue.state = 'active'
    )
    order by identity.value ->> 'previewStorageContractId'
  loop
    perform vortex_record.reconcile_preview_records_internal(
      (storage_identity ->> 'recordTypeId')::uuid,
      (storage_identity ->> 'releaseStorageContractId')::uuid,
      (storage_identity ->> 'previewStorageContractId')::uuid
    );
  end loop;
  update vortex_definition.preview_installations as preview
  set reconciled_at = pg_catalog.statement_timestamp()
  where preview.preview_installation_id = p_preview_installation_id;
  return true;
end
$function$;

alter function vortex_definition.reconcile_preview_installation(uuid) owner to vortex_owner;

revoke all on function vortex_definition.reconcile_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.reconcile_preview_installation(uuid) to vortex_request;
comment on function vortex_definition.reconcile_preview_installation(uuid) is
  'When a builder opens their preview, decides its copied records again by their current live access, at most every five minutes: a record they can no longer read leaves the preview and a field they can no longer read is emptied. A preview never keeps more than its builder sees live.';

create or replace function vortex_definition.read_builder_preview_installation(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  identity_value jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation identity is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  -- A builder has at most one preview of an Application; the newest is the current one. A
  -- preview whose provisioning stopped before it wrote the release set it runs never runs, so it
  -- is not a current preview: the next request provisions one that replaces it.
  select pg_catalog.jsonb_build_object(
    'previewInstallationId', preview.preview_installation_id,
    'organizationId', preview.organization_id,
    'applicationRootId', preview.application_root_id,
    'definitionKey', root.key,
    'draftRevision', preview.draft_revision,
    'expiresAt', preview.expires_at,
    'seedable', preview.seedable,
    'seededRecordTypeIds', coalesce(seeds.seeded_ids, '[]'::jsonb),
    'derivedReadyRecordTypeIds', coalesce(seeds.ready_ids, '[]'::jsonb),
    -- Every record type it has storage for: the record types a demand may name.
    'recordTypeIds', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(identity.value ->> 'recordTypeId')
          order by identity.value ->> 'previewStorageContractId'), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(preview.storage_identities) as identity(value)
    ),
    'shapeFingerprint', preview.draft_shape_fingerprint,
    -- Copied live records are decided again by the builder's live access at most every five
    -- minutes, counting from the first seed; reconcile_preview_installation keeps the same interval.
    'reconcileDue', seeds.first_seeded_at is not null
      and coalesce(preview.reconciled_at, seeds.first_seeded_at)
        <= pg_catalog.statement_timestamp() - interval '5 minutes'
  ) into identity_value
  from vortex_definition.preview_installations as preview
  join vortex_definition.roots as root on root.root_id = preview.application_root_id
  left join lateral (
    select pg_catalog.min(seed.seeded_at) as first_seeded_at,
      pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
        order by seed.record_type_id) as seeded_ids,
      pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
        order by seed.record_type_id) filter (where seed.derived_ready_at is not null) as ready_ids
    from vortex_definition.preview_installation_seeds as seed
    where seed.preview_installation_id = preview.preview_installation_id
  ) as seeds on true
  where preview.application_root_id = p_application_root_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
    and preview.runtime_release_set is not null
    and root.kind = 'application'
    and root.organization_id = preview.organization_id
  order by preview.created_at desc, preview.preview_installation_id desc
  limit 1;
  return identity_value;
end
$function$;

alter function vortex_definition.read_builder_preview_installation(uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_builder_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_builder_preview_installation(uuid)
  to vortex_request;
comment on function vortex_definition.read_builder_preview_installation(uuid) is
  'The current runnable, unexpired preview of one Application that the builder of the validated human organisation context opened: its draft revision, the fingerprint of the draft data shape it runs, whether it can be seeded, the record types it has storage for, those it was seeded with and those whose derived fields are worked out, and whether its copied live records are due to be decided again; null when they have none. Studio reads the canvas and Data tab records through it.';

create or replace function vortex_definition.read_preview_application_identity(
  p_preview_installation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  identity_value jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation identity is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  select pg_catalog.jsonb_build_object(
    'previewInstallationId', preview.preview_installation_id,
    'organizationId', preview.organization_id,
    'applicationRootId', preview.application_root_id,
    'definitionKey', root.key,
    'draftRevision', preview.draft_revision,
    'expiresAt', preview.expires_at,
    'seedable', preview.seedable,
    'seededRecordTypeIds', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
        order by seed.record_type_id)
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = preview.preview_installation_id
    ), '[]'::jsonb),
    'derivedReadyRecordTypeIds', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
        order by seed.record_type_id)
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = preview.preview_installation_id
        and seed.derived_ready_at is not null
    ), '[]'::jsonb)
  ) into identity_value
  from vortex_definition.preview_installations as preview
  join vortex_definition.roots as root on root.root_id = preview.application_root_id
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
    and root.kind = 'application';
  return identity_value;
end
$function$;

alter function vortex_definition.read_preview_application_identity(uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_preview_application_identity(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_application_identity(uuid)
  to vortex_request;
comment on function vortex_definition.read_preview_application_identity(uuid) is
  'The Application, key and draft revision of one unexpired preview, whether it can be seeded, the record types it holds copied live records of and those whose derived fields are worked out, for the builder of the validated human organisation context who opened it; null when there is no such preview.';

create or replace function vortex_definition.read_preview_runtime_source(
  p_cached_draft_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation_value jsonb;
  preview_row vortex_definition.preview_installations%rowtype;
begin
  installation_value := vortex_definition.read_current_active_installation();
  if not installation_value ? 'previewInstallationId' then
    raise exception using errcode = '42501', message = 'Preview installation address is required';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = (installation_value ->> 'previewInstallationId')::uuid;
  if not found or preview_row.runtime_release_set is null then
    raise exception using errcode = '55000', message = 'Preview release set is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'installation', installation_value,
    'draftRevision', preview_row.draft_revision,
    'expiresAt', preview_row.expires_at,
    'correlationId', vortex_access.validated_human_request_context() ->> 'correlationId',
    -- The release set is written once for each draft revision the preview runs: a caller that
    -- already holds this revision's set gets none.
    'releaseSet', case when preview_row.draft_revision is not distinct from p_cached_draft_revision
      then null else preview_row.runtime_release_set end,
    -- The record types whose seed reached the preview bound, from the seed ledger.
    'seedBoundedRecordTypeIds', coalesce((
      select pg_catalog.jsonb_agg(seed.record_type_id order by seed.record_type_id)
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = preview_row.preview_installation_id
        and seed.bounded
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_definition.read_preview_runtime_source(bigint) owner to vortex_owner;

revoke all on function vortex_definition.read_preview_runtime_source(bigint)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_runtime_source(bigint)
  to vortex_request;
comment on function vortex_definition.read_preview_runtime_source(bigint) is
  'The installation, draft revision, expiry and stored release set of the preview the validated human Application request runs, for the runtime to render it as an installed Application. The release set is left out when the caller already holds the one for the draft revision the preview runs.';

create or replace function vortex_record.evolve_preview_module_storage(
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
  field_value jsonb;
  binding_row vortex_record.preview_storage_bindings%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  release_storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  column_token text;
  database_type text;
  index_token text;
  scope_index_columns text;
  evolved_definition jsonb;
  field_ids uuid[];
  storage_identities jsonb := '[]'::jsonb;
begin
  -- The preview follows its draft in place: each record type keeps its storage and its records,
  -- and only what the new release adds or changes is applied to it. A change its records cannot
  -- take raises V3201, and the caller provisions a new preview instead.
  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(vortex_record.preview_module_record_types_internal(
      p_preview_installation_id, p_module_root_id, p_module_release_revision
    )) as item(value)
    where not item.value ? 'systemProjection'
    order by item.value ->> 'storageContractId'
  loop
    begin
      release_storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    select binding.* into binding_row
    from vortex_record.preview_storage_bindings as binding
    where binding.preview_installation_id = p_preview_installation_id
      and binding.module_root_id = p_module_root_id
      and binding.record_type_id = record_type_id_value
    for update;
    -- A record type the preview did not have yet starts with empty storage.
    if not found then
      storage_identities := storage_identities || pg_catalog.jsonb_build_array(
        vortex_record.provision_preview_record_storage_internal(
          p_preview_installation_id, p_module_root_id, p_module_release_revision, record_type
        )
      );
      continue;
    end if;
    select catalogue.* into strict catalogue_row
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = binding_row.storage_contract_id
      and catalogue.physical_schema_token = 'record_data'
      and catalogue.state = 'active'
    for update;
    if catalogue_row.record_type_definition ->> 'storageScope' is distinct from record_type ->> 'storageScope'
      or catalogue_row.record_type_definition ->> 'ownershipMode' is distinct from record_type ->> 'ownershipMode'
      or pg_catalog.jsonb_typeof(record_type -> 'fields') is distinct from 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') is distinct from 'array' then
      raise exception using errcode = 'V3201', message = 'Preview record storage cannot follow this change';
    end if;
    evolved_definition := pg_catalog.jsonb_set(
      record_type, '{storageContractId}',
      pg_catalog.to_jsonb(binding_row.storage_contract_id::text), true
    );
    -- An unchanged record type keeps its storage exactly as it is: only the release it serves moves.
    if catalogue_row.record_type_definition = evolved_definition then
      if binding_row.module_release_revision <> p_module_release_revision
        or binding_row.release_storage_contract_id is distinct from release_storage_id then
        update vortex_record.storage_catalogue as catalogue
        set first_compatible_release_revision = p_module_release_revision,
            last_compatible_release_revision = p_module_release_revision,
            changed_at = pg_catalog.statement_timestamp()
        where catalogue.storage_contract_id = binding_row.storage_contract_id;
        update vortex_record.field_storage_mappings as mapping
        set introduced_by_module_root_id = p_module_root_id,
            introduced_at_release_revision = p_module_release_revision
        where mapping.storage_contract_id = binding_row.storage_contract_id
          and mapping.state = 'active';
        update vortex_record.preview_storage_bindings as binding
        set module_release_revision = p_module_release_revision,
            release_storage_contract_id = release_storage_id
        where binding.preview_installation_id = p_preview_installation_id
          and binding.storage_contract_id = binding_row.storage_contract_id;
      end if;
      storage_identities := storage_identities || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'moduleRootId', p_module_root_id,
          'moduleReleaseRevision', p_module_release_revision,
          'recordTypeId', record_type_id_value,
          'releaseStorageContractId', release_storage_id,
          'previewStorageContractId', binding_row.storage_contract_id
        )
      );
      continue;
    end if;
    scope_index_columns := case catalogue_row.storage_scope
      when 'organization_shared' then 'organisation_id'
      else 'organisation_id, application_root_id'
    end;
    field_ids := array[]::uuid[];

    for field_value in
      select item.value
      from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
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
      field_ids := field_ids || field_id_value;
      database_type := vortex_record.database_value_type(field_value);
      if database_type is null then
        raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = binding_row.storage_contract_id
        and mapping.field_id = field_id_value
      for update;
      if found then
        -- Stored values keep their meaning only while the field keeps its database type.
        if mapping_row.database_value_type is distinct from database_type then
          raise exception using errcode = 'V3201', message = 'Preview record storage cannot follow this change';
        end if;
        column_token := mapping_row.physical_column_token;
        -- Preview storage serves exactly the one Module release the preview runs, so each mapping
        -- is that release's.
        update vortex_record.field_storage_mappings as mapping
        set field_definition = field_value,
            introduced_by_module_root_id = p_module_root_id,
            introduced_at_release_revision = p_module_release_revision,
            state = 'active',
            retired_by_module_root_id = null,
            retired_at_release_revision = null
        where mapping.storage_contract_id = binding_row.storage_contract_id
          and mapping.field_id = field_id_value;
      else
        -- Records already in the preview have no value for a new field, so the column takes none;
        -- the save path enforces a required field for every record it writes.
        column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
        execute pg_catalog.format(
          'alter table record_data.%I add column %I %s',
          catalogue_row.physical_table_token, column_token, vortex_record.sql_value_type(database_type)
        );
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          binding_row.storage_contract_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
      end if;
      -- Table changes run only where the column or its index actually differs.
      if not (field_value ->> 'required')::boolean and exists (
        select 1
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(
            pg_catalog.format('record_data.%I', catalogue_row.physical_table_token))
          and attribute.attname = column_token
          and attribute.attnotnull
      ) then
        execute pg_catalog.format(
          'alter table record_data.%I alter column %I drop not null',
          catalogue_row.physical_table_token, column_token
        );
      end if;
      index_token := 'pux_' || pg_catalog.md5(
        binding_row.storage_contract_id::text || ':' || field_id_value::text
      );
      if (field_value ->> 'unique')::boolean
        and pg_catalog.to_regclass(pg_catalog.format('record_data.%I', index_token)) is null then
        begin
          execute pg_catalog.format(
            'create unique index %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
            index_token, catalogue_row.physical_table_token, scope_index_columns, column_token
          );
        exception when unique_violation then
          raise exception using errcode = 'V3201', message = 'Preview records repeat a value the draft makes unique';
        end;
      elsif not (field_value ->> 'unique')::boolean
        and pg_catalog.to_regclass(pg_catalog.format('record_data.%I', index_token)) is not null then
        execute pg_catalog.format('drop index record_data.%I', index_token);
      end if;
    end loop;

    -- A field the draft no longer has keeps its column, retired and empty-able, so the records
    -- keep everything else.
    for mapping_row in
      select mapping.*
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = binding_row.storage_contract_id
        and mapping.state = 'active'
        and not (mapping.field_id = any(field_ids))
      order by mapping.field_id
      for update
    loop
      execute pg_catalog.format(
        'alter table record_data.%I alter column %I drop not null',
        catalogue_row.physical_table_token, mapping_row.physical_column_token
      );
      execute pg_catalog.format('drop index if exists record_data.%I', 'pux_' || pg_catalog.md5(
        binding_row.storage_contract_id::text || ':' || mapping_row.field_id::text
      ));
      update vortex_record.field_storage_mappings as mapping
      set state = 'retired',
          retired_by_module_root_id = p_module_root_id,
          retired_at_release_revision = p_module_release_revision
      where mapping.storage_contract_id = binding_row.storage_contract_id
        and mapping.field_id = mapping_row.field_id;
    end loop;

    -- A seeded record type whose totals or stored calculations changed has them worked out again
    -- before it is read.
    if (
      select coalesce(pg_catalog.jsonb_agg(field.value order by field.value ->> 'fieldId'), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(catalogue_row.record_type_definition -> 'fields') as field(value)
      where field.value ->> 'type' = 'total'
        or (field.value ->> 'type' = 'calculation'
          and field.value #>> '{settings,evaluation}' is distinct from 'read_time')
    ) is distinct from (
      select coalesce(pg_catalog.jsonb_agg(field.value order by field.value ->> 'fieldId'), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(evolved_definition -> 'fields') as field(value)
      where field.value ->> 'type' = 'total'
        or (field.value ->> 'type' = 'calculation'
          and field.value #>> '{settings,evaluation}' is distinct from 'read_time')
    ) then
      update vortex_definition.preview_installation_seeds as seed
      set derived_ready_at = null
      where seed.preview_installation_id = p_preview_installation_id
        and seed.record_type_id = record_type_id_value;
    end if;
    update vortex_record.storage_catalogue as catalogue
    set record_type_definition = evolved_definition,
        content_fingerprint = vortex_record.storage_meaning_fingerprint(evolved_definition),
        -- Preview storage serves exactly the one Module release the preview runs.
        first_compatible_release_revision = p_module_release_revision,
        last_compatible_release_revision = p_module_release_revision,
        changed_at = pg_catalog.statement_timestamp()
    where catalogue.storage_contract_id = binding_row.storage_contract_id;
    update vortex_record.preview_storage_bindings as binding
    set module_release_revision = p_module_release_revision,
        release_storage_contract_id = release_storage_id
    where binding.preview_installation_id = p_preview_installation_id
      and binding.storage_contract_id = binding_row.storage_contract_id;
    storage_identities := storage_identities || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', p_module_root_id,
        'moduleReleaseRevision', p_module_release_revision,
        'recordTypeId', record_type_id_value,
        'releaseStorageContractId', release_storage_id,
        'previewStorageContractId', binding_row.storage_contract_id
      )
    );
  end loop;
  return storage_identities;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview record storage is unavailable';
end
$function$;

alter function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint) owner to vortex_owner;

revoke all on function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint)
  to vortex_owner;
comment on function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint) is
  'Moves a preview''s isolated Record storage to a newer exact Module release in place, keeping its records: new record types get empty storage, new fields new empty columns, changed fields their new definition and uniqueness, and removed fields are retired; a seeded record type whose totals or stored calculations changed has them worked out again. A change the stored records cannot take (another database type, storage scope or ownership, or a uniqueness they break) raises V3201.';

set local role vortex_record_adapter;

create or replace function vortex_record.derived_field_backfill_scope_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  installation jsonb;
  plan jsonb;
  binding_item jsonb;
  module_content jsonb;
  record_type_item jsonb;
  record_type_key text;
  type_meta jsonb;
  field_ids jsonb;
  pending_ids jsonb;
  definitions jsonb := '{}'::jsonb;
  targets jsonb := '{}'::jsonb;
begin
  -- Two callers work out derived values: the installation consumer under the dispatcher's
  -- system context for the live installation, and preview seeding under the builder's
  -- human context for the preview's own new storage. Both work out every stored derived field.
  context_value := vortex_platform.current_context();
  if context_value ->> 'callerKind' = 'system' then
    context_value := vortex_access.derived_backfill_context_internal();
    installation := vortex_definition.read_active_installation_for_scope_internal(
      (context_value ->> 'organizationId')::uuid,
      (context_value ->> 'applicationRootId')::uuid
    );
  else
    context_value := vortex_access.validated_human_request_context();
    if not context_value ? 'applicationRootId' then
      raise exception using errcode = '42501',
        message = 'Derived field backfill requires an application context';
    end if;
    installation := vortex_record.read_current_preview_installation_internal();
    if installation is null or installation ->> 'outcome' = 'refused' then
      raise exception using errcode = '42501', message = 'Preview Record context is unavailable';
    end if;
    -- A preview works out only the record types it was seeded with whose derived fields are not
    -- worked out yet, as its seed ledger lists them.
    pending_ids := vortex_definition.read_preview_pending_derived_internal(
      (installation ->> 'previewInstallationId')::uuid
    );
  end if;
  plan := vortex_record.resolve_installation_access_plan_internal(installation);

  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
    order by item.value ->> 'moduleRootId'
  loop
    select release.record_content into strict module_content
    from vortex_definition.runtime_releases as release
    where release.root_id = (binding_item ->> 'moduleRootId')::uuid
      and release.release_revision = (binding_item ->> 'moduleReleaseRevision')::bigint;
    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(coalesce(module_content -> 'recordTypes', '[]'::jsonb))
        as item(value)
    loop
      record_type_key := pg_catalog.lower(record_type_item ->> 'recordTypeId');
      type_meta := plan -> 'recordTypes' -> record_type_key;
      continue when type_meta is null
        or coalesce((type_meta ->> 'isSystemProjection')::boolean, false);
      definitions := definitions || pg_catalog.jsonb_build_object(record_type_key, record_type_item);
      -- The fields a backfill works out: every total and every stored calculation. The
      -- installation consumer also catches up fields from releases superseded while it waited.
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(field.value ->> 'fieldId')
          order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"), '[]'::jsonb)
      into field_ids
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      where field.value ->> 'type' = 'total'
        or (field.value ->> 'type' = 'calculation'
          and field.value #>> '{settings,evaluation}' is distinct from 'read_time');
      -- Every definition stays listed: a total reads its source record type's definition.
      if pg_catalog.jsonb_array_length(field_ids) > 0
        and (pending_ids is null or pending_ids ? record_type_key) then
        targets := targets || pg_catalog.jsonb_build_object(record_type_key, field_ids);
      end if;
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'organizationId', context_value -> 'organizationId',
    'applicationRootId', context_value -> 'applicationRootId',
    'plan', plan,
    'definitions', definitions,
    'targets', targets
  );
end
$function$;

alter function vortex_record.derived_field_backfill_scope_internal() owner to vortex_record_adapter;

revoke all on function vortex_record.derived_field_backfill_scope_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.derived_field_backfill_scope_internal()
  to vortex_record_adapter;
comment on function vortex_record.derived_field_backfill_scope_internal() is
  'Private derived-field backfill scope of the installation consumer''s live installation or the builder''s preview installation: each record type''s definition and the totals and stored calculations a backfill works out for its existing records. A preview lists only the seeded record types whose derived fields are not worked out yet.';

drop function vortex_record.apply_derived_field_backfill(uuid, jsonb);

create or replace function vortex_record.apply_derived_field_backfill(
  p_record_type_id uuid,
  p_records jsonb,
  p_last_page boolean
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope jsonb;
  preview_installation jsonb;
  record_type_key text;
  type_meta jsonb;
  field_ids jsonb;
  application_scope uuid;
  record_item jsonb;
  entry record;
  column_value jsonb;
  assignments text[];
  written_record_id uuid;
  written integer := 0;
begin
  if p_record_type_id is null
    or p_last_page is null
    or pg_catalog.jsonb_typeof(p_records) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_records) > 100 then
    raise exception using errcode = '22023', message = 'Derived field backfill is invalid';
  end if;
  -- With a preview's last page, the record type's derived fields are worked out: its seed ledger
  -- says so in this same transaction. An empty page has nothing else to write.
  if p_last_page then
    preview_installation := vortex_record.read_current_preview_installation_internal();
    if preview_installation is not null then
      perform vortex_definition.mark_preview_derived_ready_internal(
        (preview_installation ->> 'previewInstallationId')::uuid, p_record_type_id
      );
    end if;
  end if;
  if pg_catalog.jsonb_array_length(p_records) = 0 then
    return 0;
  end if;
  scope := vortex_record.derived_field_backfill_scope_internal();
  record_type_key := pg_catalog.lower(p_record_type_id::text);
  field_ids := scope -> 'targets' -> record_type_key;
  type_meta := scope -> 'plan' -> 'recordTypes' -> record_type_key;
  if field_ids is null or type_meta is null then
    raise exception using errcode = '42501', message = 'Derived field backfill target is unavailable';
  end if;
  application_scope := case when type_meta ->> 'storageScope' = 'application_contained'
    then (scope ->> 'applicationRootId')::uuid else null end;

  for record_item in
    select item.value from pg_catalog.jsonb_array_elements(p_records) as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_item) is distinct from 'object'
      or not record_item ?& array['recordId', 'expectedConcurrencyNumber', 'values']
      or pg_catalog.jsonb_typeof(record_item -> 'values') is distinct from 'object'
      or record_item -> 'values' = '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Derived field backfill is invalid';
    end if;
    assignments := array[]::text[];
    -- Only the fields this backfill works out, each value in its column's canonical form.
    for entry in
      select pg_catalog.lower(item.key) as key, item.value
      from pg_catalog.jsonb_each(record_item -> 'values') as item(key, value)
    loop
      column_value := type_meta -> 'columns' -> entry.key;
      if not field_ids ? entry.key or column_value is null
        or not vortex_record.canonical_record_value_matches(
          entry.value, column_value ->> 'type', column_value ->> 'databaseValueType'
        ) then
        raise exception using errcode = '23514', message = 'Derived field backfill value is invalid';
      end if;
      assignments := pg_catalog.array_append(assignments, pg_catalog.format(
        '%I = %s', column_value ->> 'token',
        case when pg_catalog.jsonb_typeof(entry.value) = 'null' then 'null'
        else case column_value ->> 'databaseValueType'
          when 'decimal' then pg_catalog.format('%L::numeric', entry.value #>> '{}')
          when 'timestamp_with_time_zone' then pg_catalog.format('%L::timestamptz', entry.value #>> '{}')
          when 'date' then pg_catalog.format('%L::date', entry.value #>> '{}')
          when 'integer' then pg_catalog.format('%L::bigint', entry.value #>> '{}')
          when 'boolean' then pg_catalog.format('%L::boolean', entry.value #>> '{}')
          when 'json' then pg_catalog.format('%L::jsonb', entry.value::text)
          else pg_catalog.format('%L::text', entry.value #>> '{}') end end
      ));
    end loop;
    -- Working out a new field is not a change anyone made: no Activity or Event, and the
    -- record's last change stays as it was. Its revision moves, so an open form refreshes.
    execute pg_catalog.format(
      'update record_data.%I as stored set %s, concurrency_number = stored.concurrency_number + 1
       where stored.organisation_id = $1
         and stored.application_root_id is not distinct from $2
         and stored.record_id = $3
         and stored.concurrency_number = $4
         and stored.lifecycle_state = ''active''
       returning stored.record_id',
      type_meta ->> 'table', pg_catalog.array_to_string(assignments, ', ')
    ) into written_record_id
    using (scope ->> 'organizationId')::uuid, application_scope,
      (record_item ->> 'recordId')::uuid, (record_item ->> 'expectedConcurrencyNumber')::bigint;
    if written_record_id is null then
      raise exception using errcode = '40001', message = 'Derived field backfill record changed';
    end if;
    written := written + 1;
  end loop;

  if written > 0 then
    perform vortex_record.bump_record_data_version_internal(
      (scope ->> 'organizationId')::uuid, (type_meta ->> 'storageContractId')::uuid,
      application_scope
    );
  end if;
  return written;
end
$function$;

alter function vortex_record.apply_derived_field_backfill(uuid, jsonb, boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_derived_field_backfill(uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_derived_field_backfill(uuid, jsonb, boolean)
  to vortex_runtime;
comment on function vortex_record.apply_derived_field_backfill(uuid, jsonb, boolean) is
  'Server-only derived-field backfill write: stores the totals and stored calculations the platform worked out for a page of existing records it read with read_derived_field_backfill, only for the fields the backfill provisions. With the last page of a preview''s record type, its seed ledger records that the type''s derived fields are worked out.';

reset role;
