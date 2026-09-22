-- #558: atomic deadline dependency closure.
--
-- #557 claims one due row inside the caller's request transaction: it locks
-- the due row and its root record, and establishes the configured System
-- context for exactly that organisation/Application. This migration adds the
-- owning operation that consumes that claim in the same transaction. It reuses
-- the Record engine's relationship-total closure (catalogue, snapshot and
-- transitive parent discovery), locks the concrete closure in canonical order,
-- lets the Record runtime recalculate every affected calculation and total at
-- one database instant, and then commits the root, every changed parent, their
-- Activity, standard `changed` Events and their deadline due metadata
-- together. A replay of a committed effect returns its stored outcome; a stale,
-- busy or changed closure returns a bounded conflict/refusal with no effect.
--
-- The shared primitives stay single implementations. The installation reader,
-- relationship-total catalogue/snapshot and common Event writer gain exactly
-- one alternative context source: a System context that is revalidated against
-- the configured, unrevoked deadline actor for the current session. Every other
-- caller keeps its unchanged human request validation. Activity keeps its
-- closed postgres-owned composer pattern; the Record adapter receives no raw
-- Activity or Module reader authority.
--
-- An organisation-shared root has no Application in its #557 context, so no
-- installation or Event envelope can be resolved for it; such a claim is
-- refused with `application_context_required` rather than attributed to an
-- arbitrary Application.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
grant create on schema vortex_record to postgres;
grant references on vortex_record.storage_catalogue to postgres;
reset role;

-- Idempotency ledger. #557 derives the effect identity deterministically from
-- the exact claimed due-row facts, so a replay of the same claim carries the
-- same effect id and returns the committed outcome instead of repeating it.
create table vortex_record.deadline_transition_effects (
  effect_id uuid primary key,
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  storage_contract_id uuid not null references vortex_record.storage_catalogue,
  record_id uuid not null,
  application_root_id uuid,
  effect_identity text not null check (pg_catalog.char_length(effect_identity) between 1 and 500),
  result jsonb not null check (pg_catalog.jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default pg_catalog.statement_timestamp()
);

alter table vortex_record.deadline_transition_effects enable row level security;
alter table vortex_record.deadline_transition_effects force row level security;
create policy deadline_transition_effects_adapter
  on vortex_record.deadline_transition_effects to vortex_record_adapter
  using (
    organization_id = vortex_context.organization_id()
    and case when application_root_id is null then true
      else application_root_id = vortex_context.application_root_id(true) end
  )
  with check (
    organization_id = vortex_context.organization_id()
    and case when application_root_id is null then true
      else application_root_id = vortex_context.application_root_id(true) end
  );
alter table vortex_record.deadline_transition_effects owner to vortex_record_adapter;
revoke all on table vortex_record.deadline_transition_effects
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

set local role vortex_record_adapter;

-- The one System-context check shared by every generalized primitive. The
-- context must be a live System context whose actor is still the configured,
-- unrevoked deadline actor bound to this execution session; the resolver
-- re-locks that binding and actor exactly as the #557 claim did.
create function vortex_record.validated_deadline_system_context_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  actor_resolution jsonb;
begin
  context_value := vortex_context.current_context();
  if context_value ->> 'callerKind' is distinct from 'system'
    or not context_value ?& array[
      'organizationId', 'systemActorId', 'correlationId', 'expiresAt'
    ]
    or (context_value ->> 'expiresAt')::timestamptz <= pg_catalog.statement_timestamp() then
    raise exception using errcode = '42501', message = 'Deadline System context is required';
  end if;
  actor_resolution := vortex_record.resolve_configured_deadline_actor_internal(
    (context_value ->> 'organizationId')::uuid,
    case when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid else null end
  );
  if actor_resolution ->> 'outcome' is distinct from 'resolved'
    or (actor_resolution ->> 'actorId')::uuid is distinct from
      (context_value ->> 'systemActorId')::uuid then
    raise exception using errcode = '42501', message = 'Deadline System actor is not current';
  end if;
  return context_value;
end
$function$;

alter function vortex_record.validated_deadline_system_context_internal()
  owner to vortex_record_adapter;
revoke all on function vortex_record.validated_deadline_system_context_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.validated_deadline_system_context_internal()
  to postgres;

reset role;

-- Module keeps one installation resolver. Its body moves unchanged into a
-- scope-parameterised internal; the human reader keeps its exact validation.
set local role vortex_module_owner;

create function vortex_module.read_active_installation_for_scope_internal(
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
begin
  if p_organization_id is null or p_application_root_id is null then
    raise exception using errcode = '22023', message = 'Active Application context is required';
  end if;
  selected_organization_id := p_organization_id;
  selected_application_root_id := p_application_root_id;

  select pg_catalog.min(binding.application_release_revision)
  into selected_application_release_revision
  from vortex_module.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.state = 'active';
  if selected_application_release_revision is null then
    raise exception using errcode = 'P0002', message = 'Active Application installation is unavailable';
  end if;
  if exists (
    select 1 from vortex_module.installation_bindings as binding
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
      and release.compilation_output #>> '{kind}' = 'application'
  ) then
    raise exception using errcode = '23514', message = 'Active Application release evidence is invalid';
  end if;

  if not exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      selected_application_root_id, selected_application_release_revision
    )
  ) or exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      selected_application_root_id, selected_application_release_revision
    ) as node
    left join vortex_module.installation_bindings as binding
      on binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.module_root_id = node.target_root_id
    where binding.state is distinct from 'active'
      or binding.application_release_revision is distinct from selected_application_release_revision
      or binding.module_release_revision is distinct from node.target_release_revision
      or binding.content_fingerprint is distinct from node.dependency_content_fingerprint
      or binding.resolution_fingerprint is distinct from node.evidence_fingerprint
  ) or exists (
    select 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.state = 'active'
      and not exists (
        select 1
        from vortex_definition.reachable_module_dependency_edges(
          selected_application_root_id, selected_application_release_revision
        ) as node
        where node.target_root_id = binding.module_root_id
          and node.target_release_revision = binding.module_release_revision
      )
  ) then
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
  from vortex_module.installation_bindings as binding
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


