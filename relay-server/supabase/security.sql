-- Apply as the database owner before deploying relay protocol v2.
create table if not exists public.relay_security (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz not null
);
create index if not exists relay_security_expiry on public.relay_security(expires_at);
alter table public.relay_security enable row level security;
revoke all on public.relay_security from public, anon, authenticated;
grant all on public.relay_security to service_role;

create or replace function public.relay_security_operation(
  operation text, record_key text, record_value jsonb default null, ttl_seconds integer default 86400
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare result jsonb;
begin
  if ttl_seconds < 1 or ttl_seconds > 86400 then raise exception 'Invalid security TTL'; end if;
  if operation = 'get' then
    select value into result from relay_security where key = record_key and expires_at > clock_timestamp();
  elsif operation = 'put' then
    insert into relay_security(key, value, expires_at)
      values(record_key, record_value, clock_timestamp() + make_interval(secs => ttl_seconds))
      on conflict(key) do update set value = excluded.value, expires_at = excluded.expires_at
        where relay_security.expires_at <= clock_timestamp()
      returning 'true'::jsonb into result;
    return coalesce(result, 'false'::jsonb);
  elsif operation = 'take' then
    -- DELETE RETURNING is atomic; concurrent consumers cannot both redeem an invitation.
    delete from relay_security where key = record_key and expires_at > clock_timestamp() returning value into result;
  elsif operation = 'delete' then
    delete from relay_security where key = record_key;
  elsif operation = 'increment' then
    insert into relay_security(key, value, expires_at)
      values(record_key, '1'::jsonb, clock_timestamp() + make_interval(secs => ttl_seconds))
      on conflict(key) do update set
        value = case when relay_security.expires_at <= clock_timestamp() then '1'::jsonb
          else to_jsonb((relay_security.value #>> '{}')::bigint + 1) end,
        expires_at = case when relay_security.expires_at <= clock_timestamp() then excluded.expires_at
          else relay_security.expires_at end
      returning value into result;
  else raise exception 'Invalid security operation';
  end if;
  return result;
end;
$$;
revoke all on function public.relay_security_operation(text,text,jsonb,integer) from public, anon, authenticated;
grant execute on function public.relay_security_operation(text,text,jsonb,integer) to service_role;
-- Schedule this housekeeping statement daily with your database scheduler:
-- delete from public.relay_security where expires_at <= now();
