import { z } from "zod";

/** USD per million tokens. Cache reads and writes are billed apart from uncached input. */
export const priceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});
export type Price = z.infer<typeof priceSchema>;

/** `factory.pricing`: a price per model id (or id prefix), or null to treat a model's cost as unknown. */
export const pricingSchema = z.record(z.string().min(1), priceSchema.nullable());
export type PricingOverrides = z.infer<typeof pricingSchema>;

// Claude: claude-api skill model table, cached 2026-10-06
// (https://docs.claude.com/en/docs/about-claude/pricing). Cache writes assume the 5-minute TTL at
// 1.25x input. Haiku 5.5 is the at-or-below-100K-prompt tier.
// OpenAI: https://platform.openai.com/docs/pricing, Standard tier, read 2026-10-27. The
// short-context column (at most 272K input tokens per request); cache writes at the 30-minute
// write price. A longer request costs more than this counts. Under a ChatGPT login Codex is not
// billed per token; these are what the same tokens cost on the API.
export const DEFAULT_PRICES: Readonly<Record<string, Price>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "gpt-6.1-terra": { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
};

export type TokenCounts = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

// A key prices a model id that is the key itself or the key with a suffix such as a date or
// `[1m]`, never a longer name: `gpt-6-sol` must not price `gpt-6-sol-mini`.
const SUFFIX = /^(?:-\d{4,}|-latest|\[|@|$)/;
const priceKey = (prices: Readonly<Record<string, unknown>>, model: string) =>
  Object.keys(prices)
    .filter((key) => model.startsWith(key) && SUFFIX.test(model.slice(key.length)))
    .sort((a, b) => b.length - a.length)[0];

/** The model's price, the overrides first; undefined when it is unknown or overridden to null. */
export function priceFor(model: string | null | undefined, overrides: PricingOverrides = {}): Price | undefined {
  if (!model) return undefined;
  const override = priceKey(overrides, model);
  if (override !== undefined) return overrides[override] ?? undefined;
  const key = priceKey(DEFAULT_PRICES, model);
  return key ? DEFAULT_PRICES[key] : undefined;
}

export const hasTokens = (t: TokenCounts) => t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens > 0;

/** Whether these rows' cost is known: some usage is recorded and every row with tokens has a price. */
export const costKnown = (rows: readonly (TokenCounts & { model: string | null })[], overrides?: PricingOverrides) =>
  rows.some(hasTokens) && rows.every((row) => !hasTokens(row) || priceFor(row.model, overrides) !== undefined);

/** Spend in USD; undefined when the model's price is unknown and there are tokens to price. */
export function knownCostUsd(tokens: TokenCounts, model: string | null | undefined, overrides?: PricingOverrides): number | undefined {
  if (!hasTokens(tokens)) return 0;
  const price = priceFor(model, overrides);
  if (!price) return undefined;
  return (
    (tokens.input_tokens * price.input +
      tokens.output_tokens * price.output +
      tokens.cache_read_tokens * price.cacheRead +
      tokens.cache_write_tokens * price.cacheWrite) /
    1_000_000
  );
}

/** Spend in USD. Unknown models count as 0 so a new model never breaks the panel. */
export const costUsd = (tokens: TokenCounts, model: string | null | undefined, overrides?: PricingOverrides) =>
  knownCostUsd(tokens, model, overrides) ?? 0;
