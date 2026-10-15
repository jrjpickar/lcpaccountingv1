// Sign-in, roles and access list. Run: npm test
// (Node 22+, in-memory Netlify Blobs - see test/mock-blobs.mjs)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

process.env.GHL_APP_SHARED_SECRET = "test-shared-secret";
process.env.GHL_LOCATION_ID = "LOC123";
process.env.LEDGER_PIN = "482193";
delete process.env.LEDGER_AUTH_SECRET;
delete process.env.LEDGER_PASSWORD;
delete process.env.SENIOR_ADMINS;
delete process.env.MAKE_CALLBACK_SECRET;

const { _reset } = await import("./mock-blobs.mjs");
const auth = await import("../netlify/shared/auth.ts");
const session = (await import("../netlify/functions/session.mts")).default;
const access = (await import("../netlify/functions/access.mts")).default;
const bills = (await import("../netlify/functions/bills.mts")).default;
const ytd = (await import("../netlify/functions/ytd-baseline.mts")).default;
const deals = (await import("../netlify/functions/deals.mts")).default;
const partners = (await import("../netlify/functions/partners.mts")).default;
const gate = (await import("../netlify/edge-functions/auth-gate.ts")).default;
const { recentActivity } = await import("../netlify/functions/lib/activity.mts");

// CryptoJS.AES.encrypt(JSON, passphrase) - what GHL sends a Custom Page.
function ghlEncrypt(obj: unknown, pass = "test-shared-secret") {
  const salt = randomBytes(8), pw = Buffer.from(pass), blocks: Buffer[] = [];
  let prev = Buffer.alloc(0);
  while (Buffer.concat(blocks).length < 48) { prev = createHash("md5").update(Buffer.concat([prev, pw, salt])).digest(); blocks.push(prev); }
  const km = Buffer.concat(blocks);
  const c = createCipheriv("aes-256-cbc", km.subarray(0, 32), km.subarray(32, 48));
  return Buffer.concat([Buffer.from("Salted__"), salt, c.update(JSON.stringify(obj)), c.final()]).toString("base64");
}
const ghlUser = (id: string, email: string, name = id, loc = "LOC123") => ({ userId: id, email, userName: name, activeLocation: loc });

