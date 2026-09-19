/* İzofleks İş Takibi — PWA
   Veri katmanı iki modda çalışır:
   · bulut  → Firebase Firestore (telefon + bilgisayar gerçek zamanlı senkron)
   · yerel  → localStorage (sadece o cihaz)
   A42 entegrasyonu için dışa açılan arayüz: window.IzoTodo (dosyanın sonunda)
*/
"use strict";

const APP_VERSION = "2026.09.19y";
const FB_VER = "10.12.2";
const FB = (m) => `https://www.gstatic.com/firebasejs/${FB_VER}/firebase-${m}.js`;

/* ============ sabitler ============ */
const DAY_FULL = ['Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi','Pazar'];
const MONTH = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const SWATCH = ['#8A5A24','#3F6B8C','#2F6E52','#8C4A63','#5B5FA6','#96702B','#4A7D7A','#8A4032'];
const LS_KEY = 'izo-takip-v1';

/* ============ tarih ============ */
const pad = n => n < 10 ? '0' + n : '' + n;
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const fromIso = s => { const p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
const mondayOf = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const todayIso = () => iso(new Date());
const shortDate = s => { const d = fromIso(s); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1); };

function weekNo(d){
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const first = new Date(t.getFullYear(), 0, 4);
  return 1 + Math.round(((t - first) / 86400000 - 3 + ((first.getDay() + 6) % 7)) / 7);
}
function rangeLabel(a, b){
  if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${b.getDate()} ${MONTH[b.getMonth()]} ${b.getFullYear()}`;
  if (a.getFullYear() === b.getFullYear()) return `${a.getDate()} ${MONTH[a.getMonth()]} – ${b.getDate()} ${MONTH[b.getMonth()]} ${b.getFullYear()}`;
  return `${a.getDate()} ${MONTH[a.getMonth()]} ${a.getFullYear()} – ${b.getDate()} ${MONTH[b.getMonth()]} ${b.getFullYear()}`;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ============ depo: yerel ============ */
const COLLECTIONS = ['jobs', 'tasks', 'contacts', 'settings'];

function localStore(){
  let data = {};
  try { const raw = localStorage.getItem(LS_KEY); if (raw) data = JSON.parse(raw) || {}; } catch(e){}
  const subs = {};
  COLLECTIONS.forEach(c => { if (!Array.isArray(data[c])) data[c] = []; subs[c] = []; });
  const persist = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch(e){ note('Cihaz belleği dolu — kayıt yapılamadı.'); } };
  const emit = c => subs[c].forEach(f => f(data[c].slice()));
  let seq = 0;
  return {
    kind: 'local',
    subscribe(c, cb){ subs[c].push(cb); cb(data[c].slice()); return () => { subs[c] = subs[c].filter(f => f !== cb); }; },
    add(c, o){ const id = 'l' + Date.now().toString(36) + (++seq); data[c].push({ id, ...o }); persist(); emit(c); return Promise.resolve(id); },
    setId(c, id, o){ const v = data[c].find(r => r.id === id);
      if (v) Object.assign(v, o); else data[c].push({ id, ...o });
      persist(); emit(c); return Promise.resolve(id); },
    update(c, id, p){ data[c] = data[c].map(r => r.id === id ? { ...r, ...p } : r); persist(); emit(c); return Promise.resolve(); },
    remove(c, id){ data[c] = data[c].filter(r => r.id !== id); persist(); emit(c); return Promise.resolve(); }
  };
}

/* ============ depo: Firestore ============ */
function firestoreStore(fs, uid){
  const { db, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc } = fs;
  const base = c => collection(db, 'users', uid, c);
  return {
    kind: 'cloud',
    subscribe(c, cb){
      return onSnapshot(base(c),
        snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
        err => { console.warn(err); note('Senkron hatası: ' + (err.code || 'bilinmiyor')); });
    },
    add(c, o){ const ref = doc(base(c)); return setDoc(ref, o).then(() => ref.id); },
    setId(c, id, o){ return setDoc(doc(db, 'users', uid, c, id), o, { merge: true }).then(() => id); },
    update(c, id, p){ return updateDoc(doc(db, 'users', uid, c, id), p); },
    remove(c, id){ return deleteDoc(doc(db, 'users', uid, c, id)); }
  };
}

/* ============ durum ============ */
const S = {
  tab: 'week',
  weekStart: mondayOf(new Date()),
  view: (() => { try { return localStorage.getItem('izo-view') === 'month' ? 'month' : 'week'; } catch(e){ return 'week'; } })(),
  jobs: [], tasks: [], contacts: [], settings: [],
  a42: { isler: [], at: 0, hata: '' },   // A42 widget'tan gelen devam eden işler
  ref: { c: [], p: [] },   // teklif arşivinden gelen müşteri/proje rehberi (rehber.json)
  showDone: false,
  showArchived: false,
  composer: null,
  draft: { text: '', job: '', day: '' },
  newJob: { customer: '', project: '' },
  picker: null,          // { type:'customer'|'project', q:'', rect:{...} }
  store: null,
  unsub: [],
  auth: null,          // firebase auth nesnesi (bulut modda)
  user: null,          // giriş yapmış kullanıcı
  cloudReady: false
};

const main = document.getElementById('main');
const syncBtn = document.getElementById('sync');
const syncTxt = document.getElementById('sync-t');
const sheet = document.getElementById('sheet');
const sheetBody = document.getElementById('sheet-body');
const sheetTitle = document.getElementById('sheet-title');

function note(msg){
  document.querySelectorAll('.toast').forEach(n => n.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

/* ============ türetilmiş ============ */
/* ---- Genel başlıklar: projeden / mimardan bağımsız görevler ----
   Belge kimliği sabit (gen-…) → hangi cihazdan açılırsa açılsın tek kart. */
const GENEL_HAZIR = [
  { id:'gen-muhasebe', ad:'Muhasebe',    ci:4 },
  { id:'gen-ofis',     ad:'Ofis / İdari', ci:6 },
  { id:'gen-tedarik',  ad:'Tedarikçi',   ci:5 },
  { id:'gen-kisisel',  ad:'Kişisel',     ci:3 },
  { id:'gen-dijital',  ad:'Dijital',      ci:1 }
];
const isGenel = j => !!(j && j.genel);
const genelJobs = () => S.jobs.filter(j => j.genel && !j.archived);
/* hazır başlıklar + kullanıcının eklediği genel başlıklar, kayıtlı olan öne geçer */
function genelListe(){
  const out = [], gor = new Set();
  GENEL_HAZIR.forEach(g => {
    const v = S.jobs.find(j => j.id === g.id);
    if (v && v.archived) return;
    gor.add(g.id);
    out.push({ id: g.id, ad: (v && v.project) || g.ad, ci: (v && typeof v.ci === 'number') ? v.ci : g.ci, var: !!v });
  });
  genelJobs().forEach(j => { if (!gor.has(j.id)) out.push({ id: j.id, ad: j.project || 'Genel', ci: j.ci || 0, var: true }); });
  return out;
}

const activeJobs = () => S.jobs.filter(j => !j.archived);
const jobById = id => S.jobs.find(j => j.id === id) || null;
const jobColor = j => j ? SWATCH[(j.ci || 0) % SWATCH.length] : 'var(--line-2)';
const jobLabel = j => j ? ((j.customer ? j.customer + ' · ' : '') + (j.project || '')) : 'GENEL';
const ordOf = t => (typeof t.ord === 'number' ? t.ord : (t.createdAt || 0));
const byDone = (a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || ordOf(a) - ordOf(b);

const tasksOfDay = d => S.tasks.filter(t => t.day === d && (S.showDone || !t.done)).sort(byDone);
const pinnedTasks  = () => S.tasks.filter(t => t.pin && (S.showDone || !t.done)).sort(byDone);
const undatedTasks = () => S.tasks.filter(t => !t.day && !t.pin && (S.showDone || !t.done)).sort(byDone);
const lateTasks = () => { const t0 = todayIso(); return S.tasks.filter(t => !t.done && !t.pin && t.day && t.day < t0).sort((a,b) => a.day < b.day ? -1 : 1); };
/* --- rehber: müşteri/mimar ve proje adları --- */
const norm = s => String(s || '').trim().toLocaleLowerCase('tr');

const KIND = { O: 'Ofis bölme', K: 'Kapı kasası', S: 'Süpürgelik' };

/* Sıralama: 1) devam eden işler  2) elle eklenen rehber  3) teklif arşivi */
function customerList(){
  const map = new Map();   // normalize -> { name, contactId, n, last, src }
  a42Devam().forEach(x => {                   // A42'de devam eden işlerin müşterileri
    if (!x.musteri) return;
    const k = norm(x.musteri);
    if (!map.has(k)) map.set(k, { name: x.musteri, contactId: null, n: 0, last: '', src: 'job', jobs: 0 });
    map.get(k).jobs++;
  });
  S.jobs.forEach(j => {
    if (!j.customer || j.archived) return;
    const k = norm(j.customer);
    if (!map.has(k)) map.set(k, { name: j.customer, contactId: null, n: 0, last: '', src: 'job', jobs: 0 });
    map.get(k).jobs++;
  });
  S.contacts.forEach(c => {
    if (!c.name) return;
    const k = norm(c.name);
    if (map.has(k)) map.get(k).contactId = c.id;
    else map.set(k, { name: c.name, contactId: c.id, n: 0, last: '', src: 'contact', jobs: 0 });
  });
  S.jobs.forEach(j => {                       // arşivlenmiş işlerin müşterileri
    if (!j.customer || !j.archived) return;
    const k = norm(j.customer);
    if (!map.has(k)) map.set(k, { name: j.customer, contactId: null, n: 0, last: '', src: 'contact', jobs: 0 });
  });
  (S.ref.c || []).forEach(([name, n, last]) => {
    const k = norm(name);
    if (map.has(k)){ const e = map.get(k); e.n = e.n || n; e.last = e.last || last; }
    else map.set(k, { name, contactId: null, n, last, src: 'ref', jobs: 0 });
  });
  const byName = (a, b) => a.name.localeCompare(b.name, 'tr');
  const byFresh = (a, b) => (b.last || '').localeCompare(a.last || '') || b.n - a.n || byName(a, b);
  const GUNCEL = String(new Date().getFullYear() - 1);   // son iki yıl
  const all = [...map.values()];
  const ref = all.filter(x => x.src === 'ref');
  return {
    job:     all.filter(x => x.src === 'job').sort((a, b) => b.jobs - a.jobs || byName(a, b)),
    contact: all.filter(x => x.src === 'contact').sort(byName),
    fresh:   ref.filter(x => (x.last || '') >= GUNCEL).sort(byFresh),
    ref:     ref.filter(x => (x.last || '') <  GUNCEL).sort(byFresh),
    all
  };
}

function projectList(customer){
  const cn = norm(customer);
  const live = new Map(), mine = new Map(), other = new Map();
  const seen = new Set();
  a42Devam().forEach(x => {                   // A42'de devam eden işler
    if (!x.proje) return;
    const k = norm(x.proje);
    if (seen.has(k)) return; seen.add(k);
    live.set(k, { name: x.proje, customer: x.musteri || '', kind: '', year: (String(x.baslangic||'').split('.')[2] || ''),
                  live: true, same: cn && norm(x.musteri) === cn });
  });
  S.jobs.forEach(j => {
    if (!j.project || j.archived) return;
    const k = norm(j.project);
    if (seen.has(k)) return; seen.add(k);
    live.set(k, { name: j.project, customer: j.customer || '', kind: '', year: '', live: true,
                  same: cn && norm(j.customer) === cn });
  });
  (S.ref.p || []).forEach(([cust, proj, kind, year]) => {
    const k = norm(proj);
    if (!proj || seen.has(k)) return; seen.add(k);
    const rec = { name: proj, customer: cust || '', kind: KIND[kind] || '', year };
    (cn && norm(cust) === cn ? mine : other).set(k, rec);
  });
  const srt = m => [...m.values()].sort((a, b) => (b.year || '').localeCompare(a.year || '') || a.name.localeCompare(b.name, 'tr'));
  const lv = [...live.values()].sort((a, b) => (b.same ? 1 : 0) - (a.same ? 1 : 0) || a.name.localeCompare(b.name, 'tr'));
  return { live: lv, mine: srt(mine), other: srt(other) };
}

function ensureContact(name){
  if (!name || !name.trim()) return;
  if (S.contacts.some(c => norm(c.name) === norm(name))) return;
  S.store.add('contacts', { name: name.trim(), createdAt: Date.now() });
}

const tasksOfJob = id => S.tasks.filter(t => t.jobId === id && (S.showDone || !t.done)).sort((a, b) => {
  if ((a.done ? 1 : 0) !== (b.done ? 1 : 0)) return (a.done ? 1 : 0) - (b.done ? 1 : 0);
  const ad = a.day || '9999', bd = b.day || '9999';
  return ad < bd ? -1 : ad > bd ? 1 : (a.createdAt || 0) - (b.createdAt || 0);
});

/* ============ simgeler ============ */
const ICON_LIST = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
  <circle cx="4.5" cy="5.5" r="1.25"/><circle cx="4.5" cy="10" r="1.25"/><circle cx="4.5" cy="14.5" r="1.25"/>
  <rect x="8" y="4.75" width="8.5" height="1.5" rx=".75"/>
  <rect x="8" y="9.25" width="8.5" height="1.5" rx=".75"/>
  <rect x="8" y="13.75" width="8.5" height="1.5" rx=".75"/></svg>`;

const ICON_PIN = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M11.8 2.6 17.4 8.2l-2.3.7a2 2 0 0 0-1 .6l-2.4 2.8-3.9-3.9 2.8-2.4a2 2 0 0 0 .6-1z"/>
  <path d="M7.8 12.2 3.4 16.6"/></svg>`;

const ICON_COPY = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5">
  <rect x="7" y="7" width="8.5" height="8.5" rx="2"/>
  <path d="M12.5 4.5H6a1.5 1.5 0 0 0-1.5 1.5v6.5"/></svg>`;

/* ============ parçalar ============ */
/* Müşteri ve proje ayrı parça: yer daraldığında önce müşteri kısalır,
   proje adının ilk haneleri her zaman görünür kalır. */
function jobLabelHtml(j){
  if (!j) return '<span class="jl"><i class="jp">GENEL</i></span>';
  if (isGenel(j)) return `<span class="jl gen" title="Genel · ${esc(j.project || '')}"><i class="jp">${esc(j.project || 'GENEL')}</i></span>`;
  const c = j.customer || '', pr = j.project || '';
  return `<span class="jl" title="${esc(jobLabel(j))}">`
    + (c ? `<i class="jc">${esc(c)}</i>` : '')
    + (c && pr ? '<i class="jx">·</i>' : '')
    + (pr ? `<i class="jp">${esc(pr)}</i>` : '')
    + '</span>';
}

function taskHtml(t, o = {}){
  const j = jobById(t.jobId);
  const late = !t.done && !t.pin && t.day && t.day < todayIso();
  const meta = o.showDay ? `<span class="dbadge">${t.day ? esc(shortDate(t.day)) : 'tarihsiz'}</span>` : '';
  return `<div class="task${t.done ? ' done' : ''}${late ? ' late' : ''}" data-id="${t.id}">
    <span class="stripe" style="background:${jobColor(j)}" data-drag="${t.id}" title="Sürükle" aria-hidden="true"></span>
    <button class="box" data-act="toggle" data-id="${t.id}" aria-label="Tamamlandı işaretle" aria-pressed="${t.done ? 'true' : 'false'}">
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 6.2L4.4 9 10.5 2.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <span class="body">${o.hideJob ? '' : jobLabelHtml(j)}<span class="tt">${esc(t.text)}${meta}</span></span>
    <span class="acts">${t.day ? `<button class="fwd" data-act="day-fwd" data-id="${t.id}" aria-label="Bir gün ileri al" title="Bir gün ileri">\u203A</button>` : ''}<button class="pinb${t.pin ? ' on' : ''}" data-act="pin" data-id="${t.id}" aria-label="${t.pin ? 'Sabitten çıkar' : 'Sabitle'}" aria-pressed="${t.pin ? 'true' : 'false'}" title="${t.pin ? 'Sabitten çıkar' : 'Sabitle'}">${ICON_PIN}</button><button class="dup" data-act="dup-task" data-id="${t.id}" aria-label="Görevi çoğalt" title="Çoğalt">${ICON_COPY}</button><button class="kill" data-act="del-task" data-id="${t.id}" aria-label="Görevi sil" title="Sil">×</button></span>
  </div>`;
}

function composerHtml(scope){
  const sec = jobById(S.draft.job);
  const jobSel = scope.startsWith('job:') ? '' :
    `<button type="button" class="jobpick${sec ? '' : ' bos'}" id="c-job" data-act="pick" data-type="job"
       aria-label="İş / proje seç" title="Devam eden işler ve teklif arşivinden seç">
       <span class="jp-nm">${sec ? esc(jobLabel(sec)) : 'İş / proje seç…'}</span>${ICON_LIST}</button>`;
  const daySel = (scope === 'week' || scope === 'undated' || scope === 'pin') ? '' : `<input type="date" id="c-day" value="${esc(S.draft.day || '')}" aria-label="Gün">`;
  return `<div class="composer">${jobSel}${daySel}
    <input type="text" id="c-text" placeholder="Ne yapılacak?" autocomplete="off" aria-label="Görev">
    <div class="row"><button class="btn primary" data-act="save-task">Ekle</button>
    <button class="btn ghost" data-act="cancel-composer">İptal</button></div></div>`;
}

/* ============ tatil takvimi ============
   TR: resmî tatiller (arefe yarım günler ayrıca işaretli)
   US: NYSE'nin kapalı olduğu günler — ABD piyasası takibi için */
const TATIL_TR = {
  '2026-01-01':'Yılbaşı',
  '2026-03-19':'Ramazan Bayramı arefesi · yarım gün',
  '2026-03-20':'Ramazan Bayramı 1. gün',
  '2026-03-21':'Ramazan Bayramı 2. gün',
  '2026-03-22':'Ramazan Bayramı 3. gün',
  '2026-04-23':'Ulusal Egemenlik ve Çocuk Bayramı',
  '2026-05-01':'Emek ve Dayanışma Günü',
  '2026-05-19':'Atatürk\u2019ü Anma, Gençlik ve Spor Bayramı',
  '2026-05-26':'Kurban Bayramı arefesi · yarım gün',
  '2026-05-27':'Kurban Bayramı 1. gün',
  '2026-05-28':'Kurban Bayramı 2. gün',
  '2026-05-29':'Kurban Bayramı 3. gün',
  '2026-05-30':'Kurban Bayramı 4. gün',
  '2026-07-15':'Demokrasi ve Millî Birlik Günü',
  '2026-08-30':'Zafer Bayramı',
  '2026-10-28':'Cumhuriyet Bayramı arefesi · yarım gün',
  '2026-10-29':'Cumhuriyet Bayramı',
  '2027-01-01':'Yılbaşı',
  '2027-03-08':'Ramazan Bayramı arefesi · yarım gün',
  '2027-03-09':'Ramazan Bayramı 1. gün',
  '2027-03-10':'Ramazan Bayramı 2. gün',
  '2027-03-11':'Ramazan Bayramı 3. gün',
  '2027-04-23':'Ulusal Egemenlik ve Çocuk Bayramı',
  '2027-05-01':'Emek ve Dayanışma Günü',
  '2027-05-15':'Kurban Bayramı arefesi · yarım gün',
  '2027-05-16':'Kurban Bayramı 1. gün',
  '2027-05-17':'Kurban Bayramı 2. gün',
  '2027-05-18':'Kurban Bayramı 3. gün',
  '2027-05-19':'Kurban Bayramı 4. gün · Gençlik ve Spor Bayramı',
  '2027-07-15':'Demokrasi ve Millî Birlik Günü',
  '2027-08-30':'Zafer Bayramı',
  '2027-10-28':'Cumhuriyet Bayramı arefesi · yarım gün',
  '2027-10-29':'Cumhuriyet Bayramı'
};
const TATIL_US = {
  '2026-01-01':'New Year\u2019s Day',
  '2026-01-19':'Martin Luther King Jr. Day',
  '2026-02-16':'Washington\u2019s Birthday',
  '2026-04-03':'Good Friday',
  '2026-05-25':'Memorial Day',
  '2026-06-19':'Juneteenth',
  '2026-07-03':'Independence Day (4 Temmuz Cumartesi)',
  '2026-09-07':'Labor Day',
  '2026-11-26':'Thanksgiving',
  '2026-12-25':'Christmas',
  '2027-01-01':'New Year\u2019s Day',
  '2027-01-18':'Martin Luther King Jr. Day',
  '2027-02-15':'Washington\u2019s Birthday',
  '2027-03-26':'Good Friday',
  '2027-05-31':'Memorial Day',
  '2027-06-18':'Juneteenth (19 Haziran Cumartesi)',
  '2027-07-05':'Independence Day (4 Temmuz Pazar)',
  '2027-09-06':'Labor Day',
  '2027-11-25':'Thanksgiving',
  '2027-12-24':'Christmas (25 Aralık Cumartesi)'
};
const YARIM = d => /arefesi/.test(TATIL_TR[d] || '');
const tatilSinif = d => (TATIL_TR[d] ? (YARIM(d) ? ' htr yarim' : ' htr') : '') + (TATIL_US[d] ? ' hus' : '');
const KISA_TR = {"Yılbaşı": "Yılbaşı", "Ramazan Bayramı arefesi · yarım gün": "Arefe · yarım gün", "Ramazan Bayramı 1. gün": "Ramazan B. 1", "Ramazan Bayramı 2. gün": "Ramazan B. 2", "Ramazan Bayramı 3. gün": "Ramazan B. 3", "Ulusal Egemenlik ve Çocuk Bayramı": "23 Nisan", "Emek ve Dayanışma Günü": "1 Mayıs", "Atatürk’ü Anma, Gençlik ve Spor Bayramı": "19 Mayıs", "Kurban Bayramı arefesi · yarım gün": "Arefe · yarım gün", "Kurban Bayramı 1. gün": "Kurban B. 1", "Kurban Bayramı 2. gün": "Kurban B. 2", "Kurban Bayramı 3. gün": "Kurban B. 3", "Kurban Bayramı 4. gün": "Kurban B. 4", "Kurban Bayramı 4. gün · Gençlik ve Spor Bayramı": "Kurban B. 4 · 19 Mayıs", "Demokrasi ve Millî Birlik Günü": "15 Temmuz", "Zafer Bayramı": "Zafer Bayramı", "Cumhuriyet Bayramı arefesi · yarım gün": "Arefe · yarım gün", "Cumhuriyet Bayramı": "Cumhuriyet B."};
const KISA_US = {"New Year’s Day": "New Year", "Martin Luther King Jr. Day": "MLK Day", "Washington’s Birthday": "Washington", "Good Friday": "Good Friday", "Memorial Day": "Memorial Day", "Juneteenth": "Juneteenth", "Juneteenth (19 Haziran Cumartesi)": "Juneteenth", "Independence Day (4 Temmuz Cumartesi)": "Independence Day", "Independence Day (4 Temmuz Pazar)": "Independence Day", "Labor Day": "Labor Day", "Thanksgiving": "Thanksgiving", "Christmas": "Christmas", "Christmas (25 Aralık Cumartesi)": "Christmas"};
const kisaTr = d => KISA_TR[TATIL_TR[d]] || TATIL_TR[d] || '';
const kisaUs = d => KISA_US[TATIL_US[d]] || TATIL_US[d] || '';

function tatilRozet(d){
  let h = '';
  if (TATIL_TR[d]) h += `<span class="hchip tr" title="${esc(TATIL_TR[d])}">TR</span>`;
  if (TATIL_US[d]) h += `<span class="hchip us" title="ABD piyasası kapalı — ${esc(TATIL_US[d])}">ABD</span>`;
  return h;
}

/* gün hücresinde tatil adı — kisa=true ise ay görünümü için kısaltılmış */
function tatilSatir(d, kisa){
  if (!TATIL_TR[d] && !TATIL_US[d]) return '';
  let h = '<div class="hname">';
  if (TATIL_TR[d]) h += `<i class="${YARIM(d) ? 'yarim' : 'tr'}" title="${esc(TATIL_TR[d])}">${esc(kisa ? kisaTr(d) : TATIL_TR[d])}</i>`;
  if (TATIL_US[d]) h += `<i class="us" title="ABD piyasası kapalı — ${esc(TATIL_US[d])}">ABD · ${esc(kisa ? kisaUs(d) : TATIL_US[d])}</i>`;
  return h + '</div>';
}
function tatilAd(d){
  const a = [];
  if (TATIL_TR[d]) a.push(TATIL_TR[d]);
  if (TATIL_US[d]) a.push('ABD piyasası kapalı — ' + TATIL_US[d]);
  return a.join(' · ');
}

function weekView(){
  const start = S.weekStart, end = addDays(start, 6), t0 = todayIso();
  const late = lateTasks();
  let h = `<div class="weekbar">
    <div><h2>${esc(rangeLabel(start, end))}</h2><div class="kw">${weekNo(start)}. HAFTA</div></div>
    <div class="navbtns">${gorunumAnahtari()}
      <button class="btn" data-act="today">Bu hafta</button>
      <button class="btn icon" data-act="week" data-v="-1" aria-label="Önceki hafta">‹</button>
      <button class="btn icon" data-act="week" data-v="1" aria-label="Sonraki hafta">›</button>
      <button class="btn" data-act="toggle-done" aria-pressed="${S.showDone}">Bitenler</button>
    </div></div>`;

  if (late.length){
    h += `<div class="late-strip"><h3>Geciken · ${late.length}</h3><div class="late-list">`;
    late.slice(0, 6).forEach(t => {
      const j = jobById(t.jobId);
      h += `<div class="late-row">
        <span class="ld">${esc(shortDate(t.day))}</span>
        <span style="width:3px;height:14px;background:${jobColor(j)};border-radius:2px"></span>
        <span style="flex:1;min-width:140px">${esc(t.text)} <span style="color:var(--ink-3);font-size:11.5px">— ${esc(jobLabel(j))}</span></span>
        <button class="btn" data-act="to-today" data-id="${t.id}">Bugüne al</button>
        <button class="btn ghost" data-act="toggle" data-id="${t.id}">Bitti</button></div>`;
    });
    if (late.length > 6) h += `<div class="empty-note">+${late.length - 6} görev daha</div>`;
    h += `</div></div>`;
  }

  h += '<div class="weekwrap">' + pinPanelHtml() + '<div class="weekmain"><div class="weekgrid">';
  for (let i = 0; i < 7; i++){
    const d = addDays(start, i), di = iso(d), list = tasksOfDay(di);
    const open = S.tasks.filter(t => t.day === di && !t.done).length;
    const composing = S.composer && S.composer.scope === 'week' && S.composer.day === di;
    h += `<section class="day${i > 4 ? ' weekend' : ''}${di === t0 ? ' today' : ''}${tatilSinif(di)}" ${tatilAd(di) ? `title="${esc(tatilAd(di))}"` : ''}>
      <div class="day-h"><span class="dn">${DAY_FULL[i]}</span><span class="dd">${pad(d.getDate())}.${pad(d.getMonth() + 1)}</span>${open ? `<span class="cnt">${open}</span>` : ''}</div>
      ${tatilSatir(di, false)}
      <div class="day-b" data-drop="${di}">${list.map(t => taskHtml(t)).join('')}${composing ? composerHtml('week') : ''}</div>
      <div class="day-f">${composing ? '' : `<button class="addlink" data-act="open-composer" data-scope="week" data-day="${di}">+ görev</button>`}</div>
    </section>`;
  }
  h += '</div>';

  // ince bırakma şeridi — tam liste artık Tarihsiz sekmesinde
  const n = undatedTasks().length;
  h += `<div class="dropstrip" data-drop="">
    <span class="ds-t">Tarihsiz</span>
    <span class="ds-n">${n ? n + ' görev' : 'boş'}</span>
    <span class="ds-hint">buraya bırak</span>
    <button class="btn ghost" data-act="tab" data-v="undated">Aç</button>
  </div>`;
  return h + '</div></div>';
}

/* ---- SABİT görevler: takvimde yeri olmayan, hep görünen işler ---- */
function pinPanelHtml(){
  const list = pinnedTasks();
  const composing = S.composer && S.composer.scope === 'pin';
  return `<aside class="pinpanel" aria-label="Sabit görevler">
    <div class="pin-h"><h3>Sabit</h3><span class="pin-n">${list.length || ''}</span></div>
    <div class="pin-b" data-drop="pin">${
      list.length ? list.map(t => taskHtml(t, { pinli: true })).join('')
                  : '<div class="pin-bos">Takvimde yeri olmayan işler burada durur — bir kartı buraya sürükleyin ya da aşağıdan ekleyin.</div>'
    }${composing ? composerHtml('pin') : ''}</div>
    <div class="pin-f">${composing ? '' : '<button class="addlink" data-act="open-composer" data-scope="pin" data-day="">+ sabit görev</button>'}</div>
  </aside>`;
}

function undatedView(){
  const und = undatedTasks();
  const acik = S.tasks.filter(t => !t.day && !t.pin && !t.done).length;
  const composing = S.composer && S.composer.scope === 'undated';
  let h = `<div class="jobs-head"><h2>Tarihsiz</h2><div class="navbtns">
    <button class="btn" data-act="toggle-done" aria-pressed="${S.showDone}">Bitenler</button>
    <button class="btn primary" data-act="open-composer" data-scope="undated" data-day="">+ Görev</button></div></div>
    <p class="who">Tarihe bağlı olmayan genel işler · ${acik} açık</p>`;
  h += `<div class="undlist" data-drop="">`;
  h += und.length ? und.map(t => taskHtml(t)).join('')
                  : '<div class="empty-note">Tarihe bağlı olmayan görev yok.</div>';
  h += composing ? composerHtml('undated') : '';
  h += `</div>`;
  return h;
}

function gorunumAnahtari(){
  return `<span class="vsw">
    <button class="btn${S.view === 'week' ? ' primary' : ''}" data-act="setview" data-v="week">Hafta</button>
    <button class="btn${S.view === 'month' ? ' primary' : ''}" data-act="setview" data-v="month">Ay</button>
  </span>`;
}

function monthView(){
  const ay = new Date(S.weekStart.getFullYear(), S.weekStart.getMonth(), 1);
  const ilk = mondayOf(ay), t0 = todayIso();
  const son = new Date(ay.getFullYear(), ay.getMonth() + 1, 0);
  const hafta = Math.ceil((((son - ilk) / 86400000) + 1) / 7);
  let h = `<div class="weekbar">
    <div><h2>${MONTH[ay.getMonth()]} ${ay.getFullYear()}</h2><div class="kw">AY GÖRÜNÜMÜ</div></div>
    <div class="navbtns">${gorunumAnahtari()}
      <button class="btn" data-act="today">Bu ay</button>
      <button class="btn icon" data-act="month" data-v="-1" aria-label="Önceki ay">‹</button>
      <button class="btn icon" data-act="month" data-v="1" aria-label="Sonraki ay">›</button>
      <button class="btn" data-act="toggle-done" aria-pressed="${S.showDone}">Bitenler</button>
    </div></div>`;

  h += '<div class="weekwrap">' + pinPanelHtml() + '<div class="weekmain">';
  h += '<div class="monthhead">' + DAY_FULL.map(d => `<div>${d}</div>`).join('') + '</div>';
  h += '<div class="monthgrid">';
  for (let i = 0; i < hafta * 7; i++){
    const d = addDays(ilk, i), di = iso(d);
    const disi = d.getMonth() !== ay.getMonth();
    const list = tasksOfDay(di);
    const composing = S.composer && S.composer.scope === 'week' && S.composer.day === di;
    h += `<section class="day mday${d.getDay() === 0 || d.getDay() === 6 ? ' weekend' : ''}${di === t0 ? ' today' : ''}${disi ? ' disi' : ''}${tatilSinif(di)}" ${tatilAd(di) ? `title="${esc(tatilAd(di))}"` : ''}>
      <div class="day-h"><span class="dn">${d.getDate()}</span>${list.length ? `<span class="cnt">${list.length}</span>` : ''}</div>
      ${tatilSatir(di, true)}
      <div class="day-b" data-drop="${di}">${list.map(t => taskHtml(t)).join('')}${composing ? composerHtml('week') : ''}</div>
      <div class="day-f">${composing ? '' : `<button class="addlink" data-act="open-composer" data-scope="week" data-day="${di}">+</button>`}</div>
    </section>`;
  }
  h += '</div>';

  const n = undatedTasks().length;
  h += `<div class="dropstrip" data-drop="">
    <span class="ds-t">Tarihsiz</span>
    <span class="ds-n">${n ? n + ' görev' : 'boş'}</span>
    <span class="ds-hint">buraya bırak</span>
    <button class="btn ghost" data-act="tab" data-v="undated">Aç</button>
  </div>`;
  h += tatilLegend();
  return h + '</div></div>';
}

function tatilLegend(){
  return `<div class="hleg">
    <span><i class="sw tr"></i> Resmî tatil (TR)</span>
    <span><i class="sw yarim"></i> Arefe · yarım gün</span>
    <span><i class="sw us"></i> ABD piyasası kapalı</span>
  </div>`;
}

function jobsView(){
  const hepsi = S.jobs.filter(j => S.showArchived || !j.archived);
  const list  = hepsi.filter(j => !j.genel);
  const genl  = hepsi.filter(j =>  j.genel);
  let h = `<div class="jobs-head"><h2>İşler</h2><div class="navbtns">
    <button class="btn" data-act="toggle-done" aria-pressed="${S.showDone}">Bitenler</button>
    <button class="btn" data-act="toggle-arch" aria-pressed="${S.showArchived}">Arşiv</button>
    <button class="btn primary" data-act="open-job-form">+ Yeni iş</button></div></div>`;

  const newJob = S.composer && S.composer.scope === 'newjob';
  if (newJob){
    h += `<div class="job" style="margin-bottom:12px"><div class="job-b"><div class="composer">
      <div class="field">
        <input type="text" id="j-cust" placeholder="Müşteri / mimar (örn. Metrak Mimarlık)" autocomplete="off" aria-label="Müşteri / mimar">
        <button class="pick" data-act="pick" data-type="customer" aria-label="Rehberden müşteri seç" title="Rehberden seç">${ICON_LIST}</button>
      </div>
      <div class="field">
        <input type="text" id="j-proj" placeholder="Proje adı (örn. Hersek Tersanesi)" autocomplete="off" aria-label="Proje adı">
        <button class="pick" data-act="pick" data-type="project" aria-label="Geçmiş projelerden seç" title="Geçmiş projelerden seç">${ICON_LIST}</button>
      </div>
      <div class="row"><button class="btn primary" data-act="save-job">Kaydet</button>
      <button class="btn ghost" data-act="cancel-composer">İptal</button></div></div></div></div>`;
  }

  if (!list.length && !genl.length && !newJob) return h + blankHtml();

  const kartlar = arr => { let o = '<div class="joblist">'; arr.forEach(j => { o += jobKartHtml(j); }); return o + '</div>'; };
  if (list.length) h += kartlar(list);
  else if (!newJob) h += '<p class="empty-note">Henüz proje işi yok.</p>';
  /* Genel başlıklar ayrı bölümde — mimar/proje kartlarına karışmaz */
  h += `<div class="band"><div class="band-h"><h3>Genel · projeden bağımsız</h3><span class="rule"></span></div></div>`;
  h += genl.length ? kartlar(genl)
     : '<p class="empty-note">Genel görev yok — görev eklerken iş seçiciden “Genel” başlıklarından birini seçin.</p>';
  return h + dataPanelHtml();
}

function jobKartHtml(j){
  {
    const ts = tasksOfJob(j.id);
    const open = S.tasks.filter(t => t.jobId === j.id && !t.done).length;
    const done = S.tasks.filter(t => t.jobId === j.id && t.done).length;
    const composing = S.composer && S.composer.scope === 'job:' + j.id;
    return `<article class="job${j.archived ? ' archived' : ''}${j.genel ? ' gen' : ''}">
      <div class="job-h"><span class="swatch" style="background:${jobColor(j)}"></span>
        <span class="nm"><span class="cust">${esc(j.genel ? 'GENEL' : (j.customer || '—'))}</span><div class="proj">${esc(j.project || 'İsimsiz proje')}</div></span>
        <span class="acts">
          <button class="btn ghost ico" data-act="dup-job" data-id="${j.id}" title="İşi çoğalt" aria-label="İşi çoğalt">${ICON_COPY}</button>
          <button class="btn ghost" data-act="arch-job" data-id="${j.id}" title="${j.archived ? 'Arşivden çıkar' : 'Arşivle'}">${j.archived ? '↺' : '⌁'}</button>
          <button class="btn ghost" data-act="del-job" data-id="${j.id}" title="Sil">×</button></span></div>
      <div class="job-stat"><span><b>${open}</b> açık</span><span><b>${done}</b> biten</span></div>
      <div class="job-b">${ts.length ? ts.map(t => taskHtml(t, { hideJob: true, showDay: true })).join('') : '<div class="empty-note">Görev yok.</div>'}
        ${composing ? composerHtml('job:' + j.id) : `<button class="addlink" data-act="open-composer" data-scope="job:${j.id}" data-day="">+ görev</button>`}
      </div></article>`;
  }
}

const blankHtml = () => `<div class="blank"><h3>Henüz iş yok</h3>
  <p>Devam eden bir iş ekleyin — müşteri/mimar ve proje adı yeterli. Sonra haftanın günlerine görev yazıp bitince tikleyin.</p>
  <div class="row"><button class="btn primary" data-act="open-job-form">+ Yeni iş ekle</button>
  <button class="btn" data-act="seed">Örnek işlerle dene</button></div></div>`;

const dataPanelHtml = () => `<details class="data"><summary>Veri · dışa/içe aktarım (A42)</summary><div class="inner">
  <p>A42 widget’ına taşımak ya da yedek almak için: aşağıdaki JSON tüm işleri ve görevleri içerir. Yapıştırıp <b>İçe aktar</b> derseniz kayıtlar mevcutlara eklenir.</p>
  <textarea id="io" spellcheck="false" placeholder="JSON"></textarea>
  <div class="navbtns" style="margin-left:0">
    <button class="btn" data-act="export">Dışa aktar</button>
    <button class="btn" data-act="import">İçe aktar</button>
    <button class="btn" data-act="purge-done">Biten görevleri temizle</button>
  </div></div></details>`;

/* ============ A42 bağlantısı ============ */
/* Adres kodda durmaz — hesabın altına kaydedilir (depo herkese açık). */
const getSetting = k => (S.settings.find(x => x.k === k) || {}).v || '';
function setSetting(k, v){
  const r = S.settings.find(x => x.k === k);
  return r ? S.store.update('settings', r.id, { v })
           : S.store.add('settings', { k, v });
}

/* Apps Script JSONP ile yanıt veriyor (CORS başlığı yok) */
function jsonp(url, ms){
  return new Promise((ok, no) => {
    const cb = '_a42cb' + Date.now() + Math.floor(Math.random() * 1000);
    const s = document.createElement('script');
    let bitti = false;
    const kapat = () => { try { delete window[cb]; } catch(e){} try { s.remove(); } catch(e){} };
    window[cb] = res => { if (bitti) return; bitti = true; kapat(); ok(res || {}); };
    s.onerror = () => { if (bitti) return; bitti = true; kapat(); no(new Error('bağlantı hatası')); };
    s.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'cb=' + cb + '&r=' + Math.random();
    document.head.appendChild(s);
    setTimeout(() => { if (bitti) return; bitti = true; kapat(); no(new Error('zaman aşımı')); }, ms || 15000);
  });
}

const GENEL_GIDER = x => {
  const t = ((x.musteri || '') + ' ' + (x.proje || '')).toLocaleLowerCase('tr');
  return t.includes('genel gider') || String(x.is_id || '').toUpperCase().startsWith('GEN');
};
const a42Devam = () => (S.a42.isler || [])
  .filter(x => String(x.durum || 'DEVAM') === 'DEVAM' && !GENEL_GIDER(x))
  .sort((a, b) => String(b.baslangic || '').split('.').reverse().join('')
                 .localeCompare(String(a.baslangic || '').split('.').reverse().join('')));

let a42Bekliyor = false;
async function loadA42(yumusak){
  const url = getSetting('a42url');
  if (!url){ S.a42 = { isler: [], at: 0, hata: '' }; return; }
  if (a42Bekliyor) return;
  if (yumusak && S.a42.at && Date.now() - S.a42.at < 600000) return;
  a42Bekliyor = true;
  try {
    const res = await jsonp(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'fn=list', 20000);
    if (res && res.ok){
      S.a42 = { isler: res.isler || [], at: Date.now(), hata: '' };
    } else {
      S.a42 = { ...S.a42, hata: 'A42 yanıtı okunamadı' };
    }
  } catch(e){
    S.a42 = { ...S.a42, hata: 'A42 bağlantısı kurulamadı (' + e.message + ')' };
  }
  a42Bekliyor = false;
  renderPicker();
}


/* ============ sesli komut ============
   1) Tarayıcının tr-TR konuşma tanıması metne çevirir
   2) Metin Claude'a gider, JSON komut döner
   3) Güven yüksekse doğrudan uygulanır, değilse onay istenir
   API anahtarı kodda değil — hesabın altında (settings) saklanır. */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const sesDestek = () => !!SR;
let sesTanir = null;
const V = { acik:false, durum:'', metin:'', sonuc:null, sorgu:false };

const vEl  = () => document.getElementById('voice');
const vSet = (durum, metin) => {
  const d = document.getElementById('v-state'), t = document.getElementById('v-text');
  if (d && durum != null) d.textContent = durum;
  if (t && metin != null) t.textContent = metin;
};

function voiceAc(){
  V.acik = true; V.metin = ''; V.sonuc = null;
  vEl().hidden = false;
  document.getElementById('v-body').innerHTML =
    '<p class="vq">Konuşun — dinlemeyi siz bitirene kadar açık kalır. Bitince “Bitir”e basın.</p>';
  document.getElementById('v-acts').innerHTML =
    '<button class="btn primary" data-act="voice-bitir">Bitir</button>' +
    '<button class="btn" data-act="voice-close">Vazgeç</button>';
  vEl().classList.add('dinliyor');
  vSet('Dinleniyor…', '');
}
function voiceKapat(){
  V.acik = false;
  V.cevapModu = false;
  soruTur = 0;
  susturKonus();
  sesBitti = true;
  try { sesTanir && sesTanir.abort(); } catch(e){}
  sesTanir = null;
  const e = vEl(); if (e){ e.hidden = true; e.classList.remove('dinliyor'); }
}

/* Cümleyi yarıda kesmesin diye:
   · continuous=true → tarayıcı ilk duraklamada durmaz
   · otomatik kapanma yok — yalnızca "Bitir" tuşu bitirir
   · Chrome motoru kendi kendine kapanırsa (no-speech / onend) sessizce yeniden başlatılır */
const SES_TUR = 30;                       /* motor kendi kapanırsa en fazla bu kadar yeniden başlat */
const SORU_TUR = 4;                       /* en fazla bu kadar soru-cevap turu */
let sesBitti = false, sesSon = '', sesTur = 0;

/* --- program soru sorunca sesli cevap verebilmek için --- */
let sesGecmis = [];      /* Claude'a giden konuşma geçmişi */
let soruTur = 0;         /* kaçıncı soru-cevap turu */

/* Soruyu sesli oku, bitince dinlemeye geç (eller meşgulken asıl işe yarayan kısım) */
function konus(metin, bitince){
  const devam = () => { try { bitince && bitince(); } catch(e){} };
  if (!metin || !('speechSynthesis' in window)){ devam(); return; }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(metin);
    u.lang = 'tr-TR'; u.rate = 1.05;
    let acildi = false;
    const bir = () => { if (acildi) return; acildi = true; devam(); };
    u.onend = bir; u.onerror = bir;
    setTimeout(bir, Math.min(9000, 1800 + metin.length * 75));   /* ses motoru takılırsa bekletme */
    speechSynthesis.speak(u);
  } catch(e){ devam(); }
}
function susturKonus(){ try { speechSynthesis.cancel(); } catch(e){} }

