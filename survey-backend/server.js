// ระบบหลังบ้านแบบสอบถามความพึงพอใจ
// เก็บข้อมูลใน PostgreSQL (เมื่อมี DATABASE_URL) หรือไฟล์ JSON (เมื่อไม่มี)
// มีหน้า Admin (ต้องล็อกอิน) เพื่อดูผู้กรอก

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- ตั้งค่า (แก้ได้ หรือกำหนดผ่าน environment variable) ----------
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123'; // << เปลี่ยนรหัสผ่านนี้ก่อนใช้งานจริง

const PUBLIC_DIR = path.join(__dirname, 'public');
// โฟลเดอร์เก็บไฟล์ (ใช้เฉพาะโหมดไฟล์) — ตั้งผ่าน DATA_DIR ได้ เช่นชี้ไป Railway Volume
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// ---------- เตรียมที่เก็บข้อมูล ----------
const store = await createStore({ dataDir: DATA_DIR });

// ---------- helper ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, relPath) {
  // ป้องกัน path traversal
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  try {
    const data = await fsp.readFile(filePath);
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    send(res, 200, data, { 'Content-Type': type });
  } catch {
    send(res, 404, 'Not found');
  }
}

// ---------- ตรวจสอบสิทธิ์ Admin (cookie session) ----------
// secret สำหรับเซ็น session — คงที่ข้าม restart และเปลี่ยนเมื่อเปลี่ยนรหัสผ่าน
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(`${ADMIN_USER}:${ADMIN_PASS}:survey-session-v1`).digest('hex');
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // จำ login ไว้ 7 วัน

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function checkCredentials(user, pass) {
  return timingSafeEqual(user ?? '', ADMIN_USER) && timingSafeEqual(pass ?? '', ADMIN_PASS);
}

function signSession() {
  const value = `admin:${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  return `${value}.${sig}`;
}

function verifySession(token) {
  if (!token) return false;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const value = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  if (!timingSafeEqual(sig, expected)) return false;
  const ts = parseInt(value.split(':')[1], 10);
  return Boolean(ts) && Date.now() - ts < SESSION_MAX_AGE;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  return verifySession(parseCookies(req).sid);
}

function sessionCookie(req, { clear = false } = {}) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  if (clear) return `sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
  return `sid=${signSession()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE / 1000)}${secure}`;
}

// ---------- ตรวจสอบข้อมูลฝั่งเซิร์ฟเวอร์ ----------
function validate(body) {
  const errors = {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').replace(/\D/g, '');
  const birthdate = String(body.birthdate || '').trim();
  const rating = parseInt(body.rating, 10);
  const comment = String(body.comment || '').trim();

  if (!name) errors.name = 'กรุณากรอกชื่อ-นามสกุล';
  if (name.length > 120) errors.name = 'ชื่อยาวเกินไป';
  if (!/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(email)) errors.email = 'ต้องเป็นอีเมล @gmail.com ที่ถูกต้อง';
  if (!/^0\d{9}$/.test(phone)) errors.phone = 'เบอร์โทรต้องเป็นเลข 10 หลักขึ้นต้นด้วย 0';

  // วันเกิด: รูปแบบ YYYY-MM-DD, เป็นวันที่จริง, ไม่เป็นอนาคต, ปี >= 1900
  const today = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
    errors.birthdate = 'กรุณาเลือกวันเกิด';
  } else {
    const d = new Date(birthdate + 'T00:00:00Z');
    if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== birthdate) errors.birthdate = 'วันเกิดไม่ถูกต้อง';
    else if (birthdate > today) errors.birthdate = 'วันเกิดต้องไม่เป็นอนาคต';
    else if (birthdate < '1900-01-01') errors.birthdate = 'ปีเกิดไม่ถูกต้อง';
  }

  if (!(rating >= 1 && rating <= 5)) errors.rating = 'กรุณาให้คะแนน 1-5';
  if (comment.length > 2000) errors.comment = 'ข้อความยาวเกินไป';

  return { errors, clean: { name, email, phone, birthdate, rating, comment: comment.slice(0, 2000) } };
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function toCsv(rows) {
  const headers = ['ลำดับ', 'วันเวลา', 'ชื่อ-นามสกุล', 'อีเมล', 'เบอร์โทร', 'วันเกิด', 'อายุ', 'คะแนน', 'ข้อเสนอแนะ'];
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = rows.map((r, i) =>
    [i + 1, formatDate(r.submittedAt), r.name, r.email, r.phone, r.birthdate, ageFrom(r.birthdate), r.rating, r.comment].map(esc).join(',')
  );
  return '﻿' + headers.map(esc).join(',') + '\r\n' + lines.join('\r\n');
}

