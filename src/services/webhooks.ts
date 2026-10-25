import { randomUUID, createHash } from "node:crypto";
import type { DB } from "@/lib/db";
import { isOptOut } from "@/features/rules";
import { suppress } from "@/repositories/store";
import { assert } from "@/lib/errors";
export const statusRank: Record<string, number> = {
  requested: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  replied: 4,
};
export function providerState(value: unknown) {
  return (
    {
      ERROR: "failed",
      "0": "failed",
      SERVER_ACK: "sent",
      DELIVERY_ACK: "delivered",
      READ: "read",
      PLAYED: "read",
      "2": "sent",
      "3": "delivered",
      "4": "read",
      "5": "read",
    } as Record<string, string>
  )[String(value)];
}
export async function advanceJob(
  db: DB,
  user: string,
  providerId: string,
  state: string,
) {
  const job = (
    await db.query(
      "SELECT * FROM message_jobs WHERE user_id=$1 AND provider_id=$2 FOR UPDATE",
      [user, providerId],
    )
  ).rows[0];
  if (!job) return;
  if (state === "failed" && ["requested", "unknown"].includes(job.state)) {
    await db.query(
      "UPDATE message_jobs SET state='failed',error='Falha confirmada por evento do provedor',processed_at=COALESCE(processed_at,now()) WHERE id=$1",
      [job.id],
    );
    return;
  }
  if ((statusRank[state] ?? -1) > (statusRank[job.state] ?? -1))
    await db.query(
      "UPDATE message_jobs SET state=$1,error=NULL,processed_at=COALESCE(processed_at,now()) WHERE id=$2",
      [state, job.id],
    );
}
export async function handleWebhook(db: DB, body: any) {
  assert(
    body && typeof body.instance === "string" && typeof body.event === "string",
    "Evento inválido.",
  );
  const instance = (
    await db.query("SELECT * FROM whatsapp_instances WHERE name=$1", [
      body.instance,
    ])
  ).rows[0];
  assert(instance, "Instância desconhecida.", 404);
  const user = instance.user_id,
    event = body.event.toLowerCase().replaceAll("_", "."),
    data = body.data;
  const updates =
    event === "messages.update"
      ? (Array.isArray(data) ? data : [data])
          .map((item) => ({
            providerId: item?.key?.id || item?.keyId,
            state: providerState(item?.update?.status ?? item?.status),
          }))
          .filter((item) => item.providerId && item.state)
      : [];
  const key = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return db.transaction(async (tx) => {
    const inserted = await tx.query(
      "INSERT INTO message_events(id,user_id,event_key,type,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_key) DO NOTHING RETURNING id",
      [randomUUID(), user, key, event, JSON.stringify({ updates })],
    );
    if (!inserted.rows.length) return { duplicate: true };
    if (event === "connection.update") {
      const state = data?.state === "open" ? "open" : "disconnected";
      await tx.query(
        "UPDATE whatsapp_instances SET status=$1,phone=COALESCE($3,phone),last_connected_at=CASE WHEN $1='open' THEN now() ELSE last_connected_at END,updated_at=now() WHERE id=$2",
        [
          state,
          instance.id,
          typeof data?.number === "string" ? data.number : null,
        ],
      );
      if (state !== "open")
        await tx.query(
          "UPDATE campaigns SET status='paused',pause_reason='WhatsApp desconectado',updated_at=now() WHERE user_id=$1 AND status='running' AND NOT simulation",
          [user],
        );
    }
    if (event === "messages.update") {
      for (const item of Array.isArray(data) ? data : [data]) {
        const id = item?.key?.id || item?.keyId;
        const state = providerState(item?.update?.status ?? item?.status);
        if (id && state) await advanceJob(tx, user, id, state);
      }
    }
    if (event === "messages.upsert") {
      for (const item of Array.isArray(data) ? data : [data]) {
        if (
          !item?.key?.id ||
          item.key.fromMe ||
          !String(item.key.remoteJid).endsWith("@s.whatsapp.net")
        )
          continue;
        const phone = String(item.key.remoteJid).split("@")[0];
        const text =
          item.message?.conversation ||
          item.message?.extendedTextMessage?.text ||
          "";
        if (typeof text !== "string" || !text) continue;
        const contact = (
          await tx.query(
            "SELECT id FROM contacts WHERE user_id=$1 AND phone=$2",
            [user, phone],
          )
        ).rows[0];
        const job = contact
          ? (
              await tx.query(
                "SELECT id FROM message_jobs WHERE user_id=$1 AND contact_id=$2 AND NOT simulation AND state IN ('sending','requested','sent','delivered','read','replied') ORDER BY COALESCE(processed_at,processing_at) DESC LIMIT 1",
                [user, contact.id],
              )
            ).rows[0]
          : null;
        await tx.query(
          "INSERT INTO customer_replies(id,user_id,contact_id,job_id,provider_id,content) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,provider_id) DO NOTHING",
          [
            randomUUID(),
            user,
            contact?.id || null,
            job?.id || null,
            item.key.id,
            text.slice(0, 10000),
          ],
        );
        if (job)
          await tx.query(
            "UPDATE message_jobs SET state='replied' WHERE id=$1",
            [job.id],
          );
        if (isOptOut(text))
          await suppress(tx, user, phone, "Opt-out recebido no WhatsApp");
      }
    }
    return { received: true };
  });
}

export async function replayProviderEvents(
  db: DB,
  user: string,
  providerId: string,
) {
  const events = (
    await db.query(
      "SELECT data FROM message_events WHERE user_id=$1 AND type='messages.update' AND data->'updates' @> $2::jsonb ORDER BY created_at",
      [user, JSON.stringify([{ providerId }])],
    )
  ).rows;
  for (const event of events)
    for (const update of event.data.updates || [])
      if (update.providerId === providerId)
        await advanceJob(db, user, providerId, update.state);
}