/* Konuşmayı yalnızca kullanıcı bitirir — otomatik kapanma yok. */
function sesBitir(){
  if (sesBitti) return;
  sesBitti = true;
  try { sesTanir && sesTanir.stop(); } catch(e){}
  if (!sesSon){                       /* hiç ses gelmediyse stop'u beklemeye gerek yok */
    sesTanir = null;
    vEl().classList.remove('dinliyor');
    vSet('Bir şey duyamadım.', '');
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="mic">Tekrar dene</button><button class="btn" data-act="voice-close">Kapat</button>';
  }
}

function sesBaslat(){
  if (!sesDestek()){ note('Bu tarayıcı konuşma tanımayı desteklemiyor (Chrome gerekir).'); return; }
  if (!getSetting('claudekey')){ note('Önce senkron penceresinden Claude API anahtarını girin.'); openSheet(); return; }
  if (sesTanir){ sesBitir(); return; }
  susturKonus();
  voiceAc();
  sesGecmis = []; soruTur = 0;            /* yeni komut → geçmiş sıfır */
  sesBitti = false; sesSon = ''; sesTur = 0;
  sesDinle();
}

/* Programin sorusuna sesli cevap: geçmişi koruyarak yeniden dinle */
function sesCevapla(){
  if (!sesDestek()){ note('Bu tarayıcı konuşma tanımayı desteklemiyor.'); return; }
  if (sesTanir){ sesBitir(); return; }
  susturKonus();
  V.acik = true;
  const e = vEl(); if (e){ e.hidden = false; e.classList.add('dinliyor'); }
  document.getElementById('v-acts').innerHTML =
    '<button class="btn primary" data-act="voice-bitir">Bitir</button>' +
    '<button class="btn" data-act="voice-close">Vazgeç</button>';
  vSet('Dinleniyor…', '');
  sesBitti = false; sesSon = ''; sesTur = 0;
  V.cevapModu = true;
  sesDinle();
}

