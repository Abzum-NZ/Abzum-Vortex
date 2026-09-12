-- First private transactional Event append (#400).
--
-- This migration enables the Supabase image's bundled pgmq capability without
-- pinning or upgrading it, creates one Basic logged queue, and installs one
-- closed append helper. Delivery, claiming, retries and consumers remain #60.

create extension if not exists pgmq;

select pgmq.create('vortex_event_occurrences');

create schema if not exists vortex_event authorization postgres;
revoke all on schema vortex_event
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_event
  revoke all on tables
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_event
  revoke execute on functions
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

-- pgmq is not part of the Data API schemas. These explicit revocations also
-- keep every direct queue route unavailable to application and Data API roles.
revoke all on schema pgmq
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
revoke all on table pgmq.q_vortex_event_occurrences,
  pgmq.a_vortex_event_occurrences
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
revoke all on sequence pgmq.q_vortex_event_occurrences_msg_id_seq
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;

alter table pgmq.q_vortex_event_occurrences enable row level security;
alter table pgmq.q_vortex_event_occurrences force row level security;
alter table pgmq.a_vortex_event_occurrences enable row level security;
alter table pgmq.a_vortex_event_occurrences force row level security;

set local role vortex_record_owner;
grant references on vortex_record.storage_catalogue to postgres;
-- PostgreSQL requires UPDATE privilege to take SELECT ... FOR UPDATE row locks.
-- The non-login helper owner already has administrative SET authority for the
-- Record owner; this direct internal grant lets this fixed helper lock the real
-- row without adding any caller grant or a second Record lock function.
grant select, update on all tables in schema record_data to postgres;
alter default privileges for role vortex_record_owner in schema record_data
  grant select, update on tables to postgres;
reset role;

-- The fixed helper resolves the current installation through Module's one
-- existing reader. Only the helper owner receives this internal dependency;
-- the Record adapter never receives direct Module reader authority.
set local role vortex_module_owner;
grant execute on function vortex_module.read_current_active_installation()
  to postgres;
reset role;

create table vortex_event.event_outbox (
  occurrence_id uuid primary key,
  organization_id uuid not null references vortex_identity.organizations,
  storage_contract_id uuid not null references vortex_record.storage_catalogue,
  storage_scope text not null check (
    storage_scope in ('organization_shared', 'application_contained')
  ),
  sequence_application_root_id uuid,
  record_id uuid not null,
  record_sequence bigint not null check (
    record_sequence between 1 and 9007199254740991
  ),
  occurred_at timestamptz not null check (
    occurred_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  ),
  envelope jsonb not null check (pg_catalog.jsonb_typeof(envelope) = 'object'),
  check (
    (storage_scope = 'organization_shared' and sequence_application_root_id is null)
    or (storage_scope = 'application_contained'
      and sequence_application_root_id is not null)
  ),
  check (
    envelope ?& array[
      'contractVersion', 'occurrenceId', 'organizationId', 'installation',
      'descriptor', 'definitionRelease', 'recordId', 'occurredAt', 'actorId',
      'correlationId', 'recordSequence', 'payload'
    ]
    and envelope - array[
      'contractVersion', 'occurrenceId', 'organizationId', 'installation',
      'descriptor', 'definitionRelease', 'recordId', 'occurredAt', 'actorId',
      'correlationId', 'recordSequence', 'payload'
    ] = '{}'::jsonb
    and envelope ->> 'contractVersion' = '2.0.0'
    and (envelope ->> 'occurrenceId')::uuid is not distinct from occurrence_id
    and (envelope ->> 'organizationId')::uuid is not distinct from organization_id
    and (envelope ->> 'recordId')::uuid is not distinct from record_id
    and (envelope ->> 'recordSequence')::bigint is not distinct from record_sequence
    and (envelope ->> 'occurredAt')::timestamptz is not distinct from occurred_at
  )
);

set local role vortex_record_owner;
revoke references on vortex_record.storage_catalogue from postgres;
reset role;

alter table vortex_event.event_outbox enable row level security;
alter table vortex_event.event_outbox force row level security;

create unique index event_outbox_record_sequence_unique
  on vortex_event.event_outbox (
    organization_id, storage_contract_id, sequence_application_root_id,
    record_id, record_sequence
  ) nulls not distinct;
create index event_outbox_record_sequence_lookup
  on vortex_event.event_outbox (
    organization_id, storage_contract_id, sequence_application_root_id,
    record_id, record_sequence desc
  );

create function vortex_event.refuse_event_outbox_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514', message = 'Event outbox evidence is immutable';
end
$function$;

create trigger event_outbox_immutable
before update or delete on vortex_event.event_outbox
for each row execute function vortex_event.refuse_event_outbox_change();

-- The batch contains only occurrence identity, installed descriptor and payload.
-- Scope, actor, correlation, time, release evidence and sequence are derived here.
create function vortex_event.append_record_occurrences(
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_occurrences jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  maximum_safe_revision constant bigint := 9007199254740991;
  context_value jsonb;
  installation jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  context_actor_id uuid;
  context_correlation_id uuid;
  application_release_revision bigint;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  binding_value jsonb;
  binding_count integer;
  binding_module_root_id uuid;
  binding_module_release_revision bigint;
  binding_revision bigint;
  module_release vortex_definition.releases%rowtype;
  application_release vortex_definition.releases%rowtype;
  module_content jsonb;
  application_content jsonb;
  record_type jsonb;
  record_type_count integer;
  locked_definition_revision bigint;
  locked_record_count integer;
  sequence_application_scope_id uuid;
  next_sequence bigint;
  occurrence_time timestamptz := pg_catalog.statement_timestamp();
  occurrence_time_text text;
  occurrence_item jsonb;
  occurrence_id uuid;
  descriptor jsonb;
  payload jsonb;
  event_kind text;
  owner_kind text;
  owner_root_id uuid;
  declared_event jsonb;
  declared_event_count integer;
  definition_release jsonb;
  field_item jsonb;
  field_id_text text;
  previous_field_id_text text;
  field_definition jsonb;
  queued_message_id bigint;
  envelope jsonb;
  envelopes jsonb := '[]'::jsonb;
begin
  if p_storage_contract_id is null or p_storage_contract_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or pg_catalog.jsonb_typeof(p_occurrences) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Event append input is invalid';
  end if;

  if pg_catalog.jsonb_array_length(p_occurrences) = 0 then
    return envelopes;
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
    where pg_catalog.jsonb_typeof(candidate.value) is distinct from 'object'
      or not candidate.value ?& array['occurrenceId', 'descriptor', 'payload']
      or candidate.value - array['occurrenceId', 'descriptor', 'payload'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(candidate.value -> 'occurrenceId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate.value -> 'descriptor') is distinct from 'object'
      or pg_catalog.jsonb_typeof(candidate.value -> 'payload') is distinct from 'object'
  ) then
    raise exception using errcode = '22023', message = 'Event occurrence batch is invalid';
  end if;

  begin
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
      where (candidate.value ->> 'occurrenceId')::uuid = nil_uuid
    ) or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements(p_occurrences)
    ) <> (
      select pg_catalog.count(distinct (candidate.value ->> 'occurrenceId')::uuid)
      from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
    ) then
      raise exception using errcode = '22023', message = 'Event occurrence identities are invalid';
    end if;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Event occurrence identities are invalid';
  end;

  context_value := vortex_access.validated_human_request_context();
  if context_value ->> 'callerKind' is distinct from 'human'
    or not context_value ?& array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ] then
    raise exception using errcode = '42501', message = 'Human Application context is required';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  context_actor_id := (context_value ->> 'organizationAccountId')::uuid;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if not found
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'record_data' then
    raise exception using errcode = 'P0002', message = 'Event record is unavailable';
  end if;

  -- Coordinate with the approved installation lifecycle writer before trusting
  -- the exact Module binding. The actual generated row is locked below and is
  -- the ordering lock shared by every consuming Application.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'vortex_module.binding:' || context_organization_id::text || ':' ||
        context_application_root_id::text || ':' || catalogue_row.module_root_id::text,
      0
    )
  );
  installation := vortex_module.read_current_active_installation();
  application_release_revision :=
    (installation ->> 'applicationReleaseRevision')::bigint;
  -- Module's existing reader has already proved the complete binding set
  -- against the published dependency closure. Read the one exact binding from
  -- that result while its canonical lifecycle lock is held; do not add a
  -- second binding reader or broader cross-owner table grants.
  select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
  into binding_count, binding_value
  from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  where (item.value ->> 'moduleRootId')::uuid = catalogue_row.module_root_id;
  if binding_count <> 1 then
    raise exception using errcode = '55000', message = 'Installed Event binding is unavailable';
  end if;
  binding_module_root_id := (binding_value ->> 'moduleRootId')::uuid;
  binding_module_release_revision :=
    (binding_value ->> 'moduleReleaseRevision')::bigint;
  binding_revision := (binding_value ->> 'bindingRevision')::bigint;

  select release.* into module_release
  from vortex_definition.releases as release
  where release.root_id = binding_module_root_id
    and release.release_revision = binding_module_release_revision;
  if not found
    or not exists (
      select 1 from vortex_record.release_provisions as provision
      where provision.module_root_id = module_release.root_id
        and provision.release_revision = module_release.release_revision
        and provision.content_fingerprint = module_release.content_fingerprint
        and provision.resolution_fingerprint = module_release.resolution_fingerprint
        and p_storage_contract_id = any (provision.storage_contract_ids)
    ) then
    raise exception using errcode = '55000', message = 'Installed Event storage is unavailable';
  end if;
  module_content := module_release.compilation_output #> '{canonical,content}';

  select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
  into record_type_count, record_type
  from pg_catalog.jsonb_array_elements(module_content -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = catalogue_row.record_type_id;
  if record_type_count <> 1
    or (record_type ->> 'storageContractId')::uuid is distinct from p_storage_contract_id
    or record_type ->> 'storageScope' is distinct from catalogue_row.storage_scope then
    raise exception using errcode = '55000', message = 'Installed Event record type is unavailable';
  end if;

  select release.* into application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = context_application_root_id
    and release.release_revision = application_release_revision
    and root.organization_id = context_organization_id
    and root.kind = 'application';
  if not found then
    raise exception using errcode = '55000', message = 'Installed Application release is unavailable';
  end if;
  application_content := application_release.compilation_output #> '{canonical,content}';

  if catalogue_row.storage_scope = 'organization_shared' then
    sequence_application_scope_id := null;
    locked_definition_revision := null;
    execute pg_catalog.format(
      'select stored.definition_revision
       from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.application_root_id is null
       for update',
      catalogue_row.physical_table_token
    ) into locked_definition_revision
    using context_organization_id, p_record_id;
    get diagnostics locked_record_count = row_count;
  else
    sequence_application_scope_id := context_application_root_id;
    locked_definition_revision := null;
    execute pg_catalog.format(
      'select stored.definition_revision
       from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.application_root_id = $3
       for update',
      catalogue_row.physical_table_token
    ) into locked_definition_revision
    using context_organization_id, p_record_id, context_application_root_id;
    get diagnostics locked_record_count = row_count;
  end if;
  if locked_record_count <> 1 or locked_definition_revision is null
    or locked_definition_revision < catalogue_row.first_compatible_release_revision
    or (catalogue_row.last_compatible_release_revision is not null
      and locked_definition_revision > catalogue_row.last_compatible_release_revision) then
    raise exception using errcode = 'P0002', message = 'Event record is unavailable';
  end if;

  select coalesce(pg_catalog.max(stored.record_sequence), 0) + 1
  into next_sequence
  from vortex_event.event_outbox as stored
  where stored.organization_id = context_organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.sequence_application_root_id is not distinct from
      sequence_application_scope_id
    and stored.record_id = p_record_id;
  if next_sequence + pg_catalog.jsonb_array_length(p_occurrences) - 1 >
      maximum_safe_revision then
    raise exception using errcode = '22003', message = 'Event record sequence is exhausted';
  end if;

  occurrence_time_text := pg_catalog.to_char(
    pg_catalog.timezone('UTC', occurrence_time),
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );

  for occurrence_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_occurrences) with ordinality as item(value, ordinal)
    order by item.ordinal
  loop
    occurrence_id := (occurrence_item ->> 'occurrenceId')::uuid;
    descriptor := occurrence_item -> 'descriptor';
    payload := occurrence_item -> 'payload';

    if descriptor ->> 'kind' = 'standard' then
      if not descriptor ?& array['kind', 'eventKind', 'recordTypeId']
        or descriptor - array['kind', 'eventKind', 'recordTypeId'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(descriptor -> 'eventKind') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'recordTypeId') is distinct from 'string'
        or (descriptor ->> 'recordTypeId')::uuid is distinct from catalogue_row.record_type_id
        or descriptor ->> 'eventKind' is null
        or descriptor ->> 'eventKind' not in (
          'created', 'changed', 'deleted', 'linked', 'unlinked', 'reassigned',
          'state_changed'
        ) then
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;
      event_kind := descriptor ->> 'eventKind';

      if event_kind = 'changed' then
        if not payload ?& array['kind', 'changedFieldIds']
          or payload - array['kind', 'changedFieldIds'] <> '{}'::jsonb
          or payload ->> 'kind' is distinct from event_kind
          or pg_catalog.jsonb_typeof(payload -> 'changedFieldIds') is distinct from 'array'
          or pg_catalog.jsonb_array_length(payload -> 'changedFieldIds') = 0 then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
        previous_field_id_text := null;
        for field_item in
          select item.value
          from pg_catalog.jsonb_array_elements(payload -> 'changedFieldIds')
            with ordinality as item(value, ordinal)
          order by item.ordinal
        loop
          if pg_catalog.jsonb_typeof(field_item) is distinct from 'string' then
            raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
          end if;
          field_id_text := pg_catalog.lower(field_item #>> '{}');
          if previous_field_id_text is not null
              and previous_field_id_text >= field_id_text
            or not exists (
              select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
              where pg_catalog.lower(field.value ->> 'fieldId') = field_id_text
            ) then
            raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
          end if;
          previous_field_id_text := field_id_text;
        end loop;
      elsif event_kind = 'state_changed' then
        if not payload ?& array['kind', 'fieldId']
          or payload - array['kind', 'fieldId', 'previousValue', 'newValue'] <> '{}'::jsonb
          or payload ->> 'kind' is distinct from event_kind
          or pg_catalog.jsonb_typeof(payload -> 'fieldId') is distinct from 'string' then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
        select field.value into field_definition
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
        where (field.value ->> 'fieldId')::uuid = (payload ->> 'fieldId')::uuid;
        if not found
          or (field_definition ->> 'personalData' = 'none'
            and not (payload ? 'previousValue' or payload ? 'newValue'))
          or (field_definition ->> 'personalData' <> 'none'
            and (payload ? 'previousValue' or payload ? 'newValue')) then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
      elsif payload <> pg_catalog.jsonb_build_object('kind', event_kind) then
        raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
      end if;

      definition_release := pg_catalog.jsonb_build_object(
        'kind', 'module',
        'rootId', module_release.root_id,
        'releaseRevision', module_release.release_revision,
        'releaseVersion', module_release.release_version,
        'contentFingerprint', module_release.content_fingerprint,
        'resolutionFingerprint', module_release.resolution_fingerprint
      );
    elsif descriptor ->> 'kind' = 'declared' then
      if not descriptor ?& array[
          'kind', 'owner', 'declarationId', 'key', 'recordTypeId', 'carriedFieldIds'
        ]
        or descriptor - array[
          'kind', 'owner', 'declarationId', 'key', 'recordTypeId', 'carriedFieldIds'
        ] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(descriptor -> 'owner') is distinct from 'object'
        or pg_catalog.jsonb_typeof(descriptor -> 'declarationId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'key') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'recordTypeId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'carriedFieldIds') is distinct from 'array'
        or (descriptor ->> 'recordTypeId')::uuid is distinct from catalogue_row.record_type_id then
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;

      owner_kind := descriptor #>> '{owner,kind}';
      if owner_kind = 'application'
        and (descriptor -> 'owner') - array['kind', 'applicationRootId'] = '{}'::jsonb
        and (descriptor -> 'owner') ?& array['kind', 'applicationRootId']
        and pg_catalog.jsonb_typeof(
          descriptor #> '{owner,applicationRootId}'
        ) is not distinct from 'string' then
        owner_root_id := (descriptor #>> '{owner,applicationRootId}')::uuid;
        if owner_root_id <> context_application_root_id then
          raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
        end if;
        select pg_catalog.count(*), pg_catalog.jsonb_agg(event.value) -> 0
        into declared_event_count, declared_event
        from pg_catalog.jsonb_array_elements(application_content -> 'events') as event(value)
        where (event.value ->> 'eventId')::uuid = (descriptor ->> 'declarationId')::uuid
          and event.value ->> 'key' = descriptor ->> 'key';
        definition_release := pg_catalog.jsonb_build_object(
          'kind', 'application',
          'rootId', application_release.root_id,
          'releaseRevision', application_release.release_revision,
          'releaseVersion', application_release.release_version,
          'contentFingerprint', application_release.content_fingerprint,
          'resolutionFingerprint', application_release.resolution_fingerprint
        );
      elsif owner_kind = 'module'
        and (descriptor -> 'owner') - array['kind', 'moduleRootId'] = '{}'::jsonb
        and (descriptor -> 'owner') ?& array['kind', 'moduleRootId']
        and pg_catalog.jsonb_typeof(
          descriptor #> '{owner,moduleRootId}'
        ) is not distinct from 'string' then
        owner_root_id := (descriptor #>> '{owner,moduleRootId}')::uuid;
        if owner_root_id <> module_release.root_id then
          raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
        end if;
        select pg_catalog.count(*), pg_catalog.jsonb_agg(event.value) -> 0
        into declared_event_count, declared_event
        from pg_catalog.jsonb_array_elements(module_content -> 'events') as event(value)
        where (event.value ->> 'eventId')::uuid = (descriptor ->> 'declarationId')::uuid
          and event.value ->> 'key' = descriptor ->> 'key';
        definition_release := pg_catalog.jsonb_build_object(
          'kind', 'module',
          'rootId', module_release.root_id,
          'releaseRevision', module_release.release_revision,
          'releaseVersion', module_release.release_version,
          'contentFingerprint', module_release.content_fingerprint,
          'resolutionFingerprint', module_release.resolution_fingerprint
        );
      else
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;

      if declared_event_count <> 1
        or (declared_event ->> 'recordTypeId')::uuid <> catalogue_row.record_type_id
        or declared_event -> 'carriedFieldIds' is distinct from
          descriptor -> 'carriedFieldIds'
        or declared_event -> 'personalOrSensitiveValuesAllowed' is distinct from
          'false'::jsonb
        or not payload ?& array['kind', 'carriedValues']
        or payload - array['kind', 'carriedValues'] <> '{}'::jsonb
        or payload ->> 'kind' is distinct from 'declared'
        or pg_catalog.jsonb_typeof(payload -> 'carriedValues') is distinct from 'object' then
        raise exception using errcode = '22023', message = 'Installed Event declaration is invalid';
      end if;

      if exists (
        select 1
        from pg_catalog.jsonb_each(payload -> 'carriedValues') as carried(field_id, value)
        where not (descriptor -> 'carriedFieldIds') ? carried.field_id
          or not exists (
            select 1
            from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
            where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(carried.field_id)
              and field.value ->> 'personalData' = 'none'
          )
      ) then
        raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
      end if;
    else
      raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
    end if;

    envelope := pg_catalog.jsonb_build_object(
      'contractVersion', '2.0.0',
      'occurrenceId', occurrence_id,
      'organizationId', context_organization_id,
      'installation', pg_catalog.jsonb_build_object(
        'applicationRootId', context_application_root_id,
        'applicationReleaseRevision', application_release_revision,
        'moduleBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', binding_module_root_id,
          'moduleReleaseRevision', binding_module_release_revision,
          'bindingRevision', binding_revision
        )
      ),
      'descriptor', descriptor,
      'definitionRelease', definition_release,
      'recordId', p_record_id,
      'occurredAt', occurrence_time_text,
      'actorId', context_actor_id,
      'correlationId', context_correlation_id,
      'recordSequence', next_sequence,
      'payload', payload
    );

    insert into vortex_event.event_outbox (
      occurrence_id, organization_id, storage_contract_id, storage_scope,
      sequence_application_root_id, record_id, record_sequence, occurred_at,
      envelope
    ) values (
      occurrence_id, context_organization_id, p_storage_contract_id,
      catalogue_row.storage_scope, sequence_application_scope_id, p_record_id,
      next_sequence, occurrence_time, envelope
    );

    select sent.msg_id into strict queued_message_id
    from pgmq.send(
      'vortex_event_occurrences',
      pg_catalog.jsonb_build_object(
        'contractVersion', '2.0.0', 'occurrenceId', occurrence_id
      )
    ) as sent(msg_id);
    if queued_message_id is null then
      raise exception using errcode = '55000', message = 'Event queue append failed';
    end if;

    envelopes := envelopes || pg_catalog.jsonb_build_array(envelope);
    next_sequence := next_sequence + 1;
  end loop;

  return envelopes;
end
$function$;

alter function vortex_event.append_record_occurrences(uuid, uuid, jsonb)
  owner to postgres;

revoke all on table vortex_event.event_outbox
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
revoke all on function vortex_event.refuse_event_outbox_change()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
revoke all on function vortex_event.append_record_occurrences(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
grant usage on schema vortex_event to vortex_record_adapter;
grant execute on function vortex_event.append_record_occurrences(uuid, uuid, jsonb)
  to vortex_record_adapter;

comment on table vortex_event.event_outbox is
  'Private immutable V2 Event occurrence evidence; delivery state belongs to #60.';
comment on function vortex_event.append_record_occurrences(uuid, uuid, jsonb) is
  'Appends an exact validated record occurrence batch and minimal logged queue messages in the caller transaction.';
