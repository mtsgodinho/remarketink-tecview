import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhone,
  chooseTemplate,
  renderTemplate,
  intervalSchema,
  randomInterval,
  isOptOut,
  csv,
  validateTemplate,
} from "../src/features/rules";
import { parseFile } from "../src/features/imports";
import ExcelJS from "exceljs";
test("normaliza Brasil e rejeita ambiguidades sem inserir dígitos", () => {
  assert.equal(normalizePhone("(11) 99999-1234"), "5511999991234");
  assert.equal(normalizePhone("+55 (21) 2345-6789"), "552123456789");
  for (const p of [
    "1234",
    "0011999991234",
    "1198881234",
    "5510999991234",
    "+1 202 555 0123",
    "11 abc 999991234",
  ])
    assert.throws(() => normalizePhone(p));
});
test("seleção aleatória usa apenas templates habilitados e não vazios", () => {
  const templates = [
    { content: "a", enabled: true },
    { content: "b", enabled: true },
    { content: "", enabled: true },
    { content: "c", enabled: false },
  ];
  const selected = Array.from(
    { length: 200 },
    () => chooseTemplate(templates).content,
  );
  assert.ok(selected.every((v) => v === "a" || v === "b"));
  assert.deepEqual(new Set(selected), new Set(["a", "b"]));
  assert.throws(() => chooseTemplate([{ content: "", enabled: true }]));
});
test("intervalos inclusivos e limites validados", () => {
  assert.equal(randomInterval(15, 15), 15);
  for (let i = 0; i < 100; i++)
    assert.ok(randomInterval(15, 50) >= 15 && randomInterval(15, 50) <= 50);
  for (const v of [
    { minInterval: 0, maxInterval: 5 },
    { minInterval: 10, maxInterval: 5 },
    { minInterval: 1, maxInterval: 3601 },
  ])
    assert.equal(intervalSchema.safeParse(v).success, false);
});
test("variáveis e prévia validadas; não aceita campos ausentes", () => {
  assert.equal(
    renderTemplate("Oi {{nome}}, {{produto}}: {{link}}", {
      name: "Ana",
      product: "TV",
      cart_url: "https://loja.test",
    }),
    "Oi Ana, TV: https://loja.test",
  );
  assert.throws(() => validateTemplate("Oi {{senha}}"));
  assert.throws(() =>
    renderTemplate("{{produto}}", { name: "Ana", product: "", cart_url: "" }),
  );
});
test("reconhece opt-out sem confundir mensagem comum", () => {
  for (const s of ["SAIR", "Parar, por favor", "não quero receber", "stop"])
    assert.ok(isOptOut(s));
  assert.equal(isOptOut("Quero sair para buscar o produto"), false);
});
test("exportação CSV evita fórmula e escapa delimitadores", () => {
  const output = csv([
    { nome: '=HYPERLINK("url")', telefone: "+5511999991234" },
  ]);
  assert.ok(output.includes("'="));
  assert.ok(output.includes("'+55"));
  assert.ok(output.includes('""url""'));
});
test("CSV com separador Maria e BOM preserva cabeçalhos e linhas", async () => {
  const p = await parseFile(
    Buffer.from("\ufeffNome;Telefone;Consentimento\r\nAna;11999991234;sim\r\n"),
    "maria.csv",
  );
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].Nome, "Ana");
  assert.deepEqual(p.headers, ["Nome", "Telefone", "Consentimento"]);
});
test("XLSX é lido com cabeçalhos flexíveis e rejeita fórmulas", async () => {
  const w = new ExcelJS.Workbook();
  const sheet = w.addWorksheet("Maria");
  sheet.addRow(["Cliente", "Celular"]);
  sheet.addRow(["Ana", "11999991234"]);
  const p = await parseFile(
    Buffer.from(await w.xlsx.writeBuffer()),
    "maria.xlsx",
  );
  assert.equal(p.rows[0].Cliente, "Ana");
  sheet.getCell("B2").value = { formula: "1+1", result: 2 };
  await assert.rejects(() => parseFile(Buffer.from([]), "maria.exe"));
  await assert.rejects(
    async () =>
      parseFile(Buffer.from(await w.xlsx.writeBuffer()), "maria.xlsx"),
    /Fórmulas/,
  );
});
test("rejeita extensão e tamanho inválidos", async () => {
  await assert.rejects(() =>
    parseFile(Buffer.alloc(5 * 1024 * 1024 + 1), "file.csv"),
  );
  await assert.rejects(() => parseFile(Buffer.from("bad"), "file.xlsx"));
});