create or replace function vortex_module.read_current_active_installation()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId' then
    raise exception using errcode = '22023', message = 'Active Application context is required';
  end if;
  return vortex_module.read_active_installation_for_scope_internal(
    (checked_context ->> 'organizationId')::uuid,
    (checked_context ->> 'applicationRootId')::uuid
  );
end
$function$;

revoke all on function vortex_module.read_active_installation_for_scope_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter;
-- As with #400, only the fixed postgres-owned helper receives this internal
-- dependency; the Record adapter never receives direct Module reader authority.
grant execute on function vortex_module.read_active_installation_for_scope_internal(uuid, uuid)
  to postgres;
comment on function vortex_module.read_active_installation_for_scope_internal(uuid, uuid) is
  'Resolves the complete exact active Module binding set for one already-validated organisation/Application scope.';

reset role;

set local role postgres;

-- Fixed bridge: the installation of the validated deadline System context.
create function vortex_record.read_deadline_active_installation_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_record.validated_deadline_system_context_internal();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '22023', message = 'Active Application context is required';
  end if;
  return vortex_module.read_active_installation_for_scope_internal(
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid
  );
end
$function$;

-- Fixed bridge: the organisation currency the Record calculation engine needs
-- for money totals, read for the validated deadline System context only.
create function vortex_record.read_deadline_organization_currency_internal()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  currency_value text;
begin
  context_value := vortex_record.validated_deadline_system_context_internal();
  select settings.currency into currency_value
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = (context_value ->> 'organizationId')::uuid;
  return currency_value;
end
$function$;

-- Closed deadline-closure Activity composer, mirroring
-- `append_base_save_activity_internal`: it accepts only the fixed facts,
-- derives context/time/action itself and invokes the existing private Activity
-- append as its postgres owner with System attribution.
create function vortex_record.append_deadline_closure_activity_internal(
  p_activity_id uuid,
  p_subject_id uuid,
  p_changed_field_ids uuid[]
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  occurred_at_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_field_ids is null
    or pg_catalog.cardinality(p_changed_field_ids) = 0
    or pg_catalog.array_position(p_changed_field_ids, null::uuid) is not null
    or p_changed_field_ids is distinct from (
      select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[])
      from (select distinct value
        from pg_catalog.unnest(p_changed_field_ids) as item(value)) as canonical
    ) then
    raise exception using errcode = '22023',
      message = 'Deadline closure Activity input is invalid';
  end if;
  context_value := vortex_record.validated_deadline_system_context_internal();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Deadline closure Activity requires an Application context';
  end if;
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'system',
    (context_value ->> 'systemActorId')::uuid,
    'update_record', array[p_subject_id]::uuid[], p_changed_field_ids, 'system',
    (context_value ->> 'correlationId')::uuid, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Deadline closure Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

alter function vortex_record.read_deadline_active_installation_internal() owner to postgres;
alter function vortex_record.read_deadline_organization_currency_internal() owner to postgres;
alter function vortex_record.append_deadline_closure_activity_internal(uuid, uuid, uuid[])
  owner to postgres;
revoke all on function vortex_record.read_deadline_active_installation_internal(),
  vortex_record.read_deadline_organization_currency_internal(),
  vortex_record.append_deadline_closure_activity_internal(uuid, uuid, uuid[])
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.read_deadline_active_installation_internal(),
  vortex_record.read_deadline_organization_currency_internal(),
  vortex_record.append_deadline_closure_activity_internal(uuid, uuid, uuid[])
to vortex_record_adapter;

