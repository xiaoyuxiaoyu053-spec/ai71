// Linely web — 角色图鉴: characters people share, each with avatars drawn / chosen by different users.
import { h } from './lib.js';
import { icon } from './icons.js';
import { get, touch, personas, toast, mediaUrl, addMediaDataUrl } from './state.js';
import { go, goBack, registerView, modal, pickFile, menu, confirmDialog, chips, switchEl, btn } from './core.js';
import { prefill } from './forms.js';

async function api(path, body) {
  const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `请求失败（${r.status}）`);
  return j;
}
/** centre-crop any image to a small square JPEG so every avatar in the gallery has the same shape and a small size */
async function squareDataUrl(src, size = 256) {
  let bmp;
  if (typeof src === 'string') { const im = new Image(); im.src = src; await im.decode(); bmp = await createImageBitmap(im); } // data URLs can't be fetch()ed under our CSP
  else bmp = await createImageBitmap(src);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas'); c.width = c.height = size;
  c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  let q = 0.86, out = c.toDataURL('image/jpeg', q);
  while (out.length > 140000 && q > 0.4) { q -= 0.12; out = c.toDataURL('image/jpeg', q); }
  return out;
}
const imgEl = (src, cls = '') => { const i = h('img', { class: cls, alt: '', loading: 'lazy', draggable: 'false' }); i.src = src; return i; };

