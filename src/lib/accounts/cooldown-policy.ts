import { getCooldownQuotaMs, getCooldownTransientMs } from "../../config/index.js";
import type { UpstreamFailureKind, UpstreamError } from "../antigravity/errors.js";

/**
 * Quando — e por quanto tempo — uma falha esfria uma conta.
 *
 * A política é declarativa, por kind, porque a pergunta "esta falha é uma espera?" tem
 * resposta diferente por tipo: uma parede de quota espera até o `resetTime` que o backend
 * nomeou, uma aceleração espera o `retryDelay` que ele deu (ou o padrão), e um token morto,
 * um bloqueio ou uma recusa definitiva não esperam nada.
 *
 * O escopo é sempre `family`: medido em 2026-11-15, a parede de quota é por família de
 * modelos (`gemini-*` / `3p-*`), então esfriar a conta inteira por uma família drenada tira
 * do ar a outra família que ainda tinha cota. Um kind fora desta tabela não gera cooldown.
 */
export interface CooldownPolicy {
  kind: UpstreamFailureKind;
  /** Escopo do cooldown que este kind produz. */
  scope: "family";
  /** Quantas falhas seguidas no mesmo (conta, escopo, kind) antes de esfriar. */
  threshold: number;
  /** Quanto tempo, quando o backend não disse. */
  defaultMs: (env: NodeJS.ProcessEnv) => number;
}

export const COOLDOWN_POLICIES: readonly CooldownPolicy[] = [
  {
    kind: "quota",
    scope: "family",
    // Uma parede de quota já é a resposta do backend, não um tropeço: uma falha basta.
    threshold: 1,
    defaultMs: (env) => getCooldownQuotaMs(env),
  },
  {
    // Só chega aqui a aceleração que o backend atribuiu a uma espera (`retryAfterMs`);
    // sem hint ela é do request e nunca vira cooldown (ver `scope.ts`).
    kind: "transient_rate_limit",
    scope: "family",
    threshold: 1,
    defaultMs: (env) => getCooldownTransientMs(env),
  },
];

export function cooldownPolicy(kind: UpstreamFailureKind): CooldownPolicy | null {
  return COOLDOWN_POLICIES.find((policy) => policy.kind === kind) ?? null;
}

/**
 * A espera a aplicar: a que o backend nomeou vence sempre, porque é o único dado que
 * descreve esta conta e este momento. O padrão da política só cobre o silêncio dele.
 */
export function cooldownDuration(
  policy: CooldownPolicy,
  error: Pick<UpstreamError, "retryAfterMs">,
  env: NodeJS.ProcessEnv,
): number {
  return error.retryAfterMs ?? policy.defaultMs(env);
}
