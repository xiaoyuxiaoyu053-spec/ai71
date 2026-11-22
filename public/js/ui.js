// Linely web — entry point
import { loadState, flushSave, get } from './state.js';
import { initSfx, unlockAudio } from './lib.js';
import { persistRequest } from './lib.js';
import { initRouter, mount, nav } from './core.js';
import './home.js';
import './chat.js';
import './forms.js';
import './music.js';
import './themes.js';
import './gallery.js';
import './memes.js';
import { syncAutoPost } from './logic.js';
import { loadEntitlement } from './entitlement.js';
import { initAnnouncements } from './announcements.js';

async function boot() {
  await loadState();
  loadEntitlement(); initAnnouncements();
  // old bookmarks (/music.html, /themes.html) redirect to /#music and /#themes
  const hashId = location.hash.slice(1);
  if (hashId === 'music' || hashId === 'themes') nav.page = hashId;
  else if (['chat', 'feed', 'add', 'me'].includes(hashId)) nav.tab = hashId;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  initRouter();
  mount();
  syncAutoPost();
  persistRequest();
  initSfx();
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('pagehide', () => { flushSave(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
}
boot().catch((e) => { document.body.textContent = '启动失败：' + (e && e.message); console.error(e); });
