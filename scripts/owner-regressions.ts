import "./test-guard";
import assert from "node:assert/strict";
import { isAllowlisted, isOwner } from "../lib/auth/owner";

const OWNER = "owner@example.com";

assert.equal(isAllowlisted(OWNER, undefined), false, "an unset allowlist denies everyone");
assert.equal(isAllowlisted(OWNER, ""), false, "an empty allowlist denies everyone");
assert.equal(isAllowlisted(OWNER, " , ,"), false, "an allowlist of blanks denies everyone");
assert.equal(isAllowlisted("", " , ,"), false, "an empty email never matches a blank entry");
assert.equal(isAllowlisted(OWNER, "someone@example.com"), false, "an email missing from the allowlist is denied");
assert.equal(isAllowlisted(null, OWNER), false, "a missing email is denied");
assert.equal(isAllowlisted(OWNER, OWNER), true);
assert.equal(isAllowlisted("Owner@Example.COM", "owner@EXAMPLE.com"), true, "matching ignores case");
assert.equal(isAllowlisted(OWNER, " other@example.com ,  owner@example.com  "), true, "entries are trimmed");
assert.equal(isAllowlisted(`owner@example.com.evil`, OWNER), false, "a suffix does not match");

assert.equal(isOwner({ email: OWNER, emailVerified: true }, OWNER), true, "a verified allowlisted account is the owner");
assert.equal(isOwner({ email: OWNER, emailVerified: false }, OWNER), false, "an unverified allowlisted account is not the owner");
assert.equal(
  isOwner({ email: OWNER } as unknown as { email: string; emailVerified: boolean }, OWNER),
  false,
  "a session without the verified flag is not the owner",
);
assert.equal(isOwner({ email: "stranger@example.com", emailVerified: true }, OWNER), false, "verification does not stand in for the allowlist");
assert.equal(isOwner(null, OWNER), false, "no session is not the owner");

const saved = process.env.FACTORY_OWNER_EMAILS;
process.env.FACTORY_OWNER_EMAILS = OWNER;
assert.equal(isOwner({ email: OWNER, emailVerified: true }), true, "the default allowlist is FACTORY_OWNER_EMAILS");
delete process.env.FACTORY_OWNER_EMAILS;
assert.equal(isOwner({ email: OWNER, emailVerified: true }), false, "an unset FACTORY_OWNER_EMAILS denies the owner");
if (saved !== undefined) process.env.FACTORY_OWNER_EMAILS = saved;

console.log("owner regressions passed");
