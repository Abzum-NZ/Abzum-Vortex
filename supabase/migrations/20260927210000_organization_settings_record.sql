begin;

alter table vortex_identity.organization_runtime_settings
  add column extension_values jsonb not null default '{}'::jsonb
    constraint organization_runtime_settings_extension_values_object
    check (pg_catalog.jsonb_typeof(extension_values) = 'object');

create or replace function vortex_identity.save_organization_runtime_settings_record_internal(
  p_organization_id uuid,
  p_expected_revision bigint,
  p_core_values jsonb,
  p_extension_values jsonb
)
returns table (
  organization_id uuid,
  language text,
  time_zone text,
  currency text,
  date_format text,
  number_format text,
  default_application_root_id uuid,
  extension_values jsonb,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_runtime_settings%rowtype;
  language_value text;
  time_zone_value text;
  currency_value text;
  date_format_value text;
  number_format_value text;
  default_application_root_id_value uuid;
  extension_values_value jsonb;
  extension_item record;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_core_values) is distinct from 'object'
    or p_core_values - array[
      'language', 'time_zone', 'currency', 'date_format', 'number_format',
      'default_application_root_id'
    ] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_extension_values) is distinct from 'object'
    or p_extension_values ?| array[
      'organization_id', 'revision', 'language', 'time_zone', 'currency',
      'date_format', 'number_format', 'default_application_root_id'
    ] then
    raise exception using errcode = '22023',
      message = 'Organization settings record update is invalid';
  end if;

  select settings.* into existing
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id
  for update;
  if not found or existing.revision <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'Organization settings record is stale or unavailable';
  end if;

  language_value := existing.language;
  time_zone_value := existing.time_zone;
  currency_value := existing.currency;
  date_format_value := existing.date_format;
  number_format_value := existing.number_format;
  default_application_root_id_value := existing.default_application_root_id;

  if p_core_values ? 'language' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'language') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    language_value := p_core_values ->> 'language';
  end if;
  if p_core_values ? 'time_zone' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'time_zone') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    time_zone_value := p_core_values ->> 'time_zone';
  end if;
  if p_core_values ? 'currency' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'currency') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    currency_value := p_core_values ->> 'currency';
  end if;
  if p_core_values ? 'date_format' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'date_format') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    date_format_value := p_core_values ->> 'date_format';
  end if;
  if p_core_values ? 'number_format' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'number_format') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    number_format_value := p_core_values ->> 'number_format';
  end if;
  if p_core_values ? 'default_application_root_id' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') = 'null' then
      default_application_root_id_value := null;
    elsif pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') = 'string'
      and pg_catalog.pg_input_is_valid(
        p_core_values ->> 'default_application_root_id', 'uuid'
      ) then
      default_application_root_id_value :=
        (p_core_values ->> 'default_application_root_id')::uuid;
    else
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    if default_application_root_id_value = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    language_value, time_zone_value, currency_value, date_format_value, number_format_value
  );

  extension_values_value := existing.extension_values;
  for extension_item in
    select item.key, item.value
    from pg_catalog.jsonb_each(p_extension_values) as item(key, value)
    order by item.key collate "C"
  loop
    if pg_catalog.jsonb_typeof(extension_item.value) = 'null' then
      extension_values_value := extension_values_value - extension_item.key;
    else
      extension_values_value := extension_values_value || pg_catalog.jsonb_build_object(
        extension_item.key, extension_item.value
      );
    end if;
  end loop;

  update vortex_identity.organization_runtime_settings as settings
  set language = language_value,
      time_zone = time_zone_value,
      currency = currency_value,
      date_format = date_format_value,
      number_format = number_format_value,
      default_application_root_id = default_application_root_id_value,
      extension_values = extension_values_value,
      changed_at = pg_catalog.statement_timestamp(),
      revision = settings.revision + 1
  where settings.organization_id = p_organization_id
  returning * into existing;

  return query select existing.organization_id, existing.language, existing.time_zone,
    existing.currency, existing.date_format, existing.number_format,
    existing.default_application_root_id, existing.extension_values, existing.revision;
