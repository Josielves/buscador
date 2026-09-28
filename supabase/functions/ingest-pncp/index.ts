import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const isoDay = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");
const TAM = 50;

// A API do PNCP pode devolver corpo vazio (204) quando não há dados.
async function pncp(path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const r = await fetch(`https://pncp.gov.br/api/consulta/v1/${path}?${qs}`, { signal: AbortSignal.timeout(25_000) });
  if (r.status === 204) return { data: [], totalPaginas: 0 };
  if (!r.ok) throw new Error(`PNCP ${path} respondeu ${r.status}`);
  const txt = await r.text();
  return txt ? JSON.parse(txt) : { data: [], totalPaginas: 0 };
}

const limpa = (s: unknown, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const mapContratacao = (i: any) => {
  const cnpj = i.orgaoEntidade?.cnpj ?? "";
  const uf = i.unidadeOrgao?.ufSigla ?? "", mun = i.unidadeOrgao?.municipioNome ?? "";
  return {
    fonte: "pncp",
    titulo: limpa(i.objetoCompra),
    texto: limpa(`${i.objetoCompra ?? ""} ${mun} ${uf} ${i.modalidadeNome ?? ""} ${i.numeroControlePNCP ?? ""}`, 5000),
    orgao: i.orgaoEntidade?.razaoSocial ?? "",
    data: i.dataPublicacaoPncp ?? "",
    url: `https://pncp.gov.br/app/editais/${cnpj}/${i.anoCompra}/${i.sequencialCompra}`,
    extra: { valor: i.valorTotalEstimado ?? null, uf, municipio: mun, modalidade: i.modalidadeNome ?? null },
  };
};

const mapContrato = (i: any) => {
  const cnpj = i.orgaoEntidade?.cnpj ?? "";
  return {
    fonte: "pncp_contratos",
    titulo: limpa(i.objetoContrato),
    texto: limpa(`${i.objetoContrato ?? ""} ${i.nomeRazaoSocialFornecedor ?? ""} ${i.numeroControlePNCP ?? ""}`, 5000),
    orgao: i.orgaoEntidade?.razaoSocial ?? "",
    data: i.dataPublicacaoPncp ?? "",
    url: `https://pncp.gov.br/app/contratos/${cnpj}/${i.anoContrato}/${i.sequencialContrato}`,
    extra: { fornecedor: i.nomeRazaoSocialFornecedor ?? null, valor: i.valorGlobal ?? null },
  };
};

// Grava um lote; deduplica por (fonte,url) porque o upsert falha se o mesmo par aparece 2x no lote.
async function salvar(rows: any[]) {
  const unicos = [...new Map(rows.map((r) => [`${r.fonte}|${r.url}`, r])).values()];
  const { error } = await sb.from("docs").upsert(unicos, { onConflict: "fonte,url" });
  if (error) throw new Error(error.message);
  return unicos.length;
}

async function varrer(path: string, base: Record<string, string | number>, paginas: number, mapa: (i: any) => any) {
  let total = 0;
  for (let p = 1; p <= paginas; p++) {
    const j = await pncp(path, { ...base, pagina: p, tamanhoPagina: TAM });
    const itens = j.data ?? [];
    if (!itens.length) break;
    total += await salvar(itens.map(mapa));
    if (j.totalPaginas && p >= j.totalPaginas) break;
  }
  return total;
}

// Header x-ingest-key (secret INGEST_KEY).
// Ex.: ?tipo=contratacoes&dias=2&modalidades=6,8&paginas=10   |   ?tipo=contratos&dias=7&paginas=10
Deno.serve(async (req) => {
  const chave = Deno.env.get("INGEST_KEY");
  if (!chave || req.headers.get("x-ingest-key") !== chave) return new Response("unauthorized", { status: 401 });

  const u = new URL(req.url);
  const tipo = u.searchParams.get("tipo") ?? "contratacoes";
  const dias = Math.min(Number(u.searchParams.get("dias")) || 2, 30);
  const paginas = Math.min(Number(u.searchParams.get("paginas")) || 10, 40);
  const modalidades = (u.searchParams.get("modalidades") ?? u.searchParams.get("modalidade") ?? "6,8")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const janela = { dataInicial: isoDay(new Date(Date.now() - dias * 864e5)), dataFinal: isoDay(new Date()) };

  const resultado: Record<string, unknown> = {};
  try {
    if (tipo === "contratos") {
      resultado.contratos = await varrer("contratos", janela, paginas, mapContrato);
    } else if (tipo === "contratacoes") {
      // A API exige uma modalidade por consulta; falha em uma não derruba as outras.
      for (const m of modalidades) {
        try {
          resultado[`modalidade_${m}`] = await varrer(
            "contratacoes/publicacao", { ...janela, codigoModalidadeContratacao: m }, paginas, mapContratacao);
        } catch (e) { resultado[`modalidade_${m}`] = { erro: String(e) }; }
      }
    } else {
      return Response.json({ erro: "tipo deve ser contratacoes ou contratos" }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ erro: String(e), parcial: resultado }, { status: 500 });
  }
  return Response.json({ tipo, janela, upserted: resultado });
});
