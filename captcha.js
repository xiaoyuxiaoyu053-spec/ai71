'use strict';
/** Image captcha for registration and login: distorted text rendered as SVG, valid for 5 minutes, single use (even a wrong answer burns it). */
const crypto = require('crypto');

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1 — easy to confuse
const TTL = 5 * 60 * 1000;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const INK = ['#1d3557', '#6a2c70', '#0b6e4f', '#9b2226', '#005f73', '#7b2cbf', '#bb3e03', '#33415c'];
const NOISE = ['#94a3b8', '#a78bfa', '#f59e0b', '#38bdf8', '#fb7185', '#34d399'];

function makeText(n = 5) { let s = ''; for (let i = 0; i < n; i++) s += CHARS[crypto.randomInt(CHARS.length)]; return s; }

function render(text) {
  const W = 160, H = 56, seed = crypto.randomInt(1, 9999);
  let g = '';
  for (let i = 0; i < 6; i++) { // wavy noise strokes behind the text
    g += `<path d="M${rnd(0, 20).toFixed(1)} ${rnd(8, 48).toFixed(1)} C ${rnd(30, 70).toFixed(1)} ${rnd(0, 56).toFixed(1)}, ${rnd(90, 130).toFixed(1)} ${rnd(0, 56).toFixed(1)}, ${rnd(140, 160).toFixed(1)} ${rnd(8, 48).toFixed(1)}" stroke="${pick(NOISE)}" stroke-width="${rnd(1, 2.2).toFixed(1)}" fill="none" opacity=".75"/>`;
  }
  let t = '';
  [...text].forEach((c, i) => {
    const x = 20 + i * 27 + rnd(-3, 3), y = 37 + rnd(-5, 5), r = rnd(-24, 24), sk = rnd(-12, 12), fs = rnd(28, 35);
    t += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${fs.toFixed(0)}" font-weight="700" font-family="Verdana,Arial,Helvetica,sans-serif" fill="${pick(INK)}" text-anchor="middle" transform="rotate(${r.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}) skewX(${sk.toFixed(1)})">${c}</text>`;
  });
  let dots = '';
  for (let i = 0; i < 34; i++) dots += `<circle cx="${rnd(0, W).toFixed(1)}" cy="${rnd(0, H).toFixed(1)}" r="${rnd(0.8, 1.8).toFixed(1)}" fill="${pick(NOISE)}" opacity=".8"/>`;
  let lines = '';
  for (let i = 0; i < 2; i++) lines += `<line x1="${rnd(0, 30).toFixed(1)}" y1="${rnd(6, 50).toFixed(1)}" x2="${rnd(130, 160).toFixed(1)}" y2="${rnd(6, 50).toFixed(1)}" stroke="${pick(INK)}" stroke-width="1.4" opacity=".55"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f7fb"/><stop offset="1" stop-color="#e6ecf5"/></linearGradient>`
    + `<filter id="w" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.018 0.07" numOctaves="2" seed="${seed}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="6"/></filter></defs>`
    + `<rect width="${W}" height="${H}" rx="10" fill="url(#b)"/>${g}<g filter="url(#w)">${t}</g>${lines}${dots}</svg>`;
}

async function create(db) {
  const id = crypto.randomBytes(12).toString('hex'), text = makeText();
  await db.query('INSERT INTO captchas(id,answer,expires_at) VALUES($1,$2,$3)', [id, text, Date.now() + TTL]);
  if (Math.random() < 0.1) await db.query('DELETE FROM captchas WHERE expires_at<$1', [Date.now()]).catch(() => {});
  return { id, image: 'data:image/svg+xml;base64,' + Buffer.from(render(text)).toString('base64') };
}

/** true only for a correct, unexpired answer. The captcha is deleted either way, so each image gets exactly one guess. */
async function verify(db, id, answer) {
  if (!id || typeof id !== 'string' || id.length > 64) return false;
  const r = await db.query('DELETE FROM captchas WHERE id=$1 RETURNING answer,expires_at', [id]);
  const row = r.rows[0];
  if (!row || Number(row.expires_at) < Date.now()) return false;
  return String(answer || '').trim().toUpperCase() === row.answer;
}

module.exports = { create, verify };
