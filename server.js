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
const APP_PIN = process.env.APP_PIN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const TOKEN = APP_PIN ? crypto.createHash('sha256').update('kgn-offerte:' + APP_PIN).digest('hex') : '';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ---------- Statische app ---------- */
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (/(index\.html|sw\.js|manifest\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
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
app.get('/api/health', (req, res) => res.json({ ok: true, ai: !!GROQ_KEY, pdf: true, auth: !!APP_PIN }));

/* ---------- Instellingen (prijzen, bedrijfsgegevens, offertenummer) ---------- */
const SFILE = path.join(DATA_DIR, 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SFILE, 'utf8')); } catch (e) { return { cfg: null, counter: 1 }; }
}
function writeSettings(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SFILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, SFILE);
}
app.get('/api/settings', auth, (req, res) => res.json(readSettings()));
app.put('/api/settings', auth, express.json({ limit: '200kb' }), (req, res) => {
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
const EXT = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
app.post('/api/transcribe', auth, express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'Spraakherkenning is niet ingesteld (GROQ_API_KEY ontbreekt).' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Geen opname ontvangen.' });
  const ct = String(req.headers['content-type'] || 'audio/webm').split(';')[0].trim();
  try {
    const fd = new FormData();
    fd.append('file', new Blob([req.body], { type: ct }), 'opname.' + (EXT[ct] || 'webm'));
    fd.append('model', STT_MODEL);
    fd.append('language', 'nl');
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    fd.append('prompt', VOCAB);
    const r = await fetch(GROQ_BASE + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + GROQ_KEY }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('transcribe', r.status, JSON.stringify(j).slice(0, 400)); return res.status(502).json({ error: r.status === 429 ? 'Limiet van de gratis spraakdienst bereikt. Probeer het zo opnieuw.' : 'Uitschrijven mislukt.' }); }
    res.json({ text: String(j.text || '').trim() });
  } catch (e) {
    console.error('transcribe', e);
    res.status(502).json({ error: 'Uitschrijven mislukt.' });
  }
});

/* ---------- Tekst naar offerteregels (Groq taalmodel) ---------- */
function schemaFor(ids) {
  const num = { type: ['number', 'null'] };
  const str = { type: ['string', 'null'] };
  return {
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
}
function systemPrompt(catalog) {
  const lijst = catalog.map(c => `- ${c.id}: ${c.name} (${c.desc || ''}), eenheid: ${c.unit}${c.type === 'toggle' ? ', vaste post' : ''}${c.type === 'percent' ? ', percentage' : ''}${c.basis ? `, hoeveelheid volgt uit ${c.basis}oppervlak` : ''}`).join('\n');
  return `Je zet een ingesproken opname van een Nederlandse aannemer om naar gegevens voor een offerte. De tekst is automatisch uitgeschreven en kan spreektaal en kleine fouten bevatten.

Werkzaamheden in de prijslijst:
${lijst}

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
const n = v => (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.round(v * 100) / 100 : null;
const s = v => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 120) : null;
function normalize(raw, catalog) {
  const ids = new Set(catalog.map(c => c.id));
  const out = { ai: true, rooms: [], items: [], custom: [], rest: [] };
  out.klant = s(raw.klant); out.adres = s(raw.adres); out.plaats = s(raw.plaats);
  const w = n(raw.weken); if (w) out.weken = String(w);
  const k = n(raw.korting); if (k != null && k <= 100) out.korting = k;
  if ([0, 9, 21].includes(raw.btw)) out.btw = raw.btw;
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
  out.rest = (Array.isArray(raw.niet_herkend) ? raw.niet_herkend : []).map(s).filter(Boolean).slice(0, 10);
  return out;
}
async function chat(body) {
  const r = await fetch(GROQ_BASE + '/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('llm ' + r.status + ' ' + JSON.stringify(j).slice(0, 300)); e.status = r.status; throw e; }
  return JSON.parse(j.choices[0].message.content);
}
app.post('/api/parse', auth, express.json({ limit: '100kb' }), async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'AI is niet ingesteld.' });
  const text = String((req.body || {}).text || '').slice(0, 6000);
  const catalog = Array.isArray((req.body || {}).catalog) ? req.body.catalog.slice(0, 200).map(c => ({
    id: String(c.id), name: String(c.name || ''), desc: String(c.desc || ''), unit: String(c.unit || ''), type: c.type ? String(c.type) : '', basis: c.basis ? String(c.basis) : ''
  })) : [];
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
app.post('/api/pdf', auth, express.json({ limit: '6mb' }), async (req, res) => {
  const html = String((req.body || {}).html || '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const doc = html.replace(/<link[^>]*fonts\.css[^>]*>/gi, '').replace(/<\/head>/i, `<style>${FONT_CSS}</style></head>`);
  if (!html) return res.status(400).json({ error: 'Geen document.' });
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1600 });
    await page.emulateMediaType('print');
    await page.setRequestInterception(true);
    page.on('request', r => {
      const u = r.url();
      if (u.startsWith('data:') || u.startsWith('about:') || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)) r.continue();
      else r.abort();
    });
    await page.setContent(doc, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    const name = String((req.body || {}).filename || 'offerte.pdf').replace(/[^\w.\- ]+/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.end(Buffer.from(pdf));
  } catch (e) {
    console.error('pdf', e);
    res.status(500).json({ error: 'PDF maken mislukt.' });
  } finally {
    if (page) page.close().catch(() => {});
  }
});

app.listen(PORT, () => console.log(`KGN offerte-app draait op poort ${PORT} (AI: ${GROQ_KEY ? 'aan' : 'uit'}, pincode: ${APP_PIN ? 'aan' : 'uit'})`));
