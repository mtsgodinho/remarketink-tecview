import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLocal, migrate, type DB } from "../src/lib/db";
import {
  ensureUser,
  createCampaign,
  campaignAction,
  suppress,
  overview,
} from "../src/repositories/store";
import { importRows } from "../src/features/imports";
import { tick, recoverStale } from "../src/workers/processor";
import { ProviderError } from "../src/services/evolution";
import { handleWebhook } from "../src/services/webhooks";
let db: DB;
before(async () => {
  db = await createLocal();
  await migrate(db);
});
async function campaignForContacts(
  database: DB,
  userId: string,
  input: Record<string, unknown>,
) {
  const contactIds = (
    await database.query("SELECT id FROM contacts WHERE user_id=$1", [userId])
  ).rows.map((c) => c.id);
  return createCampaign(database, userId, { ...input, contactIds });
}
async function setup(simulation = true) {
  const user = { id: randomUUID(), email: "test@example.test" };
  await ensureUser(db, user);
  const data = await importRows(
    db,
    user.id,
    "test.csv",
    [
      {
        Nome: "Ana",
        Tel: "11999991234",
        Consent: "sim",
        Produto: "TV",
        Link: "https://loja.test/carrinho",
      },
    ],
    {
      name: "Nome",
      phone: "Tel",
      product: "Produto",
      link: "Link",
    },
  );
  assert.equal(data.imported, 1);
  await db.query(
    "UPDATE message_templates SET content='Oi {{nome}}, {{produto}}: {{link}}. Responda SAIR para parar.' WHERE user_id=$1 AND slot=1",
    [user.id],
  );
  const { id } = await campaignForContacts(db, user.id, {
    name: "Campanha teste",
    minInterval: 1,
    maxInterval: 1,
    simulation,
  });
  return { user, id };
}
async function jobs(id: string) {
  return (
    await db.query("SELECT * FROM message_jobs WHERE campaign_id=$1", [id])
  ).rows;
}
test("mapeamento e deduplicação permitem contatos sem campo de consentimento", async () => {
  const user = { id: randomUUID(), email: "import@test.test" };
  await ensureUser(db, user);
  const result = await importRows(
    db,
    user.id,
    "maria.csv",
    [
      { Cliente: "Ana", Tel: "11999991234", Perm: "sim" },
      { Cliente: "Ana 2", Tel: "+55 11 99999-1234", Perm: "sim" },
      { Cliente: "Bia", Tel: "21988881234", Perm: "" },
      { Cliente: "Erro", Tel: "123", Perm: "sim" },
    ],
    { name: "Cliente", phone: "Tel" },
  );
  assert.equal(result.imported, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid, 1);
  assert.equal("withoutConsent" in result, false);
  assert.equal(
    (
      await db.query("SELECT * FROM contact_consents WHERE user_id=$1", [
        user.id,
      ])
    ).rows.length,
    0,
  );
  await db.query(
    "UPDATE message_templates SET content='Olá {{nome}}' WHERE user_id=$1 AND slot=1",
    [user.id],
  );
  const c = await campaignForContacts(db, user.id, {
    name: "Clientes que entraram em contato",
    minInterval: 1,
    maxInterval: 1,
    simulation: true,
  });
  assert.equal(c.total, 2);
  const other = (
    await db.query("SELECT * FROM contacts WHERE user_id=$1", [user.id])
  ).rows;
  assert.equal(other.length, 2);
});
test("pausa, retomada, simulação e prevenção de duplicados", async () => {
  const { user, id } = await setup();
  await campaignAction(db, user.id, id, "start");
  await campaignAction(db, user.id, id, "pause");
  assert.equal(
    await tick(db, () => {
      throw Error("Nunca deve usar provedor");
    }),
    false,
  );
  assert.equal((await jobs(id))[0].state, "pending");
  await campaignAction(db, user.id, id, "resume");
  await tick(db, () => {
    throw Error("Simulação não envia");
  });
  assert.equal((await jobs(id))[0].state, "simulated");
  assert.equal((await overview(db, user.id)).counts.sent, 0);
  await tick(db);
  assert.equal((await jobs(id)).length, 1);
  await assert.rejects(() => campaignAction(db, user.id, id, "resume"));
});
test("cancelamento é terminal e preserva o progresso", async () => {
  const { user, id } = await setup();
  await campaignAction(db, user.id, id, "cancel");
  assert.equal((await jobs(id))[0].state, "cancelled");
  await assert.rejects(() => campaignAction(db, user.id, id, "start"));
});
test("descadastro impede envio mesmo após criação da fila", async () => {
  const { user, id } = await setup();
  await campaignAction(db, user.id, id, "start");
  await suppress(db, user.id, "5511999991234", "Pedido do cliente");
  await tick(db);
  assert.equal((await jobs(id))[0].state, "skipped");
});
test("recuperação de envio interrompido bloqueia reenvio e retomada", async () => {
  const { user, id } = await setup();
  await campaignAction(db, user.id, id, "start");
  await db.query(
    "UPDATE message_jobs SET state='sending',processing_at=now()-interval '3 minutes' WHERE campaign_id=$1",
    [id],
  );
  await recoverStale(db);
  assert.equal((await jobs(id))[0].state, "unknown");
  await assert.rejects(
    () => campaignAction(db, user.id, id, "resume"),
    /desconhecido/,
  );
});
test("eventos reais são idempotentes, monotônicos e opt-out é permanente", async () => {
  const { user, id } = await setup();
  const instance = (
    await db.query("SELECT * FROM whatsapp_instances WHERE user_id=$1", [
      user.id,
    ])
  ).rows[0];
  const job = (await jobs(id))[0];
  await db.query(
    "UPDATE message_jobs SET simulation=false,state='requested',provider_id='provider-test',processed_at=now() WHERE id=$1",
    [job.id],
  );
  const event = {
    instance: instance.name,
    event: "MESSAGES_UPDATE",
    data: [{ key: { id: "provider-test" }, update: { status: "READ" } }],
  };
  await handleWebhook(db, event);
  await handleWebhook(db, event);
  assert.equal((await jobs(id))[0].state, "read");
  await handleWebhook(db, {
    ...event,
    data: [{ key: { id: "provider-test" }, update: { status: "SERVER_ACK" } }],
  });
  assert.equal((await jobs(id))[0].state, "read");
  const reply = {
    instance: instance.name,
    event: "MESSAGES_UPSERT",
    data: {
      key: {
        id: "reply-1",
        fromMe: false,
        remoteJid: "5511999991234@s.whatsapp.net",
      },
      message: { conversation: "SAIR" },
    },
  };
  await handleWebhook(db, reply);
  await handleWebhook(db, reply);
  assert.equal((await jobs(id))[0].state, "replied");
  assert.equal(
    (
      await db.query("SELECT * FROM contact_suppressions WHERE user_id=$1", [
        user.id,
      ])
    ).rows.length,
    1,
  );
  assert.equal(
    (
      await db.query("SELECT * FROM customer_replies WHERE user_id=$1", [
        user.id,
      ])
    ).rows.length,
    1,
  );
  assert.equal((await overview(db, user.id)).counts.recovered, 0);
});
test("fila persiste em banco em disco após reabertura", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "techview-db-"));
  const durable = await createLocal(directory);
  await migrate(durable);
  const user = { id: randomUUID(), email: "persistent@test.test" };
  await ensureUser(durable, user);
  await importRows(
    durable,
    user.id,
    "persist.csv",
    [{ Nome: "Ana", Tel: "11999991234", Consent: "sim" }],
    { name: "Nome", phone: "Tel" },
  );
  await durable.query(
    "UPDATE message_templates SET content='Oi {{nome}}' WHERE user_id=$1 AND slot=1",
    [user.id],
  );
  const c = await campaignForContacts(durable, user.id, {
    name: "Persistência real",
    minInterval: 1,
    maxInterval: 1,
    simulation: true,
  });
  await campaignAction(durable, user.id, c.id, "start");
  await durable.close!();
  const restored = await createLocal(directory);
  await migrate(restored);
  assert.equal(
    (
      await restored.query(
        "SELECT state FROM message_jobs WHERE campaign_id=$1",
        [c.id],
      )
    ).rows[0].state,
    "pending",
  );
  await tick(restored, () => {
    throw Error("Simulação nunca envia");
  });
  assert.equal(
    (
      await restored.query(
        "SELECT state FROM message_jobs WHERE campaign_id=$1",
        [c.id],
      )
    ).rows[0].state,
    "simulated",
  );
  await restored.close!();
  await fs.rm(directory, { recursive: true });
});
async function realSetup() {
  process.env.REAL_SEND_ENABLED = "true";
  process.env.SIMULATION_MODE = "false";
  const s = await setup(false);
  await db.query(
    "UPDATE whatsapp_instances SET status='open',settings=jsonb_set(jsonb_set(settings,'{startHour}','0'),'{endHour}','24') WHERE user_id=$1",
    [s.user.id],
  );
  await campaignAction(db, s.user.id, s.id, "start");
  return s;
}
test("falha ambígua do provedor não é repetida; campanha pausa", async () => {
  const { user, id } = await realSetup();
  let calls = 0;
  const provider = {
    status: async () => ({ instance: { state: "open" } }),
    send: async () => {
      calls++;
      throw new ProviderError("Timeout", "unknown");
    },
  };
  await tick(db, () => provider);
  assert.equal(calls, 1);
  assert.equal((await jobs(id))[0].state, "unknown");
  assert.equal(
    (await db.query("SELECT status FROM campaigns WHERE id=$1", [id])).rows[0]
      .status,
    "paused",
  );
  await tick(db, () => provider);
  assert.equal(calls, 1);
});
test("rejeição 429 tem retry controlado e backoff", async () => {
  const { user, id } = await realSetup();
  await tick(db, () => ({
    status: async () => ({ instance: { state: "open" } }),
    send: async () => {
      throw new ProviderError("429", "rejected", 429);
    },
  }));
  const j = (await jobs(id))[0];
  assert.equal(j.state, "pending");
  assert.equal(j.attempts, 1);
  assert.ok(new Date(j.next_run_at).getTime() > Date.now() + 30000);
  await campaignAction(db, user.id, id, "cancel");
});
test("conexão cai antes de enviar: pausa sem chamar send", async () => {
  const { user, id } = await realSetup();
  let sends = 0;
  await tick(db, () => ({
    status: async () => ({ instance: { state: "close" } }),
    send: async () => {
      sends++;
    },
  }));
  assert.equal(sends, 0);
  assert.equal((await jobs(id))[0].state, "pending");
  assert.equal(
    (await db.query("SELECT status FROM campaigns WHERE id=$1", [id])).rows[0]
      .status,
    "paused",
  );
  await campaignAction(db, user.id, id, "cancel");
});
test("worker concorrente serializa envios pelo mesmo número", async () => {
  const { user, id } = await realSetup();
  let sends = 0;
  const provider = {
    status: async () => ({ instance: { state: "open" } }),
    send: async () => {
      sends++;
      await new Promise((r) => setTimeout(r, 25));
      return { key: { id: randomUUID() } };
    },
  };
  await Promise.all([tick(db, () => provider), tick(db, () => provider)]);
  assert.equal(sends, 1);
  assert.equal((await jobs(id))[0].state, "requested");
});
test("dados do painel permanecem isolados por usuário", async () => {
  const { user } = await setup();
  const other = { id: randomUUID(), email: "other@test.test" };
  await ensureUser(db, other);
  const view = await overview(db, other.id);
  assert.equal(view.contacts.length, 0);
  assert.equal(view.campaigns.length, 0);
  assert.equal(view.counts.sent, 0);
});
test("falha na consulta de conexão pausa e não cria resultado desconhecido", async () => {
  const { user, id } = await realSetup();
  let sends = 0;
  await tick(db, () => ({
    status: async () => {
      throw new ProviderError("Status indisponível", "unknown");
    },
    send: async () => {
      sends++;
    },
  }));
  assert.equal(sends, 0);
  assert.equal((await jobs(id))[0].state, "pending");
  assert.equal(
    (await db.query("SELECT status FROM campaigns WHERE id=$1", [id])).rows[0]
      .status,
    "paused",
  );
  await campaignAction(db, user.id, id, "cancel");
});
test("evento de entrega antecipado é conciliado após aceitação do envio", async () => {
  const { user, id } = await realSetup();
  const instance = (
    await db.query("SELECT * FROM whatsapp_instances WHERE user_id=$1", [
      user.id,
    ])
  ).rows[0];
  const providerId = randomUUID();
  await tick(db, () => ({
    status: async () => ({ instance: { state: "open" } }),
    send: async () => {
      await handleWebhook(db, {
        instance: instance.name,
        event: "messages.update",
        data: [{ keyId: providerId, status: "DELIVERY_ACK" }],
      });
      return { key: { id: providerId } };
    },
  }));
  assert.equal((await jobs(id))[0].state, "delivered");
});
test("RLS permite apenas leitura própria e bloqueia escritas diretas", async () => {
  const { user } = await setup();
  await db.query("CREATE ROLE test_reader NOLOGIN");
  await db.query("GRANT USAGE ON SCHEMA public TO test_reader");
  await db.query("GRANT SELECT,INSERT ON contacts TO test_reader");
  await db.transaction(async (tx) => {
    await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user.id }),
    ]);
    await tx.query("SET LOCAL ROLE test_reader");
    const rows = (await tx.query("SELECT * FROM contacts")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, user.id);
  });
  await assert.rejects(
    () =>
      db.transaction(async (tx) => {
        await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: user.id }),
        ]);
        await tx.query("SET LOCAL ROLE test_reader");
        await tx.query(
          "INSERT INTO contacts(id,user_id,name,phone) VALUES($1,$2,'Bypass','5521999991234')",
          [randomUUID(), user.id],
        );
      }),
    /row-level security/,
  );
});
test("nova exportação Maria atualiza compra no funil sem remover exclusão", async () => {
  const { user, id } = await setup();
  await campaignAction(db, user.id, id, "cancel");
  const update = await importRows(
    db,
    user.id,
    "maria-atualizada.csv",
    [{ Nome: "Ana", Tel: "11999991234", Status: "pago", Consent: "nao" }],
    { name: "Nome", phone: "Tel", status: "Status" },
  );
  assert.equal(update.updated, 1);
  assert.equal(update.imported, 0);
  await assert.rejects(
    () =>
      campaignForContacts(db, user.id, {
        name: "Não enviar",
        minInterval: 1,
        maxInterval: 1,
        simulation: true,
      }),
    /Nenhum contato elegível/,
  );
  await suppress(db, user.id, "5511999991234", "Exclusão permanente");
  await importRows(
    db,
    user.id,
    "maria-nova.csv",
    [{ Nome: "Ana", Tel: "11999991234", Status: "abandonado", Consent: "sim" }],
    { name: "Nome", phone: "Tel", status: "Status" },
  );
  await assert.rejects(
    () =>
      campaignForContacts(db, user.id, {
        name: "Exclusão prevalece",
        minInterval: 1,
        maxInterval: 1,
        simulation: true,
      }),
    /Nenhum contato elegível/,
  );
});
test("contatos existentes com registro antigo negativo deixam de ser bloqueados por esse campo", async () => {
  const { user, id } = await setup();
  await campaignAction(db, user.id, id, "cancel");
  const contact = (
    await db.query("SELECT id FROM contacts WHERE user_id=$1", [user.id])
  ).rows[0];
  await db.query(
    "INSERT INTO contact_consents(id,user_id,contact_id,granted,source) VALUES($1,$2,$3,false,$4)",
    [
      randomUUID(),
      user.id,
      contact.id,
      "Registro histórico de importação sem campo",
    ],
  );
  const c = await createCampaign(db, user.id, {
    name: "Contatos existentes",
    minInterval: 1,
    maxInterval: 1,
    simulation: true,
    contactIds: [contact.id],
  });
  assert.equal(c.total, 1);
  await campaignAction(db, user.id, c.id, "start");
  await tick(db, () => {
    throw Error("Simulação não chama provedor");
  });
  assert.equal((await jobs(c.id))[0].state, "simulated");
  assert.equal(
    (
      await db.query(
        "SELECT granted FROM contact_consents WHERE contact_id=$1",
        [contact.id],
      )
    ).rows[0].granted,
    false,
  );
});
test("campanha exige seleção explícita e não inclui contatos fora da seleção", async () => {
  const { user, id } = await setup();
  await campaignAction(db, user.id, id, "cancel");
  const first = (
    await db.query("SELECT id FROM contacts WHERE user_id=$1", [user.id])
  ).rows[0].id;
  await importRows(
    db,
    user.id,
    "outros.csv",
    [{ Nome: "Outro contato", Tel: "21999991234" }],
    { name: "Nome", phone: "Tel" },
  );
  const input = {
    name: "Somente escolhidos",
    minInterval: 1,
    maxInterval: 1,
    simulation: true,
  };
  await assert.rejects(() => createCampaign(db, user.id, input));
  await assert.rejects(() =>
    createCampaign(db, user.id, { ...input, contactIds: [] }),
  );
  const c = await createCampaign(db, user.id, {
    ...input,
    contactIds: [first],
  });
  assert.equal(c.total, 1);
  assert.deepEqual(
    (await jobs(c.id)).map((j) => j.contact_id),
    [first],
  );
});
test("contatos bloqueados e com compra confirmada continuam fora da fila", async () => {
  const { user, id } = await setup();
  await campaignAction(db, user.id, id, "cancel");
  await db.query("UPDATE contacts SET blocked=true WHERE user_id=$1", [
    user.id,
  ]);
  await assert.rejects(
    () =>
      campaignForContacts(db, user.id, {
        name: "Bloqueado",
        minInterval: 1,
        maxInterval: 1,
        simulation: true,
      }),
    /Nenhum contato elegível/,
  );
  await db.query(
    "UPDATE contacts SET blocked=false,purchased_at=now(),purchase_source='Pedido confirmado' WHERE user_id=$1",
    [user.id],
  );
  await assert.rejects(
    () =>
      campaignForContacts(db, user.id, {
        name: "Comprou",
        minInterval: 1,
        maxInterval: 1,
        simulation: true,
      }),
    /Nenhum contato elegível/,
  );
});