function sesDinle(){
  const r = new SR();
  sesTanir = r;
  const oncesi = sesSon;                 /* bu turdan önce biriken metin */
  r.lang = 'tr-TR'; r.interimResults = true; r.maxAlternatives = 1; r.continuous = true;

  r.onresult = ev => {
    let t = '';
    for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
    sesSon = (oncesi ? oncesi + ' ' : '') + t.trim();
    V.metin = sesSon;
    vSet(null, sesSon);
  };

  r.onerror = ev => {
    /* no-speech: Chrome'un kendi sabırsızlığı — kullanıcı daha konuşmadıysa devam et */
    if (ev.error === 'no-speech' && !sesBitti && sesTur < SES_TUR){ return; }
    sesBitti = true; sesTanir = null;
    vEl().classList.remove('dinliyor');
    const m = { 'not-allowed':'Mikrofon izni verilmedi.', 'service-not-allowed':'Mikrofon izni verilmedi.',
                'no-speech':'Ses algılanmadı.', 'audio-capture':'Mikrofon bulunamadı.',
                'aborted':'Dinleme durduruldu.',
                'network':'İnternet bağlantısı gerekiyor.' }[ev.error] || ('Ses hatası: ' + ev.error);
    if (sesSon){ komutCoz(sesSon); return; }   /* elde metin varsa yine de çöz */
    vSet(m, sesSon);
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="mic">Tekrar dene</button><button class="btn" data-act="voice-close">Kapat</button>';
  };

  r.onend = () => {
    sesTanir = null;
    if (!V.acik) return;
    if (!sesBitti){                       /* motor kendi kapandı → sessizce devam, kullanıcı bitirene kadar */
      if (sesTur < SES_TUR){ sesTur++; try { sesDinle(); return; } catch(e){} }
      sesBitti = true;
    }
    vEl().classList.remove('dinliyor');
    if (!sesSon){
      vSet('Bir şey duyamadım.', '');
      document.getElementById('v-acts').innerHTML =
        '<button class="btn primary" data-act="mic">Tekrar dene</button><button class="btn" data-act="voice-close">Kapat</button>';
      return;
    }
    komutCoz(sesSon);
  };

  try { r.start(); } catch(e){ note('Mikrofon başlatılamadı.'); voiceKapat(); }
}