-- The common Event writer keeps one implementation. Only its context/actor and
-- installation sources gain the validated deadline System alternative.
create or replace function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_occurrences jsonb,
  p_installation jsonb
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

  -- The only System caller is the deadline closure: its context is revalidated
  -- against the configured deadline actor and attributes that actor. Every
  -- other caller keeps the exact human Application context requirement.
  if vortex_context.current_context() ->> 'callerKind' = 'system' then
    context_value := vortex_record.validated_deadline_system_context_internal();
    if not context_value ?& array[
      'organizationId', 'applicationRootId', 'systemActorId', 'correlationId'
    ] then
      raise exception using errcode = '42501', message = 'System Application context is required';
    end if;
    context_actor_id := (context_value ->> 'systemActorId')::uuid;
  else
    context_value := vortex_access.validated_human_request_context();
    if context_value ->> 'callerKind' is distinct from 'human'
      or not context_value ?& array[
        'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
      ] then
      raise exception using errcode = '42501', message = 'Human Application context is required';
    end if;
    context_actor_id := (context_value ->> 'organizationAccountId')::uuid;
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
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
  -- Installation evidence is resolved here, inside the protected region, and
  -- never before it.  A lifecycle detach that commits while this append waits
  -- for the canonical binding lock above is only observed by a read taken
  -- after that wait: this assignment is its own statement, so in read
  -- committed it sees the committed lifecycle state.  `p_installation` carries
  -- an exact pin-set only from a trusted reader that already resolved it while
  -- holding the same canonical lifecycle lock.
  if p_installation is null and context_value ->> 'callerKind' = 'system' then
    installation := vortex_record.read_deadline_active_installation_internal();
  elsif p_installation is null then
    installation := vortex_module.read_current_active_installation();
  else
    installation := p_installation;
  end if;
  if installation is null
    or pg_catalog.jsonb_typeof(installation) <> 'object'
    or not installation ?& array[
      'organizationId', 'applicationRootId', 'applicationReleaseRevision',
      'moduleBindings'
    ]
    or (installation ->> 'organizationId')::uuid is distinct from context_organization_id
    or (installation ->> 'applicationRootId')::uuid is distinct from context_application_root_id
    or pg_catalog.jsonb_typeof(installation -> 'moduleBindings') <> 'array' then
    raise exception using errcode = '42501', message = 'Resolved Event installation is unavailable';
  end if;
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

reset role;

set local role vortex_record_adapter;

-- The relationship-total catalogue and snapshot keep one implementation; only
-- their installation and scope-context sources gain the System alternative.
create or replace function vortex_record.relationship_total_catalogue_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  installation jsonb;
  binding jsonb;
  content jsonb;
  record_types jsonb := '[]'::jsonb;
  relationships jsonb := '[]'::jsonb;
  has_installed_rules boolean := false;
  record_type jsonb;
