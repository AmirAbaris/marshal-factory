import "./test-guard";
import assert from "node:assert/strict";
import { isOwner } from "../lib/auth/owner";

const OWNER = "owner@example.com";

assert.equal(isOwner(OWNER, undefined), false, "an unset allowlist denies everyone");
assert.equal(isOwner(OWNER, ""), false, "an empty allowlist denies everyone");
assert.equal(isOwner(OWNER, " , ,"), false, "an allowlist of blanks denies everyone");
assert.equal(isOwner("", " , ,"), false, "an empty email never matches a blank entry");
assert.equal(isOwner(OWNER, "someone@example.com"), false, "an email missing from the allowlist is denied");
assert.equal(isOwner(null, OWNER), false, "a missing email is denied");
assert.equal(isOwner(OWNER, OWNER), true);
assert.equal(isOwner("Owner@Example.COM", "owner@EXAMPLE.com"), true, "matching ignores case");
assert.equal(isOwner(OWNER, " other@example.com ,  owner@example.com  "), true, "entries are trimmed");
assert.equal(isOwner(`owner@example.com.evil`, OWNER), false, "a suffix does not match");

const saved = process.env.FACTORY_OWNER_EMAILS;
process.env.FACTORY_OWNER_EMAILS = OWNER;
assert.equal(isOwner(OWNER), true, "the default allowlist is FACTORY_OWNER_EMAILS");
delete process.env.FACTORY_OWNER_EMAILS;
assert.equal(isOwner(OWNER), false, "an unset FACTORY_OWNER_EMAILS denies the owner");
if (saved !== undefined) process.env.FACTORY_OWNER_EMAILS = saved;

console.log("owner regressions passed");
