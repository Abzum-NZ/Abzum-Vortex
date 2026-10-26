create or replace function vortex_access.read_platform_permission_declaration_catalogue_internal(
  p_registration_revision bigint
)
returns table (
  declared_current_revision bigint,
  registration_revision bigint,
  source_version text,
  catalogue_fingerprint text,
  permission_id uuid,
  permission_key text,
  action_kind text,
  label text,
  description text,
  meaning_fingerprint text,
  steward_minimum boolean,
  first_revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  with declarations as materialized (
    select declaration.*
    from vortex_access.platform_permission_declarations as declaration
    where declaration.owner_kind = 'platform'
      and declaration.owner_id = vortex_access.platform_permission_owner_id()
  ),
  valid as (
    select p_registration_revision = 6
      and pg_catalog.count(*) = 23
      and pg_catalog.count(distinct permission_id) = 23
      and pg_catalog.count(distinct permission_key) = 23
      and pg_catalog.count(*) filter (where action_kind = 'named') = 0
      and pg_catalog.bool_and(first_revision between 1 and 6)
      as is_valid
    from declarations
  )
  select 6::bigint, 6::bigint, '1.4.0'::text,
    'sha256:60d2c42cab03723fda56198083a70e8703792587546379372334d99609b15538'::text,
    declaration.permission_id, declaration.permission_key,
    declaration.action_kind, declaration.label, declaration.description,
    declaration.meaning_fingerprint, declaration.steward_minimum,
    declaration.first_revision
  from declarations as declaration
  cross join valid
  where valid.is_valid
$function$;

alter function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  owner to vortex_owner;

revoke all on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  to postgres;
comment on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint) is
  'Returns the trusted current platform permission declaration catalogue to the authorized postgres caller.';
