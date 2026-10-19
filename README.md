# procman

Um gerenciador de processos: **daemon de longa vida + CLI curto**, conversando por um
socket local com JSON de uma linha por mensagem. **Zero dependências de runtime** —
só a biblioteca padrão do Node (>= 20).

> O nome é `procman` e vive em um lugar só: `NAME` em `lib/constants.js`. Todo o resto
> deriva daí (`~/.procman`, prefixos de env `PROCMAN_*`, título do processo, unidade de
> boot). Para renomear: `NAME`, o campo `bin` do `package.json` e `bin/procman.js`.
> Apenas o nome **no registro npm** é diferente (`procmand`, porque `procman` já era de
> outro projeto) — isso não muda comando, estado nem variáveis de ambiente.

## O que tem dentro

Comandos:

| Comando | O que faz |
|---|---|
| `start <arquivo\|config>` | sobe um script ou todos os apps de um ecosystem file |
| `list` (`ls`) | lista os processos, com a porta que cada um abriu (`--json`, `--namespace`) |
| `describe <nome\|id>` | todos os detalhes de um processo (JSON) |
| `stop` / `restart` / `reload <nome\|id\|all>` | parada graciosa, reinício, reload sem downtime |
| `delete <nome\|id\|all>` | para e esquece |
| `scale <nome\|id> <n>` | cresce/encolhe um app em cluster (`0` = um por CPU) |
| `logs <nome\|id>` | imprime e segue os logs (`--lines`, `--follow`, `--out`, `--err`) |
| `monit` | visão ao vivo no terminal (`--interval`, `--sort`) |
| `save` / `resurrect` | persiste a lista / replay dela (usado no boot) |
| `ping` | confirma que o daemon responde |
| `kill` | para tudo e encerra o daemon |
| `web` | dashboard HTTP embutido, só em loopback (`--port`, `--stop`) |
| `startup` | gera (ou instala com `--install`) a unidade de boot systemd/launchd |
| `version` / `help` | versão e ajuda |

Recursos: fork mode e **cluster mode** com balanceamento round-robin e **reload sem
janela de indisponibilidade**, restart automático com orçamento de instabilidade,
`--watch`, `--cron`, `--max-memory-restart`, `--wait-ready`, namespaces, ecosystem
files, logs por app **com rotação por tamanho e gzip opcional**, streaming de logs,
save/resurrect idempotente, boot via systemd/launchd, **descoberta automática da porta
que cada app abre** (sem o app precisar avisar), um dashboard local e uma TUI
(`monit`).

## Instalando

```bash
npm install -g procmand   # no npm o pacote se chama procmand
procman --help            # o comando continua sendo procman
```

O pacote se chama `procmand` (o nome `procman` no npm já era de outro projeto), mas
comando, diretório de estado (`~/.procman`) e prefixos de ambiente (`PROCMAN_*`)
seguem `procman`. Não há `postinstall` nem `dependencies`: nada é baixado ou compilado
na instalação, e `~/.procman` só aparece no primeiro uso.

Do clone, sem instalar nada — troque `procman` por `node bin/procman.js`:

## Uso

```bash
node bin/procman.js start ./examples/app.js --name web -- --label alpha
node bin/procman.js list
node bin/procman.js logs web --follow
node bin/procman.js restart web
node bin/procman.js delete web
node bin/procman.js kill            # para tudo e encerra o daemon
```

`examples/` só existe no clone do repositório (não vai no pacote publicado): com uma
instalação global, troque `node bin/procman.js` por `procman` e aponte para o seu
próprio arquivo.

Comandos que recebem um alvo (`describe`, `stop`, `restart`, `reload`, `delete`,
`logs`, `scale`) aceitam **id** (`0`), **nome** (`web`), `namespace:nome`
(`staging:web`) ou o **caminho do script** (`./examples/app.js`). Caminhos relativos
são resolvidos pelo cliente, contra o diretório de quem chamou — o daemon roda com
`cwd` no diretório de estado.

Cluster com 4 instâncias na mesma porta (round-robin do `node:cluster`):