const post = (fn: any, path: string, body: unknown, token?: string) =>
  fn(new Request("https://ledger.test" + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-ledger-auth": token } : {}) }, body: JSON.stringify(body) }), { ip: "1.2.3.4" });
const get = (fn: any, path: string, token?: string) =>
  fn(new Request("https://ledger.test" + path, { headers: token ? { "x-ledger-auth": token } : {} }));

async function ghlSignIn(id: string, email: string, name = id) {
  const res = await post(session, "/api/session", { action: "ghl", encryptedData: ghlEncrypt(ghlUser(id, email, name)) });
  return { res, body: await res.json() };
}

beforeEach(() => { _reset(); auth.clearAccessCache(); });

test("token round-trip, tamper and expiry", async () => {
  const { token } = await auth.signSession({ id: "u1", name: "Ann", email: "ann@x.com" }, "ghl");
  const p = await auth.verifyToken(token);
  assert.equal(p?.uid, "u1");
  assert.equal(p?.via, "ghl");
  const [v, body, sig] = token.split(".");
  assert.equal(await auth.verifyToken(`${v}.${body}.${sig.replace(/.$/, sig.endsWith("0") ? "1" : "0")}`), null);
  const forged = Buffer.from(JSON.stringify({ v: 2, uid: "u1", name: "Ann", email: "ann@x.com", via: "ghl", iat: 0, exp: 1 })).toString("base64url");
  assert.equal(await auth.verifyToken(`v2.${forged}.${sig}`), null);
  assert.equal(await auth.verifyToken("1234567890123.abc"), null); // old PIN-only format
});

test("changing LEDGER_PIN signs PIN sessions out", async () => {
  const { token } = await auth.signSession({ id: "email:a@x.com", name: "A", email: "a@x.com" }, "pin");
  assert.ok(await auth.verifyToken(token));
  process.env.LEDGER_PIN = "999999";
  assert.equal(await auth.verifyToken(token), null);
  process.env.LEDGER_PIN = "482193";
});

test("GHL user not on the list is refused and shows up as a request", async () => {
  const { res, body } = await ghlSignIn("g-bob", "bob@example.com", "Bob");
  assert.equal(res.status, 403);
  assert.equal(body.notListed, true);
  const s = await ghlSignIn("g-bryce", "brycetooley@gmail.com", "Bryce");
  const list = await (await get(access, "/api/access", s.body.token)).json();
  assert.deepEqual(list.requests.map((r: any) => r.email), ["bob@example.com"]);
});

test("wrong Shared Secret or wrong location is refused", async () => {
  let res = await post(session, "/api/session", { action: "ghl", encryptedData: ghlEncrypt(ghlUser("g-bryce", "brycetooley@gmail.com"), "wrong") });
  assert.equal(res.status, 401);
  res = await post(session, "/api/session", { action: "ghl", encryptedData: ghlEncrypt(ghlUser("g-bryce", "brycetooley@gmail.com", "J", "OTHERLOC")) });
  assert.equal(res.status, 403);
});

test("owner email is always senior admin and gets an entry", async () => {
  const { res, body } = await ghlSignIn("g-bryce", "BryceTooley@Gmail.com", "Bryce");
  assert.equal(res.status, 200);
  assert.equal(body.role, "senior");
  assert.equal(body.effectiveRole, "senior");
  const who = await (await get(session, "/api/session", body.token)).json();
  assert.equal(who.user.name, "Bryce");
  const list = await (await get(access, "/api/access", body.token)).json();
  assert.equal(list.users[0].role, "senior");
  assert.equal(list.users[0].addedBy, "built-in");
});

test("roles: admins add users, only seniors add/promote admins, nobody removes a senior", async () => {
  const j = (await ghlSignIn("g-bryce", "brycetooley@gmail.com", "Bryce")).body.token;
  // Senior adds an admin by email (GHL list unavailable in tests).
  let r = await post(access, "/api/access", { action: "add", email: "amy@example.com", name: "Amy", role: "admin" }, j);
  assert.equal(r.status, 200);
  const amy = await ghlSignIn("g-amy", "amy@example.com", "Amy");
  assert.equal(amy.body.role, "admin");
  const a = amy.body.token;
  // Entry got tied to the real GHL id.
  const users = (await (await get(access, "/api/access", j)).json()).users;
  assert.ok(users.some((u: any) => u.id === "g-amy" && !u.pending));

  // Admin can add a user...
  r = await post(access, "/api/access", { action: "add", email: "ted@example.com", name: "Ted" }, a);
  assert.equal(r.status, 200);
  // ...but not an admin, can't change roles, can't see the activity log.
  assert.equal((await post(access, "/api/access", { action: "add", email: "x@example.com", role: "admin" }, a)).status, 403);
  assert.equal((await post(access, "/api/access", { action: "set-role", id: "email:ted@example.com", role: "admin" }, a)).status, 403);
  assert.equal((await get(access, "/api/access?view=activity", a)).status, 403);
  // Nobody removes the senior.
  assert.equal((await post(access, "/api/access", { action: "remove", id: "g-bryce" }, a)).status, 409);

  // A plain user can't open the Access API at all.
  const ted = (await ghlSignIn("g-ted", "ted@example.com", "Ted")).body;
  assert.equal(ted.role, "user");
  assert.equal((await get(access, "/api/access", ted.token)).status, 403);

  // Senior promotes Ted, then demotes; admin can't remove an admin.
  assert.equal((await post(access, "/api/access", { action: "set-role", id: "g-ted", role: "admin" }, j)).status, 200);
  assert.equal((await post(access, "/api/access", { action: "remove", id: "g-ted" }, a)).status, 403);
  assert.equal((await post(access, "/api/access", { action: "set-role", id: "g-ted", role: "user" }, j)).status, 200);

  // Removing someone locks them out on their next request.
  assert.equal((await get(bills, "/api/bills", ted.token)).status, 200);
  assert.equal((await post(access, "/api/access", { action: "remove", id: "g-ted" }, a)).status, 200);
  assert.equal((await get(bills, "/api/bills", ted.token)).status, 401);

  const log = (await (await get(access, "/api/access?view=activity", j)).json()).activity.map((e: any) => `${e.by}: ${e.action}`);
  assert.ok(log.includes("Amy: Removed user"));
  assert.ok(log.includes("Bryce: Added admin"));
});

test("PIN sign-in: listed emails only, capped at user, rate limited", async () => {
  const j = (await ghlSignIn("g-bryce", "brycetooley@gmail.com", "Bryce")).body.token;
  await post(access, "/api/access", { action: "add", email: "amy@example.com", name: "Amy", role: "admin" }, j);

  let res = await post(session, "/api/session", { action: "pin", email: "stranger@x.com", pin: "482193" });
  assert.equal(res.status, 401);
  res = await post(session, "/api/session", { action: "pin", email: "amy@example.com", pin: "482193" });
  const b = await res.json();
  assert.equal(res.status, 200);
  assert.equal(b.role, "admin");
  assert.equal(b.effectiveRole, "user");
  assert.equal(b.adminLocked, true);
  const r = await get(access, "/api/access", b.token);
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /inside GHL/);
  // A senior on the PIN is also only a user - the PIN is shared.
  const js = await (await post(session, "/api/session", { action: "pin", email: "brycetooley@gmail.com", pin: "482193" })).json();
  assert.equal(js.effectiveRole, "user");
  assert.equal((await fetchYtdPut(js.token)).status, 403);
  // 5 wrong tries lock the IP (a good sign-in resets the count).
  for (let i = 0; i < 5; i++) await post(session, "/api/session", { action: "pin", email: "amy@example.com", pin: "000000" });
  res = await post(session, "/api/session", { action: "pin", email: "amy@example.com", pin: "000000" });
  assert.equal(res.status, 429);
});

const fetchYtdPut = (token: string) =>
  ytd(new Request("https://ledger.test/api/ytd-baseline", { method: "PUT", headers: { "content-type": "application/json", "x-ledger-auth": token }, body: JSON.stringify({ asOf: "2026-06-30", revenue: 100 }) }));

test("YTD baseline: everyone reads, only senior (GHL) writes", async () => {
  const j = (await ghlSignIn("g-bryce", "brycetooley@gmail.com", "Bryce")).body.token;
  await post(access, "/api/access", { action: "add", email: "ted@example.com", name: "Ted" }, j);
  const t = (await ghlSignIn("g-ted", "ted@example.com", "Ted")).body.token;
  assert.equal((await get(ytd, "/api/ytd-baseline", t)).status, 200);
  assert.equal((await fetchYtdPut(t)).status, 403);
  assert.equal((await fetchYtdPut(j)).status, 200);
});

test("bills record who did what", async () => {
  const j = (await ghlSignIn("g-bryce", "brycetooley@gmail.com", "Bryce")).body.token;
  await post(access, "/api/access", { action: "add", email: "ted@example.com", name: "Ted" }, j);
  const t = (await ghlSignIn("g-ted", "ted@example.com", "Ted")).body.token;
  const created = await (await post(bills, "/api/bills", { vendorName: "Home Depot", billNumber: "77", lineItems: [{ description: "Lumber", amount: 512 }] }, t)).json();
  assert.equal(created.history[0].by, "Ted");
  const put = await bills(new Request("https://ledger.test/api/bills", { method: "PUT", headers: { "content-type": "application/json", "x-ledger-auth": j }, body: JSON.stringify({ id: created.id, action: "approve" }) }));
  const approved = await put.json();
  assert.deepEqual(approved.history.map((h: any) => [h.action, h.by]), [["created", "Ted"], ["approved", "Bryce"]]);
  const log = (await recentActivity()).map((e) => `${e.by}: ${e.action}: ${e.detail}`);
  assert.ok(log.includes("Ted: Entered bill: Home Depot #77 · $512.00"));
  assert.ok(log.includes("Bryce: Approved bill: Home Depot #77 · $512.00"));
});

test("deals: live GHL pipeline by stage name + saved deal records", async () => {
  const j = (await ghlSignIn("g-bryce", "brycetooley@gmail.com", "Bryce")).body.token;
  process.env.GHL_PIT_TOKEN = "pit"; process.env.GHL_LOCATION_ID = "LOC123";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes("/opportunities/pipelines")) return new Response(JSON.stringify({ pipelines: [
      { id: "P_other", name: "Buyers", stages: [{ id: "x1", name: "New" }] },
      { id: "P_acq", name: "Acquisitions", stages: ["New Lead", "Run Numbers", "Verbal Acceptance", "Offer Sent", "Inspection Period", "Pending", "Closed", "Offer Declined- Hot"].map((n, i) => ({ id: "s" + i, name: n, position: i })) },
    ] }));
    if (u.includes("/opportunities/search")) {
      assert.match(u, /pipeline_id=P_acq/);
      return new Response(JSON.stringify({ opportunities: [
        { id: "o1", name: "1233 E 76th St", pipelineStageId: "s0", contact: { name: "Seller A" } },
        { id: "o2", name: "1306 57th", pipelineStageId: "s3", contact: { name: "Seller B" }, monetaryValue: 0 },
        { id: "o3", name: "313 Arbor Vitae", pipelineStageId: "s7", contact: { name: "Seller C" } },
      ] }));
    }
    throw new Error("unexpected fetch " + u);
  }) as any;
  try {
    let r = await post(deals, "/api/deals", { opportunityId: "o3", propertyAddress: "313 Arbor Vitae", emdAmount: "1,000", emdStatus: "forfeited" }, j);
    assert.equal(r.status, 200);
    r = await post(deals, "/api/deals", { opportunityId: "o2", assignmentFee: 15000, feeReceived: 15000 }, j);
    assert.equal(r.status, 400); // fee received needs a date
    r = await post(deals, "/api/deals", { opportunityId: "o2", assignmentFee: 15000, emdStatus: "held", emdAmount: 500 }, j);
    const rec = await r.json();
    assert.equal(rec.assignmentFee, 15000);
    assert.match(rec.history[0].note, /Assignment fee: blank → \$15000.00/);
    const data = await (await get(deals, "/api/deals", j)).json();
    assert.equal(data.pipeline.id, "P_acq");
    assert.deepEqual(data.deals.map((d: any) => [d.id, d.stageName]), [["o2", "Offer Sent"]]);
    assert.equal(data.deals[0].record.emdStatus, "held");
    assert.deepEqual(data.fellOut.map((d: any) => [d.id, d.stageName]), [["o3", "Offer Declined- Hot"]]);
    assert.equal(data.stages.find((s: any) => s.name === "Closed").isClosed, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("partners: anyone records entries, only senior admins change the split", async () => {
  const b = (await ghlSignIn("g-bryce", "brycetooley@gmail.com", "Bryce")).body.token;
  await post(access, "/api/access", { action: "add", email: "ted@example.com", name: "Ted" }, b);
  const t = (await ghlSignIn("g-ted", "ted@example.com", "Ted")).body.token;
  const start = await (await get(partners, "/api/partners", t)).json();
  assert.equal(start.members.length, 3);
  let r = await post(partners, "/api/partners", { action: "add-entry", memberId: "m_bryce", type: "contribution", amount: "2,500", date: "2026-10-01" }, t);
  assert.equal(r.status, 201);
  assert.equal((await r.json()).entries[0].amount, 2500);
  r = await post(partners, "/api/partners", { action: "set-members", members: [{ id: "m_bryce", name: "Bryce", pct: 25 }] }, t);
  assert.equal(r.status, 403);
  r = await post(partners, "/api/partners", { action: "set-members", members: [{ id: "m_jesse", name: "Jesse", pct: 50 }, { id: "m_art", name: "Art", pct: 25 }] }, b);
  assert.equal(r.status, 409); // Bryce has an entry, can't be dropped
  r = await post(partners, "/api/partners", { action: "set-members", members: [{ id: "m_bryce", name: "Bryce", pct: 80 }, { id: "m_art", name: "Art", pct: 30 }] }, b);
  assert.equal(r.status, 400); // over 100%
  r = await post(partners, "/api/partners", { action: "set-members", members: [{ id: "m_jesse", name: "Jesse", pct: 50 }, { id: "m_bryce", name: "Bryce", pct: 25 }, { id: "m_art", name: "Art", pct: 25 }] }, b);
  assert.equal(r.status, 200);
});

test("edge gate: sign-in page without a session, the app with one", async () => {
  const next = async () => new Response("<html>APP</html>", { headers: { "content-type": "text/html" } });
  let res = await gate(new Request("https://ledger.test/"), { next });
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, /REQUEST_USER_DATA/);
  assert.doesNotMatch(html, /APP/);
  // The inline script must at least parse.
  const script = html.split("<script>").pop()!.split("</script>")[0];
  assert.doesNotThrow(() => new Function(script));

  const j = (await ghlSignIn("g-bryce", "brycetooley@gmail.com", "Bryce")).body.token;
  res = await gate(new Request("https://ledger.test/?auth=" + encodeURIComponent(j)), { next });
  assert.equal(await res.text(), "<html>APP</html>");
  res = await gate(new Request("https://ledger.test/", { headers: { cookie: `ledger_session=${encodeURIComponent(j)}` } }), { next });
  assert.equal(await res.text(), "<html>APP</html>");
});

 test("outside-GHL password accepts text, enforces access and invalidates on rotation", async () => {
  process.env.LEDGER_PASSWORD = "a-long-test-password!";
  try {
    assert.equal(auth.getPin(), "a-long-test-password!");
    const res = await post(session, "/api/session", { action: "pin", email: auth.OWNER_EMAIL, pin: process.env.LEDGER_PASSWORD });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.effectiveRole, "user");
    assert.ok(await auth.verifyToken(body.token));
    const denied = await post(session, "/api/session", { action: "pin", email: "unlisted@example.com", pin: process.env.LEDGER_PASSWORD });
    assert.equal(denied.status, 401);
    process.env.LEDGER_PASSWORD = "another-long-password!";
    assert.equal(await auth.verifyToken(body.token), null);
    process.env.LEDGER_PASSWORD = "short";
    assert.equal(auth.getPin(), null);
  } finally { delete process.env.LEDGER_PASSWORD; }
});

test("explicit session signing secret is supported and validated", async () => {
  process.env.LEDGER_AUTH_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  try {
    assert.equal(await auth.getAuthSecret(), process.env.LEDGER_AUTH_SECRET);
    const { token } = await auth.signSession({ id: "u1", name: "A", email: "a@example.com" }, "ghl");
    assert.ok(await auth.verifyToken(token));
    process.env.LEDGER_AUTH_SECRET = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    assert.equal(await auth.verifyToken(token), null);
    process.env.LEDGER_AUTH_SECRET = "short";
    await assert.rejects(auth.getAuthSecret(), /at least 32/);
  } finally { delete process.env.LEDGER_AUTH_SECRET; }
});
