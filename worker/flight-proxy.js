/**
 * Southwest flight lookup proxy for Flight Dashboard.
 * Deployment managed by GitHub Actions and Cloudflare Wrangler.
 * Redeploy with configured AeroDataBox secret.
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
function runwayOf(a) {
  // AeroDataBox can return runway as a string or a structured runway object.
  const candidates=[a?.runway,a?.runwayNumber,a?.runwayName,a?.actualRunway,a?.landingRunway,a?.departureRunway,a?.runwayInfo];
  for(const candidate of candidates){
    const value=typeof candidate==='object'&&candidate!==null
      ?(candidate.name||candidate.number||candidate.designator||candidate.ident||candidate.id)
      :candidate;
    if(typeof value!=='string'&&typeof value!=='number')continue;
    const normalized=String(value).trim().toUpperCase().replace(/^RWY\s*/,'').replace(/^RUNWAY\s*/,'');
    if(/^(0?[1-9]|[12][0-9]|3[0-6])[LRC]?$/.test(normalized))
      return normalized.replace(/^(\d)(?=[LRC]?$)/,'0$1');
  }
  return null;
}
function trimAirport(a) {
  return {
    iata: typeof a?.airport?.iata === 'string' ? a.airport.iata.toUpperCase() : null,
    scheduled: a?.scheduledTime || null,
    predicted: a?.predictedTime || null,
    runway: runwayOf(a),
    runwayTime: a?.runwayTime || null,
    actualRunwayTime: a?.actualRunwayTime || null,
    predictedRunwayTime: a?.predictedRunwayTime || null,
    estimatedRunwayTime: a?.estimatedRunwayTime || null,
    takeoffTime: a?.takeoffTime || null,
    landingTime: a?.landingTime || null,
    gate: gateOf(a) || gateOf(a?.airport) || null,
    terminal: a?.terminal || null
  };
}
function gateOf(m, depth=0) {
  if(depth>3 || m==null)return null;
  if(typeof m==='string')return /^[A-Z0-9][A-Z0-9 -]{0,15}$/i.test(m.trim())?m.trim().toUpperCase():null;
  if(typeof m==='number')return String(m);
  if(typeof m!=='object')return null;
  for(const key of ['gate','gateNumber','gateName','boardingGate','gateInfo','gateAssignment','terminalGate','actualGate','estimatedGate','scheduledGate']){
    const value=gateOf(m[key],depth+1);
    if(value)return value;
  }
  return null;
}
function flightNumberMatches(f,number) {
  const wanted=String(Number(number));
  const candidates=[f.number,f.flightNumber,f.flight?.number,f.flight?.flightNumber,f.airline?.iata&&f.number?f.airline.iata+f.number:null];
  return candidates.some(x=>{
    if(x==null)return false;
    const v=String(x).replace(/[^a-z0-9]/gi,'').toUpperCase();
    return v===wanted || v==='WN'+wanted || v==='SWA'+wanted;
  });
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
      const gate=gateOf(movement) || gateOf(movement?.airport);
      if(gate)return gate;
    }
  }
  return null;
}