```bash
node bin/procman.js start ./examples/http.js --name api -i 4 -- --port 3000
node bin/procman.js reload api      # substitui os workers um a um, sem downtime
node bin/procman.js scale api 2
```

Ecosystem file:

```bash
node bin/procman.js start examples/ecosystem.config.js --env production
```

O formato aceito é o mesmo do `ecosystem.config.js` original (`apps: [...]`, chaves
em snake_case ou camelCase), então um arquivo escrito para o PM2 normalmente funciona
sem alteração. Caminhos relativos dentro de um app são resolvidos contra o `cwd`
**daquele app** — que por sua vez é relativo ao diretório do arquivo de configuração.
Ou seja, `{ cwd: './backend', script: 'src/server.js' }` aponta para
`<config>/backend/src/server.js`, como se espera. A exceção é `ignore_watch`, cujos
itens são casados por substring do caminho absoluto (`node_modules`, `.git`).

Visão ao vivo (TUI sem dependências; `q` sai, `c`/`m`/`n`/`i` ordenam, setas
selecionam, e o painel de baixo segue os logs do processo selecionado):

```bash
node bin/procman.js monit
node bin/procman.js monit --interval 500 --sort mem
```

`monit` é **só leitura** de propósito: um monitor que também mata coisas é uma
armadilha para quem está apenas olhando um pico. Quando a saída não é um terminal ele
imprime um retrato e sai.

### Opções de `start`

```
-n, --name <nome>                nome exibido na listagem
    --namespace <ns>             agrupa processos
    --cwd <caminho>              diretório de trabalho do app
-o, --output <arq>               arquivo de stdout
-e, --error <arq>                arquivo de stderr
    --interpreter <caminho>      interpretador (padrão: o node atual)
-i, --instances <n|max>          instâncias em cluster (0/max = um por CPU)
    --mode <fork|cluster>        modo (padrão fork; `-i` implica cluster)
    --config                     trata o argumento como ecosystem file
    --env <nome>                 sobrepõe env_<nome> do ecosystem
    --restart-delay <ms>         atraso antes do restart automático
    --max-restarts <n>           restarts instáveis antes de desistir (padrão 16)
    --min-uptime <ms>            uptime que conta como estável (padrão 1000)
    --kill-timeout <ms>          espera antes do SIGKILL (padrão 1600)
    --listen-timeout <ms>        espera pelo "listening"/"ready" (padrão 4000)
    --no-autorestart             não reinicia quando o app sai
    --stop-exit-codes <a,b>      códigos de saída que não disparam restart
    --watch                      reinicia a cada mudança de arquivo
    --watch-path <caminho>       o que vigiar (repetível; padrão: o script)
    --ignore-watch <substr>      ignora caminhos que casam (repetível)
    --cron <expr>                restart por cron de 5 campos
    --max-memory-restart <tam>   reinicia acima desse RSS (ex.: 200M, 1G)
    --time                       prefixa cada linha de log com timestamp
    --log-date-format <fmt>      padrão do timestamp (YYYY MM DD HH mm ss SSS)
    --no-merge-logs              um arquivo de log por instância (padrão: um por app)
    --log-rotate-size <tam>      rotaciona acima desse tamanho (ex.: 10M)
    --log-rotate-keep <n>        gerações rotacionadas a manter (padrão 5)
    --log-rotate-compress        comprime as gerações com gzip
    --wait-ready                 só retorna quando o app sinaliza que está pronto
```

### Prontidão e reload

Um app pode declarar que está pronto mandando uma mensagem por IPC:

```js
// depois de listen()/warm-up
if (process.send) process.send('ready');
```

Com `--wait-ready`, o `start` só retorna depois disso, e o `reload` usa a mesma espera
antes de aposentar o worker antigo. Não é preciso o app enviar nada: qualquer app que
abra uma porta TCP conta como pronto assim que o socket está de fato escutando (é a
mesma informação usada para descobrir a porta). O limite é o `--listen-timeout`: um app
que nunca sinaliza não trava o comando, apenas gasta o timeout.

