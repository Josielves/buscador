# Buscador de dados públicos

Frontend estático (`index.html`, Vercel) + Supabase (Postgres + Edge Functions).

```
index.html                              frontend
supabase/migrations/                    tabela docs + busca full-text
supabase/functions/buscar/              API de busca (chamada pelo frontend)
supabase/functions/ingest-pncp/         ingestão do PNCP (licitações e contratos)
```

## Fontes

| Fonte | Como funciona |
|---|---|
| `pncp` | Busca na base local (`docs`), populada por `ingest-pncp?tipo=contratacoes` |
| `pncp_contratos` | Busca na base local, populada por `ingest-pncp?tipo=contratos` |
| `inpi` | Base local, **ainda sem ingestão** (retorna aviso) |
| `ibge` | Consulta ao vivo à API de localidades (ignora acentos) |
| `dados_gov` | Consulta ao vivo; exige o secret `DADOS_GOV_TOKEN` |
| `onr`, `iptu` | Só orientação (não há API aberta) |

A API do PNCP não tem busca por texto; por isso o projeto ingere os dados e busca no Postgres.

## Deploy

```bash
supabase login
supabase link --project-ref rwfygldtcjvwkcfddqit

supabase db push                         # aplica as 2 migrations
supabase secrets set INGEST_KEY=$(openssl rand -hex 24)   # anote esse valor
# opcional: supabase secrets set DADOS_GOV_TOKEN=...

supabase functions deploy buscar
supabase functions deploy ingest-pncp --no-verify-jwt     # protegida por x-ingest-key
```

## Popular a base (primeira vez)

```bash
KEY=<INGEST_KEY>
URL=https://rwfygldtcjvwkcfddqit.supabase.co/functions/v1/ingest-pncp

curl -H "x-ingest-key: $KEY" "$URL?tipo=contratacoes&dias=7&modalidades=6,8&paginas=10"
curl -H "x-ingest-key: $KEY" "$URL?tipo=contratos&dias=7&paginas=10"
```

Resposta esperada: `{"tipo":...,"upserted":{"modalidade_6":N,...}}`. Códigos de modalidade
(ex.: 6 = pregão eletrônico, 8 = dispensa) estão no manual da API de consulta do PNCP.

## Atualização diária (opcional)

No SQL Editor do Supabase:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret('<INGEST_KEY>', 'ingest_key');

select cron.schedule('ingest-pncp-licitacoes', '0 7 * * *', $$
  select net.http_post(
    url := 'https://rwfygldtcjvwkcfddqit.supabase.co/functions/v1/ingest-pncp?tipo=contratacoes&dias=2&modalidades=6,8&paginas=10',
    headers := jsonb_build_object('x-ingest-key', (select decrypted_secret from vault.decrypted_secrets where name = 'ingest_key')),
    timeout_milliseconds := 120000
  );
$$);
```

## Testar

```bash
curl "https://rwfygldtcjvwkcfddqit.supabase.co/functions/v1/buscar?q=energia+solar&fontes=pncp,ibge" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
```