end
$function$;

revoke all on function vortex_identity.save_organization_runtime_settings_record_internal(
  uuid, bigint, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter;
comment on function vortex_identity.save_organization_runtime_settings_record_internal(
  uuid, bigint, jsonb, jsonb
) is
  'Private revision-checked Identity writer for one organisation settings record, merging invariant field patches and declared extension values in the same settings row.';

create or replace function vortex_access.organization_runtime_settings_manage_is_current()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  decision record;
begin
  context_value := vortex_access.validated_human_request_context();
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.runtime_settings.update',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', 'c658c254-2884-414a-9012-512c0cfe4b34'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  return decision.outcome = 'eligible'
    and decision.operation_key = 'platform.organization.runtime_settings.update'
    and decision.organization_id = (context_value ->> 'organizationId')::uuid
    and decision.organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and decision.access_version = (context_value ->> 'accessVersion')::bigint
    and decision.correlation_id = (context_value ->> 'correlationId')::uuid;
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or invalid_text_representation then
    return false;
end
$function$;

revoke all on function vortex_access.organization_runtime_settings_manage_is_current()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.organization_runtime_settings_manage_is_current()
  to vortex_record_adapter;

comment on function vortex_access.organization_runtime_settings_manage_is_current() is
  'Checks the verified request for the current platform.organization.runtime_settings.manage permission and returns only the exact eligibility result.';

create or replace function vortex_access.list_organization_runtime_settings_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  settings_row record;
  settings_default_application_root_id uuid;
  settings_extension_values jsonb;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- runtime-settings read decision the bespoke reader applies decides whether
  -- any row exists at all, and the caller's current organisation is never an
  -- input. A viewer the decision refuses sees no row, exactly as a missing or
  -- foreign record, so the record adapters return their identical refusal and
  -- a list page is empty rather than failing. The record identity is the
  -- organisation, whose settings are a single row, and the revision is the
  -- settings document's own revision, which the default application shares.
  -- Attribute names are the lowercase field keys a projection record type
  -- declares.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_runtime_settings_administration_read_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  select result.* into settings_row
  from vortex_identity.read_current_organization_runtime_settings_internal(
    scope_row.organization_id
  ) as result;
  if settings_row.organization_id is null
    or settings_row.organization_id is distinct from scope_row.organization_id then
    return;
  end if;
  if p_record_id is not null and p_record_id <> settings_row.organization_id then
    return;
  end if;
  select settings.default_application_root_id, settings.extension_values
  into settings_default_application_root_id, settings_extension_values
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = settings_row.organization_id;
  return query select
    settings_row.organization_id,
    settings_row.organization_id,
    settings_row.revision,
    coalesce(settings_extension_values, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'language', settings_row.language,
      'time_zone', settings_row.time_zone,
      'currency', settings_row.currency,
      'date_format', settings_row.date_format,
      'number_format', settings_row.number_format,
      'default_application_root_id', settings_default_application_root_id
    );
end
$function$;

revoke all on function vortex_access.list_organization_runtime_settings_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_runtime_settings_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_runtime_settings_projection(uuid, integer) is
  'Registered organisation runtime-settings projection: returns the one settings row the current viewer may read under the fixed runtime-settings decision, with the organisation, the record identity, the settings revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer or no settings exist.';

create or replace function vortex_access.save_organization_settings_record_for_administration(
  p_record_id uuid,
  p_expected_revision bigint,
  p_core_values jsonb,
  p_extension_values jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_correlation_id uuid;
  saved record;
  default_application_root_id_value uuid;
begin
  if p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_core_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_extension_values) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Organization settings record save requires an Application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  if p_record_id is distinct from context_organization_id then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  perform 1
  from vortex_access.organization_access_versions as access_version
  where access_version.organization_id = context_organization_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  if not vortex_access.organization_runtime_settings_manage_is_current() then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  if p_core_values ? 'default_application_root_id'
    and pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') <> 'null' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') <> 'string'
      or not pg_catalog.pg_input_is_valid(
        p_core_values ->> 'default_application_root_id', 'uuid'
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    default_application_root_id_value :=
      (p_core_values ->> 'default_application_root_id')::uuid;
    if default_application_root_id_value = '00000000-0000-0000-0000-000000000000'::uuid
      or not exists (
        select 1
        from vortex_access.permission_registrations as registration
        join vortex_definition.roots as root
          on root.root_id = registration.registration_owner_id
          and root.organization_id = registration.organization_id
          and root.kind = 'application'
        where registration.organization_id = context_organization_id
          and registration.registration_kind = 'application'
          and registration.registration_owner_id = default_application_root_id_value
          and registration.state = 'active'
          and exists (
            select 1
            from vortex_definition.releases as release
            where release.root_id = root.root_id
              and release.release_revision = registration.source_revision
              and release.content_fingerprint = registration.source_content_fingerprint
              and release.resolution_fingerprint = registration.source_resolution_fingerprint
              and release.compilation_output ->> 'kind' = 'application'
          )
          and exists (
            select 1
            from vortex_module.installation_bindings as binding
            where binding.organization_id = context_organization_id
              and binding.application_root_id = default_application_root_id_value
              and binding.application_release_revision = registration.source_revision
              and binding.state = 'active'
          )
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
  end if;

  select updated.* into strict saved
  from vortex_identity.save_organization_runtime_settings_record_internal(
    context_organization_id, p_expected_revision, p_core_values, p_extension_values
  ) as updated;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', saved.organization_id,
    'concurrencyNumber', saved.revision,
    'correlationId', context_correlation_id
  );
exception
  when serialization_failure or deadlock_detected then
    return pg_catalog.jsonb_build_object('outcome', 'conflict');
  when no_data_found or too_many_rows or insufficient_privilege or check_violation
    or object_not_in_prerequisite_state or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

revoke all on function vortex_access.save_organization_settings_record_for_administration(
  uuid, bigint, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.save_organization_settings_record_for_administration(
  uuid, bigint, jsonb, jsonb
) to vortex_record_adapter;

comment on function vortex_access.save_organization_settings_record_for_administration(
  uuid, bigint, jsonb, jsonb
) is
  'Protected organisation settings record writer requiring runtime-settings.manage and an exact current revision; the request organisation supplies the singleton identity and extensions are merged with the invariant settings in one transaction.';

set local role vortex_record_adapter;

create or replace function vortex_record.read_record(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  columns_value jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
  read_time_fields jsonb;
  read_time_clock jsonb;
  read_time_expression jsonb;
  read_time_value jsonb;
  due_key text;
  status_key text;
  due_value jsonb;
  status_value jsonb;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  loaded := vortex_record.load_record_access_facts_internal(p_record_type_id, 'read', p_record_id, null);
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  bounds := bounds || pg_catalog.jsonb_build_object('readableFieldIds',
    vortex_record.project_derived_readable_field_ids_internal(
      loaded, p_record_type_id, p_record_id, bounds -> 'readableFieldIds',
      bounds -> 'readableFieldIds', '[]'::jsonb
    )
  );
  columns_value := loaded -> 'columns';
  -- Read-time calculations are worked out here, at one statement timestamp in
  -- the organisation's time zone, from the record's stored values. They are
  -- never read from storage.
  select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value), '{}'::jsonb)
  into read_time_fields
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as record_type(value)
  cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
  where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and field.value ->> 'type' = 'calculation'
    and (field.value #>> '{settings,evaluation}' = 'read_time'
      or field.value #>> '{settings,expression,kind}' = 'deadline_passed');
  if read_time_fields <> '{}'::jsonb then
    read_time_clock := vortex_record.read_time_clock_internal();
  end if;
  for field_id in
    select item.value #>> '{}' from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if not (columns_value ? field_id) then
      continue;
    end if;
    if read_time_fields ? pg_catalog.lower(field_id) then
      read_time_expression := read_time_fields -> pg_catalog.lower(field_id) #> '{settings,expression}';
      -- Only the deadline-passed form is defined; another read-time form is
      -- withheld rather than disclosed from a stored column.
      if read_time_expression ->> 'kind' is distinct from 'deadline_passed' then
        continue;
      end if;
      due_key := pg_catalog.lower(read_time_expression ->> 'dueFieldId');
      status_key := pg_catalog.lower(read_time_expression ->> 'statusFieldId');
      due_value := loaded -> 'fieldValues' -> due_key;
      status_value := case when status_key is null then null else loaded -> 'fieldValues' -> status_key end;
      if status_value is not null and status_value <> 'null'::jsonb and exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(read_time_expression -> 'terminalStatusValues', '[]'::jsonb))
          as terminal(value)
        where terminal.value = status_value
      ) then
        read_time_value := 'false'::jsonb;
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and loaded -> 'columns' -> due_key ->> 'databaseValueType' = 'date' then
        -- Without the organisation's time zone the local date is unknown.
        if read_time_clock ->> 'organizationLocalDate' is null then
          continue;
        end if;
        read_time_value := pg_catalog.to_jsonb((read_time_clock ->> 'organizationLocalDate') > (due_value #>> '{}'));
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and loaded -> 'columns' -> due_key ->> 'databaseValueType' = 'timestamp_with_time_zone' then
        read_time_value := pg_catalog.to_jsonb(
          (read_time_clock ->> 'instant')::timestamp with time zone
            >= (due_value #>> '{}')::timestamp with time zone
        );
      else
        read_time_value := 'null'::jsonb;
      end if;
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, read_time_value);
    else
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, loaded -> 'fieldValues' -> field_id);
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', p_record_id,
    'concurrencyNumber', loaded -> 'concurrencyNumber', 'values', values_value);
