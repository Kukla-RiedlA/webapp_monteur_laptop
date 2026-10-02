'use strict';

const MOTOR_KEYS = [
  'bezeichnung',
  'positionsnummer',
  'hersteller',
  'type',
  'seriennummer',
  'nennleistung_kw',
  'leistungsfaktor',
  'nenndrehzahl',
  'nennstrom',
  'getriebeuebersetzung',
  'getriebedrehzahl',
  'nennspannung',
  'nennfrequenz',
  'bauform',
  'schaltung',
  'isolationsklasse',
  'schutzart',
  'leerlaufstrom_50hz',
  'anlaufart',
  'fu_hersteller',
  'fu_type',
  'fu_nennstrom',
  'fu_nennstrom_eingestellt',
  'fu_max_speed',
  'fu_max_frequency',
  'laststrom_calculated',
  'laststrom_fat',
  'laststrom_sat',
];

const NEXT_FIELD_RE =
  /^(Manufacturer|Type|Serial|Factor|Rated|Typ of|Insulation|Starting|No load|Accessories|Type of|Item|Section|Supplier|Project|Sheet|FN\.|Pos\.|Date|Helical)\b/i;

function emptyMotorRow() {
  const row = {};
  for (const k of MOTOR_KEYS) row[k] = '';
  return row;
}

function clamp(value, max) {
  let s = String(value == null ? '' : value).replace(/\0/g, '').trim();
  if (!s) return '';
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  if (s.length > (max || 255)) s = s.slice(0, max || 255);
  return s;
}

function isPlaceholder(v) {
  const t = String(v || '').trim();
  if (!t) return true;
  const stripped = t.replace(/[_\-\.\s]+/g, '');
  return stripped === '';
}

function isUnitLine(ln) {
  return /^(?:kW|KW|A|V\s*\/\s*Hz|min\s*-?1|min⁻1|min|cos\s*[fφ]|cos\s*phi|-1|~)$/iu.test(String(ln || '').trim());
}

