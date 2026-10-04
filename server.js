'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_BASE = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const STT_MODEL = process.env.STT_MODEL || 'whisper-large-v3-turbo';
const LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-oss-120b';
const VISION_MODEL = process.env.VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const APP_PIN = process.env.APP_PIN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const MOLLIE_KEY = process.env.MOLLIE_API_KEY || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const FOLLOWUP_DAYS = Number(process.env.FOLLOWUP_DAYS) || 7;
const TOKEN = APP_PIN ? crypto.createHash('sha256').update('kgn-offerte:' + APP_PIN).digest('hex') : '';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ---------- Statische app ---------- */
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (/(\.html|sw\.js|manifest\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

/* ---------- Toegang ---------- */
function auth(req, res, next) {
  if (!APP_PIN) return next();
  const t = String(req.headers['x-kgn-token'] || '');
  if (t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN))) return next();
  res.status(401).json({ error: 'Niet ingelogd' });
}
const fails = new Map();
app.post('/api/login', express.json({ limit: '2kb' }), (req, res) => {
  if (!APP_PIN) return res.json({ token: '' });
  const ip = req.ip || 'x';
  const f = fails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 10 * 60 * 1000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 6) return res.status(429).json({ error: 'Te vaak geprobeerd. Wacht 10 minuten.' });
  if (String((req.body || {}).pin || '') === APP_PIN) { fails.delete(ip); return res.json({ token: TOKEN }); }
  f.n++; fails.set(ip, f);
  res.status(401).json({ error: 'Onjuiste pincode' });
});
app.get('/api/health', (req, res) => res.json({ ok: true, ai: !!GROQ_KEY, pdf: true, auth: !!APP_PIN, mollie: !!MOLLIE_KEY, push: true }));

/* ---------- Opslag ---------- */
function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');

/* ---------- Instellingen (prijzen, bedrijfsgegevens, offertenummer) ---------- */
const SFILE = path.join(DATA_DIR, 'settings.json');
const readSettings = () => readJson(SFILE, { cfg: null, counter: 1 });
const writeSettings = s => writeJson(SFILE, s);
app.get('/api/settings', auth, (req, res) => { const s = readSettings(); res.json({ cfg: s.cfg, counter: s.counter }); });
app.put('/api/settings', auth, express.json({ limit: '1mb' }), (req, res) => {
  const s = readSettings();
  const cfg = (req.body && typeof req.body.cfg === 'object') ? req.body.cfg : null;
  if (!cfg) return res.status(400).json({ error: 'Geen instellingen' });
  delete cfg.counter;
  s.cfg = cfg;
  writeSettings(s);
  res.json({ ok: true });
});
app.post('/api/number', auth, (req, res) => {
  const s = readSettings();
  s.counter = (Number(s.counter) || 1) + 1;
  writeSettings(s);
  res.json({ counter: s.counter });
});

/* ---------- Spraak naar tekst (Groq Whisper) ---------- */
const VOCAB = 'Opname voor een offerte van een aannemer. Woonkamer 6 bij 4,5, hoogte 2,6. Slaapkamer, badkamer, keuken, hal, overloop, zolder. Sloopwerk, bouwcontainer, metalstud, verlaagd plafond, stucwerk, schilderwerk, dekvloer, tegelwerk, PVC vloer, plinten, elektrapunten, groepenkast, loodgieterspunt, vloerverwarming, sanitair, projectmanagement.';
const LANGS = ['nl', 'en', 'pl', 'de', 'tr', 'ro', 'bg', 'uk', 'ar', 'pt', 'es', 'fr'];
const EXT = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
app.post('/api/transcribe', auth, express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'Spraakherkenning is niet ingesteld (GROQ_API_KEY ontbreekt).' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Geen opname ontvangen.' });
  const ct = String(req.headers['content-type'] || 'audio/webm').split(';')[0].trim();
  const lang = LANGS.includes(String(req.query.lang)) ? String(req.query.lang) : 'nl';
  try {
    const fd = new FormData();
    fd.append('file', new Blob([req.body], { type: ct }), 'opname.' + (EXT[ct] || 'webm'));
    fd.append('model', STT_MODEL);
    fd.append('language', lang);
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    if (lang === 'nl') fd.append('prompt', VOCAB);
    const r = await fetch(GROQ_BASE + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + GROQ_KEY }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('transcribe', r.status, JSON.stringify(j).slice(0, 400)); return res.status(502).json({ error: r.status === 429 ? 'Limiet van de gratis spraakdienst bereikt. Probeer het zo opnieuw.' : 'Uitschrijven mislukt.' }); }
    res.json({ text: String(j.text || '').trim() });
  } catch (e) {
    console.error('transcribe', e);
    res.status(502).json({ error: 'Uitschrijven mislukt.' });
  }
});

