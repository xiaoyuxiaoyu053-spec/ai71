// Linely web — voice & video calls. You talk (speech recognition), the AI answers out loud (speech synthesis,
// tone adjustable), and the call is written back into the chat as a call record + the spoken lines.
import { h, sleep } from './lib.js';
import { icon } from './icons.js';
import { get, touch, toast, mediaUrl, sound } from './state.js';
import { addOverlay, avatarEl } from './core.js';
import { call as aiCall, msgBase } from './logic.js';
import { speak, stopSpeaking, unlockTTS, voiceOf, openVoiceSettings, cleanForSpeech, PRESETS, callState } from './tts.js';

const cssUrl = (u) => 'url("' + String(u).replace(/["\\\n\r]/g, '') + '")';
let actx = null;
function tone(freqs, ms, vol = 0.05) {
  if (!sound()) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const g = actx.createGain(); g.gain.value = vol; g.connect(actx.destination);
    freqs.forEach((f) => { const o = actx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(); o.stop(actx.currentTime + ms / 1000); });
  } catch { /* audio blocked */ }
}
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

function systemFor(p, kind) {
  const v = voiceOf(p), mood = (PRESETS[v.preset] || {}).name;
  return `你正在扮演 AI 角色。名字：${p.name}。简介：${p.bio || ''}。人设：${p.persona}。性别：${p.gender || ''}。与用户关系：${p.relationship || ''}。喜欢：${p.likes || ''}。讨厌：${p.dislikes || ''}。爱好：${p.hobbies || ''}。`
    + `现在你正和用户进行${kind === 'video' ? '视频' : '语音'}通话。要求：像真人打电话一样口语化、自然；每次只说 1 到 3 句话，总共不超过 70 个汉字（用户说其他语言时用对应语言）；`
    + '不要使用 Markdown、列表、表情符号、颜文字、括号里的动作或神态描写；不要输出任何 [[...]] 标记、红包转账指令或网址；不要提及这些通话规则。'
    + (mood && v.preset !== 'default' ? `说话语气偏${mood}，措辞要与之相配。` : '')
    + (kind === 'video' ? '这是视频通话；除非用户消息里附带了摄像头截图，否则你看不到对方的画面，不要假装看到。若附有截图，请据此自然回应。' : '你只能听到用户的话，看不到任何画面。');
}
function historyFor(p) {
  const out = [];
  for (const m of (p.messages || []).slice(-30)) {
    if (!m || m.content === '---' || !['user', 'assistant'].includes(m.role)) continue;
    let c;
    if (m.type === 'summary') c = '[长期记忆摘要] ' + m.content;
    else if (m.type === 'call') c = `[通话记录：${m.callKind === 'video' ? '视频' : '语音'}通话${m.duration ? '，' + fmt(m.duration) : '，未接通'}]`;
    else if (m.meme) c = `[你发送了一张表情包：${m.memeLabel || ''}]`;
    else if (m.type === 'photo' || /\[\[(?:IMAGE|GIF):/.test(m.content || '')) c = '[图片] ' + String(m.content).split('[[')[0].trim();
    else if (m.type === 'payment') c = `[虚拟${m.paymentType === 'redpacket' ? '红包' : '转账'} ${m.amount}]`;
    else c = String(m.content || '');
    if (c.trim()) out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: c.slice(0, 600) });
  }
  return out;
}