/* --- Claude --- */
const AI_URL = 'https://api.anthropic.com/v1/';
async function aiFetch(yol, govde){
  const key = getSetting('claudekey');
  if (!key) throw new Error('API anahtarı yok');
  const o = { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01',
              'anthropic-dangerous-direct-browser-access': 'true' } };
  if (govde){ o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(govde); }
  const r = await fetch(AI_URL + yol, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return j;
}
async function aiModelSec(){
  const j = await aiFetch('models?limit=40');
  const ids = (j.data || []).map(m => m.id);
  const m = ids.find(x => /haiku/.test(x)) || ids.find(x => /sonnet/.test(x)) || ids[0];
  if (!m) throw new Error('Model listesi boş');
  return m;
}

function aiIsListesi(){
  const L = [];
  a42Devam().forEach(x => L.push({ id: 'a42:' + x.is_id, m: x.musteri || '', p: x.proje || '' }));
  S.jobs.filter(j => !j.archived && !j.genel).forEach(j => L.push({ id: 'job:' + j.id, m: j.customer || '', p: j.project || '' }));
  /* genel başlıklar: projeden bağımsız işler (muhasebe, hatırlatma…) */
  genelListe().forEach(g => L.push({ id: 'job:' + g.id, m: 'GENEL', p: g.ad }));
  return L.slice(0, 70);
}

/* Tarihleri modele hesaplatma — hepsini burada çıkarıp hazır tablo olarak ver.
   Böylece "önümüzdeki hafta" bir hafta kayamaz. */
function tarihTablosu(b){
  const buPzt = mondayOf(b), gelPzt = addDays(buPzt, 7), sonPzt = addDays(buPzt, 14);
  const gunAdi = d => DAY_FULL[(d.getDay() + 6) % 7];
  const sat = (etiket, d) => '  ' + etiket + ' = ' + iso(d) + ' (' + gunAdi(d) + ')';
  const L = [];
  L.push('BUGÜN: ' + iso(b) + ' (' + gunAdi(b) + '). Hafta PAZARTESİ başlar.');
  L.push('BU HAFTA: ' + iso(buPzt) + ' → ' + iso(addDays(buPzt, 6)));
  L.push('ÖNÜMÜZDEKİ HAFTA (= gelecek hafta = haftaya): ' + iso(gelPzt) + ' → ' + iso(addDays(gelPzt, 6)));
  L.push('SONRAKİ HAFTA (= iki hafta sonra): ' + iso(sonPzt) + ' → ' + iso(addDays(sonPzt, 6)));
  L.push('');
  L.push('TARİH SÖZLÜĞÜ — bu tablodaki değerleri OLDUĞU GİBİ kullan, kendin hesaplama:');
  L.push(sat('bugün', b));
  L.push(sat('yarın', addDays(b, 1)));
  L.push(sat('öbür gün', addDays(b, 2)));
  L.push(sat('haftaya / gelecek hafta / önümüzdeki hafta (gün belirtilmemişse)', gelPzt));
  for (let i = 0; i < 7; i++){
    const ad = DAY_FULL[i].toLocaleLowerCase('tr');
    L.push(sat('bu ' + ad, addDays(buPzt, i)));
    L.push(sat('önümüzdeki ' + ad + ' / gelecek ' + ad + ' / haftaya ' + ad, addDays(gelPzt, i)));
  }
  L.push('  Sadece gün adı söylenirse (örn. "çarşamba") → bugünden SONRAKİ ilk o gün.');
  L.push('  "önümüzdeki" asla iki hafta sonrası demek değildir; yalnızca bir sonraki hafta demektir.');
  L.push('');
  return L.join('\n');
}

/* Modelin hedef görevi seçebilmesi için açık görev listesi */
function aiGorevListesi(){
  const t0 = todayIso();
  const L = S.tasks
    .filter(t => !t.done || t.day === t0)
    .sort((a, b) => (a.day || '9999').localeCompare(b.day || '9999') || (a.createdAt || 0) - (b.createdAt || 0))
    .slice(0, 80);
  return L.map(t => {
    const j = jobById(t.jobId);
    const ne = t.pin ? 'sabit' : (t.day || 'tarihsiz');
    return t.id + ' | ' + ne + ' | ' + (j ? jobLabel(j) : '—') + ' | ' + (t.text || '') + (t.done ? ' | BİTTİ' : '');
  });
}

/* Modelin yanıtından JSON'u güvenle çıkar.
   Greedy regex, JSON'dan sonra gelen açıklama metnini de yutup parse’ı patlatıyordu.
   Burada ilk { ya da [ bulunup parantezler sayılarak tam olarak eşi kapatılıyor. */