begin
  -- A deadline closure resolves the same installation from its validated
  -- System context; every other caller keeps the human request reader.
  if vortex_context.current_context() ->> 'callerKind' = 'system' then
    installation := vortex_record.read_deadline_active_installation_internal();
  else
    installation := vortex_module.read_current_active_installation();
  end if;
  for binding in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') item(value)
    order by item.value ->> 'moduleRootId'
  loop
    select release.compilation_output #> '{canonical,content}' into strict content
    from vortex_definition.releases release
    where release.root_id = (binding ->> 'moduleRootId')::uuid
      and release.release_revision = (binding ->> 'moduleReleaseRevision')::bigint;
    if pg_catalog.jsonb_typeof(content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000', message = 'Installed Record definitions are unavailable';
    end if;
    has_installed_rules := has_installed_rules or
      pg_catalog.jsonb_array_length(coalesce(content -> 'rules', '[]'::jsonb)) > 0;
    record_types := record_types || coalesce((
      select pg_catalog.jsonb_agg(
        item.value || pg_catalog.jsonb_build_object(
          'moduleReleaseRevision', binding -> 'moduleReleaseRevision'
        )
        order by item.value ->> 'recordTypeId'
      )
      from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    ), '[]'::jsonb);
    for record_type in
      select item.value from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    loop
      relationships := relationships || coalesce(record_type -> 'relationships', '[]'::jsonb);
    end loop;
  end loop;
  select release.compilation_output #> '{canonical,content}' into strict content
  from vortex_definition.releases release
  where release.root_id = (installation ->> 'applicationRootId')::uuid
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  has_installed_rules := has_installed_rules or
    pg_catalog.jsonb_array_length(coalesce(content -> 'rules', '[]'::jsonb)) > 0;
  return pg_catalog.jsonb_build_object(
    'recordTypes', record_types,
    'relationships', relationships,
    'hasInstalledRules', has_installed_rules
  );
end
$function$;

create or replace function vortex_record.relationship_total_record_snapshot_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid,
  p_lock boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  columns_value jsonb;
  value_expression text;
  load_sql text;
  result_value jsonb;
begin
  if p_record_type_id is null or p_record_id is null or p_lock is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') <> 'array' then
    return null;
  end if;
  if vortex_context.current_context() ->> 'callerKind' = 'system' then
    context_value := vortex_record.validated_deadline_system_context_internal();
  else
    context_value := vortex_access.validated_human_request_context();
  end if;
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if record_type is null then return null; end if;

  select stored.* into catalogue_row
  from vortex_record.storage_catalogue stored
  where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
    and stored.record_type_id = p_record_type_id
    and stored.state = 'active';
  if not found then return null; end if;

  select pg_catalog.jsonb_object_agg(
    pg_catalog.lower(field.value ->> 'fieldId'),
    pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type,
      'type', field.value ->> 'type'
    )
  ) into columns_value
  from pg_catalog.jsonb_array_elements(record_type -> 'fields') field(value)
  join vortex_record.field_storage_mappings mapping
    on mapping.storage_contract_id = (record_type ->> 'storageContractId')::uuid
   and mapping.field_id = (field.value ->> 'fieldId')::uuid
   and mapping.state = 'active';
  if (select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(coalesce(columns_value, '{}'::jsonb))) <>
      pg_catalog.jsonb_array_length(record_type -> 'fields') then
    return null;
  end if;

  select pg_catalog.string_agg(
    pg_catalog.format(
      '%L, %s', entry.key,
      case entry.value ->> 'databaseValueType'
        when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', entry.value ->> 'token')
        when 'timestamp_with_time_zone' then pg_catalog.format(
          'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.%I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
          entry.value ->> 'token'
        )
        when 'date' then pg_catalog.format(
          'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
          entry.value ->> 'token'
        )
        else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', entry.value ->> 'token')
      end
    ), ', ' order by entry.key collate "C"
  ) into value_expression
  from pg_catalog.jsonb_each(columns_value) entry(key, value);

  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordType'', $3 - ''moduleReleaseRevision'',
       ''recordTypeId'', %L::uuid,
       ''storageContractId'', %L::uuid,
       ''recordId'', stored.record_id,
       ''concurrencyNumber'', stored.concurrency_number,
       ''definitionRevision'', %L::bigint,
       ''existingValues'', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
     )
     from record_data.%I stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active''
       and stored.application_root_id is not distinct from %s%s',
    p_record_type_id,
    (record_type ->> 'storageContractId')::uuid,
    (record_type ->> 'moduleReleaseRevision')::bigint,
    value_expression,
    catalogue_row.physical_table_token,
    case when record_type ->> 'storageScope' = 'application_contained'
      then '$4::uuid' else 'null::uuid' end,
    case when p_lock then ' for update' else '' end
  );
  execute load_sql into result_value using
    (context_value ->> 'organizationId')::uuid,
    p_record_id,
    record_type,
    (context_value ->> 'applicationRootId')::uuid;
  return result_value;
end
$function$;

create function vortex_record.deadline_due_transition_is_valid_internal(p_due_transition jsonb)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if p_due_transition is null or pg_catalog.jsonb_typeof(p_due_transition) = 'null' then
    return true;
  end if;
  if pg_catalog.jsonb_typeof(p_due_transition) <> 'object' then
    return false;
  end if;
  if p_due_transition - array['calculationFieldId', 'transitionAt'] <> '{}'::jsonb
    or not (p_due_transition ?& array['calculationFieldId', 'transitionAt'])
    or pg_catalog.jsonb_typeof(p_due_transition -> 'calculationFieldId') <> 'string'
    or pg_catalog.jsonb_typeof(p_due_transition -> 'transitionAt') <> 'string'
    or not pg_catalog.pg_input_is_valid(p_due_transition ->> 'calculationFieldId', 'uuid')
    or not (p_due_transition ->> 'transitionAt') ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    or not pg_catalog.pg_input_is_valid(
      p_due_transition ->> 'transitionAt', 'timestamp with time zone'
    ) then
    return false;
  end if;
  return (p_due_transition ->> 'calculationFieldId')::uuid <>
    '00000000-0000-0000-0000-000000000000'::uuid;
end
$function$;

-- Same table and upsert/cancel shape as the ordinary-save composer
-- (`save_base_record_with_relationship_totals_and_deadline_due_metadata`),
-- written for each record the closure leaves at a new revision.
create function vortex_record.write_deadline_closure_due_metadata_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_record jsonb,
  p_concurrency_number bigint,
  p_due_transition jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  storage_row vortex_record.storage_catalogue%rowtype;
  metadata_application_root_id uuid;
