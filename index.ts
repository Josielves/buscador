import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const isoDay = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");

const local = (fonte: string) => async (q: string, n: number) => {
  const { data, error } = await sb.rpc("buscar_docs", { q, f: fonte, lim: n });
  if (error) throw new Error(error.message);
  return data;
};

let municipios: any[] | null = null;
const ibge = async (q: string, n: number) => {
  municipios ??= await (await fetch("https://servicodados.ibge.gov.br/api/v1/localidades/municipios")).json();
  const t = q.toLowerCase();
  return municipios!.filter((m) => m.nome.toLowerCase().includes(t)).slice(0, n).map((m) => ({
    titulo: `${m.nome}/${m.microrregiao.mesorregiao.UF.sigla}`,
    id_ibge: m.id,
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
  const j = await r.json();
  return (Array.isArray(j) ? j : j.registros ?? []).slice(0, n).map((d: any) => ({
    titulo: d.titulo, orgao: d.nomeOrganizacao, url: `https://dados.gov.br/dados/conjuntos-dados/${d.id}`,
  }));
};

const contratos = async (q: string, n: number) => {
  const fim = new Date(), ini = new Date(Date.now() - 30 * 864e5);
  const r = await fetch(
    `https://pncp.gov.br/api/consulta/v1/contratos?dataInicial=${isoDay(ini)}&dataFinal=${isoDay(fim)}&pagina=1&tamanhoPagina=50`,
  );
  if (!r.ok) return [];
  const t = q.toLowerCase();
  return ((await r.json()).data ?? [])
    .filter((i: any) => `${i.objetoContrato} ${i.nomeRazaoSocialFornecedor}`.toLowerCase().includes(t))
    .slice(0, n)
    .map((i: any) => ({
      titulo: (i.objetoContrato ?? "").slice(0, 200), orgao: i.orgaoEntidade?.razaoSocial,
      fornecedor: i.nomeRazaoSocialFornecedor, valor: i.valorGlobal,
    }));
};

const manual = (como: string) => async (q: string) => [{ aviso: "Sem API aberta gratuita", como_obter: como, consulta: q }];

const FONTES: Record<string, (q: string, n: number) => Promise<unknown>> = {
  pncp: local("pncp"),
  pncp_contratos: contratos,
  inpi: local("inpi"),
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
  const n = Math.min(Number(u.searchParams.get("limite") ?? 10), 50);
  const pedidas = (u.searchParams.get("fontes") ?? Object.keys(FONTES).join(",")).split(",");

  const out: Record<string, unknown> = {};
  await Promise.all(pedidas.map(async (f) => {
    if (!FONTES[f]) { out[f] = { erro: "fonte desconhecida" }; return; }
    try { out[f] = await FONTES[f](q, n); } catch (e) { out[f] = { erro: String(e) }; }
  }));
  return Response.json(out, { headers: cors });
});