function stripLeadingUnit(v) {
  let s = String(v || '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^(?:kW|min-?1|min⁻1|Hz|V|A|cos\s*φ|cos\s*phi|cos\s*f)\b\s*/iu, '');
  s = s.replace(/^~\s*/, '');
  return s.trim();
}

function cleanToken(v) {
  const s = stripLeadingUnit(v);
  if (isPlaceholder(s)) return '';
  if (/^,\d/.test(s)) return '0' + s;
  return s;
}

function cleanValue(v) {
  const s = stripLeadingUnit(v);
  if (!s || isPlaceholder(s)) return '';
  if (!s.includes('/')) return cleanToken(s);
  const kept = String(s)
    .split(/\s*\/\s*/)
    .map((p) => cleanToken(p))
    .filter(Boolean);
  return kept.join(' / ');
}

function splitSlashPair(raw) {
  const v = stripLeadingUnit(raw);
  if (!v) return ['', ''];
  const hadSlash = v.includes('/');
  const parts = hadSlash ? v.split(/\s*\/\s*/, 2) : [v, ''];
  return [cleanToken(parts[0] || ''), cleanToken(parts[1] || '')];
}

function normalizeOne(item) {
  if (!item || typeof item !== 'object') return null;
  const row = emptyMotorRow();
  let any = false;
  for (const k of MOTOR_KEYS) {
    const v = clamp(item[k] != null ? String(item[k]) : '');
    row[k] = v;
    if (v) any = true;
  }
  return any ? row : null;
}

function nonemptyLines(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .map((ln) => ln.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

function isMotorListLayout(text) {
  const t = String(text || '');
  if (/M\s*O\s*T\s*O\s*R\s*[-–]\s*L\s*I\s*S\s*T/i.test(t)) return true;
  if (/Motorle\.doc/i.test(t)) return true;
  if (/Typ of drive/i.test(t) && /Serial\s*-\s*No/i.test(t)) return true;
  return false;
}

function fieldFromLines(lines, labels, opts) {
  const labs = Array.isArray(labels) ? labels : [labels];
  const rawMode = !!(opts && opts.raw);
  const finish = (v) => (rawMode ? stripLeadingUnit(v) : cleanValue(v));
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const ln = lines[i];
    for (const lab of labs) {
      const re = new RegExp('^' + lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:?\\s*(.*)$', 'i');
      const m = ln.match(re);
      if (!m) continue;
      const same = String(m[1] || '').trim();
      if (/^of\b/i.test(same)) continue;
      if (same && same !== ':' && !isUnitLine(same) && !NEXT_FIELD_RE.test(same)) {
        return finish(same);
      }
      for (let j = i + 1; j < n && j < i + 10; j++) {
        const cand = lines[j];
        if (isUnitLine(cand)) continue;
        if (NEXT_FIELD_RE.test(cand) && !/^(min|A|kW|KW)$/i.test(cand)) break;
        if (/:$/.test(cand) && cand.length < 48) break;
        return finish(cand);
      }
    }
  }
  return '';
}

function itemCode(lines) {
  for (const ln of lines) {
    const m = ln.match(/\b(W-M\d+)\b/i);
    if (m) return m[1].toUpperCase().replace('W-M', 'W-M');
  }
  return '';
}

function sectionLabel(lines) {
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    if (!/^Section\b/i.test(lines[i])) continue;
    const parts = [];
    for (let j = i + 1; j < n && j < i + 6; j++) {
      const cand = lines[j];
      if (/^(Item|Supplier|FN\.|Pos\.|Typ of|Manufacturer|Sheet|Date|Project)\b/i.test(cand)) break;
      if (isUnitLine(cand)) continue;
      parts.push(cand);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function parseMotorListPage(page) {
  const lines = nonemptyLines(page);
  const row = emptyMotorRow();
  const item = itemCode(lines);
  const section = sectionLabel(lines);
  row.positionsnummer = clamp(item);
  row.bezeichnung = clamp(section || item);
  row.hersteller = clamp(fieldFromLines(lines, ['Manufacturer'], { raw: true }));
  row.type = clamp(fieldFromLines(lines, ['Type'], { raw: true }));
  row.seriennummer = clamp(
    fieldFromLines(lines, ['Serial - No.', 'Serial-No.', 'Serial Number', 'Seriennummer'], { raw: true }),
  );
  row.nennleistung_kw = clamp(cleanValue(fieldFromLines(lines, ['Rated output'])));
  row.leistungsfaktor = clamp(cleanValue(fieldFromLines(lines, ['Factor of effective power'])));
  const speedPair = splitSlashPair(fieldFromLines(lines, ['Rated speed']));
  row.nenndrehzahl = clamp(speedPair[0]);
  row.getriebedrehzahl = clamp(speedPair[1]);
  row.nennstrom = clamp(cleanValue(fieldFromLines(lines, ['Rated current'])));
  const voltPair = splitSlashPair(fieldFromLines(lines, ['Rated voltage']));
  row.nennspannung = clamp(voltPair[0]);
  row.nennfrequenz = clamp(voltPair[1]);
  row.bauform = clamp(fieldFromLines(lines, ['Type of construction'], { raw: true }));
  row.schutzart = clamp(fieldFromLines(lines, ['Type of protection'], { raw: true }));
  row.isolationsklasse = clamp(fieldFromLines(lines, ['Insulation classes', 'Insulation class'], { raw: true }));
  row.anlaufart = clamp(fieldFromLines(lines, ['Starting'], { raw: true }));
  row.leerlaufstrom_50hz = clamp(cleanValue(fieldFromLines(lines, ['No load operation', 'No load current at 50 Hz'])));
  return normalizeOne(row);
}

function parseMotorListText(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  let parts = raw.split(/(?=\bSection\b)/i);
  if (parts.length < 2) parts = raw.split(/(?=\bItem\b)/i);
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const chunk = String(part || '').trim();
    if (!chunk) continue;
    if (!/\bItem\b/i.test(chunk) && !/\bW-M\d+\b/i.test(chunk)) continue;
    if (!/\b(Manufacturer|Type\s*:|Rated output)\b/i.test(chunk)) continue;
    const row = parseMotorListPage(chunk);
    if (!row) continue;
    const key = [row.positionsnummer, row.seriennummer, row.type].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Längere Bezeichnungen zuerst, damit „Rated speed“ nicht „Rated speed Gear“ schluckt. */
const SHEET_LABELS = [
  ['fu_max_speed', ['max. Speed', 'max. Drehzahl', 'Velocidad máxima', 'Velocidad maxima']],
  ['fu_max_frequency', ['max. Frequency', 'max. Frequenz', 'Frecuencia máxima', 'Frecuencia maxima']],
  ['fu_nennstrom_pair', ['Rated current / Adjusted', 'Nennstrom / Einstellung', 'Corriente nominal / Ajuste']],
  ['leerlaufstrom_50hz', ['No load current at 50 Hz', 'Leerlaufstrom bei 50 Hz', 'Leerlauflauf bei 50 Hz', 'Corriente sin carga en 50 Hz']],
  ['getriebedrehzahl', ['Rated speed Gear', 'Nenndrehzahl Getriebe', 'Velocidad nominal de la caja de engranajes']],
  ['nenndrehzahl', ['Rated speed', 'Nenndrehzahl Motor', 'Nenndrehzahl', 'Velocidad nominal del motor', 'Velocidad nominal']],
  ['nennstrom', ['Rated current', 'Nennstrom', 'Corriente nominal']],
  ['leistungsfaktor', ['Factor of effective power', 'Wirkleistungsfaktor', 'Factor de potencia activa', 'Factor de potencia efectiva']],
  ['nennleistung_kw', ['Rated output', 'Nennleistung', 'Potencia nominal']],
  ['nennspannung', ['Rated voltage', 'Nennspannung', 'Voltaje nominal', 'Tensión nominal', 'Tension nominal']],
  ['nennfrequenz', ['Rated frequency', 'Nennfrequenz', 'Frecuencia nominal']],
  ['getriebeuebersetzung', ['Leverage Gear', 'Übersetzung Getriebe', 'Uebersetzung Getriebe', 'Relación de transmisión', 'Relacion de transmision']],
  ['bauform', ['Type of construction', 'Bauform', 'Diseño', 'Diseno', 'Tipo de construcción', 'Tipo de construccion']],
  ['schutzart', ['Type of protection', 'Schutzart', 'Grado de protección', 'Grado de proteccion', 'Protección', 'Proteccion']],
  ['isolationsklasse', ['Insulation classes', 'Insulation class', 'Isolationsklasse', 'Clase de aislamiento']],
  ['schaltung', ['Connection', 'Schaltung', 'Circuito']],
  ['anlaufart', ['Starting', 'Anlauf', 'Arranque', 'Arrancar']],
  ['seriennummer', ['Serial Number', 'Serial - No.', 'Serial-No.', 'Seriennummer', 'Fabrikationsnummer', 'Número de fabricación', 'Numero de fabricacion']],
  ['auxiliary', ['Auxiliary drive', 'Zusatzantrieb', 'Hilfsantrieb', 'Accionamiento auxiliar']],
  ['application', ['Application', 'Verwendung', 'Anwendung', 'Aplicación', 'Aplicacion']],
  ['positionsnummer', ['Position', 'Posición', 'Posicion']],
  ['type', ['Type', 'Typ', 'Tipo']],
  ['hersteller', ['Manufacturer', 'Hersteller', 'Fabricante']],
].flatMap(([field, labels]) => labels.map((lab) => ({ field, lab: lab.toLowerCase() })));

SHEET_LABELS.sort((a, b) => b.lab.length - a.lab.length);

const SHEET_FU_FIELDS = new Set(['fu_max_speed', 'fu_max_frequency', 'fu_nennstrom_pair']);
const SHEET_MOTOR_FIELDS = new Set([
  'anlaufart',
  'leerlaufstrom_50hz',
  'schutzart',
  'isolationsklasse',
  'schaltung',
  'bauform',
  'nennspannung',
  'nennfrequenz',
  'getriebeuebersetzung',
  'getriebedrehzahl',
  'nennstrom',
  'nenndrehzahl',
  'leistungsfaktor',
  'nennleistung_kw',
  'seriennummer',
  'positionsnummer',
  'application',
  'auxiliary',
]);

function isSkippableSheetLine(ln) {
  const t = String(ln || '').trim();
  if (!t) return true;
  if (isUnitLine(t)) return true;
  return !/[0-9A-Za-zÄÖÜäöüßÁÉÍÓÚáéíóúñÑ]/.test(t);
}

function matchSheetLabel(line) {
  const norm = String(line || '').trim();
  const low = norm.toLowerCase();
  for (const a of SHEET_LABELS) {
    if (low === a.lab || low === a.lab + ':') return { field: a.field, value: '' };
    if (!low.startsWith(a.lab)) continue;
    const rest = norm.slice(a.lab.length).replace(/^[\s:]+/, '');
    return { field: a.field, value: rest };
  }
  return null;
}

function cleanSheetValue(raw) {
  let s = String(raw || '')
    .replace(/[✓✔]/g, '')
    .replace(/\uF0FC/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || isPlaceholder(s)) return '';
  s = s.replace(/^(?:kW|KW|Hz|cos\s*φ|cos\s*phi|cos\s*f)\s*/iu, '');
  s = s.replace(/^min⁻1(?=\d)/u, '');
  s = s.replace(/^min-1(?=\d)/, '');
  s = s.replace(/^A(?=\d)/, '');
  s = s.replace(/^V(?=\d)/, '');
  s = s.replace(/^~\s*/, '');
  s = s.trim();
  if (!s || isPlaceholder(s)) return '';
  if (/^(?:calculated|berechnet|calculado)\s*FATSAT$/i.test(s)) return '';
  if (/^of\s/i.test(s)) return '';
  if (/\b(of\s+scale|capacity|construction|protection)\b/i.test(s) && !/\d/.test(s)) return '';
  if (/^,\d/.test(s)) s = '0' + s;
  return s;
}

function assignSheetType(row, val, section) {
  if (!val) return;
  const fu = /sinamics|\bg120\b|micromaster/i.test(val);
  const motor = /^(?:K[A-Z]?\d|DRN|DRS|DRE)/i.test(val) || /DRN|DRS|DRE/.test(val);
  if (fu || (section === 'fu' && !motor)) {
    if (!row.fu_type) row.fu_type = val;
    return;
  }
  if (!row.type) row.type = val;
}

function assignSheetHersteller(row, val, section) {
  if (!val) return;
  const asFu = section === 'fu' || /siemens/i.test(val);
  if (asFu && !row.fu_hersteller) {
    row.fu_hersteller = val;
    return;
  }
  if (!row.hersteller) row.hersteller = val;
  else if (!row.fu_hersteller) row.fu_hersteller = val;
}

function parseDataSheetChunk(page) {
  const lines = nonemptyLines(page).filter((ln) => !isSkippableSheetLine(ln));
  const row = emptyMotorRow();
  let section = 'sheet';
  let application = '';
  let auxiliary = '';
  for (let i = 0; i < lines.length; i++) {
    const hit = matchSheetLabel(lines[i]);
    if (!hit) continue;
    let raw = hit.value;
    if (!raw) {
      for (let j = i + 1; j < lines.length && j < i + 5; j++) {
        if (isSkippableSheetLine(lines[j])) continue;
        if (matchSheetLabel(lines[j])) break;
        raw = lines[j];
        break;
      }
    }
    const val = cleanSheetValue(raw);
    if (SHEET_FU_FIELDS.has(hit.field)) section = 'fu';
    if (SHEET_MOTOR_FIELDS.has(hit.field)) section = 'motor';
    if (!val) continue;
    if (hit.field === 'seriennummer' && /^\d{1,6}$/.test(val)) continue;
    if (hit.field === 'type') {
      assignSheetType(row, val, section);
      continue;
    }
    if (hit.field === 'hersteller') {
      assignSheetHersteller(row, val, section);
      continue;
    }
    if (hit.field === 'fu_nennstrom_pair') {
      const pair = splitSlashPair(val);
      if (!row.fu_nennstrom) row.fu_nennstrom = pair[0];
      if (!row.fu_nennstrom_eingestellt) row.fu_nennstrom_eingestellt = pair[1];
      continue;
    }
    if (hit.field === 'application') {
      if (!application) application = val;
      continue;
    }
    if (hit.field === 'auxiliary') {
      if (!auxiliary) auxiliary = val;
      continue;
    }
    if (!row[hit.field]) row[hit.field] = val;
  }
  const xd = (auxiliary.match(/\bXD\s*([1-7])\b/i) || [])[0] || '';
  const xdNorm = xd ? xd.replace(/\s+/g, '').toUpperCase() : '';
  let bez = application;
  if (xdNorm) bez = xdNorm + (bez ? ' ' + bez : '');
  row.bezeichnung = bez;
  if (!row.anlaufart) {
    for (const ln of lines) {
      if (/^(Frequency converter|Frequenzumrichter|Convertidor de frecuencia)$/i.test(String(ln || '').trim())) {
        row.anlaufart = String(ln).trim();
        break;
      }
    }
  }
  return normalizeOne(row);
}

function isDataSheetChunk(chunk) {
  return /Motor data|Motordaten|Datos de motor|Auxiliary drive|Zusatzantrieb|Hilfsantrieb|Accionamiento auxiliar|Rated output|Nennleistung|Potencia nominal/i.test(
    String(chunk || ''),
  );
}

function splitDataSheetChunks(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const pages = raw.split(/\f/).map((s) => s.trim()).filter(Boolean);
  const startRe = /(?=^(?:max\. Speed|max\. Drehzahl|Velocidad máxima|Velocidad maxima))/im;
  const out = [];
  for (const page of pages.length ? pages : [raw]) {
    const bits = page.split(startRe).map((s) => s.trim()).filter(Boolean);
    if (bits.length > 1) out.push(...bits);
    else if (page) out.push(page);
  }
  return out;
}

function parseDataSheetText(text) {
  const out = [];
  const seen = new Set();
  for (const chunk of splitDataSheetChunks(text)) {
    if (!isDataSheetChunk(chunk)) continue;
    const row = parseDataSheetChunk(chunk);
    if (!row) continue;
    const key = [row.positionsnummer, row.seriennummer, row.type].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function parseMlPdfText(text) {
  const raw = String(text || '');
  if (isMotorListLayout(raw)) {
    const list = parseMotorListText(raw);
    if (list.length) return list;
  }
  return parseDataSheetText(raw);
}

/** 0 Deutsch, 1 Englisch, 2 sonstige, 3 Spanisch (Fallback). */
function mlPdfLangRank(relPath) {
  const r = String(relPath || '').replace(/\\/g, '/').toLowerCase();
  const base = r.split('/').pop() || '';
  if (/(^|\/)(deutsch|german)(\/|$)/.test(r) || /_de\./.test(base)) return 0;
  if (/(^|\/)(englisch|english)(\/|$)/.test(r) || /_en\./.test(base)) return 1;
  if (/(^|\/)(spanisch|spanish|espa)/.test(r) || /_sp\./.test(base)) return 3;
  return 2;
}

function loadPdfParse() {
  try {
    return require('pdf-parse');
  } catch (_) {
    return null;
  }
}

async function extractPdfText(buf) {
  const pdfParse = loadPdfParse();
  if (!pdfParse || !buf || !buf.length) return '';
  const data = await pdfParse(buf);
  return String((data && data.text) || '');
}

async function parseMlPdfBuffer(buf) {
  const text = await extractPdfText(buf);
  if (!text.trim()) {
    return { ok: false, error: 'PDF ohne lesbaren Text.', motors: [], text: '' };
  }
  const motors = parseMlPdfText(text);
  return {
    ok: true,
    motors,
    text,
    note: motors.length ? '' : 'PDF gelesen, aber keine Antriebe zugeordnet.',
  };
}

function isMlPdfCandidate(filename, relPath) {
  const name = String(filename || '');
  const ext = name.split('.').pop().toLowerCase();
  if (ext !== 'pdf') return false;
  const rel = String(relPath || '')
    .replace(/\\/g, '/')
    .toLowerCase();
  if (/_ml_/i.test(name)) return true;
  if (rel.includes('motor list') || rel.includes('01.02')) return true;
  if (/motorle/i.test(name)) return true;
  return /motor.?list/i.test(name);
}

module.exports = {
  parseMlPdfText,
  parseMlPdfBuffer,
  extractPdfText,
  isMlPdfCandidate,
  isMotorListLayout,
  mlPdfLangRank,
};
