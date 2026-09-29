'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

// ============================================================
// CONFIG
// ============================================================
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONTENT_PATH = path.join(DATA_DIR, 'content.json');
const SEED_PATH = path.join(__dirname, 'data', 'content.seed.json');
const TEMPLATE_PATH = path.join(__dirname, 'index.template.html');
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

if (!ADMIN_PASSWORD) {
  console.error('ERREUR: la variable d\'environnement ADMIN_PASSWORD n\'est pas définie. Le back office sera inaccessible tant qu\'elle ne l\'est pas.');
}
if (!SESSION_SECRET) {
  console.error('ERREUR: la variable d\'environnement SESSION_SECRET n\'est pas définie. Génère une valeur aléatoire longue et définis-la avant de déployer.');
}

// ============================================================
// CONTENT STORE (fichier JSON sur le disque persistant)
// ============================================================
function ensureContentFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONTENT_PATH)) {
    const seed = fs.readFileSync(SEED_PATH, 'utf-8');
    fs.writeFileSync(CONTENT_PATH, seed, 'utf-8');
    console.log('content.json initialisé à partir de data/content.seed.json ->', CONTENT_PATH);
  }
}
ensureContentFile();

function readContent() {
  const raw = fs.readFileSync(CONTENT_PATH, 'utf-8');
  return JSON.parse(raw);
}

// File d'écriture simple : évite deux sauvegardes concurrentes qui s'écraseraient.
let writeQueue = Promise.resolve();
function writeContent(content) {
  writeQueue = writeQueue.then(() => {
    const tmpPath = CONTENT_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(content, null, 2), 'utf-8');
    fs.renameSync(tmpPath, CONTENT_PATH);
  });
  return writeQueue;
}

// ============================================================
// TEMPLATE RENDERING (mêmes règles que l'ancien outil d'export)
// ============================================================
const TEMPLATE_HTML = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildGalleryLiteral(items) {
  return JSON.stringify((items || []).map(it => {
    const obj = { label: it.label || '' };
    if (it.photo) obj.photo = it.photo;
    return obj;
  }));
}

function buildTarifsHtml(groups) {
  return (groups || []).map(g => {
    const rows = (g.rows || []).map(r =>
      '        <div class="price-row"><span class="price-row__name">' + escapeHtml(r.name) +
      '</span><span class="price-row__leader"></span><span class="price-row__amount u-mono">' +
      escapeHtml(r.amount) + '</span></div>'
    ).join('\n');
    return '      <div class="price-group">\n        <h3>' + escapeHtml(g.title) + '</h3>\n' + rows + '\n      </div>';
  }).join('\n\n');
}

function buildArticlesStatement(items) {
  const parts = (items || []).map(it => {
    const titleJson = JSON.stringify(it.title || '');
    if (it.mode === 'html') {
      return '      {\n        q: ' + titleJson + ',\n        html: ' + JSON.stringify(it.html || '') + '\n      }';
    }
    return '      {\n        q: ' + titleJson + ',\n        a: ' + JSON.stringify(it.text || '') + '\n      }';
  });
  return '    var articlesData = [\n' + parts.join(',\n') + '\n    ];';
}

function renderSite() {
  const content = readContent();
  let html = TEMPLATE_HTML;
  html = html.replace('__GALLERY_DATA_PLACEHOLDER__', buildGalleryLiteral(content.gallery));
  html = html.replace('__TARIFS_HTML_PLACEHOLDER__', buildTarifsHtml(content.tarifs));
  html = html.replace('__ARTICLES_DATA_PLACEHOLDER__', buildArticlesStatement(content.articles));
  return html;
}

// ============================================================
// SESSIONS (cookie signé maison — un seul admin, pas besoin d'un store)
// ============================================================
function signSession() {
  const expires = Date.now() + SESSION_MAX_AGE_MS;
  const payload = Buffer.from(JSON.stringify({ expires })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifySession(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return false;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return typeof data.expires === 'number' && data.expires > Date.now();
  } catch (err) {
    return false;
  }
}
function requireAuth(req, res, next) {
  if (verifySession(req.cookies && req.cookies.bo_session)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ============================================================
// APP
// ============================================================
const app = express();
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '30mb' }));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// ---- Public site ----
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderSite());
});

// ---- Auth ----
app.post('/api/admin/login', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (!ADMIN_PASSWORD || !SESSION_SECRET) {
    return res.status(500).json({ error: 'server_not_configured' });
  }
  // timing-safe compare
  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_PASSWORD);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    return res.status(401).json({ error: 'invalid_password' });
  }
  res.cookie('bo_session', signSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('bo_session');
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: verifySession(req.cookies && req.cookies.bo_session) });
});

// ---- Admin content API (protégé) ----
app.get('/api/admin/content', requireAuth, (req, res) => {
  res.json(readContent());
});

function validateGallery(body) {
  if (!Array.isArray(body)) return 'La galerie doit être une liste.';
  for (const it of body) {
    if (typeof it.label !== 'string') return 'Chaque photo doit avoir une légende texte.';
    if (it.photo != null && typeof it.photo !== 'string') return 'Photo invalide.';
  }
  return null;
}
function validateTarifs(body) {
  if (!Array.isArray(body)) return 'Les tarifs doivent être une liste de catégories.';
  for (const g of body) {
    if (typeof g.title !== 'string') return 'Chaque catégorie doit avoir un titre.';
    if (!Array.isArray(g.rows)) return 'Chaque catégorie doit contenir une liste de lignes.';
    for (const r of g.rows) {
      if (typeof r.name !== 'string' || typeof r.amount !== 'string') return 'Chaque ligne doit avoir un nom et un prix texte.';
    }
  }
  return null;
}
function validateArticles(body) {
  if (!Array.isArray(body)) return 'Les articles doivent être une liste.';
  for (const a of body) {
    if (typeof a.title !== 'string') return 'Chaque article doit avoir un titre.';
    if (a.mode !== 'html' && a.mode !== 'text') return 'Mode d\'article invalide.';
  }
  return null;
}

app.put('/api/admin/gallery', requireAuth, (req, res) => {
  const err = validateGallery(req.body);
  if (err) return res.status(400).json({ error: err });
  const content = readContent();
  content.gallery = req.body;
  writeContent(content).then(() => res.json({ ok: true })).catch(e => res.status(500).json({ error: e.message }));
});

app.put('/api/admin/tarifs', requireAuth, (req, res) => {
  const err = validateTarifs(req.body);
  if (err) return res.status(400).json({ error: err });
  const content = readContent();
  content.tarifs = req.body;
  writeContent(content).then(() => res.json({ ok: true })).catch(e => res.status(500).json({ error: e.message }));
});

app.put('/api/admin/articles', requireAuth, (req, res) => {
  const err = validateArticles(req.body);
  if (err) return res.status(400).json({ error: err });
  const content = readContent();
  content.articles = req.body;
  writeContent(content).then(() => res.json({ ok: true })).catch(e => res.status(500).json({ error: e.message }));
});

app.listen(PORT, () => {
  console.log('Serveur démarré sur le port ' + PORT);
  console.log('Site public : http://localhost:' + PORT + '/');
  console.log('Back office : http://localhost:' + PORT + '/admin');
});
