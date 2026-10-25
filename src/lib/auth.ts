import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { User } from "@/types";
import { AppError } from "./errors";
const LOCAL_ID = "00000000-0000-4000-8000-000000000001";
export const cookieName = "techview_session";
function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY)
    throw new AppError("Configure SUPABASE_URL e SUPABASE_ANON_KEY.", 503);
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function checkPassword(password: string, hash: string) {
  const [salt, digest] = hash.split(":");
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, "hex"),
    actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function signature(s: string) {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)
    throw new AppError(
      "SESSION_SECRET deve ter pelo menos 32 caracteres.",
      503,
    );
  return createHmac("sha256", process.env.SESSION_SECRET)
    .update(s)
    .digest("hex");
}
export async function login(email: string, password: string) {
  if (process.env.AUTH_MODE === "local") {
    if (process.env.NODE_ENV === "production")
      throw new AppError("Login local indisponível em produção.", 403);
    if (
      email !== process.env.LOCAL_ADMIN_EMAIL ||
      !checkPassword(password, process.env.LOCAL_PASSWORD_HASH || "")
    )
      throw new AppError("E-mail ou senha incorretos.", 401);
    const payload = Buffer.from(
      JSON.stringify({ id: LOCAL_ID, email, exp: Date.now() + 8 * 3600000 }),
    ).toString("base64url");
    return {
      token: payload + "." + signature(payload),
      user: { id: LOCAL_ID, email },
    };
  }
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.APP_URL?.startsWith("https://")
  )
    throw new AppError("APP_URL HTTPS é obrigatória em produção.", 503);
  const { data, error } = await supabase().auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session)
    throw new AppError("E-mail ou senha incorretos.", 401);
  return {
    token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email! },
  };
}
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(cookieName)?.value;
  if (!token) return null;
  if (process.env.AUTH_MODE === "local") {
    if (process.env.NODE_ENV === "production") return null;
    try {
      const [p, s] = token.split(".");
      const expected = Buffer.from(signature(p));
      const actual = Buffer.from(s || "");
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        return null;
      const u = JSON.parse(Buffer.from(p, "base64url").toString());
      return u.exp > Date.now() && u.id === LOCAL_ID
        ? { id: u.id, email: u.email }
        : null;
    } catch {
      return null;
    }
  }
  const { data, error } = await supabase().auth.getUser(token);
  return error || !data.user
    ? null
    : { id: data.user.id, email: data.user.email! };
}
