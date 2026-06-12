/* ===========================================================================
   Shift Manager — Single-file vanilla JS app
   - Tab navigation
   - Persists to localStorage
   - Employee master / Holidays / Demand / Shift editor / Visualization / Auto-assign / CSV I/O
   =========================================================================== */

// ---------- Constants ----------
const ROLES = ['Mgr', 'JP', 'Op(JP/EN)', 'Op(EN)', 'Night', 'DE'];
const ROLE_CLASS = {
  'Mgr': 'role-mgr',
  'JP': 'role-jp',
  'DE': 'role-de',
  'Op(JP/EN)': 'role-op-jpen',
  'Op(EN)': 'role-op-en',
  'Night': 'role-night',
};
// Lower number = higher priority. Used to fill rare roles first.
const ROLE_PRIORITY = { 'Mgr': 1, 'Night': 2, 'JP': 3, 'Op(JP/EN)': 4, 'Op(EN)': 5, 'DE': 6 };

// Demand keys (per-band): direct roles + Op aggregate
// Mgr/JP/DE/Night: count by exact role match (DE is independent — NOT counted toward opTotal)
// opTotal: count of any Op (Op(JP/EN) + Op(EN))
// opJPMin: minimum count of Op(JP/EN) within opTotal
const DEMAND_KEYS = ['Mgr', 'JP', 'DE', 'Night', 'opTotal', 'opJPMin'];
const DEMAND_LABELS = { 'Mgr': 'Mgr', 'JP': 'JP', 'DE': 'DE', 'Night': 'Night', 'opTotal': 'Op合計', 'opJPMin': 'うちJP話者最低' };
const DEMAND_PRIORITY = { 'Mgr': 1, 'Night': 2, 'JP': 3, 'DE': 4, 'opJPMin': 5, 'opTotal': 6 }; // for slot sorting

function emptyDemandBand() {
  return { Mgr: 0, JP: 0, DE: 0, Night: 0, opTotal: 0, opJPMin: 0 };
}
const TIME_BANDS = [
  { id: '04-07', label: '04-07', startH: 4,  endH: 7  },
  { id: '07-12', label: '07-12', startH: 7,  endH: 12 },
  { id: '12-16', label: '12-16', startH: 12, endH: 16 },
  { id: '16-21', label: '16-21', startH: 16, endH: 21 },
  { id: '21-02', label: '21-02', startH: 21, endH: 26 }, // wraps to 02:00
];
const DOW_LABELS = ['日','月','火','水','木','金','土'];
const DOW_LABELS_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const NATIONALITIES = [{ id: 'JP', label: '日本' }, { id: 'KH', label: 'カンボジア' }];
const EMPLOYMENT = [{ id: 'FT', label: 'フルタイム' }, { id: 'PT', label: 'パートタイム' }];

// Shift cell statuses
const STATUS = { WORK: 'work', OFF: 'off', NG: 'ng', AL: 'al', AL_HALF: 'al_half', P: 'p' };

const STORAGE_KEY = 'shift-manager-v1';

// ---------- State ----------
const state = {
  month: '2026-05',     // YYYY-MM
  employees: [],         // {id, name, nationality, employment, roles[], targetDays, defaultStart, defaultEnd, defaultBreakMin, workableDow[], notes}
  holidays: [],          // {date, country, name}
  demand: {},            // { 'YYYY-MM-DD': { '04-07': { Mgr, JP, Night, opTotal, opJPMin }, ... } }
  demandTemplates: { weekday: null, weekend: null },  // { '04-07': { Mgr, JP, Night, opTotal, opJPMin }, ... }
  shift: {},             // { 'YYYY-MM-DD': { employeeId: { status, start, end, breakMin } } }
  gapReport: [],
};

// ---------- Storage ----------
function save() {
  // Cloud override (Firestore sync): cloud.js sets ShiftApp.saveOverride
  if (window.ShiftApp?.saveOverride) {
    try { window.ShiftApp.saveOverride(state); } catch (e) { console.warn('Cloud save failed', e); }
  }
  // Always persist to LocalStorage as fallback/cache
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('保存に失敗しました: ' + e.message, 'error');
  }
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    Object.assign(state, parsed);
    migrateDemand();
    if (!state.demandTemplates) state.demandTemplates = { weekday: null, weekend: null };
    if (!state.gapReport) state.gapReport = [];
    return true;
  } catch (e) {
    console.warn('Load failed', e);
    return false;
  }
}

// Called by cloud.js when remote state changes (real-time sync).
// Replaces local state, re-renders, but skips re-saving (to avoid echo).
function applyRemoteState(remote) {
  if (!remote) return;
  Object.assign(state, remote);
  migrateDemand();
  if (!state.demandTemplates) state.demandTemplates = { weekday: null, weekend: null };
  if (!state.gapReport) state.gapReport = [];
  // Cache to LocalStorage but don't trigger save override
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  renderAll();
}
window.applyRemoteState = applyRemoteState;

function migrateDemand() {
  if (!state.demand) return;
  for (const date in state.demand) {
    const dayDemand = state.demand[date];
    for (const bandId in dayDemand) {
      const b = dayDemand[bandId];
      if (b == null) { dayDemand[bandId] = emptyDemandBand(); continue; }
      // Check if already migrated
      if ('opTotal' in b || 'opJPMin' in b) {
        // Ensure all keys exist
        for (const k of DEMAND_KEYS) if (!(k in b)) b[k] = 0;
        continue;
      }
      // Old format: { Mgr, JP, 'Op(JP/EN)', 'Op(EN)', Night }
      const opJP = b['Op(JP/EN)'] || 0;
      const opEN = b['Op(EN)'] || 0;
      const newBand = {
        Mgr: b.Mgr || 0,
        JP: b.JP || 0,
        DE: b.DE || 0,
        Night: b.Night || 0,
        opTotal: opJP + opEN,
        opJPMin: opJP,
      };
      dayDemand[bandId] = newBand;
    }
  }
}
function resetAll() {
  if (!confirm('全データをリセットしてシードデータに戻します。よろしいですか？')) return;
  localStorage.removeItem(STORAGE_KEY);
  Object.assign(state, { month: '2026-05', employees: [], holidays: [], demand: {}, shift: {} });
  seedInitialData();
  save();
  renderAll();
  toast('リセットしました', 'success');
}

// ---------- Date helpers ----------
function daysInMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function pad2(n) { return String(n).padStart(2, '0'); }
function dateKey(yyyymm, day) {
  const [y, m] = yyyymm.split('-');
  return `${y}-${m}-${pad2(day)}`;
}
function getDow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}
function isSunday(dateStr) { return getDow(dateStr) === 0; }
function isKHHoliday(dateStr) {
  return state.holidays.some(h => h.date === dateStr && h.country === 'KH');
}
function isJPHoliday(dateStr) {
  return state.holidays.some(h => h.date === dateStr && h.country === 'JP');
}
function countsDouble(dateStr) {
  // FT only: Sundays and KH holidays count as 2
  return isSunday(dateStr) || isKHHoliday(dateStr);
}