function jsonAyikla(txt){
  let t = String(txt || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const bas = t.search(/[\[{]/);
  if (bas < 0) return null;
  const acan = t[bas], kapan = acan === '[' ? ']' : '}';
  let derinlik = 0, metinde = false, kacis = false;
  for (let i = bas; i < t.length; i++){
    const c = t[i];
    if (metinde){
      if (kacis) kacis = false;
      else if (c === '\\') kacis = true;
      else if (c === '"') metinde = false;
      continue;
    }
    if (c === '"'){ metinde = true; continue; }
    if (c === acan) derinlik++;
    else if (c === kapan){
      derinlik--;
      if (derinlik === 0){
        try { return JSON.parse(t.slice(bas, i + 1)); } catch(e){ return null; }
      }
    }
  }
  return null;
}

/* Tek komut da olabilir, komut dizisi de (“şunu ve şunu ekle”) */
function komutDizi(veri){
  if (Array.isArray(veri)) return veri.filter(x => x && typeof x === 'object');
  if (veri && Array.isArray(veri.komutlar)) return veri.komutlar.filter(x => x && typeof x === 'object');
  return veri && typeof veri === 'object' ? [veri] : [];
}

async function komutCoz(metin){
  vSet('Komut çözülüyor…', metin);
  { const a = document.getElementById('v-acts');
    if (a) a.innerHTML = '<button class="btn" data-act="voice-close">Vazgeç</button>'; }
  const bugun = new Date();
  const isler = aiIsListesi();
  const gorevler = aiGorevListesi();
  const sistem = [
    'Bir Türk alüminyum doğrama firmasının iş takip uygulaması için sesli komutları JSON\'a çeviriyorsun.',
    tarihTablosu(bugun),
    'İŞ LİSTESİ (isId | müşteri | proje):',
    isler.map(x => x.id + ' | ' + x.m + ' | ' + x.p).join('\n'),
    '',
    'MEVCUT GÖREVLER (gorevId | gün | iş | metin):',
    (gorevler.length ? gorevler.join('\n') : '(görev yok)'),
    '',
    'SADECE geçerli JSON döndür — açıklama, başlık, kod çiti (```) YAZMA. JSON\u2019dan sonra tek karakter bile olmasın.',
    'Kullanıcı tek cümlede BİRDEN FAZLA iş söylerse ( “şunu ve şunu” ) JSON DİZİSİ döndür: [{…},{…}]. Tek iş varsa tek nesne.',
    'Şema:',
    '{"islem":"ekle"|"tasi"|"sil"|"bitti"|"geri-al"|"sabitle"|"sabit-kaldir"|"duzenle"|"anlasilmadi",',
    ' "isId":string|null,"gorevId":string|null,"gun":"YYYY-MM-DD"|null,"sabit":true|false,',
    ' "metin":string|null,"guven":0..1,"soru":string|null}',
    '',
    'İŞLEMLER:',
    '- ekle: yeni görev. isId + metin zorunlu, gun/sabit isteğe bağlı.',
    '- tasi: var olan görevin gününü değiştir ("cumaya al", "yarına kaydır", "tarihsize at" → gun null). gorevId + gun.',
    '- sil: görevi kaldır ("sil", "kaldır", "iptal et"). gorevId.',
    '- bitti: görevi tamamlandı işaretle ("bitti", "tamamlandı", "yapıldı"). gorevId.',
    '- geri-al: tamamlanmış görevi tekrar aç ("geri al", "bitmedi", "aç"). gorevId.',
    '- sabitle / sabit-kaldir: görevi sabit panele al / oradan çıkar. gorevId.',
    '- duzenle: görev metnini değiştir. metin = YENİ TAM METİN.',
    '    "şunu da ekle / notunu ekle" → eski metni aynen koru, sonuna ", <yeni>" ekleyip tam metni yaz.',
    '    "şunu çıkar" → o kısmı ayıklayıp kalan tam metni yaz.',
    '- anlasilmadi: emin değilsen. soru alanını doldur.',
    '',
    'KURALLAR:',
    '- isId: İŞ LİSTESİ’nden EN İYİ eşleşen id; eşleşme yoksa null ve guven düşük.',
    '- gorevId: MEVCUT GÖREVLER listesinden EN İYİ eşleşen id. Birden fazla görev aynı derecede uyuyorsa "anlasilmadi" dön ve soru ile hangisi olduğunu sor — rastgele seçme.',
    '- Müşteri sütunu GENEL olanlar projeden bağımsız başlıklardır. Komutta mimar/proje geçmiyorsa (fatura, muhasebe, vergi, SGK, ofis işi, tedarikçi, kişisel hatırlatma) bunlardan uygun olanı seç — proje uydurma.',
    '- gun: tarih anlaşılmadıysa null.',
    '- sabit: "sabit", "sabitle", "pinle" geçiyorsa true; görev takvime girmez, gun null olur.',
    '- metin: kısa Türkçe açıklama, komut kalıbı olmadan (örn. "boya yapılacak").',
    '- guven: hedef + tarih birlikte ne kadar kesinse. Emin değilsen 0.7 altında ver.',
    '- soru: guven düşükse tek cümlelik soru, değilse null. Soru KISA ve TEK olsun — kullanıcı sesle cevaplayacak.',
    '- Kullanıcı bir önceki sorunun cevabını veriyorsa (örn. sadece bir mimar adı ya da bir gün söylüyorsa) önceki komutu o bilgiyle TAMAMLA; sıfırdan yeni komut sayma.',
    '- "evet / tamam / olur / onayla" = bir önceki JSON\u2019u aynen tekrar döndür, guven 0.95. "hayır / iptal / vazgeç" = islem "anlasilmadi", soru null.'
  ].join('\n');

  try {
    let model = getSetting('claudemodel');
    if (!model){ model = await aiModelSec(); await setSetting('claudemodel', model); }
    sesGecmis.push({ role: 'user', content: metin });
    if (sesGecmis.length > 9) sesGecmis = sesGecmis.slice(-9);
    const j = await aiFetch('messages', {
      model, max_tokens: 400, system: sistem, messages: sesGecmis
    });
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    const veri = jsonAyikla(txt);
    if (!veri) throw new Error('Yanıt okunamadı');
    sesGecmis.push({ role: 'assistant', content: JSON.stringify(veri) });
    komutSonuc(veri, metin);
  } catch(e){
    vSet('Çözülemedi: ' + e.message, metin);
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="mic">Tekrar dene</button><button class="btn" data-act="voice-close">Kapat</button>';
  }
}

const ISLEM_AD = { ekle:'Ekle', tasi:'Taşı', sil:'Sil', bitti:'Bitti işaretle',
  'geri-al':'Geri aç', sabitle:'Sabitle', 'sabit-kaldir':'Sabitten çıkar', duzenle:'Değiştir' };
const HEDEF_ISLEM = ['tasi','sil','bitti','geri-al','sabitle','sabit-kaldir','duzenle'];

function komutSonuc(veri, ham){
  const dizi = komutDizi(veri);
  if (dizi.length > 1) return komutCoklu(dizi, ham);
  const o = dizi[0] || {};
  V.sonuc = o;
  const islem = String(o.islem || '');
  const gecerli = (islem === 'ekle' && o.isId && o.metin)
               || (HEDEF_ISLEM.includes(islem) && o.gorevId && S.tasks.some(t => t.id === o.gorevId));
  if (!gecerli){
    const soru = o.soru || 'Hangi iş için, hangi güne?';
    vSet('Soru', ham);
    document.getElementById('v-body').innerHTML = `<p class="vq">${esc(soru)}</p>`;
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="voice-cevap">&#127908; Cevapla</button>' +
      '<button class="btn" data-act="mic">Baştan söyle</button>' +
      '<button class="btn ghost" data-act="voice-close">Kapat</button>';
    soruSor(soru);
    return;
  }
  const guven = +o.guven || 0;
  /* Silme asla kendiliğinden yapılmaz — her zaman onay ister. */
  const esik = islem === 'sil' ? 2 : (islem === 'ekle' ? 0.75 : 0.8);
  if (guven >= esik){ komutUygula(o, true); return; }
  const soru = o.soru || (islem === 'sil' ? 'Bu görev silinsin mi?' : 'Doğru mu?');
  vSet('Onay bekliyor', ham);
  document.getElementById('v-body').innerHTML = komutOzet(o) + `<p class="vq">${esc(soru)}</p>`;
  document.getElementById('v-acts').innerHTML =
    `<button class="btn primary${islem === 'sil' ? ' tehlike' : ''}" data-act="voice-ok">${esc(ISLEM_AD[islem] || 'Uygula')}</button>` +
    '<button class="btn" data-act="voice-cevap">&#127908; Cevapla</button>' +
    '<button class="btn ghost" data-act="voice-close">İptal</button>';
  soruSor(soru, komutSesOzet(o));
}

/* Birden fazla komut: hepsini özetle, tek onayla uygula */
function komutCoklu(dizi, ham){
  const gecerliMi = o => {
    const i = String(o.islem || '');
    return (i === 'ekle' && o.isId && o.metin)
        || (HEDEF_ISLEM.includes(i) && o.gorevId && S.tasks.some(t => t.id === o.gorevId));
  };
  const iyi = dizi.filter(gecerliMi);
  if (!iyi.length){ komutSonuc(dizi[0] || {}, ham); return; }
  V.coklu = iyi;
  const silVar = iyi.some(o => String(o.islem) === 'sil');
  const dusuk  = iyi.some(o => (+o.guven || 0) < 0.8);
  if (!silVar && !dusuk){ komutCokluUygula(); return; }
  vSet('Onay bekliyor · ' + iyi.length + ' işlem', ham);
  document.getElementById('v-body').innerHTML =
    '<div class="vsum">' + iyi.map(o => {
      const i = String(o.islem || '');
      const t = S.tasks.find(x => x.id === o.gorevId);
      const ne = i === 'ekle' ? (komutIsAdi(o) + ' · ' + gunEtiket(o.gun, o.sabit) + ' · ' + (o.metin || ''))
                              : ((t && t.text) || '');
      return `<div><span>${esc(ISLEM_AD[i] || i)}</span><b>${esc(ne)}</b></div>`;
    }).join('') + '</div>';
  document.getElementById('v-acts').innerHTML =
    `<button class="btn primary${silVar ? ' tehlike' : ''}" data-act="voice-coklu">${iyi.length} işlemi uygula</button>` +
    '<button class="btn" data-act="voice-cevap">&#127908; Cevapla</button>' +
    '<button class="btn ghost" data-act="voice-close">İptal</button>';
  soruSor(iyi.length + ' işlem yapılacak. Onaylıyor musun?');
}

async function komutCokluUygula(){
  const dizi = V.coklu || [];
  V.coklu = null;
  let n = 0;
  for (const o of dizi){
    try { await komutUygula(o, true, true); n++; } catch(e){}
  }
  voiceKapat();
  note(n + ' işlem uygulandı.');
  render();
}

/* Soruyu sesli oku, sonra kendiliğinden dinlemeye geç */
function soruSor(soru, onek){
  soruTur++;
  if (soruTur > SORU_TUR) return;                 /* döngüye girmesin */
  konus((onek ? onek + '. ' : '') + soru, () => {
    if (!V.acik) return;                          /* pencere kapandıysa dinleme */
    if (!document.querySelector('[data-act="voice-cevap"]')) return;   /* başka ekrana geçildi */
    sesCevapla();
  });
}

/* Onay ekranında sesle okunacak kısa özet */
function komutSesOzet(o){
  const islem = String(o.islem || '');
  if (islem === 'ekle') return komutIsAdi(o) + ', ' + gunEtiket(o.gun, o.sabit) + ', ' + (o.metin || '');
  const t = S.tasks.find(x => x.id === o.gorevId);
  if (!t) return '';
  if (islem === 'tasi') return t.text + ', ' + gunEtiket(o.gun, false) + '\u2019e ta\u015f\u0131nacak';
  if (islem === 'sil')  return t.text + ' silinecek';
  if (islem === 'duzenle') return 'yeni metin: ' + (o.metin || '');
  return t.text;
}

function gunEtiket(gun, sabit){
  if (sabit) return 'sabit (takvim dışı)';
  if (!gun) return 'tarihsiz';
  return DAY_FULL[(fromIso(gun).getDay() + 6) % 7] + ' ' + shortDate(gun);
}

function komutOzet(o){
  const islem = String(o.islem || '');
  const sat = (e, v) => `<div><span>${e}</span><b>${esc(v)}</b></div>`;
  if (islem === 'ekle'){
    return `<div class="vsum">${sat('İş', komutIsAdi(o))}${sat('Gün', gunEtiket(o.gun, o.sabit))}${sat('Not', o.metin || '')}</div>`;
  }
  const t = S.tasks.find(x => x.id === o.gorevId);
  if (!t) return '';
  const j = jobById(t.jobId);
  let h = `<div class="vsum">${sat('İşlem', ISLEM_AD[islem] || islem)}`
        + sat('Görev', t.text || '')
        + sat('İş', j ? jobLabel(j) : '—');
  if (islem === 'tasi')    h += sat('Yeni gün', gunEtiket(o.gun, false)) + sat('Eski gün', gunEtiket(t.day, t.pin));
  if (islem === 'duzenle') h += sat('Yeni metin', o.metin || '');
  if (islem === 'sabitle') h += sat('Sonuç', 'sabit panele taşınır');
  if (islem === 'sabit-kaldir') h += sat('Sonuç', 'tarihsiz listeye döner');
  return h + '</div>';
}

function komutIsAdi(o){
  { const g = genelListe().find(x => 'job:' + x.id === String(o.isId || '')); if (g) return g.ad; }
  if (String(o.isId || '').startsWith('a42:')){
    const x = a42Devam().find(z => 'a42:' + z.is_id === o.isId);
    if (x) return [x.musteri, x.proje].filter(Boolean).join(' · ');
  } else {
    const j = jobById(String(o.isId || '').replace(/^job:/, ''));
    if (j) return jobLabel(j);
  }
  return o.isAd || '—';
}

async function komutUygula(o, otomatik, sessiz){
  const islem = String(o.islem || 'ekle');
  if (islem !== 'ekle') return komutHedefUygula(o, islem, sessiz);

  const id = String(o.isId || '');
  let jobId = null;
  if (id.startsWith('a42:')){
    const isId = id.slice(4);
    const v = S.jobs.find(j => String(j.a42Id || '') === isId);
    if (v) jobId = v.id;
    else {
      const x = a42Devam().find(z => z.is_id === isId);
      jobId = await S.store.setId('jobs', 'a42-' + isId, { customer: (x && x.musteri) || '', project: (x && x.proje) || '',
        archived: false, a42Id: isId, ci: S.jobs.length % SWATCH.length, createdAt: Date.now() });
      ensureContact(x && x.musteri);
    }
  } else {
    jobId = id.replace(/^job:/, '');
    if (!jobById(jobId)){
      const g = genelListe().find(x => x.id === jobId);
      if (g){
        await S.store.setId('jobs', g.id, { customer: '', project: g.ad, genel: true,
          archived: false, a42Id: '', ci: g.ci, createdAt: Date.now() });
      } else jobId = null;
    }
  }
  if (!jobId){ vSet('İş bulunamadı', V.metin); return; }
  const sabit = !!o.sabit;
  const gorevId = await S.store.add('tasks', { jobId, day: sabit ? '' : (o.gun || ''),
    text: o.metin || V.metin, done: false, pin: sabit, createdAt: Date.now() });
  if (sessiz) return;
  voiceKapat();
  noteGeri('Eklendi — ' + komutIsAdi(o) + ' · ' + gunEtiket(o.gun, sabit),
           () => S.store.remove('tasks', gorevId));
  render();
}

/* Var olan bir görev üzerinde işlem: taşı / sil / bitti / geri-al / sabitle / düzenle */
async function komutHedefUygula(o, islem, sessiz){
  const t = S.tasks.find(x => x.id === o.gorevId);
  if (!t){ vSet('Görev bulunamadı', V.metin); return; }
  const eski = { day: t.day || '', pin: !!t.pin, done: !!t.done, text: t.text || '', ord: t.ord, jobId: t.jobId, createdAt: t.createdAt };
  const geriYaz = () => S.store.update('tasks', t.id, { day: eski.day, pin: eski.pin, done: eski.done, text: eski.text });
  let mesaj = '', geri = geriYaz;

  if (islem === 'tasi'){
    await S.store.update('tasks', t.id, { day: o.gun || '', pin: false });
    mesaj = 'Taşındı — ' + gunEtiket(o.gun, false);
  } else if (islem === 'bitti'){
    await S.store.update('tasks', t.id, { done: true });
    mesaj = 'Bitti — ' + kisalt(t.text);
  } else if (islem === 'geri-al'){
    await S.store.update('tasks', t.id, { done: false });
    mesaj = 'Geri açıldı — ' + kisalt(t.text);
  } else if (islem === 'sabitle'){
    await S.store.update('tasks', t.id, { pin: true, day: '' });
    mesaj = 'Sabitlendi — ' + kisalt(t.text);
  } else if (islem === 'sabit-kaldir'){
    await S.store.update('tasks', t.id, { pin: false });
    mesaj = 'Sabitten çıkarıldı — ' + kisalt(t.text);
  } else if (islem === 'duzenle'){
    if (!o.metin){ vSet('Yeni metin anlaşılmadı', V.metin); return; }
    await S.store.update('tasks', t.id, { text: o.metin });
    mesaj = 'Değiştirildi — ' + kisalt(o.metin);
  } else if (islem === 'sil'){
    await S.store.remove('tasks', t.id);
    mesaj = 'Silindi — ' + kisalt(eski.text);
    geri = () => S.store.add('tasks', { jobId: eski.jobId, day: eski.day, text: eski.text,
      done: eski.done, pin: eski.pin, ord: eski.ord, createdAt: eski.createdAt || Date.now() });
  } else {
    vSet('Bilinmeyen işlem', V.metin); return;
  }
  if (sessiz) return;
  voiceKapat();
  noteGeri(mesaj, geri);
  render();
}

const kisalt = s => { s = String(s || ''); return s.length > 38 ? s.slice(0, 36) + '…' : s; };

/* geri alınabilir bildirim */
function noteGeri(msg, geri){
  document.querySelectorAll('.toast').forEach(n => n.remove());   /* tek bildirim dursun, üst üste binmesin */
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${esc(msg)}</span>`;
  const b = document.createElement('button');
  b.className = 'toast-undo'; b.textContent = 'Geri al';
  b.onclick = () => { try { geri(); } catch(e){} t.remove(); };
  t.appendChild(b);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 7000);
}

/* ============ rehber penceresi ============ */
function openPicker(type, btn){
  const r = btn.getBoundingClientRect();
  S.picker = { type, q: '', all: false, rect: { top: r.bottom, right: r.right, left: r.left } };
  renderPicker();
}
function closePicker(){
  S.picker = null;
  document.getElementById('pop-back')?.remove();
  document.getElementById('pop')?.remove();
}

function renderPicker(){
  document.getElementById('pop-back')?.remove();
  document.getElementById('pop')?.remove();
  if (!S.picker) return;

  const { type, q } = S.picker;
  const hit = n => !q.trim() || norm(n).includes(norm(q));
  const CAP = 50;
  const more = n => n > 0 ? `<div class="pop-more">+${n} kayıt daha — aramak için yazın</div>` : '';
  let body = '', title, addable = '';

  const block = (label, rows, rowFn, cap) => rows.length
    ? `<div class="pop-grp">${label}</div>` + rows.slice(0, cap).map(rowFn).join('') + more(rows.length - cap)
    : '';

  if (type === 'job'){
    title = 'İş / Proje';
    /* 1) Devam eden işler = A42 widget'ta DEVAM durumundaki işler */
    const devam = a42Devam();
    const arow = x => `<div class="pop-row live"><button class="pop-pick" data-act="pop-choose" data-a42="${esc(x.is_id)}" data-val="${esc(x.proje || '')}" data-cust="${esc(x.musteri || '')}">
      <span class="pop-nm">${esc(x.proje || x.musteri || 'İsimsiz iş')}</span>
      <span class="pop-sub">${[x.musteri, x.baslangic].filter(Boolean).map(esc).join(' · ')}</span></button></div>`;
    /* 2) uygulamada elle açılan işler (A42'den gelmeyenler) */
    const a42li = new Set(devam.map(x => String(x.is_id)));
    const yerel = S.jobs.filter(j => !j.archived && !(j.a42Id && a42li.has(String(j.a42Id))));
    const jrow = j => `<div class="pop-row"><button class="pop-pick" data-act="pop-choose" data-job="${j.id}">
      <span class="pop-nm">${esc(j.project || j.customer || 'İsimsiz iş')}</span>
      <span class="pop-sub">${[j.customer, tasksOfJob(j.id).length ? tasksOfJob(j.id).length + ' görev' : ''].filter(Boolean).map(esc).join(' · ')}</span></button></div>`;
    /* 3) teklif arşivi */
    const varOlan = new Set([...S.jobs.map(j => norm(j.project)), ...devam.map(x => norm(x.proje))]);
    const teklif = (S.ref.p || [])
      .filter(([c, p]) => p && !varOlan.has(norm(p)))
      .map(([c, p, k, y]) => ({ customer: c || '', name: p, kind: KIND[k] || '', year: y || '' }))
      .sort((a, b) => (b.year || '').localeCompare(a.year || '') || a.name.localeCompare(b.name, 'tr'));
    const trow = p => `<div class="pop-row"><button class="pop-pick" data-act="pop-choose" data-val="${esc(p.name)}" data-cust="${esc(p.customer)}">
      <span class="pop-nm">${esc(p.name)}</span>
      <span class="pop-sub">${[p.customer, p.kind, p.year].filter(Boolean).map(esc).join(' · ')}</span></button></div>`;
    const fa = a => a.filter(x => hit(x.proje) || hit(x.musteri));
    const fj = a => a.filter(j => hit(j.project) || hit(j.customer));
    const fp = a => a.filter(p => hit(p.name) || hit(p.customer));
    /* 0) genel başlıklar — projeden / mimardan bağımsız */
    const gen = genelListe();
    const grow = g => `<div class="pop-row gen"><button class="pop-pick" data-act="pop-choose" data-genel="${esc(g.id)}" data-val="${esc(g.ad)}" data-ci="${g.ci}">
      <span class="pop-nm"><span class="gdot" style="background:${SWATCH[g.ci % SWATCH.length]}"></span>${esc(g.ad)}</span>
      <span class="pop-sub">${g.var ? (tasksOfJob(g.id).length ? tasksOfJob(g.id).length + ' görev' : 'genel') : 'genel'}</span></button></div>`;
    const fg = a => a.filter(g => hit(g.ad) || hit('genel'));
    const genBlok = block('Genel · projeden bağımsız', fg(gen), grow, 20);
    let kalan = block('Devam eden işler · A42', fa(devam), arow, CAP)
              + block('Uygulamada açılan işler', fj(yerel), jrow, 30)
              + block('Teklif arşivi', fp(teklif), trow, CAP);
    if (!devam.length){
      const url = getSetting('a42url');
      kalan = `<div class="pop-note">${url
        ? (S.a42.hata ? esc(S.a42.hata) : 'A42\u2019de devam eden iş yok.')
        : 'A42 bağlantısı tanımlı değil — senkron penceresinden ekleyin.'}</div>` + kalan;
    }
    body = genBlok + kalan;
    if (!body) body = '<div class="pop-empty">Kayıt yok.</div>';
    if (q.trim()) addable = `<button class="pop-add" data-act="pop-add">+ “${esc(q.trim())}” için yeni iş aç</button>`
      + `<button class="pop-add gen" data-act="pop-add-gen">+ “${esc(q.trim())}” genel başlığı ekle</button>`;
  } else if (type === 'customer'){
    const L = customerList();
    title = 'Müşteri / Mimar';
    const row = c => `<div class="pop-row${c.src === 'job' ? ' live' : ''}"><button class="pop-pick" data-act="pop-choose" data-val="${esc(c.name)}">
      <span class="pop-nm">${esc(c.name)}</span>
      <span class="pop-sub">${[c.jobs ? c.jobs + ' açık iş' : '', c.n ? c.n + ' teklif' : '', c.last].filter(Boolean).map(esc).join(' · ')}</span></button>${
      c.contactId ? `<button class="pop-del" data-act="pop-del" data-id="${c.contactId}" title="Rehberden sil" aria-label="Rehberden sil">×</button>` : ''}</div>`;
    const f = a => a.filter(c => hit(c.name));
    body = block('Devam eden işler', f(L.job), row, CAP)
         + block('Rehber', f(L.contact), row, CAP)
         + block('Güncel müşteriler', f(L.fresh), row, CAP)
         + block('Teklif arşivi', f(L.ref), row, CAP);
    if (!body) body = '<div class="pop-empty">Kayıt yok.</div>';
    if (q.trim() && !L.all.some(c => norm(c.name) === norm(q))) addable = `<button class="pop-add" data-act="pop-add">+ “${esc(q.trim())}” rehbere ekle</button>`;
  } else {
    const cust = (document.getElementById('j-cust')?.value || S.newJob.customer || '').trim();
    const L = projectList(cust);
    const dar = !!cust && !S.picker.all;          // müşteri seçiliyse yalnızca onun projeleri
    title = cust ? 'Proje · ' + cust : 'Proje';
    const row = p => `<div class="pop-row${p.live ? ' live' : ''}"><button class="pop-pick" data-act="pop-choose" data-val="${esc(p.name)}" data-cust="${esc(p.customer)}">
      <span class="pop-nm">${esc(p.name)}</span>
      <span class="pop-sub">${[p.customer && (!cust || norm(p.customer) !== norm(cust)) ? p.customer : '', p.kind, p.year].filter(Boolean).map(esc).join(' · ')}</span></button></div>`;
    const f = a => a.filter(p => hit(p.name) || hit(p.customer));
    const live = dar ? L.live.filter(p => p.same) : L.live;
    body = block('Devam eden işler', f(live), row, CAP)
         + block(dar || !cust ? 'Teklif arşivi' : esc(cust) + ' · teklif arşivi', f(L.mine), row, CAP);
    if (!dar) body += block(L.mine.length || live.length ? 'Diğer teklifler' : 'Teklif arşivi', f(L.other), row, CAP);
    if (!body) body = `<div class="pop-empty">${dar ? esc(cust) + ' için kayıtlı proje yok.' : 'Kayıtlı proje yok.'}</div>`;
    if (dar) addable = `<button class="pop-add" data-act="pop-all">Tüm müşterilerde ara (${L.other.length + (L.live.length - live.length)} kayıt)</button>`;
  }

  const back = document.createElement('div');
  back.id = 'pop-back';
  const pop = document.createElement('div');
  pop.id = 'pop';
  pop.className = 'pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', title);
  pop.innerHTML = `<div class="pop-h"><b>${title}</b><button class="pop-x" data-act="pop-close" aria-label="Kapat">×</button></div>
    <div class="pop-s"><input type="text" id="pop-q" placeholder="Ara ya da yaz…" autocomplete="off" aria-label="Ara" value="${esc(q)}"></div>
    <div class="pop-l">${body}</div>${addable ? `<div class="pop-f">${addable}</div>` : ''}`;

  document.body.appendChild(back);
  document.body.appendChild(pop);

  // konumlandır: düğmenin altına, ekran dışına taşmadan
  const w = pop.offsetWidth, hgt = pop.offsetHeight, m = 12;
  let left = Math.min(S.picker.rect.right - w, window.innerWidth - w - m);
  left = Math.max(m, left);
  let top = S.picker.rect.top + 6;
  if (top + hgt > window.innerHeight - m) top = Math.max(m, S.picker.rect.top - 6 - hgt);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  const qi = document.getElementById('pop-q');
  qi.focus();
  try { qi.setSelectionRange(qi.value.length, qi.value.length); } catch(e){}
}

/* Görev yazarken iş seçimi: mevcut işi seç, ya da arşivdeki teklif için
   sessizce bir iş kartı aç ve göreve onu bağla. */
/* Genel başlık seç — yoksa sabit kimlikle aç (cihazlar arası tek kart). */
async function genelChoose(id, ad, ci){
  if (!id) return;
  if (!jobById(id)){
    await S.store.setId('jobs', id, { customer: '', project: ad || 'Genel', genel: true,
      archived: false, a42Id: '', ci: ci || 0, createdAt: Date.now() });
    note('Genel başlık açıldı — ' + (ad || 'Genel'));
  }
  S.draft.job = id;
  const t = document.getElementById('c-text');
  if (t) S.draft.text = t.value;
  closePicker();
  render();
}

async function jobChoose(jobId, proje, musteri, a42Id){
  if (!jobId && a42Id){
    const v = S.jobs.find(j => String(j.a42Id || '') === String(a42Id));
    if (v) jobId = v.id;
  }
  if (!jobId){
    if (a42Id){
      /* Sabit belge kimliği: aynı A42 işi hangi cihazdan seçilirse seçilsin tek kart açılır. */
      jobId = await S.store.setId('jobs', 'a42-' + a42Id, {
        customer: musteri || '', project: proje || '', archived: false,
        a42Id: String(a42Id), ci: S.jobs.length % SWATCH.length, createdAt: Date.now()
      });
    } else {
      jobId = await S.store.add('jobs', {
        customer: musteri || '', project: proje || '', archived: false,
        a42Id: '', ci: S.jobs.length % SWATCH.length, createdAt: Date.now()
      });
    }
    ensureContact(musteri);
    note('İş kartı açıldı — ' + (proje || musteri));
  }
  S.draft.job = jobId;
  const t = document.getElementById('c-text');
  if (t) S.draft.text = t.value;
  closePicker();
  render();
}

function pickerChoose(val, cust){
  const type = S.picker.type;
  const id = type === 'customer' ? 'j-cust' : 'j-proj';
  const el = document.getElementById(id);
  if (el) el.value = val;
  if (type === 'customer') S.newJob.customer = val; else S.newJob.project = val;
  // arşivden proje seçildiyse ve müşteri boşsa, müşteriyi de doldur
  if (type === 'project' && cust){
    const ce = document.getElementById('j-cust');
    if (ce && !ce.value.trim()){ ce.value = cust; S.newJob.customer = cust; }
  }
  closePicker();
  document.getElementById('j-proj')?.focus();
}

/* ============ yazarken öneri ============ */
let sg = null;   // { input, items, i }

function sgList(id, q){
  const t = norm(q);
  if (!t) return [];
  const pre = [], inc = [];
  const push = (name, sub, cust) => {
    const n = norm(name);
    if (n === t) return;
    if (n.startsWith(t)) pre.push({ name, sub, cust });
    else if (n.includes(t)) inc.push({ name, sub, cust });
  };
  if (id === 'j-cust'){
    const L = customerList();
    [...L.job, ...L.contact, ...L.fresh, ...L.ref].forEach(c =>
      push(c.name, [c.jobs ? c.jobs + ' açık iş' : '', c.n ? c.n + ' teklif' : '', c.last].filter(Boolean).join(' · ')));
  } else {
    const cust = (document.getElementById('j-cust')?.value || '').trim();
    const L = projectList(cust);
    const dar = !!cust;
    const kay = dar ? [...L.live.filter(p => p.same), ...L.mine] : [...L.live, ...L.mine, ...L.other];
    kay.forEach(p => push(p.name, [p.customer && norm(p.customer) !== norm(cust) ? p.customer : '', p.kind, p.year].filter(Boolean).join(' · '), p.customer));
  }
  return [...pre, ...inc].slice(0, 8);
}

function sgClose(){ sg = null; document.getElementById('sg')?.remove(); }

function sgShow(input){
  const items = sgList(input.id, input.value);
  sgClose();
  if (!items.length) return;
  sg = { input, items, i: -1 };
  const box = document.createElement('div');
  box.id = 'sg'; box.className = 'sg';
  box.innerHTML = items.map((it, k) =>
    `<button class="sg-row" data-k="${k}"><span class="sg-nm">${esc(it.name)}</span>${
      it.sub ? `<span class="sg-sub">${esc(it.sub)}</span>` : ''}</button>`).join('');
  document.body.appendChild(box);
  const r = input.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8)) + 'px';
  box.style.width = Math.min(r.width, window.innerWidth - 16) + 'px';
  const alt = r.bottom + 4;
  box.style.top = (alt + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - 4 - box.offsetHeight) : alt) + 'px';
  box.addEventListener('mousedown', e => e.preventDefault());
  box.addEventListener('click', e => {
    const b = e.target.closest('.sg-row');
    if (b) sgPick(+b.dataset.k);
  });
}

function sgMark(){
  document.querySelectorAll('#sg .sg-row').forEach((n, k) => n.classList.toggle('on', k === sg.i));
}

function sgPick(k){
  if (!sg || !sg.items[k]) return;
  const it = sg.items[k], input = sg.input;
  input.value = it.name;
  if (input.id === 'j-cust') S.newJob.customer = it.name;
  else {
    S.newJob.project = it.name;
    const ce = document.getElementById('j-cust');
    if (it.cust && ce && !ce.value.trim()){ ce.value = it.cust; S.newJob.customer = it.cust; }
  }
  sgClose();
  (input.id === 'j-cust' ? document.getElementById('j-proj') : input)?.focus();
}

/* ============ render ============ */
function render(){
  document.getElementById('tab-week').setAttribute('aria-selected', S.tab === 'week');
  document.getElementById('tab-und').setAttribute('aria-selected', S.tab === 'undated');
  document.getElementById('tab-jobs').setAttribute('aria-selected', S.tab === 'jobs');
  const undN = S.tasks.filter(t => !t.day && !t.pin && !t.done).length;
  const undRozet = document.getElementById('und-n');
  if (undRozet){ undRozet.textContent = undN || ''; undRozet.hidden = !undN; }
  main.innerHTML = S.tab === 'week' ? (S.view === 'month' && window.innerWidth >= 1000 ? monthView() : weekView())
    : S.tab === 'undated' ? undatedView() : jobsView();
  const txt = document.getElementById('c-text');
  if (txt){ txt.value = S.draft.text; txt.focus(); try { txt.setSelectionRange(txt.value.length, txt.value.length); } catch(e){} }
  const jc = document.getElementById('j-cust'), jp = document.getElementById('j-proj');
  if (jc){
    jc.value = S.newJob.customer || '';
    if (jp) jp.value = S.newJob.project || '';
    if (!txt && document.activeElement !== jp) jc.focus();
  }
}

function setSync(kind, label){
  syncTxt.textContent = label;
  syncBtn.querySelector('.dot').className = 'dot' + (kind === 'cloud' ? '' : kind === 'warn' ? ' warn' : ' off');
}

/* ============ eylemler ============ */
function openComposer(scope, day){
  S.composer = { scope, day };
  S.draft.text = '';
  S.draft.day = day || todayIso();
  if (!S.draft.job || !jobById(S.draft.job)){ const a = activeJobs(); S.draft.job = a.length ? a[0].id : ''; }
  render();
}

function saveTask(){
  const el = document.getElementById('c-text');
  const text = (el ? el.value : '').trim();
  if (!text){ note('Görev metni boş.'); el && el.focus(); return; }
  const scope = S.composer.scope;
  let jobId, day;
  if (scope.startsWith('job:')){
    jobId = scope.slice(4);
    const de = document.getElementById('c-day');
    day = de && de.value ? de.value : '';
  } else {
    jobId = S.draft.job || '';
    day = scope === 'pin' ? '' : S.composer.day;
    if (!jobId || !jobById(jobId)){ note('Önce bir iş / proje seçin.'); document.getElementById('c-job')?.click(); return; }
  }
  S.draft.job = jobId;
  S.store.add('tasks', { jobId, day: day || '', text, done: false,
    pin: scope === 'pin', createdAt: Date.now() });
  S.draft.text = '';
  render();
  const t = document.getElementById('c-text'); if (t) t.focus();
}

function saveJob(){
  const c = (document.getElementById('j-cust')?.value || '').trim();
  const p = (document.getElementById('j-proj')?.value || '').trim();
  if (!c && !p){ note('Müşteri ya da proje adı gerekli.'); return; }
  S.store.add('jobs', { customer: c, project: p, archived: false, ci: S.jobs.length % SWATCH.length, createdAt: Date.now() });
  ensureContact(c);
  S.composer = null; S.newJob = { customer: '', project: '' };
  closePicker();
  render();
}

function seed(){
  const now = Date.now();
  const demo = [
    { customer: 'Metrak Mimarlık', project: 'Hersek Tersanesi — ofis bölme' },
    { customer: 'BOMdesign', project: 'Kapı kasası + süpürgelik revizyonu' }
  ];
  Promise.all(demo.map((d, i) => S.store.add('jobs', { ...d, archived: false, ci: i, createdAt: now + i })))
    .then(ids => {
      const seeds = [
        [0, todayIso(), 'Metraj kontrolü — 4. kat cam ölçüleri'],
        [0, iso(addDays(new Date(), 1)), 'Teklif revizyonu gönder'],
        [1, '', 'Asistal profil siparişi netleştir']
      ];
      seeds.forEach((s, k) => S.store.add('tasks', { jobId: ids[s[0]], day: s[1], text: s[2], done: false, createdAt: now + 10 + k }));
      note('Örnek işler eklendi — silebilirsiniz.');
    });
}

/* ============ hesap / senkron sayfası ============ */
function openSheet(){
  sheetTitle.textContent = 'Senkron';
  if (!S.cloudReady){
    sheetBody.innerHTML = `<p class="lead">Şu an <b>yerel mod</b>: veriler yalnızca bu cihazda saklanıyor.</p>
      <p class="lead">Telefon ve bilgisayar arasında senkron için <code>firebase-config.js</code> dosyasına Firebase ayarlarını yapıştırın (kurulum adımları KURULUM.md dosyasında).</p>
      <p class="who">sürüm ${APP_VERSION}</p>
      ${a42Alani()}
      <div class="row"><button class="btn" data-act="refresh">Güncellemeyi denetle</button>
      <button class="btn primary" data-act="close-sheet">Tamam</button></div>`;
  } else if (S.user){
    sheetBody.innerHTML = `<p class="lead">Bulut senkronu açık. Aynı hesapla girdiğiniz her cihazda aynı liste görünür — değişiklikler anında yansır, yenilemeye gerek yok.</p>
      <p class="who">${esc(S.user.email || S.user.uid)}</p>
      <p class="who">sürüm ${APP_VERSION} · ${(S.ref.c || []).length} müşteri · ${(S.ref.p || []).length} proje</p>
      ${a42Alani()}
      <div class="row"><button class="btn" data-act="refresh">Güncellemeyi denetle</button></div>
      <div class="row"><button class="btn" data-act="signout">Çıkış yap</button>
      <button class="btn primary" data-act="close-sheet">Kapat</button></div>`;
  } else {
    sheetBody.innerHTML = `<p class="lead">Bulut senkronu için giriş yapın. Hesabınız yoksa aynı bilgilerle <b>Hesap oluştur</b> deyin.</p>
      <label for="a-mail">E-posta</label><input type="email" id="a-mail" autocomplete="username" inputmode="email">
      <label for="a-pass">Parola</label><input type="password" id="a-pass" autocomplete="current-password">
      <div class="row"><button class="btn primary" data-act="signin">Giriş yap</button>
      <button class="btn" data-act="signup">Hesap oluştur</button></div>
      <div class="row"><button class="btn ghost" data-act="close-sheet">Yerel modda devam et</button></div>
      <div class="err" id="a-err" hidden></div>`;
  }
  sheet.hidden = false;
}
function a42Alani(){
  const url = getSetting('a42url');
  const n = a42Devam().length;
  const durum = !url ? 'Tanımlı değil — A42 widget\u2019ındaki IZ_TAKIP_URL adresini yapıştırın.'
    : S.a42.hata ? S.a42.hata
    : n ? n + ' devam eden iş okundu.'
    : 'Bağlandı, devam eden iş yok.';
  return `<hr class="sep">
    <label for="a-a42">A42 iş takip bağlantısı</label>
    <input type="url" id="a-a42" placeholder="https://script.google.com/macros/s/.../exec" value="${esc(url)}" autocomplete="off" spellcheck="false">
    <p class="who">${esc(durum)}</p>
    <div class="row"><button class="btn" data-act="a42-save">Kaydet ve bağlan</button>
    <button class="btn ghost" data-act="a42-reload">Tazele</button></div>
    ${aiAlani()}`;
}

function aiAlani(){
  const k = getSetting('claudekey'), m = getSetting('claudemodel');
  const durum = !k ? 'Tanımlı değil — sesli komut için console.anthropic.com\u2019dan bir API anahtarı alın.'
    : (m ? 'Bağlı · ' + m : 'Anahtar kayıtlı ama model doğrulanmadı — Kaydet ve doğrula deyin.');
  const destek = (window.SpeechRecognition || window.webkitSpeechRecognition)
    ? '' : '<p class="who">Bu tarayıcı konuşma tanımayı desteklemiyor — Chrome gerekiyor.</p>';
  return `<hr class="sep">
    <label for="a-key">Sesli komut · Claude API anahtarı</label>
    <input type="password" id="a-key" placeholder="sk-ant-..." value="${esc(k)}" autocomplete="off" spellcheck="false">
    <p class="who">${esc(durum)}</p>${destek}
    <div class="row"><button class="btn" data-act="ai-save">Kaydet ve doğrula</button></div>`;
}

const closeSheet = () => { sheet.hidden = true; };
const authErr = m => { const e = document.getElementById('a-err'); if (e){ e.textContent = m; e.hidden = false; } };

function authMessage(code){
  const map = {
    'auth/invalid-email': 'E-posta adresi geçersiz.',
    'auth/missing-password': 'Parola girin.',
    'auth/weak-password': 'Parola en az 6 karakter olmalı.',
    'auth/email-already-in-use': 'Bu e-posta zaten kayıtlı — Giriş yap deyin.',
    'auth/invalid-credential': 'E-posta ya da parola hatalı.',
    'auth/wrong-password': 'Parola hatalı.',
    'auth/user-not-found': 'Böyle bir hesap yok — Hesap oluştur deyin.',
    'auth/network-request-failed': 'İnternet bağlantısı yok.',
    'auth/too-many-requests': 'Çok fazla deneme — biraz bekleyin.',
    'auth/operation-not-allowed': 'Firebase konsolunda E-posta/Parola girişi açık değil.'
  };
  return map[code] || ('Giriş yapılamadı (' + code + ')');
}

/* ============ olaylar ============ */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act, id = b.dataset.id;

  if (a === 'tab'){ S.tab = b.dataset.v; S.composer = null; render(); return; }
  if (a === 'week'){ S.weekStart = addDays(S.weekStart, 7 * parseInt(b.dataset.v, 10)); S.composer = null; render(); return; }
  if (a === 'month'){
    const d = new Date(S.weekStart.getFullYear(), S.weekStart.getMonth() + parseInt(b.dataset.v, 10), 1);
    S.weekStart = mondayOf(d).getMonth() === d.getMonth() ? mondayOf(d) : d;
    S.composer = null; render(); return;
  }
  if (a === 'setview'){
    S.view = b.dataset.v; S.composer = null;
    try { localStorage.setItem('izo-view', S.view); } catch(e){}
    render(); return;
  }
  if (a === 'today'){ S.weekStart = mondayOf(new Date()); S.composer = null; render(); return; }
  if (a === 'toggle-done'){ S.showDone = !S.showDone; render(); return; }
  if (a === 'toggle-arch'){ S.showArchived = !S.showArchived; render(); return; }
  if (a === 'open-composer'){ openComposer(b.dataset.scope, b.dataset.day); return; }
  if (a === 'cancel-composer'){ S.composer = null; S.draft.text = ''; render(); return; }
  if (a === 'save-task'){ saveTask(); return; }
  if (a === 'pin'){
    const t = S.tasks.find(x => x.id === id);
    if (!t) return;
    const yeni = !t.pin;
    S.store.update('tasks', id, { pin: yeni, day: yeni ? '' : (t.day || '') });
    note(yeni ? 'Sabitlendi' : 'Sabitten \u00e7\u0131kar\u0131ld\u0131');
    return;
  }
  if (a === 'day-fwd'){
    const t = S.tasks.find(x => x.id === id);
    if (!t || !t.day) return;
    const yeni = iso(addDays(fromIso(t.day), 1));
    S.store.update('tasks', id, { day: yeni });
    if (yeni > iso(addDays(S.weekStart, 6))) note('Gelecek haftaya taşındı — ' + shortDate(yeni));
    return;
  }
  if (a === 'open-job-form'){ S.tab = 'jobs'; S.composer = { scope: 'newjob', day: '' }; S.newJob = { customer: '', project: '' }; render(); return; }
  if (a === 'pick'){ openPicker(b.dataset.type, b); return; }
  if (a === 'pop-close'){ closePicker(); return; }
  if (a === 'pop-all'){ if (S.picker){ S.picker.all = true; renderPicker(); } return; }
  if (a === 'pop-choose'){
    if (S.picker && S.picker.type === 'job'){
      if (b.dataset.genel){ genelChoose(b.dataset.genel, b.dataset.val, +b.dataset.ci || 0); return; }
      jobChoose(b.dataset.job, b.dataset.val, b.dataset.cust, b.dataset.a42); return;
    }
    pickerChoose(b.dataset.val, b.dataset.cust); return;
  }
  if (a === 'pop-add-gen'){
    const v = (document.getElementById('pop-q')?.value || '').trim();
    if (!v) return;
    genelChoose('gen-' + norm(v).replace(/[^a-z0-9ğüşıöç]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40),
                v, (genelJobs().length + 4) % SWATCH.length);
    return;
  }
  if (a === 'pop-del'){
    const c = S.contacts.find(x => x.id === id);
    if (c && confirm(`“${c.name}” rehberden silinsin mi? (İşler etkilenmez)`)) S.store.remove('contacts', id);
    return;
  }
  if (a === 'pop-add'){
    const v = (document.getElementById('pop-q')?.value || '').trim();
    if (!v) return;
    if (S.picker && S.picker.type === 'job'){ jobChoose(null, v, ''); return; }
    ensureContact(v);
    pickerChoose(v);
    return;
  }
  if (a === 'save-job'){ sgClose(); saveJob(); return; }
  if (a === 'seed'){ seed(); return; }
  if (a === 'install'){ doInstall(); return; }
  if (a === 'account'){ openSheet(); return; }
  if (a === 'a42-save'){
    const v = (document.getElementById('a-a42')?.value || '').trim();
    if (v && !/^https:\/\/script\.google\.com\//.test(v)){ note('Adres https://script.google.com/… ile başlamalı.'); return; }
    await setSetting('a42url', v);
    S.a42 = { isler: [], at: 0, hata: '' };
    await loadA42(false);
    openSheet();
    note(v ? (a42Devam().length + ' devam eden iş okundu.') : 'A42 bağlantısı kaldırıldı.');
    return;
  }
  if (a === 'mic'){ sesBaslat(); return; }
  if (a === 'voice-bitir'){ sesBitir(); return; }
  if (a === 'voice-cevap'){ sesCevapla(); return; }
  if (a === 'voice-coklu'){ komutCokluUygula(); return; }
  if (a === 'voice-close'){ voiceKapat(); return; }
  if (a === 'voice-ok'){ if (V.sonuc) komutUygula(V.sonuc, false); return; }
  if (a === 'ai-save'){
    const v = (document.getElementById('a-key')?.value || '').trim();
    if (!v){ await setSetting('claudekey',''); await setSetting('claudemodel',''); openSheet(); note('Anahtar kaldırıldı.'); return; }
    if (!/^sk-ant-/.test(v)){ note('Anahtar sk-ant- ile başlamalı.'); return; }
    await setSetting('claudekey', v);
    try {
      const m = await aiModelSec();
      await setSetting('claudemodel', m);
      openSheet(); note('Bağlandı · ' + m);
    } catch(e){
      await setSetting('claudemodel','');
      openSheet(); note('Anahtar doğrulanamadı: ' + e.message);
    }
    return;
  }
  if (a === 'a42-reload'){ S.a42.at = 0; await loadA42(false); openSheet(); return; }
  if (a === 'close-sheet'){ closeSheet(); return; }
  if (a === 'refresh'){ closeSheet(); hardRefresh(); return; }

  if (a === 'signin' || a === 'signup'){
    const mail = (document.getElementById('a-mail')?.value || '').trim();
    const pass = document.getElementById('a-pass')?.value || '';
    try {
      if (a === 'signin') await S.auth.signIn(mail, pass);
      else await S.auth.signUp(mail, pass);
      closeSheet();
    } catch(err){ authErr(authMessage(err.code || err.message)); }
    return;
  }
  if (a === 'signout'){ await S.auth.signOut(); closeSheet(); return; }

  if (a === 'toggle'){
    const t = S.tasks.find(x => x.id === id);
    if (t) S.store.update('tasks', id, { done: !t.done, doneAt: t.done ? 0 : Date.now() });
    return;
  }
  if (a === 'to-today'){ S.store.update('tasks', id, { day: todayIso() }); return; }
  if (a === 'dup-task'){
    const t = S.tasks.find(x => x.id === id);
    if (!t) return;
    const ayni = S.tasks.filter(x => (x.day || '') === (t.day || '')).sort(byDone);
    const i = ayni.findIndex(x => x.id === id);
    S.store.add('tasks', { jobId: t.jobId, day: t.day || '', text: t.text, pin: !!t.pin,
      done: false, createdAt: Date.now(), ord: ordBetween(ayni[i], ayni[i + 1]) });
    note('Görev çoğaltıldı.');
    return;
  }
  if (a === 'dup-job'){
    const j = jobById(id);
    if (!j) return;
    const yeni = await S.store.add('jobs', { customer: j.customer || '', project: (j.project || '') + ' (kopya)',
      archived: false, ci: S.jobs.length % SWATCH.length, createdAt: Date.now() });
    const acik = S.tasks.filter(t => t.jobId === id && !t.done).sort(byDone);
    for (const t of acik){
      await S.store.add('tasks', { jobId: yeni, day: t.day || '', text: t.text,
        done: false, createdAt: Date.now(), ord: ordOf(t) });
    }
    note(acik.length ? `İş ve ${acik.length} açık görev çoğaltıldı.` : 'İş çoğaltıldı.');
    return;
  }
  if (a === 'del-task'){ if (confirm('Bu görev silinsin mi?')) S.store.remove('tasks', id); return; }
  if (a === 'arch-job'){ const j = jobById(id); if (j) S.store.update('jobs', id, { archived: !j.archived }); return; }
  if (a === 'del-job'){
    const j = jobById(id); if (!j) return;
    const n = S.tasks.filter(t => t.jobId === id).length;
    if (confirm(`“${j.project || j.customer}” işi ve bağlı ${n} görev silinsin mi? Geri alınamaz.`)){
      S.tasks.filter(t => t.jobId === id).forEach(t => S.store.remove('tasks', t.id));
      S.store.remove('jobs', id);
    }
    return;
  }
  if (a === 'export'){
    const ta = document.getElementById('io');
    ta.value = JSON.stringify({ v: 1, exportedAt: new Date().toISOString(), jobs: S.jobs, tasks: S.tasks }, null, 2);
    ta.select(); note('JSON hazır — kopyalayabilirsiniz.');
    return;
  }
  if (a === 'import'){
    const el = document.getElementById('io'); const raw = (el.value || '').trim();
    if (!raw){ note('Önce JSON yapıştırın.'); return; }
    let obj; try { obj = JSON.parse(raw); } catch(err){ note('JSON okunamadı.'); return; }
    const jobs = Array.isArray(obj.jobs) ? obj.jobs : [], tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
    if (!jobs.length && !tasks.length){ note('İçeride iş ya da görev yok.'); return; }
    if (!confirm(`${jobs.length} iş ve ${tasks.length} görev eklensin mi?`)) return;
    const map = {};
    for (let i = 0; i < jobs.length; i++){
      const j = jobs[i];
      const nid = await S.store.add('jobs', { customer: j.customer || '', project: j.project || '', archived: !!j.archived,
        ci: typeof j.ci === 'number' ? j.ci : (S.jobs.length + i) % SWATCH.length, createdAt: j.createdAt || Date.now() });
      map[j.id] = nid;
    }
    for (const t of tasks){
      const nj = map[t.jobId];
      if (!nj) continue;
      await S.store.add('tasks', { jobId: nj, day: t.day || '', text: t.text || '', done: !!t.done, createdAt: t.createdAt || Date.now() });
    }
    el.value = ''; note('İçe aktarıldı.');
    return;
  }
  if (a === 'purge-done'){
    const d = S.tasks.filter(t => t.done);
    if (!d.length){ note('Biten görev yok.'); return; }
    if (!confirm(`${d.length} biten görev kalıcı olarak silinsin mi?`)) return;
    d.forEach(t => S.store.remove('tasks', t.id));
    return;
  }
});

sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

document.addEventListener('input', e => {
  if (e.target.id === 'c-text') S.draft.text = e.target.value;
  if (e.target.id === 'j-cust'){ S.newJob.customer = e.target.value; sgShow(e.target); }
  if (e.target.id === 'j-proj'){ S.newJob.project = e.target.value; sgShow(e.target); }
  if (e.target.id === 'pop-q' && S.picker){ S.picker.q = e.target.value; renderPicker(); }
});

document.addEventListener('focusout', e => {
  if (e.target.id === 'j-cust' || e.target.id === 'j-proj') setTimeout(sgClose, 120);
});

document.addEventListener('mousedown', e => {
  if (!S.picker) return;
  if (e.target.closest('#pop') || e.target.closest('[data-act="pick"]')) return;
  closePicker();
});
document.addEventListener('change', e => {
  if (e.target.id === 'c-day') S.draft.day = e.target.value;
});
document.addEventListener('keydown', e => {
  // yazarken öneri listesinde gezinme
  if (sg && (e.target.id === 'j-cust' || e.target.id === 'j-proj')){
    if (e.key === 'ArrowDown'){ e.preventDefault(); sg.i = (sg.i + 1) % sg.items.length; sgMark(); return; }
    if (e.key === 'ArrowUp'){ e.preventDefault(); sg.i = (sg.i - 1 + sg.items.length) % sg.items.length; sgMark(); return; }
    if (e.key === 'Enter' && sg.i >= 0){ e.preventDefault(); sgPick(sg.i); return; }
    if (e.key === 'Escape'){ e.preventDefault(); sgClose(); return; }
    if (e.key === 'Tab'){ if (sg.i >= 0){ e.preventDefault(); sgPick(sg.i); } else sgClose(); return; }
  }
  if (e.key === 'Escape'){
    if (S.picker){ closePicker(); return; }
    if (!sheet.hidden){ closeSheet(); return; }
    if (S.composer){ S.composer = null; S.draft.text = ''; render(); }
    return;
  }
  if (e.key !== 'Enter') return;
  if (e.target.id === 'pop-q'){
    e.preventDefault();
    const first = document.querySelector('#pop .pop-pick');
    if (first && S.picker.type === 'job') jobChoose(first.dataset.job, first.dataset.val, first.dataset.cust, first.dataset.a42);
    else if (first) pickerChoose(first.dataset.val, first.dataset.cust);
    else if (S.picker.type === 'job'){ const v = e.target.value.trim(); if (v) jobChoose(null, v, ''); }
    else if (S.picker.type === 'customer'){ const v = e.target.value.trim(); if (v){ ensureContact(v); pickerChoose(v); } }
    return;
  }
  if (e.target.id === 'c-text'){ e.preventDefault(); saveTask(); }
  if (e.target.id === 'j-cust' || e.target.id === 'j-proj'){ e.preventDefault(); saveJob(); }
  if (e.target.id === 'a-mail' || e.target.id === 'a-pass'){ e.preventDefault(); document.querySelector('[data-act="signin"]')?.click(); }
});

/* ============ depo bağlama ============ */
function bind(store, label, kind){
  S.unsub.forEach(u => { try { u(); } catch(e){} });
  S.unsub = [];
  S.store = store;
  S.jobs = []; S.tasks = []; S.contacts = []; S.settings = [];
  setSync(kind, label);
  S.unsub.push(store.subscribe('jobs', rows => { S.jobs = rows.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); render(); renderPicker(); }));
  S.unsub.push(store.subscribe('tasks', rows => { S.tasks = rows; render(); }));
  S.unsub.push(store.subscribe('contacts', rows => { S.contacts = rows; renderPicker(); }));
  S.unsub.push(store.subscribe('settings', rows => { S.settings = rows; loadA42(true); }));
}

/* ============ açılış ============ */
try {
  const v = new URLSearchParams(location.search).get('v');
  if (v === 'jobs' || v === 'week' || v === 'undated') S.tab = v;
} catch(e){}
render();
bind(localStore(), 'yerel', 'off');

/* Teklif arşivinden üretilen müşteri/proje rehberi (statik dosya).
   Uygulama açıkken saatte bir ve her odaklanışta yeniden denetlenir;
   rehber yayınlandığında sayfayı yenilemeye gerek kalmaz. */
let refFetched = 0;
async function loadRef(force){
  const now = Date.now();
  if (!force && now - refFetched < 3600000) return;
  refFetched = now;
  try {
    const r = await fetch('./rehber.json?t=' + now, { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (!d || (!d.c && !d.p)) return;
    const eski = (S.ref.c || []).length + (S.ref.p || []).length;
    S.ref = { c: d.c || [], p: d.p || [] };
    const yeni = S.ref.c.length + S.ref.p.length;
    renderPicker();
    if (eski && yeni !== eski) note(`Rehber güncellendi — ${S.ref.c.length} müşteri, ${S.ref.p.length} proje`);
  } catch(e){}
}
loadRef(true);
document.addEventListener('visibilitychange', () => { if (!document.hidden){ loadRef(false); loadA42(true); } });
window.addEventListener('focus', () => { loadRef(false); loadA42(true); });
setInterval(() => { if (!document.hidden){ loadRef(false); loadA42(true); } }, 3600000);

(async function boot(){
  const cfg = window.IZO_FIREBASE || {};
  if (!cfg.apiKey || !cfg.projectId){ setSync('off', 'yerel'); return; }
  try {
    const [{ initializeApp }, authMod, fsMod] = await Promise.all([
      import(FB('app')), import(FB('auth')), import(FB('firestore'))
    ]);
    const app = initializeApp(cfg);
    const auth = authMod.getAuth(app);
    await authMod.setPersistence(auth, authMod.browserLocalPersistence).catch(() => {});

    let db;
    try {
      db = fsMod.initializeFirestore(app, {
        localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() })
      });
    } catch(e){ db = fsMod.getFirestore(app); }

    S.cloudReady = true;
    S.auth = {
      signIn: (m, p) => authMod.signInWithEmailAndPassword(auth, m, p),
      signUp: (m, p) => authMod.createUserWithEmailAndPassword(auth, m, p),
      signOut: () => authMod.signOut(auth)
    };

    authMod.onAuthStateChanged(auth, user => {
      S.user = user;
      if (user){
        bind(firestoreStore({ db, ...fsMod }, user.uid), 'buluta kayıtlı', 'cloud');
      } else {
        bind(localStore(), 'giriş yapın', 'warn');
      }
    });
  } catch(err){
    console.warn('Firebase yüklenemedi:', err);
    setSync('warn', 'yerel — bulut yok');
  }
})();

/* ============ kurulum (install) ============ */
let deferredPrompt = null;
const installBtn = document.getElementById('install');
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredPrompt = e; installBtn.hidden = false;
});
window.addEventListener('appinstalled', () => { installBtn.hidden = true; deferredPrompt = null; });
async function doInstall(){
  if (deferredPrompt){ deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; installBtn.hidden = true; return; }
  note('Safari’de: Paylaş ➔ Ana Ekrana Ekle');
}
// iOS Safari: kurulum ipucu
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
if (isIOS && !standalone) installBtn.hidden = false;

/* ============ sürükle-bırak ============ */
let drag = null;

function ordBetween(prev, next){
  const a = prev ? ordOf(prev) : null, b = next ? ordOf(next) : null;
  if (a === null && b === null) return Date.now();
  if (a === null) return b - 60000;
  if (b === null) return a + 60000;
  return (a + b) / 2;
}

/* Bırakma hedefini geometriyle bul: parmağın tam bırakma şeridinin üstünde
   olması gerekmesin — gün kartının herhangi bir yeri, hatta yakını yeter. */
function hedefBul(x, y){
  const liste = [...document.querySelectorAll('[data-drop]')].map(box => ({
    box, r: (box.closest('.day') || box.closest('.pinpanel') || box).getBoundingClientRect()
  })).filter(t => t.r.width > 0 && t.r.height > 0);
  for (const t of liste){
    if (x >= t.r.left && x <= t.r.right && y >= t.r.top && y <= t.r.bottom) return t.box;
  }
  let en = null, mesafe = Infinity;
  for (const t of liste){
    const dx = x < t.r.left ? t.r.left - x : x > t.r.right ? x - t.r.right : 0;
    const dy = y < t.r.top ? t.r.top - y : y > t.r.bottom ? y - t.r.bottom : 0;
    const d = Math.hypot(dx, dy);
    if (d < mesafe){ mesafe = d; en = t.box; }
  }
  return mesafe <= 70 ? en : null;
}

/* sürüklerken ekran kenarında otomatik kaydırma (telefonda 7 gün ekrana sığmıyor) */
let scrollTimer = null;
function autoScroll(y){
  const esik = 90, hiz = 14;
  const h = window.innerHeight;
  let yon = 0;
  if (y < esik) yon = -1;
  else if (y > h - esik) yon = 1;
  if (!yon){ if (scrollTimer){ clearInterval(scrollTimer); scrollTimer = null; } return; }
  if (scrollTimer) return;
  scrollTimer = setInterval(() => {
    if (!drag){ clearInterval(scrollTimer); scrollTimer = null; return; }
    window.scrollBy(0, yon * hiz);
  }, 16);
}
function stopScroll(){ if (scrollTimer){ clearInterval(scrollTimer); scrollTimer = null; } }

function dropIndicator(box, y){
  document.querySelectorAll('.dropline').forEach(n => n.remove());
  const line = document.createElement('div');
  line.className = 'dropline';
  const kids = [...box.querySelectorAll('.task')].filter(n => n !== drag.el);
  let before = null;
  for (const k of kids){
    const r = k.getBoundingClientRect();
    if (y < r.top + r.height / 2){ before = k; break; }
  }
  box.insertBefore(line, before);
  drag.box = box; drag.before = before;
}

/* Kartın tamamı sürüklenir.
   · şerit (tutamaç) veya fare  → hemen sürükleme
   · kart gövdesi + dokunma     → 280 ms basılı tut, sonra sürükleme
     (böylece parmakla sayfayı kaydırmak da çalışmaya devam eder) */
const TIKLANIR = 'button, a, input, select, textarea, label, [contenteditable]';
const BASILI_TUT = 280;

document.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.target.closest(TIKLANIR)) return;
  const h  = e.target.closest('[data-drag]');
  const el = e.target.closest('.task');
  if (!el) return;
  const id = el.dataset.id || (h && h.dataset.drag);
  if (!id) return;
  const r = el.getBoundingClientRect();
  drag = { id, el, h: h || el, x0: e.clientX, y0: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top,
           w: r.width, on: false, hazir: false, ghost: null, box: null, before: null, timer: null };
  if (h || e.pointerType !== 'touch'){
    drag.hazir = true;
    e.preventDefault();
    try { (h || el).setPointerCapture(e.pointerId); } catch(err){}
  } else {
    drag.timer = setTimeout(() => {
      if (!drag) return;
      drag.hazir = true;
      drag.el.classList.add('pressready');
      try { navigator.vibrate && navigator.vibrate(12); } catch(err){}
    }, BASILI_TUT);
  }
});

/* sürükleme başladıysa sayfa kaymasın */
document.addEventListener('touchmove', e => { if (drag && drag.on) e.preventDefault(); }, { passive: false });

/* ============ telefonda yatay kaydırma ile hafta değiştirme ============
   Sola kaydır → sonraki hafta, sağa kaydır → önceki hafta.
   Görev sürüklerken, çoklu dokunuşta ve yazarken devre dışı. */
const SWIPE_ESIK = 60, SWIPE_EGIM = 1.6;
let sw = null;

main.addEventListener('touchstart', e => {
  sw = null;
  if (e.touches.length !== 1) return;
  if (S.tab !== 'week') return;
  if (drag && drag.on) return;
  if (document.getElementById('pop')) return;                   // seçici açık
  if (e.target.closest('input, textarea, select, .composer, .sg')) return;
  const t = e.touches[0];
  /* ekran kenarı telefonun kendi "geri" hareketine ait — oraya karışma */
  if (t.clientX < 30 || t.clientX > window.innerWidth - 30) return;
  sw = { x: t.clientX, y: t.clientY, t: Date.now(), iptal: false };
}, { passive: true });

main.addEventListener('touchmove', e => {
  if (!sw || e.touches.length !== 1) { sw = null; return; }
  if (drag && drag.on){ sw = null; return; }
  const t = e.touches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y;
  /* dikey niyet belliyse kaydırmayı bırak — sayfa normal kaysın */
  if (Math.abs(dy) > 24 && Math.abs(dy) > Math.abs(dx)) sw.iptal = true;
}, { passive: true });

main.addEventListener('touchend', e => {
  const s = sw; sw = null;
  if (!s || s.iptal) return;
  if (drag && drag.on) return;
  const t = e.changedTouches && e.changedTouches[0];
  if (!t) return;
  const dx = t.clientX - s.x, dy = t.clientY - s.y;
  if (Math.abs(dx) < SWIPE_ESIK) return;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_EGIM) return;
  if (Date.now() - s.t > 800) return;                            // yavaş sürtme sayılmaz
  const yon = dx < 0 ? 1 : -1;                                   // sola = ileri
  S.weekStart = addDays(S.weekStart, 7 * yon);
  S.composer = null;
  render();
  try { navigator.vibrate && navigator.vibrate(8); } catch(err){}
  const b = S.weekStart, s2 = addDays(b, 6);
  note(rangeLabel(b, s2));
}, { passive: true });

document.addEventListener('pointermove', e => {
  if (!drag) return;
  const uzaklik = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
  if (!drag.hazir){
    if (uzaklik > 8){ clearTimeout(drag.timer); drag = null; }   // kaydırma niyeti
    return;
  }
  if (!drag.on){
    if (uzaklik < 5) return;
    drag.on = true;
    const g = drag.el.cloneNode(true);
    g.className = 'task dragghost';
    g.style.width = drag.w + 'px';
    document.body.appendChild(g);
    drag.ghost = g;
    drag.el.classList.add('dragsrc');
    document.body.classList.add('dragging');
  }
  drag.ghost.style.left = (e.clientX - drag.dx) + 'px';
  drag.ghost.style.top  = (e.clientY - drag.dy) + 'px';
  const box = hedefBul(e.clientX, e.clientY);
  autoScroll(e.clientY);
  document.querySelectorAll('[data-drop].dropon').forEach(n => n.classList.remove('dropon'));
  if (box){ box.classList.add('dropon'); dropIndicator(box, e.clientY); }
  else { document.querySelectorAll('.dropline').forEach(n => n.remove()); drag.box = null; }
});

function endDrag(apply){
  if (!drag) return;
  const d = drag; drag = null;
  clearTimeout(d.timer);
  stopScroll();
  d.ghost?.remove();
  d.el.classList.remove('dragsrc');
  d.el.classList.remove('pressready');
  document.body.classList.remove('dragging');
  document.querySelectorAll('.dropline').forEach(n => n.remove());
  document.querySelectorAll('[data-drop].dropon').forEach(n => n.classList.remove('dropon'));
  if (!apply || !d.on || !d.box) return;

  const hedef = d.box.dataset.drop;
  const t = S.tasks.find(x => x.id === d.id);
  if (!t) return;
  const sabit = hedef === 'pin';
  const gun = sabit ? '' : hedef;
  const komsular = sabit
    ? S.tasks.filter(x => x.pin && x.id !== d.id && (S.showDone || !x.done)).sort(byDone)
    : S.tasks.filter(x => !x.pin && (x.day || '') === gun && x.id !== d.id && (S.showDone || !x.done)).sort(byDone);
  const beforeId = d.before?.dataset.id || null;
  const i = beforeId ? komsular.findIndex(x => x.id === beforeId) : komsular.length;
  const yer = i < 0 ? komsular.length : i;
  const yeniOrd = ordBetween(komsular[yer - 1], komsular[yer]);
  if (!!t.pin === sabit && (t.day || '') === gun && Math.abs(ordOf(t) - yeniOrd) < 1) return;
  S.store.update('tasks', d.id, { day: gun, ord: yeniOrd, pin: sabit });
  if (sabit && !t.pin) note('Sabitlendi');
  else if (!sabit && t.pin) note('Sabitten \u00e7\u0131kar\u0131ld\u0131');
}

document.addEventListener('pointerup', () => endDrag(true));
document.addEventListener('pointercancel', () => endDrag(false));

/* ============ service worker + otomatik güncelleme ============ */
let swReg = null, lastCheck = 0, updateShown = false;

function showUpdateBar(){
  if (updateShown) return;
  updateShown = true;
  const bar = document.createElement('div');
  bar.className = 'updbar';
  bar.innerHTML = '<span>Yeni sürüm hazır</span><button class="btn primary" id="upd-go">Yenile</button>';
  document.body.appendChild(bar);
  document.getElementById('upd-go').addEventListener('click', () => location.reload());
}

async function checkUpdate(force){
  if (!swReg) return false;
  const now = Date.now();
  if (!force && now - lastCheck < 60000) return false;
  lastCheck = now;
  try { await swReg.update(); return true; } catch(e){ return false; }
}

if ('serviceWorker' in navigator){
  window.addEventListener('load', async () => {
    try {
      swReg = await navigator.serviceWorker.register('./sw.js');
      navigator.serviceWorker.addEventListener('controllerchange', showUpdateBar);
      swReg.addEventListener('updatefound', () => {
        const w = swReg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar();
        });
      });
      checkUpdate(true);
    } catch(e){ console.warn('SW:', e); }
  });
  // uygulamaya her dönüşte sessizce yeni sürüm var mı diye bak
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(false); });
}

async function hardRefresh(){
  note('Güncelleme denetleniyor…');
  const found = await checkUpdate(true);
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch(e){}
  setTimeout(() => location.reload(), found ? 900 : 400);
}

/* ============ A42 arayüzü ============ */
window.IzoTodo = {
  state: S,
  render,
  exportData: () => ({ v: 1, jobs: S.jobs, tasks: S.tasks }),
  addJob: (customer, project) => S.store.add('jobs', { customer: customer || '', project: project || '', archived: false, ci: S.jobs.length % SWATCH.length, createdAt: Date.now() }),
  addTask: (jobId, text, day) => S.store.add('tasks', { jobId, text: text || '', day: day || '', done: false, createdAt: Date.now() }),
  /* test / dış kullanım: sesli komut zincirini metinle çalıştır */
  komut: (metin, devam) => { V.acik = true; V.metin = metin; sesSon = metin;
    if (!devam){ sesGecmis = []; soruTur = 0; }
    const e = vEl(); if (e){ e.hidden = false; document.getElementById('v-body').innerHTML = '';
      document.getElementById('v-acts').innerHTML = ''; }
    return komutCoz(metin); },
  sonuc: () => V.sonuc
};