function ageFrom(birthdate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate || '')) return '';
  const b = new Date(birthdate + 'T00:00:00Z');
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age >= 0 && age < 150 ? age : '';
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  } catch {
    return iso;
  }
}

// ---------- เซิร์ฟเวอร์ ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // --- ส่งแบบสอบถาม ---
    if (req.method === 'POST' && p === '/api/submit') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { ok: false, message: 'ข้อมูลไม่ถูกต้อง' });
      }
      const { errors, clean } = validate(body);
      if (Object.keys(errors).length) return sendJson(res, 422, { ok: false, errors });

      const item = {
        id: crypto.randomUUID(),
        ...clean,
        submittedAt: new Date().toISOString(),
        ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(),
      };
      const saved = await store.insert(item);
      if (!saved.ok && saved.duplicate) {
        return sendJson(res, 409, {
          ok: false,
          errors: { phone: 'เบอร์โทรนี้เคยกรอกแบบสอบถามแล้ว ไม่สามารถกรอกซ้ำได้' },
        });
      }
      return sendJson(res, 200, { ok: true, id: item.id, rating: item.rating });
    }

    // --- เช็กเบอร์ซ้ำแบบ real-time (คืนแค่ true/false ไม่เปิดเผยข้อมูล) ---
    if (req.method === 'GET' && p === '/api/check-phone') {
      const phone = (url.searchParams.get('phone') || '').replace(/\D/g, '');
      if (!/^0\d{9}$/.test(phone)) return sendJson(res, 200, { ok: true, valid: false, exists: false });
      return sendJson(res, 200, { ok: true, valid: true, exists: await store.phoneExists(phone) });
    }

    // --- เข้าสู่ระบบ / ออกจากระบบ ---
    if (req.method === 'POST' && p === '/api/login') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
      if (checkCredentials(body.username, body.password)) {
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req) });
      }
      return sendJson(res, 401, { ok: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    if (req.method === 'POST' && p === '/api/logout') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, { clear: true }) });
    }
    if (req.method === 'GET' && p === '/login') {
      if (isAuthed(req)) return send(res, 302, '', { Location: '/admin' });
      return serveStatic(res, 'login.html');
    }

    // --- พื้นที่ Admin (ต้องล็อกอินทั้งหมด) ---
    if (p === '/admin' || p.startsWith('/api/responses') || p.startsWith('/api/export')) {
      if (!isAuthed(req)) {
        if (p === '/admin') return send(res, 302, '', { Location: '/login' });
        return sendJson(res, 401, { ok: false, message: 'ต้องเข้าสู่ระบบ' });
      }

      if (p === '/admin') return serveStatic(res, 'admin.html');

      if (p === '/api/responses') {
        const all = await store.all(); // เรียงใหม่สุดก่อนอยู่แล้ว
        return sendJson(res, 200, { ok: true, count: all.length, responses: all });
      }

      if (p === '/api/export.csv') {
        const all = (await store.all()).slice().reverse(); // CSV เรียงเก่า -> ใหม่
        return send(res, 200, toCsv(all), {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="survey_responses.csv"',
        });
      }
    }

    // --- หน้าแบบสอบถาม ---
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return serveStatic(res, 'index.html');
    }

    // --- ไฟล์ static อื่น ๆ ---
    if (req.method === 'GET') {
      return serveStatic(res, p.slice(1));
    }

    send(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { ok: false, message: 'เกิดข้อผิดพลาดในระบบ' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ✅ ระบบแบบสอบถามพร้อมใช้งานแล้ว');
  console.log(`  💾 เก็บข้อมูลแบบ: ${store.kind === 'postgres' ? 'PostgreSQL' : 'ไฟล์ JSON (data/responses.json)'}`);
  console.log('  ─────────────────────────────────────────');
  console.log(`  📝 หน้ากรอกแบบสอบถาม : http://localhost:${PORT}/`);
  console.log(`  🔐 หน้า Admin (ดูผู้กรอก): http://localhost:${PORT}/admin`);
  console.log(`     ผู้ใช้: ${ADMIN_USER}   รหัสผ่าน: ${ADMIN_PASS}`);
  console.log('  ─────────────────────────────────────────');
  console.log('  กด Ctrl+C เพื่อหยุดเซิร์ฟเวอร์');
  console.log('');
});
