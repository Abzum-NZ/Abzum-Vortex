begin;
select plan(67);
set local search_path = extensions, public, pg_catalog;

\set tenant_id 'a4900000-0000-4000-8000-000000000001'
\set org_one 'a4900000-0000-4000-8000-000000000002'
\set org_two 'a4900000-0000-4000-8000-000000000003'
\set app_one 'a4900000-0000-4000-8000-000000000004'
\set module_one 'a4900000-0000-4000-8000-000000000005'
\set app_other 'a4900000-0000-4000-8000-000000000006'
\set missing_root 'a4900000-0000-4000-8000-000000000007'
\set missing_org 'a4900000-0000-4000-8000-000000000008'
\set creator 'a4900000-0000-4000-8000-000000000099'

-- The registry is private to the Record owner, so the fixture builds only the
-- organisation and definition-root rows its scope constraints reference. The
-- database-test launcher recursively runs every .sql file beneath
-- supabase/tests, so no separate manifest entry is required.
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values (
  :'tenant_id'::uuid, 'actor_registry', 'Actor registry', 'active',
  pg_catalog.statement_timestamp(), :'creator'::uuid,
  pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values
  (:'org_one'::uuid, :'tenant_id'::uuid, 'actor_registry_a', 'Actor registry A',
    'active', pg_catalog.statement_timestamp(), :'creator'::uuid,
    pg_catalog.statement_timestamp(), 1),
  (:'org_two'::uuid, :'tenant_id'::uuid, 'actor_registry_b', 'Actor registry B',
    'active', pg_catalog.statement_timestamp(), :'creator'::uuid,
    pg_catalog.statement_timestamp(), 1);
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (:'app_one'::uuid, :'org_one'::uuid, 'application', 'vortex.actor_registry.app_one',
    pg_catalog.statement_timestamp(), :'creator'::uuid),
  (:'module_one'::uuid, :'org_one'::uuid, 'module', 'vortex.actor_registry.module_one',
    pg_catalog.statement_timestamp(), :'creator'::uuid),
  (:'app_other'::uuid, :'org_two'::uuid, 'application', 'vortex.actor_registry.app_other',
    pg_catalog.statement_timestamp(), :'creator'::uuid);

-- Installed shape, ownership, forced RLS and effective privileges.
select has_table('vortex_record', 'deadline_actor_bindings',
  'the private deadline actor binding table is installed');
select has_table('vortex_record', 'deadline_actors',
  'the private deadline actor table is installed');
select is((select relowner::regrole::text from pg_catalog.pg_class
  where oid = 'vortex_record.deadline_actor_bindings'::regclass),
  'vortex_record_owner', 'the Record owner owns the binding table');
select is((select relowner::regrole::text from pg_catalog.pg_class
  where oid = 'vortex_record.deadline_actors'::regclass),
  'vortex_record_owner', 'the Record owner owns the actor table');
select ok((select pg_catalog.count(*) = 2 from pg_catalog.pg_class
  where oid in ('vortex_record.deadline_actor_bindings'::regclass,
    'vortex_record.deadline_actors'::regclass)
    and relrowsecurity and relforcerowsecurity),
  'both registry tables enable and force row-level security');
select is((select pg_catalog.count(*)::integer from pg_catalog.pg_policies
  where schemaname = 'vortex_record'
    and tablename in ('deadline_actor_bindings', 'deadline_actors')
    and roles = array['vortex_record_owner']::name[] and cmd = 'ALL'),
  2, 'each registry table has one explicit owner-only policy');
select ok(exists (
  select 1
  from pg_catalog.pg_index as index_row
  where index_row.indrelid = 'vortex_record.deadline_actor_bindings'::regclass
    and index_row.indisunique and index_row.indnullsnotdistinct
    and (
      select pg_catalog.array_agg(attribute.attname order by k.ord)
      from pg_catalog.unnest(index_row.indkey::smallint[]) with ordinality as k(attnum, ord)
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = index_row.indrelid and attribute.attnum = k.attnum
    ) = array['organization_id', 'application_root_id', 'operation']::name[]
), 'the scope identity is unique with NULLS NOT DISTINCT over the nullable Application');
select is((select pg_catalog.count(*)::integer from pg_catalog.pg_proc
  where pronamespace = 'vortex_record'::regnamespace
    and proname ~ 'deadline_actor.*_internal$'),
  7, 'the registry installs exactly three lifecycle and four trigger functions');
select ok(not exists (
  select 1 from pg_catalog.pg_proc as routine
  where routine.pronamespace = 'vortex_record'::regnamespace
    and routine.proname ~ 'deadline_actor.*_internal$'
    and (
      routine.proowner <> 'vortex_record_owner'::regrole
      or routine.proconfig is null
      or not (routine.proconfig @> array['search_path=""'])
    )
), 'every registry function is Record-owner owned with a fixed empty search path');
select is((select pg_catalog.count(*)::integer from pg_catalog.pg_proc
  where oid in (
    'vortex_record.create_deadline_actor_binding_internal(uuid,uuid)'::regprocedure,
    'vortex_record.rotate_deadline_actor_binding_internal(uuid,bigint)'::regprocedure,
    'vortex_record.revoke_deadline_actor_binding_internal(uuid,bigint)'::regprocedure
  ) and not prosecdef),
  3, 'the lifecycle functions run with the caller authority, which is owner-only');
select ok(not exists (
  select 1
  from pg_catalog.pg_class as relation
  cross join lateral pg_catalog.aclexplode(coalesce(
    relation.relacl, pg_catalog.acldefault('r', relation.relowner)
  )) as privilege
  where relation.oid in ('vortex_record.deadline_actor_bindings'::regclass,
      'vortex_record.deadline_actors'::regclass)
    and privilege.grantee <> relation.relowner
), 'no role other than the owner holds any privilege on the registry tables');
select ok(not exists (
  select 1
  from pg_catalog.pg_proc as routine
  cross join lateral pg_catalog.aclexplode(coalesce(
    routine.proacl, pg_catalog.acldefault('f', routine.proowner)
  )) as privilege
  where routine.pronamespace = 'vortex_record'::regnamespace
    and routine.proname ~ 'deadline_actor.*_internal$'
    and privilege.grantee <> routine.proowner
), 'no role other than the owner, including PUBLIC, may execute a registry function');
select ok(not exists (
  select 1
  from pg_catalog.unnest(array['anon', 'authenticated', 'service_role', 'vortex_runtime',
    'vortex_request', 'vortex_record_adapter', 'vortex_module_owner']) as role_name
  cross join pg_catalog.unnest(array['vortex_record.deadline_actor_bindings',
    'vortex_record.deadline_actors']) as table_name
  where has_table_privilege(role_name::name, table_name::regclass,
    'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
), 'no client, runtime, adapter or sibling-owner role has an effective table privilege');
select ok(not exists (
  select 1
  from pg_catalog.unnest(array['anon', 'authenticated', 'service_role', 'vortex_runtime',
    'vortex_request', 'vortex_record_adapter', 'vortex_module_owner']) as role_name
  cross join pg_catalog.unnest(array[
    'vortex_record.create_deadline_actor_binding_internal(uuid,uuid)',
    'vortex_record.rotate_deadline_actor_binding_internal(uuid,bigint)',
    'vortex_record.revoke_deadline_actor_binding_internal(uuid,bigint)'
  ]) as function_name
  where has_function_privilege(role_name::name, function_name::regprocedure, 'EXECUTE')
), 'no client, runtime, adapter or sibling-owner role may execute a lifecycle function');
select ok(not exists (
  select 1
  from pg_catalog.pg_class as relation
  cross join lateral pg_catalog.aclexplode(coalesce(
    relation.relacl, pg_catalog.acldefault('r', relation.relowner)
  )) as privilege
  where relation.oid = 'vortex_definition.roots'::regclass
    and privilege.grantee = 'vortex_record_owner'::regrole
    and privilege.privilege_type = 'REFERENCES'
), 'the temporary definition-root foreign-key privilege is revoked after installation');
select ok(not exists (
  select 1
  from pg_catalog.pg_namespace as schema
  cross join lateral pg_catalog.aclexplode(coalesce(
    schema.nspacl, pg_catalog.acldefault('n', schema.nspowner)
  )) as privilege
  where schema.oid = 'vortex_record'::regnamespace
    and privilege.grantee in ('postgres'::regrole, 'vortex_record_adapter'::regrole)
    and privilege.privilege_type = 'CREATE'
), 'no migration or adapter schema creation grant survives installation');

-- Lifecycle proof under the Record owner. Restricted roles cannot resolve the
-- pgTAP helpers, so every operation is captured while the role is active and
-- asserted after reset role.
set local role vortex_record_owner;
create temporary table owner_results (
  case_name text primary key,
  result jsonb,
  returned_sqlstate text,
  message_text text
) on commit drop;
create function pg_temp.capture_case(p_case text, p_statement text)
returns void language plpgsql volatile set search_path = '' as $function$
declare
  v_result jsonb;
  v_sqlstate text;
  v_message text;
begin
  begin
    if pg_catalog.lower(pg_catalog.left(p_statement, 6)) = 'select' then
      execute p_statement into v_result;
    else
      execute p_statement;
    end if;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_message = message_text;
  end;
  insert into pg_temp.owner_results values (p_case, v_result, v_sqlstate, v_message);
end
$function$;
-- Forces this registry's deferred commit-time checks now, then restores deferral.
-- Only its own constraints are named: ALL would also run the fixture's deferred
-- tenant and organisation lifecycle triggers under the Record owner.
create function pg_temp.check_integrity(p_case text)
returns void language plpgsql volatile set search_path = '' as $function$
declare
  v_sqlstate text;
begin
  begin
    set constraints
      vortex_record.deadline_actor_bindings_integrity,
      vortex_record.deadline_actors_integrity,
      vortex_record.deadline_actor_bindings_current_actor_fk immediate;
  exception when others then
    v_sqlstate := sqlstate;
  end;
  set constraints
      vortex_record.deadline_actor_bindings_integrity,
      vortex_record.deadline_actors_integrity,
      vortex_record.deadline_actor_bindings_current_actor_fk deferred;
  insert into pg_temp.owner_results (case_name, returned_sqlstate) values (p_case, v_sqlstate);
end
$function$;

select pg_temp.capture_case('create_org', pg_catalog.format(
  $q$select vortex_record.create_deadline_actor_binding_internal(%L::uuid, null::uuid)$q$,
  :'org_one'));
select pg_temp.capture_case('create_app', pg_catalog.format(
  $q$select vortex_record.create_deadline_actor_binding_internal(%L::uuid, %L::uuid)$q$,
  :'org_one', :'app_one'));
select pg_temp.capture_case('dup_org', pg_catalog.format(
  $q$select vortex_record.create_deadline_actor_binding_internal(%L::uuid, null::uuid)$q$,
  :'org_one'));
select pg_temp.capture_case('dup_app', pg_catalog.format(
  $q$select vortex_record.create_deadline_actor_binding_internal(%L::uuid, %L::uuid)$q$,
  :'org_one', :'app_one'));
select pg_temp.capture_case('unknown_org', pg_catalog.format(
  $q$select vortex_record.create_deadline_actor_binding_internal(%L::uuid, null::uuid)$q$,
  :'missing_org'));
select pg_temp.capture_case('foreign_root', pg_catalog.format(
  $q$select vortex_record.create_deadline_actor_binding_internal(%L::uuid, %L::uuid)$q$,
  :'org_one', :'app_other'));
select pg_temp.capture_case('module_root', pg_catalog.format(
  $q$select vortex_record.create_deadline_actor_binding_internal(%L::uuid, %L::uuid)$q$,
  :'org_one', :'module_one'));
select pg_temp.capture_case('missing_root', pg_catalog.format(
  $q$select vortex_record.create_deadline_actor_binding_internal(%L::uuid, %L::uuid)$q$,
  :'org_one', :'missing_root'));
select pg_temp.capture_case('null_org',
  $q$select vortex_record.create_deadline_actor_binding_internal(null::uuid, null::uuid)$q$);
select pg_temp.capture_case('bad_operation', pg_catalog.format(
  $q$insert into vortex_record.deadline_actor_bindings (
    organization_id, operation, current_actor_id, generation
  ) values (%L::uuid, 'other_operation', pg_catalog.gen_random_uuid(), 1)$q$,
  :'org_two'));
select pg_temp.capture_case('active_without_role', pg_catalog.format(
  $q$insert into vortex_record.deadline_actor_bindings (
    organization_id, current_actor_id, generation, state
  ) values (%L::uuid, pg_catalog.gen_random_uuid(), 1, 'active')$q$,
  :'org_two'));
select pg_temp.capture_case('forged_org_actor', pg_catalog.format(
  $q$insert into vortex_record.deadline_actors (
    binding_id, organization_id, operation, generation
  ) values (%L::uuid, %L::uuid, 'refresh_record_deadline', 5)$q$,
  (select result ->> 'bindingId' from pg_temp.owner_results where case_name = 'create_org'),
  :'org_two'));
select pg_temp.capture_case('forged_app_actor', pg_catalog.format(
  $q$insert into vortex_record.deadline_actors (
    binding_id, organization_id, application_root_id, operation, generation
  ) values (%L::uuid, %L::uuid, %L::uuid, 'refresh_record_deadline', 6)$q$,
  (select result ->> 'bindingId' from pg_temp.owner_results where case_name = 'create_org'),
  :'org_one', :'app_one'));
select pg_temp.capture_case('duplicate_generation', pg_catalog.format(
  $q$insert into vortex_record.deadline_actors (
    binding_id, organization_id, operation, generation
  ) values (%L::uuid, %L::uuid, 'refresh_record_deadline', 1)$q$,
  (select result ->> 'bindingId' from pg_temp.owner_results where case_name = 'create_org'),
  :'org_one'));
select pg_temp.check_integrity('integrity_after_create');
reset role;

select
  (select result ->> 'bindingId' from pg_temp.owner_results where case_name = 'create_org') as org_binding,
  (select result ->> 'actorId' from pg_temp.owner_results where case_name = 'create_org') as org_actor_one,
  (select result ->> 'bindingId' from pg_temp.owner_results where case_name = 'create_app') as app_binding,
  (select result ->> 'actorId' from pg_temp.owner_results where case_name = 'create_app') as app_actor
\gset

select is((select concat_ws('|', result ->> 'state', result ->> 'generation')
  from pg_temp.owner_results where case_name = 'create_org'),
  'disabled|1', 'creating an organisation binding returns a disabled generation-1 actor');
select is((select pg_catalog.concat_ws('|', operation, (current_actor_id = :'org_actor_one'::uuid)::text,
    generation::text, state, (execution_session_role_oid is null)::text,
    (application_root_id is null)::text)
  from vortex_record.deadline_actor_bindings where binding_id = :'org_binding'::uuid),
  'refresh_record_deadline|true|1|disabled|true|true',
  'the stored organisation binding is fixed-purpose, disabled and has no session role');
select ok((select substr(result ->> 'bindingId', 15, 1) = '4'
    and substr(result ->> 'actorId', 15, 1) = '4'
    and result ->> 'bindingId' <> result ->> 'actorId'
  from pg_temp.owner_results where case_name = 'create_org'),
  'binding and actor identifiers are server-generated random UUIDs');
select is((select pg_catalog.concat_ws('|', state, generation::text, application_root_id::text)
  from vortex_record.deadline_actor_bindings where binding_id = :'app_binding'::uuid),
  'disabled|1|' || :'app_one', 'an Application binding records its Application root');
select is((select pg_catalog.concat_ws('|', generation::text, (revoked_at is null)::text, operation)
  from vortex_record.deadline_actors where actor_id = :'org_actor_one'::uuid),
  '1|true|refresh_record_deadline', 'the generation-1 actor is live with the fixed purpose');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'dup_org'),
  '23505', 'a second organisation binding for the same scope is refused');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'dup_app'),
  '23505', 'a second Application binding for the same scope is refused');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'unknown_org'),
  '23503', 'an unknown organisation is refused');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'foreign_root'),
  '23503', 'an Application root of another organisation is refused');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'module_root'),
  '23503', 'a non-Application definition root is refused');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'missing_root'),
  '23503', 'an unknown Application root is refused');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'null_org'),
  '22023', 'a missing organisation is refused before any write');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'bad_operation'),
  '23514', 'the stored purpose is fixed to refresh_record_deadline');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'active_without_role'),
  '23514', 'a binding cannot be active without a provisioned session role');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'forged_org_actor'),
  '23503', 'an actor cannot carry another organisation than its binding');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'forged_app_actor'),
  '23503', 'an actor cannot carry an Application scope its binding lacks');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'duplicate_generation'),
  '23505', 'a binding cannot have two actors of one generation');
