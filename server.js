'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');

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

// ---- Envoi du formulaire de contact (SMTP IONOS) ----
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.ionos.fr';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === 'true'
  : SMTP_PORT === 465; // 465 = SSL/TLS direct, 587 = STARTTLS
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
// Chez IONOS l'adresse "From" doit être la boîte authentifiée (SMTP_USER).
// CONTACT_TO permet d'envoyer vers une autre adresse si besoin (sinon = SMTP_USER).
const CONTACT_TO = process.env.CONTACT_TO || SMTP_USER;

if (!SMTP_USER || !SMTP_PASS) {
  console.error('ERREUR: SMTP_USER / SMTP_PASS ne sont pas définies. Le formulaire de contact ne pourra pas envoyer d\'e-mail tant que ces variables ne sont pas configurées (boîte mail IONOS).');
}

let mailTransporter = null;
function getMailTransporter() {
  if (!SMTP_USER || !SMTP_PASS) return null;
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
  }
  return mailTransporter;
}

// Anti-spam très simple : limite le nombre d'envois par IP sur une fenêtre glissante.
const CONTACT_RATE_LIMIT = 5; // envois max
const CONTACT_RATE_WINDOW_MS = 15 * 60 * 1000; // par 15 minutes
const contactRateMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const hits = (contactRateMap.get(ip) || []).filter((t) => now - t < CONTACT_RATE_WINDOW_MS);
  hits.push(now);
  contactRateMap.set(ip, hits);
  return hits.length > CONTACT_RATE_LIMIT;
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

// Valeurs par défaut : garantit que le site public reste inchangé si
// content.json (déjà existant sur le disque persistant) ne contient pas
// encore de bloc "mentions" (ajouté après coup) tant que l'admin n'a pas
// encore publié depuis le nouvel onglet du back office.
const MENTIONS_DEFAULTS = {
  editeur: 'Blanchisserie de Molières-sur-Cèze, exploitée par DOURNIN.<br>Représentante : Patricia Dournin, directrice de la publication.',
  siege: '14 rue Louis Serre, 30410 Molières-sur-Cèze, France.',
  contact: 'Tél. : 06 58 73 18 09<br>E-mail : contact@blanchisseriedemolieres.com',
  immatriculation: 'SIRET : 421 721 408 00035',
  fiscalite: 'TVA non applicable, <a href="https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000048826700/" target="_blank" rel="noopener noreferrer">art. 293 B du CGI</a>.',
  hebergement: 'Render Services, Inc., 525 Brannan Street Ste 300, San Francisco, CA 94107, États-Unis — legal@render.com — +1 415-319-8186.',
  propriete: 'L\'ensemble des textes, illustrations originales et éléments graphiques de ce site sont la propriété de la Blanchisserie de Molières-sur-Cèze, sauf mention contraire. Toute reproduction sans autorisation est interdite.',
  credits: 'Les illustrations, pictogrammes et éléments graphiques présents sur ce site ont été réalisés ou sélectionnés pour la Blanchisserie de Molières-sur-Cèze.',
  donnees: 'Les informations transmises via le formulaire de contact sont utilisées uniquement pour répondre à votre demande et ne sont ni cédées ni transmises à des tiers. Conformément au RGPD, vous disposez d\'un droit d\'accès, de rectification et de suppression de vos données en écrivant à contact@blanchisseriedemolieres.com.',
  sources: 'Régime de TVA : <a href="https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000048826700/" target="_blank" rel="noopener noreferrer">article 293 B du Code général des impôts</a> (Légifrance).',
  misAJour: '29 septembre 2026'
};
const MENTIONS_FIELDS = ['editeur', 'siege', 'contact', 'immatriculation', 'fiscalite', 'hebergement', 'propriete', 'credits', 'donnees', 'sources', 'misAJour'];

function mergeMentions(mentions) {
  const out = Object.assign({}, MENTIONS_DEFAULTS);
  MENTIONS_FIELDS.forEach(k => {
    if (mentions && typeof mentions[k] === 'string' && mentions[k].trim()) out[k] = mentions[k];
  });
  return out;
}

// ============================================================
// HORAIRES D'OUVERTURE (éditables depuis le back office)
// ============================================================
const HORAIRES_JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const HORAIRES_LABELS = {
  lundi: 'Lundi', mardi: 'Mardi', mercredi: 'Mercredi', jeudi: 'Jeudi',
  vendredi: 'Vendredi', samedi: 'Samedi', dimanche: 'Dimanche'
};
const HORAIRES_JOURS_EN = {
  lundi: 'Monday', mardi: 'Tuesday', mercredi: 'Wednesday', jeudi: 'Thursday',
  vendredi: 'Friday', samedi: 'Saturday', dimanche: 'Sunday'
};

