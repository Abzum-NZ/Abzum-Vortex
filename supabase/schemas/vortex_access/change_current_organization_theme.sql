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