select is((select coalesce(returned_sqlstate, 'none') from pg_temp.owner_results
  where case_name = 'integrity_after_create'),
  'none', 'created bindings satisfy the commit-time actor integrity check');
select is((select (select pg_catalog.count(*) from vortex_record.deadline_actor_bindings)::text
    || '|' || (select pg_catalog.count(*) from vortex_record.deadline_actors)::text),
  '2|2', 'refused creations and forgeries leave only the two created bindings and actors');

-- Rotation: atomic compare-and-swap that retains the retired actor.
set local role vortex_record_owner;
select pg_temp.capture_case('rotate_ok', pg_catalog.format(
  $q$select vortex_record.rotate_deadline_actor_binding_internal(%L::uuid, 1)$q$,
  :'org_binding'));
select pg_temp.capture_case('rotate_stale', pg_catalog.format(
  $q$select vortex_record.rotate_deadline_actor_binding_internal(%L::uuid, 1)$q$,
  :'org_binding'));
select pg_temp.capture_case('rotate_missing', pg_catalog.format(
  $q$select vortex_record.rotate_deadline_actor_binding_internal(%L::uuid, 1)$q$,
  :'missing_org'));
select pg_temp.check_integrity('integrity_after_rotate');
reset role;

select (select result ->> 'actorId' from pg_temp.owner_results where case_name = 'rotate_ok') as org_actor_two
\gset