begin
  select catalogue.* into strict storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = (p_record ->> 'storageContractId')::uuid
    and catalogue.record_type_id = (p_record ->> 'recordTypeId')::uuid;
  metadata_application_root_id := case storage_row.storage_scope
    when 'application_contained' then p_application_root_id
    else null
  end;
  if p_due_transition is null or pg_catalog.jsonb_typeof(p_due_transition) = 'null' then
    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = p_organization_id
      and metadata.storage_contract_id = storage_row.storage_contract_id
      and metadata.record_id = (p_record ->> 'recordId')::uuid
      and metadata.application_root_id is not distinct from metadata_application_root_id;
    return;
  end if;
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_record #> '{recordType,fields}') as field(value)
    where pg_catalog.lower(field.value ->> 'fieldId') =
        pg_catalog.lower(p_due_transition ->> 'calculationFieldId')
      and field.value ->> 'type' = 'calculation'
  ) then
    raise exception using errcode = '22023', message = 'Deadline due transition field is invalid';
  end if;
  insert into vortex_record.record_deadline_due_metadata (
    organization_id, storage_contract_id, storage_scope, record_id, record_type_id,
    application_root_id, record_concurrency_number,
    deadline_calculation_field_id, transition_at
  ) values (
    p_organization_id,
    storage_row.storage_contract_id,
    storage_row.storage_scope,
    (p_record ->> 'recordId')::uuid,
    storage_row.record_type_id,
    metadata_application_root_id,
    p_concurrency_number,
    (p_due_transition ->> 'calculationFieldId')::uuid,
    (p_due_transition ->> 'transitionAt')::timestamptz
  ) on conflict (
    organization_id, storage_contract_id, record_id, application_root_id
  )
  do update set
    storage_scope = excluded.storage_scope,
    record_type_id = excluded.record_type_id,
    record_concurrency_number = excluded.record_concurrency_number,
    deadline_calculation_field_id = excluded.deadline_calculation_field_id,
    transition_at = excluded.transition_at,
    changed_at = pg_catalog.statement_timestamp();
end
$function$;

-- Generated-value writer for one locked closure record. It has the same
-- physical patch, revision, data-version, Activity and standard Event shape as
-- `apply_relationship_total_parent_internal`, attributed to the System actor.
create function vortex_record.apply_deadline_closure_record_internal(
  p_record jsonb,
  p_final_values jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_context jsonb
)
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  storage_row vortex_record.storage_catalogue%rowtype;
  scope_application_root_id uuid;
  field_value jsonb;
  column_value jsonb;
  entry record;
  assignments text[] := array[]::text[];
  changed_field_ids uuid[] := array[]::uuid[];
  update_sql text;
  new_revision bigint;
  event_result jsonb;
