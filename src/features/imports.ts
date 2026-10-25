import Papa from "papaparse";
import ExcelJS from "exceljs";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { normalizePhone } from "./rules";
import { assert, AppError } from "@/lib/errors";
import type { DB } from "@/lib/db";
export const MAX_FILE = 5 * 1024 * 1024,
  MAX_ROWS = 10000;
export const mappingSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  status: z.string().optional(),
  product: z.string().optional(),
  link: z.string().optional(),
  abandonedAt: z.string().optional(),
  orderId: z.string().optional(),
  consent: z.string().optional(),
});
export type Mapping = z.infer<typeof mappingSchema>;
export async function parseFile(buffer: Buffer, name: string) {
  assert(
    buffer.length > 0 && buffer.length <= MAX_FILE,
    "O arquivo deve ter até 5 MB.",
  );
  let rows: Record<string, string>[] = [];
  if (name.toLowerCase().endsWith(".csv")) {
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      preview: MAX_ROWS + 1,
      skipEmptyLines: "greedy",
      transformHeader: (h) => h.trim(),
    });
    assert(
      !Object.keys(parsed.meta.renamedHeaders || {}).length,
      "Cabeçalhos duplicados não são permitidos.",
    );
    assert(
      !parsed.errors.length,
      "CSV inválido: verifique as colunas e delimitadores.",
    );
    rows = parsed.data;
  } else if (name.toLowerCase().endsWith(".xlsx")) {
    assert(buffer[0] === 0x50 && buffer[1] === 0x4b, "Arquivo XLSX inválido.");
    // Inspect zip central directory before decompression to reject archive bombs.
    let total = 0,
      entries = 0;
    for (let p = 0; p + 46 < buffer.length; p++)
      if (buffer.readUInt32LE(p) === 0x02014b50) {
        total += buffer.readUInt32LE(p + 24);
        entries++;
        assert(
          total <= 30 * 1024 * 1024 && entries <= 300,
          "Planilha compactada excede os limites de segurança.",
        );
        p +=
          45 +
          buffer.readUInt16LE(p + 28) +
          buffer.readUInt16LE(p + 30) +
          buffer.readUInt16LE(p + 32);
      }
    assert(entries > 0, "Estrutura XLSX inválida.");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];
    assert(sheet, "A planilha não contém abas.");
    assert(sheet.rowCount <= MAX_ROWS + 1, "Máximo de 10.000 linhas.");
    const headers: string[] = [];
    sheet
      .getRow(1)
      .eachCell(
        { includeEmpty: true },
        (cell, i) => (headers[i - 1] = cell.text.trim()),
      );
    assert(
      headers.length > 0 &&
        headers.length <= 50 &&
        headers.every(Boolean) &&
        new Set(headers).size === headers.length,
      "Cabeçalhos devem ser únicos, preenchidos e ter até 50 colunas.",
    );
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      const values: Record<string, string> = {};
      headers.forEach((h, i) => {
        const c = row.getCell(i + 1);
        assert(
          c.type !== ExcelJS.ValueType.Formula,
          "Fórmulas não são aceitas; exporte somente valores.",
        );
        values[h] = c.value instanceof Date ? c.value.toISOString() : c.text;
      });
      if (Object.values(values).some(Boolean)) rows.push(values);
    });
  } else throw new AppError("Formato não permitido. Envie CSV ou XLSX.");
  assert(
    rows.length > 0 && rows.length <= MAX_ROWS,
    "A planilha deve ter de 1 a 10.000 linhas.",
  );
  const headers = Object.keys(rows[0]);
  assert(
    headers.length <= 50 && headers.every(Boolean),
    "Máximo de 50 colunas com cabeçalhos preenchidos.",
  );
  assert(
    rows.every((r) =>
      Object.values(r).every((v) => typeof v === "string" && v.length <= 4000),
    ),
    "Células devem ter até 4.000 caracteres.",
  );
  return { headers, rows };
}
export async function importRows(
  db: DB,
  userId: string,
  filename: string,
  rows: Record<string, string>[],
  mapping: Mapping,
) {
  mappingSchema.parse(mapping);
  const importId = randomUUID();
  const result = {
    total: rows.length,
    valid: 0,
    invalid: 0,
    duplicates: 0,
    withoutConsent: 0,
    updated: 0,
    imported: 0,
    errors: [] as { linha: number; erro: string }[],
  };
  return db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO imports(id,user_id,filename,mapping) VALUES($1,$2,$3,$4)",
      [importId, userId, filename, JSON.stringify(mapping)],
    );
    const seen = new Set<string>();
    for (const [i, row] of rows.entries()) {
      let contactId: string | null = null,
        reason = "",
        status = "imported";
      try {
        const phone = normalizePhone(row[mapping.phone]),
          name = row[mapping.name]?.trim();
        assert(
          name && name.length <= 200,
          "Nome obrigatório, até 200 caracteres.",
        );
        const consent = mapping.consent
          ? String(row[mapping.consent]).trim().toLowerCase()
          : "";
        const granted = ["sim", "true", "1", "yes", "autorizado"].includes(
          consent,
        );
        if (!granted) result.withoutConsent++;
        const link = mapping.link ? row[mapping.link] || "" : "";
        if (link)
          assert(
            /^https?:\/\//.test(link) && URL.canParse(link),
            "Link do carrinho inválido.",
          );
        const date = mapping.abandonedAt ? row[mapping.abandonedAt] : null;
        if (date)
          assert(
            !Number.isNaN(Date.parse(date)) && /^\d{4}-\d{2}-\d{2}/.test(date),
            "Data deve estar no formato ISO (AAAA-MM-DD).",
          );
        result.valid++;
        const existing = (
          await tx.query(
            "SELECT id FROM contacts WHERE user_id=$1 AND phone=$2",
            [userId, phone],
          )
        ).rows[0];
        if (seen.has(phone) || existing) {
          result.duplicates++;
          status = "duplicate";
          contactId = existing?.id ?? null;
          if (existing && !seen.has(phone)) {
            const funnel = mapping.status
              ? row[mapping.status]?.trim()
              : undefined;
            if (funnel)
              await tx.query(
                "UPDATE contacts SET funnel_status=$1,updated_at=now() WHERE id=$2",
                [funnel, existing.id],
              );
            if (
              mapping.consent &&
              [
                "sim",
                "true",
                "1",
                "yes",
                "autorizado",
                "não",
                "nao",
                "false",
                "0",
                "no",
                "revogado",
              ].includes(consent)
            )
              await tx.query(
                "INSERT INTO contact_consents(id,user_id,contact_id,granted,source) VALUES($1,$2,$3,$4,$5)",
                [
                  randomUUID(),
                  userId,
                  existing.id,
                  granted,
                  `Atualização por importação ${importId}, linha ${i + 2}, coluna ${mapping.consent}: ${consent}`,
                ],
              );
            result.updated++;
            reason =
              "Telefone existente: status e consentimento explícito atualizados; demais dados preservados.";
          } else
            reason =
              "Telefone repetido na mesma planilha; primeira ocorrência preservada.";
        } else {
          contactId = randomUUID();
          await tx.query(
            "INSERT INTO contacts(id,user_id,name,phone,funnel_status,product,cart_url,abandoned_at,order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              contactId,
              userId,
              name,
              phone,
              mapping.status ? row[mapping.status] || "" : "",
              mapping.product ? row[mapping.product] || "" : "",
              link,
              date || null,
              mapping.orderId ? row[mapping.orderId] || "" : "",
            ],
          );
          await tx.query(
            "INSERT INTO contact_consents(id,user_id,contact_id,granted,source) VALUES($1,$2,$3,$4,$5)",
            [
              randomUUID(),
              userId,
              contactId,
              granted,
              `Importação ${importId}, linha ${i + 2}, coluna ${mapping.consent || "ausente"}: ${consent || "não informado"}`,
            ],
          );
          result.imported++;
        }
        seen.add(phone);
      } catch (e) {
        reason = e instanceof Error ? e.message : "Linha inválida";
        status = "invalid";
        result.invalid++;
      }
      if (reason) result.errors.push({ linha: i + 2, erro: reason });
      await tx.query(
        "INSERT INTO import_rows(id,user_id,import_id,row_number,status,error,contact_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          userId,
          importId,
          i + 2,
          status,
          reason || null,
          contactId,
        ],
      );
    }
    await tx.query("UPDATE imports SET summary=$1 WHERE id=$2", [
      JSON.stringify({ ...result, errors: undefined }),
      importId,
    ]);
    return { id: importId, ...result };
  });
}