select is((select concat_ws('|', result ->> 'generation', (result ->> 'actorId' <> :'org_actor_one')::text)
  from pg_temp.owner_results where case_name = 'rotate_ok'),
  '2|true', 'rotation returns the next generation with a new actor');
select is((select pg_catalog.concat_ws('|', generation::text, (current_actor_id = :'org_actor_two'::uuid)::text)
  from vortex_record.deadline_actor_bindings where binding_id = :'org_binding'::uuid),
  '2|true', 'rotation moves the current-actor pointer and generation together');
select is((select pg_catalog.concat_ws('|',
    (pg_catalog.count(*) filter (where revoked_at is not null))::text,
    (pg_catalog.count(*) filter (where revoked_at is null))::text)
  from vortex_record.deadline_actors where binding_id = :'org_binding'::uuid),
  '1|1', 'rotation retires exactly the old actor and leaves one live actor');
select is((select pg_catalog.concat_ws('|', generation::text, organization_id::text)
  from vortex_record.deadline_actors where actor_id = :'org_actor_one'::uuid),
  '1|' || :'org_one', 'the retired actor keeps its generation and scope');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'rotate_stale'),
  '55000', 'a stale expected generation cannot rotate the binding');
select is((select generation::text from vortex_record.deadline_actor_bindings
  where binding_id = :'org_binding'::uuid),
  '2', 'the refused stale rotation leaves the generation unchanged');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'rotate_missing'),
  'P0002', 'rotating an unknown binding is refused');
