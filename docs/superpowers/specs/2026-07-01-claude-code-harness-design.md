# Design: Adicionar `claude -p` (Claude Code CLI) como harness default do Tamandua

- **Data:** 2026-07-01
- **Status:** Aprovado (aguardando revisão do spec escrito)
- **Autor:** Daniel Heler Pohlmann + Claude

## 1. Contexto e objetivo

O Tamandua orquestra times de agentes de IA através de workflows determinísticos. Cada
rodada de polling de um agente executa hoje o harness **pi** (`pi --print --mode json
--no-session <prompt>`). Existe também um harness **hermes** (alpha, lento, contabilidade
de tokens quebrada).

O objetivo é **adicionar o Claude Code CLI (`claude -p`) como um novo harness e torná-lo
o default**, mantendo `pi` e `hermes` como opções selecionáveis por flag. A abstração
multi-harness (`HarnessType`) é preservada — a mudança é de baixo risco e reversível.

### Princípio norteador

A mudança fica **concentrada na camada de execução do harness** (`src/installer/`) mais
CLI/MCP e docs/testes. Os 23 workflows e as personas (`AGENTS.md`/`IDENTITY.md`/`SOUL.md`)
**não mudam**: todos os workflows usam `model: default` (agnóstico de provider) e nenhuma
persona referencia o pi.

### Decisões tomadas no brainstorming

1. **Escopo:** adicionar `claude` como default, mantendo `pi`/`hermes` (abstração
   multi-harness preservada).
2. **Permissões:** autonomia total via `--dangerously-skip-permissions`, sem restrição
   de ferramentas por role (paridade com o comportamento atual do pi).
3. **Formato de saída:** `--output-format json` (objeto único com `.result` e `.usage`),
   evitando o parser de stream do pi.

## 2. Invocação do claude

Nova função `runClaude(prompt, options)` em `src/installer/agent-scheduler.ts`, espelhando
`runHermes` (mesmo contrato: recebe prompt + opções, retorna `Promise<string>`).

Comando:

```
claude -p "<pollingPrompt>" \
  --output-format json \
  --dangerously-skip-permissions \
  [--model <model>]
```

Comportamento:

- **cwd** = `workingDirectoryForHarness` (worktree ou diretório direto) — igual ao pi.
- **stdin** fechado imediatamente após o spawn; o prompt vai como argumento posicional
  após `-p`.
- **Sessão fresca por rodada:** omitimos `--resume`/`--continue`. Cada invocação inicia
  uma sessão nova (contexto limpo), equivalente ao `--no-session` do pi.
- **`--model`:** passado **apenas** quando o modelo resolvido for concreto
  (≠ `"default"` e não-vazio). Como todos os workflows usam `model: default`, na prática
  o claude usa o modelo configurado no ambiente — igual ao pi hoje, que nem passa
  `--model`. É um pequeno ganho opcional para workflows que definam um modelo concreto.
- **Gerenciamento de processo:** idêntico ao pi/hermes — `spawn` com `detached: true`,
  kill de process-group (`SIGTERM` → `SIGKILL` após 5s) em timeout, caps de stdout/stderr
  (10MB), callback `onSpawn` para registrar pid/pgid em `inFlightChildren`.
- **Env vars** injetadas: `TAMANDUA_WORKER_JOB_ID`, `TAMANDUA_WORKER_PID` e
  `TAMANDUA_CLAUDE_BINARY` (o caminho resolvido do binário).

> **Validação na implementação:** os flags serão confirmados contra `claude --help` da
> máquina antes de finalizar. `--print`/`-p`, `--output-format json` e
> `--dangerously-skip-permissions` são estáveis; qualquer ajuste de nome será feito
> nessa etapa.

## 3. Parsing da saída (`--output-format json`)

Com `--output-format json`, o stdout do claude é **um único objeto JSON** no final, com
o formato (campos relevantes):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "<texto final do assistente>",
  "session_id": "...",
  "total_cost_usd": 0.0,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

- `runClaude` bufferiza o stdout, valida que é JSON e o **retorna como string** (mantendo
  o contrato `Promise<string>` dos demais harnesses). O `pi-stream-parser.ts` **não é
  usado** pelo claude.
