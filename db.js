'use strict';
/**
 * Linely database layer.
 *  - On Render: set DATABASE_URL (render.yaml wires it to the managed PostgreSQL) → uses the `pg` driver.
 *  - Without DATABASE_URL (local dev / quick tests): uses SQLite through Node's built-in `node:sqlite` (file: <DATA_DIR>/linely.db).
 * All SQL below is written in the portable subset both engines understand ($1 placeholders, ON CONFLICT, RETURNING,
 * BIGINT epoch-millisecond timestamps, 0/1 integers for booleans).
 */
const fs = require('fs');
const path = require('path');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_lc TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    banned INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    last_login BIGINT NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    locked_until BIGINT NOT NULL DEFAULT 0,
    free_unlocked_at BIGINT NOT NULL DEFAULT 0,
    free_expires BIGINT NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS captchas (id TEXT PRIMARY KEY, answer TEXT NOT NULL, expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS metrics_day (
    day TEXT PRIMARY KEY,
    visits BIGINT NOT NULL DEFAULT 0,
    api_requests BIGINT NOT NULL DEFAULT 0,
    free_api_requests BIGINT NOT NULL DEFAULT 0,
    user_api_requests BIGINT NOT NULL DEFAULT 0,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens BIGINT NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS redeem_codes (
    code TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    batch_name TEXT NOT NULL DEFAULT '',
    days INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    used_by TEXT,
    used_at BIGINT NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_codes_batch ON redeem_codes(batch_id)`,
  `CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    pinned INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS announcement_reads (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ann_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    read_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, ann_id)
  )`,
  `CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    accent TEXT NOT NULL,
    bubble_color TEXT NOT NULL,
    my_bubble_color TEXT NOT NULL,
    my_text_color TEXT NOT NULL,
    ai_text_color TEXT NOT NULL,
    bubble_style TEXT NOT NULL DEFAULT 'classic',
    bubble_radius INTEGER NOT NULL DEFAULT 18,
    background TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plaza (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    persona TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    likes TEXT NOT NULL DEFAULT '',
    dislikes TEXT NOT NULL DEFAULT '',
    hobbies TEXT NOT NULL DEFAULT '',
    gender TEXT NOT NULL DEFAULT '',
    relationship TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gallery_characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    persona TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gallery_avatars (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES gallery_characters(id) ON DELETE CASCADE,
    author TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_avatars_char ON gallery_avatars(character_id)`,
];

/** "$1, $2" → "?, ?" (SQLite), keeping parameter order even if a placeholder is reused */
function toQuestionMarks(sql, params) {
  const out = [];
  const text = sql.replace(/\$(\d+)/g, (_, n) => { out.push(params[Number(n) - 1]); return '?'; });
  return [text, out];
}

async function open(dataDir) {
  const url = process.env.DATABASE_URL || process.env.LINELY_DATABASE_URL || '';
  if (url) {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => Number(v));   // BIGINT → number
    pg.types.setTypeParser(1700, (v) => Number(v)); // NUMERIC (SUM) → number
    const flag = process.env.LINELY_DB_SSL;
    const needSsl = flag === '1' || (flag !== '0' && (/sslmode=require/i.test(url) || /\.render\.com|neon\.tech|supabase\.(co|com)/i.test(url)));
    const pool = new pg.Pool({ connectionString: url, ssl: needSsl ? { rejectUnauthorized: false } : undefined, max: 10, idleTimeoutMillis: 30000 });
    pool.on('error', (e) => console.error('[db] idle client error:', e.message));
    return {
      type: 'PostgreSQL',
      query: async (sql, params = []) => { const r = await pool.query(sql, params); return { rows: r.rows, rowCount: r.rowCount }; },
      exec: async (sql) => { await pool.query(sql); },
      close: () => pool.end(),
    };
  }
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dataDir, { recursive: true });
  const d = new DatabaseSync(path.join(dataDir, 'linely.db'));
  d.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  return {
    type: 'SQLite',
    query: async (sql, params = []) => {
      const [text, vals] = toQuestionMarks(sql, params);
      const st = d.prepare(text);
      if (/^\s*(select|with|pragma)\b/i.test(text) || /\breturning\b/i.test(text)) { const rows = st.all(...vals.map(norm)); return { rows, rowCount: rows.length }; }
      const r = st.run(...vals.map(norm)); return { rows: [], rowCount: Number(r.changes) };
    },
    exec: async (sql) => { d.exec(sql); },
    close: () => d.close(),
  };
}

const db = {
  type: '', query: null, exec: null, close: null,
  async init({ dataDir }) {
    const impl = await open(dataDir);
    Object.assign(db, impl);
    for (const stmt of SCHEMA) await db.exec(stmt);
    await migrateLegacy(db, dataDir);
    return db;
  },
};

// ───────────── one-time import of the old JSON files (earlier versions kept everything in <DATA_DIR>/*.json) ─────────────
const readJson = (file, fb) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; } };
async function migrateLegacy(d, dir) {
  const done = await d.query('SELECT value FROM settings WHERE key=$1', ['legacy_migrated']);
  if (done.rows.length) return;
  const f = (n) => path.join(dir, n);
  const any = ['users.json', 'themes.json', 'gallery.json', 'persona-plaza.json', 'metrics.json', 'admin-config.json'].some((n) => fs.existsSync(f(n)));
  let counts = {};
  if (any) {
    const users = readJson(f('users.json'), []);
    for (const u of Array.isArray(users) ? users : []) {
      await d.query('INSERT INTO users(id,username,username_lc,salt,hash,banned,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
        [u.id, u.username, String(u.username).toLowerCase(), u.salt, u.hash, u.banned ? 1 : 0, u.createdAt || Date.now()]);
    }
    counts.users = (Array.isArray(users) ? users : []).length;
    const themes = readJson(f('themes.json'), []);
    for (const t of Array.isArray(themes) ? themes : []) {
      await d.query('INSERT INTO themes(id,name,description,author,accent,bubble_color,my_bubble_color,my_text_color,ai_text_color,bubble_style,bubble_radius,background,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING',
        [t.id, t.name, t.description || '', t.author || '', t.accent || '#0A84FF', t.bubbleColor || '#FFFFFF', t.myBubbleColor || '#0A84FF', t.myTextColor || '#243047', t.aiTextColor || '#263247', t.bubbleStyle || 'classic', t.bubbleRadius || 18, t.background || '', t.createdAt || Date.now()]);
    }
    const plaza = readJson(f('persona-plaza.json'), []);
    for (const p of Array.isArray(plaza) ? plaza : []) {
      await d.query('INSERT INTO plaza(id,name,bio,persona,avatar,provider,model,likes,dislikes,hobbies,gender,relationship,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING',
        [p.id, p.name, p.bio || '', p.persona || '', p.avatar || '', p.provider || '', p.model || '', p.likes || '', p.dislikes || '', p.hobbies || '', p.gender || '', p.relationship || '', p.createdAt || Date.now()]);
    }
    const gallery = readJson(f('gallery.json'), []);
    for (const c of Array.isArray(gallery) ? gallery : []) {
      await d.query('INSERT INTO gallery_characters(id,name,bio,persona,author,author_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [c.id, c.name, c.bio || '', c.persona || '', c.author || '', c.authorId || '', c.createdAt || Date.now()]);
      for (const a of c.avatars || []) await d.query('INSERT INTO gallery_avatars(id,character_id,author,author_id,image,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [a.id, c.id, a.author || '', a.authorId || '', a.image, a.note || '', a.createdAt || Date.now()]);
    }
    const m = readJson(f('metrics.json'), null);
    if (m && m.byDay) {
      for (const [day, v] of Object.entries(m.byDay)) {
        await d.query('INSERT INTO metrics_day(day,visits,api_requests,free_api_requests,user_api_requests,input_tokens,output_tokens,total_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
          [day, v.visits || 0, v.apiRequests || 0, v.freeApiRequests || 0, v.userApiRequests || 0, v.inputTokens || 0, v.outputTokens || 0, v.totalTokens || 0]);
      }
    }
    const cfg = readJson(f('admin-config.json'), null);
    if (cfg) {
      if (cfg.freeApi) await d.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['freeApi', JSON.stringify(cfg.freeApi)]);
      const a = cfg.announcement;
      if (a && a.enabled && (a.title || a.body)) {
        const now = Date.now();
        await d.query('INSERT INTO announcements(id,title,body,level,pinned,published,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING', [require('crypto').randomUUID(), a.title || '网站公告', a.body || '', 'info', 1, 1, a.updatedAt || now, a.updatedAt || now]);
      }
    }
    if (counts.users !== undefined) console.log(`[db] imported legacy JSON data (${counts.users} users) into ${d.type}`);
  }
  await d.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['legacy_migrated', String(Date.now())]);
}

module.exports = db;
