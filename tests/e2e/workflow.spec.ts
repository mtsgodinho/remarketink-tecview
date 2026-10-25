import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
test("login, importação Maria, mensagens, campanha simulada, histórico e mobile", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  expect((await request.get("/api/overview")).status()).toBe(401);
  expect(
    (
      await request.post("/api/templates", {
        data: [],
        headers: { Origin: "https://attacker.test" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (await request.post("/api/webhooks/evolution", { data: {} })).status(),
  ).toBe(401);
  const access = await fs.readFile(".data/local-access.txt", "utf8");
  const email = access.match(/E-mail: (.+)/)![1],
    password = access.match(/Senha: (.+)/)![1];
  await page.goto("/");
  await expect(page).toHaveURL(/login/);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Acessar painel" }).click();
  await expect(
    page.getByRole("heading", { name: "TechView Remarketing", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Nenhum envio confirmado neste período"),
  ).toBeVisible();
  await page.screenshot({
    path: ".data/dashboard-desktop.png",
    fullPage: true,
  });
  const nav = (label: string) =>
    page.locator("nav").getByRole("button", { name: label, exact: true });
  await nav("Importar Planilha").click();
  await page.locator("input[type=file]").setInputFiles({
    name: "maria-e2e.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Nome;Telefone;Produto;Link\nTeste Ana;11999991234;TV;https://loja.test/a\nTeste Bia;21988881234;Monitor;https://loja.test/b\nFora da campanha;31977771234;TV;https://loja.test/c\nDuplicado;11999991234;TV;https://loja.test/a\nInvalido;123;TV;https://loja.test/a",
    ),
  });
  await expect(
    page.getByRole("heading", { name: "Mapear colunas" }),
  ).toBeVisible();
  await expect(page.getByLabel("Consentimento comercial")).toHaveCount(0);
  await page.getByRole("button", { name: "Confirmar importação" }).click();
  await expect(
    page.getByRole("heading", { name: "Resultado da importação" }),
  ).toBeVisible();
  await nav("Mensagens").click();
  for (let i = 0; i < 4; i++)
    await page
      .locator("textarea")
      .nth(i)
      .fill(
        `Olá {{nome}}, você se interessou em {{produto}}. {{link}}. Responda SAIR para parar. Variação ${i + 1}.`,
      );
  await page.getByRole("button", { name: "Salvar mensagens" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Quatro mensagens salvas",
  );
  await nav("Campanhas").click();
  await page.getByRole("button", { name: "Nova campanha" }).click();
  await page
    .getByLabel("Nome da campanha")
    .fill("Teste E2E — apenas simulação");
  await page.getByLabel("Intervalo mínimo (s)", { exact: true }).fill("1");
  await page.getByLabel("Intervalo máximo (s)", { exact: true }).fill("1");
  await expect(
    page.getByRole("button", { name: "Criar campanha" }),
  ).toBeDisabled();
  await page.getByLabel(/Teste Ana ·/).check();
  await page.getByLabel(/Teste Bia ·/).check();
  await expect(
    page.getByText("Selecionar contatos da campanha · 2 selecionados"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Criar campanha" }).click();
  await expect(page.locator("tbody")).toContainText("Teste E2E");
  await page.getByTitle("Iniciar campanha", { exact: true }).click();
  await expect
    .poll(
      async () => {
        const d = await (await page.request.get("/api/overview")).json();
        return d.campaigns[0]?.status;
      },
      { timeout: 20000 },
    )
    .toBe("completed");
  const d = await (await page.request.get("/api/overview")).json();
  expect(d.counts.contacts).toBe(3);
  expect(d.counts.sent).toBe(0);
  expect(d.counts.simulated).toBe(2);
  expect(d.jobs.filter((j: any) => j.state === "simulated")).toHaveLength(2);
  expect(d.jobs.some((j: any) => j.name === "Fora da campanha")).toBe(false);
  await nav("Histórico").click();
  await page.getByLabel("Filtrar status").selectOption("simulated");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Exportar CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("historico-techview.csv");
  await nav("Relatórios").click();
  await expect(
    page.getByRole("heading", { name: "Resultados por mensagem" }),
  ).toBeVisible();
  await nav("Configurações").click();
  await expect(
    page.getByText("Não configurada no servidor", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Abrir menu").click();
  await nav("Dashboard").click();
  await expect(
    page.getByRole("heading", { name: "TechView Remarketing", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({ path: ".data/dashboard-mobile.png", fullPage: true });
  expect(errors).toEqual([]);
});
