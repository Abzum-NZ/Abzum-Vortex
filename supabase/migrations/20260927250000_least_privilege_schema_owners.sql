-- Least-privilege owners for the remaining Vortex service schemas.

do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_access_owner') then
    create role vortex_access_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_access_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_activity_owner') then
    create role vortex_activity_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_activity_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_connection_owner') then
    create role vortex_connection_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_connection_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_context_owner') then
    create role vortex_context_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_context_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_definition_owner') then
    create role vortex_definition_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_definition_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_event_owner') then
    create role vortex_event_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_event_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_file_owner') then
    create role vortex_file_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_file_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_identity_owner') then
    create role vortex_identity_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_identity_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_invalidation_owner') then
    create role vortex_invalidation_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_invalidation_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_operations_owner') then
    create role vortex_operations_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_operations_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_page_owner') then
    create role vortex_page_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_page_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_search_owner') then
    create role vortex_search_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_search_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_workflow_owner') then
    create role vortex_workflow_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_workflow_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
end
$roles$;

revoke vortex_access_owner, vortex_activity_owner, vortex_connection_owner,
  vortex_context_owner, vortex_definition_owner, vortex_event_owner, vortex_file_owner,
  vortex_identity_owner, vortex_invalidation_owner, vortex_operations_owner,
  vortex_page_owner, vortex_search_owner, vortex_workflow_owner
  from anon, authenticated, service_role, vortex_runtime, vortex_request;
-- CREATE ROLE can leave the creator with an admin-only membership. Clear it
-- before installing the single membership that may set each owner role.
revoke vortex_access_owner, vortex_activity_owner, vortex_connection_owner,
  vortex_context_owner, vortex_definition_owner, vortex_event_owner, vortex_file_owner,
  vortex_identity_owner, vortex_invalidation_owner, vortex_operations_owner,
  vortex_page_owner, vortex_search_owner, vortex_workflow_owner
  from postgres;
grant vortex_access_owner, vortex_activity_owner, vortex_connection_owner,
  vortex_context_owner, vortex_definition_owner, vortex_event_owner, vortex_file_owner,
  vortex_identity_owner, vortex_invalidation_owner, vortex_operations_owner,
  vortex_page_owner, vortex_search_owner, vortex_workflow_owner
  to postgres with inherit false, set true;

grant usage, create on schema vortex_access to vortex_access_owner;
grant usage, create on schema vortex_activity to vortex_activity_owner;
grant usage, create on schema vortex_connection to vortex_connection_owner;
grant usage, create on schema vortex_context to vortex_context_owner;
grant usage, create on schema vortex_definition to vortex_definition_owner;
grant usage, create on schema vortex_event to vortex_event_owner;
grant usage, create on schema vortex_file to vortex_file_owner;
grant usage, create on schema vortex_identity to vortex_identity_owner;
grant usage, create on schema vortex_invalidation to vortex_invalidation_owner;
grant usage, create on schema vortex_operations to vortex_operations_owner;
grant usage, create on schema vortex_page to vortex_page_owner;
grant usage, create on schema vortex_search to vortex_search_owner;
grant usage, create on schema vortex_workflow to vortex_workflow_owner;

set local role vortex_access_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_access
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_access
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_activity_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_activity
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_activity
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_connection_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_connection
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_connection
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_context_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_context
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_context
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_definition_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_definition
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_definition
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_event_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_event
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_event
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_file_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_file
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_file
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_identity_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_identity
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_identity
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_invalidation_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_invalidation
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_invalidation
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_operations_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_operations
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_operations
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_page_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_page
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_page
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_search_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_search
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_search
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;

set local role vortex_workflow_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema vortex_workflow
  revoke all on tables from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges in schema vortex_workflow
  revoke all on sequences from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
reset role;