/* ---------- Tekst en foto's naar offerteregels (Groq taalmodel) ---------- */
function schemaFor(ids, vision) {
  const num = { type: ['number', 'null'] };
  const str = { type: ['string', 'null'] };
  const sch = {
    type: 'object', additionalProperties: false,
    required: ['klant', 'adres', 'plaats', 'weken', 'korting', 'btw', 'rooms', 'items', 'custom', 'niet_herkend'],
    properties: {
      klant: str, adres: str, plaats: str, weken: num, korting: num, btw: num,
      rooms: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['naam', 'lengte', 'breedte', 'hoogte'],
        properties: { naam: { type: 'string' }, lengte: { type: 'number' }, breedte: { type: 'number' }, hoogte: num } } },
      items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'aantal'],
        properties: { id: { type: 'string', enum: ids }, aantal: num } } },
      custom: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['omschrijving', 'aantal', 'eenheid'],
        properties: { omschrijving: { type: 'string' }, aantal: num, eenheid: { type: 'string' } } } },
      niet_herkend: { type: 'array', items: { type: 'string' } }
    }
  };
  if (vision) {
    sch.required.push('waarneming', 'titel');
    sch.properties.waarneming = str;
    sch.properties.titel = str;
  }
  return sch;
}
function catalogText(catalog) {
  return catalog.map(c => `- ${c.id}: ${c.name} (${c.desc || ''}), eenheid: ${c.unit}${c.type === 'toggle' ? ', vaste post' : ''}${c.type === 'percent' ? ', percentage' : ''}${c.basis ? `, hoeveelheid volgt uit ${c.basis}oppervlak` : ''}`).join('\n');
}
function systemPrompt(catalog) {
  return `Je zet een ingesproken opname van een aannemer om naar gegevens voor een Nederlandse offerte. De tekst is automatisch uitgeschreven en kan spreektaal en kleine fouten bevatten. De tekst is meestal Nederlands, maar kan ook in een andere taal zijn (bijvoorbeeld Engels, Pools of Turks). Schrijf namen van ruimtes en omschrijvingen altijd in het Nederlands.

Werkzaamheden in de prijslijst:
${catalogText(catalog)}

Regels:
- rooms: elke ruimte waarvan maten genoemd worden. Lengte, breedte en hoogte in meters ("4 meter 50" = 4.5, "260 centimeter" = 2.6). Geen hoogte genoemd: null.
- items: alleen id's uit de prijslijst. Zet aantal op het genoemde aantal of de genoemde m² of meters. Is er geen hoeveelheid genoemd, of moet die uit de ruimtes volgen, zet aantal dan op null. Vaste posten en percentages: aantal null, behalve een expliciet genoemd percentage projectmanagement.
- Stucwerk of schilderwerk zonder "plafond" geldt voor de wanden. Noemt hij wanden en plafonds, neem dan beide op. Tegelwerk zonder "wand" geldt voor de vloer.
- custom: werk dat duidelijk gevraagd wordt maar niet in de prijslijst staat, met aantal en eenheid (bijvoorbeeld "stuk", "m²", "m", "post").
- klant, adres, plaats: alleen als die genoemd worden. weken: doorlooptijd in weken. korting: percentage. btw: 21, 9 of 0 (btw verlegd), anders null.
- niet_herkend: korte stukjes tekst die je niet kon plaatsen.
- Verzin niets. Wat niet genoemd is blijft null of leeg.
Antwoord alleen met JSON volgens het schema.`;
}
function visionPrompt(catalog) {
  return `Je bent een ervaren Nederlandse aannemer. Je krijgt foto's van een ruimte of situatie bij een klant, soms met een korte toelichting. Bepaal welke werkzaamheden uit de prijslijst nodig lijken om de ruimte op te knappen of te verbouwen, en schat de hoeveelheden.

Werkzaamheden in de prijslijst:
${catalogText(catalog)}

Regels:
- waarneming: twee of drie zinnen in het Nederlands over wat je ziet (staat van wanden, plafond, vloer, installaties, sanitair) en waarom je deze werkzaamheden kiest.
- titel: een korte projectomschrijving, bijvoorbeeld "Renovatie badkamer" of "Opknappen woonkamer". Maximaal 6 woorden.
- rooms: alleen als je de maten van een ruimte redelijk kunt schatten (bijvoorbeeld aan de hand van deuren van 2,1 m hoog en tegels). Rond af op halve meters. Anders leeg.
- items: alleen id's uit de prijslijst en alleen werk dat echt nodig lijkt. aantal: je schatting in de eenheid van de prijslijst, of null als die uit de ruimtes moet volgen of niet te schatten is.
- custom: nodig werk dat niet in de prijslijst staat, in het Nederlands.
- klant, adres, plaats, weken, korting, btw: null, tenzij de toelichting ze noemt.
- niet_herkend: leeg.
Antwoord alleen met JSON volgens het schema.`;
}
const n = v => (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.round(v * 100) / 100 : null;
const s = (v, m = 120) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, m) : null;
function normalize(raw, catalog) {
  const ids = new Set(catalog.map(c => c.id));
  const out = { ai: true, rooms: [], items: [], custom: [], rest: [] };
  out.klant = s(raw.klant); out.adres = s(raw.adres); out.plaats = s(raw.plaats);
  const w = n(raw.weken); if (w) out.weken = String(w);
  const k = n(raw.korting); if (k != null && k <= 100) out.korting = k;
  if ([0, 9, 21].includes(raw.btw)) out.btw = raw.btw;
  if (raw.waarneming) out.waarneming = s(raw.waarneming, 600);
  if (raw.titel) out.titel = s(raw.titel, 60);
  (Array.isArray(raw.rooms) ? raw.rooms : []).forEach(r => {
    let l = n(r && r.lengte), b = n(r && r.breedte), h = n(r && r.hoogte);
    if (!l || !b || l > 200 || b > 200) return;
    if (h && h > 10) h = h / 100;
    out.rooms.push({ naam: s(r.naam) || '', l, b, h: h || null });
  });
  const seen = new Map();
  (Array.isArray(raw.items) ? raw.items : []).forEach(x => {
    if (!x || !ids.has(x.id)) return;
    const q = n(x.aantal);
    if (!seen.has(x.id) || q != null) seen.set(x.id, { id: x.id, qty: q });
  });
  out.items = [...seen.values()];
  (Array.isArray(raw.custom) ? raw.custom : []).forEach(c => {
    const name = s(c && c.omschrijving); if (!name) return;
    out.custom.push({ name, qty: n(c.aantal), unit: s(c.eenheid) || 'stuk' });
  });
  out.rest = (Array.isArray(raw.niet_herkend) ? raw.niet_herkend : []).map(x => s(x)).filter(Boolean).slice(0, 10);
  return out;
}
async function chat(body) {
  const r = await fetch(GROQ_BASE + '/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('llm ' + r.status + ' ' + JSON.stringify(j).slice(0, 300)); e.status = r.status; throw e; }
  let txt = String(j.choices[0].message.content || '').trim();
  const m = txt.match(/\{[\s\S]*\}/); if (m) txt = m[0];
  return JSON.parse(txt);
}
function cleanCatalog(list) {
  return Array.isArray(list) ? list.slice(0, 200).map(c => ({
    id: String(c.id), name: String(c.name || ''), desc: String(c.desc || ''), unit: String(c.unit || ''), type: c.type ? String(c.type) : '', basis: c.basis ? String(c.basis) : ''
  })) : [];
}
app.post('/api/parse', auth, express.json({ limit: '100kb' }), async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'AI is niet ingesteld.' });
  const text = String((req.body || {}).text || '').slice(0, 6000);
  const catalog = cleanCatalog((req.body || {}).catalog);
  if (!text || !catalog.length) return res.status(400).json({ error: 'Geen tekst of prijslijst.' });
  const messages = [{ role: 'system', content: systemPrompt(catalog) }, { role: 'user', content: text }];
  try {
    let raw;
    try {
      raw = await chat({ model: LLM_MODEL, temperature: 0.1, messages,
        response_format: { type: 'json_schema', json_schema: { name: 'offerte', strict: true, schema: schemaFor(catalog.map(c => c.id)) } } });
    } catch (e) {
      if (e.status === 429) throw e;
      console.warn('strict schema mislukt, terugval naar json_object:', e.message);
      raw = await chat({ model: LLM_MODEL, temperature: 0.1,
        messages: [{ role: 'system', content: messages[0].content + '\n\nJSON-schema:\n' + JSON.stringify(schemaFor(catalog.map(c => c.id))) }, messages[1]],
        response_format: { type: 'json_object' } });
    }
    res.json(normalize(raw || {}, catalog));
  } catch (e) {
    console.error('parse', e.message);
    res.status(502).json({ error: e.status === 429 ? 'Limiet van de gratis AI-dienst bereikt.' : 'AI kon de tekst niet verwerken.' });
  }
});

