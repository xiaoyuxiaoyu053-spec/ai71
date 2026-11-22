// Linely web — 主题 = 气泡工坊. Pick a preset bubble style or build your own: shape, border, texture,
// plus decorations you add (emoji / images) or draw by hand and drag into place on a live preview.
import { h, prepareImage, uid } from './lib.js';
import { icon } from './icons.js';
import { S, get, touch, toast, mediaUrl, addMediaDataUrl } from './state.js';
import { registerView, fillTabbar, openTab, btn, switchEl, modal, pickFile } from './core.js';
import { BUBBLE_STYLES, STYLE_IDS, ANCHORS, PATTERNS, SHADOWS, validStyle, bubbleVars, bubbleEl, themeCfg, customList, newDesign, findDesign } from './bubbles.js';

const DEFAULT_WALL = 'linear-gradient(180deg,#f3f5f8 0%,#d3d9e0 38%,#edeff3 68%,#c5cdd5 100%)';
const cssUrl = (u) => 'url("' + String(u).replace(/["\\\n\r]/g, '') + '")';
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : d);
const clone = (o) => JSON.parse(JSON.stringify(o));
const EMOJI = '🐰 🐱 🐻 🐼 🦊 🐶 🦋 🐣 🎀 ⭐ 🌟 ✨ 💖 💗 💫 🌸 🌷 🌈 ☁️ 🌙 ☀️ 🍓 🍒 🍑 🍰 🧁 🍭 🐾 🫧 🧸 👑 🔥 ❄️ 🍀 🪽 💎 🎵 🎧 💌 🩷 🩵 💜 🖤 😊 🥰 😎 🤍'.split(' ');
const SWATCH = ['#1B1B1F', '#FF5C8A', '#FF9F43', '#FFD43B', '#34C759', '#32ADE6', '#7B61FF', '#FFFFFF'];

let D = null; // working draft; survives tab switches until applied

function currentDraft() {
  const c = themeCfg();
  return { name: '', desc: '', style: c.style, design: c.design ? clone(c.design) : null, sel: '', accent: get('theme'), sent: c.sent, recv: c.recv, sentText: c.sentText, recvText: c.recvText, radius: c.radius, wall: !!get('themeWall'), bg: '', removeBg: false, dirty: false };
}
const cfgOf = (d) => ({ style: d.style, design: d.design || null, sent: d.sent, recv: d.recv, sentText: d.sentText, recvText: d.recvText, radius: d.radius });
const draftBg = () => (D.removeBg ? '' : D.bg || mediaUrl(get('background')));
const wallFor = (style, wallOn, bg) => {
  const tint = BUBBLE_STYLES[style] && BUBBLE_STYLES[style].wall;
  return bg ? `linear-gradient(#ffffff14,#ffffff14),${cssUrl(bg)} center/cover` : wallOn && tint ? tint : DEFAULT_WALL;
};

