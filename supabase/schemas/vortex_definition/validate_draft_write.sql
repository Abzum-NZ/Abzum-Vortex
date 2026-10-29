CREATE OR REPLACE FUNCTION vortex_definition.validate_draft_write() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  root_kind text;
  root_key text;
  root_created_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    if new.root_id is distinct from old.root_id then
      raise exception using
        errcode = '23514',
        message = 'A definition draft cannot move to another root';
    end if;

    if new.draft_revision is distinct from old.draft_revision + 1 then
      raise exception using
        errcode = '23514',
        message = 'A definition draft revision must increment exactly once';
    end if;

    if new.updated_at < old.updated_at then
      raise exception using
        errcode = '23514',
        message = 'Definition draft update time cannot move backwards';
    end if;
  end if;

  select root.kind, root.key, root.created_at
  into root_kind, root_key, root_created_at
  from vortex_definition.roots as root
  where root.root_id = new.root_id;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'A definition draft requires an existing root';
  end if;

  if pg_catalog.jsonb_typeof(new.draft_source) is distinct from 'object'
    or new.draft_source ->> 'kind' is distinct from root_kind
    or new.draft_source ->> 'key' is distinct from root_key
    or new.draft_source ->> 'source_contract_version'
      is distinct from new.source_contract_version then
    raise exception using
      errcode = '23514',
      message = 'Definition draft metadata must match its permanent root and source contract';
  end if;

  -- A draft holds only the one accepted contract: an older release is history and is never
  -- restored into a draft, and no writer can store a draft of another version.
  if root_kind in ('application', 'module')
    and new.source_contract_version <> all (vortex_definition.accepted_contract_version(root_kind)) then
    raise exception using
      errcode = '23514',
      message = 'A definition draft must use the accepted definition contract version';
  end if;

  if new.updated_at < root_created_at then
    raise exception using
      errcode = '23514',
      message = 'Definition draft update time cannot precede root creation';
  end if;

  return new;
end
$$;

alter function vortex_definition.validate_draft_write() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_definition.validate_draft_write() FROM PUBLIC;

grant execute on function vortex_definition.validate_draft_write() to postgres;