/* ---------- Foto's ---------- */
const PDIR = path.join(DATA_DIR, 'photos');
const PHOTO_RE = /^[\w-]{16,40}$/;
const photoFile = id => path.join(PDIR, id + '.jpg');
const imgType = buf => buf[0] === 0x89 ? 'image/png' : (buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/jpeg');
app.post('/api/photos', auth, express.raw({ type: () => true, limit: '12mb' }), (req, res) => {
  const b = req.body;
  if (!b || b.length < 100) return res.status(400).json({ error: 'Geen foto ontvangen.' });
  const isJpg = b[0] === 0xff && b[1] === 0xd8, isPng = b[0] === 0x89 && b[1] === 0x50, isWebp = b.slice(8, 12).toString() === 'WEBP';
  if (!isJpg && !isPng && !isWebp) return res.status(400).json({ error: 'Alleen JPG, PNG of WebP.' });
  const id = rid(18);
  fs.mkdirSync(PDIR, { recursive: true });
  fs.writeFileSync(photoFile(id), b);
  res.json({ id, url: '/files/photos/' + id + '.jpg' });
});
app.get('/files/photos/:file', (req, res) => {
  const id = String(req.params.file).replace(/\.jpg$/, '');
  if (!PHOTO_RE.test(id) || !fs.existsSync(photoFile(id))) return res.status(404).end();
  const buf = fs.readFileSync(photoFile(id));
  res.setHeader('Content-Type', imgType(buf));
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.end(buf);
});
function photoDataUrl(id) {
  const buf = fs.readFileSync(photoFile(id));
  return `data:${imgType(buf)};base64,${buf.toString('base64')}`;
}
app.post('/api/vision', auth, express.json({ limit: '200kb' }), async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'AI is niet ingesteld.' });
  const body = req.body || {};
  const ids = (Array.isArray(body.photos) ? body.photos : []).map(String).filter(id => PHOTO_RE.test(id) && fs.existsSync(photoFile(id))).slice(0, 5);
  const catalog = cleanCatalog(body.catalog);
  if (!ids.length || !catalog.length) return res.status(400).json({ error: 'Geen foto\'s of prijslijst.' });
  const note = String(body.note || '').slice(0, 2000);
  const content = [{ type: 'text', text: (note ? 'Toelichting van de aannemer: ' + note + '\n\n' : '') + 'Hier zijn de foto\'s. JSON-schema voor je antwoord:\n' + JSON.stringify(schemaFor(catalog.map(c => c.id), true)) }]
    .concat(ids.map(id => ({ type: 'image_url', image_url: { url: photoDataUrl(id) } })));
  try {
    const raw = await chat({ model: VISION_MODEL, temperature: 0.2, max_completion_tokens: 2000,
      messages: [{ role: 'system', content: visionPrompt(catalog) }, { role: 'user', content }],
      response_format: { type: 'json_object' } });
    const out = normalize(raw || {}, catalog);
    out.vision = true;
    res.json(out);
  } catch (e) {
    console.error('vision', e.message);
    res.status(502).json({ error: e.status === 429 ? 'Limiet van de gratis AI-dienst bereikt.' : 'AI kon de foto\'s niet bekijken.' });
  }
});

