export function isOwner(email: string | null | undefined, allowlist = process.env.FACTORY_OWNER_EMAILS) {
  if (!email || !allowlist) return false;
  const owners = allowlist.split(",").map((entry) => entry.trim().toLowerCase());
  return owners.includes(email.trim().toLowerCase());
}
