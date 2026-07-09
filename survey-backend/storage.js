// ชั้นจัดเก็บข้อมูล (storage layer)
// - ถ้ามี DATABASE_URL  -> ใช้ PostgreSQL
// - ถ้าไม่มี            -> ใช้ไฟล์ JSON (สำหรับรันในเครื่องที่ไม่มีฐานข้อมูล)
//
// interface เดียวกัน:
//   store.kind
//   store.all()               -> Promise<item[]>  (ใหม่สุดก่อน, แต่ละ item มี hasPhoto:boolean)
//   store.phoneExists(phone)  -> Promise<boolean>
//   store.insert(item)        -> Promise<{ ok:true } | { ok:false, duplicate:true }>
//   store.getPhoto(id)        -> Promise<{ mime, buffer } | null>
//
// item: { id, name, email, phone, birthdate:'YYYY-MM-DD', rating, comment, ip, submittedAt:ISO,
//         photo?: { mime, ext, buffer } }   // photo ใส่ตอน insert เท่านั้น

import fs from 'node:fs';
import fsp from 'node:fs/promises';

export async function createStore({ dataDir } = {}) {
  if (process.env.DATABASE_URL) return createPgStore();
  return createFileStore(dataDir);
}

// ---------------------------------------------------------------- PostgreSQL
async function createPgStore() {
  const pg = (await import('pg')).default;

  const connectionString = process.env.DATABASE_URL;
  const useSSL =
    process.env.PGSSL === 'require' || /[?&]sslmode=require/.test(connectionString);

  const pool = new pg.Pool({
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 5,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS responses (
      id           UUID PRIMARY KEY,
      name         TEXT        NOT NULL,
      email        TEXT        NOT NULL,
      phone        TEXT        NOT NULL UNIQUE,
      birthdate    DATE        NOT NULL,
      rating       INTEGER     NOT NULL,
      comment      TEXT        NOT NULL DEFAULT '',
      ip           TEXT        NOT NULL DEFAULT '',
      submitted_at TIMESTAMPTZ NOT NULL,
      photo        BYTEA,
      photo_mime   TEXT
    )
  `);
  // เผื่อตารางเดิมยังไม่มีคอลัมน์รูป
  await pool.query('ALTER TABLE responses ADD COLUMN IF NOT EXISTS photo BYTEA');
  await pool.query('ALTER TABLE responses ADD COLUMN IF NOT EXISTS photo_mime TEXT');

  const LIST_COLS =
    "id, name, email, phone, to_char(birthdate,'YYYY-MM-DD') AS birthdate, rating, comment, ip, submitted_at, (photo IS NOT NULL) AS has_photo";

  const toItem = (row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    birthdate: row.birthdate,
    rating: row.rating,
    comment: row.comment,
    ip: row.ip,
    submittedAt: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : row.submitted_at,
    hasPhoto: row.has_photo === true,
  });

  return {
    kind: 'postgres',
    async all() {
      const { rows } = await pool.query(`SELECT ${LIST_COLS} FROM responses ORDER BY submitted_at DESC`);
      return rows.map(toItem);
    },
    async phoneExists(phone) {
      const { rowCount } = await pool.query('SELECT 1 FROM responses WHERE phone = $1 LIMIT 1', [phone]);
      return rowCount > 0;
    },
    async insert(item) {
      try {
        await pool.query(
          `INSERT INTO responses (id, name, email, phone, birthdate, rating, comment, ip, submitted_at, photo, photo_mime)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            item.id, item.name, item.email, item.phone, item.birthdate, item.rating,
            item.comment, item.ip, item.submittedAt,
            item.photo ? item.photo.buffer : null,
            item.photo ? item.photo.mime : null,
          ]
        );
        return { ok: true };
      } catch (e) {
        if (e && e.code === '23505') return { ok: false, duplicate: true };
        throw e;
      }
    },
    async getPhoto(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id || '')) return null;
      const { rows } = await pool.query('SELECT photo, photo_mime FROM responses WHERE id = $1', [id]);
      if (!rows.length || !rows[0].photo) return null;
      return { mime: rows[0].photo_mime || 'application/octet-stream', buffer: rows[0].photo };
    },
  };
}

// ---------------------------------------------------------------- ไฟล์ JSON
function createFileStore(dataDir) {
  const DATA_DIR = dataDir;
  const PHOTOS_DIR = `${DATA_DIR}/photos`;
  const DATA_FILE = `${DATA_DIR}/responses.json`;

  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');

  async function readAll() {
    try {
      const arr = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  const toItem = (r) => ({
    id: r.id, name: r.name, email: r.email, phone: r.phone, birthdate: r.birthdate,
    rating: r.rating, comment: r.comment, ip: r.ip, submittedAt: r.submittedAt,
    hasPhoto: Boolean(r.photoFile),
  });

  let writeQueue = Promise.resolve();

  return {
    kind: 'file',
    async all() {
      const all = await readAll();
      all.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      return all.map(toItem);
    },
    async phoneExists(phone) {
      const all = await readAll();
      return all.some((r) => r.phone === phone);
    },
    insert(item) {
      const task = writeQueue.then(async () => {
        const all = await readAll();
        if (all.some((r) => r.phone === item.phone)) return { ok: false, duplicate: true };

        let photoFile = null;
        let photoMime = null;
        if (item.photo) {
          photoFile = `${item.id}.${item.photo.ext}`;
          photoMime = item.photo.mime;
          await fsp.writeFile(`${PHOTOS_DIR}/${photoFile}`, item.photo.buffer);
        }

        all.push({
          id: item.id, name: item.name, email: item.email, phone: item.phone,
          birthdate: item.birthdate, rating: item.rating, comment: item.comment,
          ip: item.ip, submittedAt: item.submittedAt, photoFile, photoMime,
        });
        const tmp = DATA_FILE + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
        await fsp.rename(tmp, DATA_FILE);
        return { ok: true };
      });
      writeQueue = task.then(() => {}, () => {});
      return task;
    },
    async getPhoto(id) {
      const all = await readAll();
      const r = all.find((x) => x.id === id);
      if (!r || !r.photoFile) return null;
      try {
        const buffer = await fsp.readFile(`${PHOTOS_DIR}/${r.photoFile}`);
        return { mime: r.photoMime || 'application/octet-stream', buffer };
      } catch {
        return null;
      }
    },
  };
}