/* ---------- Adres opzoeken (PDOK) ---------- */
app.get('/api/adres', auth, async (req, res) => {
  const pc = String(req.query.pc || '').replace(/\s+/g, '').toUpperCase();
  const nr = String(req.query.nr || '').trim();
  const m = nr.match(/^(\d{1,5})\s*[-\s]?\s*([a-zA-Z0-9]{0,4})$/);
  if (!/^\d{4}[A-Z]{2}$/.test(pc) || !m) return res.status(400).json({ error: 'Ongeldige postcode of huisnummer.' });
  try {
    const u = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?rows=20&fl=straatnaam,huisnummer,huisletter,huisnummertoevoeging,postcode,woonplaatsnaam'
      + '&fq=type:adres&fq=postcode:' + pc + '&fq=huisnummer:' + m[1] + '&q=' + encodeURIComponent(pc + ' ' + m[1]);
    const r = await fetch(u, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('pdok ' + r.status);
    const docs = ((await r.json()).response || {}).docs || [];
    if (!docs.length) return res.status(404).json({ error: 'Adres niet gevonden.' });
    const toev = (m[2] || '').toUpperCase();
    const d = docs.find(x => ((x.huisletter || '') + (x.huisnummertoevoeging || '')).toUpperCase() === toev) || docs[0];
    const huis = d.huisnummer + (d.huisletter || '') + (d.huisnummertoevoeging ? '-' + d.huisnummertoevoeging : '');
    res.json({ straat: d.straatnaam, huisnummer: huis, postcode: d.postcode.replace(/^(\d{4})([A-Z]{2})$/, '$1 $2'), plaats: d.woonplaatsnaam });
  } catch (e) {
    console.error('adres', e.message);
    res.status(502).json({ error: 'Adres opzoeken lukt nu niet.' });
  }
});

/* ---------- Meldingen (web push) en activiteit ---------- */
const webpush = require('web-push');
const VFILE = path.join(DATA_DIR, 'vapid.json');
let VAPID = readJson(VFILE, null);
if (!VAPID) {
  VAPID = webpush.generateVAPIDKeys();
  try { writeJson(VFILE, VAPID); } catch (e) { console.warn('VAPID-sleutels niet bewaard', e.message); }
}
webpush.setVapidDetails('mailto:' + (process.env.PUSH_CONTACT || 'info@kgntotaalservice.nl'), VAPID.publicKey, VAPID.privateKey);
const PFILE = path.join(DATA_DIR, 'push.json');
const EFILE = path.join(DATA_DIR, 'events.json');
app.get('/api/push/key', auth, (req, res) => res.json({ key: VAPID.publicKey }));
app.post('/api/push/subscribe', auth, express.json({ limit: '10kb' }), (req, res) => {
  const sub = (req.body || {}).sub;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) return res.status(400).json({ error: 'Ongeldig abonnement.' });
  const subs = readJson(PFILE, []).filter(x => x.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: sub.keys, at: Date.now() });
  writeJson(PFILE, subs.slice(-20));
  res.json({ ok: true });
});
app.post('/api/push/test', auth, async (req, res) => {
  await notify('Meldingen staan aan', 'Je krijgt hier een seintje als een klant kijkt, tekent of betaalt.', '/');
  res.json({ ok: true });
});
async function notify(title, body, url, tag) {
  const subs = readJson(PFILE, []);
  if (!subs.length) return;
  const payload = JSON.stringify({ title, body, url: url || '/', tag });
  const keep = [];
  await Promise.all(subs.map(sub => webpush.sendNotification(sub, payload, { TTL: 86400 })
    .then(() => keep.push(sub))
    .catch(e => { if (e.statusCode !== 404 && e.statusCode !== 410) { keep.push(sub); console.warn('push', e.statusCode || e.message); } })));
  if (keep.length !== subs.length) writeJson(PFILE, keep);
}
function event(type, q, text, title) {
  const ev = readJson(EFILE, []);
  ev.push({ id: rid(6), at: Date.now(), type, quote: q ? q.id : null, nummer: q ? q.nummer : null, text });
  writeJson(EFILE, ev.slice(-200));
  notify(title || 'KGN Offerte', text, q ? '/?q=' + encodeURIComponent(q.id) : '/', type + ':' + (q ? q.id : '')).catch(() => {});
}
app.get('/api/events', auth, (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(readJson(EFILE, []).filter(e => e.at > since).slice(-50).reverse());
});

