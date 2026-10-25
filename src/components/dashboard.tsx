"use client";
import { useState, useEffect, useRef } from "react";
import {
  LayoutDashboard,
  Send,
  Users,
  Upload,
  MessageSquare,
  History,
  BarChart3,
  Settings,
  ArrowUpRight,
  ArrowRight,
  Plus,
  Search,
  Bell,
  ChevronDown,
  ChevronRight,
  Download,
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  ShoppingBag,
  Play,
  Pause,
  Square,
  X,
  Wifi,
  WifiOff,
  LogOut,
  Menu,
  RefreshCw,
  ShieldCheck,
  FlaskConical,
  Loader2,
  Eye,
  FileSpreadsheet,
  Link2,
  Zap,
} from "lucide-react";
import { api, useDashboard } from "@/hooks/use-dashboard";
import type { Row } from "@/types";
const tabs = [
  ["Dashboard", LayoutDashboard],
  ["Campanhas", Send],
  ["Contatos", Users],
  ["Importar Planilha", Upload],
  ["Mensagens", MessageSquare],
  ["Histórico", History],
  ["Relatórios", BarChart3],
  ["Configurações", Settings],
] as const;
const labels: Record<string, string> = {
  available: "Disponível",
  suppressed: "Descadastrado",
  blocked: "Bloqueado",
  purchased: "Compra registrada",
  draft: "Rascunho",
  running: "Em andamento",
  paused: "Pausada",
  cancelled: "Cancelada",
  completed: "Concluída",
  pending: "Pendente",
  sending: "Processando",
  requested: "Envio solicitado",
  sent: "Enviado",
  delivered: "Entregue",
  read: "Lido",
  replied: "Respondido",
  failed: "Falhou",
  unknown: "Resultado desconhecido",
  skipped: "Excluído",
  simulated: "Simulado",
  open: "Conectado",
  disconnected: "Desconectado",
};
const fmt = (v: unknown) => Number(v || 0).toLocaleString("pt-BR");
const date = (v: unknown) =>
  v
    ? new Date(String(v)).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
