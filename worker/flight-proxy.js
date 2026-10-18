/**
 * Southwest flight lookup proxy for Flight Dashboard.
 * Deployment managed by GitHub Actions and Cloudflare Wrangler.
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
    gate: gateOf(a) || gateOf(a?.airport) || null,
    terminal: a?.terminal || null
  };
}
function gateOf(m) {
  const g=m?.gate ?? m?.gateNumber ?? m?.boardingGate ?? m?.gateInfo;
  if(typeof g==='string'&&g.trim())return g.trim();
  if(typeof g==='number')return String(g);
  if(g&&typeof g==='object')return gateOf(g);
  return null;
}
function flightNumberMatches(f,number) {
  const candidates=[f.number,f.flightNumber,f.flight?.number,f.airline?.iata&&f.number?f.airline.iata+f.number:null];
  return candidates.some(x=>x!=null&&String(x).replace(/[^a-z0-9]/gi,'').toUpperCase()==='WN'+Number(number));
}
async function boardGate(env, airport, date, number, direction, opposite) {
  if(!/^[A-Z]{3}$/.test(airport))return null;
  const from=date+'T00:00',to=date+'T12:00',from2=date+'T12:00',to2=date+'T23:59';
  for(const [start,end] of [[from,to],[from2,to2]]) {
    const u=API_BASE+'/flights/airports/iata/'+airport+'/'+start+'/'+end+'?direction='+direction+'&withLeg=true';
    const response=await fetch(u,{headers:{'X-RapidAPI-Key':env.AERODATABOX_API_KEY,'X-RapidAPI-Host':API_HOST}});
    if(!response.ok)continue;
    const data=await response.json();
    const rows=direction==='Departure'?data.departures:data.arrivals;
    if(!Array.isArray(rows))continue;
    for(const f of rows) {
      if(!flightNumberMatches(f,number))continue;
      const other=direction==='Departure'?f.arrival?.airport?.iata:f.departure?.airport?.iata;
      if(other&&other!==opposite)continue;
      const movement=direction==='Departure'?(f.departure||f.movement):(f.arrival||f.movement);
      const gate=gateOf(movement);
      if(gate)return gate;
    }
  }
  return null;
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
    const cacheKey = new Request('https://flight-dashboard-cache.invalid/v2/'+date+'/WN'+Number(number));
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
      // Airport FIDS fallback: only query when a gate is missing. Never guess.
      // Each segment is matched by flight number and opposite airport.
      for(const f of flights) {
        if(!f.departure.gate) {
          try { f.departure.gate=await boardGate(env,f.departure.iata,date,number,'Departure',f.arrival.iata); }
          catch(e) { /* preserve primary flight data */ }
        }
        if(!f.arrival.gate) {
          try { f.arrival.gate=await boardGate(env,f.arrival.iata,date,number,'Arrival',f.departure.iata); }
          catch(e) { /* preserve primary flight data */ }
        }
      }
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