/* ---------- Offertes ---------- */
const QDIR = path.join(DATA_DIR, 'quotes');
const ID_RE = /^[\w-]{6,40}$/;
const quotes = new Map();
const byToken = new Map();
function indexTokens(q) {
  if (q.deleted) return;
  if (q.token) byToken.set(q.token, { q: q.id });
  (q.facturen || []).forEach(f => { if (f.token) byToken.set(f.token, { q: q.id, f: f.id }); });
}
(function loadQuotes() {
  try {
    fs.mkdirSync(QDIR, { recursive: true });
    fs.readdirSync(QDIR).filter(f => f.endsWith('.json')).forEach(f => {
      const q = readJson(path.join(QDIR, f), null);
      if (q && q.id) { quotes.set(q.id, q); indexTokens(q); }
    });
  } catch (e) { console.warn('Offertes laden mislukt', e.message); }
})();
function saveQuote(q) {
  q.updated = Date.now();
  quotes.set(q.id, q); indexTokens(q);
  writeJson(path.join(QDIR, q.id + '.json'), q);
}
const lastContact = x => Math.max(x.sentAt || 0, ...((x.followups || []).map(Number)));
function invoiceSummary(f) {
  return { id: f.id, nummer: f.nummer, datum: f.datum, verval: f.verval, pct: f.pct, label: f.label, excl: f.excl, btw: f.btw, incl: f.incl,
    status: f.status, paidAt: f.paidAt || null, token: f.token, sentAt: f.sentAt || null, followups: f.followups || [],
    lastContact: lastContact(f) || null, viewedAt: f.viewedAt || null, hasSnapshot: !!f.snapshot };
}
function summary(q) {
  const d = q.data || {}, k = d.klant || {}, p = d.project || {};
  return {
    id: q.id, nummer: d.nummer || q.nummer, status: q.status, created: q.created, updated: q.updated,
    klant: { naam: k.naam || '', tel: k.tel || '', email: k.email || '', adres: k.adres || '', plaats: k.plaats || '' },
    titel: p.titel || '', datum: d.datum, excl: (q.totals || {}).excl || 0, incl: (q.totals || {}).incl || 0,
    token: q.token || null, sentAt: q.sentAt || null, followups: q.followups || [], lastContact: lastContact(q) || null,
    viewedAt: q.viewedAt || null, views: q.views || 0,
    signed: q.signed ? { name: q.signed.name, at: q.signed.at } : null, rejected: q.rejected || null,
    facturen: (q.facturen || []).map(invoiceSummary)
  };
}
function getQ(req, res) {
  const q = quotes.get(String(req.params.id));
  if (!q || q.deleted) { res.status(404).json({ error: 'Offerte niet gevonden.' }); return null; }
  return q;
}
app.get('/api/quotes', auth, (req, res) => {
  res.json([...quotes.values()].filter(q => !q.deleted).map(summary).sort((a, b) => (b.updated || 0) - (a.updated || 0)));
});
app.get('/api/quotes/:id', auth, (req, res) => {
  const q = getQ(req, res); if (!q) return;
  res.json(Object.assign(summary(q), { data: q.data }));
});
app.put('/api/quotes/:id', auth, express.json({ limit: '2mb' }), (req, res) => {
  const id = String(req.params.id);
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Ongeldig id.' });
  const b = req.body || {};
  if (!b.data || typeof b.data !== 'object') return res.status(400).json({ error: 'Geen gegevens.' });
  let q = quotes.get(id);
  if (q && q.deleted) return res.status(410).json({ error: 'Deze offerte is verwijderd.' });
  if (!q) q = { id, status: 'concept', created: Date.now(), facturen: [] };
  q.data = b.data;
  q.nummer = b.data.nummer || q.nummer;
  q.totals = { excl: Number((b.totals || {}).excl) || 0, incl: Number((b.totals || {}).incl) || 0 };
  saveQuote(q);
  res.json(summary(q));
});
app.delete('/api/quotes/:id', auth, (req, res) => {
  const q = getQ(req, res); if (!q) return;
  q.deleted = Date.now();
  if (q.token) byToken.delete(q.token);
  (q.facturen || []).forEach(f => byToken.delete(f.token));
  saveQuote(q);
  res.json({ ok: true });
});
const STATUSES = ['concept', 'verstuurd', 'getekend', 'afgewezen'];
app.post('/api/quotes/:id/status', auth, express.json({ limit: '2kb' }), (req, res) => {
  const q = getQ(req, res); if (!q) return;
  const st = String((req.body || {}).status);
  if (!STATUSES.includes(st)) return res.status(400).json({ error: 'Onbekende status.' });
  q.status = st;
  if (st === 'getekend' && !q.signed) q.signed = { name: 'Handmatig gemarkeerd', at: Date.now(), manual: true };
  if (st !== 'getekend' && q.signed) delete q.signed;
  if (st === 'afgewezen' && !q.rejected) q.rejected = { at: Date.now(), reason: '', manual: true };
  if (st !== 'afgewezen') delete q.rejected;
  saveQuote(q);
  res.json(summary(q));
});
app.post('/api/quotes/:id/send', auth, express.json({ limit: '8mb' }), (req, res) => {
  const q = getQ(req, res); if (!q) return;
  const snap = String((req.body || {}).snapshot || '');
  if (snap && q.status !== 'getekend') q.snapshot = snap;
  if (!q.snapshot) return res.status(400).json({ error: 'Geen document.' });
  if (!q.token) q.token = rid(18);
  saveQuote(q);
  res.json(summary(q));
});
// Vastleggen dat de offerte (of een factuur) echt verstuurd is, of dat er een herinnering is gestuurd.
app.post('/api/quotes/:id/sent', auth, express.json({ limit: '2kb' }), (req, res) => {
  const q = getQ(req, res); if (!q) return;
  const fid = (req.body || {}).factuur;
  const target = fid ? (q.facturen || []).find(f => f.id === fid) : q;
  if (!target) return res.status(404).json({ error: 'Niet gevonden.' });
  if (!fid && q.status === 'concept') q.status = 'verstuurd';
  if (!target.sentAt) target.sentAt = Date.now();
  else if ((req.body || {}).herinnering) (target.followups = target.followups || []).push(Date.now());
  saveQuote(q);
  res.json(summary(q));
});
app.post('/api/quotes/:id/duplicate', auth, express.json({ limit: '2mb' }), (req, res) => {
  const src = getQ(req, res); if (!src) return;
  const b = req.body || {};
  const id = String(b.id || rid(9));
  if (!ID_RE.test(id) || quotes.has(id)) return res.status(400).json({ error: 'Ongeldig id.' });
  const data = JSON.parse(JSON.stringify(src.data || {}));
  Object.assign(data, b.patch || {});
  const q = { id, status: 'concept', created: Date.now(), facturen: [], data, nummer: data.nummer, totals: src.totals };
  saveQuote(q);
  res.json(Object.assign(summary(q), { data: q.data }));
});
app.get('/api/customers', auth, (req, res) => {
  const seen = new Map();
  [...quotes.values()].filter(q => !q.deleted).sort((a, b) => (b.updated || 0) - (a.updated || 0)).forEach(q => {
    const k = (q.data || {}).klant || {};
    if (!k.naam) return;
    const key = (k.naam + '|' + (k.adres || '')).toLowerCase();
    if (!seen.has(key)) seen.set(key, { naam: k.naam, adres: k.adres || '', plaats: k.plaats || '', email: k.email || '', tel: k.tel || '', postcode: k.postcode || '', huisnr: k.huisnr || '', offertes: 0 });
    seen.get(key).offertes++;
  });
  res.json([...seen.values()].slice(0, 500));
});

