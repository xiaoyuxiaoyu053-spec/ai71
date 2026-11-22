// Linely web — bubble styles shared by the chat page, the 一起听 page and the 主题 page.
// A "style" is a CSS class (bs-<id>) on the chat root plus a few CSS variables, so every page that
// renders bubbles with .mrow / .mline / .bubble automatically picks the same look.
import { h } from './lib.js';
import { get, mediaUrl } from './state.js';

/** Presets. `palette` is applied when the user picks a style; they can still tweak every colour after. */
export const BUBBLE_STYLES = {
  classic: {
    name: '经典', desc: 'iMessage 尾巴气泡',
    palette: { accent: '#0A84FF', myBubbleColor: '#0A84FF', bubbleColor: '#FFFFFF', myTextColor: '#243047', aiTextColor: '#263247' },
    wall: '',
  },
  bunny: {
    name: '小兔子', desc: '长耳朵 + 毛茸茸小尾巴',
    palette: { accent: '#F0709A', myBubbleColor: '#F0709A', bubbleColor: '#FFF1F6', myTextColor: '#FFFFFF', aiTextColor: '#5A2B3F' },
    wall: 'linear-gradient(180deg,#fff3f7 0%,#ffdce8 42%,#fff1f6 72%,#ffc9dc 100%)',
  },
  kitty: {
    name: '小猫咪', desc: '尖尖耳朵的暖橙气泡',
    palette: { accent: '#F39A3D', myBubbleColor: '#F6A65B', bubbleColor: '#FFF7EE', myTextColor: '#3A2312', aiTextColor: '#3A2312' },
    wall: 'linear-gradient(180deg,#fff9f0 0%,#ffe6c8 45%,#fff4e6 75%,#ffd7a8 100%)',
  },
  cloud: {
    name: '云朵', desc: '软绵绵的云朵泡泡',
    palette: { accent: '#3F9BEA', myBubbleColor: '#9ED3FA', bubbleColor: '#FDFEFF', myTextColor: '#0E3556', aiTextColor: '#1F3F5B' },
    wall: 'linear-gradient(180deg,#ecf7ff 0%,#cfe8fb 40%,#f2f9ff 70%,#bfe0f8 100%)',
  },
  sticker: {
    name: '贴纸', desc: '粗描边的漫画贴纸风',
    palette: { accent: '#F2A900', myBubbleColor: '#FFD43B', bubbleColor: '#FEFEFE', myTextColor: '#1B1B1F', aiTextColor: '#1B1B1F' },
    wall: 'radial-gradient(rgba(0,0,0,.09) 1.3px,transparent 1.6px) 0 0/18px 18px,#fff6cf',
  },
};
export const STYLE_IDS = Object.keys(BUBBLE_STYLES);
/** Custom designs made in the bubble workshop live in settings as customBubbles; their style id is "c:<design id>". */
export const customList = () => get('customBubbles') || [];
export const findDesign = (styleId) => (String(styleId).startsWith('c:') ? customList().find((d) => 'c:' + d.id === styleId) || null : null);
export const validStyle = (id) => (BUBBLE_STYLES[id] || findDesign(id) ? id : 'classic');
export const ANCHORS = { ts: ['左上', 0, 0], tc: ['上中', 50, 0], te: ['右上', 100, 0], ms: ['左中', 0, 50], me: ['右中', 100, 50], bs: ['左下', 0, 100], bc: ['下中', 50, 100], be: ['右下', 100, 100] };
export const PATTERNS = {
  none: ['无', ''],
  dots: ['波点', 'radial-gradient(rgba(255,255,255,.5) 18%,transparent 20%) 0 0/12px 12px'],
  stripes: ['斜纹', 'repeating-linear-gradient(45deg,rgba(255,255,255,.3) 0 6px,transparent 6px 12px)'],
  grid: ['方格', 'linear-gradient(rgba(255,255,255,.35) 1px,transparent 1px) 0 0/14px 14px,linear-gradient(90deg,rgba(255,255,255,.35) 1px,transparent 1px) 0 0/14px 14px'],
  stars: ['星点', 'radial-gradient(circle at 25% 30%,rgba(255,255,255,.7) 0 2px,transparent 3px) 0 0/22px 22px,radial-gradient(circle at 70% 70%,rgba(255,255,255,.55) 0 1.5px,transparent 2.5px) 0 0/22px 22px'],
};
export const SHADOWS = { none: ['无', 'none'], soft: ['柔和', '0 4px 12px rgba(0,0,0,.18)'], hard: ['硬阴影', '3px 3px 0 var(--bd,#1b1b1f)'], glow: ['发光', '0 0 14px var(--bc,#fff)'] };
export const newDesign = (name = '我的气泡') => ({ id: Math.random().toString(36).slice(2, 10), name, radius: 20, borderW: 0, borderColor: '#1B1B1F', shadow: 'soft', pattern: 'none', tail: true, bold: false, items: [] });
export const activeDesign = () => findDesign(get('bubbleStyle'));