### Logs

Um arquivo por app (`logs/<id>-<nome>-{out,err}.log`), compartilhado por todas as
instâncias. Com `--no-merge-logs` cada instância ganha o seu (`...-out-0.log`), e aí é
possível separar a saída de N workers; nesse caso o `logs` marca cada linha com o slot
(`web | [1] ...`). O app recebe `NODE_APP_INSTANCE` e `PROC_INSTANCE` com o índice.

Rotação é opcional e por app: com `--log-rotate-size 10M --log-rotate-keep 5
--log-rotate-compress`, o arquivo é fechado, renomeado para `<arquivo>.<timestamp>`
(comprimido, se pedido) e reaberto; nada é escrito durante a troca sem ser enfileirado
antes, então nenhuma linha se perde no meio. Sem `--log-rotate-size` os arquivos
crescem sem limite.

Em ecosystem files, as mesmas opções aparecem como `log_date_format`, `merge_logs`,
`log_rotate_size`, `log_rotate_keep`, `log_rotate_compress` e `wait_ready` (snake_case
ou camelCase, como todas as outras).

### Portas

O `procman` descobre sozinho a porta que o app abre — o app não precisa avisar nada.
Todo servidor TCP do Node (`http`, `https`, `net`, e portanto Express, Fastify, Koa e o
dev server do Vite) passa por `net.Server#listen`, e o wrapper do container intercepta
esse ponto, lê `server.address()` e reporta a porta ao supervisor por IPC. Isso cobre
inclusive o caso em que o app pede `port 0` e o sistema escolhe uma porta livre.

A porta aparece no `list` (coluna `port`), no `describe` (`port` e `ports`) e no
dashboard, onde cada porta é um link. Um app que abre mais de uma porta mostra todas
(`41700,41701`); em cluster, as N instâncias que compartilham o mesmo listener contam
como **uma** porta, não N. Quando o processo morre a porta é esquecida junto: um app
parado não anuncia uma porta que não está mais escutando.

### Dashboard

`procman web` sobe um dashboard em `127.0.0.1:9615` (só loopback, sem autenticação):
tabela ordenável por qualquer coluna, filtro por nome/namespace/script, seleção por
namespace, barra de memória quando há `--max-memory-restart`, pausa do refresh
automático (que também para sozinho com a aba em segundo plano) e as ações `restart`,
`stop`, `reload`, `scale`, `info` e `delete` na própria linha. Cada processo tem os logs
ao vivo (com seguir/ir-ao-fim e linhas de erro destacadas) e um painel de detalhes
(`cwd`, `args`, portas, arquivos de log).

A página é servida com `Cache-Control: no-store` e uma CSP restritiva com **nonce**
(nada de `unsafe-inline` para script): mesmo sendo um serviço local sem autenticação,
ela não executa script injetado.

### Quem pode subir o daemon

| Comando | Sem daemon rodando |
|---|---|
| `ping`, `start`, `resurrect`, `web` | sobe o daemon automaticamente |
| `list` | imprime tabela vazia (`[]` no `--json`), não sobe nada |
| `describe`, `stop`, `restart`, `reload`, `delete`, `scale`, `logs`, `monit`, `save`, `web --stop` | falha com `daemon is not running` |
| `kill` | informa que não está rodando e sai com 0 |

Comandos de leitura e de parada **não** criam daemon. `resurrect` cria, porque é ele
que roda no boot; `kill` **espera o daemon realmente morrer** antes de retornar (senão
o próximo comando de um script falaria com um daemon em desligamento).

## API programática

```js
const procman = require('./index.js');

await procman.connect();
await procman.start({ script: './server.js', instances: 4, mode: 'cluster' });
console.log(await procman.list());

// lifecycle methods return an array: a target can match several processes
// (duplicate names, or `all`), and `ns:name` selects a namespace explicitly.
const [stopped] = await procman.stop('server');
console.log(await procman.describe('staging:server'));

procman.subscribe({ target: 'server' }, (kind, payload) => console.log(kind, payload));
await procman.startEcosystem('./ecosystem.config.js', { env: 'production' });
await procman.save();
await procman.killDaemon();
```

