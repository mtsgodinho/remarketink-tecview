import { randomUUID } from "node:crypto";
import type { DB } from "@/lib/db";
import type { User, Row } from "@/types";
import {
  chooseTemplate,
  renderTemplate,
  campaignSchema,
} from "@/features/rules";
import { assert } from "@/lib/errors";
export async function audit(
  db: DB,
  user: string,
  action: string,
  id?: string,
  details: Row = {},
) {
  await db.query(
    "INSERT INTO audit_logs(id,user_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), user, action, id || null, JSON.stringify(details)],
  );
}
export async function ensureUser(db: DB, user: User) {
  await db.query(
    "INSERT INTO users(id,email) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
    [user.id, user.email],
  );
  await db.query(
    "INSERT INTO whatsapp_instances(id,user_id,name) VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING",
    [
      randomUUID(),
      user.id,
      (process.env.EVOLUTION_INSTANCE || "techview") +
        "-" +
        user.id.slice(0, 8),
    ],
  );
  for (let slot = 1; slot <= 4; slot++)
    await db.query(
      "INSERT INTO message_templates(id,user_id,slot) VALUES($1,$2,$3) ON CONFLICT(user_id,slot) DO NOTHING",
      [randomUUID(), user.id, slot],
    );
}
export const eligibleSQL = `SELECT ct.* FROM contacts ct WHERE ct.user_id=$1 AND NOT ct.blocked AND ct.purchased_at IS NULL
 AND lower(ct.funnel_status) NOT IN ('comprou','pago','purchased','paid','concluído','concluido')
 AND NOT EXISTS(SELECT 1 FROM contact_suppressions s WHERE s.user_id=ct.user_id AND s.phone=ct.phone)
 AND (SELECT cc.granted AND (cc.expires_at IS NULL OR cc.expires_at>now()) FROM contact_consents cc WHERE cc.contact_id=ct.id ORDER BY cc.recorded_at DESC,cc.id DESC LIMIT 1)=true`;
