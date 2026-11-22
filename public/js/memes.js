// Linely web — 表情库: Chinese meme images the AI can search online and send, plus the pictures you send
// (collected automatically so the AI can reuse them). Images come through the server's /api/meme proxy.
import { h, uid } from './lib.js';
import { icon } from './icons.js';
import { get, set, touch, toast, mediaUrl, addMediaDataUrl } from './state.js';
import { registerView, goBack, menu, modal, switchEl, field } from './core.js';

const CAP = 120;
export const collection = () => get('memeCollection') || [];
const sentRecently = new Set();

/** add an image (media ref) to the collection; returns the entry, or null when disabled / duplicate */
export function collectImage(ref, { label = '', source = 'user', gif = false, force = false } = {}) {
  if (!ref || (!force && !get('memeCollectEnabled'))) return null;
  const list = collection();
  if (list.some((x) => x.ref === ref)) return null;
  const item = { id: uid(), ref, label: String(label).replace(/\[\[[^\]]*\]\]/g, '').trim().slice(0, 30), gif: !!gif, source, time: Date.now() };
  const next = [...list, item];
  while (next.length > CAP) { const i = next.findIndex((x) => x.source !== 'manual'); next.splice(i < 0 ? 0 : i, 1); }
  set('memeCollection', next);
  return item;
}
/** pull images out of a chat message the user just sent: "caption [[IMAGE:ref]]" / "[[GIF:ref]]" */
export function collectFromMessage(msg) {
  const m = /\[\[(IMAGE|GIF):([\s\S]*?)\]\]/.exec(msg || ''); if (!m) return;
  const caption = (msg.slice(0, m.index) + msg.slice(m.index + m[0].length)).replace(/^【GIF表情包】[^\n]*\n?/, '').trim();
  collectImage(m[2], { label: caption, source: 'user', gif: m[1] === 'GIF' });
}

// ───────────── network search ─────────────
export async function searchMemes(q, gif = false) {
  const r = await fetch(`/api/meme/search?q=${encodeURIComponent(q)}${gif ? '&gif=1' : ''}`, { credentials: 'same-origin', cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || '搜索失败');
  if (j.enabled === false) throw new Error('管理员已关闭表情包搜索');
  return j.items || [];
}
const proxy = (u) => '/api/meme/img?u=' + encodeURIComponent(u);
/** download through the proxy; static images are shrunk to ≤512px, GIFs are kept (≤2.5 MB) so they still move */
export async function downloadMeme(url) {
  const r = await fetch(proxy(url), { credentials: 'same-origin' });
  if (!r.ok) throw new Error('图片无法下载');
  const blob = await r.blob(), isGif = blob.type === 'image/gif';
  if (isGif) {
    if (blob.size > 2.5 * 1024 * 1024) throw new Error('动图太大');
    return { dataUrl: await new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(blob); }), gif: true };
  }
  const bmp = await createImageBitmap(blob), k = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  if (bmp.width < 40 || bmp.height < 40) throw new Error('图片太小');
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL(blob.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.86), gif: false };
}
/** search + download the first image that works; used when the AI writes [[MEME:关键词]] */
export async function fetchAndStoreMeme(query) {
  const gifFirst = /动图|gif/i.test(query);
  let items = await searchMemes(query.replace(/动图|gif/gi, '').trim() || query, gifFirst);
  items = items.filter((i) => !sentRecently.has(i.url));
  const pool = items.slice(0, 10).sort(() => Math.random() - 0.5).slice(0, 5);
  for (const it of pool) {
    try {
      const { dataUrl, gif } = await downloadMeme(it.url);
      sentRecently.add(it.url); if (sentRecently.size > 60) sentRecently.delete(sentRecently.values().next().value);
      return { ref: await addMediaDataUrl(dataUrl), gif, label: it.title || query };
    } catch { /* try next */ }
  }
  throw new Error('没有找到合适的表情包');
}

// ───────────── what the AI is told ─────────────
export function memeSystemNote() {
  if (!get('memeSearchEnabled')) return '';
  const mine = collection().slice(-20);
  const list = mine.length ? ` 用户收藏的表情包（可用 [[MYMEME:编号]] 发送）：${mine.map((m, i) => `${i + 1}.${m.label || '图片'}`).join('；')}。` : '';
  return ` 你可以偶尔发送网络上的中文表情包/梗图来增强聊天氛围：需要时在回复里单独写一个标记 [[MEME:搜索关键词]]，关键词用中文且贴合情绪与梗（例如 [[MEME:无语 熊猫头]]、[[MEME:笑死 哈哈哈]]、[[MEME:晚安 可爱]]，想要动图就加"动图"二字）。每条回复最多一个，大约每 5 条消息才发一次，只在情绪合适时发，不要连续发；标记前后照常写你要说的话，不要解释标记。${list}`;
}
export function parseMemeTokens(reply) {
  const searches = [], mine = [];
  const clean = String(reply || '').replace(/\[\[MEME:([^\]]{1,40})\]\]/g, (_, q) => { searches.push(q.trim()); return ''; })
    .replace(/\[\[MYMEME:(\d{1,3})\]\]/g, (_, n) => { mine.push(Number(n)); return ''; }).trim();
  return { clean, searches: searches.slice(0, 1), mine: mine.slice(0, 1) };
}
export function pickMine(n) { const list = collection().slice(-20); return list[n - 1] || null; }

