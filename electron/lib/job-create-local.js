'use strict';

/**
 * Lokales Anlegen eines Auftrags (Offline-First) + Pending create.
 */
const crypto = require('crypto');

function str(v) {
  return v == null ? '' : String(v).trim();
}

function normalizeDatetimeLocal(value, endOfDay) {
  const s = str(value);
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s + (endOfDay ? ' 23:59:59' : ' 00:00:00');
  }
  let out = s.replace('T', ' ');
  if (out.length === 16) out += ':00';
  return out;
}

function ensureLocalCustomer(db, payload) {
  const serverId = parseInt(payload.customer_server_id || payload.customer_id, 10);
  const name = str(payload.customer_name || (payload.customer && payload.customer.name));
  const street = str(payload.customer_street || (payload.customer && payload.customer.street));
  const house = str(payload.customer_house_number || (payload.customer && payload.customer.house_number));
  const zip = str(payload.customer_zip || (payload.customer && payload.customer.zip));
  const city = str(payload.customer_city || (payload.customer && payload.customer.city));
  const country = str(payload.customer_country || (payload.customer && payload.customer.country));
  const ex1 = str(payload.customer_address_extra_1 || (payload.customer && payload.customer.address_extra_1));
  const ex2 = str(payload.customer_address_extra_2 || (payload.customer && payload.customer.address_extra_2));
  const phone = str(payload.customer_phone || (payload.customer && payload.customer.phone));
  const email = str(payload.customer_email || (payload.customer && payload.customer.email));

  if (Number.isFinite(serverId) && serverId > 0) {
    const byServer = db.prepare('SELECT id FROM customers WHERE server_id = ? LIMIT 1').get(serverId);
    if (byServer) {
      db.prepare(
        `UPDATE customers SET name=COALESCE(NULLIF(?, ''), name), street=?, house_number=?, zip=?, city=?,
         country=?, address_extra_1=?, address_extra_2=?, phone=?, email=? WHERE id=?`,
      ).run(name || '', street, house, zip, city, country, ex1, ex2, phone, email, byServer.id);
      return { localId: byServer.id, serverId };
    }
  }

  if (name) {
    const row = db.prepare('SELECT id, server_id FROM customers WHERE name = ? LIMIT 1').get(name);
    if (row) {
      const rowServer = row.server_id != null && String(row.server_id).trim() !== '' ? Number(row.server_id) : null;
      if (rowServer == null || rowServer === serverId || !(Number.isFinite(serverId) && serverId > 0)) {
        if (Number.isFinite(serverId) && serverId > 0 && rowServer == null) {
          try {
            db.prepare('UPDATE customers SET server_id = ? WHERE id = ?').run(serverId, row.id);
          } catch (_) {
            /* unique conflict */
          }
        }
        db.prepare(
          `UPDATE customers SET street=?, house_number=?, zip=?, city=?, country=?,
           address_extra_1=?, address_extra_2=?, phone=?, email=? WHERE id=?`,
        ).run(street, house, zip, city, country, ex1, ex2, phone, email, row.id);
        return { localId: row.id, serverId: rowServer || serverId || null };
      }
    }
  }

  if (!name) {
    throw Object.assign(new Error('Kunde (Firma) erforderlich.'), { status: 400 });
  }

  const r = db
    .prepare(
      `INSERT INTO customers (server_id, name, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Number.isFinite(serverId) && serverId > 0 ? serverId : null,
      name,
      street || null,
      house || null,
      zip || null,
      city || null,
      country || null,
      ex1 || null,
      ex2 || null,
      phone || null,
      email || null,
    );
  return { localId: Number(r.lastInsertRowid), serverId: Number.isFinite(serverId) && serverId > 0 ? serverId : null };
}

function createJobLocal(db, technicianId, body, helpers) {
  const payload = body && typeof body === 'object' ? body : {};
  const jobType = str(payload.job_type) || 'Service';
  const allowed = ['Montage', 'Service', 'Stoerung', 'Wartung', 'Vertrieb', 'Inbetriebnahme', 'VertriebUndInbetriebnahme'];
  let type = jobType === 'Störung' ? 'Stoerung' : jobType;
  if (allowed.indexOf(type) < 0) {
    throw Object.assign(new Error('Ungültiger job_type.'), { status: 400 });
  }

  // Status nicht vom Client: Dispo-/Server-Regeln (mit Techniker → zugeteilt).
  let status = 'angelegt';

  const required = Math.min(99, Math.max(1, parseInt(payload.required_technicians, 10) || 1));
  const dateNotFixed = Number(payload.date_not_fixed) === 1 ? 1 : 0;
  const entryPermit = Number(payload.entry_permit_required) === 1 ? 1 : 0;
  const description = payload.description != null ? String(payload.description) : null;
  let fab = null;
  if (payload.fabrikationsnummern != null) {
    fab = typeof payload.fabrikationsnummern === 'string'
      ? payload.fabrikationsnummern
      : JSON.stringify(payload.fabrikationsnummern);
  }

  let start = normalizeDatetimeLocal(payload.start_datetime, false);
  let end = normalizeDatetimeLocal(payload.end_datetime, true);
  if (!start && !end) {
    start = '1000-01-01 00:00:00';
    end = '1000-01-01 23:59:59';
  } else if (!start || !end) {
    throw Object.assign(new Error('Datum Von und Bis (oder beide leer).'), { status: 400 });
  }

  const token = str(payload.client_create_token) || crypto.randomUUID();
  const existing = db.prepare('SELECT id FROM jobs WHERE client_create_token = ? LIMIT 1').get(token);
  if (existing) {
    return { ok: true, id: existing.id, client_create_token: token, idempotent: true };
  }

  const cust = ensureLocalCustomer(db, payload);
  if (status === 'angelegt') status = 'zugeteilt';

  const insertJob = db.prepare(
    `INSERT INTO jobs (
      server_id, job_number, customer_id, job_type, start_datetime, end_datetime, status,
      required_technicians, description, fabrikationsnummern, eap_nummer, bestellnummer,
      date_not_fixed, entry_permit_required, client_create_token, updated_at
    ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, datetime('now'))`,
  );
  const jobResult = insertJob.run(
    cust.localId,
    type,
    start,
    end,
    status,
    required,
    description,
    fab,
    dateNotFixed,
    entryPermit,
    token,
  );
  const localJobId = Number(jobResult.lastInsertRowid);

  const site = payload.job_address && typeof payload.job_address === 'object' ? payload.job_address : payload;
  if (typeof helpers.insertOrUpdateJobAddress === 'function') {
    helpers.insertOrUpdateJobAddress(db, localJobId, {
      endkunde: str(site.endkunde) || null,
      street: str(site.street),
      house_number: str(site.house_number),
      zip: str(site.zip),
      city: str(site.city),
      country: str(site.country) || 'AT',
      address_extra_1: str(site.address_extra_1) || null,
      address_extra_2: str(site.address_extra_2) || null,
    });
  }

  const hotel = payload.hotel_address && typeof payload.hotel_address === 'object' ? payload.hotel_address : null;
  if (hotel) {
    const hasHotel = ['endkunde', 'street', 'house_number', 'zip', 'city', 'country', 'phone', 'email', 'website']
      .some((k) => str(hotel[k]) !== '');
    if (hasHotel) {
      db.prepare(
        `INSERT OR REPLACE INTO job_hotel_addresses
          (job_id, endkunde, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email, website)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        localJobId,
        str(hotel.endkunde) || null,
        str(hotel.street),
        str(hotel.house_number),
        str(hotel.zip),
        str(hotel.city),
        str(hotel.country),
        str(hotel.address_extra_1) || null,
        str(hotel.address_extra_2) || null,
        str(hotel.phone) || null,
        str(hotel.email) || null,
        str(hotel.website) || null,
      );
    }
  }

  const techIds = new Set([Number(technicianId)]);
  if (Array.isArray(payload.technician_ids)) {
    payload.technician_ids.forEach((t) => {
      const n = parseInt(t, 10);
      if (Number.isFinite(n) && n > 0) techIds.add(n);
    });
  }
  const insTech = db.prepare('INSERT OR IGNORE INTO job_technicians (job_id, technician_id) VALUES (?, ?)');
  techIds.forEach((tid) => {
    try {
      if (typeof helpers.ensureTechnician === 'function') helpers.ensureTechnician(db, tid);
    } catch (_) {
      /* ignore */
    }
    insTech.run(localJobId, tid);
  });

  if (Array.isArray(payload.job_contacts)) {
    const insC = db.prepare(
      `INSERT INTO job_contacts (
        job_id, contact_name, contact_phone, contact_email,
        first_name, last_name, title, department, phone, mobile, email, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let sort = 0;
    payload.job_contacts.forEach((c) => {
      if (!c || typeof c !== 'object') return;
      const fn = str(c.first_name);
      const ln = str(c.last_name);
      const ti = str(c.title);
      const dept = str(c.department);
      const ph = str(c.phone || c.contact_phone);
      const mob = str(c.mobile);
      const em = str(c.email || c.contact_email);
      const disp = str(c.contact_name || c.display_name);
      if (!fn && !ln && !ti && !dept && !ph && !mob && !em && !disp) return;
      const combined = (fn + ' ' + ln).trim();
      const contactName = disp || combined || null;
      const contactPhone = ph || mob || null;
      sort += 1;
      insC.run(
        localJobId,
        contactName,
        contactPhone,
        em || null,
        fn || null,
        ln || null,
        ti || null,
        dept || null,
        ph || null,
        mob || null,
        em || null,
        sort,
      );
    });
  }

  const pushPayload = {
    client_create_token: token,
    job_type: type,
    required_technicians: required,
    entry_permit_required: entryPermit,
    date_not_fixed: dateNotFixed,
    start_datetime: start,
    end_datetime: end,
    description,
    fabrikationsnummern: fab,
    customer_id: cust.serverId || null,
    customer_server_id: cust.serverId || null,
    customer: {
      name: str(payload.customer_name || (payload.customer && payload.customer.name)),
      street: str(payload.customer_street || (payload.customer && payload.customer.street)),
      house_number: str(payload.customer_house_number || (payload.customer && payload.customer.house_number)),
      zip: str(payload.customer_zip || (payload.customer && payload.customer.zip)),
      city: str(payload.customer_city || (payload.customer && payload.customer.city)),
      country: str(payload.customer_country || (payload.customer && payload.customer.country)),
      address_extra_1: str(payload.customer_address_extra_1 || (payload.customer && payload.customer.address_extra_1)),
      address_extra_2: str(payload.customer_address_extra_2 || (payload.customer && payload.customer.address_extra_2)),
      phone: str(payload.customer_phone || (payload.customer && payload.customer.phone)),
      email: str(payload.customer_email || (payload.customer && payload.customer.email)),
    },
    job_address: {
      endkunde: str(site.endkunde),
      street: str(site.street),
      house_number: str(site.house_number),
      zip: str(site.zip),
      city: str(site.city),
      country: str(site.country) || 'AT',
      address_extra_1: str(site.address_extra_1),
      address_extra_2: str(site.address_extra_2),
    },
    hotel_address: hotel || null,
    job_contacts: Array.isArray(payload.job_contacts) ? payload.job_contacts : [],
    technician_ids: Array.from(techIds),
  };

  db.prepare(
    `INSERT INTO pending_changes (entity_type, entity_id, action, payload) VALUES ('job', ?, 'create', ?)`,
  ).run(localJobId, JSON.stringify(pushPayload));

  return { ok: true, id: localJobId, client_create_token: token, idempotent: false, status };
}

function upsertCustomersFromExport(db, customers) {
  if (!Array.isArray(customers) || customers.length === 0) return 0;
  const sel = db.prepare('SELECT id FROM customers WHERE server_id = ? LIMIT 1');
  const upd = db.prepare(
    `UPDATE customers SET name=?, street=?, house_number=?, zip=?, city=?, country=?,
     address_extra_1=?, address_extra_2=?, phone=?, email=? WHERE id=?`,
  );
  const ins = db.prepare(
    `INSERT INTO customers (server_id, name, street, house_number, zip, city, country, address_extra_1, address_extra_2, phone, email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  // db-compat: transaction(fn) führt fn sofort ohne Args aus.
  // better-sqlite3 native: transaction(fn) liefert eine Runner-Funktion.
  // Deshalb Closure über customers, keine Parameter an den Callback.
  const apply = () => {
    for (const c of customers) {
      const serverId = parseInt(c.id != null ? c.id : c.server_id, 10);
      if (!Number.isFinite(serverId) || serverId <= 0) continue;
      const name = str(c.name) || 'Unbekannt';
      const existing = sel.get(serverId);
      if (existing) {
        upd.run(
          name,
          str(c.street),
          str(c.house_number),
          str(c.zip),
          str(c.city),
          str(c.country),
          str(c.address_extra_1),
          str(c.address_extra_2),
          str(c.phone),
          str(c.email),
          existing.id,
        );
      } else {
        // Name-Kollision ohne server_id: server_id setzen
        const byName = db.prepare('SELECT id, server_id FROM customers WHERE name = ? LIMIT 1').get(name);
        if (byName && (byName.server_id == null || String(byName.server_id).trim() === '')) {
          try {
            db.prepare('UPDATE customers SET server_id = ? WHERE id = ?').run(serverId, byName.id);
            upd.run(
              name,
              str(c.street),
              str(c.house_number),
              str(c.zip),
              str(c.city),
              str(c.country),
              str(c.address_extra_1),
              str(c.address_extra_2),
              str(c.phone),
              str(c.email),
              byName.id,
            );
          } catch (_) {
            ins.run(
              serverId,
              name,
              str(c.street),
              str(c.house_number),
              str(c.zip),
              str(c.city),
              str(c.country),
              str(c.address_extra_1),
              str(c.address_extra_2),
              str(c.phone),
              str(c.email),
            );
          }
        } else {
          ins.run(
            serverId,
            name,
            str(c.street),
            str(c.house_number),
            str(c.zip),
            str(c.city),
            str(c.country),
            str(c.address_extra_1),
            str(c.address_extra_2),
            str(c.phone),
            str(c.email),
          );
        }
      }
      n += 1;
    }
  };
  if (db && typeof db.transaction === 'function') {
    const runner = db.transaction(apply);
    if (typeof runner === 'function') runner();
  } else {
    apply();
  }
  return n;
}

function searchCustomersLocal(db, q, limit) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 50);
  const query = str(q);
  if (!query) {
    return db
      .prepare(
        `SELECT id, server_id, name, street, house_number, zip, city, country, phone, email,
                address_extra_1, address_extra_2
         FROM customers ORDER BY name COLLATE NOCASE LIMIT ?`,
      )
      .all(lim);
  }
  const like = '%' + query.replace(/%/g, '') + '%';
  return db
    .prepare(
      `SELECT id, server_id, name, street, house_number, zip, city, country, phone, email,
              address_extra_1, address_extra_2
       FROM customers
       WHERE name LIKE ? OR city LIKE ? OR street LIKE ? OR zip LIKE ?
       ORDER BY
         CASE WHEN name LIKE ? THEN 0 ELSE 1 END,
         name COLLATE NOCASE
       LIMIT ?`,
    )
    .all(like, like, like, like, query + '%', lim);
}

module.exports = {
  createJobLocal,
  upsertCustomersFromExport,
  searchCustomersLocal,
  ensureLocalCustomer,
};
