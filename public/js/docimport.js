// Linely web — import a character setting from a document (TXT / MD / JSON / DOCX).
// The text is read in the browser; an AI model (free API, or the key of a character you already made)
// turns it into name / bio / persona / likes…, and the result opens in the editor for review.
import { h } from './lib.js';
import { icon } from './icons.js';
import { get, personas, toast } from './state.js';
import { replyDetailed, defaultModel } from './lib.js';
import { go, modal, pickFile, chips } from './core.js';
import { prefill } from './forms.js';

const MAX_CHARS = 24000;

// ───────────── reading files ─────────────
async function inflateRaw(bytes) {
  if (!window.DecompressionStream) throw new Error('当前浏览器不支持读取 DOCX，请改用 TXT / MD，或升级浏览器');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function readDocx(file) {
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('这不是有效的 DOCX 文件');
  let p = dv.getUint32(eocd + 16, true); const n = dv.getUint16(eocd + 10, true), dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    if (name === 'word/document.xml') {
      const lh = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), raw = buf.subarray(lh, lh + csize);
      const xml = dec.decode(method === 0 ? raw : await inflateRaw(raw));
      return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error('DOCX 里没有找到正文');
}
export async function extractDocText(file) {
  const name = file.name.toLowerCase();
  if (/\.docx$/.test(name)) return (await readDocx(file)).trim();
  if (/\.(pdf|doc|pages|rtf)$/.test(name)) throw new Error('暂不支持这种格式，请另存为 TXT、MD 或 DOCX 后再导入');
  return (await file.text()).replace(/^\uFEFF/, '').trim();
}

// ───────────── turning text into a character ─────────────
const LABELS = {
  name: /^(?:名字|姓名|名称|角色名|角色|name)\s*[:：]\s*(.+)$/i, bio: /^(?:简介|介绍|一句话介绍|bio|summary)\s*[:：]\s*(.+)$/i,
  gender: /^(?:性别|gender)\s*[:：]\s*(.+)$/i, relation: /^(?:关系|与我的关系|relationship)\s*[:：]\s*(.+)$/i,
  likes: /^(?:喜欢|喜好|likes?)\s*[:：]\s*(.+)$/i, dislikes: /^(?:讨厌|厌恶|不喜欢|dislikes?)\s*[:：]\s*(.+)$/i, hobbies: /^(?:爱好|兴趣|hobbies|hobby)\s*[:：]\s*(.+)$/i,
};
/** No-AI fallback: JSON character cards and "字段：值" lines. */
export function parseLocally(text, fileName = '') {
  const out = { name: '', bio: '', persona: '', gender: '其他', relation: '朋友', likes: '', dislikes: '', hobbies: '' };
  try {
    const j = JSON.parse(text), c = j.data || j;
    if (c && typeof c === 'object') {
      out.name = String(c.name || c.char_name || '').trim();
      out.bio = String(c.bio || c.creator_notes || c.tagline || '').trim();
      out.persona = [c.description, c.personality, c.scenario, c.persona, c.system_prompt].filter(Boolean).join('\n\n').trim();
      if (c.first_mes) out.persona += (out.persona ? '\n\n' : '') + '开场白参考：' + c.first_mes;
      if (out.name || out.persona) return out;
    }
  } catch { /* not JSON */ }
  const rest = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*#\-•·]+/, '').trim(); let hit = false;
    for (const [k, re] of Object.entries(LABELS)) { const m = re.exec(line); if (m && !out[k]) { out[k] = m[1].trim(); hit = true; break; } }
    const pm = /^(?:人设|性格|设定|背景|persona|description)\s*[:：]\s*(.*)$/i.exec(line);
    if (pm) { rest.push(pm[1]); hit = true; }
    if (!hit && line) rest.push(raw.trim());
  }
  out.persona = rest.join('\n').trim() || text;
  if (!out.name) { const first = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''; out.name = (first.length <= 20 ? first : fileName.replace(/\.[^.]+$/, '')) || '新角色'; }
  if (!['男', '女'].includes(out.gender)) out.gender = '其他';
  return out;
}
const SYSTEM = `你是「角色设定整理助手」。用户会给你一份文档，里面描述了一个聊天角色。请只依据文档内容，整理成 JSON，不要编造文档里没有的事实。
只输出一个 JSON 对象，不要 Markdown、不要解释，键如下：
{"name":"角色名","bio":"一句话简介(30字内)","persona":"完整人设：性格、说话风格、背景、与用户的相处方式、禁忌，用第二人称'你是…'写成可直接作为系统提示词的文字，保留文档原有的细节与语气","gender":"男|女|其他","relation":"家人|情侣|哥哥|弟弟|朋友|亲戚 之一，或文档中的自定义关系","likes":"喜欢的事物","dislikes":"讨厌的事物","hobbies":"爱好"}
文档没写的字段给空字符串。`;
function parseAiJson(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || '')); if (!m) throw new Error('AI 没有返回有效结果');
  const j = JSON.parse(m[0]);
  const s = (v) => String(v == null ? '' : v).trim();
  return { name: s(j.name), bio: s(j.bio), persona: s(j.persona), gender: ['男', '女'].includes(j.gender) ? j.gender : '其他', relation: s(j.relation) || '朋友', likes: s(j.likes), dislikes: s(j.dislikes), hobbies: s(j.hobbies) };
}