begin
  if pg_catalog.jsonb_typeof(p_final_values) <> 'object' or p_final_values = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Deadline closure mutation is invalid';
  end if;
  select catalogue.* into storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = (p_record ->> 'storageContractId')::uuid
    and catalogue.record_type_id = (p_record ->> 'recordTypeId')::uuid
    and catalogue.state = 'active'
    and catalogue.physical_schema_token = 'record_data';
  if not found then
    raise exception using errcode = 'P0002', message = 'Deadline closure record is unavailable';
  end if;
  scope_application_root_id := case storage_row.storage_scope
    when 'application_contained' then (p_context ->> 'applicationRootId')::uuid
    else null
  end;

  for entry in select pg_catalog.lower(key) as key, value from pg_catalog.jsonb_each(p_final_values)
  loop
    select field.value into field_value
    from pg_catalog.jsonb_array_elements(p_record #> '{recordType,fields}') field(value)
    where pg_catalog.lower(field.value ->> 'fieldId') = entry.key;
    if field_value is null or field_value ->> 'type' not in ('total', 'calculation') then
      raise exception using errcode = '42501', message = 'Deadline closure field is unavailable';
    end if;
    select pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type
    ) into column_value
    from vortex_record.field_storage_mappings mapping
    where mapping.storage_contract_id = storage_row.storage_contract_id
      and mapping.field_id = entry.key::uuid and mapping.state = 'active';
    if column_value is null or not vortex_record.canonical_record_value_matches(
      entry.value, field_value ->> 'type', column_value ->> 'databaseValueType'
    ) then
      raise exception using errcode = '23514', message = 'Deadline closure value is invalid';
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
    changed_field_ids := pg_catalog.array_append(changed_field_ids, entry.key::uuid);
  end loop;
  select pg_catalog.array_agg(distinct value order by value) into changed_field_ids
  from pg_catalog.unnest(changed_field_ids) item(value);

  update_sql := pg_catalog.format(
    'update record_data.%I stored set %s,
       concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $5
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.application_root_id is not distinct from $6
       and stored.lifecycle_state = ''active''
       and stored.concurrency_number = $4
     returning stored.concurrency_number',
    storage_row.physical_table_token,
    pg_catalog.array_to_string(assignments, ', ')
  );
  execute update_sql into new_revision using
    (p_context ->> 'organizationId')::uuid,
    (p_record ->> 'recordId')::uuid,
    (p_context ->> 'systemActorId')::uuid,
    (p_record ->> 'concurrencyNumber')::bigint,
    (p_record ->> 'definitionRevision')::bigint,
    scope_application_root_id;
  if new_revision is null then
    raise exception using errcode = '40001', message = 'Deadline closure record write is stale';
  end if;
  perform vortex_record.bump_record_data_version_internal(
    (p_context ->> 'organizationId')::uuid,
    storage_row.storage_contract_id,
    scope_application_root_id
  );
  perform vortex_record.append_deadline_closure_activity_internal(
    p_activity_id, (p_record ->> 'recordId')::uuid, changed_field_ids
  );
  event_result := vortex_event.append_record_occurrences(
    storage_row.storage_contract_id, (p_record ->> 'recordId')::uuid,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed',
        'recordTypeId', storage_row.record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Deadline closure Event append failed';
  end if;
  return new_revision;
end
$function$;

-- Locks and prepares the concrete closure of one claimed root: the root, every
-- relationship-total parent it transitively feeds, and the declared aggregate
-- sources of each. Rows are locked NOWAIT in the canonical (storage contract,
-- record) order: the claim already holds the root, so waiting could invert the
-- ordinary-save order; a busy row is a bounded conflict and the claim retries.
create function vortex_record.prepare_record_deadline_closure(
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_record_type_id uuid,
  p_application_root_id uuid,
  p_expected_concurrency_number bigint,
  p_system_actor_id uuid,
  p_effect_id uuid,
  p_effect_identity text,
  p_transition_at timestamptz
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
  ledger_row vortex_record.deadline_transition_effects%rowtype;
  catalogue jsonb;
  root_type jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  lock_row vortex_record.storage_catalogue%rowtype;
  locked_count integer;
  root_record jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  currency_value text;
begin
  if p_organization_id is null or p_organization_id = nil_uuid
    or p_storage_contract_id is null or p_storage_contract_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_application_root_id = nil_uuid
    or p_system_actor_id is null or p_system_actor_id = nil_uuid
    or p_effect_id is null or p_effect_id = nil_uuid
    or p_effect_identity is null
    or pg_catalog.char_length(p_effect_identity) not between 1 and 500
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_transition_at is null or not pg_catalog.isfinite(p_transition_at) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  context_value := vortex_record.validated_deadline_system_context_internal();
  if (context_value ->> 'organizationId')::uuid is distinct from p_organization_id
    or (context_value ->> 'systemActorId')::uuid is distinct from p_system_actor_id
    or (context_value ? 'applicationRootId') <> (p_application_root_id is not null)
    or (
      p_application_root_id is not null
      and (context_value ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    ) then
    raise exception using errcode = '42501',
      message = 'Deadline closure requires the exact claimed System context';
  end if;

  select stored.* into ledger_row
  from vortex_record.deadline_transition_effects as stored
  where stored.effect_id = p_effect_id;
  if found then
    if ledger_row.effect_identity is distinct from p_effect_identity
      or ledger_row.storage_contract_id is distinct from p_storage_contract_id
      or ledger_row.record_id is distinct from p_record_id then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'replayed', 'result', ledger_row.result);
  end if;

  if p_application_root_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'application_context_required'
    );
  end if;
  if p_transition_at > pg_catalog.statement_timestamp() then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'transition_not_due');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null
    or (root_type ->> 'storageContractId')::uuid is distinct from p_storage_contract_id then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_type_unavailable'
    );
  end if;

  -- The claimed change is to generated values only, so no relationship
  -- membership moves: the closure is discovered from the stored values.
  before_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, 'update', p_record_type_id, p_record_id, '{}'::jsonb
  );
  if before_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'reasonCode', 'record_unavailable');
  end if;

  begin
    for record_value in
      select item.value
      from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
      where item.value ? 'recordId'
      order by (item.value ->> 'storageContractId')::uuid,
        (item.value ->> 'recordId')::uuid
    loop
      select catalogue_row.* into lock_row
      from vortex_record.storage_catalogue as catalogue_row
      where catalogue_row.storage_contract_id = (record_value ->> 'storageContractId')::uuid
        and catalogue_row.state = 'active'
        and catalogue_row.physical_schema_token = 'record_data';
      if not found then
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'reasonCode', 'record_unavailable'
        );
      end if;
      execute pg_catalog.format(
        'select 1 from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.application_root_id is not distinct from $3
           and stored.lifecycle_state = ''active''
         for update nowait',
        lock_row.physical_table_token
      ) using p_organization_id, (record_value ->> 'recordId')::uuid,
        case when lock_row.storage_scope = 'application_contained'
          then p_application_root_id else null end;
      get diagnostics locked_count = row_count;
      if locked_count <> 1 then
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'reasonCode', 'record_unavailable'
        );
      end if;
    end loop;
  exception when lock_not_available then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'reasonCode', 'record_busy');
  end;

  after_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, 'update', p_record_type_id, p_record_id, '{}'::jsonb
  );
  if after_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'reasonCode', 'record_unavailable');
  end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'reasonCode', 'closure_changed');
  end if;
  select item.value into root_record
  from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
  where item.value ->> 'recordKey' = 'root';
  if root_record is null
    or (root_record ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'concurrency_mismatch'
    );
  end if;

  -- Materialize only the declared aggregate sources for each locked record,
  -- exactly as `prepare_relationship_total_save` does. Closure members are
  -- keyed so the runtime evaluates them from their recalculated values.
  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb
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
        and pg_catalog.lower(item.value #>> '{toRecordType,recordTypeId}') =
          pg_catalog.lower(prepared_record ->> 'recordTypeId');
      if relationship_value is null then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_type_unavailable'
        );
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
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_type_unavailable'
        );
      end if;
      source_records := '[]'::jsonb;
      for edge_value in
        select edge.* from vortex_record.relationship_edges edge
        where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
          and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
          and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
          and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
          and edge.from_organisation_id = p_organization_id
          and edge.to_organisation_id = p_organization_id
          and edge.from_application_root_id is not distinct from case
            when source_type ->> 'storageScope' = 'application_contained'
              then p_application_root_id else null end
          and edge.to_application_root_id is not distinct from case
            when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
              then p_application_root_id else null end
        order by edge.from_storage_contract_id, edge.from_record_id
      loop
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
          edge_value.from_record_id, false
        );
        if source_snapshot is null then
          return pg_catalog.jsonb_build_object(
            'outcome', 'conflict', 'reasonCode', 'closure_changed'
          );
        end if;
        source_key := null;
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

  currency_value := vortex_record.read_deadline_organization_currency_internal();
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', '[]'::jsonb,
    'records', prepared_records,
    'evaluatedAt', pg_catalog.to_char(
      pg_catalog.timezone('UTC', pg_catalog.statement_timestamp()),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'hasInstalledRules', coalesce((catalogue ->> 'hasInstalledRules')::boolean, false)
  ) || case when currency_value is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('organizationCurrency', currency_value) end;
