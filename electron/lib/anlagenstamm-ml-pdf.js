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
  return /^(?:kW|KW|A|Hz|V(?:\s*\/\s*Hz)?|min(?:[-⁻^]\s*[1¹]|-?\s*1(?!\d))?|cos\s*[fφ]|cos\s*phi|-1|~)$/iu.test(String(ln || '').trim());
}

function stripLeadingUnit(v) {
  let s = String(v || '')
    .replace(/\s+/g, ' ')
    .trim();
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(/^(?:kW|KW|Hz|cos\s*φ|cos\s*phi|cos\s*f|V\s*\/\s*Hz|min(?:[-⁻^]\s*[1¹]|-?\s*1(?!\d))?|A|V)(?:\s+|(?=\d))/iu, '');
    s = s.replace(/^~\s*/, '');
    s = s.trim();
  }
  return s;
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
  if (/(^|[^a-z])motorl(?:iste)?(?![a-z])/i.test(t)) return true;
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
    const m = ln.match(/\b(W-\d*M\d+)\b/i);
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
  return normalizeOne(finishMotorRow(row));
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
    if (!/\bItem\b/i.test(chunk) && !/\bW-\d*M\d+\b/i.test(chunk)) continue;
    if (!/\b(Manufacturer|Type\s*:|Rated output|Hersteller|Nennleistung|Fabrikations)\b/i.test(chunk)) continue;
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
  ['getriebeuebersetzung', ['Leverage Gear', 'Übersetzung Getriebe', 'Uebersetzung Getriebe', 'Übersetzung', 'Uebersetzung', 'Relación de transmisión', 'Relacion de transmision']],
  ['bauform', ['Type of construction', 'Bauform', 'Diseño', 'Diseno', 'Tipo de construcción', 'Tipo de construccion']],
  ['schutzart', ['Type of protection', 'Schutzart', 'Grado de protección', 'Grado de proteccion', 'Protección', 'Proteccion']],
  ['isolationsklasse', ['Insulation classes', 'Insulation class', 'Isolationsklasse', 'Clase de aislamiento']],
  ['schaltung', ['Connection', 'Schaltung', 'Circuito']],
  ['anlaufart', ['Starting', 'Anlaufart', 'Anlauf', 'Arranque', 'Arrancar']],
  ['seriennummer', ['Serial Number', 'Serial - No.', 'Serial-No.', 'Seriennummer', 'Fabrikationsnummer', 'Fabrikations-Nr', 'Fabrikationsnr', 'Fabr.-Nr', 'Fabr. Nr', 'Número de fabricación', 'Numero de fabricacion']],
  ['auxiliary', ['Auxiliary drive', 'Zusatzantrieb', 'Hilfsantrieb', 'Accionamiento auxiliar']],
  ['application', ['Application', 'Verwendung', 'Anwendung', 'Antriebsart', 'Aplicación', 'Aplicacion']],
  ['bauteil', ['Bauteil']],
  ['positionsnummer', ['Position', 'Pos.', 'Posición', 'Posicion']],
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
  'bauteil',
]);

function isSkippableSheetLine(ln) {
  const t = String(ln || '').trim();
  if (!t) return true;
  if (isUnitLine(t)) return true;
  return !/[0-9A-Za-zÄÖÜäöüßÁÉÍÓÚáéíóúñÑ]/.test(t);
}