function galleryView() {
  let list = null, detail = null, q = '', err = '';
  const root = h('div', { class: 'screen gallery' });
  const title = h('h2', { style: 'margin:0;font-size:20px;color:var(--wall-ink)' }, '角色图鉴');
  const back = h('button', { class: 'circle-btn glass s2 bounce', 'aria-label': '返回', onClick: () => { if (detail) { detail = null; draw(); } else goBack(); } }, icon('left', 24));
  const header = h('div', { class: 'lt-header', style: 'display:flex;align-items:center;gap:12px;padding-bottom:8px' }, back, title);
  const pad = h('div', { class: 'pad', style: 'padding-top:4px' });
  root.append(header, h('div', { class: 'scroll' }, pad));

  async function loadList() { try { list = await api('/api/gallery'); err = ''; } catch (e) { err = e.message; list = []; } draw(); }
  async function openDetail(id) { try { detail = await api('/api/gallery/' + id); draw(); root.querySelector('.scroll').scrollTo({ top: 0 }); } catch (e) { toast(e.message); } }

  // ── list ──
  function drawList() {
    title.textContent = '角色图鉴';
    const search = h('input', { type: 'search', placeholder: '搜索角色', value: q, autocomplete: 'off', 'aria-label': '搜索角色' });
    search.addEventListener('input', () => { q = search.value; drawGrid(); });
    const grid = h('div', { class: 'gal-grid' });
    const drawGrid = () => {
      const items = (list || []).filter((c) => !q.trim() || (c.name + c.bio + c.author).toLowerCase().includes(q.trim().toLowerCase()));
      grid.replaceChildren(...(items.length ? items.map((c) => h('button', { class: 'gal-card glass s2 bounce soft', onClick: () => openDetail(c.id) },
        h('div', { class: 'gal-cover' + (c.avatars.length < 2 ? ' one' : '') }, ...c.avatars.slice(0, 4).map((a) => imgEl(a.image))),
        h('b', null, c.name), h('small', null, `${c.avatarCount} 张头像 · ${c.author}`), c.mine ? h('span', { class: 'chip' }, '我发布的') : null))
        : [h('div', { class: 'hint', style: 'grid-column:1/-1;text-align:center;padding:26px 0' }, err || (list ? '还没有角色，成为第一个发布的人吧' : '加载中…'))]));
    };
    pad.replaceChildren(
      h('div', { class: 'hint', style: 'margin:0 4px 10px' }, '发布你的角色，也可以为别人的角色投稿头像——每个角色都会收集到大家做的不同头像。'),
      h('div', { class: 'row-btns' }, btn('发布我的角色', publishDialog, 'primary', 'add')),
      h('div', { style: 'margin:12px 0 10px' }, search), grid);
    drawGrid();
  }

  // ── detail ──
  function drawDetail() {
    const c = detail; title.textContent = c.name;
    const grid = h('div', { class: 'gal-avatars' }, ...c.avatars.map((a) => h('button', { class: 'gal-av bounce', 'aria-label': `${a.author} 的头像`, onClick: (e) => avatarMenu(e.currentTarget, a) }, imgEl(a.image), h('span', null, a.author + (a.mine ? '（我）' : '')))));
    pad.replaceChildren(
      h('div', { class: 'gal-hero glass s2' }, h('div', { class: 'gal-hero-av' }, c.avatars[0] ? imgEl(c.avatars[0].image) : null), h('div', { style: 'flex:1;min-width:0' }, h('b', { style: 'font-size:19px' }, c.name), h('small', { style: 'display:block;color:var(--muted);margin-top:3px' }, `发布者 ${c.author}`), c.bio ? h('p', { style: 'margin:8px 0 0;font-size:14px;line-height:1.5' }, c.bio) : null)),
      h('div', { class: 'row-btns' }, btn('投稿我的头像', contributeFlow, 'primary', 'image'), c.persona ? btn('导入这个角色', importCharacter, '', 'personAdd') : null),
      c.mine ? btn('删除这个角色', async () => { if (await confirmDialog('删除角色？', '角色和所有人为它投稿的头像都会从图鉴中移除。', '删除')) { try { await api(`/api/gallery/${c.id}/delete`, {}); detail = null; toast('已删除'); await loadList(); } catch (e) { toast(e.message); } } }, 'danger', 'del') : null,
      h('div', { class: 'secttl', style: 'margin-top:14px' }, `大家为 TA 做的头像 · ${c.avatars.length}`), grid);
  }
  function avatarMenu(anchor, a) {
    const items = [
      { label: '设为我的角色头像', onClick: () => useAvatar(anchor, a) },
      { label: '放大查看', onClick: () => modal({ title: `${a.author} 的头像`, body: [h('div', { class: 'gal-big' }, imgEl(a.image)), a.note ? h('p', { style: 'text-align:center' }, a.note) : null], actions: [{ label: '关闭', kind: 'p' }] }) },
      { label: '保存到相册', onClick: () => { const l = h('a', { href: a.image, download: `${detail.name}-${a.author}.jpg` }); document.body.append(l); l.click(); l.remove(); } },
    ];
    if (a.mine || detail.mine) items.push({ label: '删除', danger: true, onClick: async () => { try { await api(`/api/gallery/${detail.id}/avatars/${a.id}/delete`, {}); await openDetail(detail.id); toast('已删除'); } catch (e) { toast(e.message); } } });
    menu(anchor, items);
  }
  function useAvatar(anchor, a) {
    const ps = personas();
    if (!ps.length) { toast('你还没有 AI 角色，先创建一个吧'); return; }
    menu(anchor, ps.map((p) => ({ label: `给「${p.name}」使用`, onClick: async () => { p.avatar = await addMediaDataUrl(a.image); touch(); toast(`已更新「${p.name}」的头像`); } })));
  }
  async function importCharacter() {
    const c = detail, first = c.avatars[0];
    prefill.data = { name: c.name, bio: c.bio, persona: c.persona, avatar: first ? await addMediaDataUrl(first.image) : '' };
    toast('已载入角色设定，补上 API Key 就能创建');
    go('editor', { id: '' });
  }
  function contributeFlow() {
    pickFile('image/*', async (f) => {
      let img; try { img = await squareDataUrl(f); } catch { toast('无法读取这张图片'); return; }
      const note = h('input', { type: 'text', placeholder: '想说点什么？（选填，例如「古风版」）', maxlength: '80', autocomplete: 'off' });
      modal({ title: `为「${detail.name}」投稿头像`, body: [h('div', { class: 'gal-big' }, imgEl(img)), note], actions: [{ label: '取消' }, { label: '投稿', kind: 'p', onClick: async () => {
        try { await api(`/api/gallery/${detail.id}/avatars`, { image: img, note: note.value.trim() }); toast('投稿成功'); await openDetail(detail.id); } catch (e) { toast(e.message); return false; }
      } }] });
    });
  }
  function publishDialog() {
    const ps = personas();
    const st = { pid: ps[0] ? ps[0].id : '', img: '', share: false };
    const preview = h('div', { class: 'gal-big' });
    const loadFromPersona = async () => { st.img = ''; const p = ps.find((x) => x.id === st.pid), u = p && mediaUrl(p.avatar); if (u && u.startsWith('data:')) { try { st.img = await squareDataUrl(u); } catch { /* use picker */ } } drawPrev(); };
    const drawPrev = () => preview.replaceChildren(st.img ? imgEl(st.img) : h('div', { class: 'hint', style: 'padding:30px 0;text-align:center' }, ps.length ? '这个角色还没有头像，请选择一张' : '先去创建一个 AI 角色，或直接选一张图片'));
    const nameIn = h('input', { type: 'text', placeholder: '角色名称', maxlength: '60', autocomplete: 'off', value: ps[0] ? ps[0].name : '' });
    const bioIn = h('input', { type: 'text', placeholder: '一句话简介（选填）', maxlength: '240', autocomplete: 'off', value: ps[0] ? ps[0].bio || '' : '' });
    const sync = () => { const p = ps.find((x) => x.id === st.pid); if (p) { nameIn.value = p.name; bioIn.value = p.bio || ''; } loadFromPersona(); };
    const body = [];
    if (ps.length) body.push(h('b', null, '选择我的角色'), chips(ps.map((p) => p.name), ps[0].name, (n) => { st.pid = ps.find((p) => p.name === n).id; sync(); }));
    body.push(preview, btn('换一张头像', () => pickFile('image/*', async (f) => { try { st.img = await squareDataUrl(f); drawPrev(); } catch { toast('无法读取这张图片'); } }), 'inline', 'image'),
      h('label', { class: 'fld' }, h('span', null, '名称'), nameIn), h('label', { class: 'fld' }, h('span', null, '简介'), bioIn),
      h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', null, '同时分享人设'), h('small', null, '别人可以一键导入这个角色的设定（不含 API Key）')), switchEl(false, (v) => { st.share = v; })));
    modal({ title: '发布角色', body, actions: [{ label: '取消' }, { label: '发布', kind: 'p', onClick: async () => {
      const p = ps.find((x) => x.id === st.pid), name = nameIn.value.trim();
      if (!name) { toast('请填写角色名称'); return false; }
      if (!st.img) { toast('请先选择一张头像'); return false; }
      try { const r = await api('/api/gallery', { name, bio: bioIn.value.trim(), avatar: st.img, sharePersona: st.share, persona: st.share && p ? p.persona || '' : '' }); toast('已发布到角色图鉴'); await loadList(); await openDetail(r.id); }
      catch (e) { toast(e.message); return false; }
    } }] });
    loadFromPersona();
  }

  function draw() { if (detail) drawDetail(); else drawList(); }
  return { el: root, afterMount: loadList, update() {} };
}
registerView('gallery', galleryView);
