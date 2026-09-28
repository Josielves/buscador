import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const semAcento = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// Busca full-text na tabela docs. `extra` (jsonb) é achatado no item (valor, fornecedor, uf...).
const local = (fonte: string, avisoBaseVazia?: string) => async (q: string, n: number) => {
  const { data, error } = await sb.rpc("buscar_docs", { q, f: fonte, lim: n });
  if (error) throw new Error(error.message);
  const rows = (data ?? []).map(({ extra, ...r }: any) => ({ ...r, ...(extra ?? {}) }));
  if (!rows.length && avisoBaseVazia) {
    const { count } = await sb.from("docs").select("id", { count: "exact", head: true }).eq("fonte", fonte);
    if (!count) return [{ aviso: avisoBaseVazia }];
  }
  return rows;
};

let municipios: any[] | null = null;
const ibge = async (q: string, n: number) => {
  if (!municipios) {
    const r = await fetch("https://servicodados.ibge.gov.br/api/v1/localidades/municipios");
    if (!r.ok) throw new Error(`IBGE respondeu ${r.status}`);
    municipios = await r.json();
  }
  const t = semAcento(q);
  return municipios!.filter((m) => semAcento(m.nome).includes(t)).slice(0, n).map((m) => ({
    titulo: `${m.nome}/${m.microrregiao?.mesorregiao?.UF?.sigla ?? "?"}`,
    aviso: `Código IBGE ${m.id}`,
    url: `https://servicodados.ibge.gov.br/api/v3/malhas/municipios/${m.id}?formato=application/vnd.geo+json`,
  }));
};

const dadosGov = async (q: string, n: number) => {
  const token = Deno.env.get("DADOS_GOV_TOKEN");
  if (!token) return [{ aviso: "Defina o secret DADOS_GOV_TOKEN (gratuito em dados.gov.br)" }];
  const r = await fetch(
    `https://dados.gov.br/api/publico/conjuntos-dados?nomeConjuntoDados=${encodeURIComponent(q)}&pagina=1`,
    { headers: { "chave-api-dados-abertos": token } },
  );
  if (!r.ok) throw new Error(`dados.gov.br respondeu ${r.status}`);
  const j = await r.json();
  return (Array.isArray(j) ? j : j.registros ?? []).slice(0, n).map((d: any) => ({
    titulo: d.titulo, orgao: d.nomeOrganizacao, url: `https://dados.gov.br/dados/conjuntos-dados/${d.id}`,
  }));
};

const manual = (como: string) => async (q: string) => [{ aviso: "Sem API aberta gratuita", como_obter: como, consulta: q }];

const FONTES: Record<string, (q: string, n: number) => Promise<unknown>> = {
  pncp: local("pncp", "Base local vazia: rode a função ingest-pncp (tipo=contratacoes) para popular."),
  pncp_contratos: local("pncp_contratos", "Base local vazia: rode a função ingest-pncp (tipo=contratos) para popular."),
  inpi: local("inpi", "A base do INPI ainda não foi ingerida (não existe função de ingestão do INPI neste projeto)."),
  ibge,
  dados_gov: dadosGov,
  onr: manual("Certidão de matrícula/proprietário paga via ONR/SAEC (registradores.onr.org.br)."),
  iptu: manual("Cadastro imobiliário é municipal: use o portal ou dados abertos da prefeitura."),
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return Response.json({ erro: "q muito curto" }, { status: 400, headers: cors });
  const n = Math.min(Math.max(Number(u.searchParams.get("limite")) || 10, 1), 50);
  const pedidas = (u.searchParams.get("fontes") || Object.keys(FONTES).join(",")).split(",").filter(Boolean);

  const out: Record<string, unknown> = {};
  await Promise.all(pedidas.map(async (f) => {
    if (!FONTES[f]) { out[f] = { erro: "fonte desconhecida" }; return; }
    try { out[f] = await FONTES[f](q, n); } catch (e) { out[f] = { erro: String(e) }; }
  }));
  return Response.json(out, { headers: cors });
});