/** Current look, read from the saved settings. */
export function themeCfg() {
  return {
    style: validStyle(get('bubbleStyle')),
    sent: get('myBubbleColor'), recv: get('bubbleColor'),
    sentText: get('myTextColor'), recvText: get('aiTextColor'),
    radius: Number(get('bubbleRadius')) || 18,
    design: activeDesign(),
  };
}

const rgb = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); const n = m ? parseInt(m[1], 16) : 0xffffff; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mixHex = (a, b, f) => { const x = rgb(a), y = rgb(b); return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * f).toString(16).padStart(2, '0')).join(''); };

/** Writes the bubble CSS variables + style class onto `root` (a .chat element or any wrapper of one). */
export function bubbleVars(root, cfg = themeCfg()) {
  const dark = root.classList.contains('dark');
  const set = (k, v) => root.style.setProperty(k, v);
  set('--sent', cfg.sent); set('--sent-top', mixHex(cfg.sent, '#ffffff', 0.16));
  set('--sent-text', String(cfg.sentText).toLowerCase() === '#243047' ? '#fff' : cfg.sentText);
  const customRecv = String(cfg.recv).toLowerCase() !== '#ffffff';
  const r = customRecv ? cfg.recv : dark ? '#3a3a3f' : '#e9e9eb';
  set('--recv', r); set('--recv-top', mixHex(r, '#ffffff', 0.12));
  const autoText = String(cfg.recvText).toLowerCase() === '#263247';
  set('--recv-text', autoText ? (dark ? '#fff' : '#111') : cfg.recvText);
  set('--br', (Number(cfg.radius) || 18) + 'px');
  [...root.classList].filter((c) => c.startsWith('bs-')).forEach((c) => root.classList.remove(c));
  const style = validStyle(cfg.style), d = cfg.design !== undefined ? cfg.design : findDesign(style);
  if (d) {
    root.classList.add('bs-custom');
    if (!d.tail) root.classList.add('bs-on');
    set('--br', (Number(d.radius) || 18) + 'px');
    set('--bw', (Number(d.borderW) || 0) + 'px'); set('--bd', d.borderColor || '#1B1B1F');
    set('--shadow', (SHADOWS[d.shadow] || SHADOWS.none)[1]);
    set('--pat', (PATTERNS[d.pattern] || PATTERNS.none)[1] || 'linear-gradient(transparent,transparent)');
    set('--fw', d.bold ? '700' : '400');
    return;
  }
  root.classList.add('bs-' + (BUBBLE_STYLES[style] ? style : 'classic'));
  if (style !== 'classic') root.classList.add('bs-on');
}

/** One decoration (emoji / drawn image) positioned relative to the bubble; mirrored for outgoing bubbles. */
export function decorEl(it, out, extraClass = '') {
  const a = ANCHORS[it.a] || ANCHORS.ts, mir = out ? -1 : 1;
  const x = out ? 100 - a[1] : a[1];
  const el = h('span', { class: 'bdecor ' + extraClass, 'data-s': it.scope || 'run', 'data-id': it.id, 'data-out': out ? '1' : '' });
  const flip = out && it.mirror !== false ? ' scaleX(-1)' : '';
  el.style.cssText = `left:calc(${x}% + ${(it.dx || 0) * mir}px);top:calc(${a[2]}% + ${it.dy || 0}px);transform:translate(-50%,-50%) rotate(${(it.rot || 0) * mir}deg)${flip};${it.behind ? 'z-index:-1;' : ''}`;
  if (it.kind === 'img') { const im = h('img', { alt: '', draggable: 'false' }); im.src = it.v; im.style.width = (it.size || 40) + 'px'; el.append(im); }
  else { el.textContent = it.v; el.style.fontSize = (it.size || 26) + 'px'; }
  return el;
}
export function bubbleEl(text, out, tail, extra = '', design = activeDesign()) {
  const el = h('div', { class: 'bubble' + (tail ? ' tail' : '') + extra }, text);
  if (design && design.items) for (const it of design.items) el.append(decorEl(it, out));
  const bgImg = mediaUrl(get('bubbleBackground'));
  if (bgImg) {
    el.style.backgroundImage = `url("${bgImg}"), linear-gradient(180deg, var(${out ? '--sent-top' : '--recv-top'}, ${out ? '#4aa6ff' : '#ececee'}), var(${out ? '--sent' : '--recv'}, ${out ? '#0a7bff' : '#e3e3e6'}))`;
    el.style.backgroundBlendMode = 'soft-light, normal'; el.style.backgroundSize = 'cover';
  }
  return el;
}
export const typingEl = () => h('div', { class: 'bubble typing tail' }, h('i'), h('i'), h('i'));
