import { countries as rawCountries } from './countries.js';

const STORAGE_KEY = 'worldcards-state-v1';
const SIMILARITY_MIN = 0.7;
const STREAK_TO_LEARNED = 2;

const QUESTION_TYPES = ['country_capital', 'flag_capital', 'fact_capital', 'capital_country'];

function hashId(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'c' + (h >>> 0).toString(36);
}

const countries = rawCountries.map((c) => ({
  ...c,
  id: hashId(`${c.name}|${c.capital}|${c.flag}|${c.fact}`),
}));

function defaultState() {
  return {
    countries: {},
    settings: {
      theme: 'light',
      sound: true,
      volume: 0.8,
      vibration: true,
    },
    stats: {
      correct: 0,
      wrong: 0,
    },
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const base = defaultState();
    return {
      countries: { ...base.countries, ...parsed.countries },
      settings: { ...base.settings, ...parsed.settings },
      stats: { ...base.stats, ...parsed.stats },
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getProgress(state, id) {
  if (!state.countries[id]) {
    state.countries[id] = { status: 'new', correctStreak: 0, errors: 0 };
  }
  return state.countries[id];
}

function normalizeAnswer(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/ё/g, 'е');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

function answerSimilarity(userRaw, expectedRaw) {
  const u = normalizeAnswer(userRaw);
  const e = normalizeAnswer(expectedRaw);
  if (!u.length && !e.length) return 1;
  if (!u.length || !e.length) return 0;
  const d = levenshtein(u, e);
  const maxLen = Math.max(u.length, e.length);
  return (maxLen - d) / maxLen;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let state = loadState();
let view = 'study';
let studyQueue = [];
let studyIndex = 0;
let repeatSessionStreak = 0;

let repeatCurrent = null;
let repeatHintStep = 0;

const els = {
  topbarTitle: document.getElementById('topbar-title'),
  topbarAction: document.getElementById('topbar-action'),
  btnMenu: document.getElementById('btn-menu'),
  viewStudy: document.getElementById('view-study'),
  viewRepeat: document.getElementById('view-repeat'),
  cardSlot: document.getElementById('card-slot'),
  studyProgress: document.getElementById('study-progress'),
  repeatCard: document.getElementById('repeat-card'),
  repeatInput: document.getElementById('repeat-input'),
  repeatForm: document.getElementById('repeat-form'),
  btnCheck: document.getElementById('btn-check'),
  btnHint: document.getElementById('btn-hint'),
  hintLine: document.getElementById('hint-line'),
  repeatStreak: document.getElementById('repeat-streak'),
  drawer: document.getElementById('drawer'),
  drawerOverlay: document.getElementById('drawer-overlay'),
  drawerClose: document.getElementById('drawer-close'),
  setSound: document.getElementById('set-sound'),
  setVolume: document.getElementById('set-volume'),
  setVibration: document.getElementById('set-vibration'),
  btnReset: document.getElementById('btn-reset'),
  btnExport: document.getElementById('btn-export'),
  btnImport: document.getElementById('btn-import'),
  statsList: document.getElementById('stats-list'),
};

let audioCtx = null;

function getAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

function playTone(freq, duration, type = 'sine', vol = 0.12) {
  if (!state.settings.sound) return;
  const ctx = getAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const v = (state.settings.volume ?? 0.8) * vol;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = v;
  osc.connect(gain);
  gain.connect(ctx.destination);
  const t = ctx.currentTime;
  osc.start(t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.stop(t + duration + 0.02);
}

function soundCorrect() {
  playTone(880, 0.12, 'sine', 0.15);
  setTimeout(() => playTone(1320, 0.15, 'sine', 0.12), 60);
}

function soundWrong() {
  playTone(180, 0.25, 'sawtooth', 0.08);
}

function soundSwipe() {
  playTone(520, 0.06, 'triangle', 0.06);
}

function vibrate(pattern) {
  if (!state.settings.vibration || !navigator.vibrate) return;
  navigator.vibrate(pattern);
}

function applyTheme() {
  const t = state.settings.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.getElementById('meta-theme-color');
  if (meta) {
    meta.setAttribute('content', t === 'dark' ? '#1C1C1E' : '#F5F7FA');
  }
  document.querySelectorAll('input[name="theme"]').forEach((r) => {
    r.checked = r.value === t;
  });
}

function countByStatus(st) {
  let n = 0,
    l = 0,
    g = 0;
  for (const c of countries) {
    const p = getProgress(state, c.id);
    if (p.status === 'new') n++;
    else if (p.status === 'learning') l++;
    else g++;
  }
  return { new: n, learning: l, learned: g };
}

function remainingNotLearned() {
  return countries.filter((c) => getProgress(state, c.id).status !== 'learned').length;
}

function buildStudyQueue() {
  const notLearned = countries.filter((c) => getProgress(state, c.id).status !== 'learned');
  const news = notLearned.filter((c) => getProgress(state, c.id).status === 'new');
  const learn = notLearned.filter((c) => getProgress(state, c.id).status === 'learning');
  studyQueue = [...shuffle(news), ...shuffle(learn)];
  studyIndex = 0;
}

function buildRepeatPool() {
  return countries.filter((c) => {
    const s = getProgress(state, c.id).status;
    return s === 'learning' || s === 'learned';
  });
}

function pickRepeatQuestion() {
  const pool = buildRepeatPool();
  if (!pool.length) return null;
  const country = pool[Math.floor(Math.random() * pool.length)];
  const type = QUESTION_TYPES[Math.floor(Math.random() * QUESTION_TYPES.length)];
  let prompt = '';
  let expected = '';
  let label = '';

  switch (type) {
    case 'country_capital':
      label = 'Страна';
      prompt = country.name;
      expected = country.capital;
      break;
    case 'flag_capital':
      label = 'Флаг';
      prompt = country.flag;
      expected = country.capital;
      break;
    case 'fact_capital':
      label = 'Факт';
      prompt = country.fact;
      expected = country.capital;
      break;
    case 'capital_country':
      label = 'Столица';
      prompt = country.capital;
      expected = country.name;
      break;
    default:
      expected = country.capital;
      prompt = country.name;
  }

  return { country, type, label, prompt, expected };
}

function renderStats() {
  const { new: nw, learning, learned } = countByStatus();
  const total = countries.length;
  const attempts = state.stats.correct + state.stats.wrong;
  const pct = attempts ? Math.round((state.stats.correct / attempts) * 100) : 0;
  const errSum = Object.values(state.countries).reduce((s, p) => s + (p.errors || 0), 0);

  els.statsList.innerHTML = `
    <li>Всего стран: ${total}</li>
    <li>Изучено: ${learned}</li>
    <li>В процессе: ${learning}</li>
    <li>Не изучено: ${nw}</li>
    <li>% правильных ответов: ${pct}%</li>
    <li>Ошибок (всего): ${errSum}</li>
  `;
}

function updateStudyProgressBar() {
  const total = countries.length;
  const learned = countByStatus().learned;
  const pct = total ? (learned / total) * 100 : 0;
  els.studyProgress.style.width = `${pct}%`;
}

function setDrawer(open) {
  const d = els.drawer;
  const o = els.drawerOverlay;
  if (open) {
    d.classList.remove('hidden');
    o.classList.remove('hidden');
    requestAnimationFrame(() => {
      d.classList.add('open');
      o.classList.add('visible');
    });
    d.setAttribute('aria-hidden', 'false');
  } else {
    d.classList.remove('open');
    o.classList.remove('visible');
    d.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      d.classList.add('hidden');
      o.classList.add('hidden');
    }, 280);
  }
}

function syncSettingsUI() {
  els.setSound.checked = !!state.settings.sound;
  els.setVibration.checked = !!state.settings.vibration;
  els.setVolume.value = String(state.settings.volume ?? 0.8);
}

function showView(name) {
  view = name;
  const isStudy = name === 'study';
  els.viewStudy.classList.toggle('hidden', !isStudy);
  els.viewRepeat.classList.toggle('hidden', isStudy);

  if (isStudy) {
    els.topbarTitle.textContent = `Осталось: ${remainingNotLearned()} стран`;
    els.topbarAction.textContent = 'Повторить';
    buildStudyQueue();
    renderStudyCard();
    updateStudyProgressBar();
  } else {
    els.topbarTitle.textContent = 'Повторение';
    els.topbarAction.textContent = 'Изучать';
    repeatHintStep = 0;
    els.hintLine.classList.add('hidden');
    repeatCurrent = pickRepeatQuestion();
    renderRepeatCard();
    setTimeout(() => els.repeatInput.focus(), 200);
  }
}

function renderStudyCard() {
  els.cardSlot.innerHTML = '';
  if (studyIndex >= studyQueue.length) {
    const p = document.createElement('p');
    p.className = 'empty-msg';
    p.textContent =
      remainingNotLearned() === 0
        ? 'Все страны выучены. Загляните в повторение!'
        : 'Очередь изучения пуста. Закрепите «в процессе» в режиме повторения.';
    els.cardSlot.appendChild(p);
    els.topbarTitle.textContent = `Осталось: ${remainingNotLearned()} стран`;
    return;
  }

  const country = studyQueue[studyIndex];
  let capitalHidden = true;

  const card = document.createElement('div');
  card.className = 'study-card anim-in';
  card.innerHTML = `
    <div class="flag">${country.flag}</div>
    <h2 class="name">${escapeHtml(country.name)}</h2>
    <p class="capital hidden-capital">${escapeHtml(country.capital)}</p>
    <p class="fact">${escapeHtml(country.fact)}</p>
  `;
  const capEl = card.querySelector('.capital');

  card.addEventListener('click', () => {
    capitalHidden = !capitalHidden;
    capEl.classList.toggle('hidden-capital', capitalHidden);
  });

  attachSwipe(card, country);
  els.cardSlot.appendChild(card);
  els.topbarTitle.textContent = `Осталось: ${remainingNotLearned()} стран`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attachSwipe(card, country) {
  let startX = 0;
  let startY = 0;
  let curX = 0;
  let curY = 0;
  let tracking = false;
  const threshold = Math.min(100, window.innerWidth * 0.22);

  const onDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tracking = true;
    card.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startY = e.clientY;
    curX = curY = 0;
  };

  const onMove = (e) => {
    if (!tracking) return;
    curX = e.clientX - startX;
    curY = e.clientY - startY;
    const rot = curX * 0.05;
    card.style.transform = `translateX(${curX}px) translateY(${curY * 0.15}px) rotate(${rot}deg)`;
  };

  const finish = (e, committed) => {
    if (!tracking) return;
    tracking = false;
    try {
      card.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!committed) {
      card.style.transition = 'transform 0.25s ease';
      card.style.transform = '';
      setTimeout(() => {
        card.style.transition = '';
      }, 260);
    }
  };

  const onUp = (e) => {
    if (!tracking) return;
    if (Math.abs(curX) > threshold) {
      const dir = curX > 0 ? 1 : -1;
      card.classList.add('exiting');
      card.style.transition = 'transform 0.28s ease, opacity 0.28s ease';
      const off = dir * (window.innerWidth + 80);
      card.style.transform = `translateX(${off}px) rotate(${dir * 24}deg)`;
      card.style.opacity = '0';
      soundSwipe();

      const prog = getProgress(state, country.id);
      if (dir > 0) {
        if (prog.status === 'new') {
          prog.status = 'learned';
          prog.correctStreak = Math.max(prog.correctStreak || 0, STREAK_TO_LEARNED);
        }
      } else {
        prog.status = 'learning';
      }
      saveState(state);

      setTimeout(() => {
        studyIndex += 1;
        renderStudyCard();
        updateStudyProgressBar();
      }, 260);
      finish(e, true);
      return;
    }
    finish(e, false);
  };

  card.addEventListener('pointerdown', onDown);
  card.addEventListener('pointermove', onMove);
  card.addEventListener('pointerup', onUp);
  card.addEventListener('pointercancel', onUp);
}

function renderRepeatCard() {
  els.repeatCard.classList.remove('ok', 'bad');
  els.repeatInput.value = '';
  repeatHintStep = 0;
  els.hintLine.classList.add('hidden');

  if (!repeatCurrent) {
    els.repeatCard.innerHTML =
      '<p class="q-text">Добавьте карточки: свайпните «не уверен» в изучении или дождитесь режима повторения.</p>';
    els.repeatInput.disabled = true;
    els.btnCheck.disabled = true;
    els.btnHint.disabled = true;
    return;
  }

  els.repeatInput.disabled = false;
  els.btnCheck.disabled = false;
  els.btnHint.disabled = false;

  const { label, prompt, type } = repeatCurrent;
  const isFlag = type === 'flag_capital';
  els.repeatCard.innerHTML = `
    <span class="q-label">${escapeHtml(label)}</span>
    ${isFlag ? `<div class="q-flag">${prompt}</div>` : `<p class="q-text">${escapeHtml(prompt)}</p>`}
  `;
  els.repeatStreak.textContent = `Серия: ${repeatSessionStreak}`;
}

function flashRepeat(ok) {
  const el = els.repeatCard;
  el.classList.remove('ok', 'bad');
  void el.offsetWidth;
  el.classList.add(ok ? 'ok' : 'bad');
  setTimeout(() => el.classList.remove('ok', 'bad'), 650);
}

function submitRepeat() {
  if (!repeatCurrent) return;
  const user = els.repeatInput.value;
  const sim = answerSimilarity(user, repeatCurrent.expected);
  const ok = sim >= SIMILARITY_MIN;
  const prog = getProgress(state, repeatCurrent.country.id);

  if (ok) {
    soundCorrect();
    vibrate(15);
    state.stats.correct += 1;
    flashRepeat(true);
    repeatSessionStreak += 1;

    if (prog.status === 'learning') {
      prog.correctStreak = (prog.correctStreak || 0) + 1;
      if (prog.correctStreak >= STREAK_TO_LEARNED) {
        prog.status = 'learned';
      }
    } else if (prog.status === 'learned') {
      /* stays learned */
    }
  } else {
    soundWrong();
    vibrate([40, 30, 60]);
    state.stats.wrong += 1;
    prog.errors = (prog.errors || 0) + 1;
    prog.correctStreak = 0;
    if (prog.status === 'learned') {
      prog.status = 'learning';
    }
    flashRepeat(false);
    repeatSessionStreak = 0;
  }

  saveState(state);
  renderStats();

  setTimeout(() => {
    repeatCurrent = pickRepeatQuestion();
    renderRepeatCard();
    els.repeatInput.focus();
  }, ok ? 520 : 700);
}

function showHint() {
  if (!repeatCurrent) return;
  const exp = repeatCurrent.expected;
  repeatHintStep += 1;
  if (repeatHintStep === 1) {
    const ch = exp.trim().charAt(0);
    els.hintLine.textContent = `Первая буква: «${ch}»`;
  } else {
    const n = normalizeAnswer(exp).length;
    els.hintLine.textContent = `Длина ответа (без пробелов): ${n} символов`;
  }
  els.hintLine.classList.remove('hidden');
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'worldcards-progress.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== 'object') throw new Error('bad');
      const next = defaultState();
      if (data.countries && typeof data.countries === 'object') next.countries = data.countries;
      if (data.settings && typeof data.settings === 'object') next.settings = { ...next.settings, ...data.settings };
      if (data.stats && typeof data.stats === 'object') next.stats = { ...next.stats, ...data.stats };
      state = next;
      saveState(state);
      applyTheme();
      syncSettingsUI();
      renderStats();
      showView(view);
      setDrawer(false);
    } catch {
      alert('Не удалось импортировать файл.');
    }
  };
  reader.readAsText(file, 'utf-8');
}

els.topbarAction.addEventListener('click', () => {
  showView(view === 'study' ? 'repeat' : 'study');
});

els.btnMenu.addEventListener('click', () => {
  syncSettingsUI();
  renderStats();
  setDrawer(true);
});

els.drawerClose.addEventListener('click', () => setDrawer(false));
els.drawerOverlay.addEventListener('click', () => setDrawer(false));

document.querySelectorAll('input[name="theme"]').forEach((r) => {
  r.addEventListener('change', () => {
    state.settings.theme = r.value;
    saveState(state);
    applyTheme();
  });
});

els.setSound.addEventListener('change', () => {
  state.settings.sound = els.setSound.checked;
  saveState(state);
});

els.setVibration.addEventListener('change', () => {
  state.settings.vibration = els.setVibration.checked;
  saveState(state);
});

els.setVolume.addEventListener('input', () => {
  state.settings.volume = parseFloat(els.setVolume.value);
  saveState(state);
});

els.btnReset.addEventListener('click', () => {
  if (confirm('Сбросить весь прогресс?')) {
    state = defaultState();
    saveState(state);
    applyTheme();
    syncSettingsUI();
    renderStats();
    repeatSessionStreak = 0;
    showView(view);
    setDrawer(false);
  }
});

els.btnExport.addEventListener('click', () => exportJson());
els.btnImport.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) importJson(f);
  e.target.value = '';
});

els.repeatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitRepeat();
});

els.btnHint.addEventListener('click', () => showHint());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', import.meta.url)).catch(() => {});
  });
}

applyTheme();
syncSettingsUI();
renderStats();
showView('study');
