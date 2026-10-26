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
  if (!env.AIRLABS_API_KEY) return {error:'airlabs_key_missing'};
  const endpoint = new URL('https://airlabs.co/api/v9/schedules');
  endpoint.searchParams.set('api_key', env.AIRLABS_API_KEY);
  endpoint.searchParams.set('flight_iata', 'WN' + Number(number));
  const response = await fetch(endpoint.toString());
  if (!response.ok) return {error:'airlabs_http_error',airlabsStatus:response.status};
  const payload = await response.json();
  if (payload.error) return {error:'airlabs_api_error',airlabsCode:String(payload.error.code || payload.error.type || 'unknown').slice(0,80)};
  if (!Array.isArray(payload.response)) return {error:'airlabs_unexpected_response'};
  // Just after midnight, a flight that departed yesterday can still be active today.
  // Only include that previous-day leg when its arrival date is the requested date.
  const previousDate = new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  const flights = payload.response.filter(f => {
    const flightCode = String(f.flight_iata || '').replace(/\s/g, '').toUpperCase();
    const departureDate = String(f.dep_time || f.dep_time_utc || '').slice(0,10);
    const arrivalDate = String(f.arr_estimated || f.arr_actual || f.arr_time || '').slice(0,10);
    const status = String(f.status || '').toLowerCase();
    const overnightActive = departureDate === previousDate && arrivalDate === date && ['active','en-route','en_route','landed'].includes(status);
    return flightCode === 'WN' + Number(number) && (departureDate === date || overnightActive);
  }).map(f => ({
    number: 'WN' + Number(number), date:String(f.dep_time || f.dep_time_utc || '').slice(0,10), status: f.status || 'Unknown',
    departure: {iata:f.dep_iata || null, scheduled:f.dep_time || null, predicted:f.dep_estimated || null, scheduledUtc:f.dep_time_utc || null, predictedUtc:f.dep_estimated_utc || null, actual:f.dep_actual || null, actualUtc:f.dep_actual_utc || null, runway:null, gate:f.dep_gate || null, terminal:f.dep_terminal || null},
    arrival: {iata:f.arr_iata || null, scheduled:f.arr_time || null, predicted:f.arr_estimated || null, scheduledUtc:f.arr_time_utc || null, predictedUtc:f.arr_estimated_utc || null, actual:f.arr_actual || null, actualUtc:f.arr_actual_utc || null, runway:null, gate:f.arr_gate || null, terminal:f.arr_terminal || null}
  })).filter(f => /^[A-Z]{3}$/.test(f.departure.iata||'') && /^[A-Z]{3}$/.test(f.arrival.iata||''));
  return flights.length ? {source:'AirLabs',retrievedAt:new Date().toISOString(),flights} : {error:'airlabs_no_matching_flights',returnedCount:payload.response.length};
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
    if (url.pathname === '/airport-config') {
      const airport=(url.searchParams.get('airport')||'').toUpperCase();
      if(!/^[A-Z]{3}$/.test(airport))return respond({error:'Three-letter US airport code required'},400);
      const cacheKey=new Request('https://flight-dashboard-cache.invalid/faa-config/v1/'+airport);
      const cached=await caches.default.match(cacheKey);
      if(cached)return respond(await cached.json());
      try{
        const upstream=await fetch('https://nasstatus.faa.gov/api/airport-events',{headers:{Accept:'application/json'}});
        if(!upstream.ok)return respond({airport,available:false,reason:'FAA feed unavailable'},200);
        const events=await upstream.json();
        const event=Array.isArray(events)?events.find(x=>String(x.airportId||'').toUpperCase()===airport):null;
        const config=event?.airportConfig;
        const timestamp=config?.sourceTimeStamp||null;
        const age=Date.now()-Date.parse(timestamp||'');
        const fresh=Number.isFinite(age)&&age>=-120000&&age<=20*60000;
        const extract=value=>[...new Set((String(value||'').toUpperCase().match(/\\b(?:0?[1-9]|[12][0-9]|3[0-6])[LRC]?\\b/g)||[]).map(x=>x.padStart(2,'0')))];
        const result={airport,available:!!(config&&fresh),departureRunways:fresh?extract(config?.departureRunwayConfig):[],arrivalRunways:fresh?extract(config?.arrivalRunwayConfig):[],source:'FAA NAS Status',sourceTimeStamp:timestamp,disclaimer:'Airport-wide configuration only; not a flight-specific runway assignment'};
        ctx.waitUntil(caches.default.put(cacheKey,new Response(JSON.stringify(result),{headers:{'Cache-Control':'public, max-age=120'}})));
        return respond(result);
      }catch(e){return respond({airport,available:false,reason:'FAA airport configuration lookup failed'},200);}
    }
    if (url.pathname === '/atis') {
      const icao=(url.searchParams.get('icao')||'').toUpperCase();
      if(!/^K[A-Z]{3}$/.test(icao))return respond({error:'US ICAO airport required'},400);
      const cacheKey=new Request('https://flight-dashboard-cache.invalid/atis-free/v2/'+icao);
      const cached=await caches.default.match(cacheKey);
      if(cached)return respond(await cached.json());
      try{
        const upstream=await fetch('https://datis.clowd.io/api/'+icao,{headers:{Accept:'application/json'}});
        if(!upstream.ok)return respond({icao,available:false,reason:'D-ATIS source unavailable',source:'datis.clowd.io'},200);
        const data=await upstream.json();
        const reports=Array.isArray(data)?data:Array.isArray(data?.atis)?data.atis:Array.isArray(data?.reports)?data.reports:[data];
        const arrivals=[],departures=[];
        const add=(list,raw)=>{
          for(const m of String(raw).toUpperCase().matchAll(/\b(?:0?[1-9]|[12]\d|3[0-6])[LRC]?\b/g)){
            const token=m[0],match=token.match(/^(\d{1,2})([LRC]?)$/);
            if(!match)continue;
            const runway=match[1].padStart(2,'0')+match[2];
            if(!list.includes(runway))list.push(runway);
          }
        };
        const extract=(raw,kind)=>{
          // Only accept explicit runway-use clauses; never infer from approaches or wind.
          const words=kind==='departure'?'(?:DEPARTURES?|DEPARTING|TAKEOFFS?|TAKE.OFF|DEP|TKOF)':'(?:ARRIVALS?|LANDING|LDG)';
          const expression=new RegExp('\\b'+words+'\\b(?:\\s+(?:RUNWAYS?|RWYS?|RWY|ON|USING|IN|USE|ARE|IS|FOR|AND))*\\s*[:,-]?\\s*((?:(?:RUNWAYS?|RWYS?|RWY)\\s*)?(?:0?[1-9]|[12]\\d|3[0-6])[LRC]?(?:\\s*(?:,|\\/|&|AND|OR)\\s*(?:0?[1-9]|[12]\\d|3[0-6])[LRC]?)*)','gi');
          for(const match of String(raw).matchAll(expression))add(kind==='departure'?departures:arrivals,match[1]);
        };
        for(const report of reports){
          if(!report||typeof report!=='object')continue;
          const type=String(report.type||report.atisType||'').toLowerCase();
          const raw=String(report.datis||report.text||report.atis||'').toUpperCase();
          if(!raw)continue;
          if(/^(arr|arrival|combined|both)$/.test(type)||!type)extract(raw,'arrival');
          if(/^(dep|departure|combined|both)$/.test(type)||!type)extract(raw,'departure');
        }
        const result={icao,arrivalRunways:arrivals,departureRunways:departures,runways:arrivals,
          available:arrivals.length>0||departures.length>0,source:'datis.clowd.io',
          retrievedAt:new Date().toISOString(),reportCount:reports.length,
          disclaimer:'INFORMATIONAL ONLY - NOT FOR OPERATIONAL USE. VERIFY WITH CURRENT ATIS/ATC'};
        ctx.waitUntil(caches.default.put(cacheKey,new Response(JSON.stringify(result),{headers:{'Cache-Control':'public, max-age=120'}})));
        return respond(result);
      }catch{return respond({icao,available:false,arrivalRunways:[],departureRunways:[],source:'datis.clowd.io',reason:'D-ATIS fetch failed'},200)}
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
      if (!env.AERODATABOX_API_KEY) { try { const alt=await airlabsFallback(env,number,date); if(alt?.flights)return respond(alt); return respond({error:'No flight data available',airlabs:alt},502); } catch(e) {return respond({error:'AirLabs request failed'},502);}  }
      const upstream = await fetch(API_BASE+'/flights/number/WN'+Number(number)+'/'+date,{
        headers:{'X-RapidAPI-Key':env.AERODATABOX_API_KEY,'X-RapidAPI-Host':API_HOST}
      });
      if (!upstream.ok) { try { const alt=await airlabsFallback(env,number,date); if(alt?.flights)return respond(alt); return respond({error:'Flight providers unavailable',providerStatus:upstream.status,airlabs:alt},502); } catch(e) {return respond({error:'Flight providers unavailable',providerStatus:upstream.status,airlabs:{error:'airlabs_request_failed'}},502);}  }
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
      try { const alt=await airlabsFallback(env,number,date); if(alt?.flights)return respond(alt); return respond({error:'Flight provider request failed',airlabs:alt},502); } catch(e) {}
      return respond({error:'Flight provider request failed',airlabs:{error:'airlabs_request_failed'}},502);
    }
  }
};