// Valeurs par défaut : reprennent les horaires historiques du site, et
// servent de repli tant que l'admin n'a pas encore publié depuis le
// nouvel onglet "Horaires" du back office.
const HORAIRES_DEFAULTS = {
  lundi:    { ferme: false, matinDebut: '09:00', matinFin: '12:00', apresMidiDebut: '14:00', apresMidiFin: '18:00', note: '' },
  mardi:    { ferme: false, matinDebut: '09:00', matinFin: '12:00', apresMidiDebut: '14:00', apresMidiFin: '18:00', note: '' },
  mercredi: { ferme: false, matinDebut: '09:00', matinFin: '12:00', apresMidiDebut: '14:00', apresMidiFin: '18:00', note: '' },
  jeudi:    { ferme: true,  matinDebut: '', matinFin: '', apresMidiDebut: '', apresMidiFin: '', note: '' },
  vendredi: { ferme: false, matinDebut: '09:00', matinFin: '12:00', apresMidiDebut: '14:00', apresMidiFin: '18:00', note: '' },
  samedi:   { ferme: false, matinDebut: '09:00', matinFin: '11:00', apresMidiDebut: '', apresMidiFin: '', note: '15 mai – 15 sept. uniquement' },
  dimanche: { ferme: true,  matinDebut: '', matinFin: '', apresMidiDebut: '', apresMidiFin: '', note: '' }
};

function mergeHoraires(horaires) {
  const out = {};
  HORAIRES_JOURS.forEach(j => {
    const d = (horaires && typeof horaires[j] === 'object' && horaires[j]) || {};
    const def = HORAIRES_DEFAULTS[j];
    out[j] = {
      ferme: typeof d.ferme === 'boolean' ? d.ferme : def.ferme,
      matinDebut: typeof d.matinDebut === 'string' ? d.matinDebut : def.matinDebut,
      matinFin: typeof d.matinFin === 'string' ? d.matinFin : def.matinFin,
      apresMidiDebut: typeof d.apresMidiDebut === 'string' ? d.apresMidiDebut : def.apresMidiDebut,
      apresMidiFin: typeof d.apresMidiFin === 'string' ? d.apresMidiFin : def.apresMidiFin,
      note: typeof d.note === 'string' ? d.note : def.note
    };
  });
  return out;
}

function formatHeure(hhmm) {
  if (!hhmm || typeof hhmm !== 'string' || hhmm.indexOf(':') === -1) return '';
  const parts = hhmm.split(':');
  const h = parseInt(parts[0], 10);
  if (isNaN(h)) return '';
  const m = parts[1] || '00';
  return m === '00' ? (h + 'h') : (h + 'h' + m);
}

function escapeHtmlServer(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHoursTableRows(horaires) {
  return HORAIRES_JOURS.map(j => {
    const d = horaires[j];
    const label = HORAIRES_LABELS[j];
    if (d.ferme) {
      return '<tr><td>' + label + '</td><td>Fermé</td></tr>';
    }
    const slots = [];
    const m1 = formatHeure(d.matinDebut), m2 = formatHeure(d.matinFin);
    if (m1 && m2) slots.push(m1 + ' – ' + m2);
    const a1 = formatHeure(d.apresMidiDebut), a2 = formatHeure(d.apresMidiFin);
    if (a1 && a2) slots.push(a1 + ' – ' + a2);
    const text = slots.length ? slots.join(' / ') : 'Horaires non renseignés';
    const noteHtml = d.note ? ('<br><span class="hours-note">' + escapeHtmlServer(d.note) + '</span>') : '';
    return '<tr><td>' + label + '</td><td>' + text + noteHtml + '</td></tr>';
  }).join('\n              ');
}

function buildOpeningHoursJsonLd(horaires) {
  const specs = [];
  HORAIRES_JOURS.forEach(j => {
    const d = horaires[j];
    if (d.ferme) return;
    const dayEn = HORAIRES_JOURS_EN[j];
    if (d.matinDebut && d.matinFin) {
      specs.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: [dayEn], opens: d.matinDebut, closes: d.matinFin });
    }
    if (d.apresMidiDebut && d.apresMidiFin) {
      specs.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: [dayEn], opens: d.apresMidiDebut, closes: d.apresMidiFin });
    }
  });
  return JSON.stringify(specs, null, 4);
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
  const mentions = mergeMentions(content.mentions);
  MENTIONS_FIELDS.forEach(k => {
    // $$ échappe le caractère spécial de remplacement de String.replace (au cas
    // où un texte légal contiendrait un "$", ex. un prix en dollars).
    html = html.replace('__MENTIONS_' + k.toUpperCase() + '__', String(mentions[k]).replace(/\$/g, '$$$$'));
  });
  const horaires = mergeHoraires(content.horaires);
  html = html.replace('__HOURS_TABLE_ROWS__', buildHoursTableRows(horaires).replace(/\$/g, '$$$$'));
  html = html.replace('__OPENING_HOURS_SPEC_JSON__', buildOpeningHoursJsonLd(horaires).replace(/\$/g, '$$$$'));
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