function matchSheetLabel(line) {
  let norm = String(line || '').trim().replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
  const low = norm.toLowerCase();
  for (const a of SHEET_LABELS) {
    if (low === a.lab || low === a.lab + ':') return { field: a.field, value: '' };
    if (!low.startsWith(a.lab)) continue;
    const rest = trimValueAtNextLabel(norm.slice(a.lab.length).replace(/^[\s:]+/, ''));
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
  s = stripLeadingUnit(s);
  s = s.replace(/^A(?=\d)/, '');
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

function finishMotorRow(row) {
  const cleanKeys = [
    'nenndrehzahl',
    'getriebedrehzahl',
    'nennstrom',
    'nennleistung_kw',
    'leistungsfaktor',
    'nennspannung',
    'nennfrequenz',
    'leerlaufstrom_50hz',
    'getriebeuebersetzung',
  ];
  for (const key of cleanKeys) {
    if (String(row[key] || '').trim()) row[key] = cleanSheetValue(row[key]);
  }
  if (row.getriebeuebersetzung) {
    row.getriebeuebersetzung = String(row.getriebeuebersetzung).replace(/^i\s*=?\s*/i, '').trim();
  }
  const speed = String(row.nenndrehzahl || '').trim();
  const speedMatch = speed.match(/^(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)$/);
  if (speedMatch) {
    row.nenndrehzahl = speedMatch[1];
    if (!String(row.getriebedrehzahl || '').trim()) row.getriebedrehzahl = speedMatch[2];
  }
  const volt = String(row.nennspannung || '').trim();
  const voltMatch = volt.match(/^(\d+(?:\s*-\s*\d+)?)\s*([YΔD△](?:\s*\/\s*[YΔD△])?)\s*\/\s*(\d+(?:[.,]\d+)?)$/i);
  if (voltMatch) {
    row.nennspannung = voltMatch[1].replace(/\s*-\s*/g, '-').trim();
    if (!String(row.schaltung || '').trim()) {
      row.schaltung = voltMatch[2].toUpperCase().replace(/\s+/g, '').replace(/[D△]/g, 'Δ');
    }
    if (!String(row.nennfrequenz || '').trim()) row.nennfrequenz = voltMatch[3];
  }
  return row;
}

function copyEmptyMotor(dst, src) {
  if (String(dst.bezeichnung || '').trim() && String(dst.bezeichnung).trim() === String(dst.positionsnummer || '').trim()) {
    dst.bezeichnung = '';
  }
  for (const key of Object.keys(src || {})) {
    if (String(dst[key] || '').trim() === '' && String(src[key] || '').trim() !== '') dst[key] = src[key];
  }
  return finishMotorRow(dst);
}

function fillMotorRows(primary, extra) {
  if (!primary.length) return extra;
  if (!extra.length) return primary;
  const used = new Set();
  primary.forEach((row, i) => {
    for (let j = 0; j < extra.length; j++) {
      if (used.has(j)) continue;
      const cand = extra[j];
      const sameType = String(row.type || '').trim() && String(row.type).toLowerCase() === String(cand.type || '').toLowerCase();
      const samePos = String(row.positionsnummer || '').trim() && row.positionsnummer === cand.positionsnummer;
      const only = primary.length === 1 && extra.length === 1;
      if (!sameType && !samePos && !only) continue;
      primary[i] = copyEmptyMotor(row, cand);
      used.add(j);
      break;
    }
  });
  extra.forEach((cand, j) => {
    if (!used.has(j)) primary.push(cand);
  });
  return primary;
}

function trimValueAtNextLabel(rest) {
  let s = String(rest || '').trim();
  if (!s) return '';
  const alts = ['fn\\.?', 'datum', 'blatt', 'projekt', 'maschinenlieferant'];
  for (const a of SHEET_LABELS) {
    if (a.lab.length < 4) continue;
    alts.push(a.lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const re = new RegExp('\\s(?:' + alts.join('|') + ')(?=$|[\\s:]|[^\\p{L}])', 'iu');
  const m = re.exec(s);
  if (m && m.index > 0) return s.slice(0, m.index).trim();
  return s;
}

function pairsFromCells(cells) {
  const out = [];
  let i = 0;
  while (i < cells.length) {
    const hit = matchSheetLabel(cells[i]);
    if (!hit) {
      i++;
      continue;
    }
    if (hit.value) {
      out.push(cells[i]);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < cells.length && isUnitLine(cells[j])) j++;
    if (j >= cells.length) {
      i++;
      continue;
    }
    const next = matchSheetLabel(cells[j]);
    if (next && !next.value) {
      i++;
      continue;
    }
    out.push(cells[i] + ' ' + cells[j]);
    i = j + 1;
  }
  return out;
}

function pairsFromInline(line) {
  const hits = [];
  for (const a of SHEET_LABELS) {
    const re = new RegExp('(?<![\\p{L}\\p{N}])' + a.lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\s:]|[^\\p{L}])', 'giu');
    let m;
    while ((m = re.exec(line))) {
      hits.push({ pos: m.index, len: m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  if (!hits.length) return [line];
  hits.sort((a, b) => a.pos - b.pos || b.len - a.len);
  const kept = [];
  let coveredUntil = -1;
  for (const h of hits) {
    if (h.pos < coveredUntil) continue;
    kept.push(h);
    coveredUntil = h.pos + h.len;
  }
  const out = [];
  for (let i = 0; i < kept.length; i++) {
    const start = kept[i].pos;
    const end = i + 1 < kept.length ? kept[i + 1].pos : line.length;
    const piece = line.slice(start, end).trim();
    if (piece) out.push(piece);
  }
  return out;
}

function expandTableLine(line) {
  let s = String(line || '').trim().replace(/\s*-\s*/g, '-');
  if (!s) return [];
  const cells = s
    .split(/\t+| {2,}/)
    .map((c) => c.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (cells.length >= 2) return pairsFromCells(cells);
  return pairsFromInline(s);
}

function parseDataSheetChunk(page) {
  const lines = [];
  String(page || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .forEach((ln) => {
      expandTableLine(ln).forEach((piece) => {
        if (!isSkippableSheetLine(piece)) lines.push(piece);
      });
    });
  const row = emptyMotorRow();
  let section = 'sheet';
  let application = '';
  let auxiliary = '';
  let bauteil = '';
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
    let val = cleanSheetValue(raw);
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
    if (hit.field === 'bauteil') {
      if (!bauteil) bauteil = val;
      continue;
    }
    if (hit.field === 'getriebeuebersetzung') val = String(val).replace(/^i\s*=?\s*/i, '').trim();
    if (!row[hit.field]) row[hit.field] = val;
  }
  const xd = (auxiliary.match(/\bXD\s*([1-7])\b/i) || [])[0] || '';
  const xdNorm = xd ? xd.replace(/\s+/g, '').toUpperCase() : '';
  let bez = application;
  if (xdNorm) bez = xdNorm + (bez ? ' ' + bez : '');
  if (bauteil && bez) bez = bauteil + ' · ' + bez;
  else if (!bez) bez = bauteil;
  row.bezeichnung = bez;
  if (!row.anlaufart) {
    for (const ln of lines) {
      if (/^(Frequency converter|Frequenzumrichter|Convertidor de frecuencia)$/i.test(String(ln || '').trim())) {
        row.anlaufart = String(ln).trim();
        break;
      }
    }
  }
  return normalizeOne(finishMotorRow(row));
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

function mlSegmentFabs(part, len) {
  if (len < 4) return [];
  const re = new RegExp('(?<!\\d)(\\d{' + len + '})(?!\\d)', 'g');
  const out = new Set();
  let m;
  while ((m = re.exec(String(part || '')))) out.add(m[1]);
  return [...out];
}

/** 0 nur diese FN, 2 kein Einzel-FN, 3 andere FN. Spanne 9499-9509 ist nicht Eigentum der ersten Nummer. */
function mlFabFit(rel, fab) {
  const fd = String(fab || '').replace(/\D/g, '');
  if (!fd) return 2;
  let own = false;
  let other = false;
  for (const part of String(rel || '').replace(/\\/g, '/').toLowerCase().split('/')) {
    if (!part) continue;
    const nums = mlSegmentFabs(part, fd.length);
    if (nums.length !== 1) continue;
    if (nums[0] === fd) own = true;
    else other = true;
  }
  if (other) return 3;
  if (own) return 0;
  return 2;
}

function fnNumbers(text) {
  const out = new Set();
  const re = /\bFN\.?\s*:?\s*(?:\r?\n\s*)?(\d{4,8})\b/giu;
  let m;
  const s = String(text || '');
  while ((m = re.exec(s))) out.add(m[1]);
  return [...out];
}

function splitByFn(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks = [];
  let cur = [];
  let curFn = '';
  let pending = false;
  for (const line of lines) {
    let fn = '';
    const inline = line.match(/\bFN\.?\s*:?\s*(\d{4,8})\b/iu);
    if (inline) {
      fn = inline[1];
      pending = false;
    } else if (pending && /^\s*(\d{4,8})\b/u.test(line)) {
      fn = line.match(/^\s*(\d{4,8})\b/u)[1];
      pending = false;
    } else if (/^\s*FN\.?\s*:?\s*$/iu.test(line)) {
      pending = true;
    }
    if (fn && curFn && fn !== curFn) {
      blocks.push(cur.join('\n'));
      cur = [line];
      curFn = fn;
      continue;
    }
    if (fn && !curFn) curFn = fn;
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks.length ? blocks : [String(text || '')];
}

function appendMotorRows(into, add) {
  const score = (row) => Object.keys(row || {}).reduce((n, k) => n + (String(row[k] || '').trim() ? 1 : 0), 0);
  const index = new Map();
  into.forEach((row, i) => {
    const key = [row.positionsnummer, row.seriennummer, row.type].join('|');
    index.set(key === '||' ? 'row-' + i : key, i);
  });
  for (const row of add || []) {
    if (!row) continue;
    let key = [row.positionsnummer, row.seriennummer, row.type].join('|');
    if (key === '||' || !index.has(key)) {
      if (key === '||') key = 'row-' + into.length;
      index.set(key, into.length);
      into.push(row);
      continue;
    }
    const i = index.get(key);
    if (score(row) > score(into[i])) into[i] = row;
  }
  return into;
}

function parseMlPdfText(text, fab) {
  const raw = String(text || '');
  const want = String(fab || '').replace(/\D/g, '');
  const docHasFn = fnNumbers(raw).length > 0;
  let merged = [];
  for (const block of splitByFn(raw)) {
    const fns = fnNumbers(block);
    if (want) {
      if (fns.some((n) => n !== want)) continue;
      if (!fns.length && docHasFn) continue;
    }
    const list = isMotorListLayout(block) ? parseMotorListText(block) : [];
    const sheets = parseDataSheetText(block);
    merged = appendMotorRows(merged, fillMotorRows(list, sheets));
  }
  return merged;
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

async function parseMlPdfBuffer(buf, fab) {
  const text = await extractPdfText(buf);
  if (!text.trim()) {
    return { ok: false, error: 'PDF ohne lesbaren Text.', motors: [], text: '' };
  }
  const motors = parseMlPdfText(text, fab);
  return {
    ok: true,
    motors,
    text,
    note: motors.length ? '' : 'PDF gelesen, aber keine Antriebe zugeordnet.',
  };
}

/** MOTORL, Motorliste, Motordatenblatt, ML, Antriebsliste, Datos de motor — nicht Motorleistung oder Getriebe-Motor. */
function labelIsMotorList(label) {
  let s = String(label || '').toLowerCase();
  s = s.replace(/\.(pdf|docx?|xlsx?|txt)$/i, '');
  const flat = s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return false;
  const compact = flat.replace(/ /g, '');
  if (/(^| )ml( |$)/.test(flat)) return true;
  const phrases = [
    'motordatenblatt', 'motordatenblaetter', 'motordaten',
    'motordatasheet', 'motordata', 'motorblatt',
    'motorenliste', 'motorliste', 'motorlist',
    'antriebsliste', 'antriebsdatenblatt', 'antriebsdaten', 'antriebsblatt',
    'drivelist', 'driveslist',
    'datosdemotor', 'datosdelmotor', 'listademotores', 'listamotores',
    'motlist', 'motlst', 'mlist', 'mliste',
  ];
  if (phrases.some((p) => compact.includes(p))) return true;
  if (/motorle(?![a-z])/.test(compact) || /motorl(?![a-z])/.test(compact)) return true;
  if (/(^|[^a-z])motoren(?![a-z])/.test(compact)) return true;
  if (/\bmotor\s+list\b|\bmotor\s+data\b|\bdrive\s+list\b|\bdatos\s+de\s+motor\b|\blista\s+de\s+motores\b/.test(flat)) {
    return true;
  }
  return /\bdata\s+sheet\b/.test(flat) && /\bmotor\b/.test(flat);
}

/** 0 Dateiname, 1 Ordnername, 2 Datenblatt, 3 nur Ordner 01.02, 9 kein Treffer. */
function mlPdfMatchRank(filenameOrRel) {
  const rel = String(filenameOrRel || '').replace(/\\/g, '/');
  const parts = rel.split('/').filter(Boolean);
  const base = parts.pop() || '';
  if (labelIsMotorList(base)) return 0;
  if (parts.some((part) => labelIsMotorList(part))) return 1;
  const path = rel.toLowerCase();
  if (/datenblatt/i.test(path)) return 2;
  if (/(^|\/)01[._]02(?![0-9])/.test(path)) return 3;
  return 9;
}

function isMlPdfCandidate(filename, relPath) {
  const name = String(filename || '');
  const ext = name.split('.').pop().toLowerCase();
  if (ext !== 'pdf' && ext !== 'doc' && ext !== 'docx') return false;
  const rel = String(relPath || '').replace(/\\/g, '/');
  const rank = Math.min(mlPdfMatchRank(name), mlPdfMatchRank(rel));
  if (rank >= 9) return false;
  if (ext === 'pdf') return true;
  return rank === 0;
}

module.exports = {
  parseMlPdfText,
  parseMlPdfBuffer,
  mlFabFit,
  extractPdfText,
  isMlPdfCandidate,
  isMotorListLayout,
  mlPdfLangRank,
  mlPdfMatchRank,
};
