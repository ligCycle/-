// ชั้นจัดเก็บข้อมูล (storage layer)
// - ถ้ามี DATABASE_URL  -> ใช้ PostgreSQL
// - ถ้าไม่มี            -> ใช้ไฟล์ JSON (สำหรับรันในเครื่องที่ไม่มีฐานข้อมูล)
//
// ทุก implementation คืน interface เดียวกัน:
//   store.kind                     ชนิดที่ใช้ ('postgres' | 'file')
//   store.all()        -> Promise<item[]>   (เรียงใหม่สุดก่อน)
//   store.phoneExists(phone) -> Promise<boolean>
//   store.insert(item) -> Promise<{ ok: true } | { ok: false, duplicate: true }>
//
// รูปแบบ item: { id, name, email, phone, birthdate:'YYYY-MM-DD', rating, comment, ip, submittedAt:ISO }

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
  // Railway (private network) ไม่ต้องใช้ SSL; ถ้าต่อผ่าน public URL ให้ตั้ง PGSSL=require
  const useSSL =
    process.env.PGSSL === 'require' || /[?&]sslmode=require/.test(connectionString);

  const pool = new pg.Pool({
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 5,
  });

  // สร้างตารางถ้ายังไม่มี — phone เป็น UNIQUE เพื่อกันเบอร์ซ้ำระดับฐานข้อมูล
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
      submitted_at TIMESTAMPTZ NOT NULL
    )
  `);

  const SELECT_COLS =
    "id, name, email, phone, to_char(birthdate,'YYYY-MM-DD') AS birthdate, rating, comment, ip, submitted_at";

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
  });

  return {
    kind: 'postgres',
    async all() {
      const { rows } = await pool.query(
        `SELECT ${SELECT_COLS} FROM responses ORDER BY submitted_at DESC`
      );
      return rows.map(toItem);
    },
    async phoneExists(phone) {
      const { rowCount } = await pool.query('SELECT 1 FROM responses WHERE phone = $1 LIMIT 1', [phone]);
      return rowCount > 0;
    },
    async insert(item) {
      try {
        await pool.query(
          `INSERT INTO responses (id, name, email, phone, birthdate, rating, comment, ip, submitted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [item.id, item.name, item.email, item.phone, item.birthdate, item.rating, item.comment, item.ip, item.submittedAt]
        );
        return { ok: true };
      } catch (e) {
        if (e && e.code === '23505') return { ok: false, duplicate: true }; // unique_violation
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------- ไฟล์ JSON
function createFileStore(dataDir) {
  const path = dataDir;
  const DATA_DIR = path;
  const DATA_FILE = `${DATA_DIR}/responses.json`;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');

  async function readAll() {
    try {
      const arr = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  // เขียนทีละคิว กันไฟล์พัง + กันเบอร์ซ้ำเวลามีคนส่งพร้อมกัน
  let writeQueue = Promise.resolve();

  return {
    kind: 'file',
    async all() {
      const all = await readAll();
      all.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      return all;
    },
    async phoneExists(phone) {
      const all = await readAll();
      return all.some((r) => r.phone === phone);
    },
    insert(item) {
      const task = writeQueue.then(async () => {
        const all = await readAll();
        if (all.some((r) => r.phone === item.phone)) return { ok: false, duplicate: true };
        all.push(item);
        const tmp = DATA_FILE + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
        await fsp.rename(tmp, DATA_FILE);
        return { ok: true };
      });
      writeQueue = task.then(() => {}, () => {});
      return task;
    },
  };
}