end
$function$;


revoke all on function vortex_record.read_record(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record(uuid, uuid) to vortex_request;

comment on function vortex_record.read_record(uuid, uuid) is
  'Fixed record read adapter: returns the readable field projection of one record under the caller''s own current authority, or an identical refusal for a missing, foreign or unreachable record.';

create or replace function vortex_record.read_record_capabilities(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  read_loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  readable_field_ids jsonb;
  meta jsonb;
  changeable_field_ids jsonb := '[]'::jsonb;
  actions text[] := array[]::text[];
  action_kind text;
  action_loaded jsonb;
  action_decision jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid then
    return null;
  end if;

  -- The row must be readable under the exact decision read_record applies, over
  -- the same fact loader; an unreadable row has no capabilities to report.
  read_loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'read', p_record_id, null
  );
  if read_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(read_loaded -> 'declaration') <> 'object' then
    return null;
  end if;
  read_decision := vortex_access.evaluate_organization_record_access_internal(
    read_loaded -> 'declaration', p_record_id, read_loaded -> 'facts'
  );
  if read_decision ->> 'outcome' <> 'allowed' then
    return null;
  end if;
  read_bounds := vortex_access.resolve_record_field_bounds_internal(read_decision);
  readable_field_ids := vortex_record.project_derived_readable_field_ids_internal(
    read_loaded, p_record_type_id, p_record_id,
    read_bounds -> 'readableFieldIds', read_bounds -> 'readableFieldIds', '[]'::jsonb
  );

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  if meta #>> '{recordType,key}' = 'organization_settings'
    and meta #>> '{recordType,systemProjection,protectedView}' =
      'organization_runtime_settings'
    and coalesce((meta #> '{recordType,standardActions}') ? 'update', false)
    and exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = (meta ->> 'moduleRootId')::uuid
        and root.kind = 'module'
        and root.key = 'vortex.organisation_administration'
    ) then
    if vortex_access.organization_runtime_settings_manage_is_current() then
      select coalesce(
        pg_catalog.jsonb_agg(projected.value order by projected.value), '[]'::jsonb
      )
      into changeable_field_ids
      from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
      join pg_catalog.jsonb_array_elements(meta #> '{recordType,fields}') as field(value)
        on pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(projected.value)
      where field.value ->> 'key' not in ('organization_id', 'revision')
        and field.value ->> 'type' not in (
          'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
          'attachment', 'calculation'
        );
      if pg_catalog.jsonb_array_length(changeable_field_ids) > 0 then
        actions := array['update'];
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'changeableFieldIds', changeable_field_ids,
      'actions', pg_catalog.to_jsonb(actions)
    );
  end if;

  -- Each record action kind is decided exactly as its own writer decides it: the
  -- same fact loader for that action kind and the same complete exact-record
  -- evaluation. An action is reported only when its own decision allows this
  -- exact record; a missing declaration contributes no action.
  foreach action_kind in array array['update', 'delete', 'restore'] loop
    action_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, action_kind, p_record_id, null
    );
    if action_loaded ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(action_loaded -> 'declaration') = 'object' then
      action_decision := vortex_access.evaluate_organization_record_access_internal(
        action_loaded -> 'declaration', p_record_id, action_loaded -> 'facts'
      );
      if action_decision ->> 'outcome' = 'allowed' then
        actions := pg_catalog.array_append(actions, action_kind);
        -- The changeable fields are the update decision's own field bounds, the
        -- set the record save enforces, narrowed to the fields read_record
        -- projects for this row, so no hidden field is ever reported.
        if action_kind = 'update' then
          changeable_field_ids := coalesce((
            select pg_catalog.jsonb_agg(projected.value order by projected.value)
            from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
            where exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                vortex_access.resolve_record_field_bounds_internal(action_decision)
                  -> 'changeableFieldIds'
              ) as changeable(value)
              where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
            )
          ), '[]'::jsonb);
        end if;
      end if;
    end if;
  end loop;

  -- Changing a row needs at least one field it may change, so update is never
  -- reported without one.
  if pg_catalog.jsonb_array_length(changeable_field_ids) = 0 then
    actions := pg_catalog.array_remove(actions, 'update');
  end if;

  return pg_catalog.jsonb_build_object(
    'changeableFieldIds', changeable_field_ids,
    'actions', pg_catalog.to_jsonb(actions)
  );
