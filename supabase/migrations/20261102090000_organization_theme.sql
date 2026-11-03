-- THEME-ORG: the organisation theme layer. One row per organisation holds the selection delta
-- (only the dimensions the organisation changed) over the platform default selection; the
-- application's own selection and the platform default are resolved with it in the platform
-- theme code. Reads are open to the organisation's members (every application draws with the
-- theme); a change needs the organisation runtime-settings manage permission and the expected
-- revision. The table is owned by vortex_owner, closed to every other role, and reached only
-- through the functions below.
set local role vortex_owner;

create table if not exists vortex_identity.organization_themes (
  organization_id uuid primary key references vortex_identity.organizations(organization_id),
  selection jsonb not null check (pg_catalog.jsonb_typeof(selection) = 'object'),
  revision bigint not null check (revision between 1 and 9007199254740991),
  changed_at timestamptz not null
);
alter table vortex_identity.organization_themes enable row level security;
alter table vortex_identity.organization_themes force row level security;
revoke all on table vortex_identity.organization_themes
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant select on table vortex_identity.organization_themes to postgres;
comment on table vortex_identity.organization_themes is
  'The organisation theme: a selection delta over the platform default theme selection, one row per organisation, read and changed only through vortex_access functions.';

create or replace function vortex_access.read_current_organization_theme_for_application()
returns table (selection jsonb, revision bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  return query
  select theme.selection, theme.revision
  from vortex_identity.organization_themes as theme
  where theme.organization_id = (context_value ->> 'organizationId')::uuid;
end
$function$;

comment on function vortex_access.read_current_organization_theme_for_application() is
  'Reads only the organisation theme of the validated human organisation context: the stored selection delta over the platform default and its revision, or no row when the organisation has none. Every member of the organisation may read it, because every application and Studio draws with it.';

revoke all on function vortex_access.read_current_organization_theme_for_application()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.read_current_organization_theme_for_application()
  to vortex_request;
alter function vortex_access.read_current_organization_theme_for_application()
  owner to vortex_owner;
grant execute on function vortex_access.read_current_organization_theme_for_application()
  to postgres;

create or replace function vortex_access.organization_theme_change_is_permitted()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_access.validated_human_request_context();
  -- The organisation theme is an organisation setting: the runtime-settings manage permission decides.
  return vortex_access.organization_runtime_settings_manage_is_current();
end
$function$;

comment on function vortex_access.organization_theme_change_is_permitted() is
  'Whether the validated human organisation context may change the organisation theme, so the editor can show a read-only theme to a member without the permission. The change itself checks the same permission again.';

revoke all on function vortex_access.organization_theme_change_is_permitted()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.organization_theme_change_is_permitted()
  to vortex_request;
alter function vortex_access.organization_theme_change_is_permitted()
  owner to vortex_owner;
grant execute on function vortex_access.organization_theme_change_is_permitted()
  to postgres;

create or replace function vortex_access.change_current_organization_theme(
  p_expected_revision bigint,
  p_selection jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_value uuid;
  stored vortex_identity.organization_themes%rowtype;
  new_revision bigint;
  setting record;
  now_value timestamptz := pg_catalog.statement_timestamp();
begin
  if p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740990
    or p_selection is null
    or pg_catalog.jsonb_typeof(p_selection) <> 'object' then
    raise exception using errcode = '22023', message = 'Organization theme input is invalid';
  end if;
  for setting in select entry.key, entry.value from pg_catalog.jsonb_each(p_selection) as entry loop
    if setting.key not in (
      'style', 'baseColor', 'theme', 'chartColor', 'radius',
      'menuColor', 'menuAccent', 'iconLibrary', 'bodyFont', 'headingFont'
    )
      or pg_catalog.jsonb_typeof(setting.value) <> 'string'
      or (setting.value #>> '{}') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      or pg_catalog.char_length(setting.value #>> '{}') > 120 then
      raise exception using errcode = '22023', message = 'Organization theme input is invalid';
    end if;
  end loop;

  context_value := vortex_access.validated_human_request_context();
  organization_value := (context_value ->> 'organizationId')::uuid;
  -- The organisation theme is an organisation setting: the runtime-settings manage permission
  -- decides who may change it, exactly as it decides the other organisation settings.
  if not vortex_access.organization_runtime_settings_manage_is_current() then
    raise exception using errcode = '42501', message = 'Organization theme administration is unavailable';
  end if;

  select theme.* into stored
  from vortex_identity.organization_themes as theme
  where theme.organization_id = organization_value
  for update;
  if not found then
    if p_expected_revision <> 0 then
      return pg_catalog.jsonb_build_object('outcome', 'conflict', 'revision', 0);
    end if;
    insert into vortex_identity.organization_themes (
      organization_id, selection, revision, changed_at
    ) values (organization_value, p_selection, 1, now_value)
    on conflict (organization_id) do nothing;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'conflict', 'revision', 1);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', 1);
  end if;
  if stored.revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'revision', stored.revision);
  end if;
  new_revision := stored.revision + 1;
  update vortex_identity.organization_themes as theme
  set selection = p_selection, revision = new_revision, changed_at = now_value
  where theme.organization_id = organization_value;
  return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', new_revision);
end
$function$;

comment on function vortex_access.change_current_organization_theme(bigint, jsonb) is
  'Replaces the organisation theme of the validated human organisation context: the selection delta over the platform default, saved only at the expected revision (0 when none is stored) by a holder of the organisation runtime-settings manage permission. Returns saved or conflict with the stored revision.';

revoke all on function vortex_access.change_current_organization_theme(bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.change_current_organization_theme(bigint, jsonb)
  to vortex_request;
alter function vortex_access.change_current_organization_theme(bigint, jsonb)
  owner to vortex_owner;
grant execute on function vortex_access.change_current_organization_theme(bigint, jsonb)
  to postgres;

reset role;
