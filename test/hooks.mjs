export async function resolve(spec, ctx, next) {
  if (spec === '@netlify/blobs') return { url: new URL('./mock-blobs.mjs', import.meta.url).href, shortCircuit: true };
  return next(spec, ctx);
}
// esbuild (Netlify's bundler) imports JSON without `with { type: "json" }`; Node needs it.
export async function load(url, ctx, next) {
  if (url.endsWith('.json')) return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: 'json' } });
  return next(url, ctx);
}
