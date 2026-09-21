-- Private, owner-only registry of fixed-purpose deadline actor identities.
-- This slice installs no login, activation path, runtime caller, request
-- context or Record effect. Every binding starts disabled and stays disabled
-- until a later, separately reviewed owner step provisions a session role.

begin;

-- The migration role holds this foreign-key privilege only while the two
-- tables are created; it is revoked again before the transaction completes.
grant references on vortex_definition.roots to vortex_record_owner;

set local role vortex_record_owner;

create table vortex_record.deadline_actor_bindings (
  binding_id uuid primary key default pg_catalog.gen_random_uuid()
    constraint deadline_actor_bindings_binding_non_nil check (
      binding_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  organization_id uuid not null
    constraint deadline_actor_bindings_organization_fk
      references vortex_identity.organizations (organization_id)
    constraint deadline_actor_bindings_organization_non_nil check (
      organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  application_root_id uuid
    constraint deadline_actor_bindings_application_root_fk
      references vortex_definition.roots (root_id)
    constraint deadline_actor_bindings_application_non_nil check (
      application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  application_scope_key uuid generated always as (
    coalesce(application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) stored,
  operation text not null default 'refresh_record_deadline'
    constraint deadline_actor_bindings_operation_fixed check (
      operation = 'refresh_record_deadline'
    ),
  current_actor_id uuid,
  generation bigint not null
    constraint deadline_actor_bindings_generation_range check (
      generation between 1 and 9007199254740991
    ),
  execution_session_role_oid oid,
  state text not null default 'disabled'
    constraint deadline_actor_bindings_state_valid check (
      state in ('disabled', 'active', 'revoked')
    ),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint deadline_actor_bindings_scope_unique
    unique nulls not distinct (organization_id, application_root_id, operation),
  constraint deadline_actor_bindings_scope_reference_key
    unique (binding_id, organization_id, operation, application_scope_key),
  constraint deadline_actor_bindings_active_ready check (
    state <> 'active'
    or (current_actor_id is not null and execution_session_role_oid is not null)
  ),
  constraint deadline_actor_bindings_revoked_shape check (
    ((state = 'revoked') = (current_actor_id is null))
    and (state <> 'revoked' or execution_session_role_oid is null)
  )
);

create table vortex_record.deadline_actors (
  actor_id uuid primary key default pg_catalog.gen_random_uuid()
    constraint deadline_actors_actor_non_nil check (
      actor_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  binding_id uuid not null,
  organization_id uuid not null,
  application_root_id uuid,
  application_scope_key uuid generated always as (
    coalesce(application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) stored,
  operation text not null
    constraint deadline_actors_operation_fixed check (
      operation = 'refresh_record_deadline'
    ),
  generation bigint not null
    constraint deadline_actors_generation_range check (
      generation between 1 and 9007199254740991
    ),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  revoked_at timestamptz,
  constraint deadline_actors_binding_generation_unique unique (binding_id, generation),
  constraint deadline_actors_current_reference_key
    unique (actor_id, binding_id, generation),
  constraint deadline_actors_binding_scope_fk
    foreign key (binding_id, organization_id, operation, application_scope_key)
    references vortex_record.deadline_actor_bindings (
      binding_id, organization_id, operation, application_scope_key
    ),
  constraint deadline_actors_revoked_after_creation check (
    revoked_at is null or revoked_at >= created_at
  )
);

-- The current actor must be a generation of this same binding. The reference is
-- deferred so a binding and its first actor can be inserted in either order.
alter table vortex_record.deadline_actor_bindings
  add constraint deadline_actor_bindings_current_actor_fk
  foreign key (current_actor_id, binding_id, generation)
  references vortex_record.deadline_actors (actor_id, binding_id, generation)
  deferrable initially deferred;

alter table vortex_record.deadline_actor_bindings enable row level security;
alter table vortex_record.deadline_actor_bindings force row level security;
alter table vortex_record.deadline_actors enable row level security;
alter table vortex_record.deadline_actors force row level security;
create policy deadline_actor_bindings_owner on vortex_record.deadline_actor_bindings
  to vortex_record_owner using (true) with check (true);
create policy deadline_actors_owner on vortex_record.deadline_actors
  to vortex_record_owner using (true) with check (true);
revoke all on table vortex_record.deadline_actor_bindings, vortex_record.deadline_actors
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;

-- An Application scope must name an Application root of the same organisation.
create function vortex_record.validate_deadline_actor_binding_scope_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if new.application_root_id is not null and not exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = new.application_root_id
      and root.organization_id = new.organization_id
      and root.kind = 'application'
  ) then
    raise exception using errcode = '23503',
      message = 'Deadline actor binding Application root is not in the organisation';
  end if;
  return new;
end
$function$;

-- Scope, purpose and creation facts never change; revocation is terminal.
create function vortex_record.protect_deadline_actor_binding_internal()
returns trigger
language plpgsql
volatile
set search_path = ''
as $function$
begin
  if tg_op <> 'UPDATE' then
    raise exception using errcode = '55000',
      message = 'Deadline actor bindings are retained';
  end if;
  if old.state = 'revoked' then
    raise exception using errcode = '55000',
      message = 'Deadline actor binding is revoked';
  end if;
  if (new.binding_id, new.organization_id, new.application_root_id, new.operation,
      new.created_at)
    is distinct from (old.binding_id, old.organization_id, old.application_root_id,
      old.operation, old.created_at) then
    raise exception using errcode = '55000',
      message = 'Deadline actor binding scope is immutable';
  end if;
  if new.generation < old.generation then
    raise exception using errcode = '55000',
      message = 'Deadline actor binding generation cannot decrease';
  end if;
  return new;
end
$function$;

-- Actor identities are retained after retirement; only the one-way retirement
-- timestamp may change.
create function vortex_record.protect_deadline_actor_internal()
returns trigger
language plpgsql
volatile
set search_path = ''
as $function$
begin
  if tg_op <> 'UPDATE' then
    raise exception using errcode = '55000',
      message = 'Deadline actors are retained';
  end if;
  if (new.actor_id, new.binding_id, new.organization_id, new.application_root_id,
      new.operation, new.generation, new.created_at)
    is distinct from (old.actor_id, old.binding_id, old.organization_id,
      old.application_root_id, old.operation, old.generation, old.created_at)
    or old.revoked_at is not null
    or new.revoked_at is null then
    raise exception using errcode = '55000',
      message = 'Deadline actor identity is immutable';
  end if;
  return new;
end
$function$;

-- Commit-time cycle check: a live binding has exactly one unretired actor and
-- it is the current one; a revoked binding has none.
create function vortex_record.check_deadline_actor_binding_integrity_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  binding_row vortex_record.deadline_actor_bindings%rowtype;
  live_actor_count bigint;
begin
  select binding.* into binding_row
  from vortex_record.deadline_actor_bindings as binding
  where binding.binding_id = new.binding_id;
  if not found then
    raise exception using errcode = '23503',
      message = 'Deadline actor binding is unavailable';
  end if;
  select pg_catalog.count(*) into live_actor_count
  from vortex_record.deadline_actors as actor
  where actor.binding_id = binding_row.binding_id and actor.revoked_at is null;
  if binding_row.state = 'revoked' then
    if live_actor_count <> 0 then
      raise exception using errcode = '23514',
        message = 'A revoked deadline actor binding retains an unretired actor';
    end if;
  elsif live_actor_count <> 1 or not exists (
    select 1
    from vortex_record.deadline_actors as actor
    where actor.actor_id = binding_row.current_actor_id
      and actor.binding_id = binding_row.binding_id
      and actor.revoked_at is null
  ) then
    raise exception using errcode = '23514',
      message = 'A live deadline actor binding requires exactly its current actor';
  end if;
  return null;
end
$function$;

create trigger deadline_actor_bindings_scope_validate
  before insert on vortex_record.deadline_actor_bindings
  for each row execute function vortex_record.validate_deadline_actor_binding_scope_internal();
create trigger deadline_actor_bindings_protect
  before update or delete on vortex_record.deadline_actor_bindings
  for each row execute function vortex_record.protect_deadline_actor_binding_internal();
create trigger deadline_actor_bindings_protect_truncate
  before truncate on vortex_record.deadline_actor_bindings
  for each statement execute function vortex_record.protect_deadline_actor_binding_internal();
create trigger deadline_actors_protect
  before update or delete on vortex_record.deadline_actors
  for each row execute function vortex_record.protect_deadline_actor_internal();
create trigger deadline_actors_protect_truncate
  before truncate on vortex_record.deadline_actors
  for each statement execute function vortex_record.protect_deadline_actor_internal();
create constraint trigger deadline_actor_bindings_integrity
  after insert or update on vortex_record.deadline_actor_bindings
  deferrable initially deferred
  for each row execute function vortex_record.check_deadline_actor_binding_integrity_internal();
create constraint trigger deadline_actors_integrity
  after insert or update on vortex_record.deadline_actors
  deferrable initially deferred
  for each row execute function vortex_record.check_deadline_actor_binding_integrity_internal();

-- Creates a disabled binding and its generation-1 actor. The identifiers are
-- generated here; the caller supplies only the scope.
create function vortex_record.create_deadline_actor_binding_internal(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  new_binding_id uuid := pg_catalog.gen_random_uuid();
  new_actor_id uuid := pg_catalog.gen_random_uuid();
begin
  if p_organization_id is null then
    raise exception using errcode = '22023',
      message = 'Deadline actor binding requires an organisation';
  end if;
  insert into vortex_record.deadline_actor_bindings (
    binding_id, organization_id, application_root_id, operation,
    current_actor_id, generation, state
  ) values (
    new_binding_id, p_organization_id, p_application_root_id,
    'refresh_record_deadline', new_actor_id, 1, 'disabled'
  );
  insert into vortex_record.deadline_actors (
    actor_id, binding_id, organization_id, application_root_id, operation, generation
  ) values (
    new_actor_id, new_binding_id, p_organization_id, p_application_root_id,
    'refresh_record_deadline', 1
  );
  return pg_catalog.jsonb_build_object(
    'bindingId', new_binding_id, 'actorId', new_actor_id,
    'generation', 1, 'state', 'disabled'
  );
end
$function$;

-- Compare-and-swap rotation: retires the current actor and installs the next
-- generation under one row lock. Scope and history are never rewritten.
create function vortex_record.rotate_deadline_actor_binding_internal(
  p_binding_id uuid,
  p_expected_generation bigint
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  binding_row vortex_record.deadline_actor_bindings%rowtype;
  new_actor_id uuid := pg_catalog.gen_random_uuid();
  next_generation bigint;
  changed_time timestamptz := pg_catalog.statement_timestamp();
begin
  if p_binding_id is null or p_expected_generation is null then
    raise exception using errcode = '22023',
      message = 'Deadline actor rotation requires a binding and generation';
  end if;
  select binding.* into binding_row
  from vortex_record.deadline_actor_bindings as binding
  where binding.binding_id = p_binding_id
  for update;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Deadline actor binding is unavailable';
  end if;
  if binding_row.state = 'revoked' then
    raise exception using errcode = '55000',
      message = 'Deadline actor binding is revoked';
  end if;
  if binding_row.generation <> p_expected_generation then
    raise exception using errcode = '55000',
      message = 'Deadline actor binding generation is stale';
  end if;
  next_generation := binding_row.generation + 1;
  update vortex_record.deadline_actors as actor
  set revoked_at = changed_time
  where actor.actor_id = binding_row.current_actor_id;
  insert into vortex_record.deadline_actors (
    actor_id, binding_id, organization_id, application_root_id, operation, generation
  ) values (
    new_actor_id, binding_row.binding_id, binding_row.organization_id,
    binding_row.application_root_id, binding_row.operation, next_generation
  );
  update vortex_record.deadline_actor_bindings as binding
  set current_actor_id = new_actor_id, generation = next_generation,
    changed_at = changed_time
  where binding.binding_id = binding_row.binding_id;
  return pg_catalog.jsonb_build_object(
    'bindingId', binding_row.binding_id, 'actorId', new_actor_id,
    'generation', next_generation, 'state', binding_row.state
  );
end
$function$;

-- Terminal revocation: retires the current actor and clears the pointer. There
-- is no reactivation path; replacement is an explicit owner decision.
create function vortex_record.revoke_deadline_actor_binding_internal(
  p_binding_id uuid,
  p_expected_generation bigint
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  binding_row vortex_record.deadline_actor_bindings%rowtype;
  changed_time timestamptz := pg_catalog.statement_timestamp();
begin
  if p_binding_id is null or p_expected_generation is null then
    raise exception using errcode = '22023',
      message = 'Deadline actor revocation requires a binding and generation';
  end if;
  select binding.* into binding_row
  from vortex_record.deadline_actor_bindings as binding
  where binding.binding_id = p_binding_id
  for update;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Deadline actor binding is unavailable';
  end if;
  if binding_row.state = 'revoked' then
    raise exception using errcode = '55000',
      message = 'Deadline actor binding is revoked';
  end if;
  if binding_row.generation <> p_expected_generation then
    raise exception using errcode = '55000',
      message = 'Deadline actor binding generation is stale';
  end if;
  update vortex_record.deadline_actors as actor
  set revoked_at = changed_time
  where actor.actor_id = binding_row.current_actor_id;
  update vortex_record.deadline_actor_bindings as binding
  set state = 'revoked', current_actor_id = null,
    execution_session_role_oid = null, changed_at = changed_time
  where binding.binding_id = binding_row.binding_id;
  return pg_catalog.jsonb_build_object(
    'bindingId', binding_row.binding_id, 'actorId', binding_row.current_actor_id,
    'generation', binding_row.generation, 'state', 'revoked'
  );
end
$function$;

revoke all on function
  vortex_record.validate_deadline_actor_binding_scope_internal(),
  vortex_record.protect_deadline_actor_binding_internal(),
  vortex_record.protect_deadline_actor_internal(),
  vortex_record.check_deadline_actor_binding_integrity_internal(),
  vortex_record.create_deadline_actor_binding_internal(uuid, uuid),
  vortex_record.rotate_deadline_actor_binding_internal(uuid, bigint),
  vortex_record.revoke_deadline_actor_binding_internal(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;

comment on table vortex_record.deadline_actor_bindings is
  'Private owner-only scope bindings for the fixed refresh_record_deadline operation; disabled until a later owner step provisions a dedicated session role.';
comment on table vortex_record.deadline_actors is
  'Private immutable deadline actor identities, one per binding generation; attribution identifiers, never credentials.';
comment on function vortex_record.create_deadline_actor_binding_internal(uuid, uuid) is
  'Owner-only: creates a disabled deadline actor binding and its generation-1 actor for an organisation or Application scope.';
comment on function vortex_record.rotate_deadline_actor_binding_internal(uuid, bigint) is
  'Owner-only: compare-and-swap rotation to the next deadline actor generation.';
comment on function vortex_record.revoke_deadline_actor_binding_internal(uuid, bigint) is
  'Owner-only: terminal revocation of a deadline actor binding.';

reset role;
revoke references on vortex_definition.roots from vortex_record_owner;

commit;