select is((select coalesce(returned_sqlstate, 'none') from pg_temp.owner_results
  where case_name = 'integrity_after_rotate'),
  'none', 'a rotated binding satisfies the commit-time actor integrity check');

-- Revocation: terminal, retains history and keeps the scope occupied.
set local role vortex_record_owner;
select pg_temp.capture_case('revoke_stale', pg_catalog.format(
  $q$select vortex_record.revoke_deadline_actor_binding_internal(%L::uuid, 1)$q$,
  :'org_binding'));
select pg_temp.capture_case('revoke_ok', pg_catalog.format(
  $q$select vortex_record.revoke_deadline_actor_binding_internal(%L::uuid, 2)$q$,
  :'org_binding'));
select pg_temp.capture_case('rotate_revoked', pg_catalog.format(
  $q$select vortex_record.rotate_deadline_actor_binding_internal(%L::uuid, 2)$q$,
  :'org_binding'));
select pg_temp.capture_case('revoke_revoked', pg_catalog.format(
  $q$select vortex_record.revoke_deadline_actor_binding_internal(%L::uuid, 2)$q$,
  :'org_binding'));
select pg_temp.capture_case('recreate_after_revoke', pg_catalog.format(
  $q$select vortex_record.create_deadline_actor_binding_internal(%L::uuid, null::uuid)$q$,
  :'org_one'));