exception
  when no_data_found or too_many_rows or check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
end
$function$;

-- The owning atomic commit. It repeats the protected preparation itself, so
-- the closure identity, revisions and the complete generated-field set never
-- depend on caller-supplied state; the caller supplies only the values the
-- Record calculation engine derived from that same locked preparation.
create function vortex_record.finalize_record_deadline_refresh(
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_record_type_id uuid,
  p_application_root_id uuid,
  p_expected_concurrency_number bigint,
  p_system_actor_id uuid,
  p_effect_id uuid,
  p_effect_identity text,
  p_transition_at timestamptz,
  p_final_values jsonb,
  p_due_transition jsonb,
  p_parent_mutations jsonb,
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
  preparation jsonb;
  context_value jsonb;
  root_record jsonb;
  root_values jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  parent_values jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  changed_parents jsonb := '[]'::jsonb;
  root_revision bigint;
  parent_revision bigint;
  result_value jsonb;
begin
  if pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_parent_mutations) is distinct from 'array'
    or p_activity_id is null or p_activity_id = nil_uuid
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or not vortex_record.deadline_due_transition_is_valid_internal(p_due_transition)
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
      where case when pg_catalog.jsonb_typeof(item.value) <> 'object' then true
        else not item.value ?& array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]
          or item.value - array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues',
            'dueTransition'
          ] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(item.value -> 'finalValues') <> 'object'
          or not vortex_record.deadline_due_transition_is_valid_internal(
            item.value -> 'dueTransition'
          )
        end
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  preparation := vortex_record.prepare_record_deadline_closure(
    p_organization_id, p_storage_contract_id, p_record_id, p_record_type_id,
    p_application_root_id, p_expected_concurrency_number, p_system_actor_id,
    p_effect_id, p_effect_identity, p_transition_at
  );
  if preparation ->> 'outcome' = 'replayed' then
    return (preparation -> 'result') || pg_catalog.jsonb_build_object('replayed', true);
  end if;
  if preparation ->> 'outcome' is distinct from 'prepared' then
    return preparation;
  end if;
  context_value := vortex_record.validated_deadline_system_context_internal();

  select item.value into strict root_record
  from pg_catalog.jsonb_array_elements(preparation -> 'records') item(value)
  where item.value ->> 'recordKey' = 'root';

  -- The supplied parents must be exactly the locked closure's parents at their
  -- locked revisions, each carrying its complete generated-field set.
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
  from pg_catalog.jsonb_array_elements(preparation -> 'records') item(value)
  where item.value ->> 'recordKey' <> 'root';
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', item.value -> 'recordTypeId',
      'recordId', item.value -> 'recordId',
      'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
      'finalFieldIds', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.lower(field_id) order by pg_catalog.lower(field_id) collate "C")
        from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') field(field_id)
      ), '[]'::jsonb)
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into supplied_parents
  from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value);
  if supplied_parents is distinct from expected_parents then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'reasonCode', 'closure_changed');
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(entry.key), entry.value), '{}'::jsonb)
  into root_values
  from pg_catalog.jsonb_each(p_final_values) entry(key, value)
  where entry.value is distinct from coalesce(
    root_record -> 'existingValues' -> pg_catalog.lower(entry.key), 'null'::jsonb
  );

  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    select item.value into strict prepared_parent
    from pg_catalog.jsonb_array_elements(preparation -> 'records') item(value)
    where item.value ->> 'recordKey' <> 'root'
      and item.value ->> 'recordTypeId' = parent_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = parent_value ->> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(entry.key), entry.value), '{}'::jsonb)
    into parent_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_parent -> 'existingValues' -> pg_catalog.lower(entry.key), 'null'::jsonb
    );
    if parent_values <> '{}'::jsonb then
      changed_parents := changed_parents || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'record', prepared_parent,
          'finalValues', parent_values,
          'dueTransition', coalesce(parent_value -> 'dueTransition', 'null'::jsonb)
        )
      );
    end if;
  end loop;

  -- Ordinary saves refuse relationship-total propagation while installed
  -- Rules exist; the deadline closure keeps that same boundary.
  if (preparation ->> 'hasInstalledRules')::boolean
    and pg_catalog.jsonb_array_length(changed_parents) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'rules_unsupported');
  end if;

  root_revision := p_expected_concurrency_number;
  if root_values <> '{}'::jsonb then
    root_revision := vortex_record.apply_deadline_closure_record_internal(
      root_record, root_values, p_activity_id, p_occurrence_id, context_value
    );
  end if;
  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(changed_parents) item(value)
  loop
    parent_revision := vortex_record.apply_deadline_closure_record_internal(
      parent_value -> 'record', parent_value -> 'finalValues',
      pg_catalog.gen_random_uuid(), pg_catalog.gen_random_uuid(), context_value
    );
    perform vortex_record.write_deadline_closure_due_metadata_internal(
      p_organization_id, p_application_root_id, parent_value -> 'record',
      parent_revision, parent_value -> 'dueTransition'
    );
  end loop;
  -- The claimed due row is always replaced or cancelled, so an obsolete
  -- deadline cannot be claimed again even when no value changed.
  perform vortex_record.write_deadline_closure_due_metadata_internal(
    p_organization_id, p_application_root_id, root_record,
    root_revision, p_due_transition
  );

  result_value := pg_catalog.jsonb_build_object(
    'outcome', 'closed',
    'recordId', p_record_id,
    'concurrencyNumber', root_revision
  );
  insert into vortex_record.deadline_transition_effects (
    effect_id, organization_id, storage_contract_id, record_id, application_root_id,
    effect_identity, result
  ) values (
    p_effect_id, p_organization_id, p_storage_contract_id, p_record_id,
    p_application_root_id, p_effect_identity, result_value
  );
  return result_value || pg_catalog.jsonb_build_object('replayed', false);