async function airlabsFallback(env, number, date) {
  if (!env.AIRLABS_API_KEY) return null;
  const endpoint = new URL('https://airlabs.co/api/v9/schedules');
  endpoint.searchParams.set('api_key', env.AIRLABS_API_KEY);
  endpoint.searchParams.set('flight_iata', 'WN' + Number(number));
  const response = await fetch(endpoint.toString());
  if (!response.ok) return null;
  const payload = await response.json();
  if (payload.error || !Array.isArray(payload.response)) return null;
  const flights = payload.response.filter(f => {
    const flightCode = String(f.flight_iata || '').replace(/\s/g, '').toUpperCase();
    const scheduled = String(f.dep_time || f.dep_time_utc || '');
    return flightCode === 'WN' + Number(number) && scheduled.slice(0,10) === date;
  }).map(f => ({
    number: 'WN' + Number(number), date, status: f.status || 'Unknown',
    departure: {iata:f.dep_iata || null, scheduled:f.dep_time || null, predicted:f.dep_estimated || null, runway:null, gate:f.dep_gate || null, terminal:f.dep_terminal || null},
    arrival: {iata:f.arr_iata || null, scheduled:f.arr_time || null, predicted:f.arr_estimated || null, runway:null, gate:f.arr_gate || null, terminal:f.arr_terminal || null}
  })).filter(f => /^[A-Z]{3}$/.test(f.departure.iata||'') && /^[A-Z]{3}$/.test(f.arrival.iata||''));
  return flights.length ? {source:'AirLabs',retrievedAt:new Date().toISOString(),flights} : null;
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
    if (url.pathname === '/atis') {
      const icao=(url.searchParams.get('icao')||'').toUpperCase();
      if(!/^K[A-Z]{3}$/.test(icao))return respond({error:'US ICAO airport required'},400);
      const cacheKey=new Request('https://flight-dashboard-cache.invalid/atis-free/v1/'+icao);
      const cached=await caches.default.match(cacheKey);
      if(cached)return respond(await cached.json());
      try{
        const upstream=await fetch('https://datis.clowd.io/api/'+icao,{headers:{Accept:'application/json'}});
        if(!upstream.ok)return respond({icao,available:false,reason:'D-ATIS source unavailable',source:'datis.clowd.io'},200);
        const data=await upstream.json();
        const reports=Array.isArray(data)?data:[data];
        const arrivals=reports.filter(x=>x&&/^(arrival|combined)$/i.test(String(x.type||'')));
        const runways=[];
        const add=v=>{const m=String(v).toUpperCase().match(/^(0?[1-9]|[12][0-9]|3[0-6])([LRC]?)$/);if(m){const n=m[1].padStart(2,'0')+m[2];if(!runways.includes(n))runways.push(n)}};
        for(const report of arrivals){
          const raw=String(report.datis||'').toUpperCase();
          // Restrict extraction to explicit landing runway clauses, not general approach/runway mentions.
          const clauses=raw.match(/(?:LANDING|ARRIVALS?)(?:\\s+(?:RUNWAYS?|RWYS?))?\\s+(?:ON|USING|IN USE|RUNWAYS?|RWYS?|RWY|ARE|IS|AND|,|\\/|\\s)*\\s*((?:\\d{1,2}[LRC]?\\s*(?:,|\\/|AND|&|\\s)\\s*)*\\d{1,2}[LRC]?)/g)||[];
          for(const clause of clauses){
            const after=clause.replace(/^.*?(?:LANDING|ARRIVALS?)/,'');
            for(const m of after.matchAll(/\\b(\\d{1,2}[LRC]?)\\b/g))add(m[1]);
          }
        }
        const letter=arrivals.find(x=>x.code)?.code||null;
        const result={icao,runways,letter,available:runways.length>0,source:'datis.clowd.io',retrievedAt:new Date().toISOString(),disclaimer:'NOT FOR OPERATIONAL USE'};
        ctx.waitUntil(caches.default.put(cacheKey,new Response(JSON.stringify(result),{headers:{'Cache-Control':'public, max-age=120'}})));
        return respond(result);
      }catch{return respond({icao,available:false,runways:[],source:'datis.clowd.io',reason:'D-ATIS fetch failed'},200)}
    }
    if (url.pathname !== '/flight') return respond({error:'Not found'},404);
    const number = (url.searchParams.get('number') || '').replace(/^WN/i,'');
    const date = url.searchParams.get('date') || '';
    if (!/^\d{1,5}$/.test(number) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date+'T00:00:00Z')))
      return respond({error:'Invalid flight number or date'},400);
    if (!env.AERODATABOX_API_KEY && !env.AIRLABS_API_KEY) return respond({error:'API secrets not configured'},503);
    // Cache repeated lookups for 15 minutes to conserve API quota.
    const cacheKey = new Request('https://flight-dashboard-cache.invalid/v3/'+date+'/WN'+Number(number));
    const cached = await caches.default.match(cacheKey);
    if (cached) return respond(await cached.json(),200,{'X-Flight-Cache':'HIT'});
    try {
      if (!env.AERODATABOX_API_KEY) { const alt=await airlabsFallback(env,number,date); return alt?respond(alt):respond({error:'No flight data available'},502); }
      const upstream = await fetch(API_BASE+'/flights/number/WN'+Number(number)+'/'+date,{
        headers:{'X-RapidAPI-Key':env.AERODATABOX_API_KEY,'X-RapidAPI-Host':API_HOST}
      });
      if (!upstream.ok) { const alt=await airlabsFallback(env,number,date); return alt?respond(alt):respond({error:'Flight providers unavailable',providerStatus:upstream.status},502); }
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
      try { const alt=await airlabsFallback(env,number,date); if(alt)return respond(alt); } catch(e) {}
      return respond({error:'Flight provider request failed'},502);
    }
  }
};