export async function createCampaign(db: DB, user: string, input: unknown) {
  const data = campaignSchema.parse(input);
  return db.transaction(async (tx) => {
    const instance = (
      await tx.query(
        "SELECT * FROM whatsapp_instances WHERE user_id=$1 FOR UPDATE",
        [user],
      )
    ).rows[0];
    assert(instance, "Instância não configurada.");
    if (!data.simulation)
      assert(
        process.env.REAL_SEND_ENABLED === "true" &&
          process.env.SIMULATION_MODE === "false",
        "Envio real está desabilitado no servidor.",
      );
    const templates = (
      await tx.query(
        "SELECT * FROM message_templates WHERE user_id=$1 ORDER BY slot",
        [user],
      )
    ).rows;
    const eligible = (await tx.query(eligibleSQL, [user])).rows.filter(
      (c) => !data.contactIds || data.contactIds.includes(c.id),
    );
    assert(
      eligible.length,
      "Nenhum contato elegível com consentimento válido.",
    );
    const id = randomUUID();
    await tx.query(
      "INSERT INTO campaigns(id,user_id,name,simulation,min_interval,max_interval) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        user,
        data.name,
        data.simulation,
        data.minInterval,
        data.maxInterval,
      ],
    );
    for (const c of eligible) {
      const t = chooseTemplate(
          templates as (Row & { content: string; enabled: boolean })[],
        ),
        content = renderTemplate(t.content, c as any);
      await tx.query(
        "INSERT INTO campaign_contacts(id,user_id,campaign_id,contact_id) VALUES($1,$2,$3,$4)",
        [randomUUID(), user, id, c.id],
      );
      await tx.query(
        "INSERT INTO message_jobs(id,user_id,campaign_id,contact_id,template_id,template_slot,content,simulation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [randomUUID(), user, id, c.id, t.id, t.slot, content, data.simulation],
      );
    }
    await audit(tx, user, "campaign.created", id, {
      simulation: data.simulation,
      total: eligible.length,
    });
    return { id, total: eligible.length };
  });
}
export async function campaignAction(
  db: DB,
  user: string,
  id: string,
  action: string,
) {
  return db.transaction(async (tx) => {
    const c = (
      await tx.query(
        "SELECT * FROM campaigns WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [id, user],
      )
    ).rows[0];
    assert(c, "Campanha não encontrada.", 404);
    const transitions: Record<string, string[]> = {
      start: ["draft"],
      resume: ["paused"],
      pause: ["running"],
      cancel: ["draft", "running", "paused"],
    };
    assert(
      transitions[action]?.includes(c.status),
      "Ação não permitida no estado atual.",
    );
    if (action === "start" || action === "resume") {
      if (!c.simulation) {
        const inst = (
          await tx.query(
            "SELECT status FROM whatsapp_instances WHERE user_id=$1",
            [user],
          )
        ).rows[0];
        assert(inst?.status === "open", "Conecte o WhatsApp antes de iniciar.");
        assert(
          process.env.REAL_SEND_ENABLED === "true" &&
            process.env.SIMULATION_MODE === "false",
          "Envios reais desabilitados.",
        );
      }
      assert(
        !(
          await tx.query(
            "SELECT id FROM message_jobs WHERE campaign_id=$1 AND state IN ('unknown','sending')",
            [id],
          )
        ).rows.length,
        "Há envios com resultado desconhecido. Reconcilie antes de continuar.",
      );
    }
    const status =
      action === "pause"
        ? "paused"
        : action === "cancel"
          ? "cancelled"
          : "running";
    await tx.query(
      "UPDATE campaigns SET status=$1,pause_reason=NULL,updated_at=now() WHERE id=$2",
      [status, id],
    );
    if (action === "cancel")
      await tx.query(
        "UPDATE message_jobs SET state='cancelled',processed_at=now() WHERE campaign_id=$1 AND state='pending'",
        [id],
      );
    await audit(tx, user, "campaign." + action, id);
    return { status };
  });
}
export async function suppress(
  db: DB,
  user: string,
  phone: string,
  reason: string,
) {
  await db.query(
    "INSERT INTO contact_suppressions(id,user_id,phone,reason) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,phone) DO NOTHING",
    [randomUUID(), user, phone, reason],
  );
  await db.query(
    "UPDATE message_jobs SET state='skipped',error='Contato descadastrado',processed_at=now() WHERE user_id=$1 AND state='pending' AND contact_id IN(SELECT id FROM contacts WHERE user_id=$1 AND phone=$2)",
    [user, phone],
  );
  await audit(db, user, "contact.suppressed", undefined, { phone, reason });
}
export async function overview(db: DB, user: string) {
  const [
    contacts,
    campaigns,
    jobs,
    templates,
    instance,
    imports,
    suppressions,
  ] = await Promise.all([
    db.query(
      `SELECT ct.*,(SELECT granted AND (expires_at IS NULL OR expires_at>now()) FROM contact_consents WHERE contact_id=ct.id ORDER BY recorded_at DESC,id DESC LIMIT 1) AS consent,
 EXISTS(SELECT 1 FROM contact_suppressions s WHERE s.user_id=ct.user_id AND s.phone=ct.phone) AS suppressed FROM contacts ct WHERE ct.user_id=$1 ORDER BY ct.created_at DESC LIMIT 1000`,
      [user],
    ),
    db.query(
      "SELECT cs.*,c.min_interval,c.max_interval,c.pause_reason,c.created_at FROM campaign_statistics cs JOIN campaigns c ON c.id=cs.campaign_id WHERE cs.user_id=$1 ORDER BY c.created_at DESC LIMIT 200",
      [user],
    ),
    db.query(
      "SELECT j.*,ct.name,ct.phone,c.name AS campaign_name,(SELECT content FROM customer_replies r WHERE r.job_id=j.id ORDER BY received_at DESC LIMIT 1) AS reply FROM message_jobs j JOIN contacts ct ON ct.id=j.contact_id JOIN campaigns c ON c.id=j.campaign_id WHERE j.user_id=$1 ORDER BY j.created_at DESC LIMIT 1000",
      [user],
    ),
    db.query("SELECT * FROM message_templates WHERE user_id=$1 ORDER BY slot", [
      user,
    ]),
    db.query("SELECT * FROM whatsapp_instances WHERE user_id=$1", [user]),
    db.query(
      "SELECT * FROM imports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30",
      [user],
    ),
    db.query(
      "SELECT * FROM contact_suppressions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
      [user],
    ),
  ]);
  const counts = (
    await db.query(
      `SELECT (SELECT count(*)::integer FROM contacts WHERE user_id=$1) AS contacts,
 count(*) FILTER(WHERE NOT simulation AND state IN ('sent','delivered','read','replied'))::integer AS sent,
 count(*) FILTER(WHERE NOT simulation AND state IN ('delivered','read','replied'))::integer AS delivered,
 count(*) FILTER(WHERE NOT simulation AND state='replied')::integer AS replied,
 count(*) FILTER(WHERE NOT simulation AND state='failed')::integer AS failed,
 count(*) FILTER(WHERE simulation AND state='simulated')::integer AS simulated,
 count(DISTINCT contact_id) FILTER(WHERE NOT simulation AND state IN ('sent','delivered','read','replied') AND EXISTS(SELECT 1 FROM contacts ct WHERE ct.id=contact_id AND ct.purchased_at>message_jobs.processed_at AND ct.purchase_source IS NOT NULL))::integer AS recovered FROM message_jobs WHERE user_id=$1`,
      [user],
    )
  ).rows[0];
  const activity = (
    await db.query(
      "SELECT (processed_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS day,count(*)::integer AS sent FROM message_jobs WHERE user_id=$1 AND NOT simulation AND state IN ('sent','delivered','read','replied') AND processed_at>=now()-interval '8 days' GROUP BY 1 ORDER BY 1",
      [user],
    )
  ).rows;
  const templateStats = (
    await db.query(
      "SELECT template_slot,count(*)::integer AS total,count(*) FILTER(WHERE NOT simulation AND state IN ('sent','delivered','read','replied'))::integer AS sent,count(*) FILTER(WHERE NOT simulation AND state IN ('delivered','read','replied'))::integer AS delivered,count(*) FILTER(WHERE NOT simulation AND state='replied')::integer AS replied,count(*) FILTER(WHERE NOT simulation AND state='failed')::integer AS failed,count(*) FILTER(WHERE state='simulated')::integer AS simulated FROM message_jobs WHERE user_id=$1 GROUP BY template_slot",
      [user],
    )
  ).rows;
  return {
    activity,
    templateStats,
    contacts: contacts.rows,
    campaigns: campaigns.rows,
    jobs: jobs.rows,
    templates: templates.rows,
    instance: instance.rows[0],
    imports: imports.rows,
    suppressions: suppressions.rows,
    counts,
    realSendEnabled:
      process.env.REAL_SEND_ENABLED === "true" &&
      process.env.SIMULATION_MODE === "false",
  };
}
