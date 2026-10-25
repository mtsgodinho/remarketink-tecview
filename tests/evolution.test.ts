import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Evolution, ProviderError } from "../src/services/evolution";
test("adaptador Evolution v2 usa credencial no backend, cria instância, QR e webhook", async () => {
  const paths: string[] = [];
  let exists = false;
  let status = 200;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.apikey, "test-only-key");
    paths.push(req.method + " " + req.url);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("Content-Type", "application/json");
    if (status !== 200) {
      res.statusCode = status;
      res.end("{}");
      return;
    }
    if (req.url?.startsWith("/instance/connectionState/")) {
      if (!exists) {
        res.statusCode = 404;
        res.end("{}");
      } else res.end(JSON.stringify({ instance: { state: "open" } }));
    } else if (req.url === "/instance/create") {
      exists = true;
      const b = JSON.parse(raw);
      assert.equal(b.integration, "WHATSAPP-BAILEYS");
      res.end("{}");
    } else if (req.url?.startsWith("/webhook/set/")) {
      const b = JSON.parse(raw);
      assert.equal(b.webhook.headers["x-webhook-secret"], "x".repeat(40));
      assert.equal(b.webhook.url, "https://app.test/api/webhooks/evolution");
      res.end("{}");
    } else if (req.url?.startsWith("/instance/connect/"))
      res.end(JSON.stringify({ base64: "data:image/png;base64,dGVzdA==" }));
    else if (req.url?.startsWith("/message/sendText/")) {
      const b = JSON.parse(raw);
      assert.deepEqual(b, { number: "5511999991234", text: "Teste apenas" });
      res.end(JSON.stringify({ key: { id: "provider-id" } }));
    } else res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const old = { ...process.env };
  process.env.EVOLUTION_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.EVOLUTION_API_KEY = "test-only-key";
  process.env.APP_URL = "https://app.test";
  process.env.EVOLUTION_WEBHOOK_SECRET = "x".repeat(40);
  try {
    const provider = new Evolution("instance-test");
    const qr = await provider.connect();
    assert.ok(qr.base64.startsWith("data:"));
    assert.equal(
      (await provider.send("5511999991234", "Teste apenas")).key.id,
      "provider-id",
    );
    status = 401;
    await assert.rejects(
      () => provider.status(),
      (e) => e instanceof ProviderError && e.disposition === "disconnected",
    );
    status = 429;
    await assert.rejects(
      () => provider.send("5511999991234", "Teste apenas"),
      (e) => e instanceof ProviderError && e.disposition === "rejected",
    );
    status = 503;
    await assert.rejects(
      () => provider.send("5511999991234", "Teste apenas"),
      (e) => e instanceof ProviderError && e.disposition === "unknown",
    );
    assert.ok(paths.includes("POST /instance/create"));
    assert.ok(paths.includes("POST /webhook/set/instance-test"));
  } finally {
    for (const key of [
      "EVOLUTION_API_URL",
      "EVOLUTION_API_KEY",
      "APP_URL",
      "EVOLUTION_WEBHOOK_SECRET",
    ])
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