// ---- Formulaire de contact ----
function escapeHtmlMail(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

app.post('/api/contact', async (req, res) => {
  const body = req.body || {};
  // Piège à robots : champ caché normalement vide, rempli seulement par les bots.
  if (body._honey) {
    return res.json({ ok: true });
  }

  const name = String(body.name || '').trim().slice(0, 200);
  const email = String(body.email || '').trim().slice(0, 200);
  const phone = String(body.phone || '').trim().slice(0, 60);
  const message = String(body.message || '').trim().slice(0, 5000);
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!name || !message || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_fields' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  const transporter = getMailTransporter();
  if (!transporter) {
    return res.status(500).json({ error: 'mail_not_configured' });
  }

  try {
    await transporter.sendMail({
      from: `"Site Blanchisserie" <${SMTP_USER}>`,
      to: CONTACT_TO,
      replyTo: `"${name.replace(/[\r\n"]/g, ' ')}" <${email}>`,
      subject: 'Nouvelle demande — site Blanchisserie de Molières-sur-Cèze',
      text:
        'Nom : ' + name + '\n' +
        'E-mail : ' + email + '\n' +
        'Téléphone : ' + (phone || '(non renseigné)') + '\n\n' +
        'Message :\n' + message,
      html:
        '<p><strong>Nom :</strong> ' + escapeHtmlMail(name) + '</p>' +
        '<p><strong>E-mail :</strong> ' + escapeHtmlMail(email) + '</p>' +
        '<p><strong>Téléphone :</strong> ' + escapeHtmlMail(phone || '(non renseigné)') + '</p>' +
        '<p><strong>Message :</strong><br>' + escapeHtmlMail(message).replace(/\n/g, '<br>') + '</p>'
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur envoi e-mail contact:', err && err.message);
    res.status(502).json({ error: 'send_failed' });
  }
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

function validateMentions(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Les mentions légales doivent être un objet.';
  for (const k of Object.keys(body)) {
    if (MENTIONS_FIELDS.indexOf(k) === -1) continue; // champs inconnus ignorés, pas bloquants
    if (typeof body[k] !== 'string') return 'Le champ "' + k + '" doit être du texte.';
  }
  return null;
}

const HORAIRES_TIME_RE = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
function validateHoraires(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Les horaires doivent être un objet.';
  for (const j of HORAIRES_JOURS) {
    if (!(j in body)) continue; // jour manquant : on garde la valeur déjà enregistrée
    const d = body[j];
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return 'Le jour "' + j + '" doit être un objet.';
    if ('ferme' in d && typeof d.ferme !== 'boolean') return 'Le champ "ferme" du jour "' + j + '" doit être vrai/faux.';
    for (const f of ['matinDebut', 'matinFin', 'apresMidiDebut', 'apresMidiFin']) {
      if (!(f in d)) continue;
      if (typeof d[f] !== 'string') return 'Le champ "' + f + '" du jour "' + j + '" doit être du texte.';
      if (d[f] && !HORAIRES_TIME_RE.test(d[f])) return 'Le champ "' + f + '" du jour "' + j + '" doit être une heure valide (HH:MM).';
    }
    if ('note' in d && typeof d.note !== 'string') return 'Le champ "note" du jour "' + j + '" doit être du texte.';
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

app.put('/api/admin/mentions', requireAuth, (req, res) => {
  const err = validateMentions(req.body);
  if (err) return res.status(400).json({ error: err });
  const content = readContent();
  content.mentions = mergeMentions(Object.assign({}, content.mentions, req.body));
  writeContent(content).then(() => res.json({ ok: true })).catch(e => res.status(500).json({ error: e.message }));
});

app.put('/api/admin/horaires', requireAuth, (req, res) => {
  const err = validateHoraires(req.body);
  if (err) return res.status(400).json({ error: err });
  const content = readContent();
  const next = {};
  HORAIRES_JOURS.forEach(j => {
    next[j] = Object.assign({}, content.horaires && content.horaires[j], req.body && req.body[j]);
  });
  content.horaires = mergeHoraires(next);
  writeContent(content).then(() => res.json({ ok: true })).catch(e => res.status(500).json({ error: e.message }));
});

app.listen(PORT, () => {
  console.log('Serveur démarré sur le port ' + PORT);
  console.log('Site public : http://localhost:' + PORT + '/');
  console.log('Back office : http://localhost:' + PORT + '/admin');
});