// ───────────── library page ─────────────
function memesView() {
  let results = null, q = '', gif = false, busy = false;
  const root = h('div', { class: 'screen memes' });
  const back = h('button', { class: 'circle-btn glass s2 bounce', 'aria-label': '返回', onClick: () => goBack() }, icon('left', 24));
  const header = h('div', { class: 'lt-header', style: 'display:flex;align-items:center;gap:12px;padding-bottom:8px' }, back, h('h2', { style: 'margin:0;font-size:20px;color:var(--wall-ink)' }, '表情库'));
  const pad = h('div', { class: 'pad', style: 'padding-top:4px' });
  root.append(header, h('div', { class: 'scroll' }, pad));
  const resultBox = h('div'), gridBox = h('div');

  async function doSearch() {
    if (!q.trim() || busy) return; busy = true; resultBox.replaceChildren(h('div', { class: 'hint', style: 'text-align:center;padding:16px' }, '搜索中…'));
    try { results = await searchMemes(q.trim(), gif); } catch (e) { results = []; toast(e.message); }
    busy = false; drawResults();
  }
  function drawResults() {
    if (results === null) { resultBox.replaceChildren(); return; }
    resultBox.replaceChildren(results.length ? h('div', { class: 'meme-grid' }, ...results.map((it) => {
      const im = h('img', { alt: it.title || '', loading: 'lazy', draggable: 'false' }); im.src = proxy(it.thumb || it.url);
      return h('button', { class: 'meme-cell bounce', 'aria-label': '收藏：' + (it.title || ''), onClick: async (e) => {
        const el = e.currentTarget; el.classList.add('busy');
        try { const { dataUrl, gif: g } = await downloadMeme(it.url); const ref = await addMediaDataUrl(dataUrl); collectImage(ref, { label: it.title || q, source: 'manual', gif: g, force: true }); toast('已收藏'); drawGrid(); }
        catch (x) { toast(x.message || '收藏失败'); } el.classList.remove('busy');
      } }, im);
    })) : h('div', { class: 'hint', style: 'text-align:center;padding:16px' }, '没有搜到结果，换个关键词试试（国内外网络环境可能影响搜索）'));
  }
  function drawGrid() {
    const list = collection().slice().reverse();
    gridBox.replaceChildren(h('div', { class: 'secttl' }, `我的收藏 · ${list.length}`), list.length ? h('div', { class: 'meme-grid' }, ...list.map((m) => {
      const im = h('img', { alt: m.label || '表情', loading: 'lazy', draggable: 'false' }); im.src = mediaUrl(m.ref);
      return h('button', { class: 'meme-cell bounce', onClick: (e) => menu(e.currentTarget, [
        { label: '重命名', onClick: () => rename(m) },
        { label: '放大查看', onClick: () => modal({ title: m.label || '表情', body: [h('div', { class: 'gal-big', style: 'width:min(260px,80%)' }, (() => { const i = h('img', { alt: '' }); i.src = mediaUrl(m.ref); i.style.objectFit = 'contain'; return i; })())], actions: [{ label: '关闭', kind: 'p' }] }) },
        { label: '删除', danger: true, onClick: () => { set('memeCollection', collection().filter((x) => x.id !== m.id)); drawGrid(); } }]) },
        im, m.label ? h('span', null, m.label) : null, m.source === 'user' ? h('i', { class: 'tag' }, '我发的') : m.gif ? h('i', { class: 'tag' }, 'GIF') : null);
    })) : h('div', { class: 'hint', style: 'text-align:center;padding:18px' }, '这里会收藏你发给 AI 的图片，你也可以在上面搜索并收藏喜欢的表情包。'));
  }
  function rename(m) {
    const inp = h('input', { type: 'text', value: m.label || '', maxlength: '30', placeholder: '给它起个名字，AI 会据此挑选', autocomplete: 'off' });
    modal({ title: '重命名', body: [field('名称', inp)], actions: [{ label: '取消' }, { label: '保存', kind: 'p', onClick: () => { m.label = inp.value.trim(); touch(); drawGrid(); } }] });
  }
  const search = h('input', { type: 'search', placeholder: '搜索中文表情包，例如：无语 熊猫头', autocomplete: 'off', 'aria-label': '搜索表情包' });
  search.addEventListener('input', () => { q = search.value; });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  const toggles = h('div', { class: 'glass s2', style: 'border-radius:24px;padding:6px 16px;margin-bottom:12px' },
    h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', null, '允许 AI 搜索网络表情包'), h('small', null, '聊天时 AI 会偶尔发中文梗图')), switchEl(!!get('memeSearchEnabled'), (v) => set('memeSearchEnabled', v))),
    h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', null, '自动收藏我发的图片'), h('small', null, 'AI 之后可以把它们当表情包再发给你')), switchEl(!!get('memeCollectEnabled'), (v) => set('memeCollectEnabled', v))));
  pad.append(toggles,
    h('div', { style: 'display:flex;gap:8px;margin-bottom:6px' }, h('div', { style: 'flex:1' }, search), h('button', { class: 'gpill bounce on', onClick: doSearch }, icon('search', 16), '搜索')),
    h('div', { class: 'setting', style: 'padding:4px 2px' }, h('div', { class: 't' }, h('small', { style: 'font-size:13px' }, '只找动图（GIF）')), switchEl(false, (v) => { gif = v; })),
    resultBox, gridBox);
  drawGrid();
  return { el: root, update: drawGrid };
}
registerView('memes', memesView);