Erros trazem um `code` estável: `NO_DAEMON`, `NOT_FOUND`, `AMBIGUOUS`,
`SCRIPT_NOT_FOUND`, `SHUTTING_DOWN`.

## Onde ficam os arquivos de estado

`PROCMAN_HOME` ou `~/.procman`:

```
daemon.sock   endpoint IPC (named pipe no Windows)
daemon.pid    pid do daemon
daemon.log    stdout/stderr do daemon
dump.json     lista salva por `save`, usada por `resurrect`
logs/         <id>-<nome>-{out,err}.log  e, se rotacionado, <...>.log.<timestamp>[.gz]
pids/         <id>-<nome>.pid  (um pid por linha, no cluster)
```

`PROCMAN_DEBUG=1` liga o log de debug (CLI e daemon; no daemon, veja `daemon.log`).

## Arquitetura

```
bin/procman.js
   └─ lib/cli.js                 parse de args, tabela, comandos
        └─ lib/client.js         conecta no socket; probe tri-estado; sobe o daemon
             └─ lib/daemon.js    servidor JSON-por-linha, pidfile, fanout de eventos
                  └─ lib/supervisor.js    tabela de processos + política de restart
                       ├─ lib/container.js       wrapper carregado no lugar do app
                       ├─ lib/logs.js            linhas, arquivos, rotação, eventos
                       ├─ lib/watch.js           fs.watch recursivo + debounce
                       ├─ lib/cron.js            parser/matcher de 5 campos
                       ├─ lib/monitor.js         amostragem de CPU/RSS
                       ├─ lib/treekill.js        mata a árvore de um worker
                       ├─ lib/ecosystem.js       ecosystem files (.js/.json)
                       ├─ lib/startup.js         systemd/launchd
                       └─ lib/dashboard.js       dashboard HTTP (loopback)
   └─ lib/monit.js               TUI ao vivo (só leitura), fala com o daemon pelo client
```

Decisões que valem explicação:

| Decisão | Motivo |
|---|---|
| Um request por conexão | O CLI não guarda estado; nada vaza se ele morrer. Só `subscribe` mantém a conexão aberta, para streaming. |
| Opções de start resolvidas no **cliente** | O daemon roda com `cwd` = diretório de estado; caminho relativo enviado a ele resolveria no lugar errado. |
| Wrapper (`lib/container.js`) em vez do script direto | Permite `process.title`, handshake `node_version` por IPC, `chdir` antes do app e reescrever `process.argv` (no cluster o argv real seria `[node, container.js]`). |
| Um wrapper só para fork e cluster | O cluster não aceita `argv` extra nem `cwd` por app; passar tudo por env mantém os dois modos idênticos. |
| `detached: true` (fork) | O app ganha o próprio process group → `process.kill(-pid)` mata a árvore inteira de uma vez. |
| Cluster via `node:cluster` | O daemon vira o primary: round-robin e reload gracioso saem de graça. O `cwd` por app vai por env, porque `setupPrimary` é global. |
| Matar árvore no cluster por `/proc` | Workers do cluster não são detached; `treekill` varre `/proc` e mata de baixo para cima. |
| Logs quebrados em **linhas** | O `--time` precisa prefixar cada linha (prefixar o chunk colocaria o timestamp no meio da frase) e o `logs --follow` só faz sentido por linha. |
| `process.kill(pid, 0)` para "vivo?" | Não existe `waitpid` no Node; sinal 0 só testa existência. |
| Dados desconhecidos retornam `null` | CPU/memória aparecem como `-` fora do Linux, em vez de mentir `0`. |
| `restarts` conta reinícios, não spawns | `pm2` infla esse número; aqui um restart de um app com N workers conta 1. |
| Rotação de log fecha → renomeia → reabre, com fila | Renomear com o arquivo aberto perderia a cauda do buffer; escrever enquanto rotaciona perderia linhas. A fila existe só para essa janela. |
| Nome da geração com timestamp + sufixo | Um burst rotaciona várias vezes no mesmo segundo; sem o sufixo as gerações sobrescreveriam umas às outras. |
| Prontidão por mensagem `ready` **e** por `listening` | São coisas diferentes: `listening` é fato do runtime (cluster), `ready` é declaração do app. O `--wait-ready` aceita as duas. |
| `monit` é só leitura | Um monitor com botões de matar é um acidente esperando para acontecer; `stop`/`restart` ficam no CLI, onde o alvo é explícito. |