select pg_temp.check_integrity('integrity_after_revoke');
reset role;

select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'revoke_stale'),
  '55000', 'a stale expected generation cannot revoke the binding');
select is((select concat_ws('|', result ->> 'state', result ->> 'generation')
  from pg_temp.owner_results where case_name = 'revoke_ok'),
  'revoked|2', 'revocation reports the terminal state at the current generation');
select is((select pg_catalog.concat_ws('|', state, (current_actor_id is null)::text,
    (execution_session_role_oid is null)::text, generation::text)
  from vortex_record.deadline_actor_bindings where binding_id = :'org_binding'::uuid),
  'revoked|true|true|2', 'a revoked binding has no current actor or session role');
select is((select pg_catalog.concat_ws('|',
    (pg_catalog.count(*) filter (where revoked_at is null))::text, pg_catalog.count(*)::text)
  from vortex_record.deadline_actors where binding_id = :'org_binding'::uuid),
  '0|2', 'revocation retains every actor and leaves none live');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'rotate_revoked'),
  '55000', 'a revoked binding cannot be rotated');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'revoke_revoked'),
  '55000', 'a revoked binding cannot be revoked again');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'recreate_after_revoke'),
  '23505', 'revocation is terminal: the same scope cannot be silently re-created');
select is((select coalesce(returned_sqlstate, 'none') from pg_temp.owner_results
  where case_name = 'integrity_after_revoke'),
  'none', 'a revoked binding satisfies the commit-time actor integrity check');

