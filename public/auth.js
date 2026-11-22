// Linely — sign in / register, protected by an image captcha.
const $ = (s) => document.querySelector(s);
const form = $('#form'), err = $('#err'), go = $('#go'), goLabel = $('.go-label');
const username = $('#username'), password = $('#password'), confirmEl = $('#confirm'), captcha = $('#captcha'), website = $('#website');
const seg = $('.seg'), capBtn = $('#capBtn'), capImg = $('#capImg');
let mode = 'login', capId = '', busy = false;

fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json()).then((j) => { if (j.authenticated) location.replace('/'); }).catch(() => {});

function showError(msg, ok = false) { err.hidden = !msg; err.className = 'error' + (ok ? ' ok' : ''); err.textContent = msg || ''; if (msg) { err.style.animation = 'none'; void err.offsetWidth; err.style.animation = ''; } }
async function loadCaptcha() {
  capBtn.classList.add('loading'); captcha.value = '';
  try {
    const r = await fetch('/api/auth/captcha', { cache: 'no-store' }), j = await r.json();
    if (!r.ok) throw new Error(j.error || '验证码加载失败');
    capId = j.id; capImg.src = j.image;
  } catch (e) { capId = ''; showError(e.message || '验证码加载失败，请点击图片重试'); }
  capBtn.classList.remove('loading');
}
function setMode(m, focus = true) {
  mode = m; const reg = m === 'register';
  seg.classList.toggle('reg', reg);
  $('#tabLogin').setAttribute('aria-selected', String(!reg)); $('#tabReg').setAttribute('aria-selected', String(reg));
  document.querySelectorAll('.reg-only').forEach((el) => { el.hidden = !reg; });
  $('#title').textContent = reg ? '创建账号' : '欢迎回来';
  $('#sub').textContent = reg ? '只需几秒，马上开始聊天' : '登录你的 Linely 账号';
  username.placeholder = reg ? '3–24 位字母、数字、下划线或中文' : '输入用户名'; username.autocomplete = reg ? 'username' : 'username';
  password.autocomplete = reg ? 'new-password' : 'current-password';
  password.placeholder = reg ? '至少 8 位，字母加数字更安全' : '输入密码';
  goLabel.textContent = reg ? '注册' : '登录'; document.title = (reg ? '注册' : '登录') + ' · Linely';
  $('#switchHint').innerHTML = reg ? '已经有账号？<button type="button" id="toLogin">去登录</button>' : '还没有账号？<button type="button" id="toReg">立即注册</button>';
  showError(''); loadCaptcha(); if (focus) username.focus();
  history.replaceState(null, '', reg ? '?mode=register' : location.pathname);
}
$('#tabLogin').onclick = () => setMode('login'); $('#tabReg').onclick = () => setMode('register');
$('#switchHint').addEventListener('click', (e) => { if (e.target.id === 'toReg') setMode('register'); if (e.target.id === 'toLogin') setMode('login'); });
capBtn.onclick = loadCaptcha;
$('#eye').onclick = (e) => { const on = password.type === 'password'; password.type = confirmEl.type = on ? 'text' : 'password'; e.currentTarget.setAttribute('aria-pressed', String(on)); e.currentTarget.setAttribute('aria-label', on ? '隐藏密码' : '显示密码'); };

function strength(p) {
  let s = 0; if (p.length >= 8) s++; if (p.length >= 12) s++; if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++; if (/\d/.test(p) && /[a-zA-Z]/.test(p)) s++; if (/[^\w\s]/.test(p)) s++;
  return !p ? 0 : Math.max(1, Math.min(4, s - (p.length < 8 ? 1 : 0)));
}
password.addEventListener('input', () => { const box = $('#strength'), s = strength(password.value); box.dataset.s = s; $('#strengthText').textContent = ['', '太弱', '一般', '不错', '很强'][s]; });

form.addEventListener('submit', async (e) => {
  e.preventDefault(); if (busy) return;
  const u = username.value.trim(), p = password.value, reg = mode === 'register';
  if (!u || !p) return showError('请输入用户名和密码');
  if (reg) {
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{3,24}$/.test(u)) return showError('用户名需为 3–24 位字母、数字、下划线或中文');
    if (p.length < 8) return showError('密码至少需要 8 位');
    if (p !== confirmEl.value) return showError('两次输入的密码不一致');
  }
  if (!capId) { showError('验证码还没加载出来，请点击图片重试'); return loadCaptcha(); }
  if (captcha.value.trim().length < 4) return showError('请输入图片中的验证码');
  busy = true; go.disabled = true; go.classList.add('busy'); showError('');
  try {
    const r = await fetch(reg ? '/api/auth/register' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ username: u, password: p, captchaId: capId, captcha: captcha.value.trim(), website: website.value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { showError(j.error || '请求失败，请稍后再试'); if (j.captcha !== false) loadCaptcha(); return; }
    go.classList.add('done'); goLabel.textContent = reg ? '注册成功' : '登录成功'; showError('');
    setTimeout(() => location.replace('/'), 450);
  } catch { showError('网络连接失败，请检查网络后重试'); loadCaptcha(); }
  finally { go.classList.remove('busy'); if (!go.classList.contains('done')) { busy = false; go.disabled = false; } }
});
setMode(new URLSearchParams(location.search).get('mode') === 'register' ? 'register' : 'login', false);
