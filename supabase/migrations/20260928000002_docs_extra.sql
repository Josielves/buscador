-- Campos extras por documento (valor, fornecedor, UF, município, modalidade...)
alter table public.docs add column if not exists extra jsonb;

-- O tipo de retorno mudou, então é preciso recriar a função.
drop function if exists public.buscar_docs(text, text, int);

create function public.buscar_docs(q text, f text, lim int default 10)
returns table (fonte text, titulo text, orgao text, data text, url text, extra jsonb)
language sql stable as $$
  select d.fonte, d.titulo, d.orgao, d.data, d.url, d.extra
  from public.docs d
  where d.fonte = f and d.tsv @@ websearch_to_tsquery('portuguese', q)
  order by ts_rank(d.tsv, websearch_to_tsquery('portuguese', q)) desc, d.data desc nulls last
  limit lim;
$$;

-- Só as Edge Functions (service_role) chamam a busca; o navegador nunca fala direto com o banco.
revoke execute on function public.buscar_docs(text, text, int) from public, anon, authenticated;
grant execute on function public.buscar_docs(text, text, int) to service_role;
