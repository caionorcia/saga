# SagaZap

Aplicativo de desktop (Windows) que lê as conversas (individuais e grupos) do WhatsApp do mentor dos últimos 30 dias, transcreve os áudios e sugere respostas para ele revisar, copiar ou enviar. Desde a 0.4.0 o app envia respostas, **só com a confirmação explícita do mentor a cada envio** e em ritmo lento. Desde a 0.6.0 também envia mensagens avulsas (fora das sugestões), pelo mesmo caminho e com as mesmas regras. Desde a 0.5.0, se o mentor ligar, envia ao Copiloto da Saga só as conversas dos mentorados cadastrados lá (contrato em `docs/superpowers/specs/2026-11-26-copiloto-integration.md`).

Para instalar no Windows, veja o [guia de instalação](docs/guia-instalacao.md).

## Desenvolvimento

Requisitos: Node 22.

```bash
npm ci
npm run dev          # abre o app com recarga automática
npm run preview:ui   # só a interface, no navegador (http://127.0.0.1:5199), com dados de demonstração
```

Para testar sem WhatsApp, rode o app com `SAGA_FAKE_WA=1` (dados de demonstração num banco temporário).

## Testes

```bash
npm test             # vitest
npm run typecheck
```

## Build do instalador

```bash
npm run build
npx electron-builder --win --publish never   # gera dist/SagaZap-Setup-<versão>.exe
```

O CI (`.github/workflows/ci.yml`) faz isso em `windows-latest` a cada push e guarda o `.exe` como artefato. Não há módulos nativos.

## Lançar uma versão

1. Atualize `version` em `package.json`.
2. Faça commit e envie uma tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. O workflow `release.yml` testa, compila e publica o instalador (e `latest.yml`, usado pelas atualizações) num GitHub Release.

As instalações existentes avisam "Nova versão disponível — Atualizar" (electron-updater, repositório público). O download é manual (clique) e a instalação acontece ao fechar o app, ou na hora com "Reiniciar e atualizar" (`autoUpdater.quitAndInstall`, depois de parar a fila e fechar o banco). Para desligar: variável de ambiente `SAGA_UPDATES=off` (necessário se o repositório virar privado; nesse caso baixe o `.exe` à mão).

## Modelo da Groq

O modelo de texto padrão é `llama-3.3-70b-versatile` (constante `DEFAULT_GROQ_MODEL` em `src/core/ai/llm.ts`). **Verificar no catálogo gratuito da Groq** antes de cada lançamento se ele ainda existe e continua o melhor em português; o modelo também pode ser trocado em Configurações.

## Limites

- Groq gratuito: 20 pedidos/min, 2.000/dia, 28.800 s de áudio/dia, mínimo de 10 s cobrado por pedido.
- Downloads de mídia: intervalo sorteado de 4 a 12 s, até 300 por hora e 2.000 por dia. Aquecimento de 15 min com intervalos dobrados ao iniciar ou ao acordar de suspensão de mais de 1 h.
- Reconexão: esperas de 10 s, 30 s, 2 min, 5 min, 15 min e 30 min (±20%); no máximo 6 tentativas por hora, depois só manual.
- IA: até 3 tentativas com espera crescente; depois "falhou" com botão "Tentar de novo". Teto de gasto diário configurável (padrão US$ 1,00).
- Envio direto: intervalo sorteado de 30 a 90 s entre envios (o dobro no aquecimento), até 40 por hora e 200 por dia; o primeiro sai na hora se os tetos permitem. Envio na fila há mais de 10 min volta a "aguardando confirmação".
- Menos de 1 GB livre pausa a fila.
- Histórico: 30 dias, pelo horário da mensagem no WhatsApp.

## Princípios de segurança

- Um único caminho de escrita: `sendPresenceUpdate`, `sendMessage` e `readMessages` só são chamados por `executeSend` (handler do job `send_message` em `src/core/wa/client.ts`), que só existe depois de o mentor confirmar o envio (token de uso único do `prepareSend` para exatamente aquele jid + texto, válido por 5 min). Nunca `sendReceipt(s)`, `chatModify` nem métodos de grupo; o socket usa `markOnlineOnConnect: false`. `readMessages` marca só as mensagens do contato daquela conversa.
- Envio: só para conversas em que o contato mandou mensagem nos últimos 30 dias; nada é enviado sozinho depois de reiniciar ou reconectar (qualquer perda de conexão expira o que está na fila; o job leva a geração da conexão); queda no meio do envio fica "desconhecido" e é conferida pelo id de mensagem que o próprio app gera (`messageId`) antes de oferecer reenviar, sempre com nova confirmação e nunca com o pedido anterior ainda em andamento; idempotência por resposta aprovada + impressão do texto, transições condicionadas à tentativa. Na individual, o destino é o `remoteJid` original do contato (@lid quando a conversa migrou). O registro de diagnóstico tem uma linha por etapa (`send_queued`, `send_typing`, `send_sent`, `send_failed`, `send_unknown`, `send_expired`) com o id do envio/job e uma impressão da conversa, nunca o texto nem o número.
- Conversas individuais e grupos (só leitura: nenhum método que altere grupos é chamado; os nomes dos grupos vêm de eventos e de uma consulta `groupFetchAllParticipating` pela fila, no máximo 1 vez por dia). Status, newsletters e listas de transmissão são ignorados.
- Toda ação de rede para o WhatsApp passa pela fila com limites de ritmo.
- Chaves de API só em `safeStorage`, nunca em texto puro nem em logs.
- Dados em `app.getPath('userData')`: `saga.db`, `auth/`, `auth-backup/`, `media/`. Nada sai do computador, exceto texto e áudio enviados à IA escolhida.
- O uso do WhatsApp por cliente não oficial tem risco de limitação da conta; por isso o ritmo lento.