// ───────────── dialog ─────────────
async function freeApiEnabled() { try { const r = await fetch('/api/free-config', { cache: 'no-store' }); const c = await r.json(); return !!(r.ok && c.enabled && c.unlocked); } catch { return false; } }

export function importDocFlow() {
  pickFile('.txt,.md,.markdown,.json,.docx,.csv,text/plain', async (file) => {
    let text;
    try { text = await extractDocText(file); } catch (e) { toast(e.message || '读取文档失败'); return; }
    if (!text) { toast('文档里没有可用的文字'); return; }
    const free = await freeApiEnabled();
    const engines = [];
    if (free) engines.push({ label: '站点免费 API', cfg: { provider: 'DeepSeek', model: defaultModel('DeepSeek'), useFreeApi: true, apiKey: '', baseUrl: '' } });
    for (const p of personas()) if (p.useFreeApi ? free : p.apiKey) engines.push({ label: `用「${p.name}」的 API`, cfg: { provider: p.provider || 'DeepSeek', model: p.model || defaultModel(p.provider || 'DeepSeek'), useFreeApi: !!p.useFreeApi, apiKey: p.apiKey || '', baseUrl: p.baseUrl || '' } });
    engines.push({ label: '本地规则（不用 AI）', cfg: null });
    let pick = engines[0];
    const truncated = text.length > MAX_CHARS;
    const note = h('div', { class: 'hint', style: 'margin:6px 0 0' });
    const dlg = modal({
      title: '从文档导入角色设定',
      body: [
        h('div', { class: 'doc-card glass s2' }, icon('doc', 28), h('div', null, h('b', null, file.name), h('small', null, `${text.length.toLocaleString()} 字${truncated ? `（只读取前 ${MAX_CHARS.toLocaleString()} 字）` : ''}`))),
        h('p', { style: 'margin:12px 0 6px' }, '选择由谁来整理这份文档：'),
        chips(engines.map((e) => e.label), pick.label, (v) => { pick = engines.find((e) => e.label === v); note.textContent = pick.cfg ? 'AI 会读取文档并整理成角色资料，约消耗一次对话的额度。' : '只识别「名字：」「人设：」这类字段和 JSON 角色卡，识别不到的内容会整体放进人设。'; }),
        note],
      actions: [{ label: '取消' }, { label: '开始导入', kind: 'p', onClick: async () => {
        let data, usedAi = false;
        if (pick.cfg) {
          toast('正在让 AI 整理文档，请稍候…');
          try {
            const r = await replyDetailed({ ...pick.cfg, system: SYSTEM, history: [{ role: 'user', content: text.slice(0, MAX_CHARS) }], direct: !!get('directMode') });
            data = parseAiJson(r.text); usedAi = true;
          } catch (e) { toast('AI 整理失败，已改用本地规则：' + (e.message || e)); }
        }
        if (!data) data = parseLocally(text, file.name);
        if (!data.persona) data.persona = text.slice(0, 6000);
        prefill.data = { ...data, ...(pick.cfg ? { provider: pick.cfg.provider, model: pick.cfg.model, baseUrl: pick.cfg.baseUrl, apiKey: pick.cfg.apiKey, useFreeApi: pick.cfg.useFreeApi } : {}) };
        toast(usedAi ? '已整理好，请检查后保存' : '已导入，请检查后保存');
        go('editor', { id: '' });
      } }],
    });
    note.textContent = pick.cfg ? 'AI 会读取文档并整理成角色资料，约消耗一次对话的额度。' : '只识别「名字：」「人设：」这类字段和 JSON 角色卡。';
    void dlg;
  });
}
