# Saga

Aplicativo de desktop (Windows) que lê, **somente leitura**, as conversas individuais do WhatsApp do mentor dos últimos 30 dias, transcreve os áudios e sugere respostas para ele revisar e copiar. Nenhuma mensagem é enviada pelo app.

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
npx electron-builder --win --publish never   # gera dist/Saga-Setup-<versão>.exe
```

O CI (`.github/workflows/ci.yml`) faz isso em `windows-latest` a cada push e guarda o `.exe` como artefato. Não há módulos nativos.

## Lançar uma versão

1. Atualize `version` em `package.json`.
2. Faça commit e envie uma tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. O workflow `release.yml` testa, compila e publica o instalador (e `latest.yml`, usado pelas atualizações) num GitHub Release.

As instalações existentes avisam "Nova versão disponível — Atualizar" (electron-updater, repositório público). O download é manual (clique) e a instalação acontece ao fechar o app. Para desligar: variável de ambiente `SAGA_UPDATES=off` (necessário se o repositório virar privado; nesse caso baixe o `.exe` à mão).

## Modelo da Groq

O modelo de texto padrão é `llama-3.3-70b-versatile` (constante `DEFAULT_GROQ_MODEL` em `src/core/ai/llm.ts`). **Verificar no catálogo gratuito da Groq** antes de cada lançamento se ele ainda existe e continua o melhor em português; o modelo também pode ser trocado em Configurações.

## Limites

- Groq gratuito: 20 pedidos/min, 2.000/dia, 28.800 s de áudio/dia, mínimo de 10 s cobrado por pedido.
- Downloads de mídia: intervalo sorteado de 4 a 12 s, até 300 por hora e 2.000 por dia. Aquecimento de 15 min com intervalos dobrados ao iniciar ou ao acordar de suspensão de mais de 1 h.
- Reconexão: esperas de 10 s, 30 s, 2 min, 5 min, 15 min e 30 min (±20%); no máximo 6 tentativas por hora, depois só manual.
- IA: até 3 tentativas com espera crescente; depois "falhou" com botão "Tentar de novo". Teto de gasto diário configurável (padrão US$ 1,00).
- Menos de 1 GB livre pausa a fila.
- Histórico: 30 dias, pelo horário da mensagem no WhatsApp.

## Princípios de segurança

- Somente leitura: não existe chamada a `sendMessage`; nunca se chama `readMessages`, `sendReceipt(s)` ou `sendPresenceUpdate`; o socket usa `markOnlineOnConnect: false` (sem confirmação de leitura nem "online").
- Só conversas individuais; grupos, status e newsletters são ignorados.
- Toda ação de rede para o WhatsApp passa pela fila com limites de ritmo.
- Chaves de API só em `safeStorage`, nunca em texto puro nem em logs.
- Dados em `app.getPath('userData')`: `saga.db`, `auth/`, `auth-backup/`, `media/`. Nada sai do computador, exceto texto e áudio enviados à IA escolhida.
- O uso do WhatsApp por cliente não oficial tem risco de limitação da conta; por isso o ritmo lento.