- `parsePollingRoundMetadata` (em `agent-scheduler.ts`) é **estendido** para reconhecer o
  objeto-resultado do claude:
  - `assistantOutput` ← campo `.result` (texto final → alimenta
    `classifyPollingRoundOutcome` para detectar `HEARTBEAT_OK` / `STATUS: done` /
    `STATUS: fail`).
  - `tokenUsage` ← `.usage` via `extractTokenUsage`.
  - `runId`/`stepId` continuam vindo primariamente do CLI (`step complete`/`step claim`),
    com o fallback de regex sobre o texto.
- `extractTokenUsage` tem as listas de chaves **estendidas** para incluir os nomes do
  claude: `cache_creation_input_tokens` (cache write) e `cache_read_input_tokens`
  (cache read), somados a `input_tokens` + `output_tokens`.
- `attributePollingRoundTokenUsage` e `autoCompleteStepIfRunning` **não mudam** — recebem
  o `PollingRoundMetadata` já normalizado.

## 4. Roteamento e default

- `src/installer/types.ts`: `export type HarnessType = "pi" | "hermes" | "claude";`
- **O default passa a ser `"claude"`** nos três readers:
  - `getRunHarnessType` (`run-harness.ts`) — retorna `"claude"` quando não há
    `harness_type` no contexto; `"hermes"`/`"pi"` quando explícito.
  - `createAgentCronJob` (`agent-scheduler.ts`) — lê `ctx.harness_type`; default `claude`.
  - `buildPollingRoundContext` (`agent-scheduler.ts`) — `job.harnessType ?? "claude"`.
- `executePollingRound` (`agent-scheduler.ts`): novo branch
  `if (harnessType === "claude") { output = await runClaude(...) }` antes dos branches
  de hermes/pi.
- `findClaudeBinary()` (`agent-scheduler.ts`): espelha `findPiBinary` — respeita
  `TAMANDUA_CLAUDE_BINARY` (validando `X_OK`), senão procura `claude` no `PATH`. Mensagem
  de erro aponta para instalação do Claude Code ou o env var.
- `validateRunHarnessForScheduling` (`run-harness.ts`): quando
  `harness_type === "claude"`, valida a disponibilidade do binário via `findClaudeBinary()`
  (fail-fast no momento do scheduling, como já é feito para hermes). Como `claude` é o
  novo default, essa validação cobre a maioria dos runs.

## 5. CLI / MCP / flags

- `src/cli/workflow-run-args.ts`:
  - `WorkflowRunArgs.harnessAs?: "pi" | "hermes" | "claude"`.
  - Nova flag `--claude-as-harness`.
  - A verificação de mutualidade passa a cobrir as **três** flags (especificar mais de
    uma é erro).
- `src/cli/cli.ts`:
  - Texto de help/usage atualizado; `--claude-as-harness` documentado como **default**.
  - Quando nenhuma flag de harness é passada, `harnessType` fica `undefined` e os readers
    assumem `claude` (não é necessário escrever `harness_type` no contexto para o default).
  - O mapeamento `runArgs.harnessAs → harnessType` aceita `"claude"`.
- MCP (`src/server/mcp-server.ts`) e a documentação das ferramentas MCP: se/onde houver
  seleção de harness, incluir `claude` como opção/valor default.

## 6. Fix de install para ambientes "claude-only"

`src/installer/install.ts:243` chama `await readPiConfig()`, que **lança** se
`~/.pi/agent/settings.json` não existir. Isso quebraria `workflow install` para usuários
que só têm o claude instalado.

**Correção:** tornar essa leitura **best-effort** — envolver em `try/catch`, registrar em
nível `debug` quando ausente, e seguir o fluxo. A config do pi só é lida "para
referência" e nunca é modificada, então a ausência é inofensiva.

## 7. Documentação

- **README.md:**
  - Seção "Harness Selection": adicionar `--claude-as-harness` e marcá-lo como **default**
    (remover a marcação de default do `--pi-as-harness`).
  - Seção "Requirements": Claude Code CLI (`claude`) como requisito principal; pi passa a
    ser opcional (necessário só com `--pi-as-harness`).
  - Diagrama mermaid "How It Works": `pi --print` → `claude -p` no nó do harness.
  - Texto de intro/"Origins": ajustar referência ao pi como base de execução default.
