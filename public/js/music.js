// Linely web — 一起听: upload your own MP3s (custom name + icon), play them in a chat-styled page.
// The <audio> element lives at module level, so music keeps playing while you switch tabs.
import { dbDel, h, uid, clock, defaultModel, replyDetailed, luminanceOf, playSfx, prepareImage } from './lib.js';
import { icon } from './icons.js';
import { S, get, set, save, personas, findPersona, toast, sound, addMediaFromFile, addMediaDataUrl, mediaUrl, readFileAsDataUrl } from './state.js';
import { registerView, avatarEl, press, menu, modal, pickFile, chatDark, fillTabbar, openTab, field } from './core.js';
import { buildEntries } from './chat.js';
import { bubbleVars, bubbleEl, typingEl } from './bubbles.js';

const cssUrl = (u) => 'url("' + String(u).replace(/["\\\n\r]/g, '') + '")';
const MAX_MB = 20;
const M = { pending: '', error: '', auto: false, timer: null, view: null, draft: '' };
const P = { id: '', playing: false, t: 0, d: 0, mode: 'list' };
const MODES = { list: '顺序', shuffle: '随机', one: '单曲' };
const audio = new Audio(); audio.preload = 'auto';
const blobUrls = new Map();
const tracks = () => get('musicTracks') || [];
const currentTrack = () => tracks().find((t) => t.id === P.id) || null;
const fmt = (s) => (isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const hue = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

/** Cover = the track's custom icon, or a coloured tile with the first letter of its name. */
function coverEl(t, size = 56, cls = '') {
  const url = t && mediaUrl(t.icon);
  const el = h('div', { class: 'cover ' + cls, style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.44)}px` });
  if (url) el.style.backgroundImage = cssUrl(url);
  else { const x = t ? hue(t.name) : 210; el.style.background = `linear-gradient(135deg,hsl(${x} 85% 72%),hsl(${(x + 40) % 360} 80% 58%))`; el.textContent = t ? [...t.name][0] || '♪' : '♪'; }
  return el;
}
function dataUrlToBlob(u) {
  const i = u.indexOf(','), mime = (/^data:([^;,]+)/.exec(u) || [])[1] || 'audio/mpeg', bin = atob(u.slice(i + 1)), arr = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
  return new Blob([arr], { type: mime });
}

// ───────────── player engine ─────────────
const ping = () => M.view && M.view.tick();
audio.addEventListener('play', () => { P.playing = true; ping(); });
audio.addEventListener('pause', () => { P.playing = false; ping(); });
audio.addEventListener('timeupdate', () => { P.t = audio.currentTime; ping(); });
audio.addEventListener('loadedmetadata', () => { P.d = audio.duration; ping(); });
audio.addEventListener('ended', () => step(1, true));
async function playTrack(id) {
  const t = tracks().find((x) => x.id === id);
  if (!t) return;
  if (P.id !== id || !audio.src) {
    const src = mediaUrl(t.audio);
    if (!src) { toast('找不到这首歌的音频文件，请重新上传'); return; }
    if (!blobUrls.has(id)) blobUrls.set(id, URL.createObjectURL(dataUrlToBlob(src)));
    audio.src = blobUrls.get(id); P.id = id; P.t = 0; P.d = 0;
    get('musicCurrent') !== id && (setCurrent(id));
  }
  try { await audio.play(); } catch (e) { toast('无法播放：' + (e.message || '浏览器阻止了播放')); }
  setSession(t); ping(); M.view && M.view.update();
}
function setCurrent(id) { set('musicCurrent', id); }
function toggle() {
  if (!P.id) { const t = tracks().find((x) => x.id === get('musicCurrent')) || tracks()[0]; if (t) playTrack(t.id); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
function step(dir, auto = false) {
  const list = tracks(); if (!list.length) return;
  if (auto && P.mode === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  let i = list.findIndex((t) => t.id === P.id);
  if (P.mode === 'shuffle' && list.length > 1) { let j; do { j = Math.floor(Math.random() * list.length); } while (j === i); i = j; }
  else i = (i + dir + list.length) % list.length;
  playTrack(list[i].id);
}
function setSession(t) {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  const art = mediaUrl(t.icon);
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: t.artist || 'Linely 一起听', artwork: art ? [{ src: art, sizes: '512x512' }] : [] });
  for (const [a, f] of [['play', () => audio.play()], ['pause', () => audio.pause()], ['nexttrack', () => step(1)], ['previoustrack', () => step(-1)]]) { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported */ } }
}
function removeTrack(t) {
  if (P.id === t.id) { audio.pause(); audio.removeAttribute('src'); P.id = ''; P.playing = false; }
  if (blobUrls.has(t.id)) { URL.revokeObjectURL(blobUrls.get(t.id)); blobUrls.delete(t.id); }
  for (const ref of [t.audio, t.icon]) { if (ref && ref.startsWith('media:')) { S.media.delete(ref.slice(6)); dbDel('media', ref.slice(6)).catch(() => {}); } }
  set('musicTracks', tracks().filter((x) => x.id !== t.id));
}

// ───────────── AI ─────────────
const currentPersona = () => findPersona(get('musicPersona')) || personas()[0] || null;
function systemFor(p) {
  const t = currentTrack();
  const song = t ? `《${t.name}》${t.artist ? '（' + t.artist + '）' : ''}${P.playing ? '，正在播放' : '，已暂停'}` : '用户尚未添加歌曲';
  return `你正在与用户一起听歌。请严格遵循角色设定，像真实聊天伙伴一样自然交流。角色：${p.name}。简介：${p.bio || ''}。人设：${p.persona || ''}。当前歌曲：${song}。可以聊歌曲氛围、歌词感受和聆听体验；你无法听到音频，不要声称听到了具体旋律或歌词细节，不确定的内容请坦诚说明。回答简短自然，像聊天消息。`;
}
async function ask(p, text, proactive = false) {
  if (M.pending) return;
  const list = (p.musicMessages ||= []);
  if (!proactive) list.push({ id: uid(), role: 'user', content: text, time: Date.now() });
  M.pending = p.id; M.error = ''; save(); M.view && M.view.refresh();
  try {
    const history = list.slice(-20).filter((m) => m.content).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));
    if (proactive) history.push({ role: 'user', content: text });
    const r = await replyDetailed({ provider: p.provider, apiKey: p.apiKey, baseUrl: p.baseUrl || '', model: p.model || defaultModel(p.provider || 'DeepSeek'), system: systemFor(p), history, direct: !!get('directMode'), useFreeApi: !!p.useFreeApi });
    list.push({ id: uid(), role: 'assistant', content: r.text, time: Date.now(), tokens: r.totalTokens, model: p.model || '' });
    if (sound()) playSfx('receive');
  } catch (e) { M.error = '发送失败：' + (e && e.message ? e.message : e); }
  finally { M.pending = ''; save(); M.view && M.view.refresh(); }
}


// ───────────── view ─────────────
function musicView() {
  const bgRef = () => get('musicBackground');
  let bgDark = null, first = true, prevCount = -1, panelOpen = false;
  const seen = new Set();
  const isDark = () => (bgRef() ? !!bgDark : chatDark());
  const root = h('div', { class: 'screen chat music' });
  const bgLayer = h('div', { class: 'mbg' });

  const backPill = h('button', { class: 'back-pill glass s2 bounce', 'aria-label': '返回信息', onClick: () => openTab('chat') }, icon('left', 28));
  const nameCap = h('button', { class: 'name-cap glass s2 bounce', onClick: () => personaMenu() });
  const headMid = h('div', { class: 'head-mid' });
  const addBtn = h('button', { class: 'vid-btn glass s2 bounce', 'aria-label': '添加音乐', onClick: () => trackDialog() }, icon('add', 26));
  const head = h('div', { class: 'chat-head' }, backPill, headMid, addBtn);

  // player card
  const player = h('div', { class: 'player glass s2' });
  const msgs = h('div', { class: 'msgs' });
  const errEl = h('div', { class: 'errchip glass s3', hidden: true, onClick: () => { M.error = ''; drawError(); } });
  const panel = h('div', { class: 'panel glass s3', hidden: true });
  const ta = h('textarea', { rows: 1, 'aria-label': '消息输入框' });
  ta.value = M.draft;
  const trailing = h('span', { style: 'display:contents' });
  const plus = h('button', { class: 'plus glass s2 bounce', 'aria-label': '展开功能', onClick: () => { panelOpen = !panelOpen; plus.classList.toggle('open', panelOpen); panel.hidden = !panelOpen; if (panelOpen) panel.replaceChildren(...panelItems()); } }, icon('add', 26));
  const composer = h('div', { class: 'composer' }, plus, h('div', { class: 'field glass s2' }, ta, trailing));
  const tabbar = h('div', { class: 'tabbar glass s2' });
  root.append(bgLayer, head, player, msgs, errEl, panel, composer, tabbar);

  let cover, titleEl, subEl, playBtn, seek, curEl, durEl, modeBtn;
  function drawPlayer() {
    const list = tracks(), t = currentTrack() || list.find((x) => x.id === get('musicCurrent')) || list[0] || null;
    player.classList.toggle('no-song', !list.length);
    if (!list.length) {
      player.replaceChildren(h('button', { class: 'music-empty bounce soft', onClick: () => trackDialog() }, icon('music', 30), h('div', null, h('b', null, '上传你的第一首 MP3'), h('small', null, '给它起个名字、换个图标，就能和 AI 一起听'))));
      cover = titleEl = null; return;
    }
    cover = coverEl(t, 58, 'p-cover');
    titleEl = h('b', { class: 'p-title' }, t.name);
    subEl = h('small', { class: 'p-sub' }, t.artist || (P.id === t.id ? '' : '点击播放'));
    const g = (cls, label, ic, fn) => h('button', { class: 'gbtn bounce ' + cls, 'aria-label': label, onClick: fn }, icon(ic, 22));
    playBtn = g('big', '播放 / 暂停', 'play', toggle);
    seek = h('input', { type: 'range', class: 'seek', min: 0, max: 1000, value: 0, 'aria-label': '播放进度' });
    seek.addEventListener('input', () => { if (P.d) { audio.currentTime = (seek.value / 1000) * P.d; } });
    curEl = h('span', { class: 'tm' }, '0:00'); durEl = h('span', { class: 'tm' }, '0:00');
    modeBtn = h('button', { class: 'gpill bounce', onClick: () => { P.mode = P.mode === 'list' ? 'shuffle' : P.mode === 'shuffle' ? 'one' : 'list'; modeBtn.textContent = MODES[P.mode]; } }, MODES[P.mode]);
    const listBtn = h('button', { class: 'gpill bounce', onClick: () => playlistDialog() }, icon('list', 16), '歌单 ' + list.length);
    player.replaceChildren(
      h('div', { class: 'p-top' }, cover, h('div', { class: 'p-meta' }, titleEl, subEl), g('', '上一首', 'prev', () => step(-1)), playBtn, g('', '下一首', 'next', () => step(1))),
      h('div', { class: 'p-bar' }, curEl, seek, durEl, modeBtn, listBtn));
    tick();
  }
  function tick() {
    if (!seek) return;
    const t = currentTrack(), playing = P.playing && !!t;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 24));
    cover && cover.classList.toggle('playing', playing);
    if (t) { titleEl.textContent = t.name; subEl.textContent = t.artist || (playing ? '正在播放' : '已暂停'); }
    if (document.activeElement !== seek) seek.value = P.d ? Math.round((P.t / P.d) * 1000) : 0;
    curEl.textContent = fmt(P.t); durEl.textContent = fmt(P.d);
    drawHead();
  }

  function look() {
    root.classList.toggle('dark', isDark());
    bubbleVars(root);
    const url = mediaUrl(bgRef());
    bgLayer.style.backgroundImage = url ? cssUrl(url) : '';
    bgLayer.hidden = !url;
    if (url && bgDark === null) luminanceOf(url).then((l) => { bgDark = l < 0.5; look(); });
  }
  function drawHead() {
    const p = currentPersona(), t = currentTrack();
    nameCap.replaceChildren(h('span', null, p ? p.name : '一起听'), icon('right', 18));
    ta.placeholder = p ? `和 ${p.name} 聊聊这首歌` : 'iMessage信息';
    headMid.replaceChildren(
      h('div', { class: 'bounce' + (P.playing ? ' float' : ''), onClick: () => personaMenu() }, avatarEl(p && p.avatar, p ? p.name : '♫', 66)),
      nameCap, h('small', { class: 'song-sub' }, t ? (P.playing ? '正在一起听 · ' : '已暂停 · ') + t.name : '还没有添加歌曲'));
  }
  function drawError() { errEl.hidden = !M.error; errEl.textContent = M.error; errEl.style.color = '#ff6b6b'; }
  function canSend() { return !M.pending && ta.value.trim() && currentPersona(); }
  function drawTrailing() { trailing.replaceChildren(h('button', { class: 'sendbtn bounce', style: canSend() ? '' : 'opacity:.35', 'aria-label': '发送消息', onClick: doSend }, icon('up', 20))); }
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; };
  async function doSend() {
    if (!canSend()) return;
    const p = currentPersona(), t = ta.value.trim();
    ta.value = ''; M.draft = ''; autosize(); drawTrailing();
    if (sound()) playSfx('send');
    await ask(p, t);
  }
  ta.addEventListener('input', () => { M.draft = ta.value; autosize(); drawTrailing(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); doSend(); } });

  function personaMenu() {
    const list = personas();
    if (!list.length) { toast('还没有 AI 角色，先去「增加AI」创建一个'); return; }
    menu(nameCap, list.map((p) => ({ label: (currentPersona() && currentPersona().id === p.id ? '✓ ' : '') + p.name, onClick: () => set('musicPersona', p.id) })));
  }

  // ── upload / edit a track: MP3 + custom name + custom icon ──
  function trackDialog(existing) {
    const st = { file: null, icon: existing ? mediaUrl(existing.icon) : '', iconData: '' };
    const nameIn = h('input', { type: 'text', placeholder: '歌曲名称', maxlength: '60', autocomplete: 'off', value: existing ? existing.name : '' });
    const artistIn = h('input', { type: 'text', placeholder: '歌手 / 备注（选填）', maxlength: '60', autocomplete: 'off', value: existing ? existing.artist || '' : '' });
    const fileLab = h('small', { class: 'hint', style: 'margin:0' }, existing ? '已保存音频（可重新选择替换）' : '支持 MP3 / M4A / WAV，不超过 ' + MAX_MB + ' MB');
    const iconBox = h('div', { class: 'icon-pick' });
    const drawIcon = () => iconBox.replaceChildren(
      h('button', { class: 'bounce', 'aria-label': '选择图标', onClick: pickIcon }, coverEl({ name: nameIn.value || '♪', icon: '' }, 72, st.icon ? 'has-img' : '')),
      h('div', null, h('b', null, '自定义图标'), h('small', { class: 'hint', style: 'display:block;margin:2px 0 6px' }, '点击左侧选择一张图片'), st.icon ? h('button', { class: 'gpill bounce', onClick: () => { st.icon = ''; st.iconData = ''; drawIcon(); } }, '恢复默认') : null));
    function drawIconImg() { const c = iconBox.querySelector('.cover'); if (c && st.icon) { c.style.background = ''; c.textContent = ''; c.style.backgroundImage = cssUrl(st.icon); } }
    const pickIcon = () => pickFile('image/*', async (f) => { try { st.iconData = await prepareImage(f, 512); st.icon = st.iconData; drawIcon(); drawIconImg(); } catch (e) { toast(e.message || '无法读取图片'); } });
    const pickAudio = () => pickFile('audio/*,.mp3,.m4a,.wav,.flac,.ogg', (f) => {
      if (f.size > MAX_MB * 1024 * 1024) { toast(`文件超过 ${MAX_MB} MB，请压缩后再上传`); return; }
      st.file = f; fileLab.textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
      if (!nameIn.value.trim()) { nameIn.value = f.name.replace(/\.[^.]+$/, ''); }
    });
    drawIcon(); drawIconImg();
    modal({
      title: existing ? '编辑歌曲' : '添加音乐',
      body: [h('button', { class: 'btn bounce soft', onClick: pickAudio }, icon('file', 19), existing ? '更换 MP3 文件' : '选择 MP3 文件'), fileLab, field('歌曲名称', nameIn), field('歌手 / 备注', artistIn), iconBox],
      actions: [{ label: '取消' }, { label: '保存', kind: 'p', onClick: async () => {
        const name = nameIn.value.trim();
        if (!existing && !st.file) { toast('请先选择一个 MP3 文件'); return false; }
        if (!name) { toast('给歌曲起个名字吧'); return false; }
        try {
          let audioRef = existing ? existing.audio : '';
          if (st.file) { let u = await readFileAsDataUrl(st.file); if (!/^data:audio\//.test(u)) u = u.replace(/^data:[^;,]*/, 'data:audio/mpeg'); audioRef = await addMediaDataUrl(u); }
          let iconRef = existing ? existing.icon || '' : '';
          if (st.iconData) iconRef = await addMediaDataUrl(st.iconData); else if (!st.icon) iconRef = '';
          if (existing) {
            if (st.file && blobUrls.has(existing.id)) { URL.revokeObjectURL(blobUrls.get(existing.id)); blobUrls.delete(existing.id); if (P.id === existing.id) { audio.pause(); audio.removeAttribute('src'); P.id = ''; } }
            Object.assign(existing, { name, artist: artistIn.value.trim(), audio: audioRef, icon: iconRef }); set('musicTracks', tracks());
          } else {
            const t = { id: uid(), name, artist: artistIn.value.trim(), audio: audioRef, icon: iconRef, addedAt: Date.now() };
            set('musicTracks', [...tracks(), t]); toast('已添加，点播放键开始听');
            if (tracks().length === 1) set('musicCurrent', t.id);
          }
        } catch (e) { toast('保存失败：' + (e.message || e)); return false; }
      } }],
    });
  }
  function playlistDialog() {
    const body = h('div', { class: 'tracklist' });
    const dlg = modal({ title: '歌单', body: [body, h('button', { class: 'btn bounce soft', onClick: () => { dlg.close(); trackDialog(); } }, icon('add', 19), '添加音乐')], actions: [{ label: '完成', kind: 'p' }] });
    const draw = () => body.replaceChildren(...(tracks().length ? tracks().map((t) => h('div', { class: 'trow' + (t.id === P.id ? ' on' : '') },
      h('button', { class: 'trow-main bounce', onClick: () => { playTrack(t.id); dlg.close(); } }, coverEl(t, 44), h('div', null, h('b', null, t.name), h('small', null, t.artist || '—'))),
      h('button', { class: 'gpill bounce', onClick: () => { dlg.close(); trackDialog(t); } }, '编辑'),
      h('button', { class: 'gpill bounce danger', onClick: () => { removeTrack(t); draw(); } }, '删除'))) : [h('div', { class: 'hint', style: 'text-align:center;padding:14px' }, '歌单还是空的')]));
    draw();
  }
  function panelItems() {
    const it = (label, ic, color, delay, fn) => h('button', { class: 'pitem bounce pop-in', style: `animation-delay:${delay}ms`, onClick: () => { panelOpen = false; plus.classList.remove('open'); panel.hidden = true; fn(); } }, h('div', { class: 'ic glass s2', style: 'color:' + color }, icon(ic, 28)), label);
    const items = [
      it('添加音乐', 'music', '#ff5d7a', 0, () => trackDialog()),
      it('歌单', 'list', '#635bff', 40, playlistDialog),
      it('背景', 'image', '#3b9af5', 80, () => pickFile('image/*', async (f) => { try { bgDark = null; set('musicBackground', await addMediaFromFile(f, 1600)); } catch (e) { toast(e.message || '无法读取图片'); } })),
    ];
    if (bgRef()) items.push(it('清除背景', 'close', '#8e8e93', 120, () => { bgDark = null; set('musicBackground', ''); }));
    items.push(it(M.auto ? 'AI主动·开' : 'AI主动·关', 'spark', M.auto ? '#17a979' : '#af52de', 160, () => { M.auto = !M.auto; syncTimer(); toast(M.auto ? '已开启：每 3 分钟 AI 可能主动发一条消息（需保持本页打开）' : '已关闭 AI 主动消息'); }));
    return items;
  }
  function syncTimer() {
    clearInterval(M.timer); M.timer = null;
    if (M.auto) M.timer = setInterval(() => { const p = currentPersona(); if (p && currentTrack() && !M.pending) ask(p, '请自然地主动发一条关于我们正在一起听歌的简短消息，不要重复之前说过的话。', true); }, 180000);
  }

  // messages
  function entryRow(e, p) {
    const m = e.m, out = m.role === 'user';
    const nodes = [];
    if (e.label) nodes.push(h('div', { class: 'sep' }, e.label));
    const isNew = !first && !seen.has(e.key); seen.add(e.key);
    const row = h('div', { class: `mrow ${out ? 'out' : 'in'}${e.startRun && !e.label ? ' start' : ''}${e.startRun ? ' run' : ''}${isNew ? ' pop-in' : ''}`, style: isNew ? `transform-origin:${out ? 'right' : 'left'} bottom` : '' });
    const body = bubbleEl(m.content || '', out, e.endRun);
    press(body, { onLong: () => menu(body, [
      { label: '复制', onClick: () => { try { navigator.clipboard.writeText(m.content || ''); toast('已复制'); } catch { toast('无法复制'); } } },
      { label: '删除', danger: true, onClick: () => { p.musicMessages = (p.musicMessages || []).filter((x) => x !== m); save(); renderMsgs(); } }]) });
    row.append(h('div', { class: 'mline' }, body));
    if (!out && e.aiEnd) row.append(h('div', { class: 'meta' }, [m.model || '', m.time ? clock(m.time) : ''].filter(Boolean).join('  ✦  ')));
    nodes.push(row);
    return nodes;
  }
  function renderMsgs() {
    const p = currentPersona();
    const entries = buildEntries(p && p.musicMessages || []);
    const nodes = entries.flatMap((e) => entryRow(e, p));
    if (!p) nodes.push(h('div', { class: 'sumnote' }, h('small', null, '一起听'), h('p', { class: 'glass s2' }, '还没有 AI 角色。到「增加AI」创建一个，就能一起听歌聊天了。')));
    else if (!entries.length && !M.pending) nodes.push(h('div', { class: 'sumnote' }, h('small', null, '一起听'), h('p', { class: 'glass s2' }, tracks().length ? `放一首歌，和 ${p.name} 聊聊吧。` : '先上传一首 MP3，再和 TA 一起听。')));
    if (M.pending && p && M.pending === p.id) nodes.push(h('div', { class: 'mrow in run' }, h('div', { class: 'mline' }, typingEl())));
    const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 120, keep = msgs.scrollTop;
    msgs.replaceChildren(...nodes);
    const count = entries.length + (M.pending ? 1 : 0), grew = count !== prevCount; prevCount = count;
    if (first) msgs.scrollTop = msgs.scrollHeight;
    else if (grew || nearBottom) msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
    else msgs.scrollTop = keep;
    first = false;
  }

  function refresh() { drawHead(); renderMsgs(); drawTrailing(); drawError(); }
  function update() { look(); drawHead(); drawPlayer(); drawTabbar(); renderMsgs(); drawTrailing(); }
  function drawTabbar() { fillTabbar(tabbar, 'music', openTab); }
  function afterMount() { M.view = { refresh, tick, update }; syncTimer(); autosize(); renderMsgs(); }
  function destroy() { clearInterval(M.timer); M.timer = null; M.view = null; }

  look(); drawHead(); drawPlayer(); drawTabbar(); drawTrailing(); drawError();
  return { el: root, afterMount, update, destroy, onBusy() {}, onError() {} };
}
registerView('music', musicView);
