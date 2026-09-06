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

function afterLabel(text, label) {
  const pat = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+([^\\r\\n]+)', 'iu');
  const all = [];
  let m;
  const re = new RegExp(pat.source, 'giu');
  while ((m = re.exec(text))) {
    const v = String(m[1] || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!v || v === '-' || v === '—' || v === '____' || v.toLowerCase() === 'n') continue;
    all.push(v);
  }
  return all;
}

function parseDataSheetPage(page) {
  const row = emptyMotorRow();
  let aux = (afterLabel(page, 'Auxiliary drive')[0] || afterLabel(page, 'Hilfsantrieb')[0] || '').trim();
  let app = (afterLabel(page, 'Application')[0] || afterLabel(page, 'Anwendung')[0] || '').trim();
  let xd = '';
  const xm = (aux + ' ' + page).match(/\bXD\s*([1-7])\b/i);
  if (xm) xd = 'XD' + xm[1];
  let bez = app;
  if (xd) bez = xd + (bez ? ' ' + bez : '');
  row.bezeichnung = clamp(bez);
  row.positionsnummer = clamp(afterLabel(page, 'Position')[0] || '');
  const man = afterLabel(page, 'Manufacturer');
  man.sort((a, b) => b.length - a.length);
  row.hersteller = clamp(man[0] || '');
  let type = '';
  for (const cand of afterLabel(page, 'Type')) {
    if (/\b(of\s+scale|capacity|fabr|construction|protection)\b/i.test(cand)) continue;
    if (/^of\s/i.test(cand)) continue;
    const t = cleanValue(cand);
    if (t) {
      type = t;
      break;
    }
  }
  if (!type) {
    const tm = page.match(/\b(K[A-Z]\d{2}\S*)/u);
    if (tm) type = tm[1];
  }
  row.type = clamp(type);
  row.seriennummer = clamp(afterLabel(page, 'Serial Number')[0] || afterLabel(page, 'Seriennummer')[0] || '');
  row.nennleistung_kw = clamp(cleanValue(afterLabel(page, 'Rated output')[0] || ''));
  row.leistungsfaktor = clamp(cleanValue(afterLabel(page, 'Factor of effective power')[0] || ''));
  for (const cand of afterLabel(page, 'Rated speed')) {
    if (/^\s*Gear\b/i.test(cand)) continue;
    row.nenndrehzahl = clamp(cleanValue(cand));
    break;
  }
  let nennstromRaw = '';
  for (const cand of afterLabel(page, 'Rated current')) {
    if (/Adjusted/i.test(cand)) continue;
    nennstromRaw = cand;
    break;
  }
  row.nennstrom = clamp(cleanValue(nennstromRaw));
  row.getriebeuebersetzung = clamp(afterLabel(page, 'Leverage Gear')[0] || '');
  row.getriebedrehzahl = clamp(cleanValue(afterLabel(page, 'Rated speed Gear')[0] || ''));
  row.nennspannung = clamp(cleanValue(afterLabel(page, 'Rated voltage')[0] || ''));
  row.nennfrequenz = clamp(cleanValue(afterLabel(page, 'Rated frequency')[0] || ''));
  row.bauform = clamp(afterLabel(page, 'Type of construction')[0] || '');
  row.schaltung = clamp(afterLabel(page, 'Connection')[0] || '');
  row.isolationsklasse = clamp(afterLabel(page, 'Insulation class')[0] || '');
  row.schutzart = clamp(afterLabel(page, 'Type of protection')[0] || '');
  row.leerlaufstrom_50hz = clamp(cleanValue(afterLabel(page, 'No load current at 50 Hz')[0] || ''));
  row.anlaufart = clamp(afterLabel(page, 'Starting')[0] || '');
  return normalizeOne(row);
}

function parseMlPdfText(text) {
  const raw = String(text || '');
  if (isMotorListLayout(raw)) {
    const list = parseMotorListText(raw);
    if (list.length) return list;
  }
  const chunks = raw.replace(/\r\n/g, '\n').split(/\f|(?=Motor data sheet)/i);
  const out = [];
  for (const chunk of chunks) {
    const c = String(chunk || '').trim();
    if (!c) continue;
    if (!/Motor data|Auxiliary drive|Hilfsantrieb/i.test(c)) continue;
    const row = parseDataSheetPage(c);
    if (row) out.push(row);
  }
  return out;
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
};