- **skills/tamandua-agents/SKILL.md** e qualquer doc que cite `pi --print` como o
  mecanismo de execução.
- **Nomenclatura de arquivos:** manter os nomes `pi-*.ts` (`pi-command-preview.ts`,
  `pi-stream-parser.ts`, `pi-config.ts`) por ora, para minimizar o diff e o risco. Uma
  renomeação para nomes harness-agnósticos pode ser feita em uma fase futura separada.
  O `pi-command-preview.ts` é reutilizado para o preview/redação do comando do claude
  (o `-p` já é tratado como flag-com-valor a ser redigida).

## 8. Testes

### Novos

- Construção do comando `runClaude` (flags corretas, cwd, env, prompt posicional).
- Parsing do objeto-resultado do claude em `parsePollingRoundMetadata`: extração de
  `.result` como `assistantOutput` e de `.usage` como `tokenUsage`, **incluindo** cache
  tokens (`cache_creation_input_tokens`/`cache_read_input_tokens`).
- Roteamento: `executePollingRound` despacha para `runClaude` quando
  `harnessType === "claude"`.
- `findClaudeBinary`: env override + busca no PATH + erro quando ausente.
- Default = `claude` em `getRunHarnessType`, `createAgentCronJob`,
  `buildPollingRoundContext`.
- `validateRunHarnessForScheduling` valida o binário do claude quando o harness é claude.

### Atualizados

- Testes que afirmam default `"pi"`:
  - `agent-scheduler-harness-routing.test.ts` (default agora `claude`).
  - `run-harness.test.ts` (`getRunHarnessType` default).
  - Quaisquer asserts de `buildPollingRoundContext`/`createAgentCronJob`.
- Flags/mutex: `cli.test.ts` e testes de `workflow-run-args` (adicionar
  `--claude-as-harness`, mutex das três flags, default sem flag).
- Docs-tests: `readme-hermes-docs.test.ts`, `skill-hermes-docs.test.ts`,
  `readme-mcp-tools.test.ts`, `readme-workflow-catalog.test.ts` e afins — ajustar
  asserts da seção de harness/requirements para refletir o claude como default.

## 9. Riscos e trade-offs

- **Side-effect de migração:** runs antigos sem `harness_type` no contexto passam a
  resumir como `claude`. Aceitável para um novo default major; documentado. (Runs que
  gravaram `harness_type: "pi"|"hermes"` explicitamente continuam no harness escolhido.)
- **Schema stream-json não-documentado:** evitado ao usar `--output-format json`, cujo
  objeto-resultado é estável e documentado.
- **Cross-platform:** a descoberta de binário e os process-groups (`detached`,
  `kill(-pgid)`) permanecem Unix-only, como todo o resto do projeto. Fora de escopo.
- **Flags do claude:** confirmados na implementação contra `claude --help`; risco baixo,
  pois os flags usados são estáveis.

## 10. Arquivos afetados (resumo)

| Arquivo | Mudança |
|---------|---------|
| `src/installer/types.ts` | `HarnessType` += `"claude"` |
| `src/installer/agent-scheduler.ts` | `runClaude`, `findClaudeBinary`, branch de roteamento, default `claude`, `extractTokenUsage` estendido, `parsePollingRoundMetadata` reconhece o objeto do claude |
| `src/installer/run-harness.ts` | default `claude` em `getRunHarnessType`; validação do binário claude |
| `src/cli/workflow-run-args.ts` | flag `--claude-as-harness`, mutex das três, tipo `harnessAs` |
| `src/cli/cli.ts` | help/usage, mapeamento `harnessAs → harnessType` |
| `src/installer/install.ts` | `readPiConfig()` best-effort |
| `src/server/mcp-server.ts` | seleção de harness inclui `claude` (se aplicável) |
| `README.md`, `skills/tamandua-agents/SKILL.md` | docs: harness default, requirements, diagrama |
| `tests/**`, `src/**/*.test.ts` | novos + atualizados conforme seção 8 |
