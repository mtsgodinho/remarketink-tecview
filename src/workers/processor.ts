import type { DB } from "@/lib/db";
import type { Row } from "@/types";
import { Evolution, ProviderError } from "@/services/evolution";
import { eligibleSQL } from "@/repositories/store";
import { replayProviderEvents } from "@/services/webhooks";
import { randomInterval } from "@/features/rules";
export interface Provider {
  status(): Promise<any>;
  send(phone: string, text: string): Promise<any>;
}
export async function recoverStale(db: DB) {
  await db.transaction(async (tx) => {
    const stale = await tx.query(
      "UPDATE message_jobs SET state='unknown',error='Worker interrompido após iniciar envio. Reconciliação obrigatória.' WHERE state='sending' AND processing_at<now()-interval '90 seconds' RETURNING campaign_id",
    );
    for (const row of stale.rows)
      await tx.query(
        "UPDATE campaigns SET status='paused',pause_reason='Envio com resultado desconhecido',updated_at=now() WHERE id=$1 AND status='running'",
        [row.campaign_id],
      );
  });
}
function allowedHour(settings: Row, now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: settings.timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  return hour >= settings.startHour && hour < settings.endHour;
}
export async function tick(
  db: DB,
  providerFactory: (name: string) => Provider = (name) => new Evolution(name),
) {
  await recoverStale(db);
  const claimed = await db.transaction(async (tx) => {
    const instance = (
      await tx.query(`SELECT w.* FROM whatsapp_instances w WHERE (w.locked_until IS NULL OR w.locked_until<now()) AND w.next_send_at<=now()
   AND EXISTS(SELECT 1 FROM campaigns c JOIN message_jobs j ON j.campaign_id=c.id WHERE c.user_id=w.user_id AND c.status='running' AND j.state='pending' AND j.next_run_at<=now()) ORDER BY w.next_send_at LIMIT 1 FOR UPDATE SKIP LOCKED`)
    ).rows[0];
    if (!instance) return null;
    const job = (
      await tx.query(
        `SELECT j.*,c.min_interval,c.max_interval,ct.phone FROM message_jobs j JOIN campaigns c ON c.id=j.campaign_id JOIN contacts ct ON ct.id=j.contact_id
   WHERE j.user_id=$1 AND j.state='pending' AND j.next_run_at<=now() AND c.status='running' ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j,c`,
        [instance.user_id],
      )
    ).rows[0];
    if (!job) return null;
    const eligible = (
      await tx.query(eligibleSQL + " AND ct.id=$2", [
        instance.user_id,
        job.contact_id,
      ])
    ).rows.length;
    if (!eligible) {
      await tx.query(
        "UPDATE message_jobs SET state='skipped',error='Contato sem elegibilidade atual',processed_at=now() WHERE id=$1",
        [job.id],
      );
      return null;
    }
    const settings = instance.settings;
    if (!job.simulation) {
      if (
        process.env.REAL_SEND_ENABLED !== "true" ||
        process.env.SIMULATION_MODE !== "false" ||
        instance.status !== "open"
      ) {
        await tx.query(
          "UPDATE campaigns SET status='paused',pause_reason='Envio real desabilitado ou WhatsApp desconectado' WHERE id=$1",
          [job.campaign_id],
        );
        return null;
      }
      if (!allowedHour(settings)) {
        await tx.query(
          "UPDATE whatsapp_instances SET next_send_at=now()+interval '1 minute' WHERE id=$1",
          [instance.id],
        );
        return null;
      }
      const limits = (
        await tx.query(
          `SELECT count(*) FILTER(WHERE processing_at>now()-interval '1 hour')::integer AS hourly,
    count(*) FILTER(WHERE processing_at>now()-interval '24 hours')::integer AS daily,
    count(*) FILTER(WHERE contact_id=$2 AND processing_at>now()-make_interval(days => $3))::integer AS recent
    FROM message_jobs WHERE user_id=$1 AND NOT simulation AND state IN ('sending','requested','sent','delivered','read','replied','unknown')`,
          [job.user_id, job.contact_id, settings.frequencyDays],
        )
      ).rows[0];
      if (limits.recent) {
        await tx.query(
          "UPDATE message_jobs SET state='skipped',error='Limite de frequência por contato',processed_at=now() WHERE id=$1",
          [job.id],
        );
        return null;
      }
      if (
        limits.hourly >= settings.hourlyLimit ||
        limits.daily >= settings.dailyLimit
      ) {
        await tx.query(
          "UPDATE whatsapp_instances SET next_send_at=now()+interval '1 minute' WHERE id=$1",
          [instance.id],
        );
        return null;
      }
    }
    const delay = randomInterval(job.min_interval, job.max_interval);
    await tx.query(
      "UPDATE whatsapp_instances SET locked_until=now()+interval '90 seconds',next_send_at=now()+make_interval(secs => $2) WHERE id=$1",
      [instance.id, delay + 90],
    );
    await tx.query(
      "UPDATE message_jobs SET state='sending',attempts=attempts+1,processing_at=now() WHERE id=$1",
      [job.id],
    );
    return { job, instance, delay };
  });
  if (!claimed) {
    await completeCampaigns(db);
    return false;
  }
  const { job, instance, delay } = claimed;
  let sideEffectStarted = false;
  try {
    if (job.simulation) {
      await db.query(
        "UPDATE message_jobs SET state='simulated',processed_at=now(),error=NULL WHERE id=$1",
        [job.id],
      );
    } else {
      const provider = providerFactory(instance.name);
      const status = await provider.status();
      if (status?.instance?.state !== "open") {
        await db.query(
          "UPDATE message_jobs SET state='pending',attempts=attempts-1,processing_at=NULL WHERE id=$1",
          [job.id],
        );
        await db.query(
          "UPDATE whatsapp_instances SET status='disconnected' WHERE id=$1",
          [instance.id],
        );
        await db.query(
          "UPDATE campaigns SET status='paused',pause_reason='WhatsApp desconectado' WHERE user_id=$1 AND status='running' AND NOT simulation",
          [job.user_id],
        );
        return true;
      }
      // Re-check controls immediately before side effect. An already accepted send cannot be recalled.
      const control = (
        await db.query("SELECT status FROM campaigns WHERE id=$1", [
          job.campaign_id,
        ])
      ).rows[0];
      const stillEligible = (
        await db.query(eligibleSQL + " AND ct.id=$2", [
          job.user_id,
          job.contact_id,
        ])
      ).rows.length;
      if (control.status !== "running" || !stillEligible) {
        await db.query(
          "UPDATE message_jobs SET state=$1,processing_at=NULL,attempts=attempts-1 WHERE id=$2",
          [
            control.status === "cancelled"
              ? "cancelled"
              : !stillEligible
                ? "skipped"
                : "pending",
            job.id,
          ],
        );
        return true;
      }
      sideEffectStarted = true;
      const result = await provider.send(job.phone, job.content);
      const providerId = result?.key?.id;
      if (typeof providerId !== "string")
        throw new ProviderError(
          "Provedor não retornou identificador do envio.",
          "unknown",
        );
      await db.transaction(async (tx) => {
        await tx.query(
          "UPDATE message_jobs SET state=CASE WHEN state IN ('replied','read','delivered','sent') THEN state ELSE 'requested' END,provider_id=$1,processed_at=now(),error=NULL WHERE id=$2",
          [providerId, job.id],
        );
        await replayProviderEvents(tx, job.user_id, providerId);
      });
    }
  } catch (error) {
    if (!sideEffectStarted && !job.simulation) {
      await db.transaction(async (tx) => {
        await tx.query(
          "UPDATE message_jobs SET state='pending',attempts=attempts-1,processing_at=NULL,error='Falha ao verificar conexão; nenhum envio iniciado' WHERE id=$1",
          [job.id],
        );
        await tx.query(
          "UPDATE campaigns SET status='paused',pause_reason='Não foi possível verificar a conexão WhatsApp' WHERE user_id=$1 AND status='running' AND NOT simulation",
          [job.user_id],
        );
      });
      return true;
    }
    const e =
      error instanceof ProviderError
        ? error
        : new ProviderError(
            "Falha inesperada no processamento; confirme o estado no provedor.",
            "unknown",
          );
    const attempts = Number(job.attempts) + 1;
    const retry =
      e.disposition === "rejected" &&
      e.status === 429 &&
      attempts < instance.settings.maxAttempts;
    const state = retry
      ? "pending"
      : e.disposition === "rejected"
        ? "failed"
        : "unknown";
    await db.query(
      "UPDATE message_jobs SET state=$1,error=$2,next_run_at=now()+make_interval(secs => $3),processed_at=CASE WHEN $1='pending' THEN NULL ELSE now() END WHERE id=$4",
      [state, e.message, Math.min(3600, 30 * 2 ** attempts), job.id],
    );
    if (state === "unknown" || e.disposition === "disconnected")
      await db.query(
        "UPDATE campaigns SET status='paused',pause_reason=$1 WHERE id=$2 AND status='running'",
        [e.message, job.campaign_id],
      );
  } finally {
    const seconds = delay;
    await db.query(
      "UPDATE whatsapp_instances SET locked_until=NULL,next_send_at=now()+make_interval(secs => $1) WHERE id=$2",
      [seconds, instance.id],
    );
  }
  await completeCampaigns(db);
  return true;
}
export async function completeCampaigns(db: DB) {
  await db.query(
    "UPDATE campaigns c SET status='completed',updated_at=now() WHERE status='running' AND NOT EXISTS(SELECT 1 FROM message_jobs j WHERE j.campaign_id=c.id AND j.state IN ('pending','sending','unknown'))",
  );
}