/* ---------- Facturen ---------- */
const money = v => (Math.round(v * 100) / 100).toFixed(2);
const euro = v => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(v || 0);
const baseUrl = req => PUBLIC_URL || (req.protocol + '://' + req.get('host'));
function qrSvg(text) {
  return require('qrcode').toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#1d1d1b', light: '#ffffff' } });
}
function epcPayload(cfg, f) {
  const iban = String(cfg.iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) return null;
  const name = String(cfg.naam || 'KGN Totaalservice').slice(0, 70);
  return ['BCD', '002', '1', 'SCT', '', name, iban, 'EUR' + money(f.incl), '', '', ('Factuur ' + f.nummer).slice(0, 140), ''].join('\n');
}
async function invoiceQr(req, f) {
  const link = baseUrl(req) + '/o/' + f.token;
  try {
    if (MOLLIE_KEY) return { link, qr: await qrSvg(link), qrKind: 'link' };
    const p = epcPayload(readSettings().cfg || {}, f);
    if (p) return { link, qr: await qrSvg(p), qrKind: 'epc' };
  } catch (e) { console.warn('qr', e.message); }
  return { link, qr: null, qrKind: null };
}
app.post('/api/quotes/:id/invoices', auth, express.json({ limit: '10kb' }), async (req, res) => {
  const q = getQ(req, res); if (!q) return;
  const b = req.body || {};
  const pct = Math.min(100, Math.max(0.01, Number(b.pct) || 100));
  const excl = Math.round((Number(b.excl) || 0) * 100) / 100;
  const btw = Math.round((Number(b.btw) || 0) * 100) / 100;
  const dagen = Math.min(90, Math.max(0, Number.isFinite(Number(b.dagen)) ? Number(b.dagen) : 14));
  if (!(excl > 0)) return res.status(400).json({ error: 'Geen bedrag.' });
  const st = readSettings();
  const year = new Date().getFullYear();
  if (st.invYear !== year) { st.invYear = year; st.invCounter = 0; }
  st.invCounter = (Number(st.invCounter) || 0) + 1;
  writeSettings(st);
  const datum = new Date();
  const verval = new Date(datum.getTime() + dagen * 86400000);
  const f = {
    id: rid(6), nummer: 'F-' + year + '-' + String(st.invCounter).padStart(3, '0'),
    datum: datum.toISOString().slice(0, 10), verval: verval.toISOString().slice(0, 10), dagen,
    pct, label: String(b.label || '').slice(0, 140), excl, btw, incl: Math.round((excl + btw) * 100) / 100,
    status: 'open', token: rid(18), created: Date.now()
  };
  (q.facturen = q.facturen || []).push(f);
  saveQuote(q);
  res.json(Object.assign(invoiceSummary(f), await invoiceQr(req, f)));
});
app.get('/api/quotes/:id/invoices/:fid/qr', auth, async (req, res) => {
  const q = getQ(req, res); if (!q) return;
  const f = (q.facturen || []).find(x => x.id === req.params.fid);
  if (!f) return res.status(404).json({ error: 'Factuur niet gevonden.' });
  res.json(Object.assign(invoiceSummary(f), await invoiceQr(req, f)));
});
app.put('/api/quotes/:id/invoices/:fid', auth, express.json({ limit: '8mb' }), (req, res) => {
  const q = getQ(req, res); if (!q) return;
  const f = (q.facturen || []).find(x => x.id === req.params.fid);
  if (!f) return res.status(404).json({ error: 'Factuur niet gevonden.' });
  const b = req.body || {};
  if (typeof b.snapshot === 'string' && b.snapshot) f.snapshot = b.snapshot;
  if (b.status === 'betaald' && f.status !== 'betaald') { f.status = 'betaald'; f.paidAt = Date.now(); f.paidVia = 'handmatig'; }
  if (b.status === 'open') { f.status = 'open'; delete f.paidAt; }
  if (b.remove) { q.facturen = q.facturen.filter(x => x !== f); byToken.delete(f.token); }
  saveQuote(q);
  res.json(summary(q));
});