### Concorrência e recuperação de socket

Dois cuidados que evitam a pior falha de um supervisor (perder o daemon e não notar):

1. **Nunca declarar um daemon vivo como morto.** `probe()` distingue três casos:
   `alive` (respondeu ao ping), `dead` (ninguém escutando: `ENOENT`/`ECONNREFUSED`)
   e `busy` (algo escuta mas não respondeu no prazo). Só `dead` autoriza remover o
   socket e subir outro daemon.
2. **Nunca roubar um endpoint alheio.** O daemon escreve o pidfile *depois* do `listen`
   bem-sucedido; se o bind falhar com `EADDRINUSE`, sai com 0 sem tocar no pidfile. Ao
   encerrar, só remove o pidfile se o conteúdo for o próprio pid.

### Reload: o que "sem downtime" significa aqui

`reload` em cluster sobe o substituto, espera o evento `listening` (ou uma mensagem
`ready`, se o app usar `--wait-ready`), **desconecta** o antigo (`worker.disconnect()`,
que tira o worker do pool de round-robin para ele não receber conexões novas) e só
então move para o próximo slot. Não existe instante com zero workers — e é isso que o
teste mede.

Medição do próprio teste (carga com concorrência 4 durante 2 reloads de um app com 3
instâncias):

```
34704 requisições ok, 0 ECONNREFUSED, 8 ECONNRESET
```

Ou seja: **não há janela de indisponibilidade** (nenhuma conexão recusada), e sobra um
resíduo de conexões já despachadas para o worker que está saindo (~0,02%). O mesmo
número em `restart` (que para antes de subir) inclui `ECONNREFUSED`, como esperado.
O teste assevera os `ECONNREFUSED` (devem ser 0) e apenas informa os resets.

## Testes

```bash
npm run smoke     # 107 asserções end-to-end com PROCMAN_HOME descartável
```

O smoke cobre: subida/reuso do daemon, socket/pidfile, fork mode, logs em arquivo,
resolução de alvo por id/nome/`namespace:nome`/caminho do script,
`describe` com `node_version` via IPC, morte por `SIGKILL` → restart, `restart`
explícito sem contar como instável, `stop` sem restart, `delete`, passthrough de args,
`cwd`, caminhos relativos, `--no-autorestart`, orçamento de restarts → `errored`,
**tree kill** (pai e filho), cluster com 3 instâncias, round-robin, **reload sem
ECONNREFUSED**, `scale` para cima e para baixo, `--watch` (uma edição → um restart),
`--max-memory-restart` (dispara e é throttled), parser de cron (incluindo rejeitar
expressões inválidas), `save`/`kill`/`resurrect` idempotente, ecosystem file com
`exec_mode: cluster` e namespace, geração da unidade de boot, dashboard (HTML, API com
porta, ação de restart, stop, CSP com nonce), **descoberta da porta** (inclusive `port
0` e cluster com listener compartilhado reportando uma única porta, mais o ciclo
stop/restart que a esquece e a redescobre), `logs --follow` entregando linhas ao vivo,
**rotação de logs
sem perder nenhuma das 600 linhas** (com compressão gzip e o limite de gerações),
`--log-date-format`, `--wait-ready` (espera de verdade, e o caso em que o app nunca
sinaliza), logs por instância com `--no-merge-logs`, o retrato do `monit` quando a
saída não é um terminal, erros de CLI sem substituir o daemon, e a checagem final de
que **nada sobra**: nem processos, nem socket, nem pidfile.