/** Real chat rows (the same classes the chat page uses) so the preview is exact. */
function sample(cfg, rows) {
  const root = h('div', { class: 'chat tp-chat' });
  bubbleVars(root, cfg);
  rows.forEach(([out, text, run, tail]) => root.append(h('div', { class: `mrow ${out ? 'out' : 'in'}${run ? ' start run' : ''}` }, h('div', { class: 'mline' }, bubbleEl(text, out, tail, '', cfg.design || null)))));
  return root;
}
async function stickerFromFile(f) {
  const bmp = await createImageBitmap(f), k = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

// ───────────── hand-drawing dialog ─────────────
function drawDialog(onDone) {
  const W = 600, H = 480, canvas = h('canvas', { width: W, height: H, class: 'draw-canvas', 'aria-label': '绘图画布' });
  const ctx = canvas.getContext('2d');
  let color = SWATCH[1], size = 10, erase = false, drawing = false, last = null; const undo = [];
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]; };
  const snap = () => { undo.push(ctx.getImageData(0, 0, W, H)); if (undo.length > 25) undo.shift(); };
  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); snap(); drawing = true; last = pos(e); stroke(last, last); });
  canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); stroke(last, p); last = p; });
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  function stroke(a, b) {
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0] + 0.01, b[1]); ctx.stroke();
  }
  const sw = h('div', { class: 'swatches' });
  const drawSw = () => sw.replaceChildren(...SWATCH.map((c) => h('button', { class: 'sw' + (c === color && !erase ? ' on' : ''), style: `background:${c}`, 'aria-label': c, onClick: () => { color = c; erase = false; drawSw(); drawTool(); } })));
  const picker = h('input', { type: 'color', value: color, 'aria-label': '自定义颜色' });
  picker.addEventListener('input', () => { color = picker.value; erase = false; drawSw(); drawTool(); });
  const sizeIn = h('input', { type: 'range', class: 'slider', min: 2, max: 40, value: size, 'aria-label': '笔刷粗细' });
  sizeIn.addEventListener('input', () => { size = Number(sizeIn.value); });
  const tools = h('div', { class: 'draw-tools' });
  const drawTool = () => tools.replaceChildren(
    h('button', { class: 'gpill bounce' + (!erase ? ' on' : ''), onClick: () => { erase = false; drawTool(); drawSw(); } }, icon('brush', 16), '画笔'),
    h('button', { class: 'gpill bounce' + (erase ? ' on' : ''), onClick: () => { erase = true; drawTool(); drawSw(); } }, icon('eraser', 16), '橡皮'),
    h('button', { class: 'gpill bounce', onClick: () => { const s = undo.pop(); if (s) ctx.putImageData(s, 0, 0); } }, icon('undo', 16), '撤销'),
    h('button', { class: 'gpill bounce danger', onClick: () => { snap(); ctx.clearRect(0, 0, W, H); } }, '清空'));
  drawSw(); drawTool();
  modal({
    title: '手绘装饰', body: [h('div', { class: 'hint', style: 'margin:0 0 8px' }, '随便画点什么：耳朵、蝴蝶结、星星……完成后会自动裁剪，并可在预览里拖动位置。'), h('div', { class: 'canvas-wrap' }, canvas), sw, h('div', { class: 'draw-row' }, picker, sizeIn), tools],
    actions: [{ label: '取消' }, { label: '完成', kind: 'p', onClick: () => {
      const data = ctx.getImageData(0, 0, W, H).data; let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) { toast('还没有画任何内容'); return false; }
      const w = x1 - x0 + 1, hh = y1 - y0 + 1, k = Math.min(1, 240 / Math.max(w, hh)), out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(w * k)); out.height = Math.max(1, Math.round(hh * k));
      out.getContext('2d').drawImage(canvas, x0, y0, w, hh, 0, 0, out.width, out.height);
      onDone(out.toDataURL('image/png'));
    } }],
  });
}

