create or replace function vortex_record.evolve_field_storage_internal(
  p_storage_contract_id uuid,
  p_field_id uuid,
  p_requested jsonb,
  p_storage_scope text,
  p_table_token text,
  p_column_token text,
  p_is_projection boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored vortex_record.field_storage_mappings%rowtype;
  scope_columns text := vortex_record.index_scope_columns(p_storage_scope);
  desired_purpose text;
  current_purpose text;
begin
  select mapping.* into strict stored
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_storage_contract_id and mapping.field_id = p_field_id
  for update;
  if not vortex_record.field_storage_compatible(stored.field_definition, p_requested, false) then
    raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
  end if;
  if stored.field_definition is not distinct from p_requested then
    return;
  end if;
  if not p_is_projection then
    -- A later release may stop requiring a value.
    if coalesce((stored.field_definition ->> 'required')::boolean, false)
      and not coalesce((p_requested ->> 'required')::boolean, false) then
      execute pg_catalog.format(
        'alter table record_data.%I alter column %I drop not null', p_table_token, p_column_token
      );
    end if;
    -- The field's one index follows its current flags: uniqueness, else performance when the
    -- field can be filtered or sorted, else none.
    desired_purpose := case
      when coalesce((p_requested ->> 'unique')::boolean, false) then 'uniqueness'
      when coalesce((p_requested ->> 'filterable')::boolean, false)
        or coalesce((p_requested ->> 'sortable')::boolean, false) then 'performance'
      else null end;
    select index_row.purpose into current_purpose
    from vortex_record.index_catalogue as index_row
    where index_row.storage_contract_id = p_storage_contract_id
      and index_row.field_id = p_field_id
      and index_row.purpose in ('uniqueness', 'performance');
    if current_purpose is distinct from desired_purpose then
      if current_purpose is not null then
        execute pg_catalog.format('drop index if exists record_data.%I',
          'ux_' || pg_catalog.substr(p_column_token, 3));
        execute pg_catalog.format('drop index if exists record_data.%I',
          'ix_' || pg_catalog.substr(p_column_token, 3));
        delete from vortex_record.index_catalogue as index_row
        where index_row.storage_contract_id = p_storage_contract_id
          and index_row.field_id = p_field_id
          and index_row.purpose in ('uniqueness', 'performance');
      end if;
    end if;
  end if;
  update vortex_record.field_storage_mappings as mapping
  set field_definition = p_requested
  where mapping.storage_contract_id = p_storage_contract_id and mapping.field_id = p_field_id;
  if not p_is_projection and desired_purpose is not null then
    perform vortex_record.ensure_field_index_internal(
      p_storage_contract_id, p_field_id, desired_purpose, p_storage_scope,
      p_table_token, scope_columns, p_column_token
    );
  end if;
end
$function$;

alter function vortex_record.evolve_field_storage_internal(uuid, uuid, jsonb, text, text, text, boolean)
  owner to vortex_owner;
revoke all on function vortex_record.evolve_field_storage_internal(uuid, uuid, jsonb, text, text, text, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.evolve_field_storage_internal(uuid, uuid, jsonb, text, text, text, boolean)
  to vortex_owner;
comment on function vortex_record.evolve_field_storage_internal(uuid, uuid, jsonb, text, text, text, boolean) is
  'Applies a later compatible release of one stored field: drops a requirement it no longer has, moves the field to the one index its unique, filterable and sortable flags need, and records the release''s field definition.';
