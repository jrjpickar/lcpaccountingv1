import { requireAuth } from "./lib/auth-guard.mts";
// GET /api/vendors?q=<search>
//
// Vendor picker source for the Bills (AP) tab - vendors are GHL contacts,
// not a separate list, per the "reuse GHL contacts" decision. Searches
// live against GHL's contacts endpoint and returns a trimmed shape for the
// picker; doesn't create contacts, so a vendor needs to already exist in
// GHL before it can be picked here.

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default async (req: Request) => {
  const denied = await requireAuth(req);
  if (denied) return denied;

  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const token = process.env.GHL_PIT_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;

  if (!token || !locationId) {
    return json({ error: "Missing GHL_PIT_TOKEN or GHL_LOCATION_ID environment variable" }, 500);
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "";

  // NOTE: unlike /opportunities/search (which validated as snake_case -
  // see get-invoices.mts), GHL's general contacts endpoint follows the
  // more common camelCase convention. Verify against a live response if
  // this starts 422ing the way opportunities/search did.
  const ghlUrl = new URL(`${GHL_BASE}/contacts/`);
  ghlUrl.searchParams.set("locationId", locationId);
  ghlUrl.searchParams.set("limit", "20");
  if (q) ghlUrl.searchParams.set("query", q);

  try {
    const res = await fetch(ghlUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      return json({ error: `GHL API ${res.status}: ${await res.text()}` }, 502);
    }

    const body: any = await res.json();
    const contacts: any[] = body?.contacts ?? [];
    const vendors = contacts.map((c) => ({
      id: c.id,
      name:
        c.contactName ||
        c.name ||
        [c.firstName, c.lastName].filter(Boolean).join(" ") ||
        c.email ||
        c.phone ||
        "Unnamed contact",
      email: c.email || null,
      phone: c.phone || null,
    }));

    return json(vendors);
  } catch (err: any) {
    return json({ error: String(err?.message || err) }, 502);
  }
};

export const config = {
  path: "/.netlify/functions/vendors",
};