Prova manual da guarda de endpoint (um segundo daemon no mesmo socket não deve assumir
o controle):

```bash
export PROCMAN_HOME=/tmp/guard && rm -rf "$PROCMAN_HOME"
node bin/procman.js ping
ORIG=$(cat "$PROCMAN_HOME/daemon.pid")
PROC_DAEMON=1 node lib/daemon.js   # imprime "already owned by another daemon" e sai com 0
node bin/procman.js ping           # continua respondendo com ORIG
```

`scripts/hammer.js` mede o efeito de um comando sob carga:

```bash
node scripts/hammer.js http://127.0.0.1:3000/health 8000
```

## Limitações conhecidas

- **Cron**: 5 campos, sem segundos e sem nomes (`MON`, `JAN`). Expressões fora disso são
  rejeitadas no `start` em vez de agendadas errado.
- **`--max-memory-restart`**: a amostragem é de 1 s. Um app que aloca muito rápido
  ultrapassa o limite entre duas amostras (o restart acontece, mas depois do excesso).
  Há um cooldown de 10 s entre restarts por limite, para não virar tempestade.
- **YAML**: não suportado em ecosystem files. Um parser meia-boca seria pior que o erro
  claro que damos hoje — use `.js` ou `.json`.
- **`--watch`**: usa `fs.watch` recursivo, disponível no Linux a partir do Node 20. Os
  eventos são grosseiros (um editor pode gerar um único evento para uma subárvore) e o
  `--ignore-watch` casa por substring do caminho absoluto, não por glob. Também não há
  debounce configurável por app (fixo em 300 ms).
- **Tree kill**: a varredura de `/proc` é Linux. Em outros sistemas a parada de um
  worker em cluster cai para "matar só o pid".
- **Descoberta de porta**: cobre servidores TCP abertos no próprio processo Node. Um app
  que delega o `listen` a outro processo, a um addon nativo ou que roda em outro runtime
  (Python, Go) não reporta porta nenhuma — nesses casos o `list` mostra `-`.
- **`reload` espera `listening`/`ready`**: um app em cluster que nunca chama `listen()`
  nem manda `ready` faz o reload gastar `--listen-timeout` (padrão 4 s) por worker antes
  de aposentar o antigo. Use `restart` nesse caso, ou reduza o timeout.
- **Rotação é opt-in**: sem `--log-rotate-size` os arquivos crescem sem limite (como no
  PM2, que resolve isso com um módulo externo). O limite é checado *antes* de cada
  escrita, então o arquivo pode passar um pouco do tamanho pedido, e o nome da geração
  tem resolução de segundo (com sufixo quando há mais de uma rotação no mesmo segundo,
  o que só acontece em bursts).
- **`logs` com `--no-merge-logs`**: o `--lines` é um orçamento para a resposta inteira,
  dividido entre as instâncias; a intercalação entre arquivos diferentes é por slot, não
  cronológica (não há timestamp global para ordenar).
- **Dashboard sem autenticação**: escuta em `127.0.0.1` por padrão. Usar `--host`
  diferente disso emite um aviso, e é responsabilidade de quem chamou. A página vai com
  CSP de nonce e sem cache, mas a API em si não tem autenticação nenhuma.
- **Recursos do PM2 não implementados**: `startup` no Windows, `deploy`, módulos,
  `--watch` com globs, `log_date_format` com o formato `strftime` completo (aqui são
  tokens: `YYYY MM DD HH mm ss SSS ISO`), e o protocolo, que aqui é um JSON por linha
  simples (não há RPC bidirecional nem pub/sub arbitrário, só o canal de eventos de
  log/estado).

## Licença e procedência

MIT. Este projeto é uma **reimplementação independente**; não contém código do PM2.

Atenção: o PM2 é distribuído sob **AGPL-3.0**. Copiar qualquer trecho do código dele
(direta ou por dependências do vendor, como `pm2-axon`) sujeita este projeto à AGPL —
o que é incompatível com a licença pretendida aqui. Também não reutilize o nome ou a
marca "pm2".
