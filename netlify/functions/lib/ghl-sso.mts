// GHL side of sign-in (Node only - uses node:crypto for the MD5 key
// derivation Web Crypto doesn't have, so it can't live in shared/auth.ts
// which the edge function also imports).
//
// GHL Custom Page user context is CryptoJS AES: base64("Salted__" + 8-byte
// salt + ciphertext), key/iv from OpenSSL EVP_BytesToKey(MD5). Same as the
// dispatch board's and the dialer's decryptGhlUserData.

import { createHash, createDecipheriv } from "node:crypto";
import { env } from "../../shared/auth.ts";
import { HttpError } from "./shared.mts";
import { GHL_BASE } from "./ghl.mts";

export function decryptGhlUserData(encryptedData: string, passphrase: string): string {
  const raw = Buffer.from(String(encryptedData || ""), "base64");
  if (raw.length < 17 || raw.subarray(0, 8).toString("ascii") !== "Salted__") throw new Error("Invalid encrypted context");
  const salt = raw.subarray(8, 16);
  const password = Buffer.from(passphrase);
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  while (Buffer.concat(blocks).length < 48) {
    previous = createHash("md5").update(Buffer.concat([previous, password, salt])).digest();
    blocks.push(previous);
  }
  const material = Buffer.concat(blocks);
  const decipher = createDecipheriv("aes-256-cbc", material.subarray(0, 32), material.subarray(32, 48));
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8");
}

export type GhlUser = { id: string; name: string; email: string };

// Returns the verified GHL user, or throws HttpError.
export function ghlUserFromContext(encryptedData: unknown): GhlUser {
  const secret = env("GHL_APP_SHARED_SECRET");
  if (!secret) throw new HttpError(503, "GHL_APP_SHARED_SECRET is not set in Netlify, so GHL sign-in is off.");
  if (typeof encryptedData !== "string" || !encryptedData || encryptedData.length > 20000) {
    throw new HttpError(400, "Encrypted GHL user context is required.");
  }
  let user: any;
  try {
    user = JSON.parse(decryptGhlUserData(encryptedData, secret));
  } catch {
    throw new HttpError(401, "GHL user context could not be verified. Check GHL_APP_SHARED_SECRET matches the Ledger's Marketplace app.");
  }
  if (!user?.userId || !user.email) throw new HttpError(401, "GHL user context is incomplete.");
  const location = env("GHL_LOCATION_ID");
  if (!location) throw new HttpError(503, "GHL_LOCATION_ID is not set in Netlify.");
  if (!user.activeLocation || user.activeLocation !== location) throw new HttpError(403, "This GHL user is not in the LocalCare location.");
  return { id: String(user.userId), name: String(user.userName || user.email), email: String(user.email).toLowerCase() };
}

// Location users, for the "Add person" picker on the Access tab.
// GHL_PIT_TOKEN needs the users.readonly scope.
let usersCache: { at: number; users: GhlUser[] } | null = null;
export async function listLocationUsers({ fresh = false } = {}): Promise<GhlUser[]> {
  if (!fresh && usersCache && Date.now() - usersCache.at < 5 * 60 * 1000) return usersCache.users;
  const token = env("GHL_PIT_TOKEN");
  const locationId = env("GHL_LOCATION_ID");
  if (!token || !locationId) throw new HttpError(503, "GHL_PIT_TOKEN or GHL_LOCATION_ID is not set.");
  const res = await fetch(`${GHL_BASE}/users/?${new URLSearchParams({ locationId })}`, {
    headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " (the GHL token probably needs the users.readonly scope)" : "";
    throw new HttpError(502, `GHL users list failed: ${res.status}${hint}`);
  }
  const payload: any = await res.json();
  const users: GhlUser[] = (Array.isArray(payload?.users) ? payload.users : [])
    .filter((u: any) => u && u.id && !u.deleted)
    .map((u: any) => ({
      id: String(u.id),
      name: String(u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id),
      email: String(u.email || "").toLowerCase(),
    }))
    .sort((a: GhlUser, b: GhlUser) => a.name.localeCompare(b.name));
  usersCache = { at: Date.now(), users };
  return users;
}
