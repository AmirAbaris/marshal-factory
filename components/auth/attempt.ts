type AuthError = { message?: string; code?: string };
export type AuthFailure = { message: string; unverified: boolean };

// Better Auth returns EMAIL_NOT_VERIFIED; the Neon client rethrows it as email_not_confirmed.
const UNVERIFIED = new Set(["EMAIL_NOT_VERIFIED", "email_not_confirmed"]);

function failure(error: AuthError, fallback: string): AuthFailure {
  return { message: error.message || fallback, unverified: UNVERIFIED.has(error.code ?? "") };
}

export async function attempt(call: () => Promise<{ error: AuthError | null }>, fallback: string) {
  // The Neon client throws on an HTTP error even though Better Auth documents a returned error.
  try {
    const { error } = await call();
    return error ? failure(error, fallback) : null;
  } catch (error) {
    return failure(error instanceof Error ? (error as AuthError) : {}, fallback);
  }
}