-- Direct table mutation by the owner cannot break history or scope.
set local role vortex_record_owner;
select pg_temp.capture_case('actor_generation_update', pg_catalog.format(
  $q$update vortex_record.deadline_actors set generation = 9 where actor_id = %L::uuid$q$,
  :'app_actor'));
select pg_temp.capture_case('actor_unrevoke', pg_catalog.format(
  $q$update vortex_record.deadline_actors set revoked_at = null where actor_id = %L::uuid$q$,
  :'org_actor_one'));
select pg_temp.capture_case('actor_delete', pg_catalog.format(
  $q$delete from vortex_record.deadline_actors where actor_id = %L::uuid$q$,
  :'app_actor'));
select pg_temp.capture_case('binding_delete', pg_catalog.format(
  $q$delete from vortex_record.deadline_actor_bindings where binding_id = %L::uuid$q$,
  :'app_binding'));
select pg_temp.capture_case('binding_scope_move', pg_catalog.format(
  $q$update vortex_record.deadline_actor_bindings set organization_id = %L::uuid
    where binding_id = %L::uuid$q$,
  :'org_two', :'app_binding'));
select pg_temp.capture_case('revoked_binding_update', pg_catalog.format(
  $q$update vortex_record.deadline_actor_bindings
    set changed_at = pg_catalog.statement_timestamp() where binding_id = %L::uuid$q$,
  :'org_binding'));
select pg_temp.capture_case('registry_truncate',
  $q$truncate vortex_record.deadline_actor_bindings cascade$q$);
reset role;

select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'actor_generation_update'),
  '55000', 'an actor identity column cannot be rewritten');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'actor_unrevoke'),
  '55000', 'a retired actor cannot be reinstated');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'actor_delete'),
  '55000', 'an actor cannot be deleted');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'binding_delete'),
  '55000', 'a binding cannot be deleted');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'binding_scope_move'),
  '55000', 'a binding scope cannot be moved');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'revoked_binding_update'),
  '55000', 'a revoked binding cannot be updated');
select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'registry_truncate'),
  '55000', 'the registry cannot be truncated');
select is((select (select pg_catalog.count(*) from vortex_record.deadline_actor_bindings)::text
    || '|' || (select pg_catalog.count(*) from vortex_record.deadline_actors)::text),
  '2|3', 'every refused mutation left the registry rows intact');

-- Commit-time integrity rejects rows that pass their own column checks.
set local role vortex_record_owner;
do $capture$
declare
  v_state text;
  v_binding record;
begin
  select binding.* into v_binding
  from vortex_record.deadline_actor_bindings as binding
  where binding.binding_id = (
    select (result ->> 'bindingId')::uuid from pg_temp.owner_results where case_name = 'create_app'
  );
  begin
    insert into vortex_record.deadline_actors (
      binding_id, organization_id, application_root_id, operation, generation
    ) values (
      v_binding.binding_id, v_binding.organization_id, v_binding.application_root_id,
      v_binding.operation, 2
    );
    set constraints
      vortex_record.deadline_actor_bindings_integrity,
      vortex_record.deadline_actors_integrity,
      vortex_record.deadline_actor_bindings_current_actor_fk immediate;
  exception when others then
    v_state := sqlstate;
  end;
  set constraints
      vortex_record.deadline_actor_bindings_integrity,
      vortex_record.deadline_actors_integrity,
      vortex_record.deadline_actor_bindings_current_actor_fk deferred;
  insert into pg_temp.owner_results (case_name, returned_sqlstate)
  values ('extra_live_actor', v_state);