end
$function$;

revoke all on function vortex_record.read_record_capabilities(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record_capabilities(uuid, uuid) to vortex_request;

comment on function vortex_record.read_record_capabilities(uuid, uuid) is
  'Fixed record capabilities adapter: for one record readable under the caller''s own current authority, the record action kinds update, delete and restore whose own exact-record decisions allow it, and the fields the update decision lets the caller change, narrowed to the fields read_record projects; returns null for a missing, foreign or unreadable record, identically.';

create or replace function vortex_record.prepare_base_record_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  installation jsonb;
  module_content jsonb;
  application_content jsonb;
  unsupported boolean := false;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  fingerprint_value text;
  receipt_claim jsonb;
  projection jsonb;
  decision jsonb;
  bounds jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  fingerprint_value := vortex_record.base_save_command_fingerprint_internal(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_selected_group_id
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, p_operation, fingerprint_value,
    p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_id_value
      );
    end if;
    projection := vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    );
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', 'pending',
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  installation := vortex_module.read_current_active_installation();

  select release.compilation_output #> '{canonical,content}'
  into strict module_content
  from vortex_definition.releases as release
  where release.root_id = (meta ->> 'moduleRootId')::uuid
    and release.release_revision = (meta ->> 'moduleReleaseRevision')::bigint;

  select release.compilation_output #> '{canonical,content}'
  into strict application_content
  from vortex_definition.releases as release
  where release.root_id = (meta -> 'context' ->> 'applicationRootId')::uuid
    and release.release_revision =
      (installation ->> 'applicationReleaseRevision')::bigint;

  unsupported := exists (
    select 1
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as field(value)
    where field.value ->> 'type' = 'total'
  ) or exists (
    -- #578: Record evaluates the owning Module release's rules (`beforeSaveRules`);
    -- an Application rule on this record type cannot be evaluated and refuses.
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  );

  if unsupported then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported',
      'correlationId', meta -> 'context' -> 'correlationId'
    );
  end if;

  if meta -> 'recordType' ? 'systemProjection' then
    if p_operation <> 'update'
      or meta #>> '{recordType,key}' <> 'organization_settings'
      or meta #>> '{recordType,systemProjection,protectedView}' <>
        'organization_runtime_settings'
      or not coalesce(
        (meta #> '{recordType,standardActions}') ? 'update', false
      )
      or not exists (
        select 1
        from vortex_definition.roots as root
        where root.root_id = (meta ->> 'moduleRootId')::uuid
          and root.kind = 'module'
          and root.key = 'vortex.organisation_administration'
      )
      or p_record_id is distinct from
        (meta -> 'context' ->> 'organizationId')::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;

    -- Do not execute application before-save rules for this projection until
    -- the platform settings-manage permission has passed its own current check.
    if not vortex_access.organization_runtime_settings_manage_is_current() then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;

    -- The one writable system projection is prepared through its protected
    -- read model. The final write still goes only through the closed settings
    -- writer registered by Record; ordinary projected records remain refused.
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'read', p_record_id, null
    );
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    bounds := bounds || pg_catalog.jsonb_build_object(
      'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
        loaded -> 'facts' -> 'recordTypes', p_record_type_id,
        bounds -> 'readableFieldIds'
      )
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'recordType', meta -> 'recordType',
      'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
        (meta ->> 'moduleRootId')::uuid,
        (meta ->> 'moduleReleaseRevision')::bigint,
        p_record_type_id
      ),
      'correlationId', correlation_id_value,
      'readableFieldIds', bounds -> 'readableFieldIds',
      'existingValues', loaded -> 'fieldValues'
    );
  end if;

  if p_operation = 'update' then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    bounds := bounds || pg_catalog.jsonb_build_object(
      'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
        loaded -> 'facts' -> 'recordTypes', p_record_type_id,
        bounds -> 'readableFieldIds'
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- #578: the owning Module release's rules for this record type, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'correlationId', meta -> 'context' -> 'correlationId',
    'readableFieldIds', case when p_operation = 'update'
      then bounds -> 'readableFieldIds' else '[]'::jsonb end,
    'existingValues', case when p_operation = 'update'
      then loaded -> 'fieldValues' else '{}'::jsonb end
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

revoke all on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Server-only operation-scoped preparation read for one exact active installed base Record save.';

create or replace function vortex_record.save_organization_settings_record(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
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
  meta jsonb;
  loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  record_type_value jsonb;
  field_item jsonb;
  field_id text;
  field_key text;
  field_type text;
  database_type text;
  field_value jsonb;
  candidate_values jsonb;
  core_values jsonb := '{}'::jsonb;
  extension_values jsonb := '{}'::jsonb;
  changed_field_ids uuid[] := array[]::uuid[];
  access_result jsonb;
  projection jsonb;
  event_result jsonb;
  correlation_id_value uuid;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
    if p_command_id is not null then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  record_type_value := meta -> 'recordType';
  if record_type_value ->> 'key' is distinct from 'organization_settings'
    or record_type_value #>> '{systemProjection,protectedView}' is distinct from
      'organization_runtime_settings'
    or not coalesce((record_type_value -> 'standardActions') ? 'update', false)
    or not exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = (meta ->> 'moduleRootId')::uuid
        and root.kind = 'module'
        and root.key = 'vortex.organisation_administration'
    ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;

  correlation_id_value := (meta -> 'context' ->> 'correlationId')::uuid;
  if p_record_id is distinct from (meta -> 'context' ->> 'organizationId')::uuid then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'read', p_record_id, null
  );
  if loaded ->> 'outcome' <> 'loaded' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'concurrencyNumber', loaded -> 'concurrencyNumber',
      'correlationId', correlation_id_value
    );
  end if;

  read_decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if read_decision ->> 'outcome' is distinct from 'allowed' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_bounds := vortex_access.resolve_record_field_bounds_internal(read_decision);
  if exists (
    select 1
    from (
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
      union
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    ) as supplied
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        read_bounds -> 'readableFieldIds'
      ) as readable(field_id)
      where pg_catalog.lower(readable.field_id) = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'field_refused',
      'correlationId', correlation_id_value
    );
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) or exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  candidate_values := (loaded -> 'fieldValues') || p_final_values;
  for field_item in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    field_id := pg_catalog.lower(field_item ->> 'fieldId');
    field_key := field_item ->> 'key';
    field_type := field_item ->> 'type';
    database_type := vortex_record.database_value_type(field_item);

    if (field_item ->> 'required')::boolean
      and (not (candidate_values ? field_id)
        or pg_catalog.jsonb_typeof(candidate_values -> field_id) = 'null') then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'required_field_missing',
        'correlationId', correlation_id_value
      );
    end if;
    if not (p_final_values ? field_id) then
      continue;
    end if;

    field_value := p_final_values -> field_id;
    if field_key in ('organization_id', 'revision')
      or field_type in (
        'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
        'attachment', 'calculation'
      )
      or not vortex_record.canonical_record_value_matches(
        field_value, field_type, database_type
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_type = 'choice'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
        where option.value ->> 'value' = field_value #>> '{}'
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type = 'several_choices'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(field_value) as selected(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
          where option.value ->> 'value' = selected.value
        )
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type in ('text', 'long_text', 'choice', 'email_address', 'phone_number', 'web_address')
      and field_item #> '{settings,maxLength}' is not null
      and pg_catalog.jsonb_typeof(field_value) = 'string'
      and pg_catalog.char_length(field_value #>> '{}') >
        (field_item #>> '{settings,maxLength}')::integer then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_key in (
      'language', 'time_zone', 'currency', 'date_format', 'number_format',
      'default_application_root_id'
    ) then
      core_values := core_values || pg_catalog.jsonb_build_object(field_key, field_value);
    else
      extension_values := extension_values || pg_catalog.jsonb_build_object(field_key, field_value);
    end if;
  end loop;

  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(p_final_values) as key;

  access_result := vortex_access.save_organization_settings_record_for_administration(
    p_record_id, p_expected_concurrency_number, core_values, extension_values
  );
  if access_result ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return access_result || pg_catalog.jsonb_build_object('correlationId', correlation_id_value);
  end if;
  if access_result ->> 'outcome' <> 'saved' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;

  perform vortex_record.append_base_save_activity_internal(
    p_activity_id, 'update', p_record_id, changed_field_ids, 'completed'
  );
  event_result := vortex_event.append_record_occurrences(
    (meta ->> 'storageContractId')::uuid,
    p_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', p_record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Organization settings Event append failed';
  end if;

  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, p_record_id,
    (access_result ->> 'concurrencyNumber')::bigint,
    'Organization settings record save receipt is stale'
  );
  projection := vortex_record.read_record(p_record_type_id, p_record_id);
  if projection ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '55000',
      message = 'Saved organisation settings projection is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', 'pending',
    'replayed', false
  );
exception
  when serialization_failure or deadlock_detected then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', correlation_id_value
    );
  when no_data_found or too_many_rows or insufficient_privilege or check_violation
    or object_not_in_prerequisite_state or invalid_text_representation then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
end
$function$;

revoke all on function vortex_record.save_organization_settings_record(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.save_organization_settings_record(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) to vortex_runtime;

comment on function vortex_record.save_organization_settings_record(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) is
  'Closed Record save writer for the organisation_settings system projection: rechecks its installed definition, delegates protected settings authorization and persistence to Access, and records one receipt, Activity and Event.';

reset role;

commit;