// time "HH:MM" → minutes since 04:00 of the working day (day starts at 04:00, ends at 28:00 = 04:00 next day)
function timeToMin(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function minToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

// ---------- Seed initial data ----------
function seedInitialData() {
  state.month = '2026-05';
  state.employees = [
    // Japanese full-time
    { id: '009', name: 'Ms.Mizuki', nationality: 'JP', employment: 'FT', roles: ['Mgr'],        targetDays: 22, defaultStart: '08:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [1,2,3,4,5], notes: '5.5day/week' },
    { id: '050', name: 'Ms. Reine', nationality: 'JP', employment: 'PT', roles: ['JP'],         targetDays: 13, defaultStart: '04:20', defaultEnd: '09:00', defaultBreakMin: 0, workableDow: [0,1,2,3,4,5,6], notes: '7-16デフォ。早朝枠' },
    { id: '076', name: 'Ms. Tomoko Tsuji', nationality: 'JP', employment: 'FT', roles: ['JP'],   targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '070', name: 'Ms. Chisato', nationality: 'JP', employment: 'PT', roles: ['JP'],       targetDays: 14, defaultStart: '07:00', defaultEnd: '13:00', defaultBreakMin: 0, workableDow: [1,2,4,5],     notes: '月火木金' },
    { id: '075', name: 'Ms. Haruna', nationality: 'JP', employment: 'PT', roles: ['JP'],        targetDays: 11, defaultStart: '13:00', defaultEnd: '21:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '008', name: 'Mr.Shuya', nationality: 'JP', employment: 'FT', roles: ['Mgr','JP'],    targetDays: 22, defaultStart: '09:00', defaultEnd: '18:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: 'Mgr' },
    { id: '030', name: 'Ms.tomoko', nationality: 'JP', employment: 'PT', roles: ['Mgr'],        targetDays: 12, defaultStart: '12:00', defaultEnd: '16:00', defaultBreakMin: 0, workableDow: [3,5],         notes: '水金 / 月90h程度' },
    { id: '027', name: 'Ms.Ayumi', nationality: 'JP', employment: 'PT', roles: ['JP'],          targetDays: 11, defaultStart: '08:00', defaultEnd: '13:00', defaultBreakMin: 0, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '010', name: 'Ms.chikako', nationality: 'JP', employment: 'PT', roles: ['JP'],        targetDays: 13, defaultStart: '15:00', defaultEnd: '21:00', defaultBreakMin: 0, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '056', name: 'Mr. Koki Niwa', nationality: 'JP', employment: 'PT', roles: ['JP'],     targetDays: 12, defaultStart: '13:00', defaultEnd: '20:00', defaultBreakMin: 0, workableDow: [0,1,2,3,4,5,6], notes: '13時以降一日7時間 月90h前後' },
    { id: '107', name: 'Mr.Naho Kihara', nationality: 'JP', employment: 'FT', roles: ['Night','JP'], targetDays: 22, defaultStart: '13:00', defaultEnd: '22:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: 'Night兼任' },
    { id: '023', name: 'Mr.Rikinari', nationality: 'JP', employment: 'PT', roles: ['Night'],    targetDays: 12, defaultStart: '20:00', defaultEnd: '24:00', defaultBreakMin: 0, workableDow: [1,2,3,4],     notes: '20-24, 週4, 60-80h, 土日祝NG' },
    { id: '109', name: 'Ms. Iayo Liu', nationality: 'JP', employment: 'FT', roles: ['Night'],   targetDays: 22, defaultStart: '22:00', defaultEnd: '07:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '22-7深夜' },
    { id: '015', name: 'Mrs. Kyoko Yamashita', nationality: 'JP', employment: 'FT', roles: ['Night'], targetDays: 22, defaultStart: '20:45', defaultEnd: '07:15', defaultBreakMin: 60, workableDow: [0,2,3,4,5,6], notes: '月曜後半NG' },
    // Cambodian
    { id: '004', name: 'Tak Sonita', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'],    targetDays: 22, defaultStart: '07:00', defaultEnd: '15:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '021', name: 'Meng Zeang', nationality: 'KH', employment: 'FT', roles: ['Mgr','Op(JP/EN)'], targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '068', name: 'Chanleak', nationality: 'KH', employment: 'FT', roles: ['Op(EN)'],         targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '096', name: 'Mr. Bin Hakseng', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'], targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '073', name: 'Chanthim', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'],      targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '078', name: 'Thearom', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'],       targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '077', name: 'Rachana', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'],       targetDays: 22, defaultStart: '07:00', defaultEnd: '15:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '101', name: 'Ms.San Rathary', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'], targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '085', name: 'Ms. Thet Theany', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'], targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '110', name: 'Ms. Yim Sreynin', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'], targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '' },
    { id: '046', name: 'Pheakdey', nationality: 'KH', employment: 'PT', roles: ['Op(JP/EN)'],      targetDays: 4,  defaultStart: '06:00', defaultEnd: '10:00', defaultBreakMin: 0, workableDow: [0,1,2,3,4,5,6], notes: 'PT from Japan' },
    { id: '036', name: 'Kongkea Chan', nationality: 'KH', employment: 'PT', roles: ['Op(EN)'],    targetDays: 8,  defaultStart: '15:00', defaultEnd: '19:00', defaultBreakMin: 0, workableDow: [1,2,3,4],     notes: 'PT' },
    { id: '080', name: 'Ms. Chim Sreymom', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'], targetDays: 22, defaultStart: '10:00', defaultEnd: '19:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '10-19/11-20' },
    { id: '002', name: 'Odom', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'],          targetDays: 22, defaultStart: '12:00', defaultEnd: '21:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '12-21' },
    { id: '003', name: 'Pich Reaksey', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'],  targetDays: 22, defaultStart: '12:00', defaultEnd: '21:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '12-21' },
    { id: '028', name: 'Chheang Chhoung', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'], targetDays: 22, defaultStart: '12:00', defaultEnd: '21:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '12-21' },
    { id: '100', name: 'Mr. Ma Livann', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'], targetDays: 22, defaultStart: '12:00', defaultEnd: '21:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '12-21' },
    { id: '108', name: 'Ms. Meas Sovathana', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'], targetDays: 22, defaultStart: '12:00', defaultEnd: '21:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '12-21' },
    { id: '105', name: 'Mr. Ven Sileuk', nationality: 'KH', employment: 'FT', roles: ['Op(JP/EN)'], targetDays: 22, defaultStart: '12:00', defaultEnd: '21:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '12-21' },
    { id: '099', name: 'Mr. Meng Mao', nationality: 'KH', employment: 'FT', roles: ['Op(EN)'],    targetDays: 22, defaultStart: '12:00', defaultEnd: '21:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '12-21' },
    { id: '083', name: 'Ms. Sok Chansreyroth', nationality: 'KH', employment: 'FT', roles: ['Op(EN)'],    targetDays: 22, defaultStart: '12:00', defaultEnd: '21:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '12-21' },
    { id: '081', name: 'Mr. Lun Socheath', nationality: 'KH', employment: 'PT', roles: ['Op(EN)','Night'], targetDays: 10, defaultStart: '18:00', defaultEnd: '22:00', defaultBreakMin: 0, workableDow: [0,1,2,3,4,5,6], notes: '18:30-22:30, 目安週6' },
    { id: '103', name: 'Ms. Kakada', nationality: 'KH', employment: 'FT', roles: ['DE'],           targetDays: 22, defaultStart: '08:00', defaultEnd: '17:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '8-17' },
    { id: '055', name: 'NIM SREYNETH', nationality: 'KH', employment: 'FT', roles: ['DE'],         targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '(8:00AM-17:00pm)' },
    { id: '106', name: 'Ms. Thida', nationality: 'KH', employment: 'FT', roles: ['DE'],            targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '(7:00AM-16:00pm)' },
    { id: '054', name: 'Mouyeang', nationality: 'KH', employment: 'FT', roles: ['DE'],             targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60, workableDow: [0,1,2,3,4,5,6], notes: '(Part time)' },
  ];

  state.holidays = [
    { date: '2026-05-01', country: 'KH', name: 'メーデー' },
    { date: '2026-05-14', country: 'KH', name: '国王誕生日' },
    { date: '2026-05-15', country: 'KH', name: 'ヴィサクボチェア (仏陀誕生日)' },
    { date: '2026-05-04', country: 'JP', name: 'みどりの日' },
    { date: '2026-05-05', country: 'JP', name: 'こどもの日' },
  ];

  // Init empty demand / shift
  state.demand = {};
  state.shift = {};
  state.demandTemplates = { weekday: null, weekend: null };
  state.gapReport = [];
  const dim = daysInMonth(state.month);
  for (let d = 1; d <= dim; d++) {
    const date = dateKey(state.month, d);
    state.demand[date] = {};
    for (const b of TIME_BANDS) {
      state.demand[date][b.id] = emptyDemandBand();
    }
  }
}

// ---------- App init ----------
function init(opts = {}) {
  // skipLoad: cloud.js calls this after applying remote state — don't re-load locally
  if (!opts.skipLoad) {
    if (!load()) {
      // Local-only mode: seed if no LocalStorage
      if (!window.FIREBASE_CONFIG) {
        seedInitialData();
        save();
      }
    }
  }
  if (!window._eventsBound) {
    bindGlobalEvents();
    window._eventsBound = true;
  }
  renderAll();
}

function renderAll() {
  document.getElementById('month-input').value = state.month;
  renderDashboard();
  renderEmployees();
  renderHolidays();
  renderDemand();
  renderShift();
  renderVisualize();
}

function bindGlobalEvents() {
  // Tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  switchTab('dashboard');

  // Month input
  document.getElementById('month-input').addEventListener('change', (e) => {
    state.month = e.target.value;
    ensureMonthScaffolding();
    save();
    renderAll();
  });

  // Top actions
  document.getElementById('btn-reset').addEventListener('click', resetAll);
  document.getElementById('btn-auto-assign').addEventListener('click', () => {
    if (!confirm('自動アサインを実行します。\n\n・既存の勤務(WORK)セルを上書き\n・NG/AL/P/OFF は保護\n・必要人員を埋めた後、各従業員を月勤務日数まで自動でパディング\n\nよろしいですか？')) return;
    const t0 = Date.now();
    autoAssign();
    save();
    renderAll();
    const gaps = (state.gapReport || []).length;
    const ms = Date.now() - t0;
    // Compute FT target achievement stats
    const ftStats = state.employees.filter(e => e.employment === 'FT').map(e => {
      const w = monthDates().reduce((a, d) => a + (state.shift[d]?.[e.id]?.status === 'work' ? ((countsDouble(d) && e.employment === 'FT') ? 2 : 1) : 0), 0);
      return { target: e.targetDays, w };
    });
    const ftHit = ftStats.filter(s => s.w >= s.target).length;
    const ftTotal = ftStats.length;
    toast(`自動アサイン完了 (${ms}ms) — 不足${gaps}枠 / FT目標達成 ${ftHit}/${ftTotal}名`, gaps ? '' : 'success');
  });
  document.getElementById('btn-csv-export').addEventListener('click', exportCSV);
  document.getElementById('btn-csv-import').addEventListener('click', () => document.getElementById('csv-file-input').click());
  document.getElementById('csv-file-input').addEventListener('change', importCSV);

  // Employee add
  document.getElementById('btn-add-employee').addEventListener('click', () => openEmployeeModal(null));
  document.getElementById('btn-apply-target-days').addEventListener('click', openApplyTargetDaysModal);
  // Holiday add
  document.getElementById('btn-add-holiday').addEventListener('click', () => openHolidayModal(null));

  // Demand actions
  document.getElementById('btn-demand-clear').addEventListener('click', clearDemand);
  document.getElementById('btn-demand-fill').addEventListener('click', openFillDemandModal);
  document.getElementById('demand-compact-mode').addEventListener('change', renderDemand);

  // Visualize controls
  document.getElementById('vis-exclude-mgr').addEventListener('change', renderVisualize);
  document.getElementById('vis-exclude-de').addEventListener('change', renderVisualize);
  document.querySelectorAll('input[name="vis-mode"]').forEach(r => r.addEventListener('change', renderVisualize));

  // Modal global close
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.querySelector('.modal-backdrop').addEventListener('click', closeModal);
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === tab));
  // 人員整合性タブはSupabaseから非同期で読むため、表示時に遅延レンダリング
  if (tab === 'staffing-fit' && window.StaffingFit) window.StaffingFit.render();
}

function ensureMonthScaffolding() {
  const dim = daysInMonth(state.month);
  let appliedFromTemplate = 0;
  for (let d = 1; d <= dim; d++) {
    const date = dateKey(state.month, d);
    if (!state.demand[date]) {
      state.demand[date] = {};
      const dow = getDow(date);
      const isHoliday = isSunday(date) || isKHHoliday(date) || isJPHoliday(date) || dow === 6;
      const tpl = isHoliday ? state.demandTemplates?.weekend : state.demandTemplates?.weekday;
      for (const b of TIME_BANDS) {
        if (tpl && tpl[b.id]) {
          state.demand[date][b.id] = { ...tpl[b.id] };
          appliedFromTemplate++;
        } else {
          state.demand[date][b.id] = emptyDemandBand();
        }
      }
    }
  }
  if (appliedFromTemplate > 0) {
    setTimeout(() => toast(`テンプレートを ${state.month} に適用しました`, 'success'), 100);
  }
}

// ---------- Dashboard ----------
function renderDashboard() {
  document.getElementById('dash-emp-count').textContent = state.employees.length;
  // Total assigned working days this month
  let totalDays = 0;
  let ngCount = 0;
  for (const date of monthDates()) {
    const day = state.shift[date] || {};
    for (const empId in day) {
      const cell = day[empId];
      if (cell.status === STATUS.WORK) totalDays++;
      if (cell.status === STATUS.NG || cell.status === STATUS.AL) ngCount++;
    }
  }
  document.getElementById('dash-total-days').textContent = totalDays;
  document.getElementById('dash-ng-count').textContent = ngCount;

  // Unfilled count
  const { gaps } = computeCoverageVsDemand();
  document.getElementById('dash-unfilled').textContent = gaps;

  // Gap report
  renderGapReport();
}

function renderGapReport() {
  const host = document.getElementById('gap-report');
  if (!host) return;
  const report = state.gapReport || [];
  if (report.length === 0) {
    host.innerHTML = `<p class="hint">不足なし。すべての必要人員が充足されています。<br><small>※ 自動アサイン未実行時はこのリストは空です。</small></p>`;
    return;
  }
  // Group by date
  const byDate = {};
  for (const g of report) {
    if (!byDate[g.date]) byDate[g.date] = [];
    byDate[g.date].push(g);
  }
  const sortedDates = Object.keys(byDate).sort();
  let html = '<table class="gap-table"><thead><tr><th>日付</th><th>時間帯</th><th>需要</th><th>不足</th><th>理由</th></tr></thead><tbody>';
  for (const date of sortedDates) {
    const items = byDate[date];
    const dow = getDow(date);
    const isHol = isSunday(date) || isKHHoliday(date) || isJPHoliday(date);
    const agg = {};
    for (const g of items) {
      const key = `${g.bandId}|${g.kind || g.role}`;
      agg[key] = (agg[key] || 0) + 1;
    }
    const keys = Object.keys(agg);
    keys.forEach((key, i) => {
      const [bandId, kind] = key.split('|');
      const reason = items.find(g => g.bandId === bandId && (g.kind || g.role) === kind)?.reason || '';
      const kindLabel = DEMAND_LABELS[kind] || kind;
      const kindCls = kind === 'Mgr' ? 'role-mgr' : kind === 'JP' ? 'role-jp' : kind === 'DE' ? 'role-de' : kind === 'Night' ? 'role-night' : kind === 'opJP' ? 'role-op-jpen' : 'role-op-en';
      html += `<tr class="${isHol ? 'gap-holiday' : ''}">`;
      if (i === 0) html += `<td rowspan="${keys.length}">${date.slice(-2)}日(${DOW_LABELS[dow]})${isHol ? ' 🔴' : ''}</td>`;
      html += `<td>${bandId}</td><td><span class="tag ${kindCls}">${kindLabel}</span></td><td><b>${agg[key]}</b></td><td class="gap-reason">${escapeHtml(reason)}</td></tr>`;
    });
  }
  html += '</tbody></table>';
  host.innerHTML = html;
}

function monthDates() {
  const dim = daysInMonth(state.month);
  const out = [];
  for (let d = 1; d <= dim; d++) out.push(dateKey(state.month, d));
  return out;
}

// ---------- Employees ----------
function renderEmployees() {
  const tbody = document.querySelector('#employees-table tbody');
  tbody.innerHTML = '';
  for (const e of state.employees) {
    const tr = document.createElement('tr');
    const rolesHtml = (e.roles || []).map(r => `<span class="tag ${ROLE_CLASS[r] || ''}">${r}</span>`).join('');
    const dowHtml = (e.workableDow || []).map(d => DOW_LABELS[d]).join(',');
    const dayCell = (e.maxDays != null && e.maxDays !== e.targetDays)
      ? `${e.targetDays} <small style="color:#6b7280">/ 上限 ${e.maxDays}</small>`
      : `${e.targetDays}`;
    const hoursCell = (e.targetHours != null || e.maxHours != null)
      ? `<small style="color:#6b7280; display:block">${e.targetHours != null ? `目標${e.targetHours}h` : ''}${e.maxHours != null ? ` 上限${e.maxHours}h` : ''}</small>`
      : '';
    const targetCell = dayCell + hoursCell;
    tr.innerHTML = `
      <td>${escapeHtml(e.id)}</td>
      <td>${escapeHtml(e.name)}</td>
      <td><span class="tag ${e.nationality === 'JP' ? 'jp' : 'kh'}">${e.nationality}</span></td>
      <td><span class="tag ${e.employment === 'FT' ? 'ft' : 'pt'}">${e.employment}</span></td>
      <td>${rolesHtml}</td>
      <td>${targetCell}</td>
      <td>${e.defaultStart}-${e.defaultEnd}</td>
      <td>${e.defaultBreakMin || 0}</td>
      <td>${dowHtml}</td>
      <td>${escapeHtml(e.notes || '')}</td>
      <td class="actions-cell">
        <button data-id="${e.id}" class="edit">編集</button>
        <button data-id="${e.id}" class="del">削除</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('button.edit').forEach(b => b.addEventListener('click', () => openEmployeeModal(b.dataset.id)));
  tbody.querySelectorAll('button.del').forEach(b => b.addEventListener('click', () => deleteEmployee(b.dataset.id)));
}

function deleteEmployee(id) {
  if (!confirm('この従業員を削除しますか？関連シフトも削除されます。')) return;
  state.employees = state.employees.filter(e => e.id !== id);
  for (const date in state.shift) delete state.shift[date][id];
  save(); renderAll();
}

// Compute standard FT working days for a month: days - 6 (regular off) - non-Sunday holidays
function computeDefaultTargetDays(month, baseOffDays = 6, holidayCountry = 'all') {
  const dim = daysInMonth(month);
  let holidays = state.holidays.filter(h => h.date.startsWith(month + '-'));
  if (holidayCountry !== 'all') holidays = holidays.filter(h => h.country === holidayCountry);
  // Dedupe by date (one date may have both JP+KH holiday)
  const holidayDates = [...new Set(holidays.map(h => h.date))];
  // Exclude Sundays (holidays falling on Sunday don't add extra off-day)
  const nonSundayHolidays = holidayDates.filter(d => getDow(d) !== 0);
  return { value: Math.max(0, dim - baseOffDays - nonSundayHolidays.length), dim, baseOffDays, holidayDates: nonSundayHolidays };
}

function openApplyTargetDaysModal() {
  const calc = computeDefaultTargetDays(state.month);
  const holidayList = calc.holidayDates.length
    ? calc.holidayDates.map(d => {
        const h = state.holidays.find(x => x.date === d);
        return `${d.slice(-2)}日${h ? `(${h.country}/${escapeHtml(h.name || '')})` : ''}`;
      }).join(', ')
    : 'なし';
  showModal('今月の標準勤務日数を一括設定', `
    <p class="hint">${state.month}: <b>${calc.dim}日</b> − 月の休み <b>${calc.baseOffDays}日</b> − 祝日 <b>${calc.holidayDates.length}日</b> = <b>${calc.value}日</b><br>
    <small>祝日: ${holidayList} (日曜と重なる祝日は除外)</small></p>
    <div class="form-row"><label>月の休み日数</label><input type="number" id="apply-base-off" value="${calc.baseOffDays}" min="0" max="31" /></div>
    <div class="form-row"><label>祝日のカウント</label>
      <select id="apply-holiday-country">
        <option value="all" selected>JP + KH 両方</option>
        <option value="KH">KH のみ</option>
        <option value="JP">JP のみ</option>
      </select>
    </div>
    <div class="form-row"><label>勤務日数</label><input type="number" id="apply-target" value="${calc.value}" min="0" max="31" /></div>
    <p class="hint" id="apply-formula" style="margin: 4px 0 12px 0;">※ 上の「休み日数」「祝日カウント」を変更すると勤務日数が再計算されます</p>
    <div class="form-row"><label>適用範囲</label>
      <div class="checks">
        <label><input type="radio" name="apply-scope" value="ft" checked /> フルタイムのみ</label>
        <label><input type="radio" name="apply-scope" value="all" /> 全員 (FT+PT)</label>
      </div>
    </div>
  `, () => {
    const value = parseInt(document.getElementById('apply-target').value, 10) || 0;
    const scope = document.querySelector('input[name="apply-scope"]:checked').value;
    let count = 0;
    for (const e of state.employees) {
      if (scope === 'ft' && e.employment !== 'FT') continue;
      e.targetDays = value;
      count++;
    }
    save(); renderAll();
    toast(`${count}名の月勤務日数を ${value}日 に設定しました`, 'success');
    return true;
  }, () => {
    // Auto-recompute when base-off or holiday-country changes (bind immediately, no setTimeout)
    const baseOffInp = document.getElementById('apply-base-off');
    const countrySel = document.getElementById('apply-holiday-country');
    const targetInp = document.getElementById('apply-target');
    const recalc = () => {
      const off = parseInt(baseOffInp.value, 10) || 0;
      const country = countrySel.value;
      const c = computeDefaultTargetDays(state.month, off, country);
      targetInp.value = c.value;
    };
    baseOffInp.addEventListener('input', recalc);
    countrySel.addEventListener('change', recalc);
  });
}

function openEmployeeModal(id) {
  const e = id ? state.employees.find(x => x.id === id) : {
    id: '', name: '', nationality: 'KH', employment: 'FT', roles: [],
    targetDays: 22, defaultStart: '07:00', defaultEnd: '16:00', defaultBreakMin: 60,
    workableDow: [0,1,2,3,4,5,6], notes: '',
    shiftPatterns: [], maxConsecutiveDays: 6, minRestHours: 11,
  };
  const isNew = !id;
  const patterns = (e.shiftPatterns && e.shiftPatterns.length) ? e.shiftPatterns : [];
  showModal(isNew ? '従業員を追加' : '従業員を編集', `
    <div class="form-row"><label>ID</label><input type="text" id="ef-id" value="${escapeAttr(e.id)}" ${isNew ? '' : 'disabled'} /></div>
    <div class="form-row"><label>名前</label><input type="text" id="ef-name" value="${escapeAttr(e.name)}" /></div>
    <div class="form-row"><label>国籍</label>
      <select id="ef-nationality">
        ${NATIONALITIES.map(n => `<option value="${n.id}" ${e.nationality === n.id ? 'selected' : ''}>${n.label}</option>`).join('')}
      </select>
    </div>
    <div class="form-row"><label>雇用形態</label>
      <select id="ef-employment">
        ${EMPLOYMENT.map(em => `<option value="${em.id}" ${e.employment === em.id ? 'selected' : ''}>${em.label}</option>`).join('')}
      </select>
    </div>
    <div class="form-row"><label>ロール</label>
      <div class="checks">
        ${ROLES.map(r => `<label><input type="checkbox" name="ef-role" value="${r}" ${(e.roles || []).includes(r) ? 'checked' : ''} /> ${r}</label>`).join('')}
      </div>
    </div>
    <div class="form-row"><label>月勤務日数 (目標)</label><input type="number" id="ef-targetDays" value="${e.targetDays}" min="0" max="31" /></div>
    <div class="form-row"><label>上限日数 (任意)</label><input type="number" id="ef-maxDays" value="${e.maxDays != null ? e.maxDays : ''}" min="0" max="31" placeholder="(空欄 = 目標と同じ)" /></div>
    <div class="form-row"><label>月勤務時間 (目標, 任意)</label><input type="number" id="ef-targetHours" value="${e.targetHours != null ? e.targetHours : ''}" min="0" max="744" placeholder="(空欄 = 時間制約なし)" /></div>
    <div class="form-row"><label>上限時間 (任意)</label><input type="number" id="ef-maxHours" value="${e.maxHours != null ? e.maxHours : ''}" min="0" max="744" placeholder="(空欄 = 目標時間 or 無制限)" /></div>
    <div class="form-row"><label>デフォ開始</label><input type="time" id="ef-start" value="${e.defaultStart}" /></div>
    <div class="form-row"><label>デフォ終了</label><input type="time" id="ef-end" value="${e.defaultEnd}" /></div>
    <div class="form-row"><label>休憩(分)</label><input type="number" id="ef-break" value="${e.defaultBreakMin || 0}" min="0" max="180" step="15" /></div>
    <div class="form-row"><label>連続勤務上限</label><input type="number" id="ef-maxConsec" value="${e.maxConsecutiveDays || 6}" min="1" max="14" /></div>
    <div class="form-row"><label>休息時間(h)</label><input type="number" id="ef-minRest" value="${e.minRestHours != null ? e.minRestHours : 11}" min="0" max="24" /></div>
    <div class="form-row"><label>勤務可能曜日</label>
      <div class="checks">
        ${DOW_LABELS.map((d, i) => `<label><input type="checkbox" name="ef-dow" value="${i}" ${(e.workableDow || []).includes(i) ? 'checked' : ''} /> ${d}</label>`).join('')}
      </div>
    </div>
    <div class="form-row"><label>シフトパターン</label>
      <div class="pattern-list" id="ef-patterns">
        ${patterns.map((p, i) => patternRowHtml(p, i)).join('')}
      </div>
    </div>
    <div class="form-row"><label></label><button id="ef-add-pattern" type="button" class="btn-small">+ パターン追加</button></div>
    <div class="form-row"><label>備考</label><textarea id="ef-notes">${escapeHtml(e.notes || '')}</textarea></div>
    <p class="hint">シフトパターンが空ならデフォ開始/終了/休憩を1パターンとして使用。複数登録すると自動アサインが各日の必要時間帯に応じて最適パターンを選択。</p>
  `, () => {
    const newId = document.getElementById('ef-id').value.trim();
    if (!newId) { toast('IDを入力してください', 'error'); return false; }
    if (isNew && state.employees.some(x => x.id === newId)) { toast('IDが重複しています', 'error'); return false; }
    // Collect patterns
    const patternRows = document.querySelectorAll('#ef-patterns .pattern-row');
    const newPatterns = [];
    for (const row of patternRows) {
      const start = row.querySelector('.pat-start').value;
      const end = row.querySelector('.pat-end').value;
      const breakMin = parseInt(row.querySelector('.pat-break').value, 10) || 0;
      const label = row.querySelector('.pat-label').value.trim();
      if (start && end) newPatterns.push({ start, end, breakMin, label });
    }
    const maxRaw = document.getElementById('ef-maxDays').value.trim();
    const targetHoursRaw = document.getElementById('ef-targetHours').value.trim();
    const maxHoursRaw = document.getElementById('ef-maxHours').value.trim();
    const data = {
      id: isNew ? newId : e.id,
      name: document.getElementById('ef-name').value.trim(),
      nationality: document.getElementById('ef-nationality').value,
      employment: document.getElementById('ef-employment').value,
      roles: Array.from(document.querySelectorAll('input[name="ef-role"]:checked')).map(x => x.value),
      targetDays: parseInt(document.getElementById('ef-targetDays').value, 10) || 0,
      maxDays: maxRaw === '' ? null : (parseInt(maxRaw, 10) || 0),
      targetHours: targetHoursRaw === '' ? null : (parseFloat(targetHoursRaw) || 0),
      maxHours: maxHoursRaw === '' ? null : (parseFloat(maxHoursRaw) || 0),
      defaultStart: document.getElementById('ef-start').value,
      defaultEnd: document.getElementById('ef-end').value,
      defaultBreakMin: parseInt(document.getElementById('ef-break').value, 10) || 0,
      maxConsecutiveDays: parseInt(document.getElementById('ef-maxConsec').value, 10) || 6,
      minRestHours: parseInt(document.getElementById('ef-minRest').value, 10) || 11,
      workableDow: Array.from(document.querySelectorAll('input[name="ef-dow"]:checked')).map(x => parseInt(x.value, 10)),
      shiftPatterns: newPatterns,
      notes: document.getElementById('ef-notes').value,
    };
    if (data.maxDays != null && data.maxDays < data.targetDays) {
      toast('上限日数は目標日数以上にしてください', 'error');
      return false;
    }
    if (data.maxHours != null && data.targetHours != null && data.maxHours < data.targetHours) {
      toast('上限時間は目標時間以上にしてください', 'error');
      return false;
    }
    if (isNew) state.employees.push(data);
    else Object.assign(state.employees.find(x => x.id === e.id), data);
    save(); renderAll();
    return true;
  }, () => {
    // Bind pattern add/remove after modal renders
    setTimeout(() => {
      const addBtn = document.getElementById('ef-add-pattern');
      const host = document.getElementById('ef-patterns');
      function bindRemove() {
        host.querySelectorAll('.pattern-row .pat-remove').forEach(b => {
          b.onclick = () => b.closest('.pattern-row').remove();
        });
      }
      addBtn.addEventListener('click', () => {
        const div = document.createElement('div');
        div.innerHTML = patternRowHtml({ start: '09:00', end: '18:00', breakMin: 60, label: '' });
        host.appendChild(div.firstElementChild);
        bindRemove();
      });
      bindRemove();
    }, 0);
  });
}

function patternRowHtml(p, i = 0) {
  return `<div class="pattern-row">
    <input type="time" class="pat-start" value="${p.start || '09:00'}" />
    <span>-</span>
    <input type="time" class="pat-end" value="${p.end || '18:00'}" />
    <span>休憩</span>
    <input type="number" class="pat-break" value="${p.breakMin || 0}" min="0" max="180" step="15" />
    <span>分</span>
    <input type="text" class="pat-label" placeholder="ラベル (任意)" value="${escapeAttr(p.label || '')}" />
    <button type="button" class="pat-remove">×</button>
  </div>`;
}

// ---------- Holidays ----------
function renderHolidays() {
  const tbody = document.querySelector('#holidays-table tbody');
  tbody.innerHTML = '';
  const sorted = [...state.holidays].sort((a, b) => a.date.localeCompare(b.date));
  for (const h of sorted) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${h.date}</td>
      <td><span class="tag ${h.country === 'JP' ? 'jp' : 'kh'}">${h.country}</span></td>
      <td>${escapeHtml(h.name)}</td>
      <td class="actions-cell">
        <button class="edit" data-date="${h.date}" data-country="${h.country}">編集</button>
        <button class="del" data-date="${h.date}" data-country="${h.country}">削除</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('button.edit').forEach(b => b.addEventListener('click', () => openHolidayModal({ date: b.dataset.date, country: b.dataset.country })));
  tbody.querySelectorAll('button.del').forEach(b => b.addEventListener('click', () => {
    state.holidays = state.holidays.filter(h => !(h.date === b.dataset.date && h.country === b.dataset.country));
    save(); renderAll();
  }));
}

function openHolidayModal(key) {
  const existing = key ? state.holidays.find(h => h.date === key.date && h.country === key.country) : null;
  const h = existing || { date: dateKey(state.month, 1), country: 'KH', name: '' };
  const isNew = !existing;
  showModal(isNew ? '祝日を追加' : '祝日を編集', `
    <div class="form-row"><label>日付</label><input type="date" id="hf-date" value="${h.date}" /></div>
    <div class="form-row"><label>国</label>
      <select id="hf-country">
        <option value="KH" ${h.country === 'KH' ? 'selected' : ''}>カンボジア (KH)</option>
        <option value="JP" ${h.country === 'JP' ? 'selected' : ''}>日本 (JP)</option>
      </select>
    </div>
    <div class="form-row"><label>名称</label><input type="text" id="hf-name" value="${escapeAttr(h.name)}" /></div>
  `, () => {
    const date = document.getElementById('hf-date').value;
    const country = document.getElementById('hf-country').value;
    const name = document.getElementById('hf-name').value.trim();
    if (!date) { toast('日付を入力してください', 'error'); return false; }
    if (isNew) {
      if (state.holidays.some(x => x.date === date && x.country === country)) { toast('同じ祝日があります', 'error'); return false; }
      state.holidays.push({ date, country, name });
    } else {
      const idx = state.holidays.findIndex(x => x.date === h.date && x.country === h.country);
      state.holidays[idx] = { date, country, name };
    }
    save(); renderAll();
    return true;
  });
}

// ---------- Demand ----------
function renderDemand() {
  const wrap = document.getElementById('demand-table-wrap');
  wrap.innerHTML = '';
  const dates = monthDates();
  const compact = document.getElementById('demand-compact-mode')?.checked ?? true;

  const table = document.createElement('table');
  table.className = 'demand-table';

  const thead = document.createElement('thead');
  const tr1 = document.createElement('tr');
  tr1.innerHTML = `<th class="col-band">時間帯</th><th class="col-key">需要</th>` + dates.map(d => {
    const day = parseInt(d.slice(-2), 10);
    const dow = getDow(d);
    const cls = isSunday(d) || isKHHoliday(d) || isJPHoliday(d) ? 'holiday' : (dow === 6 ? 'sat' : '');
    return `<th class="${cls}">${day}<br><small>${DOW_LABELS_EN[dow]}</small></th>`;
  }).join('');
  thead.appendChild(tr1);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  let renderedBands = 0;
  for (const b of TIME_BANDS) {
    // Determine which keys to show in this band
    const visibleKeys = DEMAND_KEYS.filter(k => {
      if (!compact) return true;
      return dates.some(d => (state.demand[d]?.[b.id]?.[k] || 0) > 0);
    });
    if (compact && visibleKeys.length === 0) continue; // skip whole band
    renderedBands++;

    // Band header row with totals
    const bandTotal = dates.reduce((acc, d) => {
      const bd = state.demand[d]?.[b.id];
      if (!bd) return acc;
      return acc + (bd.Mgr || 0) + (bd.JP || 0) + (bd.Night || 0) + (bd.opTotal || 0);
    }, 0);
    const bandRow = document.createElement('tr');
    bandRow.innerHTML = `<td class="band-header" colspan="${dates.length + 2}"><b>${b.label}</b><span class="band-total"> (月内需要合計: ${bandTotal})</span></td>`;
    tbody.appendChild(bandRow);

    for (const k of visibleKeys) {
      const tr = document.createElement('tr');
      const isSub = k === 'opJPMin';
      tr.innerHTML = `<td class="col-band">${b.label}</td><td class="col-key${isSub ? ' sub' : ''}">${DEMAND_LABELS[k]}</td>` + dates.map(d => {
        const val = (state.demand[d]?.[b.id]?.[k]) || 0;
        const dow = getDow(d);
        const dayCls = isSunday(d) || isKHHoliday(d) || isJPHoliday(d) ? 'holiday' : (dow === 6 ? 'sat' : '');
        const valCls = val > 0 ? 'has-val' : 'zero';
        const valHtml = val > 0 ? String(val) : '';
        return `<td class="${dayCls} ${valCls}"><input type="number" min="0" max="20" placeholder="0" data-date="${d}" data-band="${b.id}" data-key="${k}" value="${valHtml}" /></td>`;
      }).join('');
      tbody.appendChild(tr);
    }
  }
  if (renderedBands === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="${dates.length + 2}" class="empty-hint">この月は需要が未設定です。「一括入力 / テンプレ」ボタンで設定してください。<br>もしくは「コンパクト」を外すと全ての行が表示されます。</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  wrap.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', () => {
      const date = inp.dataset.date;
      const band = inp.dataset.band;
      const key = inp.dataset.key;
      const v = parseInt(inp.value, 10) || 0;
      if (!state.demand[date]) state.demand[date] = {};
      if (!state.demand[date][band]) state.demand[date][band] = emptyDemandBand();
      state.demand[date][band][key] = v;
      // Ensure opJPMin ≤ opTotal
      if (key === 'opJPMin' && v > state.demand[date][band].opTotal) {
        state.demand[date][band].opTotal = v;
      } else if (key === 'opTotal' && v < state.demand[date][band].opJPMin) {
        state.demand[date][band].opJPMin = v;
      }
      save();
      // Update cell highlight + value display (re-render row to keep DOM cheap)
      renderDemand();
    });
  });
}

function clearDemand() {
  if (!confirm('全日の必要人員を0にします。よろしいですか？')) return;
  for (const d of monthDates()) {
    state.demand[d] = {};
    for (const b of TIME_BANDS) {
      state.demand[d][b.id] = emptyDemandBand();
    }
  }
  save(); renderDemand();
}

function openFillDemandModal() {
  // Pre-populate from existing template if any
  const tpl = state.demandTemplates?.weekday || {};
  showModal('一括入力 / テンプレート', `
    <p class="hint">下に入力した値を平日 (月-金、祝日除く) に一括反映。<br>
    <b>「テンプレートとして保存」</b>を有効にすると、今後 <b>新しい月に切り替えた時もこの値が自動適用</b>されます。</p>
    <table class="demand-table" id="fill-tbl">
      <thead><tr><th>時間帯</th>${DEMAND_KEYS.map(k => `<th>${DEMAND_LABELS[k]}</th>`).join('')}</tr></thead>
      <tbody>
        ${TIME_BANDS.map(b => `
          <tr>
            <td class="row-label">${b.label}</td>
            ${DEMAND_KEYS.map(k => {
              const v = tpl[b.id]?.[k] || 0;
              return `<td><input type="number" min="0" max="20" value="${v}" data-band="${b.id}" data-key="${k}" /></td>`;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div class="form-row" style="margin-top:12px"><label>適用範囲</label>
      <div class="checks">
        <label><input type="radio" name="fill-scope" value="this" checked /> 当月のみ (平日)</label>
        <label><input type="radio" name="fill-scope" value="this-all" /> 当月のみ (土日祝も含む)</label>
        <label><input type="radio" name="fill-scope" value="template" /> 当月+テンプレ保存 (新しい月で自動適用)</label>
      </div>
    </div>
  `, () => {
    const scope = document.querySelector('input[name="fill-scope"]:checked').value;
    const inputs = document.querySelectorAll('#fill-tbl input');
    const fill = {};
    for (const b of TIME_BANDS) fill[b.id] = emptyDemandBand();
    for (const inp of inputs) {
      const b = inp.dataset.band, k = inp.dataset.key;
      fill[b][k] = parseInt(inp.value, 10) || 0;
    }
    // Validation: opJPMin ≤ opTotal
    for (const b of TIME_BANDS) {
      if (fill[b.id].opJPMin > fill[b.id].opTotal) {
        toast(`${b.id} の "JP話者最低" が "Op合計" を超えています`, 'error');
        return false;
      }
    }
    for (const d of monthDates()) {
      const dow = getDow(d);
      const isWeekendOrHoliday = (dow === 0 || dow === 6) || isKHHoliday(d) || isJPHoliday(d);
      if (isWeekendOrHoliday && scope === 'this') continue;
      state.demand[d] = JSON.parse(JSON.stringify(fill));
    }
    if (scope === 'template') {
      state.demandTemplates = state.demandTemplates || { weekday: null, weekend: null };
      state.demandTemplates.weekday = JSON.parse(JSON.stringify(fill));
      toast('テンプレートとして保存しました', 'success');
    } else {
      toast('一括入力しました', 'success');
    }
    save(); renderDemand();
    return true;
  });
}

// ---------- Shift Editor ----------
function renderShift() {
  const wrap = document.getElementById('shift-table-wrap');
  wrap.innerHTML = '';
  const dates = monthDates();
  const table = document.createElement('table');
  table.className = 'shift-table';

  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  tr.innerHTML = `<th class="name-col">従業員</th>` + dates.map(d => {
    const day = parseInt(d.slice(-2), 10);
    const dow = getDow(d);
    let cls = '';
    if (dow === 0 || isKHHoliday(d) || isJPHoliday(d)) cls = 'sun';
    else if (dow === 6) cls = 'sat';
    return `<th class="${cls}">${day}<br><small>${DOW_LABELS_EN[dow]}</small></th>`;
  }).join('') + `<th>勤務日</th><th>合計h</th>`;
  thead.appendChild(tr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const e of state.employees) {
    // 3 rows per employee: IN, OUT, BREAK/STATUS
    const trIn = document.createElement('tr');
    trIn.className = 'row-in';
    const trOut = document.createElement('tr');
    trOut.className = 'row-out';
    const trBreak = document.createElement('tr');
    trBreak.className = 'row-break';

    trIn.innerHTML = `<td class="name-col" rowspan="3">${escapeHtml(e.name)}<br><small style="color:#6b7280">${e.id} / ${e.nationality} / ${e.employment}</small></td>`;
    let workDays = 0;
    let workHours = 0;
    for (const date of dates) {
      const cell = (state.shift[date] && state.shift[date][e.id]) || { status: null };
      const dow = getDow(date);
      const isHol = isSunday(date) || isKHHoliday(date) || isJPHoliday(date);
      const dayCls = isHol ? 'sun' : (dow === 6 ? 'sat' : '');
      let statusCls = '';
      if (cell.status === STATUS.OFF) statusCls = 'status-off';
      else if (cell.status === STATUS.NG) statusCls = 'status-ng';
      else if (cell.status === STATUS.AL || cell.status === STATUS.AL_HALF) statusCls = 'status-al';
      else if (cell.status === STATUS.P) statusCls = 'status-p';

      const start = cell.start || '';
      const end = cell.end || '';
      const isWork = cell.status === STATUS.WORK;
      if (isWork) {
        workDays += countsDouble(date) && e.employment === 'FT' ? 2 : 1;
        workHours += calcWorkHours(cell);
      }
      const statusLabel = cell.status === STATUS.OFF ? 'OFF' :
                         cell.status === STATUS.NG ? 'NG' :
                         cell.status === STATUS.AL ? 'AL' :
                         cell.status === STATUS.AL_HALF ? 'AL0.5' :
                         cell.status === STATUS.P ? 'P' :
                         cell.breakMin ? minToTime(cell.breakMin).replace(':', ':') : '';

      trIn.innerHTML += `<td class="${dayCls} editable" data-date="${date}" data-emp="${e.id}" data-field="start">${isWork ? start : ''}</td>`;
      trOut.innerHTML += `<td class="${dayCls} editable" data-date="${date}" data-emp="${e.id}" data-field="end">${isWork ? end : ''}</td>`;
      trBreak.innerHTML += `<td class="${dayCls} ${statusCls} editable" data-date="${date}" data-emp="${e.id}" data-field="status">${statusLabel}</td>`;
    }
    trIn.innerHTML += `<td class="summary-col" rowspan="3">${workDays}</td>`;
    trIn.innerHTML += `<td class="summary-col" rowspan="3">${workHours.toFixed(1)}</td>`;
    tbody.appendChild(trIn);
    tbody.appendChild(trOut);
    tbody.appendChild(trBreak);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  // Bind clicks
  wrap.querySelectorAll('td.editable').forEach(td => {
    td.addEventListener('click', () => openCellEditor(td.dataset.date, td.dataset.emp));
  });
}

function calcWorkHours(cell) {
  if (cell.status !== STATUS.WORK) return 0;
  return calcShiftHoursFromPattern(cell);
}

function calcShiftHoursFromPattern(p) {
  const s = timeToMin(p.start);
  let e = timeToMin(p.end);
  if (s == null || e == null) return 0;
  if (e <= s) e += 24 * 60; // overnight
  const breakMin = p.breakMin || 0;
  return Math.max(0, (e - s - breakMin) / 60);
}

function openCellEditor(date, empId) {
  const emp = state.employees.find(e => e.id === empId);
  const existing = (state.shift[date] && state.shift[date][empId]) || {};
  const cell = {
    status: existing.status || STATUS.WORK,
    start: existing.start || emp.defaultStart,
    end: existing.end || emp.defaultEnd,
    breakMin: existing.breakMin != null ? existing.breakMin : emp.defaultBreakMin,
  };
  showModal(`${emp.name} — ${date} (${DOW_LABELS[getDow(date)]})`, `
    <div class="form-row"><label>状態</label>
      <select id="cf-status">
        <option value="${STATUS.WORK}" ${cell.status === STATUS.WORK ? 'selected' : ''}>勤務</option>
        <option value="${STATUS.OFF}" ${cell.status === STATUS.OFF ? 'selected' : ''}>OFF (休日)</option>
        <option value="${STATUS.NG}" ${cell.status === STATUS.NG ? 'selected' : ''}>NG (勤務不可)</option>
        <option value="${STATUS.AL}" ${cell.status === STATUS.AL ? 'selected' : ''}>AL (有給)</option>
        <option value="${STATUS.AL_HALF}" ${cell.status === STATUS.AL_HALF ? 'selected' : ''}>AL0.5 (半休)</option>
        <option value="${STATUS.P}" ${cell.status === STATUS.P ? 'selected' : ''}>P (Paid?)</option>
      </select>
    </div>
    <div class="form-row"><label>開始</label><input type="time" id="cf-start" value="${cell.start}" /></div>
    <div class="form-row"><label>終了</label><input type="time" id="cf-end" value="${cell.end}" /></div>
    <div class="form-row"><label>休憩(分)</label><input type="number" id="cf-break" value="${cell.breakMin || 0}" min="0" max="180" step="15" /></div>
    <div class="form-row"><label></label><button id="cf-clear" type="button">この日をクリア</button></div>
  `, () => {
    const newCell = {
      status: document.getElementById('cf-status').value,
      start: document.getElementById('cf-start').value,
      end: document.getElementById('cf-end').value,
      breakMin: parseInt(document.getElementById('cf-break').value, 10) || 0,
    };
    if (!state.shift[date]) state.shift[date] = {};
    state.shift[date][empId] = newCell;
    save(); renderAll();
    return true;
  }, () => {
    // After modal renders, bind clear button
    setTimeout(() => {
      const btn = document.getElementById('cf-clear');
      if (btn) btn.addEventListener('click', () => {
        if (state.shift[date]) delete state.shift[date][empId];
        save(); renderAll();
        closeModal();
      });
    }, 0);
  });
}

// ---------- Visualize ----------
function renderVisualize() {
  const wrap = document.getElementById('visualize-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  const excludeMgr = document.getElementById('vis-exclude-mgr')?.checked ?? true;
  const excludeDE  = document.getElementById('vis-exclude-de')?.checked  ?? false;
  const mode = document.querySelector('input[name="vis-mode"]:checked')?.value || 'role';

  // Per-hour count: build 24-hour x date grid
  // For each shift cell with status=WORK, hours from start to end (minus break) — simplify: count an hour h if start ≤ h < end
  const dates = monthDates();
  const hours = Array.from({ length: 24 }, (_, i) => i);

  // Build counts: counts[date][hour][category] = number
  // category in role mode: 'Mgr','JP','Op(JP/EN)','Op(EN)','Night'
  // category in nationality mode: 'JP','KH'
  const counts = {};
  for (const d of dates) counts[d] = hours.map(() => ({}));

  const cats = mode === 'role'
    ? ROLES.filter(r => !(excludeMgr && r === 'Mgr') && !(excludeDE && r === 'DE'))
    : ['JP', 'KH'];

  for (const date of dates) {
    const day = state.shift[date] || {};
    for (const empId in day) {
      const cell = day[empId];
      if (cell.status !== STATUS.WORK) continue;
      const emp = state.employees.find(e => e.id === empId);
      if (!emp) continue;
      if (excludeMgr && (emp.roles || []).includes('Mgr')) continue;
      if (excludeDE  && (emp.roles || []).includes('DE'))  continue;
      const sH = parseInt(cell.start.split(':')[0], 10);
      const sM = parseInt(cell.start.split(':')[1], 10);
      const eH = parseInt(cell.end.split(':')[0], 10);
      const eM = parseInt(cell.end.split(':')[1], 10);
      let startMin = sH * 60 + sM;
      let endMin = eH * 60 + eM;
      if (endMin <= startMin) endMin += 24 * 60;
      // Night worker の朝シフト（INが12時前かつ日をまたがない）はカウント上は翌日扱い
      const isNightEarlyMorning = (emp.roles || []).includes('Night')
        && sH < 12 && eH <= 12 && eH >= sH && (endMin - startMin) <= 12 * 60;
      const countBase = isNightEarlyMorning ? (addDays(date, 1) || date) : date;
      for (let h = 0; h < 48; h++) {
        const slot = h * 60 + 30;
        if (slot >= startMin && slot < endMin) {
          const hh = h % 24;
          // h>=24 は翌日の時間帯 → さらに翌日へ。h<24 は countBase
          const targetDate = h < 24 ? countBase : addDays(countBase, 1);
          if (!targetDate || !counts[targetDate]) continue;
          // 実人数カウント（兼任でも1人として）
          if (!counts[targetDate][hh]['_unique']) counts[targetDate][hh]['_unique'] = new Set();
          counts[targetDate][hh]['_unique'].add(empId);
          if (mode === 'role') {
            // 兼任の場合は ROLES の並び順で最上位ロールのみカウント
            const primaryRole = (emp.roles || []).reduce((best, r) => {
              const idx = ROLES.indexOf(r);
              if (idx === -1) return best;
              return (best === null || idx < ROLES.indexOf(best)) ? r : best;
            }, null);
            if (primaryRole) counts[targetDate][hh][primaryRole] = (counts[targetDate][hh][primaryRole] || 0) + 1;
          } else {
            const c = emp.nationality;
            counts[targetDate][hh][c] = (counts[targetDate][hh][c] || 0) + 1;
          }
        }
      }
    }
  }

  // Build table
  const table = document.createElement('table');
  table.className = 'heatmap';
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  tr.innerHTML = `<th>日付</th><th>種別</th>` + hours.map(h => {
    let cls = '';
    if (h >= 4 && h < 7) cls = 'band-04';
    else if (h >= 7 && h < 12) cls = 'band-07';
    else if (h >= 12 && h < 16) cls = 'band-12';
    else if (h >= 16 && h < 21) cls = 'band-16';
    else cls = 'band-21';
    return `<th class="${cls}">${h}:00</th>`;
  }).join('');
  thead.appendChild(tr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const date of dates) {
    const dow = getDow(date);
    const day = parseInt(date.slice(-2), 10);
    const rowCls = (dow === 0 || isKHHoliday(date) || isJPHoliday(date)) ? 'sun' : '';
    for (const c of cats) {
      const r = document.createElement('tr');
      r.className = rowCls;
      r.innerHTML = `<td class="date-cell">${day}(${DOW_LABELS[dow]})</td><td class="type-cell">${c}</td>` + hours.map(h => {
        const v = counts[date][h][c] || 0;
        return `<td class="clickable-count" data-date="${date}" data-hour="${h}" data-role="${c}" style="cursor:pointer">${v || ''}</td>`;
      }).join('');
      tbody.appendChild(r);
    }
    // Total row (clickable cells → staffing detail panel)
    const totalRow = document.createElement('tr');
    totalRow.className = `total-row ${rowCls}`;
    totalRow.innerHTML = `<td class="date-cell">${day}(${DOW_LABELS[dow]})</td><td class="type-cell">合計</td>` + hours.map(h => {
      // 兼任ロールで重複しないよう実人数（ユニーク）で表示
      const sum = counts[date][h]['_unique']?.size || 0;
      return `<td class="clickable-count" data-date="${date}" data-hour="${h}" style="cursor:pointer">${sum || ''}</td>`;
    }).join('');
    tbody.appendChild(totalRow);

    // Demand rows: one per role in role mode
    if (mode === 'role') {
      // getHave(h, dB) — dBはその時間帯のdemandオブジェクト（残り枠計算に使用）
      const demandRowDefs = [
        { label: 'Mgr',       skip: excludeMgr,
          getDemand: dB => dB.Mgr || 0,
          getHave: (h, dB) => counts[date][h]['Mgr'] || 0 },
        { label: 'JP',        skip: false,
          getDemand: dB => dB.JP || 0,
          getHave: (h, dB) => counts[date][h]['JP'] || 0 },
        { label: 'DE',        skip: excludeDE,
          getDemand: dB => dB.DE || 0,
          getHave: (h, dB) => counts[date][h]['DE'] || 0 },
        { label: 'Op(JP/EN)', skip: false,
          getDemand: dB => dB.opJPMin || 0,
          getHave: (h, dB) => counts[date][h]['Op(JP/EN)'] || 0 },
        // 残り枠 = opTotal - opJPMin。Op(JP/EN)の余剰分 + Op(EN) で充足可能
        { label: 'Op(残り)',  skip: false,
          getDemand: dB => Math.max(0, (dB.opTotal || 0) - (dB.opJPMin || 0)),
          getHave: (h, dB) => {
            const jpEnCount = counts[date][h]['Op(JP/EN)'] || 0;
            const enCount   = counts[date][h]['Op(EN)'] || 0;
            const jpMin     = dB ? (dB.opJPMin || 0) : 0;
            return Math.max(0, jpEnCount - jpMin) + enCount;
          } },
        { label: 'Night',     skip: false,
          getDemand: dB => dB.Night || 0,
          getHave: (h, dB) => counts[date][h]['Night'] || 0 },
      ];
      for (const def of demandRowDefs) {
        if (def.skip) continue;
        const demandRow = document.createElement('tr');
        demandRow.className = `demand-row ${rowCls}`;
        demandRow.innerHTML = `<td class="date-cell">${day}(${DOW_LABELS[dow]})</td><td class="type-cell">必要(${def.label})</td>` + hours.map(h => {
          let need = 0;
          let curDB = null;
          for (const b of TIME_BANDS) {
            if (h >= b.startH && (b.endH > 24 ? (h < b.endH - 24 || h >= b.startH) : h < b.endH)) {
              const dB = state.demand[date]?.[b.id];
              if (dB) { need = def.getDemand(dB); curDB = dB; }
            }
          }
          const have = def.getHave(h, curDB);
          const gap = have < need ? 'gap-cell' : '';
          return `<td class="${gap}">${need || ''}</td>`;
        }).join('');
        tbody.appendChild(demandRow);
      }
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  // Clickable count cells → staffing detail panel
  wrap.addEventListener('click', e => {
    const td = e.target.closest('.clickable-count');
    if (!td) return;
    showHourDetail(td.dataset.date, parseInt(td.dataset.hour, 10), td.dataset.role || null);
  });
}

// ---------- Hour detail panel ----------
function showHourDetail(date, hour, filterRole) {
  const dow = getDow(date);
  const day = parseInt(date.slice(-2), 10);
  const roleLabel = filterRole ? ` [${filterRole}]` : '';
  const label = `${day}(${DOW_LABELS[dow]}) ${hour}:00${roleLabel}`;

  // -- 勤務中の社員を収集 --
  const working = [];
  const seenWorking = new Set();

  function collectWorking(shiftDate) {
    const dayShifts = state.shift[shiftDate] || {};
    for (const empId of Object.keys(dayShifts)) {
      if (seenWorking.has(empId)) continue;
      const cell = dayShifts[empId];
      if (cell.status !== STATUS.WORK) continue;
      const emp = state.employees.find(e => e.id === empId);
      if (!emp) continue;
      const sH = parseInt(cell.start.split(':')[0], 10);
      const sM = parseInt(cell.start.split(':')[1], 10);
      const eH = parseInt(cell.end.split(':')[0], 10);
      const eM = parseInt(cell.end.split(':')[1], 10);
      let startMin = sH * 60 + sM;
      let endMin = eH * 60 + eM;
      if (endMin <= startMin) endMin += 24 * 60;
      // Night worker early morning: stored on shiftDate, counts as shiftDate+1
      const isNightMorning = (emp.roles || []).includes('Night')
        && sH < 12 && eH <= 12 && sH <= eH && (endMin - startMin) <= 12 * 60;
      const effectiveDate = isNightMorning ? (addDays(shiftDate, 1) || shiftDate) : shiftDate;
      if (effectiveDate !== date) continue;
      const slotMin = hour * 60 + 30;
      const covers = endMin <= 24 * 60
        ? (slotMin >= startMin && slotMin < endMin)
        : (shiftDate === date ? slotMin >= startMin : slotMin < endMin - 24 * 60);
      if (covers) { working.push({ emp, cell }); seenWorking.add(empId); }
    }
  }
  collectWorking(date);
  const prev = addDays(date, -1);
  if (prev) collectWorking(prev);

  // ロールフィルタ適用
  const roleMatch = emp => !filterRole || (emp.roles || []).includes(filterRole);
  const workingFiltered = working.filter(({ emp }) => roleMatch(emp));

  // -- OFFで調整可能な社員 --
  const available = [];
  for (const emp of state.employees) {
    if (seenWorking.has(emp.id)) continue;
    if (!roleMatch(emp)) continue;
    if (!(emp.workableDow || []).includes(dow)) continue;
    const cell = state.shift[date]?.[emp.id];
    if (cell && cell.status === STATUS.NG) continue; // NGは除外
    const status = cell?.status || 'none';
    if (status !== STATUS.WORK) available.push({ emp, status });
  }

  // -- パネル描画 --
  let panel = document.getElementById('hour-detail-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'hour-detail-panel';
    document.body.appendChild(panel);
  }

  const roleTag = r => `<span class="role-tag role-${r.toLowerCase().replace(/[^a-z]/g,'')}">${r}</span>`;
  const rolesStr = emp => (emp.roles || []).map(roleTag).join('');

  panel.innerHTML = `
    <div class="hdp-header">
      <span>📋 ${label}</span>
      <button onclick="document.getElementById('hour-detail-panel').style.display='none'">✕</button>
    </div>
    <div class="hdp-section">
      <div class="hdp-title">🟢 勤務中 (${workingFiltered.length}人)</div>
      ${workingFiltered.length === 0 ? '<div class="hdp-empty">なし</div>' :
        workingFiltered.map(({emp, cell}) => `
          <div class="hdp-row">
            <span class="hdp-name">${emp.name}</span>
            ${rolesStr(emp)}
            <span class="hdp-time">${cell.start}–${cell.end}</span>
          </div>`).join('')}
    </div>
    <div class="hdp-section">
      <div class="hdp-title">🟡 OFF・調整可能 (${available.length}人)</div>
      ${available.length === 0 ? '<div class="hdp-empty">なし</div>' :
        available.map(({emp, status}) => `
          <div class="hdp-row">
            <span class="hdp-name">${emp.name}</span>
            ${rolesStr(emp)}
            <span class="hdp-status">${status === 'none' ? '未設定' : status.toUpperCase()}</span>
          </div>`).join('')}
    </div>`;
  panel.style.display = 'block';
}

// ---------- Coverage vs Demand ----------
function computeCoverageVsDemand() {
  let gaps = 0;
  for (const date of monthDates()) {
    for (const b of TIME_BANDS) {
      const need = state.demand[date]?.[b.id] || emptyDemandBand();
      const haveMgr = countAssignedFor(date, b, 'Mgr');
      const haveJP = countAssignedFor(date, b, 'JP');
      const haveDE = countAssignedFor(date, b, 'DE');
      const haveNight = countAssignedFor(date, b, 'Night');
      const haveOpJP = countAssignedFor(date, b, 'Op(JP/EN)');
      const haveOpEN = countAssignedFor(date, b, 'Op(EN)');
      if (haveMgr < (need.Mgr || 0)) gaps += need.Mgr - haveMgr;
      if (haveJP < (need.JP || 0)) gaps += need.JP - haveJP;
      if (haveDE < (need.DE || 0)) gaps += need.DE - haveDE;
      if (haveNight < (need.Night || 0)) gaps += need.Night - haveNight;
      if (haveOpJP < (need.opJPMin || 0)) gaps += need.opJPMin - haveOpJP;
      const opTotalHave = haveOpJP + haveOpEN;
      // count "extra Op beyond opJPMin"
      const extraNeeded = Math.max(0, (need.opTotal || 0) - Math.max(need.opJPMin || 0, opTotalHave));
      gaps += extraNeeded;
    }
  }
  return { gaps };
}

// Count employees whose shift covers (date, band, role). Handles overnight: a shift
// starting on D that crosses midnight may cover bands on D AND on D+1.
function countAssignedFor(date, band, role) {
  let count = 0;
  // 1. Same-date cells
  const day = state.shift[date] || {};
  for (const empId in day) {
    const cell = day[empId];
    if (cell.status !== STATUS.WORK) continue;
    const emp = state.employees.find(e => e.id === empId);
    if (!emp || !(emp.roles || []).includes(role)) continue;
    if (cellCoversBandOnDate(cell, date, date, band)) count++;
  }
  // 2. Previous-date overnight cells that reach into this date's band
  const prev = addDays(date, -1);
  if (prev) {
    const prevDay = state.shift[prev] || {};
    for (const empId in prevDay) {
      // Skip if already counted from same-date
      if (day[empId]?.status === STATUS.WORK) continue;
      const cell = prevDay[empId];
      if (cell.status !== STATUS.WORK) continue;
      const emp = state.employees.find(e => e.id === empId);
      if (!emp || !(emp.roles || []).includes(role)) continue;
      if (cellCoversBandOnDate(cell, prev, date, band)) count++;
    }
  }
  return count;
}

// Unique employees whose WORK shift covers (date, band), regardless of role.
// Dedupes dual-role staff and handles overnight (prev-date cells reaching into this date).
// Returns an array of employee objects. Used by 人員整合性 (volume.js).
function staffedEmployeesInBand(date, band) {
  const seen = new Set();
  const out = [];
  const collect = (cellDate) => {
    const day = state.shift[cellDate] || {};
    for (const empId in day) {
      if (seen.has(empId)) continue;
      const cell = day[empId];
      if (cell.status !== STATUS.WORK) continue;
      const emp = state.employees.find(e => e.id === empId);
      if (!emp) continue;
      if (cellCoversBandOnDate(cell, cellDate, date, band)) { seen.add(empId); out.push(emp); }
    }
  };
  collect(date);
  const prev = addDays(date, -1);
  if (prev) collect(prev);
  return out;
}

// Unique employees whose WORK shift covers a single hour (hour:00–hour:59) on `date`.
// Mirrors showHourDetail's coverage rules (overnight + Night early-morning). Used by 人員整合性 (毎時).
function staffedEmployeesAtHour(date, hour) {
  const seen = new Set();
  const out = [];
  const slotMin = hour * 60 + 30;
  const collect = (shiftDate) => {
    const dayShifts = state.shift[shiftDate] || {};
    for (const empId in dayShifts) {
      if (seen.has(empId)) continue;
      const cell = dayShifts[empId];
      if (cell.status !== STATUS.WORK) continue;
      const emp = state.employees.find(e => e.id === empId);
      if (!emp) continue;
      const startMin = timeToMin(cell.start);
      let endMin = timeToMin(cell.end);
      if (startMin == null || endMin == null) continue;
      if (endMin <= startMin) endMin += 24 * 60;
      const sH = Math.floor(startMin / 60), eH = Math.floor(timeToMin(cell.end) / 60);
      const isNightMorning = (emp.roles || []).includes('Night')
        && sH < 12 && eH <= 12 && sH <= eH && (endMin - startMin) <= 12 * 60;
      const effectiveDate = isNightMorning ? (addDays(shiftDate, 1) || shiftDate) : shiftDate;
      if (effectiveDate !== date) continue;
      const covers = endMin <= 24 * 60
        ? (slotMin >= startMin && slotMin < endMin)
        : (shiftDate === date ? slotMin >= startMin : slotMin < endMin - 24 * 60);
      if (covers) { seen.add(empId); out.push(emp); }
    }
  };
  collect(date);
  const prev = addDays(date, -1);
  if (prev) collect(prev);
  return out;
}

// Returns true if a shift cell (starting on cellDate) covers the given band on bandDate.
// For overnight shifts (end <= start), the shift extends into bandDate = cellDate+1.
function cellCoversBandOnDate(cell, cellDate, bandDate, band) {
  const s = timeToMin(cell.start);
  let e = timeToMin(cell.end);
  if (s == null || e == null) return false;
  const overnight = e <= s;
  if (overnight) e += 24 * 60;
  // Express band start/end relative to cellDate's 00:00.
  // If bandDate == cellDate: band runs from band.startH:00 to band.endH:00 (may exceed 24 for 21-02 case).
  // If bandDate == cellDate+1: shift band by +1440 min.
  let dayOffset = 0;
  if (bandDate === cellDate) dayOffset = 0;
  else {
    const next = addDays(cellDate, 1);
    if (next !== bandDate) return false;
    dayOffset = 1440;
  }
  const bs = band.startH * 60 + dayOffset;
  const be = band.endH * 60 + dayOffset;
  const overlap = Math.min(e, be) - Math.max(s, bs);
  return overlap >= 60; // require at least 60 min overlap
}

function overlapsBand(cell, band) {
  // Back-compat: same-date check
  return cellCoversBandOnDate(cell, '_', '_', band) || (() => {
    const s = timeToMin(cell.start);
    let e = timeToMin(cell.end);
    if (e == null || s == null) return false;
    if (e <= s) e += 24 * 60;
    const bs = band.startH * 60;
    const be = band.endH * 60;
    return (Math.min(e, be) - Math.max(s, bs)) >= 60;
  })();
}

function addDays(yyyymmdd, n) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`;
}

function getEmployeePatterns(emp) {
  if (emp.shiftPatterns && emp.shiftPatterns.length) return emp.shiftPatterns;
  return [{
    start: emp.defaultStart || '09:00',
    end: emp.defaultEnd || '18:00',
    breakMin: emp.defaultBreakMin || 0,
    label: 'デフォ',
  }];
}

function patternOverlapMinutes(pattern, bandDate, cellDate, band) {
  const s = timeToMin(pattern.start);
  let e = timeToMin(pattern.end);
  if (s == null || e == null) return 0;
  const overnight = e <= s;
  if (overnight) e += 24 * 60;
  let dayOffset = 0;
  if (bandDate === cellDate) dayOffset = 0;
  else {
    const next = addDays(cellDate, 1);
    if (next !== bandDate) return 0;
    dayOffset = 1440;
  }
  const bs = band.startH * 60 + dayOffset;
  const be = band.endH * 60 + dayOffset;
  return Math.max(0, Math.min(e, be) - Math.max(s, bs));
}

function weightForDay(date, emp) {
  return (countsDouble(date) && emp.employment === 'FT') ? 2 : 1;
}

// ---------- Auto-assign (rewritten for opTotal/opJPMin model) ----------
function autoAssign() {
  // 1. Wipe existing WORK cells (preserve NG/AL/P/OFF set by user)
  for (const date of monthDates()) {
    if (!state.shift[date]) state.shift[date] = {};
    for (const empId in state.shift[date]) {
      const s = state.shift[date][empId].status;
      if (s === STATUS.WORK) delete state.shift[date][empId];
    }
  }

  // 2. Build per-employee tracker
  const tracker = { days: {}, hours: {} };
  for (const e of state.employees) {
    tracker.days[e.id] = 0;
    tracker.hours[e.id] = 0;
  }

  // 3. Build flat slot list. Each demand unit = 1 slot.
  //    Op demand splits into opJPMin (Op(JP/EN) only) + opTotal-opJPMin (any Op).
  const slots = [];
  for (const date of monthDates()) {
    for (const b of TIME_BANDS) {
      const need = state.demand[date]?.[b.id] || emptyDemandBand();
      for (let i = 0; i < (need.Mgr || 0); i++) slots.push({ date, band: b, kind: 'Mgr', allowedRoles: ['Mgr'], idx: i });
      for (let i = 0; i < (need.JP || 0); i++) slots.push({ date, band: b, kind: 'JP', allowedRoles: ['JP'], idx: i });
      for (let i = 0; i < (need.DE || 0); i++) slots.push({ date, band: b, kind: 'DE', allowedRoles: ['DE'], idx: i });
      for (let i = 0; i < (need.Night || 0); i++) slots.push({ date, band: b, kind: 'Night', allowedRoles: ['Night'], idx: i });
      for (let i = 0; i < (need.opJPMin || 0); i++) slots.push({ date, band: b, kind: 'opJP', allowedRoles: ['Op(JP/EN)'], idx: i });
      const opExtra = Math.max(0, (need.opTotal || 0) - (need.opJPMin || 0));
      for (let i = 0; i < opExtra; i++) slots.push({ date, band: b, kind: 'opAny', allowedRoles: ['Op(JP/EN)', 'Op(EN)'], idx: i });
    }
  }

  // 4. Pre-compute potential candidates for each slot
  for (const slot of slots) {
    slot.potential = state.employees.filter(e => {
      const roles = e.roles || [];
      if (!slot.allowedRoles.some(r => roles.includes(r))) return false;
      const dow = getDow(slot.date);
      if (!((e.workableDow || []).includes(dow))) return false;
      const pats = getEmployeePatterns(e);
      return pats.some(p => patternOverlapMinutes(p, slot.date, slot.date, slot.band) >= 60
                         || patternOverlapMinutes(p, slot.date, addDays(slot.date, -1), slot.band) >= 60);
    });
  }

  // 5. Sort slots by (demand priority asc, potential count asc, date asc)
  slots.sort((a, b) => {
    const pa = DEMAND_PRIORITY[a.kind] || 99;
    const pb = DEMAND_PRIORITY[b.kind] || 99;
    if (pa !== pb) return pa - pb;
    if (a.potential.length !== b.potential.length) return a.potential.length - b.potential.length;
    return a.date.localeCompare(b.date);
  });

  // 6. Phase 1: Greedy fill
  const gaps = [];
  for (const slot of slots) {
    if (isSlotAlreadyFilled(slot)) continue;

    const available = slot.potential.filter(e => isEmployeeAvailable(e, slot, tracker));
    if (available.length === 0) {
      gaps.push({ slot, reason: explainGap(slot, tracker) });
      continue;
    }

    // Score and pick best
    const scored = available.map(e => {
      const pattern = pickBestPattern(e, slot);
      return { emp: e, pattern, score: scoreCandidate(e, slot, pattern, tracker) };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    applyAssignment(slot, best.emp, best.pattern, tracker);
  }

  // 7. Phase 2: Local search (try swaps to fill gaps)
  for (let iter = 0; iter < 30; iter++) {
    let improved = false;
    for (let gi = gaps.length - 1; gi >= 0; gi--) {
      const gap = gaps[gi];
      if (isSlotAlreadyFilled(gap.slot)) { gaps.splice(gi, 1); continue; }
      if (trySwapToFill(gap.slot, tracker, slots)) {
        gaps.splice(gi, 1);
        improved = true;
      }
    }
    if (!improved) break;
  }

  // 7.5 Pad to target days/hours: for each employee under target, assign their default shift
  //     on dates they can work (respecting NG/AL/OFF/dow/consec/rest/caps). Considers BOTH
  //     targetDays AND targetHours; pads while either is below target. Stops at maxDays/maxHours.
  for (const e of state.employees) {
    const hasHourTarget = e.targetHours != null && e.targetHours > 0;
    const hasDayTarget = (e.targetDays || 0) > 0;
    if (!hasHourTarget && !hasDayTarget) continue;
    // Order candidate dates: weekends/holidays first for FT (double-weight)
    const dates = monthDates().slice().sort((a, b) => {
      if (e.employment === 'FT') {
        const wa = countsDouble(a) ? 0 : 1;
        const wb = countsDouble(b) ? 0 : 1;
        if (wa !== wb) return wa - wb;
      }
      return a.localeCompare(b);
    });
    for (const d of dates) {
      // Check remaining: stop only when BOTH targets met (or surpassed)
      const dayRem = hasDayTarget ? (e.targetDays - tracker.days[e.id]) : -1;
      const hourRem = hasHourTarget ? (e.targetHours - tracker.hours[e.id]) : -1;
      if (dayRem <= 0 && hourRem <= 0) break;
      if (state.shift[d]?.[e.id]) continue;
      if (!((e.workableDow || []).includes(getDow(d)))) continue;
      if (consecutiveDaysBefore(e.id, d) >= (e.maxConsecutiveDays || 6)) continue;
      if (consecutiveSpanIncluding(e.id, d) > (e.maxConsecutiveDays || 6)) continue;
      const pat = getEmployeePatterns(e)[0];
      const minRest = (e.minRestHours != null) ? e.minRestHours : 11;
      if (!hasEnoughRest(e, d, pat, minRest)) continue;
      const weight = weightForDay(d, e);
      const shiftHours = calcShiftHoursFromPattern(pat);
      // Cap checks
      const dayCap = (e.maxDays != null) ? e.maxDays : (e.targetDays || 0);
      if (dayCap > 0 && tracker.days[e.id] + weight > dayCap) continue;
      const hourCap = (e.maxHours != null) ? e.maxHours : (e.targetHours != null ? e.targetHours : Infinity);
      if (hourCap !== Infinity && tracker.hours[e.id] + shiftHours > hourCap) continue;
      // Apply
      state.shift[d] = state.shift[d] || {};
      state.shift[d][e.id] = {
        status: STATUS.WORK,
        start: pat.start, end: pat.end, breakMin: pat.breakMin || 0,
      };
      tracker.days[e.id] += weight;
      tracker.hours[e.id] += shiftHours;
    }
  }

  // 8. Final gap report (recompute reasons after local search)
  const finalGaps = [];
  for (const date of monthDates()) {
    for (const b of TIME_BANDS) {
      const need = state.demand[date]?.[b.id] || emptyDemandBand();
      const haveMgr = countAssignedFor(date, b, 'Mgr');
      const haveJP = countAssignedFor(date, b, 'JP');
      const haveNight = countAssignedFor(date, b, 'Night');
      const haveOpJP = countAssignedFor(date, b, 'Op(JP/EN)');
      const haveOpEN = countAssignedFor(date, b, 'Op(EN)');
      const haveDE = countAssignedFor(date, b, 'DE');
      const checks = [
        { kind: 'Mgr', short: Math.max(0, (need.Mgr || 0) - haveMgr), allowedRoles: ['Mgr'] },
        { kind: 'JP', short: Math.max(0, (need.JP || 0) - haveJP), allowedRoles: ['JP'] },
        { kind: 'DE', short: Math.max(0, (need.DE || 0) - haveDE), allowedRoles: ['DE'] },
        { kind: 'Night', short: Math.max(0, (need.Night || 0) - haveNight), allowedRoles: ['Night'] },
        { kind: 'opJP', short: Math.max(0, (need.opJPMin || 0) - haveOpJP), allowedRoles: ['Op(JP/EN)'] },
        { kind: 'opAny', short: Math.max(0, (need.opTotal || 0) - Math.max(need.opJPMin || 0, haveOpJP + haveOpEN)), allowedRoles: ['Op(JP/EN)', 'Op(EN)'] },
      ];
      for (const chk of checks) {
        for (let i = 0; i < chk.short; i++) {
          const fakeSlot = { date, band: b, kind: chk.kind, allowedRoles: chk.allowedRoles, idx: i, potential: state.employees.filter(e => chk.allowedRoles.some(r => (e.roles || []).includes(r))) };
          finalGaps.push({ slot: fakeSlot, reason: explainGap(fakeSlot, tracker) });
        }
      }
    }
  }
  state.gapReport = finalGaps.map(g => ({
    date: g.slot.date,
    bandId: g.slot.band.id,
    kind: g.slot.kind,
    reason: g.reason,
  }));
}

function isSlotAlreadyFilled(slot) {
  const need = state.demand[slot.date]?.[slot.band.id] || emptyDemandBand();
  if (slot.kind === 'Mgr') return countAssignedFor(slot.date, slot.band, 'Mgr') > slot.idx;
  if (slot.kind === 'JP') return countAssignedFor(slot.date, slot.band, 'JP') > slot.idx;
  if (slot.kind === 'DE') return countAssignedFor(slot.date, slot.band, 'DE') > slot.idx;
  if (slot.kind === 'Night') return countAssignedFor(slot.date, slot.band, 'Night') > slot.idx;
  if (slot.kind === 'opJP') return countAssignedFor(slot.date, slot.band, 'Op(JP/EN)') > slot.idx;
  if (slot.kind === 'opAny') {
    const totalOp = countAssignedFor(slot.date, slot.band, 'Op(JP/EN)') + countAssignedFor(slot.date, slot.band, 'Op(EN)');
    return totalOp > ((need.opJPMin || 0) + slot.idx);
  }
  return false;
}

function isEmployeeAvailable(emp, slot, tracker) {
  // Already busy that date (any cell — NG/AL/OFF/WORK)
  // If they already have a WORK shift, they're contributing to band counts via that shift;
  // they cannot fill an *additional* slot in the same band — that would require a different person.
  const existing = state.shift[slot.date]?.[emp.id];
  if (existing && existing.status) return false;
  // Hard cap check: maxDays (if set) else targetDays
  const weight = weightForDay(slot.date, emp);
  const dayCap = (emp.maxDays != null) ? emp.maxDays : (emp.targetDays || 0);
  if (dayCap - tracker.days[emp.id] < weight) return false;
  // Max consecutive days
  const maxC = emp.maxConsecutiveDays || 6;
  if (consecutiveDaysBefore(emp.id, slot.date) >= maxC) return false;
  if (consecutiveSpanIncluding(emp.id, slot.date) > maxC) return false;
  // Min rest hours
  const minRest = (emp.minRestHours != null) ? emp.minRestHours : 11;
  const pattern = pickBestPattern(emp, slot);
  if (!hasEnoughRest(emp, slot.date, pattern, minRest)) return false;
  // Hour cap (if set)
  const hourCap = (emp.maxHours != null) ? emp.maxHours : (emp.targetHours != null ? emp.targetHours : Infinity);
  const shiftHours = calcShiftHoursFromPattern(pattern);
  if (hourCap !== Infinity && tracker.hours[emp.id] + shiftHours > hourCap) return false;
  return true;
}

function consecutiveDaysBefore(empId, date) {
  let count = 0;
  let d = addDays(date, -1);
  while (d.slice(0, 7) === state.month) {
    const cell = state.shift[d]?.[empId];
    if (!cell || cell.status !== STATUS.WORK) break;
    count++;
    d = addDays(d, -1);
  }
  return count;
}

function consecutiveSpanIncluding(empId, date) {
  // Total span including current date and any future already-assigned consecutive days
  let before = consecutiveDaysBefore(empId, date);
  let after = 0;
  let d = addDays(date, 1);
  while (d.slice(0, 7) === state.month) {
    const cell = state.shift[d]?.[empId];
    if (!cell || cell.status !== STATUS.WORK) break;
    after++;
    d = addDays(d, 1);
  }
  return before + 1 + after;
}

function hasEnoughRest(emp, date, pattern, minRestHours) {
  // Check previous day's shift end vs this day's pattern start
  const prev = addDays(date, -1);
  const prevCell = state.shift[prev]?.[emp.id];
  if (prevCell && prevCell.status === STATUS.WORK) {
    const prevEndMin = timeToMin(prevCell.end);
    const prevStartMin = timeToMin(prevCell.start);
    if (prevEndMin != null && prevStartMin != null) {
      const prevEndAbs = (prevEndMin <= prevStartMin ? prevEndMin + 1440 : prevEndMin); // overnight wraps
      const thisStart = timeToMin(pattern.start) + 1440;
      const restMin = thisStart - prevEndAbs;
      if (restMin < minRestHours * 60) return false;
    }
  }
  return true;
}

function pickBestPattern(emp, slot) {
  const patterns = getEmployeePatterns(emp);
  // Score each pattern by overlap with the slot's band (same-date + prev-date for overnight)
  let best = patterns[0];
  let bestScore = -1;
  for (const p of patterns) {
    const ov = patternOverlapMinutes(p, slot.date, slot.date, slot.band);
    if (ov > bestScore) { bestScore = ov; best = p; }
  }
  return best;
}

function scoreCandidate(emp, slot, pattern, tracker) {
  // Higher = better choice
  let score = 0;
  const rem = (emp.targetDays || 0) - tracker.days[emp.id];
  const target = emp.targetDays || 1;
  score += (rem / target) * 100;
  const rolesCount = (emp.roles || []).length || 1;
  score += (1 / rolesCount) * 20;
  const ov = patternOverlapMinutes(pattern, slot.date, slot.date, slot.band);
  score += ov / 60;
  if (countsDouble(slot.date) && emp.employment !== 'FT') score -= 5;
  // For opAny slots, prefer Op(EN)-only employees (preserve Op(JP/EN) for opJP slots)
  if (slot.kind === 'opAny') {
    const roles = emp.roles || [];
    const isOpJPOnly = roles.includes('Op(JP/EN)') && !roles.includes('Op(EN)');
    const isOpENOnly = roles.includes('Op(EN)') && !roles.includes('Op(JP/EN)');
    if (isOpENOnly) score += 30; // big boost: use Op(EN) here, save Op(JP/EN) for JP slots
    if (isOpJPOnly) score -= 10;
  }
  return score;
}

function applyAssignment(slot, emp, pattern, tracker) {
  if (!state.shift[slot.date]) state.shift[slot.date] = {};
  const wasAlreadyWork = state.shift[slot.date][emp.id]?.status === STATUS.WORK;
  state.shift[slot.date][emp.id] = {
    status: STATUS.WORK,
    start: pattern.start,
    end: pattern.end,
    breakMin: pattern.breakMin || 0,
  };
  // Only increment tracker on first WORK assignment for this (date, emp).
  if (!wasAlreadyWork) {
    tracker.days[emp.id] += weightForDay(slot.date, emp);
    tracker.hours[emp.id] += calcShiftHoursFromPattern(pattern);
  }
}

function explainGap(slot, tracker) {
  const date = slot.date;
  const band = slot.band;
  const allowed = slot.allowedRoles;
  const allRoleHolders = state.employees.filter(e => allowed.some(r => (e.roles || []).includes(r)));
  const roleLabel = allowed.length === 1 ? allowed[0] : `${allowed.join('/')}`;
  if (allRoleHolders.length === 0) return `ロール「${roleLabel}」を持つ従業員がいません`;
  let dowOk = 0, statusBlock = 0, targetExhausted = 0, consecBlock = 0, restBlock = 0, patternMiss = 0, sameDayBusy = 0;
  const dow = getDow(date);
  for (const e of allRoleHolders) {
    if (!((e.workableDow || []).includes(dow))) { dowOk++; continue; }
    const existing = state.shift[date]?.[e.id];
    if (existing && existing.status && existing.status !== STATUS.WORK) { statusBlock++; continue; }
    if (existing && existing.status === STATUS.WORK) { sameDayBusy++; continue; }
    const weight = weightForDay(date, e);
    const cap = (e.maxDays != null) ? e.maxDays : (e.targetDays || 0);
    if (cap - tracker.days[e.id] < weight) { targetExhausted++; continue; }
    if (consecutiveDaysBefore(e.id, date) >= (e.maxConsecutiveDays || 6)) { consecBlock++; continue; }
    const pat = pickBestPattern(e, slot);
    if (patternOverlapMinutes(pat, date, date, band) < 60) { patternMiss++; continue; }
    const minRest = (e.minRestHours != null) ? e.minRestHours : 11;
    if (!hasEnoughRest(e, date, pat, minRest)) { restBlock++; continue; }
  }
  const parts = [];
  if (dowOk) parts.push(`曜日NG ${dowOk}名`);
  if (statusBlock) parts.push(`NG/AL/OFF ${statusBlock}名`);
  if (sameDayBusy) parts.push(`同日他枠 ${sameDayBusy}名`);
  if (targetExhausted) parts.push(`月勤務日数達成 ${targetExhausted}名`);
  if (consecBlock) parts.push(`連続勤務上限 ${consecBlock}名`);
  if (patternMiss) parts.push(`時間帯不適合 ${patternMiss}名`);
  if (restBlock) parts.push(`休息時間不足 ${restBlock}名`);
  return `${roleLabel}保持者 ${allRoleHolders.length}名のうち: ` + (parts.join(', ') || '不明');
}

// Local search: try to fill a gap by reassigning someone from another (already-filled) slot
function trySwapToFill(gapSlot, tracker, allSlots) {
  // For each potential candidate (role match, dow ok, has pattern):
  for (const cand of gapSlot.potential || []) {
    if (isEmployeeAvailable(cand, gapSlot, tracker)) {
      // Already available — directly assign (shouldn't happen since gap exists)
      const pattern = pickBestPattern(cand, gapSlot);
      applyAssignment(gapSlot, cand, pattern, tracker);
      return true;
    }
    // Why not available?
    // If they're already working a different cell on the same date, try moving them
    const existing = state.shift[gapSlot.date]?.[cand.id];
    if (existing && existing.status === STATUS.WORK) {
      // Their existing shift doesn't cover this band — try changing their pattern
      const newPattern = pickBestPattern(cand, gapSlot);
      if (patternOverlapMinutes(newPattern, gapSlot.date, gapSlot.date, gapSlot.band) >= 60) {
        // Check if changing their pattern still satisfies other slots they cover (best-effort: skip strict check)
        state.shift[gapSlot.date][cand.id] = {
          status: STATUS.WORK,
          start: newPattern.start,
          end: newPattern.end,
          breakMin: newPattern.breakMin || 0,
        };
        return true;
      }
    }
    // If they're at hard cap (maxDays), try unassigning a low-priority day and reassigning here
    const weight = weightForDay(gapSlot.date, cand);
    const candCap = (cand.maxDays != null) ? cand.maxDays : (cand.targetDays || 0);
    if (candCap - tracker.days[cand.id] < weight) {
      // Find any day they're assigned to that is non-essential (date with surplus coverage)
      const dates = monthDates();
      for (const d of dates) {
        if (d === gapSlot.date) continue;
        const cell = state.shift[d]?.[cand.id];
        if (!cell || cell.status !== STATUS.WORK) continue;
        // Check if removing this cell would create a new gap
        if (removalIsSafe(d, cand)) {
          // Remove
          delete state.shift[d][cand.id];
          tracker.days[cand.id] -= weightForDay(d, cand);
          // Try to assign at gap
          if (isEmployeeAvailable(cand, gapSlot, tracker)) {
            const pattern = pickBestPattern(cand, gapSlot);
            applyAssignment(gapSlot, cand, pattern, tracker);
            return true;
          } else {
            // Revert
            state.shift[d][cand.id] = cell;
            tracker.days[cand.id] += weightForDay(d, cand);
          }
        }
      }
    }
  }
  return false;
}

function removalIsSafe(date, emp) {
  // Removing emp from date is safe if no slot demand requires their unique coverage
  const cell = state.shift[date][emp.id];
  if (!cell) return true;
  for (const b of TIME_BANDS) {
    if (!cellCoversBandOnDate(cell, date, date, b)
     && !cellCoversBandOnDate(cell, date, addDays(date, -1), b)) continue;
    for (const r of (emp.roles || [])) {
      const need = state.demand[date]?.[b.id]?.[r] || 0;
      if (!need) continue;
      const have = countAssignedFor(date, b, r);
      // After removal, have would drop by 1
      if (have - 1 < need) return false;
    }
  }
  return true;
}

// ---------- CSV I/O ----------
function exportCSV() {
  // Export shift table similar to existing format
  const dates = monthDates();
  const rows = [];
  // Header
  const monthLabel = state.month;
  rows.push([`${monthLabel}`, ...dates.flatMap(d => [parseInt(d.slice(-2), 10), '', ''])]);
  rows.push(['', ...dates.flatMap(d => [DOW_LABELS_EN[getDow(d)], '', ''])]);
  rows.push(['ID', 'Name', ...dates.flatMap(() => ['IN', 'OUT', 'Break'])]);

  for (const e of state.employees) {
    const row = [e.id, e.name];
    for (const date of dates) {
      const c = state.shift[date]?.[e.id] || {};
      if (c.status === STATUS.WORK) {
        row.push(c.start || '', c.end || '', c.breakMin ? minToTime(c.breakMin) : 'OFF');
      } else if (c.status === STATUS.OFF) {
        row.push('', '', 'OFF');
      } else if (c.status === STATUS.NG) {
        row.push('', '', 'NG');
      } else if (c.status === STATUS.AL) {
        row.push('', '', 'AL');
      } else if (c.status === STATUS.AL_HALF) {
        row.push('', '', 'AL0.5');
      } else if (c.status === STATUS.P) {
        row.push('', '', 'P');
      } else {
        row.push('', '', '');
      }
    }
    rows.push(row);
  }
  // Also export employees + holidays as additional sheets concat
  rows.push([]);
  rows.push(['# Employees']);
  rows.push(['ID','Name','Nationality','Employment','Roles','TargetDays','MaxDays','TargetHours','MaxHours','DefaultStart','DefaultEnd','BreakMin','WorkableDow','Notes']);
  for (const e of state.employees) {
    rows.push([e.id, e.name, e.nationality, e.employment, (e.roles || []).join('|'), e.targetDays,
      (e.maxDays != null ? e.maxDays : ''),
      (e.targetHours != null ? e.targetHours : ''),
      (e.maxHours != null ? e.maxHours : ''),
      e.defaultStart, e.defaultEnd, e.defaultBreakMin, (e.workableDow || []).join('|'), e.notes || '']);
  }
  rows.push([]);
  rows.push(['# Holidays']);
  rows.push(['Date','Country','Name']);
  for (const h of state.holidays) rows.push([h.date, h.country, h.name]);

  const csv = rows.map(r => r.map(c => csvEscape(c)).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shift-${state.month}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('CSVをダウンロードしました', 'success');
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function importCSV(ev) {
  const f = ev.target.files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      parseAndImportCSV(e.target.result);
      toast('CSVを読み込みました', 'success');
    } catch (err) {
      toast('CSV読込に失敗: ' + err.message, 'error');
    }
    ev.target.value = '';
  };
  reader.readAsText(f, 'utf-8');
}

function parseAndImportCSV(text) {
  text = text.replace(/^﻿/, '');
  if (text.includes('# Employees') || text.includes('# Holidays')) {
    importOwnFormat(text);
  } else if (/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s*\/\s*\d{4}/.test(text)
          || /\bID\s*,\s*Employee\s*name/i.test(text)) {
    importSQAFormat(text);
  } else {
    throw new Error('未対応のCSV形式です (このアプリ出力 or SQA Working Shift 形式のみ対応)');
  }
}

function importOwnFormat(text) {
  const lines = text.split(/\r?\n/);
  let mode = null;
  let headers = null;
  const newEmployees = [];
  const newHolidays = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('# Employees')) { mode = 'employees'; headers = null; continue; }
    if (line.startsWith('# Holidays')) { mode = 'holidays'; headers = null; continue; }
    if (!mode) continue;
    const cols = splitCSVLine(line);
    if (mode === 'employees') {
      if (!headers) { headers = cols; continue; }
      const obj = {};
      headers.forEach((h, i) => obj[h] = cols[i]);
      newEmployees.push({
        id: obj.ID, name: obj.Name,
        nationality: obj.Nationality, employment: obj.Employment,
        roles: (obj.Roles || '').split('|').filter(Boolean),
        targetDays: parseInt(obj.TargetDays || 0, 10),
        maxDays: (obj.MaxDays != null && obj.MaxDays !== '') ? parseInt(obj.MaxDays, 10) : null,
        targetHours: (obj.TargetHours != null && obj.TargetHours !== '') ? parseFloat(obj.TargetHours) : null,
        maxHours: (obj.MaxHours != null && obj.MaxHours !== '') ? parseFloat(obj.MaxHours) : null,
        defaultStart: obj.DefaultStart, defaultEnd: obj.DefaultEnd,
        defaultBreakMin: parseInt(obj.BreakMin || 0, 10),
        workableDow: (obj.WorkableDow || '').split('|').filter(x => x !== '').map(Number),
        notes: obj.Notes || '',
      });
    } else if (mode === 'holidays') {
      if (!headers) { headers = cols; continue; }
      newHolidays.push({ date: cols[0], country: cols[1], name: cols[2] });
    }
  }
  if (newEmployees.length) state.employees = newEmployees;
  if (newHolidays.length) state.holidays = newHolidays;
  save(); renderAll();
}

function importSQAFormat(text) {
  const rows = parseFullCSV(text);
  // Detect month from "May / 2026" header
  const MONTHS = { January:1, February:2, March:3, April:4, May:5, June:6, July:7, August:8, September:9, October:10, November:11, December:12 };
  const flat = rows.slice(0, 3).flat().join('|');
  const mm = flat.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s*\/\s*(\d{4})/);
  if (mm) {
    state.month = `${mm[2]}-${pad2(MONTHS[mm[1]])}`;
  }
  const dim = daysInMonth(state.month);
  ensureMonthScaffolding();

  // Auto-detect the column where day-1 data starts (look for "1" in cols 3-6 of the header rows)
  let dayColStart = 4;
  outer: for (let r = 0; r < Math.min(5, rows.length); r++) {
    for (let c = 3; c <= 6; c++) {
      if ((rows[r][c] || '').trim() === '1') { dayColStart = c; break outer; }
    }
  }

  // Find employee blocks: header rows are those where col0 looks like an ID (digits, 2-4 chars)
  let importedEmployees = 0;
  let updatedShifts = 0;
  let unknownStatuses = new Set();
  for (let i = 0; i < rows.length; i++) {
    const id = (rows[i][0] || '').trim();
    if (!/^\d{2,4}$/.test(id)) continue;
    const header   = rows[i]     || [];
    const inRow    = rows[i + 1] || [];
    const outRow   = rows[i + 2] || [];
    const breakRow = rows[i + 3] || [];
    i += 3;

    // Col 1 = role/dept code, Col 2 = employee name (multi-line in quotes)
    const roleRaw = (header[1] || '').trim().replace(/\t+/g, '/');
    const nameRaw = (header[2] || header[1] || '').trim();
    const nameLines = nameRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const name = nameLines[0] || id;
    const notesFromName = nameLines.slice(1).join(' / ');

    // Detect FT (values 1-2) vs PT (values > 2 = hours) from header row shift values
    const shiftNums = [];
    for (let d = 1; d <= dim; d++) {
      const v = parseFloat((header[dayColStart + 3 * (d - 1)] || '').trim());
      if (!isNaN(v) && v > 0) shiftNums.push(v);
    }
    const isHourBased = shiftNums.length > 0 && shiftNums.some(v => v > 2);

    // Extract most-common IN / OUT / break from the actual timing rows
    const inTimes = [], outTimes = [], brkMins = [];
    for (let d = 1; d <= dim; d++) {
      const col = dayColStart + 3 * (d - 1);
      const inT = (inRow[col] || '').trim();
      const outT = (outRow[col] || '').trim();
      const brkV = (breakRow[col] || '').trim();
      if (inT && /^\d+:\d+$/.test(inT)) inTimes.push(normalizeTime(inT));
      if (outT && /^\d+:\d+$/.test(outT)) outTimes.push(normalizeTime(outT));
      const bm = brkV.match(/^(\d+):(\d+)$/);
      if (bm) brkMins.push(parseInt(bm[1], 10) * 60 + parseInt(bm[2], 10));
    }
    const modalVal = arr => arr.length
      ? arr.sort((a, b) => arr.filter(v => v === b).length - arr.filter(v => v === a).length)[0]
      : null;
    const defStart = modalVal(inTimes)  || '07:00';
    const defEnd   = modalVal(outTimes) || '16:00';
    const defBreak = modalVal(brkMins)  ?? 60;

    const totalHours = isHourBased ? Math.round(shiftNums.reduce((s, v) => s + v, 0)) : 0;

    const { roles: csvRoles, nationality: csvNat } = parseSQACsvRole(roleRaw);

    let emp = state.employees.find(e => e.id === id);
    if (!emp) {
      emp = {
        id, name,
        nationality: csvNat,
        employment: isHourBased ? 'PT' : 'FT',
        roles: csvRoles,
        targetDays: isHourBased ? 0 : 22,
        targetHours: isHourBased ? totalHours : 0,
        defaultStart: defStart,
        defaultEnd: defEnd,
        defaultBreakMin: defBreak,
        workableDow: [0,1,2,3,4,5,6],
        notes: notesFromName,
      };
      state.employees.push(emp);
      importedEmployees++;
    } else {
      // 既存社員: ロール・国籍・雇用形態は変更しない（編集フォームで管理）
      // シフトのデフォ勤務時間のみ更新
      if (defStart) emp.defaultStart    = defStart;
      if (defEnd)   emp.defaultEnd      = defEnd;
      if (defBreak) emp.defaultBreakMin = defBreak;
    }

    // Parse shift per day using detected column start
    for (let d = 1; d <= dim; d++) {
      const col = dayColStart + 3 * (d - 1);
      const inT = (inRow[col] || '').trim();
      const outT = (outRow[col] || '').trim();
      const breakV = (breakRow[col] || '').trim();
      const cell = parseShiftCellFromRaw(inT, outT, breakV, emp);
      if (cell) {
        const date = dateKey(state.month, d);
        if (!state.shift[date]) state.shift[date] = {};
        state.shift[date][id] = cell;
        updatedShifts++;
      } else if (breakV && !['', 'OFF', 'NG', 'AL', 'AL0.5', 'P'].includes(breakV.toUpperCase())) {
        if (!/^\d+:\d+$/.test(breakV)) unknownStatuses.add(breakV);
      }
    }
  }
  save(); renderAll();
  toast(`取り込み完了: 新規 ${importedEmployees} 名 / シフト ${updatedShifts} セル${unknownStatuses.size ? ` (未知ステータス: ${[...unknownStatuses].slice(0,5).join(', ')})` : ''}`, 'success');
}

function parseSQACsvRole(raw) {
  const s = raw.replace(/[\s\t]+/g, '').toUpperCase();
  if (s === 'MGR')                         return { roles: ['Mgr'],         nationality: 'JP' };
  if (s === 'JP')                          return { roles: ['JP'],          nationality: 'JP' };
  if (s === 'NIGHT')                       return { roles: ['Night'],       nationality: 'JP' };
  if (s === 'JP/NIGHT' || s === 'NIGHT/JP') return { roles: ['JP','Night'], nationality: 'JP' };
  if (s === 'OP(JP/EN)')                   return { roles: ['Op(JP/EN)'],   nationality: 'KH' };
  if (s === 'OP(EN)')                      return { roles: ['Op(EN)'],      nationality: 'KH' };
  if (s === 'DE')                          return { roles: ['DE'],          nationality: 'KH' };
  return { roles: ['Op(JP/EN)'], nationality: 'KH' };
}

function parseShiftCellFromRaw(inT, outT, breakV, emp) {
  const bUp = (breakV || '').toUpperCase().replace(/\s+/g, '');
  if (bUp === 'OFF') return { status: STATUS.OFF, start: '', end: '', breakMin: 0 };
  if (bUp === 'NG')  return { status: STATUS.NG,  start: '', end: '', breakMin: 0 };
  if (bUp === 'AL')  return { status: STATUS.AL,  start: '', end: '', breakMin: 0 };
  if (bUp === 'AL0.5' || bUp === 'AL.5') return { status: STATUS.AL_HALF, start: '', end: '', breakMin: 0 };
  if (bUp === 'P')   return { status: STATUS.P,   start: '', end: '', breakMin: 0 };
  // Work cell if has in/out times
  if (inT && outT && /^\d+:\d+$/.test(inT) && /^\d+:\d+$/.test(outT)) {
    let breakMin = 0;
    const bm = breakV.match(/^(\d+):(\d+)$/);
    if (bm) breakMin = parseInt(bm[1], 10) * 60 + parseInt(bm[2], 10);
    return { status: STATUS.WORK, start: normalizeTime(inT), end: normalizeTime(outT), breakMin };
  }
  return null;
}

function normalizeTime(s) {
  const m = s.match(/^(\d+):(\d+)$/);
  if (!m) return s;
  return `${pad2(parseInt(m[1], 10))}:${pad2(parseInt(m[2], 10))}`;
}

// Full CSV parser: handles quoted fields with embedded newlines and double-quote escapes
function parseFullCSV(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function splitCSVLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ---------- Modal ----------
let modalOkHandler = null;
function showModal(title, html, onOk, afterRender) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal').classList.remove('hidden');
  modalOkHandler = onOk;
  const okBtn = document.getElementById('modal-ok');
  okBtn.onclick = () => {
    const ok = modalOkHandler ? modalOkHandler() : true;
    if (ok !== false) closeModal();
  };
  if (afterRender) afterRender();
}
function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  modalOkHandler = null;
}

// ---------- Toast ----------
function toast(msg, type = '') {
  const div = document.createElement('div');
  div.className = 'toast ' + type;
  div.textContent = msg;
  document.getElementById('toast-host').appendChild(div);
  setTimeout(() => div.remove(), 3000);
}

// ---------- Utilities ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- Bridge for cloud.js integration ----------
// Expose state + key functions so cloud.js (regular script) can interact.
window.ShiftApp = {
  get state() { return state; },
  set state(v) { Object.assign(state, v); },
  save, load, renderAll, init,
  // Read-only helpers/constants exposed for volume.js (人員整合性タブ)
  TIME_BANDS, ROLES,
  monthDates, getDow, DOW_LABELS,
  isKHHoliday, isJPHoliday,
  staffedEmployeesInBand, staffedEmployeesAtHour,
  // Override hooks: cloud.js can set these to take over persistence
  saveOverride: null,
  loadOverride: null,
  onStateChanged: null, // fn(newStateFragment) called after each save (for cloud sync)
};

// ---------- Go ----------
document.addEventListener('DOMContentLoaded', () => {
  // If cloud.js sets up an override, it will call init itself after auth.
  // Otherwise, run normal local init.
  if (!window.ShiftApp.loadOverride) {
    init();
  }
});
