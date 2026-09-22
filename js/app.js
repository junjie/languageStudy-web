/* Boot and tab switching. */

import * as store from './store.js';
import * as settings from './tab-settings.js';
import * as flashcards from './tab-flashcards.js';
import * as typing from './tab-typing.js';
import * as dictation from './tab-dictation.js';

const TABS = {
  settings: { module: settings },
  flashcards: { module: flashcards },
  typing: { module: typing },
  dictation: { module: dictation },
};

function show(name) {
  for (const [key] of Object.entries(TABS)) {
    document.getElementById('panel-' + key).hidden = key !== name;
    document.getElementById('tab-' + key).setAttribute('aria-selected', String(key === name));
  }
  try { localStorage.setItem('lsw.tab', name); } catch (e) { /* ignore */ }
  const mod = TABS[name].module;
  if (mod.onShow) mod.onShow();
}

function wireTabs() {
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) show(btn.dataset.tab);
  });

  /* Arrow keys walk the tab strip, as a tablist should. */
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const names = Object.keys(TABS);
    const here = names.findIndex((n) => document.getElementById('tab-' + n).getAttribute('aria-selected') === 'true');
    const next = names[(here + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length];
    show(next);
    document.getElementById('tab-' + next).focus();
  });
}

function wireTheme() {
  const btn = document.getElementById('theme-btn');
  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    btn.textContent = theme === 'dark' ? 'Light' : 'Dark';
  };
  apply(store.state.settings.theme === 'light' ? 'light' : 'dark');
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(next);
    store.saveSettings({ theme: next });
  });
  store.subscribe('settings', (s) => apply(s.settings.theme === 'light' ? 'light' : 'dark'));
}

async function boot() {
  store.bootLocal();
  wireTabs();
  wireTheme();

  for (const { module } of Object.values(TABS)) module.init();

  let start = 'settings';
  try { start = localStorage.getItem('lsw.tab') || 'settings'; } catch (e) { /* ignore */ }
  show(TABS[start] ? start : 'settings');

  /* Last, because it may adopt a folder and re-render everything. */
  await settings.restoreFolder();
}

boot();
