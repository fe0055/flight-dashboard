/**
 * Southwest flight lookup proxy for Flight Dashboard.
 * Cloudflare Worker secret: AERODATABOX_API_KEY
 * Set ALLOWED_ORIGIN to your GitHub Pages site, without trailing slash.
 */
const ALLOWED_ORIGIN = 'https://fe0055.github.io';
const API_HOST = 'aerodatabox.p.rapidapi.com';
const API_BASE = 'https://' + API_HOST;
function respond(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
      ...extra
    }
  });
}
function trimAirport(a) {
  return {
    iata: typeof a?.airport?.iata === 'string' ? a.airport.iata.toUpperCase() : null,
    scheduled: a?.scheduledTime || null,
    predicted: a?.predictedTime || null,
    gate: a?.gate || null,
    terminal: a?.terminal || null
  };
}
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') {
      if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin'
        }
      });
    }
    if (request.method !== 'GET') return respond({error:'Method not allowed'},405);
    if (origin && origin !== ALLOWED_ORIGIN) return respond({error:'Origin not allowed'},403);
    const url = new URL(request.url);
    if (url.pathname !== '/flight') return respond({error:'Not found'},404);
    const number = (url.searchParams.get('number') || '').replace(/^WN/i,'');
    const date = url.searchParams.get('date') || '';
    if (!/^\d{1,5}$/.test(number) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date+'T00:00:00Z')))
      return respond({error:'Invalid flight number or date'},400);
    if (!env.AERODATABOX_API_KEY) return respond({error:'API secret not configured'},503);
    // Cache repeated lookups for 15 minutes to conserve API quota.
    const cacheKey = new Request('https://flight-dashboard-cache.invalid/'+date+'/WN'+Number(number));
    const cached = await caches.default.match(cacheKey);
    if (cached) return respond(await cached.json(),200,{'X-Flight-Cache':'HIT'});
    try {
      const upstream = await fetch(API_BASE+'/flights/number/WN'+Number(number)+'/'+date,{
        headers:{'X-RapidAPI-Key':env.AERODATABOX_API_KEY,'X-RapidAPI-Host':API_HOST}
      });
      if (!upstream.ok) return respond({error:'Flight provider unavailable',providerStatus:upstream.status},502);
      const raw = await upstream.json();
      const source = Array.isArray(raw) ? raw : [];
      const flights = source.map(f=>({
        number:'WN'+Number(number),
        date,
        status:f.status || 'Unknown',
        departure:trimAirport(f.departure),
        arrival:trimAirport(f.arrival)
      })).filter(f=>/^[A-Z]{3}$/.test(f.departure.iata||'') && /^[A-Z]{3}$/.test(f.arrival.iata||''));
      const result = {source:'AeroDataBox',retrievedAt:new Date().toISOString(),flights};
      // Never cache upstream errors. Cache a validated success only.
      ctx.waitUntil(caches.default.put(cacheKey,new Response(JSON.stringify(result),{
        headers:{'Cache-Control':'public, max-age=900'}
      })));
      return respond(result,200,{'X-Flight-Cache':'MISS'});
    } catch {
      return respond({error:'Flight provider request failed'},502);
    }
  }
};
