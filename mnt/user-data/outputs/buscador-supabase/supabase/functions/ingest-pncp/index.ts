import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const isoDay = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");

// Chame com header x-ingest-key (secret INGEST_KEY). Ex.: ?dias=7&modalidade=6&paginas=5
Deno.serve(async (req) => {
  if (req.headers.get("x-ingest-key") !== Deno.env.get("INGEST_KEY")) {
    return new Response("unauthorized", { status: 401 });
  }
  const u = new URL(req.url);
  const dias = Number(u.searchParams.get("dias") ?? 7);
  const modalidade = u.searchParams.get("modalidade") ?? "6"; // 6 = pregão eletrônico
  const paginas = Number(u.searchParams.get("paginas") ?? 5);
  const fim = new Date(), ini = new Date(Date.now() - dias * 864e5);

  let total = 0;
  for (let p = 1; p <= paginas; p++) {
    const r = await fetch(
      `https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao?dataInicial=${isoDay(ini)}&dataFinal=${isoDay(fim)}&codigoModalidadeContratacao=${modalidade}&pagina=${p}&tamanhoPagina=50`,
    );
    if (!r.ok) break;
    const itens = (await r.json()).data ?? [];
    if (!itens.length) break;
    const rows = itens.map((i: any) => {
      const cnpj = i.orgaoEntidade?.cnpj ?? "";
      return {
        fonte: "pncp",
        titulo: (i.objetoCompra ?? "").slice(0, 200),
        texto: `${i.objetoCompra ?? ""} ${i.numeroControlePNCP ?? ""} ${cnpj}`,
        orgao: i.orgaoEntidade?.razaoSocial ?? "",
        data: i.dataPublicacaoPncp ?? "",
        url: `https://pncp.gov.br/app/editais/${cnpj}/${i.anoCompra}/${i.sequencialCompra}`,
      };
    });
    const { error } = await sb.from("docs").upsert(rows, { onConflict: "fonte,url" });
    if (error) return Response.json({ erro: error.message, total }, { status: 500 });
    total += rows.length;
  }
  return Response.json({ upserted: total });
});