/* ---------- Mollie (optioneel) ---------- */
async function mollie(method, p, body) {
  const r = await fetch('https://api.mollie.com/v2' + p, {
    method, headers: { Authorization: 'Bearer ' + MOLLIE_KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('mollie ' + r.status + ' ' + (j.detail || ''));
  return j;
}
function markPaid(q, f, how) {
  if (f.status === 'betaald') return;
  f.status = 'betaald'; f.paidAt = Date.now(); f.paidVia = how;
  saveQuote(q);
  const naam = ((q.data || {}).klant || {}).naam || 'De klant';
  event('betaald', q, `${naam} heeft factuur ${f.nummer} betaald (${euro(f.incl)}).`, 'Betaling ontvangen');
}
app.post('/api/mollie/webhook', express.urlencoded({ extended: false, limit: '5kb' }), async (req, res) => {
  res.status(200).end();
  const pid = String((req.body || {}).id || '');
  if (!MOLLIE_KEY || !/^tr_\w+$/.test(pid)) return;
  try {
    const p = await mollie('GET', '/payments/' + pid);
    const md = p.metadata || {};
    const q = quotes.get(md.q); const f = q && (q.facturen || []).find(x => x.id === md.f);
    if (f && p.status === 'paid') markPaid(q, f, 'mollie');
  } catch (e) { console.error('webhook', e.message); }
});

/* ---------- Openbare pagina voor de klant ---------- */
const pubHits = new Map();
function pubLimit(req, res, next) {
  const ip = req.ip || 'x', now = Date.now();
  const h = (pubHits.get(ip) || []).filter(t => now - t < 60000);
  h.push(now); pubHits.set(ip, h);
  if (pubHits.size > 5000) pubHits.clear();
  if (h.length > 60) return res.status(429).json({ error: 'Even rustig aan, probeer het zo opnieuw.' });
  next();
}
function resolve(token) {
  const t = byToken.get(String(token));
  if (!t) return null;
  const q = quotes.get(t.q);
  if (!q || q.deleted) return null;
  const f = t.f ? (q.facturen || []).find(x => x.id === t.f) : null;
  if (t.f && !f) return null;
  return { q, f };
}
const escH = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function withSignature(html, q) {
  if (!q.signed || !q.signed.img) return html;
  const when = new Date(q.signed.at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' });
  const block = `<img class="sig" src="${q.signed.img}" alt="Handtekening" style="display:block;height:18mm;max-width:70mm;margin:2mm 0 1mm"><span>Digitaal getekend door ${escH(q.signed.name)} op ${when}</span>`;
  return html.replace(/<!--KGN-SIGN-->[\s\S]*?<!--\/KGN-SIGN-->/, block);
}
app.get('/o/:token', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'o.html')); });
app.get('/api/public/:token', pubLimit, (req, res) => {
  const r = resolve(req.params.token);
  if (!r) return res.status(404).json({ error: 'Deze link is niet (meer) geldig.' });
  const { q, f } = r;
  const cfg = readSettings().cfg || {};
  const company = { naam: cfg.naam || 'KGN Totaalservice', tel: cfg.tel || '', email: cfg.email || '', kleur: cfg.kleur || '', iban: cfg.iban || '' };
  const klant = ((q.data || {}).klant || {}).naam || '';
  if (!req.query.preview) {
    const target = f || q;
    target.views = (target.views || 0) + 1;
    const first = !target.viewedAt;
    if (first) target.viewedAt = Date.now();
    saveQuote(q);
    if (first) event('bekeken', q, `${klant || 'De klant'} heeft ${f ? 'factuur ' + f.nummer : 'offerte ' + q.nummer} geopend.`, 'Klant kijkt mee');
  }
  if (f) {
    return res.json({ kind: 'factuur', nummer: f.nummer, status: f.status, html: f.snapshot || '', incl: f.incl, verval: f.verval,
      paidAt: f.paidAt || null, mollie: !!MOLLIE_KEY, company, klant });
  }
  res.json({ kind: 'offerte', nummer: q.nummer, status: q.status, html: withSignature(q.snapshot || '', q), incl: (q.totals || {}).incl || 0,
    signed: q.signed ? { name: q.signed.name, at: q.signed.at } : null, rejected: q.rejected ? { at: q.rejected.at } : null, company, klant,
    geldig: (q.data || {}).geldig, datum: (q.data || {}).datum });
});
app.post('/api/public/:token/sign', pubLimit, express.json({ limit: '600kb' }), (req, res) => {
  const r = resolve(req.params.token);
  if (!r || r.f) return res.status(404).json({ error: 'Deze link is niet (meer) geldig.' });
  const { q } = r;
  if (q.status === 'getekend') return res.status(409).json({ error: 'Deze offerte is al getekend.' });
  if (q.status === 'afgewezen') return res.status(409).json({ error: 'Deze offerte is afgewezen. Neem contact op voor een nieuwe offerte.' });
  const b = req.body || {};
  const name = s(b.name, 80);
  const img = String(b.img || '');
  if (!name) return res.status(400).json({ error: 'Vul uw naam in.' });
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 500000 || img.length < 400) return res.status(400).json({ error: 'Zet eerst uw handtekening.' });
  if (!b.akkoord) return res.status(400).json({ error: 'Vink aan dat u akkoord gaat.' });
  q.status = 'getekend';
  q.signed = { name, img, at: Date.now(), ip: req.ip, ua: String(req.headers['user-agent'] || '').slice(0, 200), hash: crypto.createHash('sha256').update(q.snapshot || '').digest('hex') };
  delete q.rejected;
  saveQuote(q);
  const bedrag = euro((q.totals || {}).incl || 0);
  event('getekend', q, `${name} heeft offerte ${q.nummer} getekend. Opdracht van ${bedrag} binnen!`, 'Offerte getekend!');
  res.json({ ok: true });
});
app.post('/api/public/:token/reject', pubLimit, express.json({ limit: '10kb' }), (req, res) => {
  const r = resolve(req.params.token);
  if (!r || r.f) return res.status(404).json({ error: 'Deze link is niet (meer) geldig.' });
  const { q } = r;
  if (q.status === 'getekend') return res.status(409).json({ error: 'Deze offerte is al getekend.' });
  if (q.status === 'afgewezen') return res.json({ ok: true });
  const reason = s((req.body || {}).reason, 1000) || '';
  q.status = 'afgewezen'; q.rejected = { at: Date.now(), reason };
  saveQuote(q);
  const naam = ((q.data || {}).klant || {}).naam || 'De klant';
  event('afgewezen', q, `${naam} heeft offerte ${q.nummer} afgewezen${reason ? ': "' + reason + '"' : '.'}`, 'Offerte afgewezen');
  res.json({ ok: true });
});
app.post('/api/public/:token/pay', pubLimit, async (req, res) => {
  const r = resolve(req.params.token);
  if (!r || !r.f) return res.status(404).json({ error: 'Deze link is niet (meer) geldig.' });
  if (!MOLLIE_KEY) return res.status(400).json({ error: 'Online betalen is niet beschikbaar.' });
  const { q, f } = r;
  if (f.status === 'betaald') return res.status(409).json({ error: 'Deze factuur is al betaald.' });
  try {
    const base = baseUrl(req);
    const body = { amount: { currency: 'EUR', value: money(f.incl) }, description: 'Factuur ' + f.nummer,
      redirectUrl: base + '/o/' + f.token + '?betaald=1', metadata: { q: q.id, f: f.id } };
    if (/^https:\/\//.test(base) && !/localhost|127\.0\.0\.1/.test(base)) body.webhookUrl = base + '/api/mollie/webhook';
    const p = await mollie('POST', '/payments', body);
    f.molliePayments = (f.molliePayments || []).concat(p.id).slice(-10);
    saveQuote(q);
    res.json({ url: p._links.checkout.href });
  } catch (e) {
    console.error('pay', e.message);
    res.status(502).json({ error: 'Betaling starten lukt nu niet.' });
  }
});
app.get('/api/public/:token/check', pubLimit, async (req, res) => {
  const r = resolve(req.params.token);
  if (!r || !r.f) return res.status(404).json({ error: 'Niet gevonden.' });
  const { q, f } = r;
  if (MOLLIE_KEY && f.status !== 'betaald') {
    for (const pid of (f.molliePayments || []).slice(-3)) {
      try { const p = await mollie('GET', '/payments/' + pid); if (p.status === 'paid') { markPaid(q, f, 'mollie'); break; } } catch (e) {}
    }
  }
  res.json({ status: f.status });
});

/* ---------- PDF ---------- */
const FONT_CSS = (() => {
  try {
    const dir = path.join(__dirname, 'public', 'fonts');
    return fs.readFileSync(path.join(dir, 'fonts.css'), 'utf8').replace(/url\(\/fonts\/([\w.-]+)\)/g,
      (m, f) => `url(data:font/woff2;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')})`);
  } catch (e) { console.warn('Lettertypen niet gevonden voor PDF'); return ''; }
})();
let browserP = null;
function getBrowser() {
  if (!browserP) {
    const puppeteer = require('puppeteer-core');
    browserP = puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'] })
      .then(b => { b.on('disconnected', () => { browserP = null; }); return b; })
      .catch(e => { browserP = null; throw e; });
  }
  return browserP;
}
const LOCAL = 'http://kgn.local/';
async function renderPdf(html) {
  const doc = String(html).replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<link[^>]*fonts\.css[^>]*>/gi, '')
    .replace(/<head>/i, `<head><base href="${LOCAL}">`)
    .replace(/<\/head>/i, `<style>${FONT_CSS}</style></head>`);
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1600 });
    await page.emulateMediaType('print');
    await page.setRequestInterception(true);
    page.on('request', r => {
      const u = r.url();
      if (u.startsWith(LOCAL + 'files/photos/')) {
        const id = u.slice((LOCAL + 'files/photos/').length).replace(/\.jpg.*$/, '');
        if (PHOTO_RE.test(id) && fs.existsSync(photoFile(id))) {
          const buf = fs.readFileSync(photoFile(id));
          return r.respond({ status: 200, contentType: imgType(buf), body: buf });
        }
        return r.abort();
      }
      if (u.startsWith('data:') || u.startsWith('about:') || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)) r.continue();
      else r.abort();
    });
    await page.setContent(doc, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  } finally {
    if (page) page.close().catch(() => {});
  }
}
function sendPdf(res, pdf, name) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${String(name || 'document.pdf').replace(/[^\w.\- ]+/g, '')}"`);
  res.end(pdf);
}
app.post('/api/pdf', auth, express.json({ limit: '8mb' }), async (req, res) => {
  const html = String((req.body || {}).html || '');
  if (!html) return res.status(400).json({ error: 'Geen document.' });
  try { sendPdf(res, await renderPdf(html), (req.body || {}).filename || 'offerte.pdf'); }
  catch (e) { console.error('pdf', e); res.status(500).json({ error: 'PDF maken mislukt.' }); }
});
app.get('/api/public/:token/pdf', pubLimit, async (req, res) => {
  const r = resolve(req.params.token);
  if (!r) return res.status(404).json({ error: 'Deze link is niet (meer) geldig.' });
  const { q, f } = r;
  const html = f ? f.snapshot : withSignature(q.snapshot || '', q);
  if (!html) return res.status(404).json({ error: 'Nog geen document.' });
  const naam = ((q.data || {}).klant || {}).naam || '';
  try { sendPdf(res, await renderPdf(html), (f ? 'Factuur ' + f.nummer : 'Offerte ' + q.nummer) + (naam ? ' ' + naam : '') + '.pdf'); }
  catch (e) { console.error('pdf', e); res.status(500).json({ error: 'PDF maken mislukt.' }); }
});

