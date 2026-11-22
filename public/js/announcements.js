// Linely web — announcements: a bell with an unread dot, a slide-up sheet with every announcement, and a floating card for new ones.
import { h } from './lib.js';
import { icon } from './icons.js';
import { addOverlay } from './core.js';

export const ann = { items: [], unread: 0, loaded: false };
const listeners = new Set();
export const onAnnouncements = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => listeners.forEach((f) => f(ann));

export const LEVELS = {
  info: { name: '通知', color: '#0A84FF', glyph: 'i' }, success: { name: '好消息', color: '#16A06A', glyph: '✓' },
  warning: { name: '提醒', color: '#E69A1A', glyph: '!' }, urgent: { name: '重要', color: '#E0405A', glyph: '!!' },
};
export async function loadAnnouncements() {
  try {
    const r = await fetch('/api/announcements', { cache: 'no-store', credentials: 'same-origin' });
    if (r.ok) { const j = await r.json(); ann.items = j.items || []; ann.unread = j.unread || 0; ann.loaded = true; }
  } catch { /* offline */ }
  notify();
}
export async function markRead(ids) {
  const all = ids === 'all', set = new Set(all ? ann.items.map((i) => i.id) : ids);
  ann.items.forEach((i) => { if (set.has(i.id)) i.read = true; });
  ann.unread = ann.items.filter((i) => !i.read).length; notify();
  try { await fetch('/api/announcements/read', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(all ? { all: true } : { ids }) }); } catch { /* retried next load */ }
}

const when = (t) => { const d = new Date(t), now = new Date(), day = 86400000, diff = now - d; return diff < 3600000 ? Math.max(1, Math.round(diff / 60000)) + ' 分钟前' : diff < day ? Math.round(diff / 3600000) + ' 小时前' : diff < 7 * day ? Math.round(diff / day) + ' 天前' : d.toLocaleDateString('zh-CN'); };
/** plain text with line breaks and clickable http(s) links — never raw HTML */
function richText(text) {
  const box = h('div', { class: 'ann-text' });
  String(text || '').split(/(https?:\/\/[^\s<>"']+)/g).forEach((part, i) => {
    if (i % 2) { const a = h('a', { href: part, target: '_blank', rel: 'noopener noreferrer' }, part); box.append(a); } else box.append(document.createTextNode(part));
  });
  return box;
}
const chip = (level) => { const L = LEVELS[level] || LEVELS.info; return h('span', { class: 'ann-chip', style: `--lv:${L.color}`, 'aria-hidden': 'true' }, L.glyph); };

export function openAnnouncements() {
  let closed = false;
  const list = h('div', { class: 'ann-list' });
  const markAll = h('button', { class: 'gpill bounce', onClick: () => markRead('all').then(draw) }, icon('check', 16), '全部已读');
  const closeBtn = h('button', { class: 'gbtn bounce', 'aria-label': '关闭', onClick: () => close() }, icon('close', 20));
  const panel = h('div', { class: 'ann-panel glass s3', role: 'dialog', 'aria-modal': 'true', 'aria-label': '公告' }, h('div', { class: 'ann-head' }, h('h3', null, '公告'), h('div', { class: 'ann-actions' }, markAll, closeBtn)), list);
  const root = h('div', { class: 'ann-sheet', onClick: (e) => { if (e.target === root) close(); } }, panel);
  const remove = addOverlay(root);
  function close() { if (closed) return; closed = true; root.classList.add('out'); setTimeout(remove, 220); off(); }
  function draw() {
    markAll.hidden = !ann.unread;
    list.replaceChildren(...(ann.items.length ? ann.items.map((a) => {
      const L = LEVELS[a.level] || LEVELS.info, long = (a.body || '').length > 90 || (a.body || '').split('\n').length > 3;
      const body = richText(a.body); body.classList.toggle('clamp', long);
      const more = long ? h('button', { class: 'ann-more', onClick: (e) => { e.stopPropagation(); const c = body.classList.toggle('clamp'); more.textContent = c ? '展开' : '收起'; if (!c && !a.read) markRead([a.id]); } }, '展开') : null;
      return h('article', { class: 'ann-card' + (a.read ? '' : ' unread'), style: `--lv:${L.color}`, onClick: () => { if (!a.read) markRead([a.id]); } },
        h('div', { class: 'ann-top' }, chip(a.level), h('div', { class: 'ann-title' }, a.title), !a.read ? h('i', { class: 'ann-dot', 'aria-label': '未读' }) : null),
        h('div', { class: 'ann-meta' }, a.pinned ? h('span', { class: 'ann-pin' }, '置顶') : null, h('span', null, L.name), h('span', null, when(a.createdAt))),
        body, more);
    }) : [h('div', { class: 'ann-empty' }, icon('bell', 34), h('p', null, '暂时没有公告'))]));
  }
  const off = onAnnouncements(() => { if (!closed) draw(); });
  draw();
  loadAnnouncements();
}

/** a floating card for the newest unread announcement; folds into the bell after a few seconds */
let banner = null;
export function showBanner() {
  if (banner) banner.remove(); banner = null;
  const a = ann.items.find((x) => !x.read);
  if (!a) return;
  const L = LEVELS[a.level] || LEVELS.info, more = ann.unread - 1;
  const card = h('aside', { id: 'linely-announcement', class: 'glass s3', style: `--lv:${L.color}`, role: 'status' },
    h('button', { class: 'ann-banner-main', onClick: () => { dismiss(); openAnnouncements(); } }, chip(a.level),
      h('div', { class: 'ann-banner-text' }, h('b', null, a.title), h('span', null, (a.body || '').replace(/\s+/g, ' ').slice(0, 70) || L.name)),
      more > 0 ? h('em', null, `+${more}`) : null),
    h('button', { class: 'ann-x', 'aria-label': '关闭并标为已读', onClick: () => { markRead([a.id]); dismiss(); } }, icon('close', 18)));
  function dismiss() { card.classList.add('out'); setTimeout(() => { card.remove(); if (banner === card) banner = null; }, 260); }
  document.body.append(card); banner = card;
  setTimeout(() => { if (banner === card) dismiss(); }, 12000);
}
export async function initAnnouncements() { await loadAnnouncements(); showBanner(); }
