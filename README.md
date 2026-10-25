# TechView Remarketing

Painel de recuperação de carrinhos por WhatsApp. Next.js App Router, React, TypeScript, Tailwind CSS, Lucide, Zod, PostgreSQL/Supabase e Evolution API v2. Interface em português, dados persistentes e worker independente do navegador.

## O que está implementado

- Dashboard, campanhas, contatos, importação, quatro mensagens, histórico, relatórios e configurações responsivas.
- Autenticação Supabase com validação de usuário no servidor; cookie HttpOnly e SameSite Strict. Nenhuma chave administrativa no cliente. As contas são isoladas por `user_id` e cada conta possui uma instância WhatsApp própria.
- Importação CSV/XLSX de até 5 MB e 10.000 linhas: prévia, mapeamento, validação de datas ISO, normalização brasileira, deduplicação, relatório de erros e modelo CSV. Fórmulas XLSX e arquivos compactados acima dos limites são rejeitados.
- Consentimento com fonte e histórico; exclusões permanentes; opt-out por resposta; exclusão de compras e contatos bloqueados; limites horários, diários e por contato.
- Quatro modelos independentes com variáveis validadas, escolha aleatória criptográfica sem distribuição fixa e conteúdo registrado na fila antes do envio.
- Campanhas em rascunho, iniciar, pausar, continuar e cancelar; prévia na página de histórico e progresso atualizado a cada cinco segundos.
- Fila PostgreSQL com locks, intervalo por instância, backoff para rejeições 429, recuperação após reinício e bloqueio de resultados desconhecidos. Um envio já aceito pelo provedor pode terminar após uma pausa ou cancelamento.
- Evolution API: criação/identificação da instância, QR Code com expiração conservadora de 45 segundos, status, número conectado, desconexão e reconexão. A queda da conexão pausa campanhas reais; reconectar exige retomada manual.
- Webhooks autenticados, eventos idempotentes, estados monotônicos, respostas e conciliação de eventos que chegam antes da resposta de envio.
- Relatórios reais por campanha/modelo, histórico filtrável e exportação CSV com proteção contra fórmulas.
- Simulação explícita: percorre a fila sem chamar o provedor e sem incrementar entregas ou vendas.

## 1. Desenvolvimento local sem serviços externos

Requer Node.js 24 e npm 11 (versões usadas na validação). O modo local usa PostgreSQL embarcado PGlite em disco e autenticação local exclusiva de desenvolvimento. Não substitui a validação com Supabase e WhatsApp reais.

```sh
cd /workspace/remarketink-tecview
npm ci
npm run local:setup
npm run dev
```

`local:setup` cria `.env.local` apenas se não existir e gera credenciais de desenvolvimento em `.data/local-access.txt`, com permissão 0600. Leia esse arquivo localmente para entrar. Senhas, banco local, resultados de testes e arquivos `.env` são ignorados pelo Git. Não compartilhe nem publique esse arquivo.

Abra a porta 3000 no seu ambiente de execução. Não há dados de exemplo pré-carregados: indicadores começam em zero. O worker local roda dentro do processo web, sem depender do navegador após a inicialização. O modo local permite simulações; a configuração gerada mantém envios reais desabilitados.

PGlite aceita **um único processo por diretório de banco**. Não execute `npm run worker` ou migrations em paralelo ao servidor local. `LOCAL_DATABASE_PATH` permite usar outro diretório para testes isolados. Para validar vários processos e usar produção, utilize PostgreSQL/Supabase e o worker separado.

Cada tarefa cloud já é isolada. Use o checkout existente; não crie worktrees salvo solicitação explícita.

## Windows: iniciar pelo computador

