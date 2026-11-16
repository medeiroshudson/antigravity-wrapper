import { isDefinitive, type UpstreamError } from "./errors.js";

/**
 * De quem é esta falha.
 *
 * `account` — a conta é dona do veredito: pode ser cobrada no limiar e esfriada.
 * `request` — a resposta seria a mesma em qualquer conta: cobrar a conta tira
 *   capacidade saudável do ar, que é o defeito medido em 2026-11-15 (um literal na
 *   `systemInstruction` respondia 429 em todas as contas e o pool esfriava três por request).
 *
 * `server_error` entra como `request` por outro motivo: ele descreve o canal ou o
 * transporte, não a credencial. Nenhum dos dois muda o estado da conta.
 *
 * `transient_rate_limit` é dividido pelo hint: com `retryAfterMs` o backend nomeou a
 * espera desta conta (o corpo diz "Resets in 30s" para ela e não para as outras), então a
 * falha é dela; sem hint o mesmo corpo responde por qualquer conta — foi exatamente essa
 * a medição de 2026-11-15 — e o veredito é do request.
 */
export type FailureScope = "account" | "request";

/** Definitivas e de canal: o veredito não pertence à conta que por acaso o recebeu. */
export function failureScope(error: UpstreamError): FailureScope {
  if (isDefinitive(error.kind)) return "request";
  if (error.kind === "server_error") return "request";
  if (error.kind === "transient_rate_limit" && error.retryAfterMs === null) return "request";
  return "account";
}

/**
 * Identidade da recusa. Duas respostas com a mesma chave, em contas diferentes, são o
 * mesmo veredito: quem responde é o request.
 */
export function refusalKey(error: UpstreamError): string {
  return `${error.kind}:${error.status}:${error.message}`;
}
