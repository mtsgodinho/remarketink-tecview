import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { getDB } from "@/lib/db";
import { AppError, assert } from "@/lib/errors";
import { login, currentUser, cookieName } from "@/lib/auth";
import {
  ensureUser,
  overview,
  createCampaign,
  campaignAction,
  suppress,
  audit,
} from "@/repositories/store";
import { parseFile, importRows, mappingSchema } from "@/features/imports";
import {
  csv,
  settingsSchema,
  validateTemplate,
  normalizePhone,
} from "@/features/rules";
import { Evolution } from "@/services/evolution";
import { handleWebhook, providerState } from "@/services/webhooks";
import { ensureInlineWorker } from "@/lib/inline-worker";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function bodyBytes(req: NextRequest, limit: number) {
  const reader = req.body?.getReader();
  assert(reader, "Corpo obrigatório.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new AppError("Requisição excede o limite de tamanho.", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function json(req: NextRequest) {
  try {
    return JSON.parse((await bodyBytes(req, 64000)).toString());
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("JSON inválido.");
  }
}
async function upload(req: NextRequest) {
  const data = await bodyBytes(req, 6 * 1024 * 1024);
  return new Request("http://upload.local", {
    method: "POST",
    headers: { "content-type": req.headers.get("content-type") || "" },
    body: data,
  }).formData();
}
const loginLimits = new Map<string, { count: number; at: number }>();
async function handler(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const parts = (await context.params).path,
      path = parts.join("/"),
      method = req.method;
    if (!["GET", "HEAD"].includes(method) && !path.startsWith("webhooks/")) {
      const origin = req.headers.get("origin");
      const expected = process.env.APP_URL || req.nextUrl.origin;
      assert(
        origin === new URL(expected).origin,
        "Origem da requisição não autorizada.",
        403,
      );
    }
    if (path === "auth/login" && method === "POST") {
      const data = z
        .object({
          email: z.email().max(254),
          password: z.string().min(1).max(200),
        })
        .parse(await json(req));
      const key = data.email.toLowerCase();
      let rate = loginLimits.get(key);
      if (!rate || Date.now() - rate.at > 900000)
        rate = { count: 0, at: Date.now() };
      assert(rate.count < 10, "Muitas tentativas. Aguarde 15 minutos.", 429);
      rate.count++;
      loginLimits.set(key, rate);
      if (loginLimits.size > 10000)
        loginLimits.delete(loginLimits.keys().next().value!);
      const result = await login(data.email, data.password);
      const db = await getDB();
      await ensureUser(db, result.user);
      (await cookies()).set(cookieName, result.token, {
        httpOnly: true,
        secure:
          new URL(process.env.APP_URL || req.nextUrl.origin).protocol ===
          "https:",
        sameSite: "strict",
        path: "/",
        maxAge: process.env.AUTH_MODE === "local" ? 28800 : 3600,
      });
      return NextResponse.json({ user: result.user });
    }
    if (path === "auth/logout" && method === "POST") {
      (await cookies()).delete(cookieName);
      return NextResponse.json({ ok: true });
    }
    if (path === "webhooks/evolution" && method === "POST") {
      const actual = Buffer.from(req.headers.get("x-webhook-secret") || ""),
        expected = Buffer.from(process.env.EVOLUTION_WEBHOOK_SECRET || "");
      assert(
        expected.length >= 32 &&
          actual.length === expected.length &&
          timingSafeEqual(actual, expected),
        "Webhook não autorizado.",
        401,
      );
      const result = await handleWebhook(await getDB(), await json(req));
      return NextResponse.json(result);
    }
    const user = await currentUser();
    assert(user, "Sessão expirada. Entre novamente.", 401);
    const db = await getDB();
    await ensureUser(db, user);
    ensureInlineWorker();
    if (path === "overview" && method === "GET")
      return NextResponse.json({ ...(await overview(db, user.id)), user });
    if (path === "templates" && method === "PUT") {
      const templates = z
        .array(
          z.object({
            slot: z.number().int().min(1).max(4),
            content: z.string().max(4000),
            enabled: z.boolean(),
          }),
        )
        .length(4)
        .parse(await json(req));
      assert(
        new Set(templates.map((t) => t.slot)).size === 4,
        "Informe as quatro mensagens.",
      );
      templates.forEach((t) => validateTemplate(t.content));
      await db.transaction(async (tx) => {
        for (const t of templates)
          await tx.query(
            "UPDATE message_templates SET content=$1,enabled=$2,updated_at=now() WHERE user_id=$3 AND slot=$4",
            [t.content, t.enabled, user.id, t.slot],
          );
        await audit(tx, user.id, "templates.updated");
      });
      return NextResponse.json({ ok: true });
    }
    if (path === "settings" && method === "PUT") {
      const settings = settingsSchema.parse(await json(req));
      await db.query(
        "UPDATE whatsapp_instances SET settings=$1,updated_at=now() WHERE user_id=$2",
        [JSON.stringify(settings), user.id],
      );
      await audit(db, user.id, "settings.updated");
      return NextResponse.json({ ok: true });
    }
    if (path === "imports" && method === "POST") {
      const form = await upload(req);
      const file = form.get("file");
      assert(file instanceof File, "Selecione uma planilha.");
      const data = await parseFile(
        Buffer.from(await file.arrayBuffer()),
        file.name,
      );
      if (form.get("mode") === "preview")
        return NextResponse.json({
          headers: data.headers,
          rows: data.rows.slice(0, 8),
          total: data.rows.length,
        });
      const mapping = mappingSchema.parse(
        JSON.parse(String(form.get("mapping") || "{}")),
      );
      assert(
        Object.values(mapping)
          .filter(Boolean)
          .every((h) => data.headers.includes(h!)),
        "Mapeamento contém coluna inexistente.",
      );
      const result = await importRows(
        db,
        user.id,
        file.name,
        data.rows,
        mapping,
      );
      await audit(db, user.id, "import.completed", result.id, {
        imported: result.imported,
      });
      return NextResponse.json(result);
    }
    if (path === "imports/template" && method === "GET")
      return download(
        csv([
          {
            Nome: "",
            Telefone: "",
            Status: "",
            Produto: "",
            Link: "",
            DataAbandono: "",
            Pedido: "",
          },
        ]),
        "modelo-maria.csv",
      );
    if (parts[0] === "imports" && parts[2] === "errors" && method === "GET") {
      z.uuid().parse(parts[1]);
      const rows = (
        await db.query(
          "SELECT row_number AS linha,status,error AS erro FROM import_rows WHERE import_id=$1 AND user_id=$2 AND error IS NOT NULL ORDER BY row_number",
          [parts[1], user.id],
        )
      ).rows;
      return download(csv(rows), "erros-importacao.csv");
    }
    if (path === "campaigns" && method === "POST")
      return NextResponse.json(
        await createCampaign(db, user.id, await json(req)),
        { status: 201 },
      );
    if (parts[0] === "campaigns" && parts.length === 3 && method === "POST") {
      z.uuid().parse(parts[1]);
      return NextResponse.json(
        await campaignAction(db, user.id, parts[1], parts[2]),
      );
    }
    if (path === "contacts/suppress" && method === "POST") {
      const d = z
        .object({ phone: z.string(), reason: z.string().min(3).max(500) })
        .parse(await json(req));
      const phone = normalizePhone(d.phone);
      await db.transaction((tx) => suppress(tx, user.id, phone, d.reason));
      return NextResponse.json({ ok: true });
    }
    if (
      parts[0] === "contacts" &&
      parts[2] === "purchase" &&
      method === "POST"
    ) {
      z.uuid().parse(parts[1]);
      const d = z
        .object({
          source: z.string().trim().min(5).max(300),
          purchasedAt: z.iso.datetime({ offset: true }),
        })
        .parse(await json(req));
      assert(
        Date.parse(d.purchasedAt) <= Date.now(),
        "A compra não pode estar no futuro.",
      );
      await db.transaction(async (tx) => {
        const r = await tx.query(
          "UPDATE contacts SET purchased_at=$1,purchase_source=$2,updated_at=now() WHERE id=$3 AND user_id=$4 RETURNING id",
          [d.purchasedAt, d.source, parts[1], user.id],
        );
        assert(r.rows.length, "Contato não encontrado.", 404);
        await tx.query(
          "UPDATE message_jobs SET state='skipped',error='Compra confirmada',processed_at=now() WHERE contact_id=$1 AND user_id=$2 AND state='pending'",
          [parts[1], user.id],
        );
        await audit(tx, user.id, "purchase.confirmed", parts[1], d);
      });
      return NextResponse.json({ ok: true });
    }
    if (path === "whatsapp/config" && method === "GET")
      return NextResponse.json({
        url: process.env.EVOLUTION_API_URL || "",
        configured: !!process.env.EVOLUTION_API_KEY,
        webhookConfigured:
          !!process.env.EVOLUTION_WEBHOOK_SECRET &&
          process.env.APP_URL?.startsWith("https://"),
      });
    if (parts[0] === "whatsapp" && method === "POST") {
      const instance = (
        await db.query("SELECT * FROM whatsapp_instances WHERE user_id=$1", [
          user.id,
        ])
      ).rows[0];
      const provider = new Evolution(instance.name);
      if (parts[1] === "connect") {
        const data = await provider.connect();
        const qr = data.base64 || data.qrcode?.base64;
        assert(
          typeof qr === "string" &&
            qr.length < 200000 &&
            /^(data:image\/png;base64,)?[A-Za-z0-9+/=]+$/.test(qr),
          "QR Code indisponível. Verifique o status e tente novamente.",
          502,
        );
        await audit(db, user.id, "whatsapp.connect", instance.id);
        return NextResponse.json({
          qr: qr.startsWith("data:") ? qr : "data:image/png;base64," + qr,
          expiresAt: Date.now() + 45000,
        });
      }
      if (parts[1] === "status") {
        const data = await provider.status();
        const state =
          data?.instance?.state === "open" ? "open" : "disconnected";
        let phone: null | string = null;
        if (state === "open") {
          const p = await provider.profile();
          phone = p.phone;
        }
        await db.transaction(async (tx) => {
          await tx.query(
            "UPDATE whatsapp_instances SET status=$1,phone=COALESCE($3,phone),last_connected_at=CASE WHEN $1='open' AND status<>'open' THEN now() ELSE last_connected_at END,updated_at=now() WHERE id=$2",
            [state, instance.id, phone],
          );
          if (state !== "open")
            await tx.query(
              "UPDATE campaigns SET status='paused',pause_reason='WhatsApp desconectado' WHERE user_id=$1 AND status='running' AND NOT simulation",
              [user.id],
            );
        });
        return NextResponse.json({ status: state, phone });
      }
      if (parts[1] === "disconnect") {
        await provider.disconnect();
        await db.transaction(async (tx) => {
          await tx.query(
            "UPDATE whatsapp_instances SET status='disconnected' WHERE id=$1",
            [instance.id],
          );
          await tx.query(
            "UPDATE campaigns SET status='paused',pause_reason='Desconexão manual' WHERE user_id=$1 AND status='running' AND NOT simulation",
            [user.id],
          );
          await audit(tx, user.id, "whatsapp.disconnect", instance.id);
        });
        return NextResponse.json({ ok: true });
      }
    }
    if (parts[0] === "jobs" && parts[2] === "reconcile" && method === "POST") {
      z.uuid().parse(parts[1]);
      const { providerId } = z
        .object({ providerId: z.string().min(1).max(200) })
        .parse(await json(req));
      const job = (
        await db.query(
          "SELECT j.*,ct.phone,w.name AS instance_name FROM message_jobs j JOIN contacts ct ON ct.id=j.contact_id JOIN whatsapp_instances w ON w.user_id=j.user_id WHERE j.id=$1 AND j.user_id=$2",
          [parts[1], user.id],
        )
      ).rows[0];
      assert(
        job?.state === "unknown",
        "Somente envios desconhecidos podem ser reconciliados.",
      );
      const result = await new Evolution(job.instance_name).findMessage(
        providerId,
      );
      const records =
        result?.messages?.records || result?.messages || result?.records;
      assert(
        Array.isArray(records),
        "Resposta de reconciliação não reconhecida.",
        502,
      );
      const match = records.find(
        (r: any) =>
          r.key?.id === providerId &&
          r.key?.fromMe &&
          String(r.key?.remoteJid).split("@")[0] === job.phone &&
          (r.message?.conversation || r.message?.extendedTextMessage?.text) ===
            job.content &&
          Number(r.messageTimestamp) * 1000 >=
            new Date(job.processing_at).getTime() - 60000 &&
          Number(r.messageTimestamp) * 1000 <= Date.now() + 60000,
      );
      assert(
        match,
        "Mensagem não confirmada no provedor. O envio continuará bloqueado.",
      );
      await db.query(
        "UPDATE message_jobs SET provider_id=$1,state=$2,error=NULL,processed_at=COALESCE(processed_at,now()) WHERE id=$3 AND state='unknown'",
        [providerId, providerState(match.status) || "requested", job.id],
      );
      await audit(db, user.id, "job.reconciled", job.id, { providerId });
      return NextResponse.json({ ok: true });
    }
    if (path === "history/export" && method === "GET") {
      const params = req.nextUrl.searchParams;
      const state = params.get("state") || "",
        campaign = params.get("campaign") || "",
        slot = params.get("slot") || "",
        search = params.get("search") || "",
        date = params.get("date") || "";
      if (campaign) z.uuid().parse(campaign);
      if (slot) z.coerce.number().int().min(1).max(4).parse(slot);
      if (date) z.iso.date().parse(date);
      const rows = (
        await db.query(
          `SELECT ct.name AS nome,ct.phone AS telefone,c.name AS campanha,j.template_slot AS modelo,j.content AS mensagem,j.processed_at AS horario,j.state AS status,j.simulation AS simulacao,
  (SELECT content FROM customer_replies WHERE job_id=j.id ORDER BY received_at DESC LIMIT 1) AS resposta,j.error AS erro FROM message_jobs j JOIN contacts ct ON ct.id=j.contact_id JOIN campaigns c ON c.id=j.campaign_id WHERE j.user_id=$1
  AND ($2='' OR j.state=$2) AND ($3='' OR c.id::text=$3) AND ($4='' OR j.template_slot::text=$4) AND ($5='' OR ct.name ILIKE '%'||$5||'%' OR ct.phone LIKE '%'||$5||'%') AND ($6='' OR (COALESCE(j.processed_at,j.created_at) AT TIME ZONE 'America/Sao_Paulo')::date::text=$6) ORDER BY j.created_at DESC LIMIT 10000`,
          [user.id, state, campaign, slot, search, date],
        )
      ).rows;
      return download(csv(rows), "historico-techview.csv");
    }
    throw new AppError("Rota não encontrada.", 404);
  } catch (e) {
    if (e instanceof z.ZodError)
      return NextResponse.json(
        { error: e.issues.map((i) => i.message).join(" ") },
        { status: 400 },
      );
    if (e instanceof AppError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof Error && e.name === "ProviderError")
      return NextResponse.json({ error: e.message }, { status: 502 });
    console.error("api_error", {
      type: e instanceof Error ? e.name : "unknown",
      path: req.nextUrl.pathname,
    });
    return NextResponse.json(
      {
        error:
          "Não foi possível concluir a operação. Verifique a configuração do servidor e os logs.",
      },
      { status: 500 },
    );
  }
}
function download(text: string, name: string) {
  return new NextResponse(text, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
export { handler as GET, handler as POST, handler as PUT };
