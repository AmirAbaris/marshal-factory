export type SessionUser = { email: string; emailVerified: boolean };

export function isAllowlisted(email: string | null | undefined, allowlist = process.env.FACTORY_OWNER_EMAILS) {
  if (!email || !allowlist) return false;
  const owners = allowlist.split(",").map((entry) => entry.trim().toLowerCase());
  return owners.includes(email.trim().toLowerCase());
}

// Sign-up can be briefly on to create the owner, so an allowlisted address counts only once its inbox proved it.
export function isOwner(user: SessionUser | null | undefined, allowlist = process.env.FACTORY_OWNER_EMAILS) {
  return user?.emailVerified === true && isAllowlisted(user.email, allowlist);
}
