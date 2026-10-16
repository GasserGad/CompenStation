// Password hashing with scrypt (built into Node, memory-hard, recommended by OWASP).
// Stored format: scrypt$N$r$p$<salt base64>$<hash base64>, so parameters can be
// raised later without breaking existing hashes.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = /** @type {(pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>} */ (
  promisify(scryptCb)
);

const N = 2 ** 15;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * N * r * 2;

/** @param {string} password */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEMORY });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const params = { N: Number(nStr), r: Number(rStr), p: Number(pStr) };
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    ...params,
    maxmem: 128 * params.N * params.r * 2,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Used when a username doesn't exist, so a login attempt takes the same time
// either way and attackers can't discover which usernames are real.
let dummyHash = "";
export async function burnPasswordCheck(password) {
  if (!dummyHash) dummyHash = await hashPassword("not-a-real-password");
  await verifyPassword(password, dummyHash);
}
