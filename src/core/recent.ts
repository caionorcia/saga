/**
 * v0.9.0 (contrato v1.3): o SagaZap guarda TODO o histórico que o celular mandar. A janela de 30 dias continua valendo
 * para o que é automático: o envio ao Copiloto, a IA (alertas, "Para responder", resumos), o download dos áudios e a
 * transcrição. Mensagem mais antiga fica só aqui (busca, conversa, "Transcrever" sob pedido, pesquisa do Copiloto).
 */
export const RECENT_WINDOW_MS = 30 * 86_400_000

/** O começo da janela (epoch ms) para um "agora". */
export const recentSince = (now: number): number => now - RECENT_WINDOW_MS
