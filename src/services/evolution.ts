import { AppError, assert } from "@/lib/errors";
export class ProviderError extends Error {
  constructor(
    message: string,
    public disposition: "rejected" | "unknown" | "disconnected",
    public status = 0,
  ) {
    super(message);
  }
}
export class Evolution {
  constructor(private instance: string) {}
  private async request(path: string, method = "GET", body?: unknown) {
    assert(
      process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY,
      "Configure EVOLUTION_API_URL e EVOLUTION_API_KEY no servidor.",
      503,
    );
    const base = new URL(process.env.EVOLUTION_API_URL);
    assert(
      base.protocol === "https:" ||
        (process.env.NODE_ENV !== "production" &&
          ["localhost", "127.0.0.1"].includes(base.hostname)),
      "Evolution API deve usar HTTPS.",
    );
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method,
        headers: {
          apikey: process.env.EVOLUTION_API_KEY,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      throw new ProviderError(
        "Evolution API indisponível ou timeout. Resultado não confirmado.",
        "unknown",
      );
    }
    if (!response.ok) {
      const kind =
        response.status === 429
          ? "rejected"
          : [401, 403, 404].includes(response.status)
            ? "disconnected"
            : response.status >= 500
              ? "unknown"
              : "rejected";
      throw new ProviderError(
        `Evolution API retornou HTTP ${response.status}.`,
        kind,
        response.status,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new ProviderError("Resposta inválida da Evolution API.", "unknown");
    }
  }
  private get encoded() {
    return encodeURIComponent(this.instance);
  }
  async status() {
    return this.request(`/instance/connectionState/${this.encoded}`);
  }
  async connect() {
    try {
      await this.status();
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) {
        await this.request("/instance/create", "POST", {
          instanceName: this.instance,
          integration: "WHATSAPP-BAILEYS",
          qrcode: true,
        });
      } else throw e;
    }
    assert(
      process.env.APP_URL?.startsWith("https://") &&
        process.env.EVOLUTION_WEBHOOK_SECRET,
      "Configure APP_URL HTTPS e EVOLUTION_WEBHOOK_SECRET antes de conectar.",
      503,
    );
    await this.request(`/webhook/set/${this.encoded}`, "POST", {
      webhook: {
        enabled: true,
        url: new URL("/api/webhooks/evolution", process.env.APP_URL).href,
        webhookByEvents: false,
        webhookBase64: false,
        headers: { "x-webhook-secret": process.env.EVOLUTION_WEBHOOK_SECRET },
        events: [
          "CONNECTION_UPDATE",
          "QRCODE_UPDATED",
          "MESSAGES_UPSERT",
          "MESSAGES_UPDATE",
          "SEND_MESSAGE",
        ],
      },
    });
    return this.request(`/instance/connect/${this.encoded}`);
  }
  async disconnect() {
    return this.request(`/instance/logout/${this.encoded}`, "DELETE");
  }
  async send(phone: string, text: string) {
    return this.request(`/message/sendText/${this.encoded}`, "POST", {
      number: phone,
      text,
    });
  }
  async findMessage(providerId: string) {
    return this.request(`/chat/findMessages/${this.encoded}`, "POST", {
      where: { key: { id: providerId } },
    });
  }
  async profile() {
    const r = await this.request(
      `/instance/fetchInstances?instanceName=${this.encoded}`,
    );
    const item = Array.isArray(r)
      ? r.find((x) => (x.name || x.instance?.instanceName) === this.instance)
      : undefined;
    return {
      phone:
        String(item?.ownerJid || item?.instance?.owner || "").split("@")[0] ||
        null,
    };
  }
}