/* ---------- Herinneringen: elk uur kijken wat opgevolgd moet worden ---------- */
function checkReminders() {
  const now = Date.now(), DAY = 86400000;
  quotes.forEach(q => {
    if (q.deleted) return;
    const naam = ((q.data || {}).klant || {}).naam || 'de klant';
    const lc = lastContact(q);
    if (q.status === 'verstuurd' && lc && now - lc >= FOLLOWUP_DAYS * DAY && (q.remindedFor || 0) < lc) {
      q.remindedFor = lc; saveQuote(q);
      event('opvolgen', q, `Offerte ${q.nummer} voor ${naam} wacht al ${Math.floor((now - lc) / DAY)} dagen op reactie. Stuur een herinnering.`, 'Tijd om op te volgen');
    }
    (q.facturen || []).forEach(f => {
      if (f.status !== 'open' || !f.verval) return;
      const due = new Date(f.verval + 'T23:59:59').getTime();
      if (now > due && !f.overdueNotified) {
        f.overdueNotified = now; saveQuote(q);
        event('verlopen', q, `Factuur ${f.nummer} van ${naam} is over de vervaldatum en nog niet betaald.`, 'Factuur niet betaald');
      }
    });
  });
}
setInterval(checkReminders, 60 * 60 * 1000).unref();
setTimeout(checkReminders, 30 * 1000).unref();

app.listen(PORT, () => console.log(`KGN offerte-app draait op poort ${PORT} (AI: ${GROQ_KEY ? 'aan' : 'uit'}, pincode: ${APP_PIN ? 'aan' : 'uit'}, Mollie: ${MOLLIE_KEY ? 'aan' : 'uit'}, offertes: ${quotes.size})`));
