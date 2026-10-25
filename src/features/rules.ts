import { randomInt } from "node:crypto";
import { z } from "zod";
import { AppError } from "@/lib/errors";
export const intervalSchema = z
  .object({
    minInterval: z.number().int().min(1).max(3600),
    maxInterval: z.number().int().min(1).max(3600),
  })
  .refine(
    (v) => v.maxInterval >= v.minInterval,
    "O máximo deve ser maior ou igual ao mínimo.",
  );
export const settingsSchema = z
  .object({
    minInterval: z.number().int().min(1).max(3600),
    maxInterval: z.number().int().min(1).max(3600),
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(1).max(24),
    hourlyLimit: z.number().int().min(1).max(300),
    dailyLimit: z.number().int().min(1).max(1000),
    frequencyDays: z.number().int().min(1).max(365),
    maxAttempts: z.number().int().min(1).max(5),
    timezone: z.literal("America/Sao_Paulo"),
  })
  .refine(
    (v) => v.maxInterval >= v.minInterval && v.endHour > v.startHour,
    "Verifique os intervalos e horários.",
  );
export const campaignSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    minInterval: z.number().int().min(1).max(3600),
    maxInterval: z.number().int().min(1).max(3600),
    simulation: z.boolean(),
    contactIds: z
      .array(z.uuid())
      .min(1, "Selecione pelo menos um contato para a campanha.")
      .max(10000),
  })
  .refine((v) => v.maxInterval >= v.minInterval, "Intervalo inválido.");
const DDD = new Set(
  "11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99".split(
    " ",
  ),
);
export function normalizePhone(input: unknown): string {
  const s = String(input ?? "").trim();
  if (!/^[+\d\s().-]+$/.test(s))
    throw new AppError("Telefone contém caracteres inválidos.");
  let p = s.replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  if (!/^55\d{10,11}$/.test(p) || !DDD.has(p.slice(2, 4)))
    throw new AppError(
      "Informe DDI 55, DDD válido e número com 8 ou 9 dígitos.",
    );
  const local = p.slice(4);
  if (
    (local.length === 9 && !/^9\d{8}$/.test(local)) ||
    (local.length === 8 && !/^[2-5]\d{7}$/.test(local))
  )
    throw new AppError(
      "Número inválido ou ambíguo; confirme o telefone de origem.",
    );
  return p;
}
export function validateTemplate(text: string) {
  if (text.length > 4000)
    throw new AppError("Mensagem deve ter até 4.000 caracteres.");
  const invalid = [...text.matchAll(/{{\s*([^{}]+)\s*}}/g)]
    .map((m) => m[1])
    .filter((v) => !["nome", "produto", "link"].includes(v));
  if (
    invalid.length ||
    text.replace(/{{(nome|produto|link)}}/g, "").includes("{{") ||
    text.replace(/{{(nome|produto|link)}}/g, "").includes("}}")
  )
    throw new AppError("Use apenas {{nome}}, {{produto}} e {{link}}.");
  return text;
}
export function renderTemplate(
  text: string,
  contact: { name: string; product: string; cart_url: string },
) {
  validateTemplate(text);
  return text.replace(/{{(nome|produto|link)}}/g, (_, v: string) => {
    const value = (
      {
        nome: contact.name,
        produto: contact.product,
        link: contact.cart_url,
      } as Record<string, string>
    )[v];
    if (!value?.trim()) throw new AppError(`Contato sem valor para {{${v}}}.`);
    return value;
  });
}
export function chooseTemplate<T extends { content: string; enabled: boolean }>(
  items: T[],
): T {
  const enabled = items.filter((t) => t.enabled && t.content.trim());
  if (!enabled.length)
    throw new AppError("Escreva pelo menos uma mensagem habilitada.");
  return enabled[randomInt(enabled.length)];
}
export const randomInterval = (min: number, max: number) => {
  intervalSchema.parse({ minInterval: min, maxInterval: max });
  return randomInt(min, max + 1);
};
export const isOptOut = (text: string) =>
  /^(sair|parar|pare|stop|cancelar|remover|descadastrar|não quero|nao quero)(\b|[.!])/i.test(
    text.trim(),
  );
export const csvSafe = (value: unknown) => {
  const s = String(value ?? "");
  return (
    '"' + (/^[\s]*[=+@-]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"'
  );
};
export function csv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "\ufeffNenhum registro\r\n";
  const keys = Object.keys(rows[0]);
  return (
    "\ufeff" +
    [
      keys.map(csvSafe).join(";"),
      ...rows.map((r) => keys.map((k) => csvSafe(r[k])).join(";")),
    ].join("\r\n")
  );
}