function Badge({ state }: { state: string }) {
  return (
    <span className={"badge " + state}>
      <span />
      {labels[state] || state}
    </span>
  );
}
function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Send size={25} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function Progress({ c }: { c: Row }) {
  const pct = c.total
    ? Math.round((100 * (c.total - c.pending - c.unknown)) / c.total)
    : 0;
  return (
    <>
      <div className="progress-label">
        <span>
          {fmt(c.total - c.pending - c.unknown)} de {fmt(c.total)} processados
        </span>
        <strong>{pct}%</strong>
      </div>
      <div className="progress">
        <i style={{ width: pct + "%" }} />
      </div>
    </>
  );
}
export default function Dashboard() {
  const { data: d, error, loading, refresh } = useDashboard();
  const [tab, setTab] = useState("Dashboard"),
    [mobile, setMobile] = useState(false),
    [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState(false);
  const [templates, setTemplates] = useState<Row[]>([]),
    [settings, setSettings] = useState<Row>({}),
    [campaign, setCampaign] = useState({
      name: "",
      minInterval: 15,
      maxInterval: 50,
      simulation: true,
    }),
    [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [filters, setFilters] = useState({
      state: "",
      campaign: "",
      slot: "",
      date: "",
    });
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<any>(null),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [importResult, setImportResult] = useState<any>(null),
    [dragging, setDragging] = useState(false);
  const [qr, setQr] = useState<{ qr: string; expiresAt: number } | null>(null),
    [now, setNow] = useState(Date.now()),
    [providerConfig, setProviderConfig] = useState<any>(null),
    [suppression, setSuppression] = useState({ phone: "", reason: "" }),
    [purchase, setPurchase] = useState({ id: "", source: "", purchasedAt: "" }),
    [reconcile, setReconcile] = useState({ id: "", providerId: "" });
  const initialized = useRef(false);
  useEffect(() => {
    if (d && !initialized.current) {
      setTemplates(d.templates);
      setSettings(d.instance.settings);
      initialized.current = true;
    }
  }, [d]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (tab === "Configurações")
      api("whatsapp/config")
        .then(setProviderConfig)
        .catch(() => {});
  }, [tab]);
  useEffect(() => {
    if (!qr || qr.expiresAt < Date.now() || d?.instance.status === "open")
      return;
    const t = setInterval(async () => {
      try {
        const s = await api("whatsapp/status", "POST");
        if (s.status === "open") {
          setQr(null);
          void refresh();
          setNotice({ text: "WhatsApp conectado com sucesso." });
        }
      } catch (e) {
        setNotice({ text: (e as Error).message, error: true });
        setQr(null);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [qr, d?.instance.status, refresh]);
  async function perform(fn: () => Promise<unknown>, message?: string) {
    setBusy(true);
    try {
      await fn();
      if (message) setNotice({ text: message });
      await refresh();
      return true;
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
      return false;
    } finally {
      setBusy(false);
    }
  }
  const go = (name: string) => {
    setTab(name);
    setSearch("");
    setMobile(false);
  };
  async function selectFile(f: File) {
    setFile(f);
    setPreview(null);
    setImportResult(null);
    const form = new FormData();
    form.set("file", f);
    form.set("mode", "preview");
    await perform(async () => {
      const p = await api("imports", "POST", form);
      setPreview(p);
      const aliases: Record<string, string[]> = {
        name: ["nome", "cliente", "nome do cliente"],
        phone: ["telefone", "celular", "whatsapp"],
        status: ["status", "status do funil"],
        product: ["produto"],
        link: ["link", "link do carrinho"],
        abandonedAt: ["dataabandono", "data do abandono"],
        orderId: ["pedido", "identificador do pedido"],
      };
      const m: Record<string, string> = {};
      for (const [k, values] of Object.entries(aliases)) {
        m[k] =
          p.headers.find((h: string) => values.includes(h.toLowerCase())) || "";
      }
      setMapping(m);
    });
  }
  const match = (r: Row) =>
    [r.name, r.phone].some((v) =>
      String(v || "")
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
  const history =
    d?.jobs.filter(
      (j: Row) =>
        match(j) &&
        (!filters.state || j.state === filters.state) &&
        (!filters.campaign || j.campaign_id === filters.campaign) &&
        (!filters.slot || String(j.template_slot) === filters.slot) &&
        (!filters.date ||
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Sao_Paulo",
          }).format(new Date(j.processed_at || j.created_at)) === filters.date),
    ) || [];
  const historyQuery = new URLSearchParams({ ...filters, search }).toString();
  const eligible: Row[] =
    d?.contacts.filter(
      (c: Row) =>
        !c.suppressed &&
        !c.blocked &&
        !c.purchased_at &&
        ![
          "comprou",
          "pago",
          "purchased",
          "paid",
          "concluído",
          "concluido",
        ].includes(c.funnel_status.toLowerCase()),
    ) || [];
  const live =
    d?.campaigns.filter((c: Row) => c.status === "running").length || 0;
  const connect = () =>
    perform(async () => {
      const result = await api("whatsapp/connect", "POST");
      setQr(result);
    });
  function campaignTable(items: Row[], compact = false) {
    return items.length ? (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Campanha</th>
              <th>Status</th>
              <th>Progresso</th>
              {!compact && (
                <>
                  <th>Enviados / entregues</th>
                  <th>Falhas</th>
                </>
              )}
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.campaign_id}>
                <td>
                  <strong>{c.name}</strong>
                  <small>
                    {c.simulation
                      ? "Simulação · sem envios reais"
                      : "Envio real"}{" "}
                    · {date(c.created_at)}
                  </small>
                </td>
                <td>
                  <Badge state={c.status} />
                  {c.pause_reason && (
                    <small className="error-text">{c.pause_reason}</small>
                  )}
                </td>
                <td className="progress-cell">
                  <Progress c={c} />
                  {c.unknown > 0 && (
                    <small className="error-text">
                      {c.unknown} envio(s) para reconciliar
                    </small>
                  )}
                </td>
                {!compact && (
                  <>
                    <td>
                      {fmt(c.sent)} / {fmt(c.delivered)}
                      <small>
                        {fmt(c.requested)} solicitado(s) · {fmt(c.simulated)}{" "}
                        simulado(s)
                      </small>
                    </td>
                    <td>{fmt(c.failed)}</td>
                  </>
                )}
                <td>
                  <div className="actions">
                    <button
                      className="icon-button"
                      title="Pré-visualizar campanha"
                      onClick={() => {
                        go("Histórico");
                        setFilters({
                          state: "",
                          campaign: c.campaign_id,
                          slot: "",
                          date: "",
                        });
                      }}
                    >
                      <Eye size={16} />
                    </button>
                    {["draft", "paused"].includes(c.status) && (
                      <button
                        className="icon-button"
                        title={
                          c.status === "draft"
                            ? "Iniciar campanha"
                            : "Continuar campanha"
                        }
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            () =>
                              api(
                                `campaigns/${c.campaign_id}/${c.status === "draft" ? "start" : "resume"}`,
                                "POST",
                              ),
                            "Campanha autorizada para processamento.",
                          )
                        }
                      >
                        <Play size={16} />
                      </button>
                    )}
                    {c.status === "running" && (
                      <button
                        className="icon-button"
                        title="Pausar campanha"
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            () =>
                              api(`campaigns/${c.campaign_id}/pause`, "POST"),
                            "Novos envios pausados.",
                          )
                        }
                      >
                        <Pause size={16} />
                      </button>
                    )}
                    {["draft", "running", "paused"].includes(c.status) && (
                      <button
                        className="icon-button danger"
                        title="Cancelar pendentes definitivamente"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              "Cancelar definitivamente os envios pendentes desta campanha?",
                            )
                          )
                            void perform(
                              () =>
                                api(
                                  `campaigns/${c.campaign_id}/cancel`,
                                  "POST",
                                ),
                              "Pendentes cancelados.",
                            );
                        }}
                      >
                        <Square size={15} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty
        title="Sua próxima campanha começa aqui"
        text="Importe seus contatos e personalize suas mensagens para criar uma campanha."
        action={
          <button
            className="button secondary"
            onClick={() => go("Importar Planilha")}
          >
            Importar contatos <ArrowRight size={16} />
          </button>
        }
      />
    );
  }
  const totalMessages = (d?.counts.sent || 0) + (d?.counts.failed || 0);
  const rate = (n: number, den: number) =>
    den ? Math.round((n / den) * 100) + "%" : "—";
  if (loading)
    return (
      <div className="loading-screen">
        <Loader2 className="spin" />
        <p>Preparando seu painel...</p>
      </div>
    );
  return (
    <div className="app-shell">
      {mobile && (
        <div className="sidebar-backdrop" onClick={() => setMobile(false)} />
      )}
      <aside className={"sidebar " + (mobile ? "visible" : "")}>
        <a className="brand" href="/">
          <span className="brand-mark">
            tv<span>↗</span>
          </span>
          <span>
            TECHVIEW<small>REMARKETING</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">T</span>
          <div>
            Workspace TechView<small>Painel de gerenciamento</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <span className="nav-caption">PRINCIPAL</span>
        <nav>
          {tabs.map(([name, Icon], i) => (
            <button
              key={name}
              className={tab === name ? "active" : ""}
              onClick={() => go(name)}
            >
              <Icon size={19} />
              <span>{name}</span>
              {name === "Campanhas" && live > 0 && <b>{live}</b>}
              {i === 0 && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-mini">
            <span
              className={
                d?.instance.status === "open" ? "green-dot" : "gray-dot"
              }
            />
            <div>
              WhatsApp
              <small>
                {d?.instance.status === "open"
                  ? "Conectado e pronto"
                  : "Conexão pendente"}
              </small>
            </div>
            <button
              title="Configurar WhatsApp"
              onClick={() => go("Configurações")}
            >
              <ArrowUpRight size={17} />
            </button>
          </div>
          <div className="user">
            <span className="user-avatar">
              {d?.user.email[0]?.toUpperCase() || "T"}
            </span>
            <div>
              Minha conta<small>{d?.user.email || "Usuário"}</small>
            </div>
            <button
              title="Sair"
              onClick={() =>
                void perform(() =>
                  api("auth/logout", "POST").then(() => {
                    window.location.href = "/login";
                  }),
                )
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label="Abrir menu"
              onClick={() => setMobile(true)}
            >
              <Menu />
            </button>
            <span className="breadcrumb">
              Workspace <ChevronRight size={14} />
              <strong>{tab}</strong>
            </span>
          </div>
          <div className="topbar-right">
            <span className="secure-label">
              <ShieldCheck size={14} /> Ambiente protegido
            </span>
            <button
              className="icon-button"
              title="Atualizar dados"
              onClick={() => void refresh()}
            >
              <RefreshCw size={17} />
            </button>
            <span className="avatar-small">TV</span>
          </div>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">RELACIONAMENTO QUE CONVERTE</div>
              <h1>{tab === "Dashboard" ? "TechView Remarketing" : tab}</h1>
              <p>
                {
                  (
                    {
                      Dashboard:
                        "Recupere clientes que abandonaram o carrinho.",
                      Campanhas: "Cada campanha, uma nova chance de conectar.",
                      Contatos:
                        "Organize seus contatos e respeite cada escolha.",
                      "Importar Planilha":
                        "Transforme sua planilha da Maria em novas oportunidades.",
                      Mensagens:
                        "A mensagem certa começa com uma conversa de verdade.",
                      Histórico: "Acompanhe cada envio, do início à resposta.",
                      Relatórios: "Resultados reais para decisões melhores.",
                      Configurações:
                        "Seu WhatsApp e suas regras, em um só lugar.",
                    } as Record<string, string>
                  )[tab]
                }
              </p>
            </div>
            <div className="heading-actions">
              {tab === "Dashboard" && (
                <span className="today">
                  {new Date().toLocaleDateString("pt-BR", {
                    timeZone: "America/Sao_Paulo",
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              )}
              {["Dashboard", "Campanhas"].includes(tab) && (
                <button
                  className="button primary"
                  onClick={() => setModal(true)}
                >
                  <Plus size={17} /> Nova campanha
                </button>
              )}
              {tab === "Contatos" && (
                <button
                  className="button primary"
                  onClick={() => go("Importar Planilha")}
                >
                  <Upload size={17} /> Importar contatos
                </button>
              )}
            </div>
          </div>
          {error && (
            <div role="alert" className="notice error">
              {error}
              <button onClick={() => void refresh()}>Tentar novamente</button>
            </div>
          )}
          {d && (
            <>
              {tab === "Dashboard" && (
                <>
                  <section className="hero-banner">
                    <div className="hero-copy">
                      <span className="hero-tag">
                        <Zap size={13} /> CADA CARRINHO TEM UMA HISTÓRIA
                      </span>
                      <h2>
                        Reconecte. Converse.
                        <br />
                        <span>Recupere oportunidades.</span>
                      </h2>
                      <p>
                        Mensagens personalizadas, no momento certo.
                        <br />
                        Você no controle de cada etapa.
                      </p>
                      <button
                        className="button light"
                        onClick={() =>
                          go(
                            d.counts.contacts
                              ? "Campanhas"
                              : "Importar Planilha",
                          )
                        }
                      >
                        {d.counts.contacts
                          ? "Ver minhas campanhas"
                          : "Começar minha primeira campanha"}{" "}
                        <ArrowRight size={16} />
                      </button>
                    </div>
                    <div className="hero-art" aria-hidden="true">
                      <div className="orbit orbit-one" />
                      <div className="orbit orbit-two" />
                      <div className="chat-tile">
                        <MessageSquare size={52} strokeWidth={1.4} />
                        <span className="chat-check">
                          <CheckCheck size={23} />
                        </span>
                      </div>
                      <div className="floating-label">
                        <span className="green-dot" /> Conexões que importam
                      </div>
                      <span className="decor-star star-one">✦</span>
                      <span className="decor-star star-two">✧</span>
                    </div>
                  </section>
                  <div className="section-line">
                    <h2>Visão geral</h2>
                    <span>
                      <span className="green-dot" /> Atualizado a cada 5
                      segundos
                    </span>
                  </div>
                  <section className="stats-grid">
                    {[
                      {
                        label: "Total de contatos",
                        value: d.counts.contacts,
                        icon: Users,
                        color: "blue",
                        hint: "Base de relacionamento",
                      },
                      {
                        label: "Mensagens enviadas",
                        value: d.counts.sent,
                        icon: Send,
                        color: "purple",
                        hint: "Envios confirmados pelo provedor",
                      },
                      {
                        label: "Mensagens entregues",
                        value: d.counts.delivered,
                        icon: CheckCheck,
                        color: "cyan",
                        hint: "Confirmação de entrega real",
                      },
                      {
                        label: "Respostas recebidas",
                        value: d.counts.replied,
                        icon: MessageSquare,
                        color: "green",
                        hint: "Contatos que responderam",
                      },
                      {
                        label: "Compras recuperadas",
                        value: d.counts.recovered,
                        icon: ShoppingBag,
                        color: "orange",
                        hint: "Compra confirmada após envio¹",
                      },
                      {
                        label: "Falhas de envio",
                        value: d.counts.failed,
                        icon: AlertCircle,
                        color: "red",
                        hint: "Falhas definitivas de envio",
                      },
                    ].map((s) => (
                      <div className="stat-card" key={s.label}>
                        <div className="stat-top">
                          <span>{s.label}</span>
                          <span className={"stat-icon " + s.color}>
                            <s.icon size={17} />
                          </span>
                        </div>
                        <strong>{fmt(s.value)}</strong>
                        <small>{s.hint}</small>
                      </div>
                    ))}
                  </section>
                  <div className="dashboard-grid">
                    <section className="panel">
                      <div className="panel-header">
                        <div>
                          <h2>Atividade de envios</h2>
                          <p>Últimos 7 dias · confirmações reais</p>
                        </div>
                        <span className="chart-legend">
                          <i /> Enviadas
                        </span>
                      </div>
                      <Activity jobs={d.activity || []} />
                      <div className="chart-footer">
                        <ShieldCheck size={15} /> Simulações não entram nos
                        indicadores de envio.
                      </div>
                    </section>
                    <section className="panel quick-start">
                      <div className="panel-header">
                        <div>
                          <h2>Seu caminho até a conversão</h2>
                          <p>Prepare sua próxima campanha</p>
                        </div>
                        <span className="icon-tile small">
                          <Zap size={16} />
                        </span>
                      </div>
                      {[
                        {
                          title: "Conecte seu WhatsApp",
                          text: "Leia o QR Code para começar.",
                          done: d.instance.status === "open",
                          target: "Configurações",
                        },
                        {
                          title: "Importe seus contatos",
                          text: "CSV ou Excel exportado da Maria.",
                          done: d.counts.contacts > 0,
                          target: "Importar Planilha",
                        },
                        {
                          title: "Crie suas mensagens",
                          text: "Até 4 variações personalizadas.",
                          done: d.templates.some((t: Row) => t.content),
                          target: "Mensagens",
                        },
                        {
                          title: "Simule e inicie uma campanha",
                          text: "Revise tudo antes de enviar.",
                          done: d.campaigns.length > 0,
                          target: "Campanhas",
                        },
                      ].map((s, i) => (
                        <button
                          className="checklist-item"
                          key={s.title}
                          onClick={() => go(s.target)}
                        >
                          <span
                            className={"step-number " + (s.done ? "done" : "")}
                          >
                            {s.done ? <Check size={15} /> : i + 1}
                          </span>
                          <span>
                            <strong>{s.title}</strong>
                            <small>{s.text}</small>
                          </span>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                    </section>
                  </div>
                  <section className="panel">
                    <div className="panel-header">
                      <div>
                        <h2>Campanhas recentes</h2>
                        <p>Acompanhe o progresso das suas ações</p>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => go("Campanhas")}
                      >
                        Ver todas <ArrowRight size={15} />
                      </button>
                    </div>
                    {campaignTable(d.campaigns.slice(0, 4), true)}
                  </section>
                  <div className="footnote">
                    ¹ Associação temporal com compra confirmada e fonte
                    registrada; não comprova causalidade da campanha.
                  </div>
                </>
              )}
              {tab === "Campanhas" && (
                <>
                  <div className="notice info">
                    <FlaskConical size={18} />
                    <span>
                      Comece com uma simulação. Ela usa a fila e os contatos
                      reais, mas não envia mensagens nem altera métricas de
                      entrega.
                    </span>
                  </div>
                  <section className="panel">
                    {campaignTable(d.campaigns)}
                  </section>
                  <p className="footnote">
                    Pausar interrompe novos envios. Uma solicitação já aceita
                    pelo provedor pode terminar. A reconexão não retoma
                    campanhas automaticamente.
                  </p>
                </>
              )}
              {tab === "Contatos" && (
                <>
                  <div className="toolbar">
                    <div className="search-input">
                      <Search size={17} />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Buscar nome ou telefone"
                      />
                    </div>
                    <span>
                      {fmt(d.counts.contacts)} contatos · {eligible.length}{" "}
                      elegíveis nesta página
                    </span>
                  </div>
                  <section className="panel">
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Contato</th>
                            <th>Telefone</th>
                            <th>Produto / funil</th>
                            <th>Situação</th>
                            <th>Ações</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.contacts.filter(match).map((c: Row) => (
                            <tr key={c.id}>
                              <td>
                                <strong>{c.name}</strong>
                                <small>Pedido: {c.order_id || "—"}</small>
                              </td>
                              <td>{c.phone}</td>
                              <td>
                                {c.product || "—"}
                                <small>{c.funnel_status || "Sem status"}</small>
                              </td>
                              <td>
                                <Badge
                                  state={
                                    c.suppressed
                                      ? "suppressed"
                                      : c.blocked
                                        ? "blocked"
                                        : eligible.some(
                                              (item) => item.id === c.id,
                                            )
                                          ? "available"
                                          : "purchased"
                                  }
                                />
                                <small>
                                  {c.suppressed
                                    ? "Exclusão permanente"
                                    : c.blocked
                                      ? "Número bloqueado"
                                      : eligible.some(
                                            (item) => item.id === c.id,
                                          )
                                        ? "Disponível para seleção em campanhas"
                                        : "Compra confirmada ou registrada no funil"}
                                </small>
                              </td>
                              <td>
                                <div className="actions">
                                  <button
                                    className="text-button"
                                    disabled={busy || c.suppressed}
                                    onClick={() =>
                                      void perform(
                                        () =>
                                          api("contacts/suppress", "POST", {
                                            phone: c.phone,
                                            reason:
                                              "Descadastro manual pelo administrador",
                                          }),
                                        "Contato excluído de envios futuros.",
                                      )
                                    }
                                  >
                                    Descadastrar
                                  </button>
                                  {!c.purchased_at && (
                                    <button
                                      className="text-button"
                                      onClick={() =>
                                        setPurchase({
                                          id: c.id,
                                          source: "",
                                          purchasedAt: "",
                                        })
                                      }
                                    >
                                      Confirmar compra
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!d.contacts.length && (
                        <Empty
                          title="Sua base ainda está vazia"
                          text="Importe a planilha da Maria para começar e selecione os destinatários ao criar uma campanha."
                        />
                      )}
                    </div>
                  </section>
                  <p className="footnote">
                    Exibindo até 1.000 contatos. Selecione os destinatários ao
                    criar a campanha; importar não inicia envios.
                  </p>
                </>
              )}
              {tab === "Importar Planilha" && (
                <>
                  <div className="import-layout">
                    <section className="panel padded">
                      <div className="panel-title">
                        <span className="icon-tile">
                          <FileSpreadsheet size={23} />
                        </span>
                        <div>
                          <h2>Importar contatos da Maria</h2>
                          <p>Conecte os dados da sua operação.</p>
                        </div>
                      </div>
                      <label
                        className={"dropzone " + (dragging ? "dragging" : "")}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragging(false);
                          if (e.dataTransfer.files[0])
                            void selectFile(e.dataTransfer.files[0]);
                        }}
                      >
                        <span className="upload-circle">
                          <Upload size={28} />
                        </span>
                        <strong>
                          {file ? file.name : "Arraste sua planilha até aqui"}
                        </strong>
                        <p>
                          ou <b>clique para selecionar um arquivo</b>
                        </p>
                        <small>CSV ou XLSX · até 5 MB · 10.000 linhas</small>
                        <input
                          type="file"
                          accept=".csv,.xlsx"
                          disabled={busy}
                          onChange={(e) => {
                            if (e.target.files?.[0])
                              void selectFile(e.target.files[0]);
                          }}
                        />
                      </label>
                      <a
                        className="text-button centered"
                        href="/api/imports/template"
                      >
                        <Download size={16} /> Baixar planilha modelo
                      </a>
                    </section>
                    <section className="panel padded import-guide">
                      <h2>Antes de importar</h2>
                      <p>Uma base bem organizada faz toda a diferença.</p>
                      <div>
                        <span>01</span>
                        <p>
                          <strong>Exporte da Maria</strong>
                          <small>
                            Utilize CSV ou Excel com cabeçalhos únicos.
                          </small>
                        </p>
                      </div>
                      <div>
                        <span>02</span>
                        <p>
                          <strong>Confira o mapeamento</strong>
                          <small>
                            Nome e telefone são obrigatórios. Datas no formato
                            AAAA-MM-DD.
                          </small>
                        </p>
                      </div>
                      <div>
                        <span>03</span>
                        <p>
                          <strong>Confira os destinatários</strong>
                          <small>
                            Escolha os contatos do teste na campanha.
                            Descadastros, bloqueios e compras continuam
                            excluídos.
                          </small>
                        </p>
                      </div>
                      <div className="notice info">
                        <ShieldCheck size={20} />
                        <small>
                          Números ambíguos são rejeitados. Não acrescentamos
                          dígitos por suposição.
                        </small>
                      </div>
                    </section>
                  </div>
                  {preview && (
                    <section className="panel padded">
                      <div className="section-line">
                        <h2>Mapear colunas</h2>
                        <span>{preview.total} linhas encontradas</span>
                      </div>
                      <div className="form-grid">
                        {Object.entries({
                          name: "Nome do cliente *",
                          phone: "Telefone *",
                          status: "Status do funil",
                          product: "Produto",
                          link: "Link do carrinho",
                          abandonedAt: "Data do abandono",
                          orderId: "Identificador do pedido",
                        }).map(([k, label]) => (
                          <label key={k}>
                            {label}
                            <select
                              value={mapping[k] || ""}
                              onChange={(e) =>
                                setMapping({ ...mapping, [k]: e.target.value })
                              }
                            >
                              <option value="">Não informado</option>
                              {preview.headers.map((h: string) => (
                                <option key={h}>{h}</option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                      <div className="notice info">
                        Contatos válidos ficam disponíveis para seleção em
                        campanhas. Duplicados atualizam o status do funil;
                        exclusões permanentes são preservadas. A importação não
                        inicia envios.
                      </div>
                      <h3>Prévia das primeiras {preview.rows.length} linhas</h3>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              {preview.headers.map((h: string) => (
                                <th key={h}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {preview.rows.map((r: Row, i: number) => (
                              <tr key={i}>
                                {preview.headers.map((h: string) => (
                                  <td key={h}>{r[h] || "—"}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <button
                        className="button primary"
                        disabled={
                          busy ||
                          !mapping.name ||
                          !mapping.phone ||
                          !!importResult
                        }
                        onClick={() =>
                          void perform(async () => {
                            const f = new FormData();
                            f.set("file", file!);
                            f.set(
                              "mapping",
                              JSON.stringify(
                                Object.fromEntries(
                                  Object.entries(mapping).filter(([, v]) => v),
                                ),
                              ),
                            );
                            const r = await api("imports", "POST", f);
                            setImportResult(r);
                          }, "Importação concluída. Nenhum envio foi autorizado.")
                        }
                      >
                        <Check size={17} /> Confirmar importação
                      </button>
                    </section>
                  )}
                  {importResult && (
                    <section className="panel padded">
                      <h2>Resultado da importação</h2>
                      <div className="mini-stats">
                        {Object.entries({
                          total: "Linhas",
                          valid: "Válidos",
                          invalid: "Inválidos",
                          duplicates: "Duplicados",
                          imported: "Importados",
                          updated: "Atualizados",
                        }).map(([k, v]) => (
                          <div key={k}>
                            <strong>{fmt(importResult[k])}</strong>
                            <small>{v}</small>
                          </div>
                        ))}
                      </div>
                      <a
                        className="button secondary"
                        href={`/api/imports/${importResult.id}/errors`}
                      >
                        <Download size={16} /> Baixar relatório de erros
                      </a>
                    </section>
                  )}
                  {!!d.imports.length && (
                    <section className="panel">
                      <div className="panel-header">
                        <h2>Importações anteriores</h2>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Arquivo</th>
                              <th>Data</th>
                              <th>Importados</th>
                              <th>Relatório</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.imports.map((i: Row) => (
                              <tr key={i.id}>
                                <td>{i.filename}</td>
                                <td>{date(i.created_at)}</td>
                                <td>{i.summary.imported || 0}</td>
                                <td>
                                  <a
                                    className="text-button"
                                    href={`/api/imports/${i.id}/errors`}
                                  >
                                    <Download size={15} /> Baixar
                                  </a>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}
                </>
              )}
              {tab === "Mensagens" && (
                <>
                  <div className="notice info">
                    <Zap size={18} />
                    <span>
                      Seleção aleatória entre mensagens habilitadas e
                      preenchidas, sem cotas fixas. O conteúdo fica registrado
                      na criação da campanha.
                    </span>
                  </div>
                  <div className="messages-grid">
                    {templates.map((t, index) => (
                      <section className="panel message-editor" key={t.id}>
                        <div className="panel-header">
                          <div className="message-title">
                            <span className="template-number">0{t.slot}</span>
                            <h2>Mensagem {t.slot}</h2>
                          </div>
                          <label className="toggle-label">
                            <input
                              type="checkbox"
                              checked={t.enabled}
                              onChange={(e) =>
                                setTemplates(
                                  templates.map((v, i) =>
                                    i === index
                                      ? { ...v, enabled: e.target.checked }
                                      : v,
                                  ),
                                )
                              }
                            />{" "}
                            Habilitada
                          </label>
                        </div>
                        <div className="message-body">
                          <textarea
                            maxLength={4000}
                            rows={6}
                            value={t.content}
                            placeholder="Escreva sua mensagem de recuperação. Use {{nome}} para personalizar e inclua uma opção de descadastro."
                            onChange={(e) =>
                              setTemplates(
                                templates.map((v, i) =>
                                  i === index
                                    ? { ...v, content: e.target.value }
                                    : v,
                                ),
                              )
                            }
                          />
                          <div className="variables">
                            {["nome", "produto", "link"].map((v) => (
                              <button
                                key={v}
                                onClick={() =>
                                  setTemplates(
                                    templates.map((m, i) =>
                                      i === index
                                        ? {
                                            ...m,
                                            content:
                                              m.content + "{{" + v + "}}",
                                          }
                                        : m,
                                    ),
                                  )
                                }
                              >
                                {"{{" + v + "}}"}
                              </button>
                            ))}
                            <span>{t.content.length}/4000</span>
                          </div>
                          <div className="message-preview">
                            <span>
                              <Eye size={13} /> PRÉ-VISUALIZAÇÃO ·{" "}
                              {d.contacts[0]
                                ? "PRIMEIRO CONTATO"
                                : "SEM CONTATO SELECIONADO"}
                            </span>
                            <p>
                              {t.content
                                ? t.content
                                    .replaceAll(
                                      "{{nome}}",
                                      d.contacts[0]?.name ||
                                        "[nome do contato]",
                                    )
                                    .replaceAll(
                                      "{{produto}}",
                                      d.contacts[0]?.product || "[produto]",
                                    )
                                    .replaceAll(
                                      "{{link}}",
                                      d.contacts[0]?.cart_url ||
                                        "[link do carrinho]",
                                    )
                                : "Sua mensagem aparecerá aqui."}
                            </p>
                          </div>
                        </div>
                      </section>
                    ))}
                  </div>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () =>
                          api(
                            "templates",
                            "PUT",
                            templates.map((t) => ({
                              slot: t.slot,
                              content: t.content,
                              enabled: t.enabled,
                            })),
                          ),
                        "Quatro mensagens salvas. Campanhas existentes preservam o texto original.",
                      )
                    }
                  >
                    <Check size={17} /> Salvar mensagens
                  </button>
                  <p className="footnote">
                    Variáveis sem valor bloqueiam a criação da campanha.
                    Mensagens vazias não participam da seleção. Oriente o
                    cliente a responder SAIR para interromper mensagens.
                  </p>
                </>
              )}
              {tab === "Histórico" && (
                <>
                  <section className="panel padded">
                    <div className="toolbar">
                      <div className="search-input">
                        <Search size={17} />
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Buscar nome ou telefone"
                        />
                      </div>
                      <a
                        className="button secondary"
                        href={"/api/history/export?" + historyQuery}
                      >
                        <Download size={16} /> Exportar CSV
                      </a>
                    </div>
                    <div className="filters">
                      <select
                        aria-label="Filtrar campanha"
                        value={filters.campaign}
                        onChange={(e) =>
                          setFilters({ ...filters, campaign: e.target.value })
                        }
                      >
                        <option value="">Todas as campanhas</option>
                        {d.campaigns.map((c: Row) => (
                          <option key={c.campaign_id} value={c.campaign_id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="Filtrar status"
                        value={filters.state}
                        onChange={(e) =>
                          setFilters({ ...filters, state: e.target.value })
                        }
                      >
                        <option value="">Todos os status</option>
                        {[
                          "pending",
                          "sending",
                          "requested",
                          "sent",
                          "delivered",
                          "read",
                          "replied",
                          "failed",
                          "unknown",
                          "cancelled",
                          "skipped",
                          "simulated",
                        ].map((s) => (
                          <option key={s} value={s}>
                            {labels[s]}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="Filtrar mensagem"
                        value={filters.slot}
                        onChange={(e) =>
                          setFilters({ ...filters, slot: e.target.value })
                        }
                      >
                        <option value="">Todas as mensagens</option>
                        {[1, 2, 3, 4].map((s) => (
                          <option value={s} key={s}>
                            Mensagem {s}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label="Filtrar data"
                        type="date"
                        value={filters.date}
                        onChange={(e) =>
                          setFilters({ ...filters, date: e.target.value })
                        }
                      />
                    </div>
                  </section>
                  <section className="panel">
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Contato / telefone</th>
                            <th>Campanha</th>
                            <th>Mensagem</th>
                            <th>Horário</th>
                            <th>Status</th>
                            <th>Resposta / erro</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.map((j: Row) => (
                            <tr key={j.id}>
                              <td>
                                <strong>{j.name}</strong>
                                <small>{j.phone}</small>
                              </td>
                              <td>
                                {j.campaign_name}
                                <small>
                                  {j.simulation ? "Simulação" : "Envio real"}
                                </small>
                              </td>
                              <td>
                                <strong>Modelo {j.template_slot}</strong>
                                <details>
                                  <summary>Ver conteúdo</summary>
                                  <p className="message-content">{j.content}</p>
                                </details>
                              </td>
                              <td>{date(j.processed_at || j.processing_at)}</td>
                              <td>
                                <Badge state={j.state} />
                              </td>
                              <td>
                                <span className={j.error ? "error-text" : ""}>
                                  {j.reply || j.error || "—"}
                                </span>
                                {j.state === "unknown" && (
                                  <button
                                    className="text-button"
                                    onClick={() =>
                                      setReconcile({ id: j.id, providerId: "" })
                                    }
                                  >
                                    Reconciliar
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!history.length && (
                        <Empty
                          title="Nenhum envio encontrado"
                          text="Os registros das campanhas aparecerão aqui, incluindo simulações e falhas."
                        />
                      )}
                    </div>
                  </section>
                  <p className="footnote">
                    Até 1.000 registros no painel; exportação filtrada de até
                    10.000. Datas no fuso de São Paulo.
                  </p>
                </>
              )}
              {tab === "Relatórios" && (
                <>
                  <div className="report-cards">
                    {[
                      [
                        "Taxa de entrega",
                        rate(d.counts.delivered, d.counts.sent),
                        CheckCheck,
                      ],
                      [
                        "Taxa de resposta",
                        rate(d.counts.replied, d.counts.sent),
                        MessageSquare,
                      ],
                      [
                        "Taxa de falha",
                        rate(d.counts.failed, totalMessages),
                        AlertCircle,
                      ],
                      [
                        "Compras confirmadas após envio",
                        fmt(d.counts.recovered),
                        ShoppingBag,
                      ],
                    ].map(([title, value, Icon]: any) => (
                      <section className="panel report-card" key={title}>
                        <Icon size={22} />
                        <small>{title}</small>
                        <strong>{value}</strong>
                      </section>
                    ))}
                  </div>
                  <div className="notice info">
                    Indicadores excluem simulações. Compras exigem confirmação
                    com fonte de pedido, nunca apenas uma resposta. Associação
                    temporal não comprova causalidade.
                  </div>
                  <section className="panel">
                    <div className="panel-header">
                      <h2>Resultados por mensagem</h2>
                      <a className="text-button" href="/api/history/export">
                        <Download size={15} /> Exportar envios
                      </a>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Modelo</th>
                            <th>Utilizações</th>
                            <th>Enviados</th>
                            <th>Entregues</th>
                            <th>Respostas</th>
                            <th>Falhas</th>
                            <th>Simulações</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[1, 2, 3, 4].map((slot) => {
                            const stats =
                              d.templateStats?.find(
                                (s: Row) => s.template_slot === slot,
                              ) || {};
                            return (
                              <tr key={slot}>
                                <td>Mensagem {slot}</td>
                                {[
                                  "total",
                                  "sent",
                                  "delivered",
                                  "replied",
                                  "failed",
                                  "simulated",
                                ].map((k) => (
                                  <td key={k}>{fmt(stats[k])}</td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <section className="panel">
                    <div className="panel-header">
                      <h2>Resultados por campanha</h2>
                    </div>
                    {campaignTable(d.campaigns)}
                  </section>
                  <p className="footnote">
                    Entrega = entregues ÷ enviados; resposta = respondidos ÷
                    enviados; falha = falhas ÷ (enviados + falhas). Ausência de
                    dados aparece como —.
                  </p>
                </>
              )}
              {tab === "Configurações" && (
                <>
                  <div className="settings-grid">
                    <section className="panel padded">
                      <div className="section-line">
                        <h2>
                          <MessageSquare size={20} /> Conexão WhatsApp
                        </h2>
                        <Badge state={d.instance.status} />
                      </div>
                      <p>
                        Conecte por QR Code, sem número ou código de pareamento.
                      </p>
                      <dl className="connection-details">
                        <div>
                          <dt>Instância</dt>
                          <dd>{d.instance.name}</dd>
                        </div>
                        <div>
                          <dt>Número conectado</dt>
                          <dd>{d.instance.phone || "—"}</dd>
                        </div>
                        <div>
                          <dt>Última conexão</dt>
                          <dd>{date(d.instance.last_connected_at)}</dd>
                        </div>
                        <div>
                          <dt>Evolution API</dt>
                          <dd>
                            {providerConfig?.url ||
                              "Não configurada no servidor"}
                          </dd>
                        </div>
                        <div>
                          <dt>Credencial do provedor</dt>
                          <dd>
                            {providerConfig?.configured
                              ? "Configurada no backend"
                              : "Pendente no servidor"}
                          </dd>
                        </div>
                        <div>
                          <dt>Webhook HTTPS</dt>
                          <dd>
                            {providerConfig?.webhookConfigured
                              ? "Configurado"
                              : "Pendente no servidor"}
                          </dd>
                        </div>
                      </dl>
                      {qr && d.instance.status !== "open" && (
                        <div className="qr-panel">
                          {qr.expiresAt > now ? (
                            <>
                              <img
                                src={qr.qr}
                                alt="QR Code para conectar WhatsApp"
                                width={230}
                                height={230}
                              />
                              <p>Escaneie em Aparelhos conectados.</p>
                              <small>
                                Atualizar em{" "}
                                {Math.max(
                                  0,
                                  Math.round((qr.expiresAt - now) / 1000),
                                )}{" "}
                                segundos.
                              </small>
                            </>
                          ) : (
                            <div className="notice error">
                              QR Code expirado. Clique em reconectar para gerar
                              outro.
                            </div>
                          )}
                        </div>
                      )}
                      <div className="button-row">
                        <button
                          className="button primary"
                          disabled={busy || d.instance.status === "open"}
                          onClick={() => void connect()}
                        >
                          <Wifi size={17} />
                          {qr ? "Reconectar" : "Conectar WhatsApp"}
                        </button>
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() =>
                            void perform(
                              () => api("whatsapp/status", "POST"),
                              "Status da conexão atualizado.",
                            )
                          }
                        >
                          <RefreshCw size={16} />
                        </button>
                        {d.instance.status === "open" && (
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              void perform(
                                () => api("whatsapp/disconnect", "POST"),
                                "WhatsApp desconectado e campanhas pausadas.",
                              )
                            }
                          >
                            <WifiOff size={17} /> Desconectar
                          </button>
                        )}
                      </div>
                      <div className="notice info">
                        URL e chaves são configuradas no servidor. A API Key
                        nunca é enviada ao navegador. A queda da conexão pausa
                        campanhas reais.
                      </div>
                    </section>
                    <section className="panel padded">
                      <h2>Regras de envio</h2>
                      <p>
                        Controle o ritmo e respeite o tempo dos seus clientes.
                      </p>
                      <div className="form-grid">
                        {Object.entries({
                          minInterval: "Intervalo mínimo (segundos)",
                          maxInterval: "Intervalo máximo (segundos)",
                          startHour: "Horário inicial (0–23)",
                          endHour: "Horário final (1–24)",
                          hourlyLimit: "Limite por hora",
                          dailyLimit: "Limite em 24 horas",
                          frequencyDays: "Dias entre envios ao mesmo contato",
                          maxAttempts: "Máximo de tentativas (1–5)",
                        }).map(([k, label]) => (
                          <label key={k}>
                            {label}
                            <input
                              type="number"
                              min={k === "startHour" ? 0 : 1}
                              value={settings[k] ?? ""}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  [k]: Number(e.target.value),
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <p className="footnote">
                        Fuso: America/Sao_Paulo. Horário final exclusivo;
                        limites em janelas móveis. A faixa de cada campanha é
                        registrada na criação.
                      </p>
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            () => api("settings", "PUT", settings),
                            "Regras de envio salvas.",
                          )
                        }
                      >
                        <Check size={17} /> Salvar configurações
                      </button>
                      <p className="footnote">
                        Intervalos aleatórios não evitam bloqueios e não
                        substituem as regras da plataforma.
                      </p>
                    </section>
                  </div>
                  <section className="panel padded">
                    <h2>Lista de exclusão permanente</h2>
                    <p>
                      Contatos nesta lista não recebem mensagens de nenhuma
                      campanha desta conta.
                    </p>
                    <form
                      className="suppression-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void perform(
                          () => api("contacts/suppress", "POST", suppression),
                          "Telefone adicionado à lista de exclusão.",
                        );
                      }}
                    >
                      <label>
                        Telefone
                        <input
                          value={suppression.phone}
                          required
                          onChange={(e) =>
                            setSuppression({
                              ...suppression,
                              phone: e.target.value,
                            })
                          }
                          placeholder="55 + DDD + telefone"
                        />
                      </label>
                      <label>
                        Motivo
                        <input
                          value={suppression.reason}
                          minLength={3}
                          required
                          onChange={(e) =>
                            setSuppression({
                              ...suppression,
                              reason: e.target.value,
                            })
                          }
                          placeholder="Solicitação do cliente"
                        />
                      </label>
                      <button className="button secondary" disabled={busy}>
                        Adicionar exclusão
                      </button>
                    </form>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Telefone</th>
                            <th>Motivo</th>
                            <th>Data</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.suppressions.map((s: Row) => (
                            <tr key={s.id}>
                              <td>{s.phone}</td>
                              <td>{s.reason}</td>
                              <td>{date(s.created_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <div className="notice info">
                    <ShieldCheck size={20} />
                    <span>
                      A conexão Baileys da Evolution API não é uma integração
                      oficial da Meta e pode sofrer interrupções e bloqueios.
                      Utilize somente contatos autorizados, respeite as
                      políticas aplicáveis e avalie a API oficial para produção.
                    </span>
                  </div>
                </>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              TECHVIEW <b>REMARKETING</b>
            </span>
            <small>
              <ShieldCheck size={13} /> Conversas com propósito. Dados com
              responsabilidade.
            </small>
          </footer>
        </main>
      </div>
      {notice && (
        <div role="status" className={"toast " + (notice.error ? "error" : "")}>
          <AlertCircle size={19} />
          <span>{notice.text}</span>
          <button aria-label="Fechar aviso" onClick={() => setNotice(null)}>
            <X size={17} />
          </button>
        </div>
      )}
      {busy && (
        <div className="busy-indicator">
          <Loader2 size={17} className="spin" /> Processando...
        </div>
      )}
      {modal && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await api("campaigns", "POST", {
                  ...campaign,
                  contactIds: selected,
                });
                setModal(false);
                setSelected([]);
              }, "Campanha criada como rascunho. Revise e clique em iniciar.");
            }}
          >
            <div className="section-line">
              <h2>Nova campanha</h2>
              <button
                type="button"
                className="icon-button"
                onClick={() => setModal(false)}
                aria-label="Fechar"
              >
                <X size={20} />
              </button>
            </div>
            <p>
              O conteúdo é escolhido aleatoriamente e registrado para cada
              contato.
            </p>
            <label>
              Nome da campanha
              <input
                required
                minLength={3}
                maxLength={120}
                value={campaign.name}
                onChange={(e) =>
                  setCampaign({ ...campaign, name: e.target.value })
                }
                placeholder="Ex.: Recuperação de carrinhos — Outubro"
              />
            </label>
            <div className="form-grid">
              <label>
                Intervalo mínimo (s)
                <input
                  type="number"
                  min={1}
                  max={3600}
                  required
                  value={campaign.minInterval}
                  onChange={(e) =>
                    setCampaign({
                      ...campaign,
                      minInterval: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                Intervalo máximo (s)
                <input
                  type="number"
                  min={campaign.minInterval}
                  max={3600}
                  required
                  value={campaign.maxInterval}
                  onChange={(e) =>
                    setCampaign({
                      ...campaign,
                      maxInterval: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <label>
              Modo de execução
              <select
                value={String(campaign.simulation)}
                onChange={(e) =>
                  setCampaign({
                    ...campaign,
                    simulation: e.target.value === "true",
                  })
                }
              >
                <option value="true">
                  Simulação — nenhuma mensagem enviada
                </option>
                <option value="false" disabled={!d?.realSendEnabled}>
                  Envio real{" "}
                  {!d?.realSendEnabled ? "(desabilitado no servidor)" : ""}
                </option>
              </select>
            </label>
            <details className="contact-select" open>
              <summary>
                Selecionar contatos da campanha · {selected.length} selecionados
              </summary>
              <p>
                Marque apenas os destinatários desta campanha. Sem seleção,
                nenhuma campanha será criada. A lista mostra até 1.000 contatos.
              </p>
              {eligible.map((c: Row) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, c.id]
                          : selected.filter((id) => id !== c.id),
                      )
                    }
                  />
                  {c.name} · {c.phone}
                </label>
              ))}
            </details>
            <div className="notice info">
              Criar não inicia envios. Contatos bloqueados, descadastrados ou
              com compra registrada são excluídos da seleção.
            </div>
            <button
              className="button primary"
              disabled={busy || !selected.length}
            >
              <Plus size={17} /> Criar campanha
            </button>
          </form>
        </div>
      )}
      {purchase.id && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await api(`contacts/${purchase.id}/purchase`, "POST", {
                  source: purchase.source,
                  purchasedAt: new Date(purchase.purchasedAt).toISOString(),
                });
                setPurchase({ id: "", source: "", purchasedAt: "" });
              }, "Compra confirmada e pendentes excluídos.");
            }}
          >
            <div className="section-line">
              <h2>Confirmar compra real</h2>
              <button
                type="button"
                className="icon-button"
                onClick={() => setPurchase({ ...purchase, id: "" })}
              >
                <X />
              </button>
            </div>
            <p>
              Registre apenas uma compra verificada na Maria ou em outra fonte
              de pedidos.
            </p>
            <label>
              Fonte e identificador do pedido
              <input
                required
                minLength={5}
                value={purchase.source}
                onChange={(e) =>
                  setPurchase({ ...purchase, source: e.target.value })
                }
                placeholder="Maria · pedido 12345"
              />
            </label>
            <label>
              Data e hora da compra (seu fuso local)
              <input
                type="datetime-local"
                required
                value={purchase.purchasedAt}
                onChange={(e) =>
                  setPurchase({ ...purchase, purchasedAt: e.target.value })
                }
              />
            </label>
            <button className="button primary" disabled={busy}>
              Registrar confirmação
            </button>
          </form>
        </div>
      )}
      {reconcile.id && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await api(`jobs/${reconcile.id}/reconcile`, "POST", {
                  providerId: reconcile.providerId,
                });
                setReconcile({ id: "", providerId: "" });
              }, "Resultado verificado junto ao provedor. Retome a campanha manualmente se desejar.");
            }}
          >
            <div className="section-line">
              <h2>Reconciliar envio</h2>
              <button
                type="button"
                className="icon-button"
                onClick={() => setReconcile({ id: "", providerId: "" })}
              >
                <X />
              </button>
            </div>
            <p>
              Consulte o identificador da mensagem na Evolution API. O backend
              verificará destinatário e conteúdo antes de associar o resultado.
              Se não houver confirmação, o envio continuará bloqueado.
            </p>
            <label>
              ID retornado pelo provedor
              <input
                required
                value={reconcile.providerId}
                onChange={(e) =>
                  setReconcile({ ...reconcile, providerId: e.target.value })
                }
              />
            </label>
            <button className="button primary" disabled={busy}>
              Consultar e verificar
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
function Activity({ jobs }: { jobs: Row[] }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 6 + i);
    const key = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
    }).format(d);
    return {
      label: d.toLocaleDateString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
      }),
      count: Number(jobs.find((j) => j.day === key)?.sent || 0),
    };
  });
  const max = Math.max(4, ...days.map((d) => d.count));
  return (
    <div className="activity-chart">
      <div className="chart-scale">
        {[
          max,
          Math.round(max * 0.75),
          Math.round(max * 0.5),
          Math.round(max * 0.25),
          0,
        ].map((n, i) => (
          <span key={i}>{n}</span>
        ))}
      </div>
      <div className="chart-area">
        <div className="chart-lines">
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} />
          ))}
        </div>
        <div className="bars">
          {days.map((d, i) => (
            <div className="bar-column" key={i}>
              <span className="bar-tooltip">{d.count} enviadas</span>
              <div
                className="bar"
                style={{
                  height: (d.count / max) * 100 + "%",
                  minHeight: d.count ? 4 : 0,
                }}
              />
              <small>{d.label}</small>
            </div>
          ))}
        </div>
        {days.every((d) => !d.count) && (
          <div className="chart-no-data">
            <span>Nenhum envio confirmado neste período</span>
            <small>Suas campanhas vão dar vida a este gráfico.</small>
          </div>
        )}
      </div>
    </div>
  );
}
