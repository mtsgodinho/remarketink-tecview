import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/lib/auth";
try {
  await fs.access(".env.local");
  console.log(".env.local existente preservado.");
  process.exit(0);
} catch {}
await fs.mkdir(".data", { recursive: true });
const password = randomBytes(18).toString("base64url");
await fs.writeFile(
  ".env.local",
  `DATABASE_MODE=local\nAUTH_MODE=local\nLOCAL_ADMIN_EMAIL=admin@techview.local\nLOCAL_PASSWORD_HASH=${hashPassword(password)}\nSESSION_SECRET=${randomBytes(48).toString("hex")}\nLOCAL_INLINE_WORKER=true\nAPP_URL=http://localhost:3000\nSIMULATION_MODE=true\nREAL_SEND_ENABLED=false\n`,
  { mode: 0o600, flag: "wx" },
);
await fs.writeFile(
  ".data/local-access.txt",
  `Acesso SOMENTE ao desenvolvimento local.\nE-mail: admin@techview.local\nSenha: ${password}\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Modo local configurado. Credenciais em .data/local-access.txt (não versionado).",
);
