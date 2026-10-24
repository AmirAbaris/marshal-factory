import { endpointOf } from "./test-mode";

/** Compute endpoints of the production branch, br-nameless-dawn-b9ku4ts5. Add any new one here. */
export const PRODUCTION_ENDPOINTS = new Set(["ep-odd-field-b95xpf9v"]);

const DB_VARS = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const;

/** Why a Vercel build must not migrate, or null when it may. Only a production build may touch production. */
export function migrateRefusal(env: Record<string, string | undefined>): string | null {
  if (env.VERCEL_ENV === "production") return null;
  const target = env.VERCEL_ENV ?? "non-production";
  for (const name of DB_VARS) {
    const url = env[name];
    if (!url) return `${name} is not set`;
    let endpoint: string;
    try {
      endpoint = endpointOf(url);
    } catch {
      return `${name} is not a valid URL`;
    }
    if (PRODUCTION_ENDPOINTS.has(endpoint)) return `${name} points at the production branch (${endpoint}) in a ${target} build`;
  }
  return null;
}