end
$function$;

alter function vortex_record.deadline_due_transition_is_valid_internal(jsonb)
  owner to vortex_record_adapter;
alter function vortex_record.write_deadline_closure_due_metadata_internal(
  uuid, uuid, jsonb, bigint, jsonb
) owner to vortex_record_adapter;
alter function vortex_record.apply_deadline_closure_record_internal(
  jsonb, jsonb, uuid, uuid, jsonb
) owner to vortex_record_adapter;
alter function vortex_record.prepare_record_deadline_closure(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, timestamptz
) owner to vortex_record_adapter;
alter function vortex_record.finalize_record_deadline_refresh(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, timestamptz, jsonb, jsonb, jsonb, uuid, uuid
) owner to vortex_record_adapter;

revoke all on function vortex_record.deadline_due_transition_is_valid_internal(jsonb),
  vortex_record.write_deadline_closure_due_metadata_internal(uuid, uuid, jsonb, bigint, jsonb),
  vortex_record.apply_deadline_closure_record_internal(jsonb, jsonb, uuid, uuid, jsonb),
  vortex_record.prepare_record_deadline_closure(
    uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, timestamptz
  ),
  vortex_record.finalize_record_deadline_refresh(
    uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, timestamptz, jsonb, jsonb, jsonb, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_record_deadline_closure(
    uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, timestamptz
  ),
  vortex_record.finalize_record_deadline_refresh(
    uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, timestamptz, jsonb, jsonb, jsonb, uuid, uuid
  )
to vortex_runtime;

comment on table vortex_record.deadline_transition_effects is
  'Private #558 idempotency ledger keyed by #557''s deterministic effect identity; a replay returns the committed closure outcome.';
comment on function vortex_record.validated_deadline_system_context_internal() is
  'Fails closed unless the transaction carries a live System context for the configured, unrevoked deadline actor of this execution session.';
comment on function vortex_record.prepare_record_deadline_closure(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, timestamptz
) is
  'Private #558 preflight: locks one claimed root''s concrete relationship-total closure NOWAIT in canonical order and returns the declared calculation inputs.';
comment on function vortex_record.finalize_record_deadline_refresh(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, timestamptz, jsonb, jsonb, jsonb, uuid, uuid
) is
  'Private #558 atomic commit of one claimed deadline transition: root, relationship-total parents, Activity, Events and due metadata in the caller''s transaction.';

reset role;
set local role vortex_record_owner;
revoke references on vortex_record.storage_catalogue from postgres;
revoke create on schema vortex_record from vortex_record_adapter;
revoke create on schema vortex_record from postgres;
reset role;

commit;