O caminho `/workspace/remarketink-tecview` pertence ao ambiente cloud e não existe automaticamente no Windows. Baixe o código pelo [repositório no GitHub](https://github.com/mtsgodinho/remarketink-tecview), em **Code → Download ZIP**, e extraia todos os arquivos antes de iniciar.

Instale **Node.js 24**, baixe o ZIP do projeto e extraia todos os arquivos. Na pasta que contém `package.json`, dê dois cliques em **`iniciar-windows.cmd`**. O iniciador usa a própria pasta do projeto, instala dependências quando necessário, prepara o modo local sem sobrescrever `.env.local` existente e inicia a porta 3000. Deixe a janela aberta e acesse `http://localhost:3000` no navegador.

Para executar manualmente, abra essa mesma pasta no Explorador de Arquivos, clique na barra de endereço, digite `cmd` e pressione Enter. Execute:

```bat
dir package.json
npm ci
npm run local:setup
npm run dev -- --port 3000
```

Se `dir package.json` informar arquivo inexistente, entre na pasta extraída que contém o arquivo antes de continuar. O erro `ENOENT ... C:\Users\Mateus\package.json` significa que o terminal estava na pasta pessoal, fora do projeto.

Para consultar o acesso local, abra um segundo terminal nessa pasta:

```bat
type .data\local-access.txt
```

O modo local gera suas próprias credenciais. O ZIP não inclui senhas, `.env.local`, bancos ou dependências da máquina cloud. A execução no Windows depende da instalação local e não foi validada neste ambiente Linux.

## 2. Supabase e autenticação em produção

1. Crie um projeto Supabase dedicado a este sistema, com PostgreSQL 15 ou superior.
2. Configure `.env.local` a partir de `.env.example` ou injete os valores no gerenciador seguro de variáveis do servidor. Nunca versione o arquivo. O gerador local preserva arquivos existentes.
3. Defina `DATABASE_MODE=postgres`, `AUTH_MODE=supabase`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `APP_URL` com a origem HTTPS pública.
4. Use a conexão direta ou o pooler em **modo sessão**. Credenciais PostgreSQL são de backend e precisam permitir migrations e operações da aplicação. A URL deve ter senha codificada como URL. Não use o pooler em modo transação com configuração de sessão não verificada.
5. Execute `npm run db:migrate`. A migration é transacional e registrada em `schema_migrations`. Execute novamente para verificar que não há alterações pendentes.
6. No Supabase Auth, crie os usuários autorizados e confirme seus e-mails. Desabilite cadastro público se o painel for interno. A aplicação não oferece cadastro público.
7. Entre com e-mail e senha dessa conta. A sessão expira em até uma hora e pede novo login. O token não fica em localStorage; cada acesso protegido consulta `auth.getUser` no servidor.

As políticas RLS permitem leitura apenas ao proprietário. Escritas diretas pela API pública do Supabase não são permitidas pelas políticas: toda alteração passa pelas rotas autenticadas do backend e suas validações. A conexão PostgreSQL privilegiada fica exclusivamente no servidor; as consultas do backend incluem o proprietário. Não distribua `DATABASE_URL` ou credenciais de serviço aos usuários do navegador.

A conexão com PostgreSQL remoto valida o certificado TLS. Se necessário, configure `DATABASE_CA_CERT` com a CA oficial do seu provedor. Opções de URL que desativam a validação são descartadas; não use `NODE_TLS_REJECT_UNAUTHORIZED=0`. Conexões de desenvolvimento em loopback podem usar PostgreSQL local sem TLS.

## 3. Evolution API e QR Code

Requer Evolution API **v2** com integração `WHATSAPP-BAILEYS`, acesso HTTPS e suporte a cabeçalhos personalizados de webhook.

Configure no servidor:

| Variável                   | Finalidade                                                      |
| -------------------------- | --------------------------------------------------------------- |
| `EVOLUTION_API_URL`        | Origem HTTPS do provedor, por exemplo a URL da sua instalação   |
| `EVOLUTION_API_KEY`        | Credencial administrativa exclusivamente no backend             |
| `EVOLUTION_INSTANCE`       | Prefixo do nome; o sistema acrescenta um identificador de conta |
| `EVOLUTION_WEBHOOK_SECRET` | Segredo aleatório com pelo menos 32 caracteres                  |
| `APP_URL`                  | Origem HTTPS pública da aplicação, acessível pelo provedor      |

Em Configurações, clique **Conectar WhatsApp**, leia o QR Code em **Aparelhos conectados** no celular e aguarde. Se expirar, use Reconectar. O sistema registra `/api/webhooks/evolution` com cabeçalho `x-webhook-secret` e os eventos `CONNECTION_UPDATE`, `QRCODE_UPDATED`, `MESSAGES_UPSERT`, `MESSAGES_UPDATE` e `SEND_MESSAGE`.

O navegador recebe somente o QR e dados de conexão, nunca a API Key. O webhook exige segredo inclusive para eventos de conexão. Versões que não encaminham cabeçalhos personalizados precisam ser atualizadas/configuradas; não remova a autenticação do webhook para contornar essa limitação.

Endpoints usados: `/instance/create`, `/instance/connect/:instance`, `/instance/connectionState/:instance`, `/instance/fetchInstances`, `/instance/logout/:instance`, `/webhook/set/:instance`, `/message/sendText/:instance` e `/chat/findMessages/:instance`.

A integração foi testada com servidor HTTP controlado, não com uma instância externa real neste ambiente. O pareamento, payloads específicos da sua versão, entrega real e disponibilidade dos webhooks precisam de validação com sua instalação. A recepção identifica conversas pessoais com JID `@s.whatsapp.net`; instalações que usam apenas LID precisam fornecer o mapeamento para telefone antes da operação real. Grupos e mídia não são processados como opt-out textual.

A conexão Baileys não é uma integração oficial da Meta. Pode sofrer desconexões, incompatibilidades e bloqueios de conta. Não há mecanismo de evasão de limites ou bloqueios. Avalie a API oficial para produção e respeite as políticas do WhatsApp e a LGPD. Intervalos aleatórios não garantem proteção contra bloqueios nem substituem consentimento.

## 4. Importar da Maria

1. Em **Importar Planilha**, baixe o modelo ou envie um CSV/XLSX.
2. Confira a prévia e mapeie Nome e Telefone. Mapeie também status, produto, carrinho, data do abandono, pedido e consentimento quando existirem.
3. Datas devem estar em ISO, como `2026-10-25`; datas ambíguas são rejeitadas. Números nacionais de 10/11 dígitos recebem somente DDI 55; não se inventa o nono dígito ou DDD.
4. Confirme e confira totais, duplicados e erros. Baixe o relatório para corrigir a origem.

`sim`, `true`, `1`, `yes` e `autorizado` representam consentimento comercial explícito na coluna escolhida. A origem e o valor informado são registrados para auditoria. Coluna ausente ou vazia não concede consentimento. O operador deve assegurar que a autorização tenha base e evidência válidas; um arquivo importado não cria autorização por si só.

O primeiro registro de cada telefone prevalece dentro do mesmo arquivo. Em uma nova importação, telefones existentes atualizam o status do funil e o consentimento **explicitamente informado**; nome, produto e demais dados são preservados. Valores negativos explícitos revogam autorização. Exclusões permanentes nunca são removidas pela importação.

Status `comprou`, `pago`, `purchased`, `paid`, `concluído` e `concluido` impedem entrada e processamento na fila. Para outros status da Maria, confirme a compra no painel ou adapte o mapeamento de origem com requisitos reais do sistema. O formato/API de pedidos da Maria não foi fornecido: não existe sincronização automática externa de pedidos.

A lista de contatos mostra até 1.000 registros, ordenados pelos mais recentes. A campanha sem seleção manual considera todos os elegíveis do banco, incluindo os fora dessa página. Importe dados reais somente após definir retenção e acesso adequados à sua operação.

## 5. Mensagens, simulação e campanhas

1. Salve até quatro mensagens habilitadas. Variáveis permitidas: `{{nome}}`, `{{produto}}`, `{{link}}`. Uma variável sem valor em qualquer contato selecionado bloqueia a criação; revise antes de iniciar.
2. Inclua orientação de descadastro, por exemplo **Responda SAIR para parar**. As respostas SAIR, PARAR, PARE, STOP, CANCELAR, REMOVER, DESCADASTRAR e NÃO QUERO são reconhecidas no começo do texto.
3. Configure intervalos de 1 a 3.600 segundos, horários de São Paulo e limites. Padrões: 15–50 segundos, 08h–20h, 30/hora, 100/24h e sete dias entre contatos. Limites são janelas móveis, compartilhados por conta, inclusive entre campanhas.
4. Crie campanha em modo **Simulação**. Ela nasce como rascunho. Use o ícone de prévia para revisar o conteúdo registrado no histórico e depois clique Iniciar.
5. A simulação respeita elegibilidade, fila e intervalos, sem chamadas ao provedor; ignora janelas e limites de envio real para poder testar a qualquer hora. Resultados aparecem como Simulado, separados das métricas reais.
6. Para envio real, o administrador precisa configurar **ambas** `SIMULATION_MODE=false` e `REAL_SEND_ENABLED=true`, conectar WhatsApp e criar uma campanha explicitamente em modo real. Alterar flags não transforma campanhas simuladas em reais. Este desenvolvimento não realizou envios reais.

As variações são escolhidas com `crypto.randomInt`, independentemente para cada contato. Não há cotas de 25%. O conteúdo e o slot ficam registrados na criação; editar mensagens depois não altera uma campanha existente.

Pausar preserva pendentes. Continuar exige autorização manual e conexão válida. Cancelar é terminal para pendentes. Uma requisição já em trânsito pode terminar: não é possível recolher uma mensagem aceita pelo provedor.

## 6. Worker, persistência e falhas

Com Supabase/PostgreSQL, execute em processos separados e no mesmo diretório, com as mesmas variáveis:

```sh
npm run db:migrate
npm run build
npm start
# Em outro terminal ou serviço supervisionado:
npm run worker
```

Use um serviço Node persistente para o worker (por exemplo contêiner ou supervisor com reinício automático). O worker não deve ser hospedado como função HTTP temporária. O navegador pode ser fechado.

`FOR UPDATE SKIP LOCKED` e uma lease persistente de 90 segundos serializam o processamento por instância. O timeout por chamada de provedor é de 20 segundos. O worker registra `sending` antes da chamada; se cair nessa janela, o job antigo vira `unknown` após 90 segundos e a campanha pausa. O progresso e o intervalo persistem no banco. Na reserva é gravado um próximo horário conservador (intervalo mais a lease), evitando perder a espera se o processo cair antes de finalizá-la.

HTTP 429 é uma rejeição conhecida: pode ser reprogramada com backoff exponencial e máximo configurado (1–5 tentativas). Rejeições definitivas viram falha. Timeout, erro de rede ou HTTP 5xx após iniciar um envio são **resultado desconhecido** e nunca são repetidos automaticamente. Falha ao consultar conexão, antes do envio, pausa a campanha mantendo o job pendente.

Não há promessa de entrega exatamente uma vez oferecida pela Evolution API. A abordagem evita reenvio automático ambíguo. Para reconciliar, consulte o ID no provedor e informe-o no histórico: o servidor verifica destinatário, conteúdo e horário junto à Evolution. Sem confirmação verificável, o job permanece bloqueado; é possível cancelar a campanha, mas não forçar um retry que possa duplicar mensagens.

Estados: pendente → processando → envio solicitado → enviado → entregue → lido → respondido. Há também simulado, excluído, cancelado, falhou e desconhecido. A aceitação HTTP não inventa entrega ou leitura. Confirmações vêm dos eventos do provedor; eventos antecipados são conciliados após registrar o ID.

## 7. Resultados e compras

Indicadores agregam o banco, não dados fictícios. Dashboard e histórico atualizam a cada cinco segundos. Relatórios por modelo incluem o total de utilizações da fila e discriminam simulações. CSV exporta até 10.000 registros filtrados; o painel exibe até 1.000 envios e 200 campanhas mais recentes.

Entrega = entregues/enviados; resposta = respondidos/enviados; falha = falhas/(enviados+falhas). Sem denominador, aparece `—`.

Em **Contatos → Confirmar compra**, informe uma compra verificada, data/hora e a fonte/identificador real do pedido na Maria ou em outro sistema. A ação é auditada e exclui pendentes. Compras confirmadas depois de um envio real entram na métrica de recuperação por associação temporal. Uma resposta no WhatsApp não é venda e associação temporal não prova causalidade. O total geral conta contatos únicos; somas por campanha podem repetir o mesmo contato.

## 8. Testes e verificação

```sh
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

Os testes usam PostgreSQL embarcado real (PGlite), sem credenciais externas e sem disparos. Cobrem CSV/XLSX, mapeamento, telefones, duplicados, consentimento/revogação, templates, intervalos, pausa/retomada/cancelamento, fila persistente em disco, concorrência, timeout, retry, desconexão, eventos, isolamento por conta e RLS. O adaptador Evolution é testado contra um servidor HTTP local controlado.

O teste Playwright percorre o painel em desktop/mobile, autenticação, proteção de rotas/Origin/webhook, importação, mensagens, campanha simulada e exportação. Use **banco de testes vazio e isolado**, pois cria contatos explicitamente fictícios de teste:

```sh
# Pare o servidor de desenvolvimento antes: não use duas instâncias no mesmo checkout.
APP_URL=http://localhost:3000 LOCAL_DATABASE_PATH=.data/e2e-db npm run dev
# Outro terminal:
npm run test:e2e
```

O teste lê apenas a credencial de desenvolvimento gerada por `local:setup`. Não execute contra um servidor com dados reais. O Chromium do ambiente fica em `/usr/bin/chromium`; em outra máquina ajuste `CHROMIUM_PATH` ou instale o navegador e altere a configuração Playwright. Resultados e capturas ficam em `.data/` e não são versionados. Antes de repetir o teste, pare o servidor e use outro diretório de banco vazio, preservando bancos com dados úteis.

### Validação realizada neste ambiente

- Build de produção e TypeScript passaram.
- Testes de domínio, banco, worker e adaptador HTTP passaram; consulte `npm test` para a contagem atual.
- Fluxo completo Playwright passou em Chromium, incluindo layout móvel sem overflow horizontal e simulação sem envio real.
- Auditoria das dependências de produção sem vulnerabilidades conhecidas no momento da execução. ExcelJS usa override de uuid corrigido, validado nos testes de XLSX.
- **Não validado com serviços externos:** Supabase Auth/PostgreSQL hospedado, QR/pareamento real, webhooks da instalação Evolution e pedidos externos Maria. As credenciais e URLs não estavam presentes. O modo local e os testes controlados não demonstram essas operações externas.

## 9. Organização

```text
src/app/                 Páginas, estilos e Route Handlers autenticados
src/components/          Painel e formulários responsivos
src/features/            Importação, schemas Zod, regras e CSV seguro
src/hooks/               Cliente HTTP e atualização automática
src/lib/                 Banco, autenticação, erros e worker local
src/repositories/        Persistência, campanhas, exclusões e auditoria
src/services/            Evolution API e processamento de webhooks
src/workers/             Worker independente e processador de fila
src/types/               Tipos compartilhados
supabase/migrations/     Esquema, índices, FKs, unicidade, view e RLS
scripts/                 Migrations e preparação local segura
tests/                   Regras, integração PostgreSQL e navegador
```

## 10. Pendências para sua operação real

Configure Supabase, usuários autorizados, URL e credencial Evolution, segredo de webhook e origem HTTPS. Autorize os destinos reais de rede nas configurações cloud quando definidos, incluindo o banco/pooler e as origens HTTPS necessárias. O segredo do webhook deve existir nos dois lados. A conectividade do banco usa protocolo PostgreSQL, não uma requisição HTTPS que possa substituir placeholders de credencial.

Valide o contrato da sua Evolution e a origem de confirmação de pedidos da Maria antes de autorizar campanhas reais. Mantenha backups e um processo de retenção/eliminação dos dados pessoais conforme a base legal da sua operação. Não exponha nem copie credenciais para código, logs ou chat.

O código-fonte está no repositório `mtsgodinho/remarketink-tecview`. Enviar código ao GitHub, publicar o ambiente cloud e implantar a aplicação são ações distintas; salvar o rascunho do ambiente não implanta a aplicação.
