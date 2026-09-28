-- Tabela única de documentos indexados (PNCP, INPI, etc.)
create table if not exists public.docs (
  id bigint generated always as identity primary key,
  fonte text not null,
  titulo text,
  texto text,
  orgao text,
  data text,
  url text,
  tsv tsvector generated always as (
    to_tsvector('portuguese', coalesce(titulo,'') || ' ' || coalesce(texto,'') || ' ' || coalesce(orgao,''))
  ) stored,
  unique (fonte, url)
);

create index if not exists docs_tsv_idx on public.docs using gin (tsv);
create index if not exists docs_fonte_idx on public.docs (fonte);

-- Só a service role (Edge Functions) acessa. Sem policies = ninguém mais lê.
alter table public.docs enable row level security;

create or replace function public.buscar_docs(q text, f text, lim int default 10)
returns table (fonte text, titulo text, orgao text, data text, url text)
language sql stable as $$
  select d.fonte, d.titulo, d.orgao, d.data, d.url
  from public.docs d
  where d.fonte = f and d.tsv @@ websearch_to_tsquery('portuguese', q)
  order by ts_rank(d.tsv, websearch_to_tsquery('portuguese', q)) desc
  limit lim;
$$;