function themesView() {
  if (!D || !D.dirty) D = currentDraft();
  const inputs = {};
  const root = h('div', { class: 'screen themes' });
  const header = h('div', { class: 'lt-header' }, h('div', { class: 'lt-top' }, h('span'), h('span')), h('h1', { class: 'lt-title' }, '主题'));
  const previewBox = h('div', { class: 'tp-wall' });
  const content = h('div', { class: 'scroll' });
  const tabbar = h('div', { class: 'tabbar glass s2' });
  const pad = h('div', { class: 'pad', style: 'padding-top:4px' });
  content.append(pad);
  root.append(header, h('div', { class: 'tp-stage' }, previewBox), content, tabbar);

  const seg = (map, selected, onPick) => { const w = h('div', { class: 'chips' }); const draw = (s) => w.replaceChildren(...Object.entries(map).map(([k, v]) => h('button', { class: 'ch bounce' + (k === s ? ' on' : ''), onClick: () => { onPick(k); draw(k); } }, Array.isArray(v) ? v[0] : v))); draw(selected); return w; };
  const range = (min, max, value, onInput, label) => { const i = h('input', { type: 'range', class: 'slider', min, max, step: 1, value, 'aria-label': label }); i.addEventListener('input', () => onInput(Number(i.value))); return i; };
  const sel = () => (D.design && D.design.items.find((x) => x.id === D.sel)) || null;
  const changed = () => { D.dirty = true; drawPreview(); };

  // ── preview (items can be dragged) ──
  function drawPreview() {
    previewBox.style.background = wallFor(D.style, D.wall, draftBg());
    const p = sample(cfgOf(D), [[false, '早安～今天想聊点什么？', true, false], [false, '我准备了新的气泡样式 ✨', false, true], [true, '好呀，看看效果！', true, true]]);
    previewBox.replaceChildren(p);
    if (!D.design) return;
    p.querySelectorAll('.bdecor').forEach((el) => {
      el.classList.toggle('sel', el.dataset.id === D.sel);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const it = D.design.items.find((x) => x.id === el.dataset.id); if (!it) return;
        const wasSel = D.sel; D.sel = it.id; const mir = el.dataset.out ? -1 : 1, sx = e.clientX, sy = e.clientY, ox = it.dx || 0, oy = it.dy || 0; let moved = false;
        const mv = (ev) => { moved = true; it.dx = Math.max(-90, Math.min(90, Math.round(ox + (ev.clientX - sx) * mir))); it.dy = Math.max(-90, Math.min(90, Math.round(oy + (ev.clientY - sy)))); changed(); };
        const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (moved || wasSel !== it.id) drawWorkshop(); };
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
      });
    });
  }

  // ── style cards (presets + my own) ──
  const grid = h('div', { class: 'style-grid' });
  const mine = h('div', { class: 'style-grid' });
  const miniCard = (id, name, desc, cfg, on, onClick, wall) => {
    const wrap = h('div', { class: 'style-mini' }, sample(cfg, [[false, '嗨～', true, true], [true, '好呀', true, true]]));
    wrap.style.background = wall;
    return h('button', { class: 'style-card bounce soft' + (on ? ' on' : ''), 'aria-pressed': String(on), onClick }, wrap, h('b', null, name), h('small', null, desc));
  };
  function drawStyles() {
    grid.replaceChildren(...STYLE_IDS.map((id) => {
      const st = BUBBLE_STYLES[id], p = st.palette;
      return miniCard(id, st.name, st.desc, { style: id, design: null, sent: p.myBubbleColor, recv: p.bubbleColor, sentText: p.myTextColor, recvText: p.aiTextColor, radius: 18 }, D.style === id, () => pickStyle(id), wallFor(id, true, ''));
    }));
    mine.replaceChildren(...customList().map((d) => miniCard('c:' + d.id, d.name, '自定义 · ' + d.items.length + ' 个装饰', { ...cfgOf(D), style: 'c:' + d.id, design: d }, D.style === 'c:' + d.id, () => pickCustom(d), DEFAULT_WALL)),
      h('button', { class: 'style-card new bounce soft', onClick: createCustom }, h('div', { class: 'plus-tile' }, icon('add', 34)), h('b', null, '新建气泡'), h('small', null, '画一个、加表情、自由组合')));
  }
  function pickStyle(id) {
    const p = BUBBLE_STYLES[id].palette;
    Object.assign(D, { style: id, design: null, sel: '', accent: p.accent, sent: p.myBubbleColor, recv: p.bubbleColor, sentText: p.myTextColor, recvText: p.aiTextColor, wall: true, dirty: true });
    syncInputs(); drawStyles(); drawWorkshop(); drawPreview();
  }
  function pickCustom(d) { Object.assign(D, { style: 'c:' + d.id, design: clone(d), sel: '', dirty: true }); drawStyles(); drawWorkshop(); drawPreview(); }
  function createCustom() { const d = newDesign('我的气泡 ' + (customList().length + 1)); Object.assign(D, { style: 'c:' + d.id, design: d, sel: '', dirty: true }); drawStyles(); drawWorkshop(); drawPreview(); toast('从下面的「气泡工坊」开始装饰吧'); }

  // ── bubble workshop ──
  const workshop = h('div');
  function addItem(it) { const d = D.design; const item = { id: uid(), kind: 'emoji', a: 'ts', dx: 14, dy: 6, size: 28, rot: -10, scope: 'run', behind: false, mirror: true, ...it }; d.items.push(item); D.sel = item.id; changed(); drawWorkshop(); drawStyles(); }
  function emojiDialog() {
    const own = h('input', { type: 'text', placeholder: '或输入任意表情 / 文字', maxlength: '4', autocomplete: 'off' });
    const dlg = modal({ title: '添加表情', body: [h('div', { class: 'emoji-grid' }, ...EMOJI.map((e) => h('button', { class: 'bounce', onClick: () => { addItem({ kind: 'emoji', v: e }); dlg.close(); } }, e))), own], actions: [{ label: '取消' }, { label: '添加', kind: 'p', onClick: () => { const v = own.value.trim(); if (!v) { toast('先选一个表情，或输入内容'); return false; } addItem({ kind: 'emoji', v }); } }] });
  }
  function drawWorkshop() {
    const d = D.design;
    if (!d) { workshop.replaceChildren(h('div', { class: 'hint', style: 'padding:6px 2px' }, '选择「我的气泡」里的一个，或点「新建气泡」，就能在这里画图、加表情、调形状。')); return; }
    const it = sel();
    const nameIn = h('input', { type: 'text', value: d.name, maxlength: '20', placeholder: '气泡名称', autocomplete: 'off' });
    nameIn.addEventListener('input', () => { d.name = nameIn.value; D.dirty = true; });
    const borderColor = h('input', { type: 'color', value: hex(d.borderColor, '#1B1B1F'), 'aria-label': '边框颜色' });
    borderColor.addEventListener('input', () => { d.borderColor = borderColor.value.toUpperCase(); changed(); });
    const thumbs = h('div', { class: 'item-strip' }, ...d.items.map((x) => h('button', { class: 'ithumb bounce' + (x.id === D.sel ? ' on' : ''), 'aria-label': '选择装饰', onClick: () => { D.sel = x.id; drawWorkshop(); drawPreview(); } }, x.kind === 'img' ? h('img', { src: x.v, alt: '' }) : h('span', null, x.v))), d.items.length ? null : h('small', { class: 'hint', style: 'margin:0' }, '还没有装饰，试试下面的按钮'));
    const itemBox = it ? h('div', { class: 'item-box' },
      h('div', { class: 'hint', style: 'margin:0 0 6px' }, '也可以直接在上方预览里拖动它'),
      h('b', { class: 'lbl' }, '位置'), seg(Object.fromEntries(Object.entries(ANCHORS).map(([k, v]) => [k, v[0]])), it.a, (k) => { it.a = k; it.dx = 0; it.dy = 0; changed(); }),
      h('b', { class: 'lbl' }, '大小'), range(12, 120, it.size, (v) => { it.size = v; changed(); }, '大小'),
      h('b', { class: 'lbl' }, '旋转'), range(-180, 180, it.rot, (v) => { it.rot = v; changed(); }, '旋转'),
      h('b', { class: 'lbl' }, '微调 水平 / 垂直'), range(-90, 90, it.dx, (v) => { it.dx = v; changed(); }, '水平'), range(-90, 90, it.dy, (v) => { it.dy = v; changed(); }, '垂直'),
      h('b', { class: 'lbl' }, '出现在'), seg({ run: '每段第一个', last: '每段最后一个', all: '每个气泡' }, it.scope, (k) => { it.scope = k; changed(); }),
      h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', null, '放在气泡后面'), h('small', null, '像耳朵一样从气泡后探出来')), switchEl(!!it.behind, (v) => { it.behind = v; changed(); })),
      h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', null, '发送方镜像'), h('small', null, '我发的气泡左右翻转，更对称')), switchEl(it.mirror !== false, (v) => { it.mirror = v; changed(); })),
      h('div', { class: 'row-btns' }, btn('复制', () => { const c = { ...clone(it), id: uid(), dx: (it.dx || 0) + 14 }; d.items.push(c); D.sel = c.id; changed(); drawWorkshop(); drawStyles(); }, 'inline', 'copy'), btn('删除', () => { d.items = d.items.filter((x) => x !== it); D.sel = ''; changed(); drawWorkshop(); drawStyles(); }, 'danger inline', 'del'))) : null;
    workshop.replaceChildren(
      h('label', { class: 'fld' }, h('span', null, '气泡名称'), nameIn),
      h('b', { class: 'lbl' }, '形状'), range(6, 32, d.radius, (v) => { d.radius = v; changed(); }, '圆角'),
      h('div', { class: 'colorrow' }, h('span', null, '边框', h('div', { class: 'hint', style: 'margin:0' }, '粗细 0 = 无边框')), borderColor),
      range(0, 6, d.borderW, (v) => { d.borderW = v; changed(); }, '边框粗细'),
      h('b', { class: 'lbl' }, '阴影'), seg(SHADOWS, d.shadow, (k) => { d.shadow = k; changed(); }),
      h('b', { class: 'lbl' }, '纹理'), seg(PATTERNS, d.pattern, (k) => { d.pattern = k; changed(); }),
      h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', null, '小尾巴'), h('small', null, 'iMessage 风格的气泡尾巴')), switchEl(!!d.tail, (v) => { d.tail = v; changed(); })),
      h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', null, '加粗文字')), switchEl(!!d.bold, (v) => { d.bold = v; changed(); })),
      h('b', { class: 'lbl' }, `装饰 · ${d.items.length}`),
      h('div', { class: 'row-btns' }, btn('表情', emojiDialog, 'inline', 'sticker'), btn('图片', () => pickFile('image/*', async (f) => { try { addItem({ kind: 'img', v: await stickerFromFile(f), size: 56, rot: 0 }); } catch (e) { toast('无法读取图片'); } }), 'inline', 'image'), btn('手绘', () => drawDialog((url) => addItem({ kind: 'img', v: url, size: 56, rot: 0 })), 'inline', 'brush')),
      thumbs, itemBox);
  }

  // ── colours ──
  const colorRow = (label, key, hint) => {
    const inp = h('input', { type: 'color', value: hex(D[key], '#ffffff'), 'aria-label': label });
    inp.addEventListener('input', () => { D[key] = inp.value.toUpperCase(); changed(); if (key === 'accent') document.documentElement.style.setProperty('--accent', D.accent); });
    inputs[key] = inp;
    return h('div', { class: 'colorrow' }, h('span', null, label, hint ? h('div', { class: 'hint', style: 'margin:0' }, hint) : null), inp);
  };
  const radiusLab = h('b', { style: 'font-size:15px' }), radius = h('input', { type: 'range', class: 'slider', min: 8, max: 30, step: 1 });
  radius.addEventListener('input', () => { D.radius = Number(radius.value); radiusLab.textContent = '预设气泡圆角 ' + D.radius; changed(); });
  const wallSwitch = h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', null, '氛围背景'), h('small', null, '页面底色跟随气泡样式（有背景图时不生效）')), switchEl(D.wall, (v) => { D.wall = v; changed(); }));
  const bgRow = h('div');
  function drawBgRow() {
    const has = !!draftBg();
    bgRow.replaceChildren(
      btn(has ? '更换背景图' : '选择背景图', () => pickFile('image/*', async (f) => { try { D.bg = await prepareImage(f, 1200); D.removeBg = false; changed(); drawBgRow(); } catch (e) { toast(e.message || '无法读取图片'); } }), '', 'image'),
      has ? btn('移除背景图', () => { D.bg = ''; D.removeBg = true; changed(); drawBgRow(); }, '', 'close') : null);
  }
  function syncInputs() {
    for (const k of ['accent', 'sent', 'recv', 'sentText', 'recvText']) if (inputs[k]) inputs[k].value = hex(D[k], '#ffffff');
    radius.value = D.radius; radiusLab.textContent = '预设气泡圆角 ' + D.radius;
    document.documentElement.style.setProperty('--accent', D.accent);
  }

  // ── save / publish ──
  const nameIn = h('input', { type: 'text', placeholder: '给主题起个名字', maxlength: '50', autocomplete: 'off', value: D.name });
  const descIn = h('input', { type: 'text', placeholder: '一句话介绍（选填）', maxlength: '200', autocomplete: 'off', value: D.desc });
  nameIn.addEventListener('input', () => { D.name = nameIn.value; });
  descIn.addEventListener('input', () => { D.desc = descIn.value; });
  function saveDesign() {
    if (!D.design) return;
    const list = customList().slice(), i = list.findIndex((x) => x.id === D.design.id), d = clone(D.design);
    if (i >= 0) list[i] = d; else list.push(d);
    S.data.customBubbles = list;
  }
  async function apply() {
    if (D.bg) { S.data.background = await addMediaDataUrl(D.bg); D.bg = ''; }
    else if (D.removeBg) S.data.background = '';
    D.removeBg = false; saveDesign();
    Object.assign(S.data, { theme: D.accent.toUpperCase(), bubbleStyle: D.style, myBubbleColor: D.sent.toUpperCase(), bubbleColor: D.recv.toUpperCase(), myTextColor: D.sentText.toUpperCase(), aiTextColor: D.recvText.toUpperCase(), bubbleRadius: D.radius, themeWall: D.wall });
    D.dirty = false; touch(); drawBgRow(); drawStyles();
    toast('已应用到聊天、群聊和一起听');
  }
  function saveOnly() { if (!D.design) return toast('预设样式无需保存；先新建一个自己的气泡'); saveDesign(); touch(); drawStyles(); toast('已保存到「我的气泡」'); }
  function deleteDesign() {
    if (!D.design) return;
    const id = D.design.id; S.data.customBubbles = customList().filter((x) => x.id !== id);
    if (get('bubbleStyle') === 'c:' + id) S.data.bubbleStyle = 'classic';
    pickStyle('classic'); touch(); toast('已删除这个气泡');
  }
  async function publish() {
    if (D.design) return toast('自定义气泡暂不支持发布到广场，可以先发布预设样式');
    const name = D.name.trim();
    if (!name) { toast('请先填写主题名称'); nameIn.focus(); return; }
    const body = { name, description: D.desc.trim(), accent: D.accent, bubbleColor: D.recv, myBubbleColor: D.sent, myTextColor: D.sentText, aiTextColor: D.recvText, bubbleStyle: D.style, bubbleRadius: D.radius };
    const bg = draftBg();
    if (bg && bg.startsWith('data:image/')) { if (bg.length < 480000) body.background = bg; else toast('背景图较大，发布时已省略（需小于约 350KB）'); }
    try {
      const r = await fetch('/api/themes', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(j.error || '发布失败'); return; }
      toast('已发布到主题广场'); loadPlaza();
    } catch (e) { toast('发布失败：' + e.message); }
  }
  function resetDefault() { pickStyle('classic'); D.name = ''; D.desc = ''; nameIn.value = ''; descIn.value = ''; D.bg = ''; D.removeBg = !!get('background'); drawBgRow(); drawPreview(); }

  // ── plaza ──
  const plaza = h('div', { class: 'plaza' });
  function useTheme(t) {
    const style = validStyle(t.bubbleStyle);
    Object.assign(D, { name: t.name || '', desc: t.description || '', style, design: null, sel: '', accent: hex(t.accent, '#0A84FF'), sent: hex(t.myBubbleColor, '#0A84FF'), recv: hex(t.bubbleColor, '#FFFFFF'), sentText: hex(t.myTextColor, '#243047'), recvText: hex(t.aiTextColor, '#263247'), radius: Number(t.bubbleRadius) || 18, wall: !t.background, bg: t.background && String(t.background).startsWith('data:image/') ? t.background : '', removeBg: !t.background && !!get('background'), dirty: true });
    nameIn.value = D.name; descIn.value = D.desc; syncInputs(); drawStyles(); drawWorkshop(); drawBgRow(); drawPreview();
    content.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function loadPlaza() {
    plaza.replaceChildren(h('div', { class: 'hint', style: 'text-align:center;padding:12px 0' }, '加载中…'));
    try {
      const r = await fetch('/api/themes', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('无法读取主题');
      const list = await r.json();
      if (!list.length) { plaza.replaceChildren(h('div', { class: 'hint', style: 'text-align:center;padding:12px 0' }, '还没有人分享主题，来发布第一个吧！')); return; }
      plaza.replaceChildren(...list.map((t) => {
        const cfg = { style: validStyle(t.bubbleStyle), design: null, sent: hex(t.myBubbleColor, '#0A84FF'), recv: hex(t.bubbleColor, '#FFFFFF'), sentText: hex(t.myTextColor, '#243047'), recvText: hex(t.aiTextColor, '#263247'), radius: Number(t.bubbleRadius) || 18 };
        const pv = h('div', { class: 'style-mini wide' }, sample(cfg, [[false, '你好，欢迎来到 Linely', true, true], [true, '这是我的主题', true, true]]));
        const bg = t.background && String(t.background).startsWith('data:image/') ? t.background : '';
        pv.style.background = wallFor(cfg.style, true, bg);
        return h('article', { class: 'plaza-item glass s2' },
          h('div', { class: 'row-top' }, h('b', { class: 'row-name' }, t.name), h('span', { class: 'chip' }, (BUBBLE_STYLES[cfg.style] || BUBBLE_STYLES.classic).name)),
          h('small', { class: 'hint', style: 'display:block;margin:2px 0 8px' }, (t.description || '没有简介') + ' · ' + (t.author || '用户')),
          pv, h('div', { class: 'plaza-actions' }, btn('预览', () => useTheme(t), '', 'image'), btn('使用', () => { useTheme(t); apply(); }, 'primary', 'check')));
      }));
    } catch (e) { plaza.replaceChildren(h('div', { class: 'hint', style: 'text-align:center;padding:12px 0' }, '主题广场暂时无法加载：' + e.message)); }
  }

  const group = (title, ...kids) => h('div', { class: 'sgroup' }, h('h4', null, title), h('div', { class: 'glass s2' }, ...kids));
  pad.append(
    group('预设气泡', grid),
    group('我的气泡', h('div', { class: 'hint', style: 'margin:2px 2px 8px' }, '自己做的气泡会保存在这里，随时再编辑。'), mine),
    group('气泡工坊', workshop),
    group('颜色', colorRow('主题强调色', 'accent'), colorRow('我的气泡', 'sent'), colorRow('对方气泡', 'recv', '#FFFFFF = iMessage 自动灰'),
      colorRow('我的文字', 'sentText', '#243047 = 自动白色'), colorRow('对方文字', 'recvText', '#263247 = 自动'),
      h('div', { style: 'padding:6px 0' }, radiusLab, radius), wallSwitch, bgRow),
    group('保存与应用', h('label', { class: 'fld' }, h('span', null, '主题名称（发布用）'), nameIn), h('label', { class: 'fld' }, h('span', null, '简介'), descIn),
      btn('应用到全部聊天', apply, 'primary', 'check'), btn('保存到「我的气泡」', saveOnly, '', 'plusCircle'), btn('发布到主题广场', publish, '', 'spark'),
      btn('删除这个自定义气泡', deleteDesign, 'danger', 'del'), btn('恢复经典样式', resetDefault, 'danger', 'close')),
    group('主题广场', plaza),
  );

  function afterMount() { syncInputs(); drawStyles(); drawWorkshop(); drawBgRow(); drawPreview(); fillTabbar(tabbar, 'themes', openTab); loadPlaza(); }
  function update() { fillTabbar(tabbar, 'themes', openTab); }
  function destroy() { document.documentElement.style.setProperty('--accent', get('theme')); }
  return { el: root, afterMount, update, destroy };
}
registerView('themes', themesView);
