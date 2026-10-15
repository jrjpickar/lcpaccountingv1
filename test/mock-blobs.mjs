// In-memory stand-in for @netlify/blobs (tests only).
const stores = globalThis.__blobStores ||= new Map();
let n = 0;
export function getStore(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  const read = (key, type) => { const e = m.get(key); if (!e) return null; return type === 'json' ? JSON.parse(e.v) : e.v; };
  return {
    async get(key, opts = {}) { return read(key, opts.type); },
    async getWithMetadata(key, opts = {}) { const e = m.get(key); return e ? { data: read(key, opts.type), etag: e.etag, metadata: {} } : null; },
    async set(key, v, opts = {}) { if (opts.onlyIfNew && m.has(key)) return { modified: false }; m.set(key, { v: String(v), etag: 'e' + (++n) }); return { modified: true }; },
    async setJSON(key, v, opts = {}) {
      if (opts.onlyIfNew && m.has(key)) return { modified: false };
      if (opts.onlyIfMatch && m.get(key)?.etag !== opts.onlyIfMatch) return { modified: false };
      m.set(key, { v: JSON.stringify(v), etag: 'e' + (++n) }); return { modified: true };
    },
    async delete(key) { m.delete(key); },
  };
}
export const _reset = () => stores.clear();
