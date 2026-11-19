-- ============================================================
-- AI Chat — таблица и функции синхронизации чатов
-- Supabase → SQL Editor → New query → вставить всё → Run
-- ============================================================
create table if not exists public.aichat_chats (
  code_hash text   not null,              -- sha256 от «кода синхронизации»
  id        text   not null,              -- id чата
  updated   bigint not null default 0,    -- время изменения (мс, с устройства)
  deleted   boolean not null default false,
  data      jsonb,                        -- весь чат целиком
  server_ts bigint not null default (extract(epoch from clock_timestamp())*1000)::bigint,
  primary key (code_hash, id)
);
create index if not exists aichat_chats_ts on public.aichat_chats (code_hash, server_ts);

-- Прямой доступ к таблице закрыт: RLS включён, политик нет.
-- Читать/писать можно только через функции ниже и только зная код синхронизации.
alter table public.aichat_chats enable row level security;
revoke all on table public.aichat_chats from anon, authenticated;

create or replace function public.aichat_push(p_code text, p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare h text;
begin
  if length(coalesce(p_code,'')) < 8 then raise exception 'Код синхронизации должен быть не короче 8 символов'; end if;
  h := encode(sha256(convert_to(p_code,'UTF8')),'hex');
  insert into aichat_chats as t (code_hash, id, updated, deleted, data, server_ts)
  select h, r->>'id', coalesce((r->>'updated')::bigint,0), coalesce((r->>'deleted')::boolean,false),
         case when coalesce((r->>'deleted')::boolean,false) then null else r->'data' end,
         (extract(epoch from clock_timestamp())*1000)::bigint
  from jsonb_array_elements(p_rows) r
  where r->>'id' is not null
  on conflict (code_hash, id) do update
    set updated = excluded.updated, deleted = excluded.deleted, data = excluded.data, server_ts = excluded.server_ts
    where t.updated <= excluded.updated or excluded.deleted;
end $$;

create or replace function public.aichat_pull(p_code text, p_since bigint)
returns table (id text, updated bigint, deleted boolean, data jsonb, server_ts bigint)
language sql security definer set search_path = public as $$
  select c.id, c.updated, c.deleted, c.data, c.server_ts
  from aichat_chats c
  where length(coalesce(p_code,'')) >= 8
    and c.code_hash = encode(sha256(convert_to(p_code,'UTF8')),'hex')
    and c.server_ts > coalesce(p_since,0)
  order by c.server_ts
  limit 500
$$;

grant execute on function public.aichat_push(text, jsonb) to anon, authenticated;
grant execute on function public.aichat_pull(text, bigint) to anon, authenticated;