end
$capture$;
do $capture$
declare
  v_state text;
begin
  begin
    update vortex_record.deadline_actor_bindings
    set current_actor_id = (
      select (result ->> 'actorId')::uuid from pg_temp.owner_results where case_name = 'create_org'
    )
    where binding_id = (
      select (result ->> 'bindingId')::uuid from pg_temp.owner_results where case_name = 'create_app'
    );
    set constraints
      vortex_record.deadline_actor_bindings_integrity,
      vortex_record.deadline_actors_integrity,
      vortex_record.deadline_actor_bindings_current_actor_fk immediate;
  exception when others then
    v_state := sqlstate;
  end;
  set constraints
      vortex_record.deadline_actor_bindings_integrity,
      vortex_record.deadline_actors_integrity,
      vortex_record.deadline_actor_bindings_current_actor_fk deferred;
  insert into pg_temp.owner_results (case_name, returned_sqlstate)
  values ('foreign_current_actor', v_state);
end
$capture$;
reset role;

select is((select returned_sqlstate from pg_temp.owner_results where case_name = 'extra_live_actor'),
  '23514', 'a second live actor for one binding fails the integrity check');
select ok((select returned_sqlstate in ('23503', '23514') from pg_temp.owner_results
  where case_name = 'foreign_current_actor'),
  'a current-actor pointer outside its binding fails the integrity check');

-- Client, runtime and adapter roles are refused by effective privilege.
set local role vortex_runtime;
do $capture$
begin
  begin
    perform vortex_record.create_deadline_actor_binding_internal(
      'a4900000-0000-4000-8000-000000000002'::uuid, null::uuid);
    perform pg_catalog.set_config('vortex_test.runtime_function', 'succeeded', true);
  exception when others then
    perform pg_catalog.set_config('vortex_test.runtime_function', sqlstate, true);
  end;
  begin
    perform 1 from vortex_record.deadline_actor_bindings;
    perform pg_catalog.set_config('vortex_test.runtime_table', 'succeeded', true);
  exception when others then
    perform pg_catalog.set_config('vortex_test.runtime_table', sqlstate, true);
  end;
end
$capture$;
reset role;
set local role vortex_request;
do $capture$
begin
  begin
    perform vortex_record.create_deadline_actor_binding_internal(
      'a4900000-0000-4000-8000-000000000002'::uuid, null::uuid);
    perform pg_catalog.set_config('vortex_test.request_function', 'succeeded', true);
  exception when others then
    perform pg_catalog.set_config('vortex_test.request_function', sqlstate, true);
  end;
  begin
    perform 1 from vortex_record.deadline_actor_bindings;
    perform pg_catalog.set_config('vortex_test.request_table', 'succeeded', true);
  exception when others then
    perform pg_catalog.set_config('vortex_test.request_table', sqlstate, true);
  end;
end
$capture$;
reset role;
set local role vortex_record_adapter;
do $capture$
begin
  begin
    perform vortex_record.create_deadline_actor_binding_internal(
      'a4900000-0000-4000-8000-000000000002'::uuid, null::uuid);
    perform pg_catalog.set_config('vortex_test.adapter_function', 'succeeded', true);
  exception when others then
    perform pg_catalog.set_config('vortex_test.adapter_function', sqlstate, true);
  end;
  begin
    perform 1 from vortex_record.deadline_actor_bindings;
    perform pg_catalog.set_config('vortex_test.adapter_table', 'succeeded', true);
  exception when others then
    perform pg_catalog.set_config('vortex_test.adapter_table', sqlstate, true);
  end;
end
$capture$;
reset role;

select is(pg_catalog.current_setting('vortex_test.runtime_function'), '42501',
  'the runtime role cannot invoke a lifecycle function');
select is(pg_catalog.current_setting('vortex_test.runtime_table'), '42501',
  'the runtime role cannot read the binding table');
select is(pg_catalog.current_setting('vortex_test.request_function'), '42501',
  'the request role cannot invoke a lifecycle function');
select is(pg_catalog.current_setting('vortex_test.request_table'), '42501',
  'the request role cannot read the binding table');
select is(pg_catalog.current_setting('vortex_test.adapter_function'), '42501',
  'the Record adapter cannot invoke a lifecycle function');
select is(pg_catalog.current_setting('vortex_test.adapter_table'), '42501',
  'the Record adapter cannot read the binding table');

select * from finish();
rollback;
