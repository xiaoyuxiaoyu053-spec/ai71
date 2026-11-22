// Linely web — the free API is locked until the signed-in user redeems an activation code (made in the admin console).
import { h } from './lib.js';
import { icon } from './icons.js';
import { toast } from './state.js';
import { modal } from './core.js';

export const ent = { loaded: false, enabled: false, unlocked: false, expiresAt: 0, permanent: false, provider: '', model: '' };
const listeners = new Set();
export const onEntitlement = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export async function loadEntitlement() {
  try {
    const r = await fetch('/api/free-config', { cache: 'no-store', credentials: 'same-origin' });
    const j = await r.json();
    Object.assign(ent, { loaded: true, enabled: !!j.enabled, unlocked: !!j.unlocked, expiresAt: j.expiresAt || 0, permanent: !!j.permanent, provider: j.provider || '', model: j.model || '' });
  } catch { /* offline: keep the last known state */ }
  listeners.forEach((f) => f(ent));
  return ent;
}
export const expiryText = () => (!ent.unlocked ? '' : ent.permanent ? '永久有效' : ent.expiresAt ? '有效期至 ' + new Date(ent.expiresAt).toLocaleDateString('zh-CN') : '');

export async function redeemCode(code) {
  const r = await fetch('/api/redeem', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || '兑换失败');
  await loadEntitlement();
  return j;
}
/** "abcd efgh…" → "ABCD-EFGH-JKMN-PQRS" while typing */
export const formatCode = (v) => (String(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16).match(/.{1,4}/g) || []).join('-');

export function codeInput() {
  const inp = h('input', { type: 'text', class: 'code-input', placeholder: 'XXXX-XXXX-XXXX-XXXX', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text', maxlength: '19', 'aria-label': '激活码' });
  inp.addEventListener('input', () => { inp.value = formatCode(inp.value); });
  return inp;
}

/** the dialog opened when a locked free-API feature is tapped */
export function redeemDialog(onDone) {
  const inp = codeInput(), msg = h('div', { class: 'redeem-msg', role: 'status' });
  const dlg = modal({
    title: '解锁免费 API',
    body: [
      h('div', { class: 'lock-hero' }, h('div', { class: 'lock-badge' }, icon('lock', 34))),
      h('p', { style: 'text-align:center;margin:10px 0 14px' }, '免费 API 需要激活码才能使用。输入管理员发给你的激活码，立刻解锁。'),
      inp, msg],
    actions: [{ label: '取消' }, { label: '兑换', kind: 'p', onClick: async () => {
      if (!inp.value.trim()) { msg.textContent = '请先输入激活码'; return false; }
      try { const j = await redeemCode(inp.value); toast(j.freeApi && j.freeApi.permanent ? '已解锁，永久有效 🎉' : `已解锁，${expiryText()}`); if (onDone) onDone(); }
      catch (e) { msg.textContent = e.message; inp.classList.remove('shake'); void inp.offsetWidth; inp.classList.add('shake'); return false; }
    } }],
  });
  setTimeout(() => inp.focus(), 80);
  return dlg;
}
