"use client";
import { useState } from "react";
import { ArrowRight, ShieldCheck, MessageCircle, Loader2 } from "lucide-react";
export default function Login() {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login-shell">
      <div className="login-story">
        <div className="brand">
          <span className="brand-mark">
            tv<span>↗</span>
          </span>
          <span>
            TECHVIEW<small>REMARKETING</small>
          </span>
        </div>
        <div>
          <span className="eyebrow">MAIS CONVERSAS. NOVAS OPORTUNIDADES.</span>
          <h1>
            Uma conversa pode
            <br />
            mudar o final
            <br />
            <em>de uma compra.</em>
          </h1>
          <p>
            Organize seus contatos, personalize suas mensagens e acompanhe cada
            oportunidade de recuperação.
          </p>
          <div className="story-badge">
            <ShieldCheck size={18} /> Relacionamento, controle e
            rastreabilidade.
          </div>
        </div>
        <small>TECHVIEW · Plataforma de relacionamento</small>
      </div>
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const r = await fetch("/api/auth/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, password }),
            });
            const d = await r.json();
            if (!r.ok) throw Error(d.error);
            window.location.href = "/";
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="icon-tile">
          <MessageCircle />
        </span>
        <h2>Bem-vindo de volta</h2>
        <p>Entre para acessar seu painel de remarketing.</p>
        <label>
          E-mail
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="voce@empresa.com.br"
          />
        </label>
        <label>
          Senha
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Sua senha"
          />
        </label>
        {error && (
          <div role="alert" className="notice error">
            {error}
          </div>
        )}
        <button className="button primary" disabled={busy}>
          {busy ? (
            <Loader2 className="spin" size={18} />
          ) : (
            <>
              Acessar painel <ArrowRight size={18} />
            </>
          )}
        </button>
        <small>
          Acesso restrito a usuários autorizados. As sessões expiram
          automaticamente.
        </small>
      </form>
    </main>
  );
}