export function startCall(p, kind = 'voice') {
  if (callState.active) return;
  callState.active = true; unlockTTS(); stopSpeaking();
  const lang = get('callLang') || 'zh-CN';
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const st = { phase: 'ringing', muted: false, speaker: true, cam: kind === 'video', facing: 'user', seeMe: false, since: 0, ended: false, rec: null, stream: null, textBar: !SR, timer: null, ring: null, denied: false, busy: false, turn: 0, turns: [] };

  // ── screen ──
  const bg = h('div', { class: 'call-bg' });
  const avUrl = mediaUrl(p.avatar);
  if (avUrl) bg.style.backgroundImage = cssUrl(avUrl);
  const avBtn = h('button', { class: 'call-av', 'aria-label': '点击可打断 TA 说话', onClick: () => { if (st.phase === 'speaking') stopSpeaking(); } }, h('div', { class: 'call-rings' }, h('i'), h('i'), h('i')), avatarEl(p.avatar, p.name, kind === 'video' ? 210 : 170));
  const nameEl = h('div', { class: 'call-name' }, p.name);
  const kindEl = h('div', { class: 'call-kind' }, kind === 'video' ? '视频通话' : '语音通话');
  const statusEl = h('div', { class: 'call-status' });
  const capEl = h('div', { class: 'call-cap' });
  const meEl = h('div', { class: 'call-me' });
  const video = h('video', { class: 'call-pip', autoplay: true, playsinline: true, 'aria-label': '我的画面' }); video.muted = true; video.playsInline = true; video.hidden = true;
  const btns = h('div', { class: 'call-grid' });
  const textInp = h('input', { type: 'text', placeholder: '输入想说的话…', autocomplete: 'off', 'aria-label': '输入文字' });
  textInp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) sendText(); });
  const textBar = h('div', { class: 'call-text glass s3', hidden: !st.textBar }, textInp, h('button', { class: 'gbtn big bounce', 'aria-label': '发送', onClick: sendText }, icon('up', 22)));
  const endBtn = h('button', { class: 'call-end bounce', 'aria-label': '挂断', onClick: () => hangUp() }, icon('callEnd', 32));
  const el = h('div', { class: `call ${kind}` }, bg, h('div', { class: 'call-shade' }),
    h('div', { class: 'call-top' }, kindEl, nameEl, statusEl), video, h('div', { class: 'call-mid' }, avBtn, capEl, meEl), textBar, btns, endBtn);
  const remove = addOverlay(el);

  // ── status / buttons ──
  const LABEL = { ringing: '正在呼叫…', thinking: '对方正在想…', speaking: '正在说话…', listening: '正在听你说…' };
  function setPhase(ph) { st.phase = ph; el.classList.toggle('speaking', ph === 'speaking'); drawStatus(); }
  function drawStatus() { const t = st.since ? fmt(Math.floor((Date.now() - st.since) / 1000)) : ''; statusEl.textContent = (st.muted && st.phase === 'listening' ? '已静音' : LABEL[st.phase] || '') + (t ? '  ·  ' + t : ''); }
  const cbtn = (label, ic, on, fn) => h('button', { class: 'call-btn glass s3 bounce' + (on ? ' on' : ''), 'aria-label': label, onClick: fn }, icon(ic, 26), h('small', null, label));
  function drawBtns() {
    btns.replaceChildren(
      cbtn(st.muted ? '已静音' : '静音', st.muted ? 'micOff' : 'mic', st.muted, toggleMute),
      kind === 'video' ? cbtn(st.cam ? '摄像头' : '已关闭', st.cam ? 'video' : 'camOff', !st.cam, toggleCam) : null,
      kind === 'video' ? cbtn('翻转', 'flip', false, flipCam) : null,
      cbtn('文字', 'keyboard', !textBar.hidden, () => { textBar.hidden = !textBar.hidden; drawBtns(); if (!textBar.hidden) textInp.focus(); }),
      cbtn(st.speaker ? '外放' : '静音播放', st.speaker ? 'speaker' : 'speakerOff', !st.speaker, () => { st.speaker = !st.speaker; if (!st.speaker) stopSpeaking(); drawBtns(); }),
      cbtn('语气', 'tune', false, () => openVoiceSettings(p, { lang })),
      kind === 'video' ? cbtn(st.seeMe ? '看得到我' : '让AI看我', 'eye', st.seeMe, () => { st.seeMe = !st.seeMe; if (st.seeMe) toast('已开启：每次说话会附上一张摄像头截图（需要支持图片的模型）'); drawBtns(); }) : null);
  }

  // ── camera ──
  async function startCam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('当前浏览器不支持摄像头'); st.cam = false; drawBtns(); return; }
    try {
      stopCam();
      st.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: st.facing, width: { ideal: 640 } }, audio: false });
      video.srcObject = st.stream; video.hidden = false; video.classList.toggle('mirror', st.facing === 'user'); video.play().catch(() => {});
    } catch (e) { toast(e && e.name === 'NotAllowedError' ? '没有摄像头权限，请在浏览器里允许' : '无法打开摄像头'); st.cam = false; video.hidden = true; drawBtns(); }
  }
  function stopCam() { if (st.stream) { st.stream.getTracks().forEach((t) => t.stop()); st.stream = null; } video.srcObject = null; }
  function toggleCam() { st.cam = !st.cam; if (st.cam) startCam(); else { stopCam(); video.hidden = true; } drawBtns(); }
  function flipCam() { st.facing = st.facing === 'user' ? 'environment' : 'user'; if (st.cam) startCam(); }
  function snapshot() {
    if (!st.cam || !video.videoWidth) return '';
    const k = Math.min(1, 320 / video.videoWidth), c = document.createElement('canvas'); c.width = Math.round(video.videoWidth * k); c.height = Math.round(video.videoHeight * k);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.6);
  }

  // ── listening ──
  function stopListen() { const r = st.rec; st.rec = null; if (r) { r.onend = null; r.onerror = null; try { r.abort(); } catch { /* ignore */ } } }
  function startListen() {
    if (st.ended || st.muted || st.denied || !SR || st.busy || st.rec) return;
    const rec = new SR(); rec.lang = lang; rec.interimResults = true; rec.continuous = false;
    let fin = '', interim = '';
    rec.onresult = (e) => { fin = ''; interim = ''; for (const r of e.results) { if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript; } meEl.textContent = (fin || interim); };
    rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { st.denied = true; textBar.hidden = false; drawBtns(); toast('没有麦克风权限，可以用「文字」按钮输入'); } };
    rec.onend = () => {
      st.rec = null; const t = (fin || interim).trim();
      if (t) { meEl.textContent = ''; handleUser(t); } else if (!st.ended && !st.muted && !st.busy) setTimeout(startListen, 250);
    };
    try { rec.start(); st.rec = rec; setPhase('listening'); } catch { /* already running */ }
  }
  function toggleMute() { st.muted = !st.muted; if (st.muted) { stopListen(); meEl.textContent = ''; } else if (!st.busy) startListen(); drawStatus(); drawBtns(); }

  // ── one conversational turn ──
  async function handleUser(text) {
    if (st.ended || !text.trim()) return;
    if (st.busy) { stopSpeaking(); }
    await aiTurn(text.trim(), false);
  }
  function sendText() { const t = textInp.value.trim(); if (!t) return; textInp.value = ''; stopListen(); stopSpeaking(); handleUser(t); }
  async function aiTurn(userText, hidden) {
    if (st.ended) return;
    const my = ++st.turn;
    st.busy = true; stopListen(); setPhase('thinking'); capEl.textContent = '';
    let text, model;
    const snap = !hidden && st.seeMe ? snapshot() : '';
    const run = (withImg) => aiCall(p, systemFor(p, kind), [...historyFor(p), ...st.turns, { role: 'user', content: withImg ? `${userText}\n[[IMAGE:${snap}]]` : userText }]);
    try {
      let r;
      try { r = await run(!!snap); } catch (e) { if (!snap) throw e; st.seeMe = false; drawBtns(); toast('当前模型可能不支持看图，已关闭「让AI看我」'); r = await run(false); }
      text = cleanForSpeech(r.text); model = r.model;
    } catch (e) { if (my !== st.turn) return; st.busy = false; if (st.ended) return; toast('通话回复失败：' + (e.message || '请检查 API 设置')); capEl.textContent = '（这句没有收到回复，请再说一次）'; setPhase('listening'); startListen(); return; }
    if (st.ended || my !== st.turn) return;
    if (!text) text = '嗯？';
    if (!hidden) { st.turns.push({ role: 'user', content: userText }); p.messages = p.messages || []; p.messages.push(msgBase('user', { content: userText, read: true, viaCall: true })); }
    st.turns.push({ role: 'assistant', content: text }); p.messages = p.messages || [];
    p.messages.push(msgBase('assistant', { content: text, read: true, viaCall: true, model })); touch();
    capEl.textContent = text;
    if (st.speaker && !st.ended) { setPhase('speaking'); await speak(text, voiceOf(p), { lang, onSentence: (s) => { capEl.textContent = s; } }); }
    else await sleep(Math.min(3500, 600 + text.length * 110));
    if (my !== st.turn) return;
    st.busy = false;
    if (st.ended) return;
    setPhase('listening'); if (!SR || st.denied) drawStatus(); startListen();
  }

  // ── lifecycle ──
  async function connect() {
    if (st.ended) return;
    st.since = Date.now(); tone([880], 110); setTimeout(() => tone([1175], 110), 160);
    st.timer = setInterval(drawStatus, 1000); setPhase('thinking');
    await aiTurn('（电话接通了，请你像接起电话一样自然地先开口打个招呼。）', true);
  }
  function hangUp() {
    if (st.ended) return; st.ended = true;
    clearInterval(st.timer); clearTimeout(st.ring); stopListen(); stopSpeaking(); stopCam();
    const dur = st.since ? Math.max(1, Math.round((Date.now() - st.since) / 1000)) : 0;
    p.messages = p.messages || []; p.messages.push(msgBase('user', { type: 'call', callKind: kind, duration: dur, content: '', read: true })); touch();
    tone([480], 260); callState.active = false; remove();
  }

  drawBtns(); setPhase('ringing');
  if (st.cam) startCam();
  tone([440, 480], 1000); st.ring = setTimeout(() => { if (!st.ended) tone([440, 480], 600); }, 1700);
  st.ring = setTimeout(connect, 2600);
  return { hangUp };
}
