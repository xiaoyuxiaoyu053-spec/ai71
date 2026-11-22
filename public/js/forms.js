// Linely web — persona editor + group creation
import { h, uid } from './lib.js';
import { ent, loadEntitlement, redeemDialog } from './entitlement.js';
import { icon } from './icons.js';
import { S, get, touch, personas, groups, findPersona, addMediaFromFile, toast } from './state.js';
import { PROVIDERS, defaultModel } from './lib.js';
import { nav, go, goBack, registerView, avatarEl, field, chips, btn, pickFile } from './core.js';

/** A character drafted elsewhere (doc import, gallery) waiting for the editor to open. */
export const prefill = { data: null };

const bar = (title) => h('div', { class: 'lt-header', style: 'display:flex;align-items:center;gap:12px;padding-bottom:8px' },
  h('button', { class: 'circle-btn glass s2 bounce', 'aria-label': '返回', onClick: () => goBack() }, icon('left', 24)),
  h('h2', { style: 'margin:0;font-size:20px;color:var(--wall-ink)' }, title));

function editorView() {
  const existing = nav.id ? findPersona(nav.id) : null;
  const pre = !existing && prefill.data ? prefill.data : null; prefill.data = null;

  const d = {
    name: existing ? existing.name : pre ? pre.name || '' : '', bio: existing ? existing.bio || '' : pre ? pre.bio || '' : '', persona: existing ? existing.persona || '' : pre ? pre.persona || '' : '',
    provider: existing ? existing.provider || 'DeepSeek' : pre && pre.provider || 'DeepSeek', baseUrl: existing ? existing.baseUrl || '' : pre && pre.baseUrl || '', model: existing ? existing.model || defaultModel(existing.provider || 'DeepSeek') : pre && pre.model || defaultModel('DeepSeek'),
    apiKey: pre && pre.apiKey || '', useFreeApi: !!(existing ? existing.useFreeApi : pre && pre.useFreeApi), gender: existing ? existing.gender || '其他' : pre && pre.gender || '其他', relation: existing ? existing.relationship || '朋友' : pre && pre.relation || '朋友',
    likes: existing ? existing.likes || '' : pre && pre.likes || '', dislikes: existing ? existing.dislikes || '' : pre && pre.dislikes || '', hobbies: existing ? existing.hobbies || '' : pre && pre.hobbies || '', avatar: existing ? existing.avatar || '' : pre && pre.avatar || '',
  };
  const input = (key, type = 'text') => { const el = h('input', { type, autocomplete: 'off', value: d[key] }); el.addEventListener('input', () => { d[key] = el.value; }); return el; };
  const area = (key, rows) => { const el = h('textarea', { rows }); el.value = d[key]; el.addEventListener('input', () => { d[key] = el.value; }); return el; };
  const avatarBox = h('div');
  const drawAvatar = () => avatarBox.replaceChildren(h('button', { class: 'bounce', onClick: pick }, avatarEl(d.avatar, d.name, 72)));
  const pick = () => pickFile('image/*', async (f) => { try { d.avatar = await addMediaFromFile(f, 512); drawAvatar(); } catch (e) { toast(e.message); } });
  const modelEl = input('model'), baseUrlEl = input('baseUrl'), hintEl = h('div', { class: 'hint' });
  baseUrlEl.placeholder = 'https://你的中转站域名/v1';
  const baseUrlField = field('第三方中转站 Base URL（仅 OpenAI 兼容接口）', baseUrlEl); baseUrlField.hidden = d.provider !== '第三方中转站 / OpenAI兼容';
  const drawHint = () => { hintEl.textContent = `默认模型：${defaultModel(d.provider)}。豆包需使用控制台中实际可用的模型或接入点 ID。`; };
  const relInput = input('relation');
  const keyEl = input('apiKey', 'password'); keyEl.placeholder = existing ? '留空保持原密钥' : '';
  const personaArea = area('persona', 3);
  const personaImport = btn('从 TXT 导入人设', () => pickFile('.txt,text/plain', async (f) => { try { d.persona = await f.text(); personaArea.value = d.persona; toast('人设文本已载入，请检查后保存'); } catch (e) { toast('读取 TXT 失败：' + e.message); } }), '', 'file');
  const freeWrap = h('div');
  function drawFree() {
    const locked = !ent.unlocked;
    const label = locked ? '免费 API · 需激活码' : d.useFreeApi ? '已选择：免费 API' : '免费 API（已解锁）';
    freeWrap.replaceChildren(btn(label, onFreeTap, locked ? 'locked' : '', locked ? 'lock' : 'unlock'),
      locked ? h('div', { class: 'hint', style: 'margin:4px 2px 0' }, '输入管理员发的激活码后即可免费使用，到「我的」或点上面的按钮兑换。') : null);
  }
  async function onFreeTap() {
    if (!ent.loaded) await loadEntitlement();
    if (!ent.unlocked) return redeemDialog(() => { drawFree(); toast(ent.enabled ? '已解锁，现在可以选择免费 API 了' : '已解锁；管理员配置好免费 API 后就能使用'); });
    if (!ent.enabled) return toast('管理员尚未配置免费 API');
    d.useFreeApi = !d.useFreeApi; keyEl.disabled = d.useFreeApi; drawFree();
    toast(d.useFreeApi ? '本角色将使用站点免费 API' : '已切换为自带 API Key');
  }
  drawFree(); loadEntitlement().then(drawFree);
  keyEl.disabled = d.useFreeApi;
  const err = h('div', { style: 'color:#d14343;font-size:14px;margin-top:8px' });
  const card = h('div', { class: 'card big glass s2' },
    h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:6px' }, avatarBox, btn('从相册选择头像', pick, '', 'image')),
    field('名字 *', input('name')), field('简介', area('bio', 2)), field('人设 *', personaArea), personaImport,
    h('b', { style: 'display:block;margin-top:10px' }, 'AI 服务商'),
    chips(PROVIDERS, d.provider, (v) => { if (v !== d.provider) { d.apiKey = ''; keyEl.value = ''; } d.provider = v; d.model = defaultModel(v); modelEl.value = d.model; baseUrlField.hidden = v !== '第三方中转站 / OpenAI兼容'; drawHint(); }),
    field('模型名称 / 豆包接入点 ID', modelEl), baseUrlField, hintEl,
    field(existing ? `更新 API Key（留空保持原密钥）` : 'API Key *', keyEl), freeWrap,
    h('div', { class: 'hint' }, existing ? '编辑资料不会删除现有聊天记录。API Key 留空会保留原密钥。' : '必须填写可用的 API Key 才能创建此 AI。费用和额度由 API 服务商决定；密钥只保存在本浏览器。'),
    h('b', { style: 'display:block;margin-top:10px' }, '性别'), chips(['男', '女', '其他'], d.gender, (v) => { d.gender = v; }),
    h('b', { style: 'display:block;margin-top:10px' }, '与你的关系'), chips(['家人', '情侣', '哥哥', '弟弟', '朋友', '亲戚'], d.relation, (v) => { d.relation = v; relInput.value = v; }),
    field('自定义关系（可直接输入）', relInput),
    h('b', { style: 'display:block;margin-top:14px' }, '选填：角色偏好'), field('喜欢什么', area('likes', 2)), field('讨厌什么', area('dislikes', 2)), field('爱好', area('hobbies', 2)), err);
  drawAvatar(); drawHint();
  const save = btn(existing ? '保存修改' : '创建 AI', () => {
    const name = d.name.trim(), persona = d.persona.trim(), key = d.apiKey.trim();
    if (!name) return (err.textContent = '请填写名字');
    if (!persona) return (err.textContent = '请填写人设');
    if (!existing && !key && !d.useFreeApi) return (err.textContent = '请填写 API Key，或选择免费 API');
    if (existing) {
      Object.assign(existing, { name, bio: d.bio.trim(), persona, gender: d.gender, relationship: d.relation.trim() || '朋友', likes: d.likes, dislikes: d.dislikes, hobbies: d.hobbies, avatar: d.avatar, provider: d.provider, baseUrl: d.baseUrl.trim(), model: d.model.trim() || defaultModel(d.provider), useFreeApi: d.useFreeApi });
      if (key) existing.apiKey = key;
    } else {
      personas().push({ id: String(Date.now()), name, bio: d.bio.trim(), persona, gender: d.gender, relationship: d.relation.trim() || '朋友', likes: d.likes, dislikes: d.dislikes, hobbies: d.hobbies, avatar: d.avatar, provider: d.provider, baseUrl: d.baseUrl.trim(), model: d.model.trim() || defaultModel(d.provider), apiKey: key, useFreeApi: d.useFreeApi, messages: [] });
    }
    touch(); toast(existing ? '已保存' : `已创建「${name}」`); goBack();
  }, 'primary');
  save.style.margin = '12px 0';
  const publish = btn('发布到人设广场', async () => { const payload={name:d.name.trim(),bio:d.bio.trim(),persona:d.persona.trim(),avatar:d.avatar,provider:d.provider,model:d.model,likes:d.likes,dislikes:d.dislikes,hobbies:d.hobbies,gender:d.gender,relationship:d.relation}; if(!payload.name||!payload.persona)return toast('请先填写名字和人设'); try{const r=await fetch('/api/plaza',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();if(!r.ok)throw new Error(j.error||'发布失败');toast('已发布到人设广场');}catch(e){toast('发布失败：'+e.message);} }, 'secondary'); publish.style.margin='0 0 18px';
  return { el: h('div', { class: 'screen' }, bar(existing ? '编辑 AI 人设' : '创建 AI 人设'), h('div', { class: 'scroll' }, h('div', { class: 'pad' }, card, save, publish))) };
}
registerView('editor', editorView);

function groupCreateView() {
  let name = '', selected = new Set();
  const nameEl = h('input', { type: 'text', placeholder: '群聊名称', autocomplete: 'off' });
  nameEl.addEventListener('input', () => { name = nameEl.value; });
  const list = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  const draw = () => list.replaceChildren(...personas().map((p) => h('button', { class: 'pr glass s2 bounce soft', style: 'text-align:left;width:100%', onClick: () => { if (selected.has(p.id)) selected.delete(p.id); else if (selected.size < 8) selected.add(p.id); draw(); createBtn.firstChild && (createBtn.lastChild.textContent = `创建群聊 · ${selected.size} 个 AI`); } },
    avatarEl(p.avatar, p.name, 46), h('div', { style: 'flex:1;min-width:0' }, h('b', null, p.name), h('small', null, p.persona || '')), h('span', { class: 'switch' + (selected.has(p.id) ? ' on' : ''), style: 'pointer-events:none' }))));
  const createBtn = btn('创建群聊 · 0 个 AI', () => {
    if (!name.trim() || !selected.size) return toast('请填写群聊名称，并至少选择一个 AI');
    groups().push({ id: uid(), name: name.trim(), memberIds: [...selected], messages: [] });
    touch(); nav.tab = 'chat'; nav.mode = '群聊'; nav.keepTab = true; goBack();
  }, 'primary');
  draw();
  return { el: h('div', { class: 'screen' }, bar('创建群聊'), h('div', { class: 'scroll' }, h('div', { class: 'pad' }, field('群聊名称', nameEl), h('div', { class: 'secttl' }, '选择你创建的 AI（每人每轮最多回复一次，最多 8 个）'), list, createBtn))) };
}
registerView('groupCreate', groupCreateView);
