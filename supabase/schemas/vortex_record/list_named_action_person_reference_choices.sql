-- Current HUMAN named-action field-bound account choices; no permission or audience from a caller.
create or replace function vortex_record.list_named_action_person_reference_choices(
  p_owner_kind text, p_owner_id uuid, p_release_revision bigint, p_action_id uuid,
  p_record_type_id uuid, p_record_id uuid, p_expected_revision bigint,
  p_input_key text, p_field_id uuid, p_page_application_revision bigint, p_page_release_key text, p_search text, p_page_size integer,
  p_after_sort_key text, p_after_account_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb; loaded jsonb; again_loaded jsonb; meta jsonb;
  decision jsonb; bounds jsonb; field_value jsonb; input_value jsonb;
  source_value jsonb; matches bigint; raw_page jsonb; candidate jsonb;
  candidates jsonb := '[]'::jsonb; account_id uuid; deadline timestamptz;
  initial_installation jsonb; current_installation jsonb; installed_page_release_key text;
begin
  if p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_field_id is null or p_field_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740990
    or p_input_key is null or p_input_key !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
    or pg_catalog.char_length(p_input_key) > 40
    or p_page_application_revision is null or p_page_application_revision not between 1 and 9007199254740991
    or p_page_release_key is null or pg_catalog.char_length(p_page_release_key) > 300
    or p_page_size is null or p_page_size not between 1 and 100
    or (p_search is not null and (pg_catalog.char_length(p_search) not between 1 and 100
      or p_search is distinct from pg_catalog.btrim(p_search)))
    or (p_after_sort_key is null) <> (p_after_account_id is null)
    or pg_catalog.char_length(p_after_sort_key) > 1000
    or p_after_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Person choice input is invalid';
  end if;
  ctx := vortex_access.validated_human_request_context();
  if ctx ->> 'applicationRootId' is null
    or (ctx ->> 'expiresAt')::timestamptz <= pg_catalog.clock_timestamp()
    or vortex_record.read_current_preview_installation_internal() is not null then
    raise exception using errcode = '42501', message = 'Person choices are unavailable';
  end if;
  initial_installation := vortex_module.read_current_active_installation();
  select release.release_version || ':' || release.content_fingerprint || ':' || release.resolution_fingerprint
    into strict installed_page_release_key from vortex_definition.releases as release
    where release.root_id = (ctx ->> 'applicationRootId')::uuid
      and release.release_revision = (initial_installation ->> 'applicationReleaseRevision')::bigint;
  if (initial_installation ->> 'applicationReleaseRevision')::bigint is distinct from p_page_application_revision
    or installed_page_release_key is distinct from p_page_release_key then
    raise exception using errcode = '40001', message = 'Person choice Page release is stale';
  end if;
  -- The existing fact loader validates the exact installed action and locks the shown subject.
  loaded := vortex_record.load_named_action_facts_internal(
    p_owner_kind,p_owner_id,p_release_revision,p_action_id,p_record_type_id,p_record_id,p_expected_revision);
  if loaded ->> 'outcome' is distinct from 'loaded'
    or (loaded ->> 'concurrencyNumber')::bigint is distinct from p_expected_revision then
    raise exception using errcode = '40001', message = 'Person choice subject is stale';
  end if;
  meta := loaded -> 'actionContext';
  select value into strict field_value from pg_catalog.jsonb_array_elements(meta #> '{recordType,fields}')
    where (value ->> 'fieldId')::uuid = p_field_id;
  select value into strict input_value from pg_catalog.jsonb_array_elements(meta #> '{action,inputs}')
    where value ->> 'key' = p_input_key;
  select pg_catalog.count(*), pg_catalog.min(entry.value::text)::jsonb into matches, source_value
  from pg_catalog.jsonb_array_elements(meta #> '{action,tasks}') task(value)
  cross join lateral pg_catalog.jsonb_each(case when task.value ->> 'type' = 'record.set_fields'
    then task.value #> '{properties,values}' else '{}'::jsonb end) entry
  where pg_catalog.lower(entry.key) = pg_catalog.lower(p_field_id::text);
  if field_value ->> 'type' is distinct from 'link_to_person'
    or field_value #>> '{settings,audience}' is distinct from 'application_accounts'
    or field_value #> '{settings,applicationRootIdRequired}' is distinct from 'true'::jsonb
    or input_value ->> 'type' is distinct from 'organization_account_reference'
    or matches <> 1 or source_value is distinct from pg_catalog.jsonb_build_object(
      'kind','reference','reference',pg_catalog.jsonb_build_object('source','input','name',p_input_key))
    or coalesce((meta ->> 'rulesUnsupported')::boolean,false) then
    raise exception using errcode = '42501', message = 'Person choice source is unavailable';
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration',p_record_id,loaded -> 'facts');
  if decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode = '42501', message = 'Person choices are unavailable';
  end if;
  deadline := least((decision ->> 'validUntil')::timestamptz,(ctx ->> 'expiresAt')::timestamptz);
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  if not (coalesce(bounds -> 'readableFieldIds','[]'::jsonb) ? pg_catalog.lower(p_field_id::text))
    or not (coalesce(bounds -> 'changeableFieldIds','[]'::jsonb) ? pg_catalog.lower(p_field_id::text))
    or deadline is null or deadline <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501', message = 'Person choices are unavailable';
  end if;
  raw_page := vortex_identity.list_organization_account_choices_internal(
    (ctx ->> 'tenantId')::uuid,(ctx ->> 'organizationId')::uuid,
    p_search,p_page_size,p_after_sort_key,p_after_account_id);
  -- Acquire all candidate account/projection locks in one deterministic order, before filtering.
  for account_id in select (value ->> 'organizationAccountId')::uuid
    from pg_catalog.jsonb_array_elements(raw_page -> 'accounts')
    order by (value ->> 'organizationAccountId')::uuid
  loop
    if vortex_identity.lock_active_organization_account_reference_internal(
      (ctx ->> 'tenantId')::uuid,(ctx ->> 'organizationId')::uuid,account_id)
      and vortex_access.organization_account_has_current_application_access_internal(
        (ctx ->> 'organizationId')::uuid,account_id,(ctx ->> 'applicationRootId')::uuid) then
      candidates := candidates || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(account_id));
    end if;
  end loop;
  -- Every possible waiter precedes completion rechecks; no rows or counts leave before these.
  again_loaded := vortex_record.load_named_action_facts_internal(
    p_owner_kind,p_owner_id,p_release_revision,p_action_id,p_record_type_id,p_record_id,p_expected_revision);
  current_installation := vortex_module.read_current_active_installation();
  if again_loaded ->> 'outcome' is distinct from 'loaded'
    or again_loaded -> 'actionContext' is distinct from meta
    or current_installation is distinct from initial_installation
    or vortex_access.validated_human_request_context() is distinct from ctx
    or deadline <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501', message = 'Person choices became unavailable';
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    again_loaded -> 'declaration',p_record_id,again_loaded -> 'facts');
  if decision ->> 'outcome' is distinct from 'allowed'
    or (decision ->> 'validUntil')::timestamptz <= pg_catalog.clock_timestamp()
    or vortex_access.resolve_record_field_bounds_internal(decision) is distinct from bounds then
    raise exception using errcode = '42501', message = 'Person choices became unavailable';
  end if;
  deadline := least(deadline,(decision ->> 'validUntil')::timestamptz);
  for candidate in select value from pg_catalog.jsonb_array_elements(raw_page -> 'accounts') loop
    if candidates @> pg_catalog.jsonb_build_array(candidate -> 'organizationAccountId')
      and not vortex_access.organization_account_has_current_application_access_internal(
        (ctx ->> 'organizationId')::uuid,(candidate ->> 'organizationAccountId')::uuid,
        (ctx ->> 'applicationRootId')::uuid) then
      raise exception using errcode = '42501', message = 'Person choices became unavailable';
    end if;
  end loop;
  if deadline <= pg_catalog.clock_timestamp()
    or vortex_access.validated_human_request_context() is distinct from ctx then
    raise exception using errcode = '42501', message = 'Person choices became unavailable';
  end if;
  return pg_catalog.jsonb_build_object('accounts',coalesce((
    select pg_catalog.jsonb_agg(item.value order by item.ordinality)
    from pg_catalog.jsonb_array_elements(raw_page -> 'accounts') with ordinality item(value,ordinality)
    where candidates @> pg_catalog.jsonb_build_array(item.value -> 'organizationAccountId')
  ),'[]'::jsonb),'next',raw_page -> 'next',
    'validUntil',vortex_context.format_timestamp_utc(deadline));
end
$function$;
alter function vortex_record.list_named_action_person_reference_choices(
  text,uuid,bigint,uuid,uuid,uuid,bigint,text,uuid,bigint,text,text,integer,text,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.list_named_action_person_reference_choices(
  text,uuid,bigint,uuid,uuid,uuid,bigint,text,uuid,bigint,text,text,integer,text,uuid)
  from public,anon,authenticated,service_role,vortex_runtime,vortex_request,vortex_record_owner,vortex_module_owner;
grant execute on function vortex_record.list_named_action_person_reference_choices(
  text,uuid,bigint,uuid,uuid,uuid,bigint,text,uuid,bigint,text,text,integer,text,uuid) to vortex_runtime;
comment on function vortex_record.list_named_action_person_reference_choices(
  text,uuid,bigint,uuid,uuid,uuid,bigint,text,uuid,bigint,text,text,integer,text,uuid)
  is 'Protected current HUMAN exact installed named-action person-field picker. Requires the shown subject revision and genuine readable/changeable bounds; filters a bounded Identity page by current App audience and rechecks completion. Returns safe account labels, raw scanned-page cursor and private completion deadline; no counts or identity details.';