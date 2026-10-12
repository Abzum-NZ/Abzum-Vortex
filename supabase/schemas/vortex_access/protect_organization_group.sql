CREATE FUNCTION vortex_access.protect_organization_group() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 or new.state <> 'active' then
      raise exception using errcode = '23514',
        message = 'An organization Group must begin active at revision one';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization Groups cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization Group revision is exhausted';
  end if;

  if old.state = 'retired'
    or new.organization_id is distinct from old.organization_id
    or new.group_id is distinct from old.group_id
    or new.group_key is distinct from old.group_key
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id)
    or (old.state = 'active' and new.state not in ('active', 'retired')) then
    raise exception using errcode = '23514',
      message = 'Organization Group transition is invalid';
  end if;

  return new;
end
$$;


ALTER FUNCTION vortex_access.protect_organization_group() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_group() FROM PUBLIC;
