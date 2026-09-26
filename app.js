/* İzofleks İş Takibi — PWA
   Veri katmanı iki modda çalışır:
   · bulut  → Firebase Firestore (telefon + bilgisayar gerçek zamanlı senkron)
   · yerel  → localStorage (sadece o cihaz)
   A42 entegrasyonu için dışa açılan arayüz: window.IzoTodo (dosyanın sonunda)
*/
"use strict";

const APP_VERSION = "2026.09.26-kalem";
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
/* 'fotoTam' bilerek ABONE OLUNMAZ — tam boyut fotoğraflar sadece bakarken tek belge çekilir */
const COLLECTIONS = ['jobs', 'tasks', 'contacts', 'settings', 'muhasebe', 'stok', 'stokHareket', 'stokKalem', 'foto', 'fotoTam', 'konum', 'odemeOnay', 'gecmis'];

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
    remove(c, id){ data[c] = data[c].filter(r => r.id !== id); persist(); emit(c); return Promise.resolve(); },
    getDoc(c, id){ return Promise.resolve((data[c] || []).find(r => r.id === id) || null); }
  };
}

/* ============ depo: Firestore ============ */
function firestoreStore(fs, uid){
  const { db, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc: fsGetDoc } = fs;
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
    remove(c, id){ return deleteDoc(doc(db, 'users', uid, c, id)); },
    /* tek belge — tam boyut fotoğraf gibi ağır veriyi abone olmadan çekmek için */
    getDoc(c, id){ return fsGetDoc(doc(db, 'users', uid, c, id)).then(s => s.exists() ? { id: s.id, ...s.data() } : null); }
  };
}

/* ============ durum ============ */
const S = {
  tab: 'home',
  gorevTab: 'week',
  weekStart: mondayOf(new Date()),
  view: (() => { try { return localStorage.getItem('izo-view') === 'month' ? 'month' : 'week'; } catch(e){ return 'week'; } })(),
  jobs: [], tasks: [], contacts: [], settings: [], muhasebe: [], stok: [], stokHareket: [], stokKalem: [], foto: [], gecmis: [],
  fotoOv: null,        // açık fotoğraf penceresi: { hedef, baslik, etiket, not, bekle, goster, tam }
  konum: [], konumOv: null,   // şantiye konumları + açık konum penceresi
  odemeOnay: [],       // elle 'ödendi' işaretleri (masaüstü ile ortak)
  odemeOv: null,       // açık ödeme işaretleme penceresi: { no, r }
  malOv: null,         // açık maliyet panosu: { isId, kat }
  gaAcik: false,       // geri al paneli
  muh: { yon:'', ara:'', odeme:'', limit:60 },
  stk: { firma:'', ara:'', limit:60 },
  a42: { isler: [], teklifler: [], faturalar: [], at: 0, hata: '' },   // A42 widget'tan gelen devam eden işler
  itSec: '',           // İş Takip'te açık satır: 'is:<is_id>' | 'tk:<id>'
  itOv: null,          // İş Takip işlem penceresi: { tip:'red'|'kabul', id, ... }
  itMesgul: '',        // sheet'e yazarken kilitli satır
  ref: { c: [], p: [] },   // teklif arşivinden gelen müşteri/proje rehberi (rehber.json)
  showDone: false,
  showArchived: false,
  composer: null,
  draft: { text: '', job: '', day: '' },
  newJob: { customer: '', project: '' },
  picker: null,          // { type:'customer'|'project', q:'', rect:{...} }
  edit: null,            // düzenlenen görev taslağı { id, text, jobId, day, pin }
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
  a42Teklif().forEach(x => {                  // bekleyen tekliflerin müşterileri
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

const ICON_EDIT = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M13.4 3.6a1.7 1.7 0 0 1 2.4 2.4L7.3 14.5 4 15.5l1-3.3z"/><path d="M12.2 4.8 14.6 7.2"/></svg>`;

const ICON_PIN = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M11.8 2.6 17.4 8.2l-2.3.7a2 2 0 0 0-1 .6l-2.4 2.8-3.9-3.9 2.8-2.4a2 2 0 0 0 .6-1z"/>
  <path d="M7.8 12.2 3.4 16.6"/></svg>`;

/* Kamera — ICON_EDIT/ICON_COPY ile aynı çizgi stili (emoji kart içinde yamalı duruyordu) */
const ICON_CAM = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 7.2h2.6L7 5.2h6l1.4 2H17a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8.2a1 1 0 0 1 1-1z"/>
  <circle cx="10" cy="11.3" r="2.7"/></svg>`;
const ICON_PIN2 = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10 17.5s5.2-4.7 5.2-8.6a5.2 5.2 0 0 0-10.4 0c0 3.9 5.2 8.6 5.2 8.6z"/>
  <circle cx="10" cy="8.8" r="2"/></svg>`;
const ICON_PIE = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10 3.2a6.8 6.8 0 1 0 6.8 6.8H10z"/>
  <path d="M12.6 2.6a6.8 6.8 0 0 1 4.8 4.8h-4.8z"/></svg>`;
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
    <span class="acts">${t.day ? `<button class="fwd${t.devir ? ' devir' : ''}" data-act="day-fwd" data-id="${t.id}" aria-label="${t.devir ? 'Bitene kadar her gün taşınıyor — kapatmak için basılı tut' : 'Bir gün ileri — bitene kadar taşımak için basılı tut'}" title="${t.devir ? 'Bitene kadar her gün taşınıyor · kapatmak için basılı tut' : 'Dokun: bir gün ileri · Basılı tut: bitene kadar her gün taşı'}">${t.devir ? '\u21BB' : '\u203A'}</button>` : ''}<button class="fotob${fotoSayi('gorev:' + t.id) ? ' var' : ''}" data-act="foto-panel" data-k="gorev:${t.id}" data-b="${esc(t.text || '')}" aria-label="Fotoğraf" title="Fotoğraf">${ICON_CAM}${fotoSayi('gorev:' + t.id) ? `<i>${fotoSayi('gorev:' + t.id)}</i>` : ''}</button><button class="editb" data-act="task-edit" data-id="${t.id}" aria-label="Düzenle" title="Düzenle">${ICON_EDIT}</button><button class="dup" data-act="dup-task" data-id="${t.id}" aria-label="Görevi çoğalt" title="Çoğalt">${ICON_COPY}</button><button class="kill" data-act="del-task" data-id="${t.id}" aria-label="Görevi sil" title="Sil">×</button></span>
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

const dataPanelHtml = () => `<details class="data"><summary>Veri · dışa/içe aktarım (TERM)</summary><div class="inner">
  <p>TERM’e taşımak ya da yedek almak için: aşağıdaki JSON tüm işleri ve görevleri içerir. Yapıştırıp <b>İçe aktar</b> derseniz kayıtlar mevcutlara eklenir.</p>
  <textarea id="io" spellcheck="false" placeholder="JSON"></textarea>
  <div class="navbtns" style="margin-left:0">
    <button class="btn" data-act="export">Dışa aktar</button>
    <button class="btn" data-act="import">İçe aktar</button>
    <button class="btn" data-act="purge-done">Biten görevleri temizle</button>
  </div></div></details>`;

/* ============ TERM İş Takip bağlantısı ============ */
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

/* A42'de gönderilmiş ama henüz işe dönüşmemiş teklifler.
   İş kartı kimliği teklifin kendi kimliğinden türetilir → cihazlar arası tek kart. */
const a42Teklif = () => (S.a42.teklifler || [])
  .filter(x => ['GONDERILDI', 'KABUL'].includes(String(x.durum || '')) && !String(x.is_id || '').trim())
  .sort((a, b) => String(b.guncelleme || '').localeCompare(String(a.guncelleme || '')));

/* Teklif kimliği uzun bir metin ("Müşteri|Proje|Tarih") — belge kimliğine çevir */
function tkfKimlik(id){
  const t = String(id || '');
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  const slug = norm(t).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return 'tkf-' + h.toString(36) + (slug ? '-' + slug : '');
}

/* Apps Script web uygulaması: tarayıcıda birden fazla Google hesabı açıkken
   çerezli istek 404 dönüyor (dağıtımın sahibi kişisel hesap, aktif hesap başka).
   Çerezsiz (credentials:'omit') istek 200 dönüyor — bu yüzden JSONP yerine
   çerezsiz fetch kullanıyoruz. Yanıt yine "cb({...});" sarmalında geliyor. */
async function sheetCek(url, ms){
  const hedef = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'fn=list&cb=t&r=' + Math.random();
  const kesici = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const zaman = setTimeout(() => { try { kesici && kesici.abort(); } catch(e){} }, ms || 45000);
  try {
    const r = await fetch(hedef, { credentials: 'omit', signal: kesici ? kesici.signal : undefined });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = (await r.text()).trim();
    const a = t.indexOf('('), b = t.lastIndexOf(')');
    if (a < 0 || b <= a) throw new Error('beklenmeyen yanıt');
    return JSON.parse(t.slice(a + 1, b));
  } finally { clearTimeout(zaman); }
}

/* Sheet'e YAZ — okuma ile aynı çerezsiz yol (fn=is / fn=teklif).
   Boş metin ('') bilerek gönderilir: sheet'teki alanı temizlemek için gerekiyor. */
async function a42Yaz(params, ms){
  const url = getSetting('a42url');
  if (!url) throw new Error('TERM bağlantısı ayarlı değil');
  const q = ['cb=t', 'r=' + Math.random()];
  for (const k in params){
    if (params[k] === null || params[k] === undefined) continue;
    q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  }
  const hedef = url + (url.indexOf('?') >= 0 ? '&' : '?') + q.join('&');
  const kesici = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const zaman = setTimeout(() => { try { kesici && kesici.abort(); } catch(e){} }, ms || 30000);
  try {
    const r = await fetch(hedef, { credentials: 'omit', signal: kesici ? kesici.signal : undefined });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = (await r.text()).trim();
    const a = t.indexOf('('), b = t.lastIndexOf(')');
    const res = (a >= 0 && b > a) ? JSON.parse(t.slice(a + 1, b)) : null;
    if (res && res.ok === false) throw new Error(res.hata || res.error || 'sheet reddetti');
    return res || {};
  } finally { clearTimeout(zaman); }
}

/* İşlem sonrası: listeyi tazele, satırı kapat */
async function itSonra(mesaj){
  S.itSec = ''; S.itOv = null; S.itMesgul = '';
  S.a42.at = 0;
  render();
  note(mesaj);
  await loadA42(false);
  render();
}

function itTl(n){ return (+n || 0).toLocaleString('tr-TR', { minimumFractionDigits:2, maximumFractionDigits:2 }); }
function itBugun(){
  const d = new Date();
  return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear();
}
/* masaüstü TERM ile birebir aynı formül (_karHesapla) */
function itKar(T, M){
  if (!(T > 0) || !(M > 0)) return null;
  const bk = T - M, vergi = bk * 0.22 + bk * (1 - 0.22) * 0.2, net = bk - vergi;
  return { teklif: T, maliyet: M, brutKar: bk, vergi: vergi, kdvFarki: bk * 0.2,
           netKar: net, brutKarPct: (T / M - 1) * 100, netKarPct: (net / T) * 100 };
}

let a42Bekliyor = false;
async function loadA42(yumusak){
  const url = getSetting('a42url');
  if (!url){ S.a42 = { isler: [], teklifler: [], at: 0, hata: '' }; return; }
  if (a42Bekliyor) return;
  if (yumusak && S.a42.at && Date.now() - S.a42.at < 600000) return;
  a42Bekliyor = true;
  try {
    let res = null;
    try {
      res = await sheetCek(url, 45000);
    } catch(e1){
      /* fetch engellenirse eski JSONP yoluna düş */
      res = await jsonp(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'fn=list', 45000);
    }
    if (res && res.ok){
      S.a42 = { isler: res.isler || [], teklifler: res.teklifler || [],
                faturalar: res.faturalar || [], at: Date.now(), hata: '' };
    } else {
      S.a42 = { ...S.a42, hata: 'TERM İş Takip yanıtı okunamadı' };
    }
  } catch(e){
    S.a42 = { ...S.a42, hata: 'TERM İş Takip bağlantısı kurulamadı (' + e.message + ')' };
  }
  a42Bekliyor = false;
  renderPicker();
  if (S.tab === 'istakip') render();   /* veri geldiğinde İş Takip ekranı kendi kendine dolsun */
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
  sesIptal = true;
  kayitIptal();
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

/* Program sesli cevap vermez — soruyu yazıyla gösterir, sonra dinlemeye geçer. */
function susturKonus(){ try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch(e){} }

/* Konuşmayı yalnızca kullanıcı bitirir — otomatik kapanma yok. */
function sesBitir(){
  if (kayit){ kayitBitir(); return; }
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
  if (!sesDestek() && !kayitMotoru()){ note('Bu tarayıcı konuşma tanımayı desteklemiyor (Chrome gerekir).'); return; }
  if (!getSetting('claudekey')){ note('Önce senkron penceresinden Claude API anahtarını girin.'); openSheet(); return; }
  if (sesTanir || kayit){ sesBitir(); return; }
  susturKonus();
  voiceAc();
  sesGecmis = []; soruTur = 0;            /* yeni komut → geçmiş sıfır */
  sesBitti = false; sesIptal = false; sesSon = ''; sesKesin = ''; sesAlt = []; sesTur = 0;
  if (kayitMotoru()) kayitBaslat(); else sesDinle();
}

/* Programin sorusuna sesli cevap: geçmişi koruyarak yeniden dinle */
function sesCevapla(){
  if (!sesDestek() && !kayitMotoru()){ note('Bu tarayıcı konuşma tanımayı desteklemiyor.'); return; }
  if (sesTanir || kayit){ sesBitir(); return; }
  ekranBilet++;
  if (soruZaman){ clearTimeout(soruZaman); soruZaman = null; }
  sesIptal = false;
  susturKonus();
  V.acik = true;
  const e = vEl(); if (e){ e.hidden = false; e.classList.add('dinliyor'); }
  document.getElementById('v-acts').innerHTML =
    '<button class="btn primary" data-act="voice-bitir">Bitir</button>' +
    '<button class="btn" data-act="voice-close">Vazgeç</button>';
  vSet('Dinleniyor…', '');
  sesBitti = false; sesIptal = false; sesSon = ''; sesKesin = ''; sesAlt = []; sesTur = 0;
  V.cevapModu = true;
  if (kayitMotoru()) kayitBaslat(); else sesDinle();
}

/* ---- konuşma metni temizliği ----
   Android Chrome'un tanıma motoru aynı parçayı birden çok kez döndürebiliyor.
   Üç kat savunma: (1) sonuçları indeks ile tut, (2) birleştirirken örtüşmeyi kırp,
   (3) yine de geçerse peş peşe tekrar eden kelime/öbekleri sil. */

/* "PazartesiPazartesi" gibi kendi içinde tekrarlayan tek kelimeyi sadeleştir */
function kelimeTekrari(w){
  const L = w.length;
  for (let n = 3; n <= L / 2; n++){
    if (L % n) continue;
    const p = w.slice(0, n);
    if (p.repeat(L / n) === w) return p;
  }
  return w;
}

/* peş peşe tekrar eden kelime ve öbekleri tek sefere indir */
function tekrarTemizle(t){
  const k = String(t || '').trim().split(/\s+/).filter(Boolean).map(kelimeTekrari);
  /* Hizadan bağımsız: her konumda "bu öbek hemen ardından aynen tekrar ediyor mu"
     diye bak, ediyorsa ikinci kopyayı at, baştan tara. Üçlü tekrarları da temizler. */
  let degisti = true, koruma = 0;
  while (degisti && koruma++ < 60){
    degisti = false;
    for (let n = 1; n <= 6 && !degisti; n++){
      for (let i = 0; i + 2 * n <= k.length; i++){
        const a = k.slice(i, i + n).join(' ').toLocaleLowerCase('tr');
        const b = k.slice(i + n, i + 2 * n).join(' ').toLocaleLowerCase('tr');
        if (a === b){ k.splice(i + n, n); degisti = true; break; }
      }
    }
  }
  return k.join(' ');
}

/* İki metni örtüşmeyi tekrarlamadan birleştir.
   Motor yeniden başladığında aynı sesi bir daha yazıya çevirebiliyor —
   "PazartesiPazartesi için…" tekrarının sebebi buydu. */
function birlestir(a, b){
  a = String(a || '').trim(); b = String(b || '').trim();
  if (!a) return b;
  if (!b) return a;
  const A = a.toLocaleLowerCase('tr'), B = b.toLocaleLowerCase('tr');
  if (A.endsWith(B)) return a;                 /* yeni parça zaten sonda var */
  if (B.startsWith(A)) return b;               /* yeni parça eskisini kapsıyor */
  const n = Math.min(A.length, B.length);
  for (let k = n; k >= 4; k--){                /* kuyruk-baş örtüşmesini kırp */
    if (A.slice(-k) === B.slice(0, k)) return a + b.slice(k);
  }
  return a + ' ' + b;
}

let sesKesin = '';        /* önceki oturumlarda kesinleşmiş metin */
let sesAlt = [];          /* tanıyıcının alternatif tahminleri */
let sesIptal = false;     /* elle düzeltme gönderildi → tanıyıcının kalan olaylarını yoksay */

/* Android Chrome'da continuous kipi aynı sonucu tekrar tekrar veriyor — orada kapalı çalış,
   oturum kendiliğinden bitince yeniden başlat. Masaüstünde continuous sorunsuz. */
const ANDROID = /Android/i.test(navigator.userAgent);

function sesDinle(){
  const r = new SR();
  sesTanir = r;
  const kesinler = [];            /* indeks → kesinleşmiş parça (tekrar gelirse ÜZERİNE yazar) */
  let gecici = '';
  r.lang = 'tr-TR'; r.interimResults = true; r.maxAlternatives = 4;   /* alternatifleri de Claude'a veriyoruz */
  r.continuous = !ANDROID;

  const oturumMetni = () => tekrarTemizle(kesinler.filter(Boolean).join(' ') + ' ' + gecici);

  r.onresult = ev => {
    gecici = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++){
      const res = ev.results[i], par = (res[0] && res[0].transcript) || '';
      if (res.isFinal){
        kesinler[i] = par;                     /* eklemiyoruz — indekse yazıyoruz */
        /* tanıyıcının diğer tahminleri: Claude doğrusunu seçsin diye saklanıyor */
        for (let k = 1; k < res.length && k < 4; k++){
          const alt = (res[k] && res[k].transcript || '').trim();
          if (alt && alt !== par && sesAlt.indexOf(alt) < 0) sesAlt.push(alt);
        }
      } else gecici = par;
    }
    sesSon = tekrarTemizle(birlestir(sesKesin, oturumMetni()));
    V.metin = sesSon;
    vSet(null, sesSon);
  };

  const oturumuKapat = () => {
    gecici = '';
    sesKesin = tekrarTemizle(birlestir(sesKesin, tekrarTemizle(kesinler.filter(Boolean).join(' '))));
    kesinler.length = 0;
    sesSon = sesKesin;
  };

  r.onerror = ev => {
    if (sesIptal) return;
    if (ev.error === 'no-speech' && !sesBitti && sesTur < SES_TUR){ return; }
    oturumuKapat();
    sesBitti = true; sesTanir = null;
    vEl().classList.remove('dinliyor');
    const m = { 'not-allowed':'Mikrofon izni verilmedi.', 'service-not-allowed':'Mikrofon izni verilmedi.',
                'no-speech':'Ses algılanmadı.', 'audio-capture':'Mikrofon bulunamadı.',
                'aborted':'Dinleme durduruldu.',
                'network':'İnternet bağlantısı gerekiyor.' }[ev.error] || ('Ses hatası: ' + ev.error);
    if (sesSon){ komutCoz(sesSon); return; }
    vSet(m, sesSon);
    document.getElementById('v-body').innerHTML = yazDuzeltHtml('');
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="mic">Tekrar dene</button><button class="btn" data-act="voice-close">Kapat</button>';
  };

  r.onend = () => {
    if (sesIptal){ sesTanir = null; return; }
    oturumuKapat();
    sesTanir = null;
    if (!V.acik) return;
    if (!sesBitti){                       /* kullanıcı bitirmediyse dinlemeye devam */
      if (sesTur < SES_TUR){
        sesTur++;
        setTimeout(() => { if (!sesBitti && V.acik && !sesTanir){ try { sesDinle(); } catch(e){} } }, 180);
        return;
      }
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

/* ============ SES MOTORU 2: sessiz kayıt + OpenAI yazıya çevirme ============
   Android'in konuşma tanıyıcısı başlarken ve her duraklamada "bip" çalıyor, duraklamada
   oturumu da kesiyor. OpenAI anahtarı tanımlıysa sesi uygulamanın kendisi kaydeder
   (hiç ses çıkmaz, duraklamada kesilmez), "Bitir"e basınca tek parça halinde
   gpt-4o-transcribe'a gönderir. Anahtar yoksa eski motor (tarayıcı tanıyıcısı) çalışır. */
const KAYIT_DESTEK = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
const kayitMotoru = () => KAYIT_DESTEK && !!getSetting('openaikey');
const KAYIT_SINIR = 150;             /* saniye — unutulan mikrofon açık kalmasın */
let kayit = null;

/* Yazıya çevirmeye ipucu: özel adlar ve sektör terimleri doğru yazılsın */
function sesIpucu(){
  const adlar = [];
  const ekle = s => { s = String(s || '').replace(/\(teklif\)/g, '').trim(); if (s && s !== 'GENEL' && adlar.indexOf(s) < 0) adlar.push(s); };
  aiIsListesi().forEach(x => { ekle(x.m); ekle(x.p); });
  let ad = '';
  for (const a of adlar){ if ((ad + a).length > 700) break; ad += (ad ? ', ' : '') + a; }
  /* depodaki ürün kodları — "A50", "B11-F3", "9584" gibi kodlar doğru yazılsın */
  let kod = '';
  try {
    const gor = [];
    stokListe().forEach(r => { const k = String(r.k || '').trim(); if (k && gor.indexOf(k) < 0) gor.push(k); });
    for (const k of gor){ if (kod.length > 260) break; kod += (kod ? ', ' : '') + k; }
  } catch(e){}
  return 'Bir alüminyum doğrama firmasının iş takip uygulamasına verilen Türkçe sesli komut. '
    + 'Terimler: İzofleks, TARS, A42 cam bölme, süpürgelik, kapı kasası, kanat, profil, eloksal, RAL, '
    + 'metraj, teklif, hakediş, fatura, sipariş, montaj, keşif, tedarikçi, sabit, tarihsiz, '
    + 'stok, depo, boy, adet, kilo, giriş, çıkış, ödeme, tahsilat, borç, alacak, kdv, '
    + 'gönderildi, reddedildi, kabul, iş takip, muhasebe. '
    + 'Renkler: naturel mat eloksal, pres, boyalı, antrasit, siyah, beyaz, gri, kuvars gri, '
    + 'açık gri, kahve, RAL 7016, RAL 7021, RAL 9005, RAL 9016, RAL 9003, RAL 7039, RAL 7047, RAL 8019, '
    + 'Saray eloksal kartelası: SM01 (mat 01), SM02 (mat 02), SM15 (mat 15), SP21 (parlak 21). '
    + (ad ? 'Geçebilecek adlar: ' + ad + '. ' : '')
    + (kod ? 'Ürün kodları: ' + kod + '.' : '');
}

async function kayitBaslat(){
  if (kayit){ kayitBitir(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1 } });
  } catch(e){
    vEl().classList.remove('dinliyor');
    vSet('Mikrofon izni verilmedi.', '');
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="mic">Tekrar dene</button><button class="btn" data-act="voice-close">Kapat</button>';
    return;
  }
  if (!V.acik){ stream.getTracks().forEach(t => t.stop()); return; }
  const tip = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  let rec;
  try { rec = new MediaRecorder(stream, tip ? { mimeType: tip, audioBitsPerSecond: 48000 } : undefined); }
  catch(e){ rec = new MediaRecorder(stream); }
  const k = kayit = { rec, stream, parcalar: [], bas: Date.now(), tip: rec.mimeType || tip || 'audio/webm', raf: 0 };
  rec.ondataavailable = e => { if (e.data && e.data.size) k.parcalar.push(e.data); };
  rec.onstop = () => kayitIsle(k);
  rec.start(1000);
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    k.ctx = new AC();
    const src = k.ctx.createMediaStreamSource(stream);
    k.an = k.ctx.createAnalyser(); k.an.fftSize = 512; src.connect(k.an);
  } catch(e){}
  vEl().classList.add('dinliyor');
  vSet('Dinleniyor — bitince “Bitir”e bas', '');
  const body = document.getElementById('v-body');
  if (body) body.innerHTML = '<div class="vseviye" id="v-seviye" data-t="0:00"><i></i></div>'
    + '<p class="vq">Rahat konuş, duraklayabilirsin — kayıt sen bitirene kadar sürer.</p>';
  const buf = new Uint8Array(512);
  const ciz = () => {
    if (kayit !== k) return;
    const s = Math.floor((Date.now() - k.bas) / 1000);
    let lv = 0;
    if (k.an){ k.an.getByteTimeDomainData(buf); let m = 0; for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i] - 128)); lv = Math.min(1, m / 50); }
    const el = document.getElementById('v-seviye');
    if (el){ el.style.setProperty('--lv', lv.toFixed(2)); el.dataset.t = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
    if (s >= KAYIT_SINIR){ kayitBitir(); return; }
    k.raf = requestAnimationFrame(ciz);
  };
  ciz();
}
function kayitBitir(){
  const k = kayit; if (!k) return;
  kayit = null;
  try { cancelAnimationFrame(k.raf); } catch(e){}
  try { if (k.rec.state !== 'inactive') k.rec.stop(); else kayitIsle(k); } catch(e){ kayitIsle(k); }
  try { k.stream.getTracks().forEach(t => t.stop()); } catch(e){}
  try { k.ctx && k.ctx.close(); } catch(e){}
}
function kayitIptal(){ if (kayit){ kayit.iptal = true; kayitBitir(); } }

async function kayitIsle(k){
  if (k.islendi) return; k.islendi = true;
  if (k.iptal || !V.acik) return;
  vEl().classList.remove('dinliyor');
  const blob = new Blob(k.parcalar, { type: k.tip });
  const sure = (Date.now() - k.bas) / 1000;
  if (!blob.size || sure < 0.6){
    vSet('Bir şey duyamadım.', '');
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="mic">Tekrar dene</button><button class="btn" data-act="voice-close">Kapat</button>';
    return;
  }
  vSet('Yazıya çevriliyor…', '');
  const body = document.getElementById('v-body'); if (body) body.innerHTML = '<p class="vq">Bir saniye…</p>';
  document.getElementById('v-acts').innerHTML = '<button class="btn" data-act="voice-close">Vazgeç</button>';
  try {
    const metin = await yaziyaCevir(blob, k.tip);
    if (!V.acik) return;
    if (!metin){ throw new Error('boş sonuç'); }
    sesSon = metin; V.metin = metin; sesAlt = [];
    vSet(null, metin);
    komutCoz(metin);
  } catch(e){
    if (!V.acik) return;
    vSet('Yazıya çevrilemedi: ' + e.message, '');
    document.getElementById('v-body').innerHTML = yazDuzeltHtml('');
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="mic">Tekrar dene</button><button class="btn" data-act="voice-close">Kapat</button>';
  }
}

async function yaziyaCevir(blob, tip){
  const key = getSetting('openaikey');
  if (!key) throw new Error('OpenAI anahtarı yok');
  const uz = /mp4|m4a|aac/.test(tip) ? 'm4a' : /ogg/.test(tip) ? 'ogg' : /wav/.test(tip) ? 'wav' : 'webm';
  let sonHata = null;
  for (const model of ['gpt-4o-transcribe', 'whisper-1']){
    const fd = new FormData();
    fd.append('file', blob, 'komut.' + uz);
    fd.append('model', model);
    fd.append('language', 'tr');
    fd.append('prompt', sesIpucu());
    fd.append('response_format', 'json');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions',
      { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return String(j.text || '').trim();
    sonHata = new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    if (r.status === 401 || r.status === 429) break;   /* anahtar/kota sorunu — diğer modeli denemenin anlamı yok */
  }
  throw sonHata || new Error('bilinmeyen hata');
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
  /* karmaşık cümleler için Sonnet (liste en yeniden eskiye geliyor → en yeni Sonnet) */
  const m = ids.find(x => /sonnet/.test(x)) || ids.find(x => /opus/.test(x)) || ids.find(x => /haiku/.test(x)) || ids[0];
  if (!m) throw new Error('Model listesi boş');
  return m;
}

function aiIsListesi(){
  const L = [];
  a42Devam().forEach(x => L.push({ id: 'a42:' + x.is_id, m: x.musteri || '', p: x.proje || '' }));
  a42Teklif().slice(0, 25).forEach(x => L.push({ id: 'tkf:' + x.id, m: (x.musteri || '') + ' (teklif)', p: x.proje || '' }));
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
/* Uzun rastgele kimlikleri model hatasız kopyalayamıyor — kısa G1, G2… numarası veriyoruz. */
let sesGorevHarita = {};

function aiGorevListesi(){
  const t0 = todayIso();
  const L = S.tasks
    .filter(t => !t.done || t.day === t0)
    .sort((a, b) => (a.day || '9999').localeCompare(b.day || '9999') || (a.createdAt || 0) - (b.createdAt || 0))
    .slice(0, 80);
  sesGorevHarita = {};
  return L.map((t, i) => {
    const kod = 'G' + (i + 1);
    sesGorevHarita[kod] = t.id;
    const j = jobById(t.jobId);
    const ne = t.pin ? 'sabit' : (t.day || 'tarihsiz');
    return kod + ' | ' + ne + ' | ' + (j ? jobLabel(j) : '—') + ' | ' + (t.text || '') + (t.done ? ' | BİTTİ' : '');
  });
}

/* Model G3 gibi bir kod, gerçek kimlik ya da doğrudan görev metni dönebilir — hepsini karşıla. */
function gorevCoz(v){
  const x = String(v || '').trim();
  if (!x) return null;
  const kod = x.toUpperCase().replace(/[^G0-9]/g, '');
  if (sesGorevHarita[kod]) return sesGorevHarita[kod];
  if (S.tasks.some(t => t.id === x)) return x;
  const q = norm(x);
  if (q.length >= 3){
    const tam = S.tasks.find(t => norm(t.text) === q);
    if (tam) return tam.id;
    const ic = S.tasks.filter(t => norm(t.text).includes(q) || q.includes(norm(t.text)));
    if (ic.length === 1) return ic[0].id;
  }
  return null;
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
  metin = tekrarTemizle(metin);
  vSet('Komut çözülüyor…', metin);
  { const a = document.getElementById('v-acts');
    if (a) a.innerHTML = '<button class="btn" data-act="voice-close">Vazgeç</button>'; }
  const bugun = new Date();
  const isler = aiIsListesi();
  const gorevler = aiGorevListesi();
  const itL = aiItListesi();
  const sistem = [
    'Bir Türk alüminyum doğrama firmasının iş takip uygulaması için sesli komutları JSON\'a çeviriyorsun.',
    '',
    'GİRİŞ METNİ HAKKINDA — ÖNEMLİ:',
    'Metin telefonun tarayıcı konuşma tanıyıcısından geliyor ve HATALI olabilir:',
    '- Türkçe kelimeler İngilizce yazılmış gibi çıkabilir (“cam”→“come”, “bay”→“buy”, “kası”→“casi”, “aşık”→“asic”).',
    '- Kelimeler yanlış bölünmüş ya da birleşmiş olabilir; Türkçe karakterler düşmüş olabilir (ş→s, ı→i, ğ→g, ü→u, ö→o, ç→c).',
    '- Özel adlar (mimar, firma, proje) bozuk gelebilir.',
    'Bu yüzden metni HARF HARF değil SESLETİM olarak değerlendir: Türkçe okunduğunda neye benziyorsa o kabul et.',
    'İş/müşteri/proje adlarını aşağıdaki listelerle SES BENZERLİĞİNE göre eşleştir; birebir yazım tutması gerekmez.',
    'metin alanına DÜZELTİLMİŞ düzgün Türkçe yaz — tanıyıcının bozuk çıktısını aynen kopyalama.',
    'Birden çok "ALTERNATİF" verilmişse hepsi aynı cümlenin farklı tahminidir; en anlamlısını seç ya da birleştirerek doğrusunu kur.',
    tarihTablosu(bugun),
    'İŞ LİSTESİ (isId | müşteri | proje):',
    isler.map(x => x.id + ' | ' + x.m + ' | ' + x.p).join('\n'),
    '',
    'İŞ TAKİP KAYITLARI — is-bitir / is-sil / teklif-* işlemlerinde isId olarak SADECE buradaki kimlikleri kullan:',
    (itL.isl.length ? 'DEVAM EDEN İŞLER:\n' + itL.isl.join('\n') : 'DEVAM EDEN İŞ YOK'),
    (itL.tkf.length ? 'TEKLİFLER:\n' + itL.tkf.join('\n') : 'AÇIK TEKLİF YOK'),
    '',
    'MEVCUT GÖREVLER (gorevId | gün | iş | metin) — gorevId olarak SADECE bu kısa kodları (G1, G2…) kullan:',
    (gorevler.length ? gorevler.join('\n') : '(görev yok)'),
    '',
    'SADECE geçerli JSON döndür — açıklama, başlık, kod çiti (```) YAZMA. JSON\u2019dan sonra tek karakter bile olmasın.',
    'Kullanıcı tek cümlede BİRDEN FAZLA iş söylerse ( “şunu ve şunu” ) JSON DİZİSİ döndür: [{…},{…}]. Tek iş varsa tek nesne.',
    'Şema:',
    '{"islem":"ekle"|"tasi"|"sil"|"bitti"|"geri-al"|"sabitle"|"sabit-kaldir"|"duzenle"|"is-degistir"',
    '        |"is-bitir"|"is-sil"|"teklif-gonderildi"|"teklif-red"|"teklif-kabul"',
    '        |"stok-giris"|"stok-cikis"|"stok-kalem-ac"|"stok-kalem-sil"|"ekran"|"sorgu"|"anlasilmadi",',
    ' "isId":string|null,"gorevId":string|null,"gun":"YYYY-MM-DD"|null,"sabit":true|false,',
    ' "metin":string|null,"hedef":string|null,"konu":string|null,"arama":string|null,"sebep":string|null,',
    ' "stokKod":string|null,"stokMiktar":number|null,"stokBirim":"boy"|"adet"|"m"|"kg"|null,"stokFirma":"izofleks"|"tars"|null,',
    ' "kalemCins":string|null,"kalemDetay":string|null,"kalemEbat":string|null,"kalemRenk":string|null,"kalemBoy":number|null,"kalemKgm":number|null,',
    ' "guven":0..1,"soru":string|null}',
    '',
    'İŞLEMLER:',
    '- ekle: yeni görev. isId + metin zorunlu, gun/sabit isteğe bağlı.',
    '    VARSAYILAN İŞLEM BUDUR. Kullanıcı yeni bir iş/fikir/hatırlatma söylüyorsa (cümlede "ekle", "yaz", "not al", "hatırlat", "sabitlere ekle" olsa da olmasa da) → ekle.',
    '    Söylenen metin mevcut bir görevin metnine BENZESE bile, kullanıcı o görevi açıkça işaret etmiyorsa YENİ görev ekle — var olanı değiştirme.',
    '- tasi: var olan görevin gününü değiştir ("cumaya al", "yarına kaydır", "tarihsize at" → gun null). gorevId + gun.',
    '- sil: görevi kaldır — "sil", "kaldır", "iptal et", "çıkar", "listeden çıkar". gorevId.',
    '- bitti: görevi tamamlandı işaretle — "bitti", "tamamlandı", "yapıldı", "tikle", "işaretle", "halloldu", "bitirdim". gorevId.',
    '- geri-al: tamamlanmış görevi tekrar aç ("geri al", "bitmedi", "aç"). gorevId.',
    '- sabitle / sabit-kaldir: görevi sabit panele al / oradan çıkar. gorevId.',
    '- duzenle: görev metnini değiştir. metin = YENİ TAM METİN.',
    '    SADECE kullanıcı var olan BELİRLİ bir görevi açıkça işaret edip ("şu görevi", "… görevinin adını", "… yazanı") değiştirme fiili kullanırsa:',
    '    "değiştir", "düzelt", "yerine … yaz", "adını … yap", "güncelle", "… görevine şunu da ekle". Bunlardan biri yoksa duzenle SEÇME.',
    '    ekle ile duzenle arasında kararsızsan HER ZAMAN ekle seç — ekleme geri alınabilir, üzerine yazma veri kaybettirir.',
    '    "şunu da ekle / notunu ekle" → eski metni aynen koru, sonuna ", <yeni>" ekleyip tam metni yaz.',
    '    "şunu çıkar" → o kısmı ayıklayıp kalan tam metni yaz.',
    '- is-degistir: var olan görevi BAŞKA bir işe/başlığa taşı (“şunu tedarikçiye al”, “bunu muhasebeye taşı”, “mimarın işine bağla”). gorevId + isId zorunlu; gün değişmez.',
    '',
    'İŞ TAKİP İŞLEMLERİ (görev değil — gerçek iş/teklif kaydı; isId "a42:" ya da "tkf:" ile başlar):',
    '- is-bitir: devam eden bir İŞİ bitmiş yap ("Akbank işini bitir", "Hersek tamamlandı", "şu işi kapat"). isId "a42:..." olmalı.',
    '- is-sil: işi listeden kaldır ("şu işi sil/iptal et"). isId "a42:..." olmalı.',
    '- teklif-gonderildi: teklifi gönderildi işaretle ("Hyatt teklifini gönderdim"). isId "tkf:..." olmalı.',
    '- teklif-red: teklif reddedildi ("… teklifi olmadı / reddedildi / rakibe gitti / pahalı buldu").',
    '    isId "tkf:...", sebep = FIYAT | RAKIP | SURE | KAPSAM | IPTAL | CEVAPSIZ | DIGER. Sebep söylenmediyse DIGER.',
    '    Söylenen ek açıklama varsa metin alanına yaz.',
    '- teklif-kabul: teklif kabul edildi / iş çıktı. isId "tkf:...". Tutar formunu AÇAR, tutarı sen yazmazsın.',
    'DİKKAT: "görevi bitir" ile "işi bitir" AYRI şeylerdir. Kullanıcı bir GÖREV metnini işaret ediyorsa bitti,',
    'bir MÜŞTERİ/PROJE işinden söz ediyorsa is-bitir. Kararsızsan anlasilmadi dön ve sor.',
    '',
    'DEPO HAREKETİ (stok bakiyesini DEĞİŞTİRİR — okuma değil):',
    '- stok-giris: depoya mal girdi ("A50\'den 27 boy giriş yap", "Saray\'dan 500 boy süpürgelik geldi").',
    '- stok-cikis: depodan mal çıktı ("B111 eloksaldan 20 boy çıkış", "Akbank işine 40 boy A50 verdik").',
    '    stokKod = söylenen ürün kodu ya da tarifi (ÜRÜN KODLARI listesinden en yakını; emin değilsen söyleneni aynen yaz).',
    '    stokMiktar = sayı. stokBirim = boy | adet | m | kg (söylenmediyse "boy").',
    '    stokFirma = izofleks | tars (söylenmediyse null). metin = iş/müşteri ya da kısa not.',
    '    DİKKAT: "kaç boy var", "ne kadar kaldı" gibi SORULAR stok hareketi DEĞİL — onlar sorgu.',
    '',
    'DEPO KALEMİ AÇMA / SİLME (stok LİSTESİNİ değiştirir — hareket değil):',
    '- stok-kalem-ac: depoda OLMAYAN yeni bir ürün kartı aç ("yeni kalem aç B11-2 RAL 7016 6 metre boy",',
    '    "depoya yeni ürün ekle", "stokta yok, yeni kalem oluştur").',
    '    stokKod = yeni ürün kodu (ZORUNLU). kalemCins = ürün cinsi. kalemDetay = iç/dış vb.',
    '    kalemEbat = kesit ("76*9"). kalemRenk = RAL/kartela. kalemBoy = boy metre (sayı). kalemKgm = kg/m (sayı).',
    '    stokMiktar = açılış adedi (söylenmediyse 0). stokFirma = izofleks | tars (söylenmediyse null).',
    '- stok-kalem-sil: bir ürün kartını depodan TAMAMEN kaldır ("B11-9 kalemini sil", "stok kartını kaldır").',
    '    stokKod zorunlu. DİKKAT: "20 boy çıkış yap" DEĞİL — o stok-cikis.',
    '',
    'EKRAN VE SORGU:',
    '- ekran: sadece ekran aç ("stok aç", "iş takibe geç", "muhasebeyi göster"). hedef = gorevler|istakip|stok|muhasebe.',
    '- sorgu: bilgi sorusu, hiçbir şey değiştirmez ("A50 profilden kaç boy var", "Turancam\'a borcum ne kadar",',
    '    "Akbank işi ne durumda", "bekleyen teklifler neler").',
    '    konu = stok | muhasebe | istakip.  arama = aranacak kelime (ürün kodu, firma, müşteri, proje). Yoksa null.',
    '    Soru cümlesi ("kaç", "ne kadar", "var mı", "ne durumda", "listele", "göster") varsa ve kayıt değiştirmiyorsa DAİMA sorgu seç.',
    '',
    '- anlasilmadi: emin değilsen. soru alanını doldur.',
    '',
    'KARMAŞIK CÜMLELER:',
    '- Önce cümleyi ayrı işlemlere böl; "ve", "ama", "ayrıca", "bir de", "sonra", "onu da" gibi bağlaçlar çoğu zaman YENİ bir işlem başlatır → JSON DİZİSİ döndür.',
    '- Her işlemin işini, gününü ve metnini KENDİ parçasından al. Bir parçada söylenen gün ya da iş, açıkça "ikisini de" denmedikçe diğer parçaya taşınmaz.',
    '- "bunu", "onu", "şunu" gibi göndermeler aynı cümlede az önce adı geçen göreve/işe aittir.',
    '- Kullanıcı konuşurken kendini düzeltirse ("pazartesi… yok salı") SON söyleneni al.',
    '- metin alanına komut kalıbını değil, yapılacak işin kendisini yaz; mimar/proje adını metne tekrar koyma (iş zaten bağlı).',
    '',
    'KURALLAR:',
    '- isId: İŞ LİSTESİ’nden EN İYİ eşleşen id; eşleşme yoksa null ve guven düşük.',
    '- Müşterisinde "(teklif)" yazanlar henüz işe dönüşmemiş, verilmiş tekliflerdir — takip görevi (arama, hatırlatma, revizyon) bunlara bağlanabilir.',
    '- gorevId: MEVCUT GÖREVLER listesindeki kısa kod (örn. "G3"). Birden fazla görev aynı derecede uyuyorsa "anlasilmadi" dön ve soru ile hangisi olduğunu sor — rastgele seçme.',
    '- Müşteri sütunu GENEL olanlar projeden bağımsız başlıklardır. Komutta mimar/proje geçmiyorsa bunlardan uygun olanı seç — proje uydurma. Hangisi ne kapsar:',
    '    Muhasebe: fatura, vergi, beyanname, SGK, ödeme, kar payı, mali müşavir.',
    '    Ofis / İdari: ofis işleri, evrak, kırtasiye, araç, resmî yazışma.',
    '    Tedarikçi: tedarikçi arama, fiyat isteme, sipariş takibi, taşeron.',
    '    Kişisel: kişisel hatırlatmalar.',
    '    Dijital: web sitesi, Wix, reklam/tanıtım mailleri, sosyal medya, katalog dijital işleri VE yazılım tarafı — uygulama (app), TERM programı, yapay zeka / AI ile ilgili her iş.',
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
    if (!model || /haiku/i.test(model)){ model = await aiModelSec(); await setSetting('claudemodel', model); }
    const altlar = (sesAlt || []).filter(x => norm(x) !== norm(metin)).slice(0, 3);
    const kullanici = altlar.length
      ? metin + '\n\n(ALTERNATİF tahminler: ' + altlar.join(' | ') + ')'
      : metin;
    sesGecmis.push({ role: 'user', content: kullanici });
    if (sesGecmis.length > 9) sesGecmis = sesGecmis.slice(-9);
    const j = await aiFetch('messages', {
      model, max_tokens: 900, system: sistem, messages: sesGecmis
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
  'geri-al':'Geri aç', sabitle:'Sabitle', 'sabit-kaldir':'Sabitten çıkar', duzenle:'Değiştir',
  'is-degistir':'İşi değiştir' };
const HEDEF_ISLEM = ['tasi','sil','bitti','geri-al','sabitle','sabit-kaldir','duzenle','is-degistir'];
/* İş Takip (gerçek iş/teklif kaydı) + ekran + sorgu — görev listesinden bağımsız işlemler */
const IT_ISLEM  = ['is-bitir','is-sil','teklif-gonderildi','teklif-red','teklif-kabul'];
const SERBEST_ISLEM = ['ekran','sorgu'];
Object.assign(ISLEM_AD, {
  'is-bitir':'İşi bitir', 'is-sil':'İşi sil', 'teklif-gonderildi':'Gönderildi işaretle',
  'teklif-red':'Teklifi reddet', 'teklif-kabul':'Teklifi kabul et', 'ekran':'Ekranı aç', 'sorgu':'Sorgula',
  'stok-giris':'Depoya giriş', 'stok-cikis':'Depodan çıkış',
  'stok-kalem-ac':'Yeni depo kalemi', 'stok-kalem-sil':'Depo kalemini sil'
});
const EKRAN_AD = { gorevler:'Görevler', istakip:'İş Takip', stok:'Stok', muhasebe:'Muhasebe' };
const EKRAN_TAB = { gorevler:'home', istakip:'istakip', stok:'stok', muhasebe:'muh' };
const SORGU_AD  = { stok:'Stok', muhasebe:'Muhasebe', istakip:'İş Takip' };
/* isId → a42 iş / teklif kaydı.
   HAM listede ararız: a42Devam() sadece DEVAM'ı, a42Teklif() sadece GONDERILDI/KABUL'ü
   döndürüyor → "teklifi gönderildi yap" gibi komutlar hedefini bulamıyordu. */
const itIsBul  = id => (S.a42.isler || []).find(z => 'a42:' + z.is_id === String(id || ''));
const itTkfBul = id => (S.a42.teklifler || []).find(z => 'tkf:' + z.id === String(id || ''));
/* Sesli komutun hedefleyebileceği İş Takip kayıtları (kapanmışlar hariç) */
function aiItListesi(){
  const kapali = ['SILINDI','RED','IPTAL'];
  const isl = (S.a42.isler || [])
    .filter(x => kapali.indexOf(String(x.durum || 'DEVAM').toUpperCase()) < 0)
    .slice(0, 30)
    .map(x => 'a42:' + x.is_id + ' | ' + [x.musteri, x.proje].filter(Boolean).join(' — ')
              + ' | durum: ' + String(x.durum || 'DEVAM'));
  const tkf = (S.a42.teklifler || [])
    .filter(x => kapali.indexOf(String(x.durum || '').toUpperCase()) < 0 && !String(x.is_id || '').trim())
    .slice(0, 30)
    .map(x => 'tkf:' + x.id + ' | ' + [x.musteri, x.proje].filter(Boolean).join(' — ')
              + ' | durum: ' + String(x.durum || 'BEKLİYOR'));
  return { isl, tkf };
}

function komutSonuc(veri, ham){
  ekranBilet++;
  if (soruZaman){ clearTimeout(soruZaman); soruZaman = null; }
  const dizi = komutDizi(veri);
  if (dizi.length > 1) return komutCoklu(dizi, ham);
  const o = dizi[0] || {};
  V.sonuc = o;
  const islem = String(o.islem || '');
  if (HEDEF_ISLEM.includes(islem)){        /* kodu gerçek kimliğe çevir */
    const ger = gorevCoz(o.gorevId);
    if (ger) o.gorevId = ger;
  }
  if (STOK_ISLEM.includes(islem)){ komutStok(o, islem); return; }   /* kendi onay akışı */
  if (islem === 'stok-kalem-ac'){  komutKalemAc(o);  return; }
  if (islem === 'stok-kalem-sil'){ komutKalemSil(o); return; }
  const gecerli = (islem === 'ekle' && o.isId && o.metin)
               || (islem === 'is-degistir' && o.isId && o.gorevId && S.tasks.some(t => t.id === o.gorevId))
               || (HEDEF_ISLEM.includes(islem) && islem !== 'is-degistir' && o.gorevId && S.tasks.some(t => t.id === o.gorevId))
               || (islem === 'sorgu' && SORGU_AD[o.konu])
               || (islem === 'ekran' && EKRAN_TAB[o.hedef])
               || ((islem === 'is-bitir' || islem === 'is-sil') && itIsBul(o.isId))
               || (islem.startsWith('teklif-') && itTkfBul(o.isId));
  if (!gecerli){
    const soru = o.soru || 'Hangi iş için, hangi güne?';
    vSet('Soru', ham);
    document.getElementById('v-body').innerHTML =
      `<p class="vq">${esc(soru)}</p>` + yazDuzeltHtml(ham);
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="voice-cevap">&#127908; Cevapla</button>' +
      '<button class="btn" data-act="mic">Baştan söyle</button>' +
      '<button class="btn ghost" data-act="voice-close">Kapat</button>';
    soruSor();
    return;
  }
  /* Sorgu ve ekran açma hiçbir kaydı değiştirmez → onay sorulmaz */
  if (SERBEST_ISLEM.includes(islem)){ komutUygula(o, true); return; }
  const guven = +o.guven || 0;
  /* Silme ve metin değiştirme asla kendiliğinden yapılmaz — her zaman onay ister
     (üzerine yazılan metin geri gelmez). */
  const esik = (islem === 'sil' || islem === 'duzenle' || IT_ISLEM.includes(islem)) ? 2
             : (islem === 'ekle' ? 0.75 : 0.8);
  if (guven >= esik){ komutUygula(o, true); return; }
  const soru = o.soru || (islem === 'sil' ? 'Bu görev silinsin mi?'
    : islem === 'duzenle' ? 'Bu görevin metni değiştirilsin mi? (Yeni görev eklemek istiyorsan “Yeni görev olarak ekle”ye bas.)'
    : islem === 'is-sil' ? 'Bu İŞ kaydı silinsin mi? (görev değil, gerçek iş)'
    : islem === 'is-bitir' ? 'Bu İŞ bitmiş olarak kapatılsın mı?'
    : IT_ISLEM.includes(islem) ? 'Teklif kaydı güncellensin mi?'
    : 'Doğru mu?');
  ekranKilitle();
  vSet('Onay bekliyor', ham);
  document.getElementById('v-body').innerHTML = komutOzet(o) + `<p class="vq">${esc(soru)}</p>`;
  document.getElementById('v-acts').innerHTML =
    `<button class="btn primary${(islem === 'sil' || islem === 'is-sil') ? ' tehlike' : ''}" data-act="voice-ok">${esc(ISLEM_AD[islem] || 'Uygula')}</button>` +
    (islem === 'duzenle' ? '<button class="btn" data-act="voice-yeni">Yeni görev olarak ekle</button>' : '') +
    '<button class="btn" data-act="voice-cevap">&#127908; Cevapla</button>' +
    '<button class="btn ghost" data-act="voice-close">İptal</button>';
  /* onay ekranında kendiliğinden dinlemeye GEÇMİYORUZ — düğmeler kaybolmasın */
}

/* Birden fazla komut: hepsini özetle, tek onayla uygula */
function komutCoklu(dizi, ham){
  const gecerliMi = o => {
    const i = String(o.islem || '');
    if (HEDEF_ISLEM.includes(i)){ const g = gorevCoz(o.gorevId); if (g) o.gorevId = g; }
    return (i === 'ekle' && o.isId && o.metin)
        || (i === 'is-degistir' && o.isId && o.gorevId && S.tasks.some(t => t.id === o.gorevId))
        || (HEDEF_ISLEM.includes(i) && i !== 'is-degistir' && o.gorevId && S.tasks.some(t => t.id === o.gorevId))
        || ((i === 'is-bitir' || i === 'is-sil') && itIsBul(o.isId))
        || (i.startsWith('teklif-') && itTkfBul(o.isId));
  };
  const iyi = dizi.filter(gecerliMi);
  if (!iyi.length){ komutSonuc(dizi[0] || {}, ham); return; }
  V.coklu = iyi;
  const silVar = iyi.some(o => String(o.islem) === 'sil' || String(o.islem) === 'duzenle');
  const dusuk  = iyi.some(o => (+o.guven || 0) < 0.8);
  if (!silVar && !dusuk){ komutCokluUygula(); return; }
  ekranKilitle();
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
  /* onay ekranında kendiliğinden dinlemeye GEÇMİYORUZ — düğmeler kaybolmasın */
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
/* Tanıma tutturamazsa: metni elle düzeltip gönderme alanı */
function yazDuzeltHtml(ham){
  return `<div class="vfix">
    <label class="vfix-l" for="v-fix">Tanıma yanlışsa düzeltip gönderin</label>
    <div class="vfix-r">
      <input type="text" id="v-fix" value="${esc(ham || '')}" autocomplete="off" aria-label="Komutu düzelt">
      <button class="btn" data-act="voice-yaz">Gönder</button>
    </div></div>`;
}

/* Sadece SORU ekranında (basılacak karar düğmesi yokken) kendiliğinden dinlemeye geçer.
   Onay ekranlarında geçmez; orada karar düğmesi ya da 🎤 Cevapla var. */
/* Ekran her değiştiğinde bilet artar; eski zamanlayıcı kendini geçersiz sayar. */
let ekranBilet = 0, soruZaman = null;

/* Onay ekranı açılırken: bekleyen dinleme zamanlayıcısını iptal et,
   arkada hala çalışan tanıyıcıyı sessizce durdur (ekranı ezmesin). */
function ekranKilitle(){
  ekranBilet++;
  if (soruZaman){ clearTimeout(soruZaman); soruZaman = null; }
  sesIptal = true; sesBitti = true;
  try { sesTanir && sesTanir.abort(); } catch(e){}
  sesTanir = null;
  const el = vEl(); if (el) el.classList.remove('dinliyor');
}

function soruSor(){
  soruTur++;
  if (soruTur > SORU_TUR) return;                 /* döngüye girmesin */
  const bilet = ekranBilet;
  if (soruZaman) clearTimeout(soruZaman);
  soruZaman = setTimeout(() => {
    soruZaman = null;
    if (bilet !== ekranBilet) return;        /* ekran değişti — karışma */
    if (!V.acik) return;
    if (!document.querySelector('[data-act="voice-cevap"]')) return;
    sesCevapla();
  }, 700);
}

/* Onay ekranında sesle okunacak kısa özet */

function gunEtiket(gun, sabit){
  if (sabit) return 'sabit (takvim dışı)';
  if (!gun) return 'tarihsiz';
  return DAY_FULL[(fromIso(gun).getDay() + 6) % 7] + ' ' + shortDate(gun);
}

function komutOzet(o){
  const islem = String(o.islem || '');
  const sat = (e, v) => `<div><span>${e}</span><b>${esc(v)}</b></div>`;
  if (IT_ISLEM.includes(islem)){
    const x = (islem === 'is-bitir' || islem === 'is-sil') ? itIsBul(o.isId) : itTkfBul(o.isId);
    if (!x) return '';
    const ad = [x.musteri, x.proje].filter(Boolean).join(' · ');
    let h = `<div class="vsum">${sat('İşlem', ISLEM_AD[islem] || islem)}${sat('Kayıt', ad)}`;
    if (islem === 'is-bitir') h += sat('Sonuç', 'iş BİTTİ olur, bitiş tarihi bugün');
    if (islem === 'is-sil')   h += sat('Uyarı', 'iş listeden kaldırılır (durum: SİLİNDİ)');
    if (islem === 'teklif-gonderildi') h += sat('Yeni durum', 'GÖNDERİLDİ');
    if (islem === 'teklif-red'){
      const sb = (IT_RED_SEBEP.find(z => z[0] === String(o.sebep || 'DIGER')) || ['DIGER','Diğer'])[1];
      h += sat('Sebep', sb) + (o.metin ? sat('Not', o.metin) : '');
    }
    if (islem === 'teklif-kabul') h += sat('Sonuç', 'tutar formu açılır — meblağı sen yazarsın');
    return h + '</div>';
  }
  if (islem === 'ekran') return `<div class="vsum">${sat('Ekran', EKRAN_AD[o.hedef] || o.hedef)}</div>`;
  if (islem === 'sorgu') return `<div class="vsum">${sat('Sorgu', SORGU_AD[o.konu] || o.konu)}${o.arama ? sat('Aranan', o.arama) : ''}</div>`;
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
  if (islem === 'duzenle') h += sat('Eski metin', t.text || '') + sat('Yeni metin', o.metin || '');
  if (islem === 'is-degistir') h += sat('Yeni iş', komutIsAdi(o)) + sat('Eski iş', j ? jobLabel(j) : '—');
  if (islem === 'sabitle') h += sat('Sonuç', 'sabit panele taşınır');
  if (islem === 'sabit-kaldir') h += sat('Sonuç', 'tarihsiz listeye döner');
  return h + '</div>';
}

function komutIsAdi(o){
  { const g = genelListe().find(x => 'job:' + x.id === String(o.isId || '')); if (g) return g.ad; }
  if (String(o.isId || '').startsWith('tkf:')){
    const x = a42Teklif().find(z => 'tkf:' + z.id === o.isId);
    if (x) return [x.musteri, x.proje].filter(Boolean).join(' · ');
  }
  if (String(o.isId || '').startsWith('a42:')){
    const x = a42Devam().find(z => 'a42:' + z.is_id === o.isId);
    if (x) return [x.musteri, x.proje].filter(Boolean).join(' · ');
  } else {
    const j = jobById(String(o.isId || '').replace(/^job:/, ''));
    if (j) return jobLabel(j);
  }
  return o.isAd || '—';
}

/* isId → yerel iş kartı kimliği (kart yoksa açar) */
async function komutIsCoz(o){
  const id = String(o.isId || '');
  let jobId = null;
  if (id.startsWith('tkf:')){
    const tid = id.slice(4);
    const x = a42Teklif().find(z => String(z.id) === tid);
    jobId = tkfKimlik(tid);
    if (!jobById(jobId)){
      await S.store.setId('jobs', jobId, { customer: (x && x.musteri) || '', project: (x && x.proje) || '',
        archived: false, a42Id: '', tkfId: tid, teklif: true,
        ci: S.jobs.length % SWATCH.length, createdAt: Date.now() });
      ensureContact(x && x.musteri);
    }
  } else if (id.startsWith('a42:')){
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
  return jobId;
}

async function komutUygula(o, otomatik, sessiz){
  const islem = String(o.islem || 'ekle');
  if (islem === 'ekran')  return komutEkran(o);
  if (islem === 'sorgu')  return komutSorgu(o);
  if (IT_ISLEM.includes(islem)) return komutItUygula(o, islem);
  if (islem !== 'ekle') return komutHedefUygula(o, islem, sessiz);
  const jobId = await komutIsCoz(o);
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

/* ============ EKRAN AÇMA ============ */
function komutEkran(o){
  const tab = EKRAN_TAB[o.hedef];
  if (!tab){ vSet('Ekran anlaşılmadı', V.metin); return; }
  voiceKapat();
  if (tab === 'home') anaEkrana(); else { S.tab = tab; S.composer = null; render(); }
  note(EKRAN_AD[o.hedef] + ' açıldı.');
}

/* ============ SORGU — hiçbir kaydı değiştirmez, sadece okur ============ */
/* ARAMA EŞLEŞTİRME (Mert 23.09.2026)
   Eskiden tek parça alt-dizi araması vardı: "b111 eloksal" yazınca, satır metninde
   "B111-EL3 … Eloksal" gibi araya başka kelime girdiği için BULAMIYORDU.
   Artık: Türkçe harfler sadeleşir (ı→i, ş→s…), noktalama silinir, sorgu KELİMELERE
   bölünür ve HER kelimenin satırda geçmesi aranır (sıra önemsiz).
   Ayrıca kodlar için boşluk/tire/nokta atılmış hâli de denenir: "b111 el3" ↔ "B111-EL3". */
const araSade = t => String(t == null ? '' : t)
  .toLocaleLowerCase('tr')
  .replace(/ı/g,'i').replace(/ş/g,'s').replace(/ğ/g,'g')
  .replace(/ü/g,'u').replace(/ö/g,'o').replace(/ç/g,'c')
  .replace(/[^a-z0-9]+/g,' ').trim();
const araSik = t => araSade(t).replace(/ /g,'');          /* "b111 el3" → "b111el3" */
/* Türkçe ek aldığımız için ("süpürgelikten", "eloksaldan") PARÇA değil ÖN EK eşleşmesi;
   sayılar (ölçü, boy, RAL) TAM eşleşir — yoksa "01" sorgusu 100*12'deki "10012"ye,
   "6" sorgusu 60*9'a takılıyordu. (Mert 23.09.2026) */
function araUyar(alanlar, q){
  const hep = alanlar.join(' ');
  const kelime = araSade(hep).split(' ').filter(Boolean), sik = araSik(hep);
  const qs = araSade(q);
  if (!qs) return true;
  const qsik = araSik(qs);
  if (qsik.length >= 3 && sik.indexOf(qsik) >= 0) return true;   /* "sm 01" → "sm01" */
  return qs.split(' ').filter(Boolean).every(k => {
    const sayi = /^[0-9]+$/.test(k);
    for (const w of kelime){
      if (w === k) return true;
      if (sayi) continue;
      if (w.indexOf(k) === 0 || (k.indexOf(w) === 0 && w.length >= 3)) return true;
    }
    return k.length >= 4 && sik.indexOf(k) >= 0;                  /* tireli kod parçası */
  });
}
function sorguStok(q){
  const L = stokListe();
  if (!L.length) return { baslik:'Stok', bos:'Depo listesi henüz gelmemiş — bilgisayarda TERM → Muhasebe ekranını bir kez aç.' };
  const n = (q || '').trim();
  const bul = n ? L.filter(r => araUyar(stokAlanlar(r), n)) : L;
  if (!bul.length){
    /* hiç bulunamadıysa ilk kelimeyle yakın kayıtları öner */
    const ilk = araSade(n).split(' ')[0] || '';
    const yakin = ilk ? L.filter(r => araUyar(stokAlanlar(r), ilk)).slice(0, 8) : [];
    if (yakin.length) return {
      baslik: 'Stok · “' + q + '” bulunamadı',
      ust: [['Benzer ' + yakin.length + ' kayıt']],
      satir: yakin.map(r => [(r.k || '—'), [r.c, r.r, r.e].filter(Boolean).join(' · '),
        (+r.a || 0) + ' ad' + (r.kg ? ' · ' + (+r.kg).toLocaleString('tr-TR',{maximumFractionDigits:1}) + ' kg' : '')]),
      fazla: 0
    };
    return { baslik:'Stok', bos:'“' + q + '” için depoda kayıt yok.' };
  }
  const ad = bul.reduce((t, r) => t + (+r.a || 0), 0);
  const kg = bul.reduce((t, r) => t + (+r.kg || 0), 0);
  return {
    baslik: 'Stok' + (q ? ' · ' + q : ''),
    ust: [[bul.length + ' kalem', ad.toLocaleString('tr-TR') + ' adet',
           kg.toLocaleString('tr-TR', { maximumFractionDigits:1 }) + ' kg']],
    satir: bul.slice(0, 12).map(r => [
      (r.k || '—'),
      [r.c, r.r, r.e].filter(Boolean).join(' · '),
      (+r.a || 0) + ' ad' + (r.kg ? ' · ' + (+r.kg).toLocaleString('tr-TR', { maximumFractionDigits:1 }) + ' kg' : '')
        + ' · ' + (r.f === 'tars' ? 'TARS' : 'İZOFLEKS')
    ]),
    fazla: Math.max(0, bul.length - 12)
  };
}

function sorguMuhasebe(q){
  const L = muhListe();
  if (!L.length) return { baslik:'Muhasebe', bos:'Fatura listesi henüz gelmemiş — bilgisayarda TERM → Muhasebe ekranını bir kez aç.' };
  const n = (q || '').trim();
  const bul = n ? L.filter(r => araUyar([r.k, r.n, r.pr], n)) : L;
  if (!bul.length) return { baslik:'Muhasebe', bos:'“' + q + '” için fatura kaydı yok.' };
  const tut = r => (r.p && r.p !== 'TL') ? (r.tl != null ? +r.tl : 0) : (+r.v || 0);
  let gelen = 0, giden = 0, acikG = 0, acikL = 0;
  bul.forEach(r => {
    const v = tut(r);
    if (r.y === 'G'){ giden += v; if (!r.d) acikG += v; }
    else { gelen += v; if (!r.d) acikL += v; }
  });
  const tl = v => v.toLocaleString('tr-TR', { maximumFractionDigits:0 }) + ' ₺';
  return {
    baslik: 'Muhasebe' + (q ? ' · ' + q : ''),
    ust: [[bul.length + ' fatura', 'Giden ' + tl(giden), 'Gelen ' + tl(gelen)]],
    satir: [
      ['Ödenmemiş giden', 'bizim borcumuz', tl(acikG)],
      ['Ödenmemiş gelen', 'bizden alacak', tl(acikL)]
    ].concat(bul.slice(0, 8).map(r => [
      (r.k || '—'),
      (r.y === 'G' ? 'GİDEN' : 'GELEN') + (r.n ? ' · ' + r.n : ''),
      tl(tut(r)) + (r.d ? ' · ödendi' : ' · açık')
    ])),
    fazla: Math.max(0, bul.length - 8)
  };
}

function sorguIstakip(q){
  const n = (q || '').trim();
  const uy = x => !n || araUyar([x.musteri, x.proje], n);
  const isl = a42Devam().filter(uy), tkf = a42Teklif().filter(uy);
  if (!isl.length && !tkf.length){
    return { baslik:'İş Takip', bos: n ? ('“' + q + '” için açık iş ya da teklif yok.') : 'Açık iş ya da bekleyen teklif yok.' };
  }
  return {
    baslik: 'İş Takip' + (q ? ' · ' + q : ''),
    ust: [[isl.length + ' devam eden iş', tkf.length + ' bekleyen teklif']],
    satir: isl.slice(0, 6).map(x => ['İŞ', [x.musteri, x.proje].filter(Boolean).join(' · '), String(x.durum || 'DEVAM')])
      .concat(tkf.slice(0, 6).map(x => ['TEKLİF', [x.musteri, x.proje].filter(Boolean).join(' · '), String(x.durum || 'BEKLİYOR')])),
    fazla: Math.max(0, (isl.length - 6)) + Math.max(0, (tkf.length - 6))
  };
}

function komutSorgu(o){
  const konu = String(o.konu || '');
  const c = konu === 'stok' ? sorguStok(o.arama)
          : konu === 'muhasebe' ? sorguMuhasebe(o.arama)
          : konu === 'istakip' ? sorguIstakip(o.arama) : null;
  if (!c){ vSet('Sorgu anlaşılmadı', V.metin); return; }
  ekranKilitle();
  vSet(c.baslik, V.metin);
  const govde = document.getElementById('v-body');
  if (c.bos){
    govde.innerHTML = `<p class="vq">${esc(c.bos)}</p>`;
  } else {
    govde.innerHTML = '<div class="vsum">'
      + (c.ust || []).map(u => `<div><span>${esc(u[0])}</span><b>${esc(u.slice(1).join('  ·  '))}</b></div>`).join('')
      + (c.satir || []).map(r => `<div><span>${esc(r[0])}</span><b>${esc(r[1])}</b><i>${esc(r[2] || '')}</i></div>`).join('')
      + (c.fazla ? `<div><span>…</span><b>${c.fazla} kayıt daha</b></div>` : '')
      + '</div>';
  }
  document.getElementById('v-acts').innerHTML =
    '<button class="btn" data-act="voice-cevap">&#127908; Yeni soru</button>' +
    '<button class="btn primary" data-act="voice-close">Kapat</button>';
}



/* ===== DEPO ARAMASI — KONUŞMA DİLİ ↔ KOD KARŞILIKLARI (masaüstü TERM ile aynı) =====
   Kalemin kendi metni (kod/cins/detay/renk/ebat) zaten aranıyor; "eloksal", "pres",
   "ral 9016", "süpürgelik" kendiliğinden eşleşir. Bu tablo SADECE o metinde geçmeyen
   söylenişleri ekler: renk adları, Saray eloksal kartelası, ölçü/boy söylenişleri.
   Kod yapısı: <aile>-<profil>-<renk>-<boy>  (B11 renkte R öneki kullanır, B12 kullanmaz)
   Yeni kelime gerekirse sadece buraya ekle. (Mert 23.09.2026) */
const STOK_RENK_ES = {
  SM01:'eloksal saray kartela mat 01 mat01',
  SM02:'eloksal saray kartela mat 02 mat02',
  SM15:'eloksal saray kartela mat 15 mat15',
  SP21:'eloksal saray kartela parlak 21 parlak21',
  '7016':'antrasit antrasit gri koyu gri',
  '7021':'antrasit siyah gri koyu gri',
  '7039':'kuvars gri gri',
  '7047':'acik gri gri',
  '8019':'kahve kahverengi gri kahve',
  '9003':'beyaz sinyal beyazi',
  '9005':'siyah jet siyah',
  '9016':'beyaz trafik beyazi',
  EL:'eloksal naturel mat', PR:'pres presli', BO:'boyali boya', PL:'plastik'
};
function stokEkKelime(kod, renk, boy, ebat){
  const ek = [], K = String(kod || '').toUpperCase(), p = K.split('-');
  const seg = (p.length >= 3) ? p[p.length - 2] : '';
  const ral = seg.replace(/^R/, '');
  if (STOK_RENK_ES[seg]) ek.push(STOK_RENK_ES[seg]);
  if (ral !== seg && STOK_RENK_ES[ral]) ek.push(STOK_RENK_ES[ral]);
  if (/^R?\d{4}$/.test(seg)) ek.push('ral' + ral, 'ral ' + ral);
  const m = String(renk || '').match(/(\d{4})/);
  if (m){ if (STOK_RENK_ES[m[1]]) ek.push(STOK_RENK_ES[m[1]]); ek.push('ral' + m[1]); }
  if (+boy > 0) ek.push(boy + 'm', boy + ' metre', boy + 'lik', boy + ' metrelik');
  const g = String(ebat || '').split('*')[0];
  if (g) ek.push(g + 'lik');
  return ek.join(' ');
}
/* telefondaki satır alanları: k=kod c=cins d=detay r=renk e=ebat b=boy n=not f=firma */
function stokAlanlar(x){
  return [x.k, x.c, x.d, x.r, x.e, x.n, x.f, stokEkKelime(x.k, x.r, x.b, x.e)];
}


/* ═══════════════ KONUM (şantiye) ═══════════════
   Her işin (devam eden + bekleyen teklif) bir şantiye konumu olur. Dört kaynak:
     · telefonun GPS'i — fotoğraf eklerken ya da "Şu an buradayım" düğmesiyle
     · fotoğrafın EXIF GPS'i — SIKIŞTIRMADAN ÖNCE orijinal dosyadan okunur
       (canvas'ta yeniden kodlama EXIF'i siliyor, o yüzden sıra önemli)
     · elle yazılan adres / etiket
     · yapıştırılan Google Maps linki (koordinat ondan çıkarılır)
   Adres çözümü YOK — koordinat + harita linki + Mert'in yazdığı etiket yeter.
   Firestore'da 'konum' koleksiyonu; belge kimliği hedefin kendisi (is:… / tkf:…),
   böylece Apps Script'e ya da İş Takip sheet'ine dokunmak gerekmiyor.  (Mert 24.09.2026) */

const kisalt2 = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function konumAl(hedef){ return (S.konum || []).find(k => k.id === hedef) || null; }
const konumVar = hedef => !!konumAl(hedef);
function konumYaz(hedef, o){
  return S.store.setId('konum', hedef, { ...o, ts: Date.now() });
}
function konumSil(hedef){ return S.store.remove('konum', hedef); }
const konumLink = k => (k && k.lat != null)
  ? `https://www.google.com/maps/search/?api=1&query=${k.lat},${k.lon}` : '';
const konumYaz6 = n => (+n).toFixed(6);
function konumOzet(k){
  if (!k) return '';
  if (k.etiket) return k.etiket;
  return (k.lat != null) ? `${konumYaz6(k.lat)}, ${konumYaz6(k.lon)}` : '';
}
const KONUM_KAYNAK = { gps:'telefon GPS', exif:'fotoğraf', el:'elle', link:'harita linki' };

/* ---- telefonun GPS'i ---- */
function gpsOku(){
  return new Promise(res => {
    if (!navigator.geolocation) return res({ hata:'Bu tarayıcı konum vermiyor.' });
    navigator.geolocation.getCurrentPosition(
      p => res({ lat:p.coords.latitude, lon:p.coords.longitude, dogruluk:Math.round(p.coords.accuracy||0) }),
      e => res({ hata: e.code === 1 ? 'Konum izni verilmedi.'
               : e.code === 3 ? 'Konum alınamadı (zaman aşımı).' : 'Konum alınamadı.' }),
      { enableHighAccuracy:true, timeout:12000, maximumAge:60000 });
  });
}

/* ---- fotoğrafın EXIF GPS'i (sıkıştırmadan ÖNCE, orijinal dosyadan) ---- */
function exifKonum(file){
  return new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => { try { res(exifGps(new DataView(fr.result))); } catch(e){ res(null); } };
    fr.onerror = () => res(null);
    try { fr.readAsArrayBuffer(file.slice(0, 384 * 1024)); } catch(e){ res(null); }   /* EXIF dosyanın başında */
  });
}
function exifGps(v){
  if (v.byteLength < 16 || v.getUint16(0) !== 0xFFD8) return null;      /* JPEG değil */
  let o = 2;
  while (o + 4 < v.byteLength){
    if (v.getUint8(o) !== 0xFF) return null;
    const m = v.getUint8(o + 1);
    if (m === 0xDA || m === 0xD9) return null;                          /* görüntü verisi başladı */
    const len = v.getUint16(o + 2);
    if (m === 0xE1 && o + 10 < v.byteLength && v.getUint32(o + 4) === 0x45786966) return tiffGps(v, o + 10);
    o += 2 + len;
  }
  return null;
}
function tiffGps(v, t){
  if (t + 8 > v.byteLength) return null;
  const le = v.getUint16(t) === 0x4949;
  const u16 = p => v.getUint16(p, le), u32 = p => v.getUint32(p, le);
  if (u16(t + 2) !== 42) return null;
  const ifd = t + u32(t + 4);
  if (ifd + 2 > v.byteLength) return null;
  let gpsOff = 0;
  const n0 = u16(ifd);
  for (let i = 0; i < n0; i++){
    const e = ifd + 2 + i * 12;
    if (e + 12 > v.byteLength) break;
    if (u16(e) === 0x8825){ gpsOff = u32(e + 8); break; }
  }
  if (!gpsOff) return null;
  const g = t + gpsOff;
  if (g + 2 > v.byteLength) return null;
  const gn = u16(g);
  let latRef = '', lonRef = '', lat = null, lon = null;
  const derece = p => {                       /* 3 RATIONAL: derece, dakika, saniye */
    let s = 0;
    for (let k = 0; k < 3; k++){
      const num = u32(p + k * 8), den = u32(p + k * 8 + 4);
      s += (den ? num / den : 0) / Math.pow(60, k);
    }
    return s;
  };
  for (let i = 0; i < gn; i++){
    const e = g + 2 + i * 12;
    if (e + 12 > v.byteLength) break;
    const tag = u16(e), cnt = u32(e + 4);
    if (tag === 1 || tag === 3){ const c = String.fromCharCode(v.getUint8(e + 8)); if (tag === 1) latRef = c; else lonRef = c; }
    if ((tag === 2 || tag === 4) && cnt === 3){
      const p = t + u32(e + 8);
      if (p + 24 > v.byteLength) continue;
      if (tag === 2) lat = derece(p); else lon = derece(p);
    }
  }
  if (lat == null || lon == null || (!lat && !lon)) return null;
  if (latRef === 'S') lat = -lat;
  if (lonRef === 'W') lon = -lon;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/* ---- yapıştırılan metinden koordinat çıkar (Maps linki ya da "41.0082, 28.9784") ---- */
/* Kısaltılmış harita linki — İÇİNDE KOORDİNAT YOKTUR, çözmek için Google'a istek
   atmak gerekir, tarayıcı da CORS yüzünden buna izin vermez. Bunu ayrıca tanıyıp
   kullanıcıya ne yapacağını söylüyoruz, sessizce reddetmek yerine. (Mert 24.09.2026) */
function konumKisaLink(t){
  return /(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|maps\.google\.[a-z.]+\/(?:maps)?\?[^ ]*\bcid=)/i.test(String(t||''));
}

/* Derece-dakika-saniye: 41°00'29.7"N 28°58'42.1"E  (Google Maps bazen böyle gösterir) */
function konumDmsCoz(t){
  const re = /(\d{1,3})\s*°\s*(\d{1,2})\s*['\u2032]\s*([\d.]+)\s*["\u2033]?\s*([NSEWKGDB])/gi;
  const bul = []; let m;
  while ((m = re.exec(String(t||''))) && bul.length < 4){
    let v = (+m[1]) + (+m[2])/60 + (parseFloat(m[3])||0)/3600;
    const y = m[4].toUpperCase();
    if (y === 'S' || y === 'W' || y === 'B') v = -v;          /* B = batı */
    bul.push({ v, eksen: (y==='N'||y==='S'||y==='K'||y==='G') ? 'lat' : 'lon' });
  }
  if (bul.length < 2) return null;
  const la = bul.find(x=>x.eksen==='lat'), lo = bul.find(x=>x.eksen==='lon');
  if (!la || !lo) return null;
  return { lat: la.v, lon: lo.v };
}

/* Yapıştırılan metinden koordinat çıkar. Google Maps'in adres çubuğu linki, "koordinatı
   kopyala" çıktısı, paylaş metni, DMS ve düz "enlem, boylam" — hepsi kabul edilir. */
function konumMetinCoz(t){
  const s = decodeURIComponent2(String(t || ''));
  /* !3d!4d ÖNCE denenir: o, pin'in gerçek koordinatı. @... ise haritanın o anki
     merkezi — zoom/kaydırma ile kayabiliyor, ikisi aynı linkte farklı çıkabiliyor. */
  let m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)                 /* .../data=...!3d..!4d.. */
       || s.match(/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/)                 /* .../@41.00,28.97,17z */
       || s.match(/[?&](?:q|query|ll|sll|daddr|saddr|center|destination|api=1&query)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/i)
       || s.match(/\/(?:place|dir|search)\/(-?\d+\.\d+),\s*(-?\d+\.\d+)/i)
       || s.match(/(?:^|[^\d.-])(-?\d{1,2}\.\d{3,})\s*[,;]\s*(-?\d{1,3}\.\d{3,})(?![\d.])/)
       || s.match(/(?:^|[^\d.-])(-?\d{1,2}\.\d{3,})\s+(-?\d{1,3}\.\d{3,})(?![\d.])/);
  let lat, lon;
  if (m){ lat = parseFloat(m[1]); lon = parseFloat(m[2]); }
  else {
    const d = konumDmsCoz(s);
    if (!d) return null;
    lat = d.lat; lon = d.lon;
  }
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}
/* Link %2C / %40 gibi kaçışlarla gelebiliyor; bozuk kaçışta ham metne dön */
function decodeURIComponent2(s){
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch(e){ return s; }
}

/* ---- pencere ---- */
function konumAc(hedef, baslik){
  S.konumOv = { hedef, baslik: baslik || '', metin:'', etiket:'', bekle:false, hata:'' };
  render();
}
function konumKapat(){ S.konumOv = null; render(); }
function konumFormAl(){
  const o = S.konumOv; if (!o) return;
  const a = document.getElementById('kn-etiket'); if (a) o.etiket = a.value;
  const b = document.getElementById('kn-metin');  if (b) o.metin  = b.value;
}
async function konumSuAn(hedef, sessiz){
  const g = await gpsOku();
  if (g.hata){ if (!sessiz) note(g.hata); return null; }
  const eski = konumAl(hedef) || {};
  await konumYaz(hedef, { lat:g.lat, lon:g.lon, dogruluk:g.dogruluk, kaynak:'gps',
                          etiket: eski.etiket || '' });
  if (!sessiz) note(`Konum kaydedildi (±${g.dogruluk} m).`);
  return g;
}
async function konumKaydet(){
  konumFormAl();
  const o = S.konumOv; if (!o) return;
  const c = o.metin.trim() ? konumMetinCoz(o.metin) : null;
  if (o.metin.trim() && !c){
    o.hata = konumKisaLink(o.metin)
      ? 'Bu bir PAYLAŞ linki (maps.app.goo.gl) — içinde koordinat yok, hiçbir uygulama açamaz. '
        + 'Şunu yap: Maps\'te yere basılı tut → üstte çıkan koordinata dokun (panoya kopyalanır) → buraya yapıştır. '
        + 'Şantiyedeysen “Şu an buradayım” en kolayı.'
      : 'Koordinat okunamadı. "41.0677017, 29.0046451" biçiminde yapıştır; '
        + 'Maps adres çubuğundaki uzun adres ve 41°04\'03.7"N 29°00\'16.7"E biçimi de olur.';
    render(); return;
  }
  const eski = konumAl(o.hedef) || {};
  /* "Şu an buradayım" ile dolduysa kaynak GPS'tir — yapıştırılmış link değil */
  const gpsIle = c && o.sonGps && o.metin.trim() === o.sonGps;
  const yeni = { etiket: o.etiket.trim(), kaynak: gpsIle ? 'gps' : (c ? 'link' : 'el') };
  if (c){ yeni.lat = c.lat; yeni.lon = c.lon; if (gpsIle && o.sonDogruluk) yeni.dogruluk = o.sonDogruluk; }
  else if (eski.lat != null){ yeni.lat = eski.lat; yeni.lon = eski.lon; yeni.kaynak = eski.kaynak || 'el'; }
  if (yeni.lat == null && !yeni.etiket){ o.hata = 'Ya bir etiket yaz ya da koordinat/link ver.'; render(); return; }
  await konumYaz(o.hedef, yeni);
  S.konumOv = null; render(); note('Konum kaydedildi.');
}
async function konumOvGps(){
  const o = S.konumOv; if (!o) return;
  konumFormAl(); o.bekle = true; o.hata = ''; render();
  const g = await gpsOku();
  if (!S.konumOv) return;
  S.konumOv.bekle = false;
  if (g.hata){ S.konumOv.hata = g.hata; render(); return; }
  S.konumOv.metin = `${konumYaz6(g.lat)}, ${konumYaz6(g.lon)}`;
  S.konumOv.sonGps = S.konumOv.metin; S.konumOv.sonDogruluk = g.dogruluk;
  render();
}

function konumOverlay(){
  const o = S.konumOv; if (!o) return '';
  const k = konumAl(o.hedef), l = konumLink(k);
  return `<div class="itov" data-act="konum-kapat"><div class="itovk" data-act="it-ov-ic">
    <div class="itovb kn">Şantiye konumu</div>
    <div class="itovg">
      ${o.baslik ? `<p class="itovm">${esc(o.baslik)}</p>` : ''}
      ${k && k.lat != null ? `<div class="knsim">
          <span class="knk">${esc(konumYaz6(k.lat))}, ${esc(konumYaz6(k.lon))}</span>
          ${k.dogruluk ? `<span class="knd">±${k.dogruluk} m</span>` : ''}
          <span class="knd">${esc(KONUM_KAYNAK[k.kaynak] || '')}</span>
          <a class="knhar" href="${l}" target="_blank" rel="noopener">Haritada aç</a>
        </div>` : '<p class="vq">Bu iş için henüz konum yok.</p>'}
      <label class="itovn">Etiket (kat, blok, giriş…)
        <input id="kn-etiket" type="text" placeholder="ör. 3. kat koridor" value="${esc(o.etiket || (k && k.etiket) || '')}"></label>
      <label class="itovn">Koordinat
        <input id="kn-metin" type="text" inputmode="text" placeholder="41.0677017, 29.0046451" value="${esc(o.metin)}"></label>
      <p class="knipc">Maps'te yere <b>basılı tut</b> → üstte çıkan koordinata dokun (panoya kopyalanır) → buraya yapıştır.
        <b>Paylaş</b> linki (maps.app.goo.gl) olmaz — içinde koordinat yoktur.</p>
      ${o.hata ? `<p class="knhata">${esc(o.hata)}</p>` : ''}
      <div class="ftbtn-l">
        <button class="itbtn bl" data-act="konum-gps" ${o.bekle ? 'disabled' : ''}>${o.bekle ? 'Alınıyor…' : '&#9678; Şu an buradayım'}</button>
        <button class="itbtn ok" data-act="konum-kaydet">Kaydet</button>
      </div>
      <div class="itovf">
        ${k ? '<button class="itbtn rd" data-act="konum-sil">Konumu kaldır</button>' : ''}
        <button class="itbtn gr" data-act="konum-kapat">Kapat</button>
      </div>
    </div></div></div>`;
}

/* ============ FAZ 3: sesle depo hareketi (masaüstü TERM ile aynı) ============ */
const STOK_ISLEM = ['stok-giris', 'stok-cikis'];
const STOK_KALEM_ISLEM = ['stok-kalem-ac', 'stok-kalem-sil'];
let kalemBek = null;
let stokSecenek = null, stokBekKomut = null;

/* Söylenen ürün tarifini depo kaydına eşle */
function stokCoz(tarif, firma){
  let L = stokListe();
  const q = String(tarif || '').trim();
  if (firma) L = L.filter(r => r.f === firma);
  if (!q) return [];
  const sik = araSik(q);
  const tam = L.filter(r => araSik(r.k) === sik);
  if (tam.length) return tam;
  return L.filter(r => araUyar(stokAlanlar(r), q));
}
/* Söylenen miktarı depo birimine (boy/adet) çevir */
function stokMiktarCevir(r, miktar, birim){
  const m = +miktar || 0, b = String(birim || '').toLocaleLowerCase('tr');
  if (!m) return { adet: 0, not: '' };
  if (b === 'm' || b === 'metre' || b === 'mt'){
    if (+r.b > 0) return { adet: Math.round((m / (+r.b)) * 100) / 100, not: m + ' m ÷ ' + r.b + ' m boy' };
    return { adet: 0, hata: 'Bu kalemin boy uzunluğu tanımlı değil — metre adede çevrilemedi.' };
  }
  if (b === 'kg' || b === 'kilo'){
    const kgBoy = (+r.kg > 0 && +r.a > 0) ? (+r.kg / +r.a) : 0;
    if (kgBoy > 0) return { adet: Math.round((m / kgBoy) * 100) / 100, not: m + ' kg ÷ ' + kgBoy.toFixed(2) + ' kg/boy' };
    return { adet: 0, hata: 'Bu kalemin kg değeri tanımlı değil — kilo adede çevrilemedi.' };
  }
  return { adet: m, not: '' };
}
function stokAdi(r){ return [r.c, r.r, r.e].filter(Boolean).join(' · '); }

function komutStok(o, islem){
  const yon = (islem === 'stok-cikis') ? 'Çıkış' : 'Giriş';
  const firma = (o.stokFirma === 'tars' || o.stokFirma === 'izofleks') ? o.stokFirma : '';
  let aday = stokCoz(o.stokKod, firma);
  if (!aday.length && firma) aday = stokCoz(o.stokKod, '');
  const h = { yon, firma, aday, o, islem };

  if (!stokHam().length){
    vSet('Depo listesi yok', V.metin);
    document.getElementById('v-body').innerHTML =
      '<p class="vq">Depo listesi henüz gelmemiş — bilgisayarda <b>TERM → Muhasebe</b> ekranını bir kez aç.</p>';
    document.getElementById('v-acts').innerHTML = '<button class="btn primary" data-act="voice-close">Kapat</button>';
    return;
  }
  if (!aday.length){
    stokBekKomut = null;
    ekranKilitle();
    vSet('Kalem bulunamadı', V.metin);
    document.getElementById('v-body').innerHTML =
      `<p class="vq">“${esc(String(o.stokKod || ''))}” depoda bulunamadı. Ürün kodunu söyler misin —`
      + ' ya da bu kodu yeni kalem olarak açalım mı?</p>' + yazDuzeltHtml(V.metin);
    kalemBek = { tip: 'teklif', o };
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="voice-cevap">&#127908; Tekrar söyle</button>' +
      '<button class="btn" data-act="kalem-ac-teklif">&#10133; Yeni kalem aç</button>' +
      '<button class="btn ghost" data-act="voice-close">Kapat</button>';
    return;
  }
  if (aday.length > 1){
    stokSecenek = h;
    ekranKilitle();
    vSet('Hangi kalem?', V.metin);
    document.getElementById('v-body').innerHTML = '<div class="vsum">'
      + aday.slice(0, 8).map((r, i) =>
          `<div data-act="stok-sec" data-i="${i}" style="cursor:pointer"><span>${i + 1}</span>`
          + `<b>${esc(r.k)}</b><i>${esc([r.r, r.e].filter(Boolean).join(' · ') + ' · ' + (r.f === 'tars' ? 'TARS' : 'İZO'))}</i></div>`).join('')
      + '</div>'
      + (aday.length > 8 ? `<p class="vq">${aday.length - 8} kalem daha var — daha belirgin söyle.</p>` : '');
    document.getElementById('v-acts').innerHTML =
      '<button class="btn" data-act="voice-cevap">&#127908; Tarif et</button>' +
      '<button class="btn ghost" data-act="voice-close">Kapat</button>';
    return;
  }
  stokOnayAc(h, aday[0]);
}

function stokOnayAc(h, r){
  const c = stokMiktarCevir(r, h.o.stokMiktar, h.o.stokBirim);
  const sonra = Math.round(((+r.a || 0) + (h.yon === 'Çıkış' ? -1 : 1) * c.adet) * 100) / 100;
  const sat = (e, v, renk) => `<div><span>${e}</span><b${renk ? ` style="color:${renk}"` : ''}>${esc(v)}</b></div>`;
  const govde = '<div class="vsum">'
    + sat('İŞLEM', h.yon === 'Çıkış' ? 'DEPODAN ÇIKIŞ' : 'DEPOYA GİRİŞ', h.yon === 'Çıkış' ? '#9C3B2A' : '#2F6E52')
    + sat('KALEM', r.k + ' — ' + stokAdi(r))
    + sat('FİRMA', r.f === 'tars' ? 'TARS' : 'İZOFLEKS')
    + sat('MİKTAR', (h.o.stokMiktar || 0) + ' ' + (h.o.stokBirim || 'adet') + (c.not ? `  →  ${c.adet} boy (${c.not})` : ''))
    + sat('ŞU AN', (+r.a || 0) + ' boy' + (r.bek ? ` (bekleyen ${r.bek > 0 ? '+' : ''}${r.bek})` : ''))
    + sat('SONRA', sonra + ' boy', sonra < 0 ? '#9C3B2A' : '')
    + (h.o.metin ? sat('NOT', h.o.metin) : '')
    + '</div>'
    + (c.hata ? `<p class="vq" style="color:#9C3B2A">${esc(c.hata)}</p>` : '')
    + (sonra < 0 ? '<p class="vq" style="color:#9C3B2A">Dikkat: bakiye eksiye düşüyor.</p>' : '')
    + '<p class="vq">Kayıt bekleyen hareket listesine düşer; Excel\'e sonra işlenir.</p>';

  ekranKilitle();
  if (c.hata || !(c.adet > 0)){
    stokBekKomut = null;
    vSet(c.hata ? 'Miktar çevrilemedi' : 'Miktar anlaşılmadı', V.metin);
    document.getElementById('v-body').innerHTML = govde;
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="voice-cevap">&#127908; Tekrar söyle</button>' +
      '<button class="btn ghost" data-act="voice-close">Kapat</button>';
    return;
  }
  stokBekKomut = { h, r, adet: c.adet };
  vSet('Onay bekliyor', V.metin);
  document.getElementById('v-body').innerHTML = govde;
  document.getElementById('v-acts').innerHTML =
    `<button class="btn primary${h.yon === 'Çıkış' ? ' tehlike' : ''}" data-act="stok-kaydet">`
    + (h.yon === 'Çıkış' ? 'Çıkışı kaydet' : 'Girişi kaydet') + '</button>'
    + '<button class="btn" data-act="voice-cevap">&#127908; Cevapla</button>'
    + '<button class="btn ghost" data-act="voice-close">İptal</button>';
}

async function stokKaydet(){
  const b = stokBekKomut; if (!b) return;
  stokBekKomut = null;
  const { r, h } = b, d = new Date();
  const kayit = {
    tarih: ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear(),
    kod: r.k, firma: r.f || '', cins: r.c || '', renk: r.r || '', ebat: r.e || '', boy: (+r.b || 0),
    yon: h.yon, adetEtki: b.adet,
    soylenen: (+h.o.stokMiktar || 0), soylenenBirim: String(h.o.stokBirim || 'adet'),
    is: String(h.o.metin || ''), aciklama: '',
    islendi: false, kaynak: 'ses', cihaz: 'telefon',
    ts: Date.now(), metin: String(V.metin || '')
  };
  voiceKapat();
  const id = await S.store.add('stokHareket', kayit);
  S.tab = 'stok'; render();
  noteGeri(`${h.yon === 'Çıkış' ? 'Çıkış' : 'Giriş'} kaydedildi — ${r.k} ${b.adet} boy (bekleyen)`,
           () => S.store.remove('stokHareket', id));
}

/* ============ FAZ 3b — DEPO KALEMİ AÇMA / SİLME ============ */
function kalemNorm(o){
  const firma = (o.stokFirma === 'tars') ? 'tars' : 'izofleks';
  const kod = String(o.stokKod || '').trim().toLocaleUpperCase('tr').replace(/\s+/g, ' ');
  const boy = +o.kalemBoy || 0, kgm = +o.kalemKgm || 0, adet = +o.stokMiktar || 0;
  return { firma, kod,
    cins: String(o.kalemCins || '').trim(), detay: String(o.kalemDetay || '').trim(),
    ebat: String(o.kalemEbat || '').trim(), renk: String(o.kalemRenk || '').trim(),
    boy, kgm, adet,
    toplamkg: (kgm > 0 && boy > 0) ? Math.round(adet * boy * kgm * 10) / 10 : 0 };
}
function komutKalemAc(o){
  const k = kalemNorm(o);
  ekranKilitle();
  if (!k.kod){
    vSet('Kod gerekli', V.metin);
    document.getElementById('v-body').innerHTML =
      '<p class="vq">Yeni kalemin ürün kodunu söyler misin?</p>' + yazDuzeltHtml(V.metin);
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="voice-cevap">&#127908; Tekrar söyle</button>' +
      '<button class="btn ghost" data-act="voice-close">Kapat</button>';
    return;
  }
  const sik = araSik(k.kod);
  const mevcut = stokListe().filter(r => r.f === k.firma && araSik(r.k || '') === sik)[0];
  if (mevcut){
    kalemBek = null;
    vSet('Bu kalem zaten var', V.metin);
    document.getElementById('v-body').innerHTML =
      `<p class="vq">“${esc(k.kod)}” ${k.firma === 'tars' ? 'TARS' : 'İZOFLEKS'} deposunda zaten kayıtlı `
      + `(${esc(stokAdi(mevcut))} · ${(+mevcut.a || 0)} boy). Miktar değişecekse giriş/çıkış komutu kullan.</p>`;
    document.getElementById('v-acts').innerHTML = '<button class="btn ghost" data-act="voice-close">Kapat</button>';
    return;
  }
  const sat = (e, v, renk) => `<div><span>${e}</span><b${renk ? ` style="color:${renk}"` : ''}>${esc(v === '' || v == null ? '—' : v)}</b></div>`;
  kalemBek = { tip: 'yeni', k };
  vSet('Yeni kalem — onay bekliyor', V.metin);
  document.getElementById('v-body').innerHTML = '<div class="vsum">'
    + sat('İŞLEM', 'YENİ DEPO KALEMİ', '#2F6E52')
    + sat('KOD', k.kod) + sat('FİRMA', k.firma === 'tars' ? 'TARS' : 'İZOFLEKS')
    + sat('CİNS', k.cins) + sat('DETAY', k.detay)
    + sat('KESİT EBAT', k.ebat) + sat('RENK', k.renk)
    + sat('BOY', k.boy > 0 ? k.boy + ' m' : '') + sat('KG/M', k.kgm > 0 ? k.kgm : '')
    + sat('AÇILIŞ ADEDİ', k.adet + ' boy')
    + (k.toplamkg > 0 ? sat('TOPLAM KG', k.toplamkg) : '')
    + '</div>'
    + ((!k.cins || !k.boy) ? '<p class="vq" style="color:#9C3B2A">Cins ya da boy boş — Excel\'e işlerken tamamlaman gerekir.</p>' : '')
    + '<p class="vq">Kalem bekleyen listeye düşer; depoda hemen görünür.</p>';
  document.getElementById('v-acts').innerHTML =
    '<button class="btn primary" data-act="kalem-kaydet">Kalemi aç</button>' +
    '<button class="btn" data-act="voice-cevap">&#127908; Cevapla</button>' +
    '<button class="btn ghost" data-act="voice-close">İptal</button>';
}
function komutKalemSil(o){
  const firma = (o.stokFirma === 'tars' || o.stokFirma === 'izofleks') ? o.stokFirma : '';
  let aday = stokCoz(o.stokKod, firma);
  if (!aday.length && firma) aday = stokCoz(o.stokKod, '');
  ekranKilitle();
  if (!aday.length){
    kalemBek = null;
    vSet('Kalem bulunamadı', V.metin);
    document.getElementById('v-body').innerHTML =
      `<p class="vq">“${esc(String(o.stokKod || ''))}” depoda yok — silinecek bir şey bulamadım.</p>` + yazDuzeltHtml(V.metin);
    document.getElementById('v-acts').innerHTML =
      '<button class="btn primary" data-act="voice-cevap">&#127908; Tekrar söyle</button>' +
      '<button class="btn ghost" data-act="voice-close">Kapat</button>';
    return;
  }
  if (aday.length > 1){
    stokSecenek = { aday, o, islem: 'stok-kalem-sil' };
    vSet('Hangi kalem silinsin?', V.metin);
    document.getElementById('v-body').innerHTML = '<div class="vsum">'
      + aday.slice(0, 8).map((r, i) =>
          `<div data-act="kalem-sil-sec" data-i="${i}" style="cursor:pointer"><span>${i + 1}</span>`
          + `<b>${esc(r.k)}</b><i>${esc([r.r, r.e].filter(Boolean).join(' · ') + ' · ' + (r.f === 'tars' ? 'TARS' : 'İZO'))}</i></div>`).join('')
      + '</div>';
    document.getElementById('v-acts').innerHTML =
      '<button class="btn" data-act="voice-cevap">&#127908; Tarif et</button>' +
      '<button class="btn ghost" data-act="voice-close">Kapat</button>';
    return;
  }
  kalemSilAc(aday[0]);
}
function kalemSilAc(r){
  kalemBek = { tip: 'sil', r };
  ekranKilitle();
  const sat = (e, v) => `<div><span>${e}</span><b>${esc(v === '' || v == null ? '—' : v)}</b></div>`;
  vSet('Silme onayı', V.metin);
  document.getElementById('v-body').innerHTML = '<div class="vsum">'
    + '<div><span>İŞLEM</span><b style="color:#9C3B2A">KALEMİ TAMAMEN SİL</b></div>'
    + sat('KOD', r.k) + sat('FİRMA', r.f === 'tars' ? 'TARS' : 'İZOFLEKS')
    + sat('CİNS', [r.c, r.d].filter(Boolean).join(' · '))
    + sat('RENK / EBAT', [r.r, r.e].filter(Boolean).join(' · '))
    + sat('MEVCUT BAKİYE', (+r.a || 0) + ' boy')
    + '</div>'
    + ((+r.a || 0) !== 0 ? `<p class="vq" style="color:#9C3B2A">Dikkat: bakiyesi ${(+r.a || 0)} boy. Silersen bu stok kayıttan düşer.</p>` : '')
    + '<p class="vq">Excel\'e işlenene kadar geri alabilirsin.</p>';
  document.getElementById('v-acts').innerHTML =
    '<button class="btn primary tehlike" data-act="kalem-sil">Kalemi sil</button>' +
    '<button class="btn ghost" data-act="voice-close">Vazgeç</button>';
}
async function kalemKaydet(){
  const b = kalemBek; if (!b || b.tip !== 'yeni') return;
  kalemBek = null;
  const k = b.k, d = new Date();
  const kayit = { tip: 'yeni',
    tarih: ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear(),
    firma: k.firma, kod: k.kod, cins: k.cins, detay: k.detay, ebat: k.ebat, renk: k.renk,
    boy: k.boy, kgm: k.kgm, adet: k.adet, toplamkg: k.toplamkg, 'not': '',
    islendi: false, kaynak: 'ses', cihaz: 'telefon',
    ts: Date.now(), metin: String(V.metin || '') };
  voiceKapat();
  const id = await S.store.add('stokKalem', kayit);
  S.tab = 'stok'; render();
  noteGeri(`Yeni kalem açıldı — ${k.kod} (bekleyen)`, () => S.store.remove('stokKalem', id));
}
async function kalemSil(){
  const b = kalemBek; if (!b || b.tip !== 'sil') return;
  kalemBek = null;
  const r = b.r, d = new Date();
  const kayit = { tip: 'sil',
    tarih: ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear(),
    firma: r.f || '', kod: r.k, cins: r.c || '', detay: r.d || '', ebat: r.e || '', renk: r.r || '',
    boy: +r.b || 0, adet: +r.a || 0,
    islendi: false, kaynak: 'ses', cihaz: 'telefon',
    ts: Date.now(), metin: String(V.metin || '') };
  voiceKapat();
  const id = await S.store.add('stokKalem', kayit);
  S.tab = 'stok'; render();
  noteGeri(`Kalem silindi — ${r.k} (geri alınabilir)`, () => S.store.remove('stokKalem', id));
}

/* ============ İŞ TAKİP KAYDI — iş bitir/sil, teklif durumu ============ */
async function komutItUygula(o, islem){
  if (islem === 'is-bitir' || islem === 'is-sil'){
    const x = itIsBul(o.isId);
    if (!x){ vSet('İş bulunamadı', V.metin); return; }
    voiceKapat();
    S.tab = 'istakip'; render();
    /* itBitir/itSil kendi ayrıntılı onayını da gösterir (gerçekleşen maliyet / kâr) */
    if (islem === 'is-bitir') await itBitir(x.is_id); else await itSil(x.is_id);
    return;
  }
  const t = itTkfBul(o.isId);
  if (!t){ vSet('Teklif bulunamadı', V.metin); return; }
  const ad = [t.musteri, t.proje].filter(Boolean).join(' · ');
  if (islem === 'teklif-gonderildi'){
    voiceKapat(); S.tab = 'istakip'; render();
    await itTeklifDurum(t.id, 'GONDERILDI', 'Gönderildi — ' + ad);
    return;
  }
  if (islem === 'teklif-red'){
    const sebep = (IT_RED_SEBEP.some(z => z[0] === String(o.sebep || '')) ? String(o.sebep) : 'DIGER');
    voiceKapat(); S.tab = 'istakip'; render();
    await itKilit('tk:' + t.id, async () => {
      await a42Yaz({ fn:'teklif', id:t.id, durum:'RED', red_sebep:sebep, red_not:(o.metin || '') });
      await itSonra('Reddedildi — ' + ad);
    });
    return;
  }
  if (islem === 'teklif-kabul'){
    /* Para söz konusu: tutarı sesle yazmıyoruz — mevcut kabul formunu açıyoruz */
    voiceKapat();
    S.tab = 'istakip';
    S.itSec = String(t.id);
    S.itOv = { tip:'kabul', id:String(t.id), para:'TL', tutar:'' };
    render();
    note('Kabul formu açıldı — tutarı gir ve kaydet.');
    return;
  }
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
  } else if (islem === 'is-degistir'){
    const yeni = await komutIsCoz(o);
    if (!yeni){ vSet('İş bulunamadı', V.metin); return; }
    await S.store.update('tasks', t.id, { jobId: yeni });
    const jy = jobById(yeni);
    mesaj = 'Taşındı — ' + (jy ? jobLabel(jy) : '');
    geri = () => S.store.update('tasks', t.id, { jobId: eski.jobId });
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

/* ============ görev düzenleme penceresi ============ */
function editAc(id){
  const t = S.tasks.find(x => x.id === id);
  if (!t) return;
  S.edit = { id, text: t.text || '', jobId: t.jobId || '', day: t.day || '', pin: !!t.pin, done: !!t.done };
  editCiz();
}
function editKapat(){ S.edit = null; document.getElementById('edit-back')?.remove(); document.getElementById('editw')?.remove(); }

function editCiz(){
  document.getElementById('edit-back')?.remove();
  document.getElementById('editw')?.remove();
  const e = S.edit; if (!e) return;
  const j = jobById(e.jobId);
  const back = document.createElement('div'); back.id = 'edit-back'; back.dataset.act = 'edit-kapat';
  const w = document.createElement('div'); w.id = 'editw'; w.className = 'editw';
  w.setAttribute('role', 'dialog'); w.setAttribute('aria-label', 'Görevi düzenle');
  w.innerHTML = `
    <div class="ed-h"><b>Görevi düzenle</b><button class="pop-x" data-act="edit-kapat" aria-label="Kapat">×</button></div>
    <div class="ed-b">
      <label class="ed-l" for="e-text">Görev</label>
      <textarea id="e-text" rows="2" placeholder="Ne yapılacak?">${esc(e.text)}</textarea>

      <label class="ed-l">İş / başlık</label>
      <button type="button" class="jobpick${j ? '' : ' bos'}" data-act="edit-is">
        <span class="jp-nm">${j ? esc(jobLabel(j)) : 'İş / proje seç…'}</span>${ICON_LIST}</button>

      <label class="ed-l">Ne zaman</label>
      <div class="ed-row">
        <input type="date" id="e-day" value="${esc(e.pin ? '' : e.day)}" ${e.pin ? 'disabled' : ''} aria-label="Gün">
        <button class="btn" data-act="edit-tarihsiz" ${e.pin ? 'disabled' : ''}>Tarihsiz</button>
      </div>
      <div class="ed-row">
        <button class="btn${e.pin ? ' primary' : ''}" data-act="edit-sabit" aria-pressed="${e.pin}">
          ${e.pin ? '✓ Sabit (takvim dışı)' : 'Sabitle'}</button>
        <button class="btn${e.done ? ' primary' : ''}" data-act="edit-bitti" aria-pressed="${e.done}">
          ${e.done ? '✓ Bitti' : 'Bitti işaretle'}</button>
      </div>
    </div>
    <div class="ed-f">
      <button class="btn primary" data-act="edit-kaydet">Kaydet</button>
      <button class="btn" data-act="edit-kapat">Vazgeç</button>
      <button class="btn ghost ed-sil" data-act="edit-sil">Sil</button>
    </div>`;
  document.body.appendChild(back);
  document.body.appendChild(w);
  const ta = document.getElementById('e-text');
  if (ta){ ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch(err){} }
}

function editTopla(){
  if (!S.edit) return;
  const ta = document.getElementById('e-text'); if (ta) S.edit.text = ta.value;
  const de = document.getElementById('e-day'); if (de && !S.edit.pin) S.edit.day = de.value || '';
}

function editKaydet(){
  editTopla();
  const e = S.edit; if (!e) return;
  const t = S.tasks.find(x => x.id === e.id);
  if (!t){ editKapat(); return; }
  const metin = (e.text || '').trim();
  if (!metin){ note('Görev metni boş olamaz.'); return; }
  if (!e.jobId || !jobById(e.jobId)){ note('Önce bir iş / başlık seçin.'); return; }
  const eski = { text: t.text || '', jobId: t.jobId, day: t.day || '', pin: !!t.pin, done: !!t.done };
  S.store.update('tasks', e.id, { text: metin, jobId: e.jobId,
    day: e.pin ? '' : (e.day || ''), pin: !!e.pin, done: !!e.done });
  editKapat();
  render();
  noteGeri('Güncellendi — ' + kisalt(metin), () => S.store.update('tasks', e.id, eski));
}

/* ============ rehber penceresi ============ */
function openPicker(type, btn, gorev){
  const r = btn.getBoundingClientRect();
  S.picker = { type, q: '', all: false, gorev: gorev || null,
               rect: { top: r.bottom, right: r.right, left: r.left } };
  renderPicker();
}

/* Seçici bir görevden açıldıysa o görevin işini değiştir, değilse yeni görevin işini seç. */
function secimUygula(jobId){
  if (S.edit){ S.edit.jobId = jobId; closePicker(); editCiz(); return; }
  const gid = S.picker && S.picker.gorev;
  if (gid){
    const t = S.tasks.find(x => x.id === gid);
    const eski = t ? t.jobId : null;
    S.store.update('tasks', gid, { jobId });
    closePicker();
    render();
    const j = jobById(jobId);
    noteGeri('Taşındı — ' + (j ? jobLabel(j) : ''),
             () => { if (eski) S.store.update('tasks', gid, { jobId: eski }); });
    return;
  }
  secimUygula(jobId);
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
    /* A42'de gönderilmiş, henüz işe dönüşmemiş teklifler */
    const bekleyen = a42Teklif();
    const brow = x => `<div class="pop-row bkl"><button class="pop-pick" data-act="pop-choose" data-tkf="${esc(x.id)}" data-val="${esc(x.proje || '')}" data-cust="${esc(x.musteri || '')}">
      <span class="pop-nm">${esc(x.proje || x.musteri || 'İsimsiz teklif')}</span>
      <span class="pop-sub">${[x.musteri, String(x.durum) === 'KABUL' ? 'KABUL' : 'teklif verildi'].filter(Boolean).map(esc).join(' · ')}</span></button></div>`;
    const fb = a => a.filter(x => hit(x.proje) || hit(x.musteri));

    const genBlok = block('Genel · projeden bağımsız', fg(gen), grow, 20);
    let kalan = block('Devam eden işler · TERM', fa(devam), arow, CAP)
              + block('Bekleyen teklifler · TERM', fb(bekleyen), brow, CAP)
              + block('Uygulamada açılan işler', fj(yerel), jrow, 30)
              + block('Teklif arşivi', fp(teklif), trow, CAP);
    if (!devam.length){
      const url = getSetting('a42url');
      kalan = `<div class="pop-note">${url
        ? (S.a42.hata ? esc(S.a42.hata) : 'TERM\u2019de devam eden iş yok.')
        : 'TERM bağlantısı tanımlı değil — senkron penceresinden ekleyin.'}</div>` + kalan;
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
  secimUygula(id);
}

/* A42 teklifini iş kartına bağla (yoksa aç). Sabit kimlik → tek kart. */
async function teklifChoose(tkfId, proje, musteri){
  const id = tkfKimlik(tkfId);
  if (!jobById(id)){
    await S.store.setId('jobs', id, { customer: musteri || '', project: proje || '', archived: false,
      a42Id: '', tkfId: String(tkfId || ''), teklif: true,
      ci: S.jobs.length % SWATCH.length, createdAt: Date.now() });
    ensureContact(musteri);
    note('Teklif kartı açıldı — ' + (proje || musteri));
  }
  secimUygula(id);
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
  secimUygula(jobId);
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

/* ============ TERM ana ekran (kart ızgarası) ============ */
const TERM_KARTLAR = [
  { id:'gorev', ad:'Görev Takibi', ac:'Haftalık görevler · sesli komut', hazir:true,
    ikon:'<rect x="6" y="6" width="48" height="42" rx="6" fill="#EBF4FF" stroke="#3A7EBF" stroke-width="2"/><rect x="6" y="6" width="48" height="10" rx="6" fill="#3A7EBF"/><rect x="6" y="11" width="48" height="5" fill="#3A7EBF"/><line x1="17" y1="3" x2="17" y2="10" stroke="#1F3864" stroke-width="2.6" stroke-linecap="round"/><line x1="43" y1="3" x2="43" y2="10" stroke="#1F3864" stroke-width="2.6" stroke-linecap="round"/><path d="M14 27.5 L17.5 31 L23.5 24" fill="none" stroke="#276749" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><line x1="28" y1="28" x2="47" y2="28" stroke="#1F3864" stroke-width="1.9" stroke-linecap="round"/>' },
  { id:'muh', ad:'Muhasebe', ac:'Gelen · giden faturalar, ödeme durumu', hazir:true,
    ikon:'<rect x="6" y="4" width="37" height="46" rx="4" fill="#EBF4FF" stroke="#3A7EBF" stroke-width="2"/><line x1="12" y1="13" x2="37" y2="13" stroke="#3A7EBF" stroke-width="1.8" stroke-linecap="round"/><line x1="12" y1="20" x2="31" y2="20" stroke="#3A7EBF" stroke-width="1.4" stroke-linecap="round" opacity=".55"/><line x1="12" y1="26" x2="34" y2="26" stroke="#3A7EBF" stroke-width="1.4" stroke-linecap="round" opacity=".55"/><line x1="12" y1="40" x2="37" y2="40" stroke="#1F3864" stroke-width="1.8" stroke-linecap="round"/><circle cx="46" cy="37" r="12.5" fill="#276749"/><path d="M42 37 L45 40 L51 33" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' },
  { id:'istakip', ad:'İş Takip', ac:'Devam eden işler · bekleyen teklifler', hazir:true,
    ikon:'<rect x="3" y="12" width="15" height="30" rx="3" fill="#EBF4FF" stroke="#3A7EBF" stroke-width="1.8"/><rect x="22" y="12" width="15" height="30" rx="3" fill="#F0FFF4" stroke="#276749" stroke-width="1.8"/><path d="M25.5 27.5 L28.5 30.5 L34 24" fill="none" stroke="#276749" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="41" y="12" width="15" height="30" rx="3" fill="#FAF5FF" stroke="#805AD5" stroke-width="1.8"/>' },
  { id:'stok', ad:'Stok', ac:'Depo bakiyesi · arama', hazir:true,
    ikon:'<rect x="6" y="20" width="48" height="30" rx="3" fill="#EBF4FF" stroke="#3A7EBF" stroke-width="2"/><path d="M6 20 L14 8 L46 8 L54 20 Z" fill="#3A7EBF" opacity=".85"/><rect x="24" y="20" width="12" height="9" rx="1.5" fill="#1F3864"/>' },
  { id:'musteri', ad:'Müşteri', ac:'Kişi · firma · mail rehberi', hazir:false,
    ikon:'<rect x="4" y="6" width="52" height="42" rx="5" fill="#EBF4FF" stroke="#3A7EBF" stroke-width="2"/><rect x="4" y="6" width="52" height="8" rx="5" fill="#3A7EBF"/><circle cx="18" cy="26" r="5" fill="#3A7EBF" opacity=".85"/><path d="M10 40 Q10 32 18 32 Q26 32 26 40 Z" fill="#3A7EBF" opacity=".55"/><line x1="32" y1="23" x2="50" y2="23" stroke="#1F3864" stroke-width="2" stroke-linecap="round"/>' },
  { id:'poz', ad:'Poz Oluştur', ac:'Bölme · kapı kasası · süpürgelik', hazir:false,
    ikon:'<rect x="4" y="6" width="52" height="42" rx="5" fill="#EBF4FF" stroke="#3A7EBF" stroke-width="2"/><rect x="4" y="6" width="52" height="8" rx="5" fill="#3A7EBF"/><rect x="11" y="22" width="8" height="8" rx="2" fill="#3A7EBF" opacity=".75"/><line x1="24" y1="24" x2="48" y2="24" stroke="#1F3864" stroke-width="1.8" stroke-linecap="round"/>' },
  { id:'proje', ad:'Proje Oluştur', ac:'Yeni müşteri projesi', hazir:false,
    ikon:'<path d="M6 18 Q6 12 12 12 L26 12 L30 18 L54 18 Q58 18 58 22 L58 48 Q58 52 54 52 L6 52 Q2 52 2 48 L2 22 Q2 18 6 18 Z" fill="#EBF4FF" stroke="#3A7EBF" stroke-width="2"/><line x1="12" y1="29" x2="48" y2="29" stroke="#3A7EBF" stroke-width="1.8" stroke-linecap="round"/><line x1="12" y1="37" x2="48" y2="37" stroke="#3A7EBF" stroke-width="1.8" stroke-linecap="round"/>' },
  { id:'birim', ad:'Birim Maliyet', ac:'Profil ve cam birim fiyatları', hazir:false,
    ikon:'<rect x="4" y="4" width="52" height="46" rx="7" fill="#EBF4FF" stroke="#3A7EBF" stroke-width="2"/><circle cx="16" cy="22" r="10" fill="#3A7EBF"/><circle cx="30" cy="22" r="10" fill="#2C7A7B"/><circle cx="44" cy="22" r="10" fill="#276749"/>' }
];

function homeView(){
  const gorevN = S.tasks.filter(t => !t.done).length;
  const muhN = muhListe().length;
  let h = '<div class="hmwrap"><h2 class="hm-h">Ne yapmak istiyorsun?</h2><div class="hmgrid">';
  TERM_KARTLAR.forEach(k => {
    const rozet = k.id === 'gorev' && gorevN ? `<span class="hm-b">${gorevN}</span>`
                : k.id === 'muh' && muhN ? `<span class="hm-b">${muhN}</span>` : '';
    h += `<button class="hmcard${k.hazir ? '' : ' dis'}" data-act="kart" data-v="${k.id}">
      ${rozet}<svg class="hm-ic" viewBox="0 0 60 54" aria-hidden="true">${k.ikon}</svg>
      <span class="hm-t">${esc(k.ad)}</span><span class="hm-d">${esc(k.ac)}</span>
      ${k.hazir ? '' : '<span class="hm-pc">bilgisayarda</span>'}</button>`;
  });
  h += '</div></div>';
  return h;
}

/* ============ Muhasebe (telefon) ============ */
function muhMeta(){ return S.muhasebe.find(d => d.id === 'meta') || null; }
function muhListe(){
  const p = S.muhasebe.filter(d => d.id !== 'meta' && Array.isArray(d.l))
    .sort((a, b) => (a.i || 0) - (b.i || 0));
  let out = [];
  p.forEach(d => { out = out.concat(d.l); });
  return out;
}
function muhTL(n){
  if (n == null || isNaN(n)) return '';
  const s = Math.abs(Number(n)).toFixed(2).split('.');
  return (Number(n) < 0 ? '-' : '') + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + s[1];
}
function muhGun(iso){
  if (!iso) return '—';
  const p = String(iso).split('-');
  return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso;
}
/* Muhasebe araması — ESKİDEN düz indexOf'tu: "gokay" yazınca "GÖKAY KORKMAZ" bulunmuyor,
   kelime sırası da bağlayıcıydı. Artık depo aramasıyla aynı sadeleştirme (ı→i, ö→o, ş→s…),
   kelime sırası önemsiz, fatura no gibi kodlar için boşluksuz hâli de denenir.
   Sayılar burada TAM eşleşme aranmaz (depodan farkı): fatura numarasının bir parçasını
   yazabilelim diye. (Mert 24.09.2026) */
function muhAraUyar(alanlar, q){
  const hep = alanlar.filter(Boolean).join(' ');
  const sade = araSade(hep), sik = araSik(hep);
  const kel = araSade(q).split(' ').filter(Boolean);
  if (!kel.length) return true;
  return kel.every(k => sade.indexOf(k) >= 0 || sik.indexOf(k) >= 0);
}
function muhSuz(){
  const q = (S.muh.ara || '').trim();
  return muhListe().filter(r => {
    if (S.muh.yon && r.y !== S.muh.yon) return false;
    const _d = muhDurum(r);
    if (S.muh.odeme === 'odendi' && !(_d === 'o' || _d === 't')) return false;
    if (S.muh.odeme === 'oneri'  && _d !== 'n') return false;
    if (S.muh.odeme === 'acik'   && _d) return false;
    if (q && !muhAraUyar([r.k, r.n, r.pr], q)) return false;
    return true;
  });
}
/* ── ELLE ÖDEME ONAYI — masaüstü TERM ile ORTAK (users/{uid}/odemeOnay) ───────────
   Muhasebe listesi masaüstünden gelen bir kopya; onayı listenin içine yazsaydık her
   gönderimde silinirdi. Bu yüzden onaylar ayrı bir koleksiyonda duruyor ve iki taraf
   da oraya yazıyor. Masaüstündeki karşılığı: onayKimlik/onayYaz. (Mert 24.09.2026) */
function onayKimlik(no){
  const t = String(no || '');
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  const slug = t.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return 'on-' + h.toString(36) + (slug ? '-' + slug : '');
}
function onayBul(no){
  if (!no) return null;
  return (S.odemeOnay || []).find(x => String(x.no || '') === String(no)) || null;
}
/* Satırın görünen ödeme durumu: elle onay, listeden gelen durumu EZER. */
function muhDurum(r){
  const el = onayBul(r.n);
  if (el && el.durum === 'onay') return 'o';
  if (el && el.durum === 'red')  return '';
  return r.d || '';
}
function muhRozet(r){
  const d = muhDurum(r), el = onayBul(r.n);
  const elle = el && el.durum === 'onay' ? '<i class="mrz-e">elle</i>' : '';
  const tik = r.n ? ` data-act="odeme-ac" data-no="${esc(r.n)}"` : '';
  const et = r.n ? 'button' : 'span';
  if (d === 'o') return `<${et} class="mrz ok"${tik}>&#10003; ödendi${elle}</${et}>`;
  if (d === 't') return `<${et} class="mrz tk"${tik}>&#8987; taksit</${et}>`;
  if (d === 'n') return `<${et} class="mrz on"${tik}>&#9203; öneri</${et}>`;
  if (d === 'p') return `<${et} class="mrz ks"${tik}>&#9686; kısmi</${et}>`;
  return `<${et} class="mrz yk"${tik} title="elle işaretlemek için dokun">—</${et}>`;
}

function odemeAc(no){
  const r = muhListe().find(x => String(x.n || '') === String(no));
  if (!r) return;
  S.odemeOv = { no, r }; render();
}
function odemeKapat(){ S.odemeOv = null; render(); }
async function odemeElle(no, karar){
  const id = onayKimlik(no), v = onayBul(no);
  try {
    if (karar === null){ if (v) await S.store.remove('odemeOnay', v.id); }
    else await S.store.setId('odemeOnay', id, { no, durum: karar, ts: Date.now(), kaynak: 'telefon' });
    S.odemeOv = null; render();
    note(karar === 'onay' ? 'Ödendi olarak işaretlendi.' : karar === 'red' ? 'Ödenmedi olarak işaretlendi.' : 'Elle kayıt silindi.');
  } catch(e){ note('Kaydedilemedi: ' + (e && e.message ? e.message : 'bağlantı hatası')); }
}
function odemeOverlay(){
  const o = S.odemeOv; if (!o) return '';
  const r = o.r, el = onayBul(o.no);
  const dv = (r.p && r.p !== 'TL' && r.tl != null) ? ` (${muhTL(r.tl)} ₺)` : '';
  return `<div class="itov" data-act="odeme-kapat"><div class="itovk" data-act="it-ov-ic">
    <div class="itovb ml">Ödeme durumu</div>
    <div class="itovg">
      <p class="itovm"><b>${esc(r.k || '')}</b><br>${esc(r.n || '')} · ${esc(muhGun(r.t))}</p>
      <div class="mlkl"><div class="mlk"><span>Tutar</span><b>${muhTL(r.v)} ${r.p === 'TL' ? '₺' : esc(r.p || '')}${dv}</b></div>
        <div class="mlk"><span>Durum</span><b>${muhDurum(r) === 'o' ? 'Ödendi' : muhDurum(r) === 't' ? 'Taksitli' : muhDurum(r) === 'n' ? 'Öneri bekliyor' : 'Ödenmemiş'}</b></div></div>
      ${el ? `<p class="mlkur">Bu satırı <b>elle</b> sen işaretledin${el.kaynak ? ' (' + esc(el.kaynak === 'telefon' ? 'telefon' : 'bilgisayar') + ')' : ''}. Bilgisayardaki TERM'de de böyle görünür.</p>`
           : '<p class="mlkur">Elle işaretlersen bilgisayardaki TERM\'de de aynı görünür. Banka eşleşmesine dokunulmaz.</p>'}
      <div class="ftbtn-l">
        <button class="itbtn ok" data-act="odeme-onay">&#10003; Ödendi işaretle</button>
        <button class="itbtn rd" data-act="odeme-red">Ödenmedi işaretle</button>
      </div>
      <div class="itovf">
        ${el ? '<button class="itbtn gr" data-act="odeme-sil">Elle kaydı sil</button>' : ''}
        <button class="itbtn gr" data-act="odeme-kapat">Kapat</button>
      </div>
    </div></div></div>`;
}
function muhView(){
  const meta = muhMeta();
  if (!meta && !muhListe().length){
    return `<div class="mbos"><h3>Muhasebe verisi yok</h3>
      <p>Fatura listesi bilgisayardaki TERM'den gönderilir. Bilgisayarda
      <b>TERM → Muhasebe</b> ekranını bir kez aç; liste buraya düşer.</p>
      <p class="mbos-n">Tutarlar yalnızca senin hesabına yazılır, uygulamanın
      açık kaynak dosyalarında durmaz.</p></div>`;
  }
  const L = muhSuz();
  let gelen = 0, giden = 0, acik = 0;
  L.forEach(r => {
    const v = (r.p && r.p !== 'TL') ? (r.tl != null ? r.tl : null) : r.v;
    if (v == null) return;
    if (r.y === 'G') giden += v; else gelen += v;
    if (!muhDurum(r)) acik += v;      /* elle işaretlenen artık açık sayılmaz */
  });
  const gor = L.slice(0, S.muh.limit);
  let h = '<div class="mwrap">';
  h += `<div class="mfilt">
    <div class="mseg">
      <button class="msg${S.muh.yon === '' ? ' on' : ''}" data-act="muh-f" data-k="yon" data-v="">Hepsi</button>
      <button class="msg${S.muh.yon === 'L' ? ' on' : ''}" data-act="muh-f" data-k="yon" data-v="L">Gelen</button>
      <button class="msg${S.muh.yon === 'G' ? ' on' : ''}" data-act="muh-f" data-k="yon" data-v="G">Giden</button>
    </div>
    <div class="mseg">
      <button class="msg${S.muh.odeme === '' ? ' on' : ''}" data-act="muh-f" data-k="odeme" data-v="">Tümü</button>
      <button class="msg${S.muh.odeme === 'acik' ? ' on' : ''}" data-act="muh-f" data-k="odeme" data-v="acik">Ödenmemiş</button>
      <button class="msg${S.muh.odeme === 'oneri' ? ' on' : ''}" data-act="muh-f" data-k="odeme" data-v="oneri">Öneri</button>
    </div>
    <input class="mara" id="m-ara" type="search" placeholder="Firma, fatura no, proje…" value="${esc(S.muh.ara)}">
  </div>`;
  h += `<div class="mstrip">
    <div class="mkut"><span>Kayıt</span><b>${L.length}</b></div>
    <div class="mkut g"><span>Giden</span><b>${muhTL(giden)} ₺</b></div>
    <div class="mkut l"><span>Gelen</span><b>${muhTL(gelen)} ₺</b></div>
    ${acik ? `<div class="mkut a"><span>Ödenmemiş</span><b>${muhTL(acik)} ₺</b></div>` : ''}
  </div>`;
  h += '<div class="mlist">';
  gor.forEach(r => {
    const dv = (r.p && r.p !== 'TL' && r.tl != null) ? `<em>${muhTL(r.tl)} ₺</em>` : '';
    h += `<div class="mrow ${r.y === 'G' ? 'gd' : 'gl'}">
      <div class="mr-1"><span class="myon ${r.y === 'G' ? 'g' : 'l'}">${r.y === 'G' ? 'GİDEN' : 'GELEN'}</span>
        <span class="mtar">${muhGun(r.t)}</span>${muhRozet(r)}</div>
      <div class="mr-2">${esc(r.k || '—')}</div>
      <div class="mr-3"><span class="mno">${esc(r.n || '')}</span>
        <span class="mtut">${muhTL(r.v)} ${r.p === 'TL' ? '₺' : esc(r.p || '')}${dv}</span></div>
      ${r.pr ? `<div class="mr-4">${esc(r.pr)}</div>` : ''}
    </div>`;
  });
  h += '</div>';
  if (L.length > gor.length)
    h += `<button class="mmore" data-act="muh-more">+${L.length - gor.length} fatura daha göster</button>`;
  if (meta && meta.guncelleme)
    h += `<p class="mnot">Son güncelleme ${muhGun(meta.guncelleme)}${meta.kapsam ? ' · ' + esc(meta.kapsam) : ''}
      · veri bilgisayardaki TERM'den gelir</p>`;
  h += '</div>';
  return h;
}

/* ============ İş Takip (telefon) ============ */
function paraYaz(v, birim){
  if (v == null || v === '' || isNaN(+v)) return '';
  const n = Math.abs(+v).toFixed(2).split('.');
  const g = n[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + n[1];
  const b = String(birim || '').toUpperCase();
  return (+v < 0 ? '-' : '') + (b === 'USD' ? '$' : b === 'EUR' ? '€' : '') + g + (b && b !== 'USD' && b !== 'EUR' ? ' ' + b : '');
}
function trTarih(v){
  const t = String(v || '').trim();
  if (!t) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(t)){ const p = t.slice(0,10).split('-'); return p[2]+'.'+p[1]+'.'+p[0]; }
  return t;
}
function isTakipView(){
  const acik = a42Devam(), tek = a42Teklif();
  let h = '<div class="itwrap">';
  if (S.a42.hata)
    h += `<div class="itnot">${esc(S.a42.hata)} <button class="itlink" data-act="a42-yenile">yeniden dene</button></div>`;
  if (!acik.length && !tek.length && !S.a42.hata && a42Bekliyor)
    h += `<div class="mbos"><h3>Yükleniyor…</h3>
      <p>TERM İş Takip tablosu okunuyor. Liste büyük olduğu için bu 15–25 saniye sürebilir.</p></div>`;
  else if (!acik.length && !tek.length && !S.a42.hata)
    h += `<div class="mbos"><h3>İş listesi boş</h3>
      <p>Devam eden iş ya da bekleyen teklif görünmüyor. Bağlantı ayarı Hesap ekranındaki
      <b>TERM bağlantısı</b> altında.</p>
      <button class="itlink" data-act="a42-yenile">Yenile</button></div>`;

  const topIs = acik.reduce((s, x) => s + (+x.sozlesme_usd || 0), 0);
  const topTk = tek.reduce((s, t) => s + (+t.tutar_usd || 0), 0);
  if (acik.length || tek.length){
    h += `<div class="mstrip">
      <div class="mkut g"><span>Devam eden iş</span><b>${acik.length}</b></div>
      <div class="mkut"><span>Sözleşme</span><b>${paraYaz(topIs,'USD')}</b></div>
      <div class="mkut l"><span>Bekleyen teklif</span><b>${tek.length}</b></div>
      <div class="mkut"><span>Teklif tutarı</span><b>${paraYaz(topTk,'USD')}</b></div>
    </div>`;
  }
  if (acik.length){
    h += '<h3 class="itbas">Devam eden işler</h3><div class="mlist">';
    acik.forEach(x => {
      const tut = x.sozlesme_tl ? paraYaz(x.sozlesme_tl, '') + ' ₺'
                : x.sozlesme_usd ? paraYaz(x.sozlesme_usd, 'USD') : '';
      const gorev = S.tasks.filter(t => t.jobId && !t.done &&
        (jobById(t.jobId) || {}).a42Id === x.is_id).length;
      const k = 'is:' + x.is_id, acikMi = S.itSec === k, mesgul = S.itMesgul === k;
      h += `<div class="mrow gd ${acikMi ? 'sec' : ''}" data-act="it-sec" data-k="${esc(k)}">
        <div class="mr-1"><span class="myon g">DEVAM</span>
          <span class="mtar">${esc(trTarih(x.baslangic))}</span>
          ${gorev ? `<span class="mrz on">${gorev} görev</span>` : ''}</div>
        <div class="mr-2">${esc(x.musteri || '')}</div>
        <div class="mr-3"><span class="mno">${esc(x.proje || '')}</span>
          <span class="mtut">${tut}</span></div>
        ${x.teslim ? `<div class="mr-4">Teslim: ${esc(trTarih(x.teslim))}</div>` : ''}
        ${acikMi ? `<div class="itact">
          <button class="itbtn fo" data-act="foto-panel" data-k="is:${esc(x.is_id)}" data-b="${esc((x.musteri||'') + (x.proje ? ' — ' + x.proje : ''))}">${ICON_CAM}Fotoğraf${fotoSayi('is:' + x.is_id) ? ' (' + fotoSayi('is:' + x.is_id) + ')' : ''}</button>
          <button class="itbtn kn${konumVar('is:' + x.is_id) ? ' var' : ''}" data-act="konum-panel" data-k="is:${esc(x.is_id)}" data-b="${esc((x.musteri||'') + (x.proje ? ' — ' + x.proje : ''))}">${ICON_PIN2}${konumVar('is:' + x.is_id) ? esc(kisalt2(konumOzet(konumAl('is:' + x.is_id)), 18)) : 'Konum'}</button>
          <button class="itbtn ml" data-act="mal-panel" data-id="${esc(x.is_id)}">${ICON_PIE}Maliyet</button>
          <button class="itbtn ok" data-act="it-bitir" data-id="${esc(x.is_id)}" ${mesgul ? 'disabled' : ''}>Bitir</button>
          <button class="itbtn rd" data-act="it-sil" data-id="${esc(x.is_id)}" ${mesgul ? 'disabled' : ''}>Sil</button>
          ${mesgul ? '<span class="itbek">kaydediliyor…</span>' : ''}
        </div>` : ''}
      </div>`;
    });
    h += '</div>';
  }
  if (tek.length){
    h += '<h3 class="itbas">Bekleyen teklifler</h3><div class="mlist">';
    tek.forEach(t => {
      const dur = String(t.durum || '');
      const k = 'tk:' + t.id, acikMi = S.itSec === k, mesgul = S.itMesgul === k;
      h += `<div class="mrow gl ${acikMi ? 'sec' : ''}" data-act="it-sec" data-k="${esc(k)}">
        <div class="mr-1"><span class="myon l">${esc(dur || 'TEKLİF')}</span>
          <span class="mtar">${esc(trTarih(t.tarih || t.guncelleme))}</span></div>
        <div class="mr-2">${esc(t.musteri || '')}</div>
        <div class="mr-3"><span class="mno">${esc(t.proje || '')}</span>
          <span class="mtut">${paraYaz(t.tutar_usd, 'USD')}</span></div>
        ${acikMi ? `<div class="itact">
          <button class="itbtn fo" data-act="foto-panel" data-k="tkf:${esc(t.id)}" data-b="${esc((t.musteri||'') + (t.proje ? ' — ' + t.proje : ''))}">${ICON_CAM}Fotoğraf${fotoSayi('tkf:' + t.id) ? ' (' + fotoSayi('tkf:' + t.id) + ')' : ''}</button>
          <button class="itbtn kn${konumVar('tkf:' + t.id) ? ' var' : ''}" data-act="konum-panel" data-k="tkf:${esc(t.id)}" data-b="${esc((t.musteri||'') + (t.proje ? ' — ' + t.proje : ''))}">${ICON_PIN2}${konumVar('tkf:' + t.id) ? esc(kisalt2(konumOzet(konumAl('tkf:' + t.id)), 18)) : 'Konum'}</button>
          ${dur === 'HAZIR' ? `<button class="itbtn bl" data-act="it-gonder" data-id="${esc(t.id)}" ${mesgul ? 'disabled' : ''}>Gönderildi</button>` : ''}
          ${(dur !== 'KABUL' && dur !== 'RED') ? `
            <button class="itbtn ok" data-act="it-kabul" data-id="${esc(t.id)}" ${mesgul ? 'disabled' : ''}>Kabul</button>
            <button class="itbtn rd" data-act="it-red" data-id="${esc(t.id)}" ${mesgul ? 'disabled' : ''}>Red</button>` : ''}
          ${mesgul ? '<span class="itbek">kaydediliyor…</span>' : ''}
        </div>` : ''}
      </div>`;
    });
    h += '</div>';
  }
  if (acik.length || tek.length)
    h += '<p class="mnot">Satıra dokun → işlemler açılır · '
       + `<button class="itlink" data-act="a42-yenile">yenile</button></p>`;
  h += itOverlay();
  h += '</div>';
  return h;
}

/* ---- İş Takip işlem pencereleri (Red sebebi / Kabul tutarı) ---- */
const IT_RED_SEBEP = [
  ['FIYAT',    'Fiyat yüksek'],
  ['RAKIP',    'Rakibe gitti'],
  ['SURE',     'Termin / süre uymadı'],
  ['KAPSAM',   'Kapsam değişti'],
  ['IPTAL',    'Proje iptal / ertelendi'],
  ['CEVAPSIZ', 'Cevap alınamadı'],
  ['DIGER',    'Diğer']
];

/* ═══════════════ FOTOĞRAF (saha / teslim / keşif) ═══════════════
   NEDEN BÖYLE: Firebase Storage Blaze planı (kredi kartı) istiyor. Ücretsiz planla
   çalışsın diye fotoğraf çekildiği anda tarayıcıda sıkıştırılıp Firestore'a yazılıyor.
   Firestore belge sınırı 1 MiB olduğu için iki parça hâlinde durur:
     foto/<id>     → hafif kayıt: 320 px önizleme + etiket + not + hedef  (abone olunur)
     fotoTam/<id>  → 1600 px tam boyut (SADECE bakarken tek belge olarak çekilir)
   Böylece liste anında açılır, veri yalnızca gerektiğinde iner.
   Hedef biçimi: is:<is_id> | tkf:<teklif id> | gorev:<task id> | stok:<hareket id>
   (Mert 24.09.2026) */
const FOTO_ETIKET = [
  ['kesif',  'Keşif',         '#3F6B8C'],
  ['once',   'Montaj öncesi', '#8A5A24'],
  ['montaj', 'Montaj',        '#96702B'],
  ['teslim', 'Teslim',        '#2F6E52'],
  ['hasar',  'Hasar / eksik', '#9C3B2A'],
  ['irsal',  'İrsaliye',      '#5B5FA6'],
  ['diger',  'Diğer',         '#7B858D']
];
const fotoEtiketAd = k => (FOTO_ETIKET.find(e => e[0] === k) || [,'',''])[1];
const fotoEtiketRenk = k => (FOTO_ETIKET.find(e => e[0] === k) || [,,'#7B858D'])[2];

const FOTO_SINIR = 700 * 1024;        /* base64 üst sınırı — 1 MiB belge sınırına pay bırakır */
const FOTO_KADEME = [[1600,.72],[1600,.60],[1280,.60],[1024,.55],[800,.50]];

function fotoListe(hedef){
  return (S.foto || []).filter(f => f.hedef === hedef)
    .sort((a, b) => (+b.ts || 0) - (+a.ts || 0));
}
const fotoSayi = hedef => fotoListe(hedef).length;

/* EXIF dönüklüğü de uygulansın diye önce createImageBitmap, olmazsa <img> */
async function fotoGoruntu(file){
  if (window.createImageBitmap){
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch(e){}
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('görüntü açılamadı'));
      i.src = url;
    });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}
function fotoCiz(img, maxKenar, kalite){
  const uzun = Math.max(img.width, img.height);
  const o = uzun > maxKenar ? maxKenar / uzun : 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * o));
  c.height = Math.max(1, Math.round(img.height * o));
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', kalite);
}
async function fotoSikistir(file){
  const img = await fotoGoruntu(file);
  let tam = '';
  for (const [kenar, kal] of FOTO_KADEME){
    tam = fotoCiz(img, kenar, kal);
    if (tam.length <= FOTO_SINIR) break;
  }
  const kucuk = fotoCiz(img, 320, .62);
  const g = { tam, kucuk, w: img.width, h: img.height };
  try { img.close && img.close(); } catch(e){}
  return g;
}

async function fotoKaydet(hedef, file, etiket, notu){
  const s = await fotoSikistir(file);
  if (s.tam.length > 1000 * 1024) throw new Error('fotoğraf çok büyük, sıkıştırılamadı');
  const id = await S.store.add('fotoTam', { d: s.tam });
  await S.store.setId('foto', id, {
    hedef, kucuk: s.kucuk, etiket: etiket || '', not: notu || '',
    w: s.w, h: s.h, boyut: s.tam.length, ad: String(file.name || ''),
    ts: Date.now(), cihaz: 'telefon'
  });
  return id;
}
async function fotoSil(id){
  await S.store.remove('foto', id);
  try { await S.store.remove('fotoTam', id); } catch(e){}
}

/* ---- dosya seçici: her çağrıda yeni input, iOS'ta aynı dosya tekrar seçilebilsin ---- */
function fotoSec(kamera){
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = 'image/*'; i.multiple = !kamera;
    if (kamera) i.capture = 'environment';
    i.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(i);
    i.onchange = () => { const f = [...(i.files || [])]; i.remove(); res(f); };
    i.click();
  });
}

function fotoAc(hedef, baslik){
  S.fotoOv = { hedef, baslik: baslik || '', etiket: '', not: '', bekle: 0, goster: null, tam: null };
  render();
}
function fotoKapat(){ S.fotoOv = null; render(); }

async function fotoYukle(kamera){
  const o = S.fotoOv; if (!o) return;
  const dosyalar = await fotoSec(kamera);
  if (!dosyalar.length) return;
  const not = (document.getElementById('foto-not') || {}).value || '';
  o.not = not;
  o.bekle = dosyalar.length; render();
  let n = 0, hata = '';
  /* Konum: iş/teklif hedefinde ve henüz konum yoksa fotoğraftan yakala.
     EXIF sıkıştırmadan ÖNCE okunmalı — canvas'ta yeniden kodlama EXIF'i siliyor. */
  const konumHedef = /^(is|tkf):/.test(o.hedef) ? o.hedef : '';
  let konumBulundu = null;
  if (konumHedef && !konumVar(konumHedef)){
    for (const f of dosyalar){
      const e = await exifKonum(f);
      if (e){ konumBulundu = { ...e, kaynak:'exif' }; break; }
    }
  }
  for (const f of dosyalar){
    try { await fotoKaydet(o.hedef, f, o.etiket, not); n++; }
    catch(e){ hata = e.message || 'kaydedilemedi'; }
    if (S.fotoOv === o){ o.bekle = dosyalar.length - n; render(); }
  }
  if (konumHedef && !konumVar(konumHedef)){
    if (!konumBulundu){                                   /* EXIF yoksa telefonun GPS'ini dene */
      const g = await gpsOku();
      if (!g.hata) konumBulundu = { lat:g.lat, lon:g.lon, dogruluk:g.dogruluk, kaynak:'gps' };
    }
    if (konumBulundu){
      await konumYaz(konumHedef, { ...konumBulundu, etiket:'' });
      note(konumBulundu.kaynak === 'exif' ? 'Konum fotoğraftan alındı.' : 'Konum telefondan alındı.');
    }
  }
  if (S.fotoOv === o){ o.bekle = 0; o.not = ''; render(); }
  if (hata) note('Bazı fotoğraflar eklenemedi: ' + hata);
  else if (n) note(n + ' fotoğraf eklendi.');
}

/* Tam boyut sadece bakarken indirilir */
async function fotoGoster(id){
  const o = S.fotoOv; if (!o) return;
  o.goster = id; o.tam = null; render();
  try {
    const d = await S.store.getDoc('fotoTam', id);
    if (S.fotoOv === o && o.goster === id){ o.tam = (d && d.d) || ''; render(); }
  } catch(e){
    if (S.fotoOv === o){ o.tam = ''; render(); note('Fotoğraf açılamadı: ' + (e.message || '')); }
  }
}

function fotoOverlay(){
  const o = S.fotoOv;
  if (!o) return '';
  const L = fotoListe(o.hedef);
  if (o.goster){
    const f = L.find(x => x.id === o.goster) || {};
    return `<div class="ftov" data-act="foto-buyuk-kapat"><div class="ftbuyuk">
      ${o.tam === null ? '<div class="ftyuk">yükleniyor…</div>'
        : o.tam ? `<img src="${o.tam}" alt="">`
        : '<div class="ftyuk">açılamadı</div>'}
      <div class="ftbb">
        ${f.etiket ? `<span class="ftet" style="background:${fotoEtiketRenk(f.etiket)}">${esc(fotoEtiketAd(f.etiket))}</span>` : ''}
        <span class="ftbt">${esc(fotoGun(f.ts))}</span>
        ${f.not ? `<span class="ftbn">${esc(f.not)}</span>` : ''}
        <span style="flex:1"></span>
        <button class="itbtn rd" data-act="foto-sil" data-id="${esc(f.id || '')}">Sil</button>
        <button class="itbtn gr" data-act="foto-buyuk-kapat">Kapat</button>
      </div>
    </div></div>`;
  }
  return `<div class="itov" data-act="foto-kapat"><div class="itovk" data-act="it-ov-ic">
    <div class="itovb fo">Fotoğraflar${L.length ? ' · ' + L.length : ''}</div>
    <div class="itovg">
      ${o.baslik ? `<p class="itovm">${esc(o.baslik)}</p>` : ''}
      <div class="ftet-l">
        ${FOTO_ETIKET.map(e => `<button class="ftets${o.etiket === e[0] ? ' on' : ''}" data-act="foto-etiket" data-v="${e[0]}"
           style="${o.etiket === e[0] ? `background:${e[2]};border-color:${e[2]};color:#fff` : `color:${e[2]};border-color:${e[2]}`}">${e[1]}</button>`).join('')}
      </div>
      <label class="itovn">Not (opsiyonel) — yeni eklenen fotoğraflara işlenir
        <input id="foto-not" type="text" placeholder="ör. 3. kat koridor, cam takıldı" value="${esc(o.not || '')}"></label>
      <div class="ftbtn-l">
        <button class="itbtn bl" data-act="foto-cek" ${o.bekle ? 'disabled' : ''}>${ICON_CAM}Fotoğraf çek</button>
        <button class="itbtn gr" data-act="foto-galeri" ${o.bekle ? 'disabled' : ''}>Galeriden seç</button>
      </div>
      ${o.bekle ? `<p class="ftyuk2">${o.bekle} fotoğraf işleniyor…</p>` : ''}
      ${L.length ? `<div class="ftgrid">${L.map(f => `
        <button class="ftk" data-act="foto-ac" data-id="${esc(f.id)}">
          <img src="${f.kucuk}" alt="" loading="lazy">
          ${f.etiket ? `<span class="ftk-e" style="background:${fotoEtiketRenk(f.etiket)}">${esc(fotoEtiketAd(f.etiket))}</span>` : ''}
          <span class="ftk-t">${esc(fotoGun(f.ts))}</span>
        </button>`).join('')}</div>`
        : '<p class="ftbos">Henüz fotoğraf yok. Yukarıdan etiket seç, sonra çek.</p>'}
      <div class="itovf"><button class="itbtn gr" data-act="foto-kapat">Kapat</button></div>
    </div></div></div>`;
}
function fotoGun(ts){
  const d = new Date(+ts || 0);
  if (!(+ts)) return '';
  return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear();
}

/* ═══════════════ MALİYET PANOSU (masaüstü TERM ile aynı pano) ═══════════════
   Telefonda A42 kartı / poz verisi yok; bu yüzden masaüstündeki "MK alt kategoriler"
   ve "Kapsam — faturalandı ✓ / kalan" blokları YOK. Geri kalan bire bir:
   KPI kutuları → Teklife Göre kâr → Gerçekleşen kâr → pasta grafik → kategori çubukları.
   $ karşılıkları işin KİLİTLİ kuru (x.kur) ile — telefonda canlı kur yok. (Mert 24.09.2026) */
const MAL_RENK = { 'Cam':'#3A7EBF', 'Profil':'#6B46C1', 'Fason Boya':'#2C7A7B', 'Aksesuar':'#276749',
                   'Sarf Malzeme':'#C05621', 'İşçilik':'#B7791F', 'Diğer Kalemler':'#718096' };
/* Kategori SADECE faturanın kendi alanından okunur. Masaüstündeki fatura no → kategori
   tablosu (IZ_FATURA_MK) BİLEREK buraya taşınmadı: bu depo herkese açık, gerçek tedarikçi
   fatura numaraları dışarı çıkmasın. Kategorisi boş fatura "Atanmamış" olarak görünür ve
   panoda uyarı satırı çıkar — o da sheet'te kategoriyi doldurmayı hatırlatır. (Mert 24.09.2026) */
function malFaturaKat(f){ return f ? String(f.kategori || f.mk || '') : ''; }
/* İş kaydındaki MK bütçesi: '{"Cam":123,...}' metni ya da nesne */
function malButce(x){
  try {
    if (typeof x.mk_butce === 'string' && x.mk_butce) return JSON.parse(x.mk_butce);
    if (x.mk_butce && typeof x.mk_butce === 'object') return x.mk_butce;
  } catch(e){}
  return null;
}
const malUf = n => (+n || 0).toLocaleString('tr-TR', { maximumFractionDigits:0 });

function malAc(isId){ S.malOv = { isId, kat:'' }; render(); }
function malKapat(){ S.malOv = null; render(); }

/* Pasta dilimi (donut) — masaüstündeki _arc ile aynı geometri */
function malArc(a0, a1, col){
  const cx = 100, cy = 100, r = 92;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const big = (a1 - a0) > Math.PI ? 1 : 0;
  return `<path d="M${cx} ${cy} L${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${big} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z" fill="${col}"/>`;
}

function malOverlay(){
  const o = S.malOv; if (!o) return '';
  const x = (S.a42.isler || []).find(z => String(z.is_id || '') === String(o.isId));
  if (!x) return `<div class="itov" data-act="mal-kapat"><div class="itovk" data-act="it-ov-ic">
    <div class="itovb ml">Maliyet panosu</div>
    <div class="itovg"><p class="vq">İş kaydı bulunamadı.</p>
    <div class="itovf"><button class="itbtn gr" data-act="mal-kapat">Kapat</button></div></div></div></div>`;

  const fs  = (S.a42.faturalar || []).filter(f => String(f.is_id || '') === String(o.isId));
  const kur = +x.kur || 0;
  const sozUSD = +x.sozlesme_usd || 0, sozTL = +x.sozlesme_tl || 0;
  const sozIsTL = (String(x.sozlesme_para || '').toUpperCase() === 'TL' && sozTL > 0);
  const sozTLval  = sozIsTL ? sozTL : (kur > 0 ? sozUSD * kur : 0);
  const sozUSDval = sozIsTL ? (kur > 0 ? sozTL / kur : 0) : sozUSD;

  const gerTL = fs.reduce((s, f) => s + (+f.tutar_kdvharic || 0), 0);
  const mkB = malButce(x);
  const butceTL = mkB ? Object.keys(mkB).reduce((s, k) => s + (+mkB[k] || 0), 0) : 0;
  const malTL  = butceTL > 0 ? butceTL : (kur > 0 ? (+x.plan_maliyet_usd || 0) * kur : 0);
  const malUSD = butceTL > 0 ? (kur > 0 ? butceTL / kur : 0) : (+x.plan_maliyet_usd || 0);
  const gerUSD = kur > 0 ? gerTL / kur : 0;
  const oran = malTL > 0 ? (gerTL / malTL * 100) : null;

  const kpi = (l, v) => `<div class="mlk"><span>${l}</span><b>${v}</b></div>`;
  const kpiG = (l, v) => `<div class="mlk g"><span>${l}</span><b>${v}</b></div>`;

  let h = `<div class="itov" data-act="mal-kapat"><div class="itovk gen" data-act="it-ov-ic">
    <div class="itovb ml">Maliyet panosu</div>
    <div class="itovg">
      <p class="itovm"><b>${esc(x.musteri || '')}</b>${x.proje ? ' — ' + esc(x.proje) : ''}${x.baslangic ? ' · ' + esc(trTarih(x.baslangic)) : ''}</p>
      <div class="mlkl">
        ${kpi('Sözleşme', sozIsTL
            ? itTl(sozTLval) + ' ₺ <i class="mlsab">SABİT</i>' + (kur > 0 ? `<u>${malUf(sozUSDval)} $</u>` : '')
            : malUf(sozUSD) + ' $' + (kur > 0 ? `<u>${itTl(sozTLval)} ₺</u>` : ''))}
        ${kpi('Maliyet', (malUSD > 0 ? malUf(malUSD) + ' $' : '—') + (malTL > 0 ? `<u>${itTl(malTL)} ₺</u>` : ''))}
        ${kpi('Gerçekleşen', itTl(gerTL) + ' ₺' + (kur > 0 ? `<u>${malUf(gerUSD)} $</u>` : ''))}
        ${oran != null ? kpi('Gerç. / Maliyet', '%' + oran.toFixed(1)) : ''}
        ${kpi('Fatura', String(fs.length))}
      </div>`;

  if (kur > 0) h += `<p class="mlkur">Kilit kur <b>${kur.toFixed(2)}</b> — telefonda canlı kur yok, $ karşılıkları bu kurla.</p>`;

  /* ---- Teklife göre kâr (sözleşme ₺ vs MK bütçe ₺) ---- */
  const kar = itKar(sozTLval, malTL);
  if (kar){
    h += `<h4 class="mlbas">Teklife göre</h4><div class="mlkl k">
      ${kpi('Vergi', itTl(kar.vergi) + ' ₺')}
      ${kpi('KDV Farkı', itTl(kar.kdvFarki) + ' ₺')}
      ${kpi('Brüt Kar', itTl(kar.brutKar) + ' ₺')}
      ${kpi('Brüt Kar %', '%' + kar.brutKarPct.toFixed(1))}
      ${kpi('Net Kar %', '%' + kar.netKarPct.toFixed(1))}
      ${kpi('Net Kar', itTl(kar.netKar) + ' ₺')}
    </div>`;
  }
  /* ---- Gerçekleşen kâr — gelen faturalara göre ---- */
  const karG = (sozTLval > 0 && gerTL > 0) ? itKar(sozTLval, gerTL) : null;
  if (karG){
    h += `<h4 class="mlbas g">Gerçekleşen · gelen ${fs.length} faturaya göre</h4><div class="mlkl k">
      ${kpiG('Vergi', itTl(karG.vergi) + ' ₺')}
      ${kpiG('KDV Farkı', itTl(karG.kdvFarki) + ' ₺')}
      ${kpiG('Brüt Kar', itTl(karG.brutKar) + ' ₺')}
      ${kpiG('Brüt Kar %', '%' + karG.brutKarPct.toFixed(1))}
      ${kpiG('Net Kar %', '%' + karG.netKarPct.toFixed(1))}
      ${kpiG('Net Kar', itTl(karG.netKar) + ' ₺')}
    </div>`;
  }

  /* ---- Gerçekleşen kategori dağılımı ---- */
  const gcat = {}, gcatFs = {};
  fs.forEach(f => {
    const k = String(malFaturaKat(f) || 'Atanmamış');
    gcat[k] = (gcat[k] || 0) + (+f.tutar_kdvharic || 0);
    (gcatFs[k] = gcatFs[k] || []).push(f);
  });
  const pieTot = Object.keys(gcat).reduce((s, k) => s + (+gcat[k] || 0), 0);

  if (pieTot > 0){
    const sira = Object.keys(mkB || {}).concat(Object.keys(gcat).filter(k => !mkB || !(k in mkB)));
    let a0 = -Math.PI / 2, dilim = '', lej = '';
    sira.forEach(cat => {
      const v = +gcat[cat] || 0; if (v <= 0) return;
      const frac = v / pieTot, cc = MAL_RENK[cat] || '#718096';
      let a1 = a0 + frac * 2 * Math.PI;
      if (frac > 0.9999) a1 = a0 + 2 * Math.PI - 0.0001;
      dilim += malArc(a0, a1, cc); a0 = a1;
      lej += `<div class="mllj"><span class="mlsw" style="background:${cc}"></span>
        <span class="mlljn">${esc(cat)}</span><b>${itTl(v)} ₺</b>
        <span class="mlljp">%${(frac * 100).toFixed(1)}</span></div>`;
    });
    h += `<div class="mlpasta">
      <svg viewBox="0 0 200 200">${dilim}<circle cx="100" cy="100" r="50" class="mlph"></circle>
        <text x="100" y="95" text-anchor="middle" class="mlpt">${malUf(pieTot)} ₺</text>
        <text x="100" y="112" text-anchor="middle" class="mlpa">gerçekleşen</text></svg>
      <div class="mllj-l"><div class="mlljb">Gerçekleşen — kategori dağılımı</div>${lej}</div>
    </div>`;
  }

  /* ---- Kategori bazlı tamamlanma ---- */
  if (mkB && Object.keys(mkB).length){
    h += `<h4 class="mlbas">Kategori bazlı tamamlanma <i>çubuğa dokun → faturalar</i></h4>`;
    Object.keys(mkB).forEach(cat => {
      const bud = +mkB[cat] || 0, sp = +gcat[cat] || 0;
      const pct = bud > 0 ? sp / bud * 100 : 0, cc = MAL_RENK[cat] || '#718096', asti = pct > 100;
      const acikMi = o.kat === cat;
      h += `<div class="mlcub" data-act="mal-kat" data-v="${esc(cat)}">
        <div class="mlcb"><span>${acikMi ? '&#9662;' : '&#9656;'} ${esc(cat)}</span>
          <span><b class="${asti ? 'ust' : ''}">%${pct.toFixed(1)}</b>
          <i>${itTl(sp)} / ${itTl(bud)} ₺</i></span></div>
        <div class="mlbar"><div style="width:${Math.min(pct, 100)}%;background:${asti ? '#C53030' : cc}"></div></div>
      </div>`;
      if (acikMi){
        const cf = gcatFs[cat] || [];
        h += `<div class="mldet">
          <div class="mldl"><div>Bütçe<b>${itTl(bud)} ₺</b></div><div>Gerçekleşen<b class="y">${itTl(sp)} ₺</b></div><div>Kalan<b class="${bud - sp < 0 ? 'ust' : ''}">${itTl(bud - sp)} ₺</b></div></div>`;
        h += cf.length
          ? '<ul class="mlful">' + cf.map(f => `<li>${esc(f.tedarikci || f.firma || f.gonderen || 'Fatura')}<b>${itTl(f.tutar_kdvharic)} ₺</b></li>`).join('') + '</ul>'
          : '<p class="mlbos">Henüz harcama yok.</p>';
        h += '</div>';
      }
    });
    const tp = malTL > 0 ? gerTL / malTL * 100 : 0;
    h += `<div class="mlcub top">
      <div class="mlcb"><span>TOPLAM</span><span><b>%${tp.toFixed(1)}</b><i>${itTl(gerTL)} / ${itTl(malTL)} ₺</i></span></div>
      <div class="mlbar b"><div style="width:${Math.min(tp, 100)}%;background:#1F3864"></div></div></div>`;
    if (gcat['Atanmamış'] > 0)
      h += `<p class="mluy">&#9888; ${itTl(gcat['Atanmamış'])} ₺ kategorisi atanmamış fatura var.</p>`;
  } else {
    h += `<p class="mluy2">Bu işin MK kategori bütçesi kayıtlı değil — bütçe/gerçekleşen kırılımı çıkarılamıyor.
      Masaüstü TERM'de işi açıp <b>Bütçe Revize</b> dersen buraya da gelir.</p>`;
  }

  h += `<div class="itovf"><button class="itbtn gr" data-act="mal-kapat">Kapat</button></div>
    </div></div></div>`;
  return h;
}

function itOverlay(){
  const o = S.itOv;
  if (!o) return '';
  const t = (S.a42.teklifler || []).find(x => String(x.id) === String(o.id)) || {};
  const bas = esc((t.musteri || '') + (t.proje ? ' — ' + t.proje : ''));
  if (o.tip === 'red'){
    return `<div class="itov" data-act="it-ov-kapat"><div class="itovk" data-act="it-ov-ic">
      <div class="itovb rd">Teklif reddedildi — sebep?</div>
      <div class="itovg">
        <p class="itovm">${bas}<br><span>${paraYaz(t.tutar_usd, 'USD')}</span></p>
        <div class="itovl">
          ${IT_RED_SEBEP.map(s => `<button class="itovs${o.sebep === s[0] ? ' on' : ''}" data-act="it-red-sec" data-v="${s[0]}">${s[1]}</button>`).join('')}
        </div>
        <label class="itovn">Not (opsiyonel)
          <input id="it-red-not" type="text" placeholder="ör. rakip %15 altında verdi" value="${esc(o.not || '')}"></label>
        <div class="itovf">
          <button class="itbtn gr" data-act="it-ov-kapat">Vazgeç</button>
          <button class="itbtn rd" data-act="it-red-kaydet" ${o.sebep ? '' : 'disabled'}>Reddet</button>
        </div>
      </div></div></div>`;
  }
  if (o.tip === 'kabul'){
    const sym = o.para === 'TL' ? '₺' : '$';
    const v = parseFloat(String(o.tutar || '').replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.'));
    const kdvli = v > 0 ? v * 1.20 : 0;
    return `<div class="itov" data-act="it-ov-kapat"><div class="itovk" data-act="it-ov-ic">
      <div class="itovb ok">Teklif kabul edildi — iş açılıyor</div>
      <div class="itovg">
        <p class="itovm">${bas}<br><span>teklif ${paraYaz(t.tutar_usd, 'USD')}</span></p>
        <div class="mseg itovp">
          <button class="msg${o.para === 'TL' ? ' on' : ''}" data-act="it-kabul-para" data-v="TL">₺ sabit</button>
          <button class="msg${o.para === 'USD' ? ' on' : ''}" data-act="it-kabul-para" data-v="USD">$ kur bazlı</button>
        </div>
        <label class="itovn">Kabul edilen meblağ (${sym}, KDV hariç) — boş bırakırsan teklif tutarı kullanılır
          <input id="it-kabul-tutar" type="text" inputmode="decimal" placeholder="0,00" value="${esc(o.tutar || '')}"></label>
        <p class="itovk2">${v > 0 ? `+ %20 KDV = <b>${itTl(kdvli)} ${sym}</b> (KDV dâhil)` : ''}</p>
        <div class="itovf">
          <button class="itbtn gr" data-act="it-ov-kapat">Vazgeç</button>
          <button class="itbtn ok" data-act="it-kabul-kaydet">İşi aç</button>
        </div>
      </div></div></div>`;
  }
  return '';
}

function itSayi(s){
  const v = parseFloat(String(s == null ? '' : s).replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(v) ? v : 0;
}
/* pencere yeniden çizilmeden önce yazılanları state'e al */
function itNotAl(){
  if (!S.itOv) return;
  const n = document.getElementById('it-red-not');    if (n) S.itOv.not = n.value;
  const t = document.getElementById('it-kabul-tutar'); if (t) S.itOv.tutar = t.value;
}
/* yazarken KDV satırını tazele — tam render yapmadan (odak kaybolmasın) */
document.addEventListener('input', (e) => {
  if (!S.itOv) return;
  if (e.target.id === 'it-red-not'){ S.itOv.not = e.target.value; return; }
  if (e.target.id === 'it-kabul-tutar'){
    S.itOv.tutar = e.target.value;
    const p = document.querySelector('.itovk2');
    if (!p) return;
    const v = itSayi(e.target.value), sym = S.itOv.para === 'TL' ? '₺' : '$';
    p.innerHTML = v > 0 ? `+ %20 KDV = <b>${itTl(v * 1.20)} ${sym}</b> (KDV dâhil)` : '';
  }
});

async function itKilit(k, isle){
  S.itMesgul = k; render();
  try { await isle(); }
  catch(err){
    S.itMesgul = ''; render();
    note('Kaydedilemedi: ' + (err && err.message ? err.message : 'bağlantı hatası'));
  }
}

/* İŞİ BİTİR — masaüstündeki gibi gelen faturalardan gerçekleşen maliyet/kâr */
async function itBitir(isId){
  const x = (S.a42.isler || []).find(z => String(z.is_id) === String(isId));
  if (!x){ note('İş bulunamadı.'); return; }
  const fs = (S.a42.faturalar || []).filter(f => String(f.is_id || '') === String(isId));
  const gerTL = fs.reduce((s, f) => s + (+f.tutar_kdvharic || 0), 0);
  const kur = +x.kur || 0, sozUSD = +x.sozlesme_usd || 0;
  const kar = (sozUSD > 0 && kur > 0 && gerTL > 0) ? itKar(sozUSD * kur, gerTL) : null;
  const p = { fn:'is', is_id:isId, durum:'BITTI', bitis:itBugun() };
  const ad = (x.musteri || '') + (x.proje ? ' — ' + x.proje : '');
  if (kar){
    const mUSD = +(gerTL / kur).toFixed(2), nkUSD = +(kar.netKar / kur).toFixed(2);
    if (!confirm(`“${ad}” işi GERÇEKLEŞEN değerlerle bitirilsin mi?\n(gelen ${fs.length} faturaya göre)\n\n`
      + `Gerçekleşen maliyet: ${itTl(gerTL)} ₺  (${itTl(mUSD)} $)\n`
      + `Brüt kâr: ${itTl(kar.brutKar)} ₺  (%${kar.brutKarPct.toFixed(1)})\n`
      + `Net kâr:  ${itTl(kar.netKar)} ₺  (%${kar.netKarPct.toFixed(1)})\n\n`
      + 'Not: maliyet artık BÜTÇE değil GERÇEKLEŞEN olur.')) return;
    p.gerceklesen_tl = gerTL;
    p.plan_maliyet_usd = mUSD;
    p.net_kar_usd = nkUSD;
    p.kar_yuzde = +kar.brutKarPct.toFixed(1);
    p['not'] = `Gerçekleşen | Kâr %${kar.brutKarPct.toFixed(1)} | Maliyet ${itTl(gerTL)} ₺ | Net kâr ${itTl(kar.netKar)} ₺ (%${kar.netKarPct.toFixed(1)})`;
  } else {
    const neden = gerTL <= 0 ? 'Bu işe ait fatura yok (gerçekleşen = 0).'
                             : 'Kur ya da sözleşme tutarı yok — gerçekleşen kâr hesaplanamıyor.';
    if (!confirm(`“${ad}”\n\n${neden}\nYine de bitirilsin mi? (Gerçekleşen değerler kaydedilmez.)`)) return;
  }
  await itKilit('is:' + isId, async () => {
    await a42Yaz(p);
    await itSonra('İş bitirildi');
  });
}

async function itSil(isId){
  const x = (S.a42.isler || []).find(z => String(z.is_id) === String(isId)) || {};
  const ad = (x.musteri || '') + (x.proje ? ' — ' + x.proje : '') || isId;
  if (!confirm(`“${ad}” işini silmek istediğine emin misin?\n(Listeden kaldırılır — durum: SİLİNDİ)`)) return;
  await itKilit('is:' + isId, async () => {
    await a42Yaz({ fn:'is', is_id:isId, durum:'SILINDI', bitis:'' });
    await itSonra('İş silindi');
  });
}

async function itTeklifDurum(id, durum, mesaj){
  await itKilit('tk:' + id, async () => {
    await a42Yaz({ fn:'teklif', id, durum });
    await itSonra(mesaj);
  });
}

async function itRedKaydet(){
  itNotAl();
  const o = S.itOv; if (!o || !o.sebep) return;
  const id = o.id, not = o.not || '';
  S.itOv = null;
  await itKilit('tk:' + id, async () => {
    await a42Yaz({ fn:'teklif', id, durum:'RED', red_sebep:o.sebep, red_not:not });
    await itSonra('Teklif reddedildi olarak kaydedildi');
  });
}

/* TEKLİFİ KABUL ET — iş kaydı açar, sonra teklifi KABUL'e çeker (masaüstüyle aynı sıra) */
async function itKabulKaydet(){
  itNotAl();
  const o = S.itOv; if (!o) return;
  const t = (S.a42.teklifler || []).find(x => String(x.id) === String(o.id));
  if (!t){ note('Teklif bulunamadı.'); return; }
  const para = o.para === 'USD' ? 'USD' : 'TL';
  const v = itSayi(o.tutar);
  const kabulTutar = v > 0 ? +v.toFixed(2) : null;
  const kabulKdvli = v > 0 ? +(v * 1.20).toFixed(2) : null;
  const sym = para === 'TL' ? '₺' : '$';
  const ad = (t.musteri || '') + (t.proje ? ' — ' + t.proje : '');
  const ozet = kabulTutar
    ? `Kabul edilen meblağ: ${itTl(kabulTutar)} ${sym} + %20 KDV = ${itTl(kabulKdvli)} ${sym}`
    : 'Kabul tutarı girilmedi — sözleşme teklif tutarı olarak açılacak.';
  if (!confirm(`“${ad}” teklifi KABUL edilip iş açılacak.\n\n${ozet}\n\nOnaylıyor musun?`)) return;

  const d = new Date();
  const isId = 'IS' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2)
             + '-' + Math.floor(Math.random() * 900 + 100);
  const sheetAdi = ((t.musteri || '').split(' ')[0].slice(0, 4) + '-' + (t.proje || '').slice(0, 12)).toUpperCase();
  let sozUsd = t.tutar_usd, sozTl = null, sozPara = 'USD';
  if (kabulTutar > 0){
    if (para === 'TL'){ sozTl = kabulTutar; sozPara = 'TL'; }
    else { sozUsd = kabulTutar; sozPara = 'USD'; }
  }
  const id = o.id;
  S.itOv = null;
  await itKilit('tk:' + id, async () => {
    await a42Yaz({ fn:'is', is_id:isId, teklif_id:id, baslangic:itBugun(),
      musteri:t.musteri, proje:t.proje, sheet_adi:sheetAdi,
      sozlesme_usd:sozUsd, sozlesme_tl:sozTl, sozlesme_para:sozPara,
      plan_maliyet_usd:t.maliyet_usd, mk_butce:t.mk_butce || '', durum:'DEVAM',
      kabul_tutar:kabulTutar, kabul_tutar_kdvli:kabulKdvli, kabul_para:kabulTutar ? para : null });
    await a42Yaz({ fn:'teklif', id, durum:'KABUL', is_id:isId,
      kabul_tutar:kabulTutar, kabul_tutar_kdvli:kabulKdvli, kabul_para:kabulTutar ? para : null });
    await itSonra('İş açıldı: ' + isId);
  });
}

/* ============ Stok (telefon) ============ */
function stokHam(){
  const d = S.stok.find(x => x.id === 'depo');
  return (d && Array.isArray(d.l)) ? d.l : [];
}
/* ---- FAZ 3: bekleyen depo hareketleri ----
   Depo verisinin kaynağı bilgisayardaki Izofleks-Des-Stok.xlsx; 'stok/depo' onun anlık
   görüntüsü. Sesle girilen hareket 'stokHareket'e bekleyen olarak düşer ve bakiyeye
   burada eklenir. Excel'e işlenip yeni anlık görüntü gelince damga ilerler ve
   o hareketler kendiliğinden düşer — elle işaretleme yok. */
function stokDamga(){
  const m = S.stok.find(x => x.id === 'meta');
  return (m && +m.damga) ? +m.damga : 0;
}
function stokBekleyen(){
  const d = stokDamga();
  return (S.stokHareket || []).filter(h => !h.islendi && (+h.ts || 0) > d)
    .sort((a, b) => (+b.ts || 0) - (+a.ts || 0));
}
function stokDelta(){
  const d = {};
  stokBekleyen().forEach(h => {
    const k = h.firma + '|' + h.kod;
    d[k] = (d[k] || 0) + ((h.yon === 'Çıkış' ? -1 : 1) * (+h.adetEtki || 0));
  });
  return d;
}
/* FAZ 3b: bekleyen KALEM işlemleri — yeni kalem / kalem silme */
function stokKalemBekleyen(){
  const d = stokDamga();
  return (S.stokKalem || []).filter(k => !k.islendi && (+k.ts || 0) > d)
    .sort((a, b) => (+b.ts || 0) - (+a.ts || 0));
}
function stokKalemUygula(L){
  const K = stokKalemBekleyen();
  if (!K.length) return L;
  const sil = {}, yeni = [];
  K.forEach(k => { if (k.tip === 'sil') sil[k.firma + '|' + k.kod] = k; else yeni.push(k); });
  let out = L.filter(r => !sil[(r.f || '') + '|' + (r.k || '')]);
  yeni.forEach(k => {
    if (out.some(r => r.f === k.firma && r.k === k.kod)) return;
    out.push({ f: k.firma, k: k.kod, c: k.cins || '', d: k.detay || '', e: k.ebat || '',
               r: k.renk || '', b: +k.boy || 0, a: +k.adet || 0, kg: +k.toplamkg || 0,
               n: k['not'] || '', yeni: true });
  });
  return out;
}
function stokListe(){
  const ham = stokKalemUygula(stokHam());
  const d = stokDelta(), bos = !Object.keys(d).length;
  if (bos) return ham;
  return ham.map(r => {
    const ek = +d[(r.f || '') + '|' + (r.k || '')] || 0;
    if (!ek) return r;
    const y = { ...r };
    y.a = Math.round(((+r.a || 0) + ek) * 100) / 100;
    if (+r.b > 0 && +r.kg > 0 && +r.a > 0) y.kg = Math.round((y.a / (+r.a)) * (+r.kg) * 10) / 10;
    y.bek = ek;
    return y;
  });
}
function stokSuz(){
  const q = (S.stk.ara || '').trim();
  return stokListe().filter(r => {
    if (S.stk.firma && r.f !== S.stk.firma) return false;
    if (q && !araUyar(stokAlanlar(r), q)) return false;   /* sesli komutla aynı eşleştirme */
    return true;
  });
}
function stokView(){
  const meta = S.stok.find(x => x.id === 'meta');
  if (!stokListe().length){
    return `<div class="mbos"><h3>Stok verisi yok</h3>
      <p>Depo listesi bilgisayardaki TERM'den gönderilir. Bilgisayarda
      <b>TERM → Muhasebe</b> ekranını bir kez aç — stok da birlikte gelir.</p></div>`;
  }
  const L = stokSuz(), gor = L.slice(0, S.stk.limit);
  const kg = L.reduce((s, r) => s + (+r.kg || 0), 0);
  const ad = L.reduce((s, r) => s + (+r.a || 0), 0);
  let h = '<div class="mwrap"><div class="mfilt"><div class="mseg">'
    + `<button class="msg${S.stk.firma === '' ? ' on' : ''}" data-act="stk-f" data-k="firma" data-v="">Hepsi</button>`
    + `<button class="msg${S.stk.firma === 'izofleks' ? ' on' : ''}" data-act="stk-f" data-k="firma" data-v="izofleks">İzofleks</button>`
    + `<button class="msg${S.stk.firma === 'tars' ? ' on' : ''}" data-act="stk-f" data-k="firma" data-v="tars">TARS</button>`
    + '</div>'
    + `<input class="mara" id="s-ara" type="search" placeholder="Kod, cins, renk, ebat…" value="${esc(S.stk.ara)}">`
    + '</div>';
  /* FAZ 3: Excel'e işlenmemiş hareketler */
  const bek = stokBekleyen();
  if (bek.length){
    h += `<div class="sbek"><div class="sbek-h">EXCEL'E İŞLENMEMİŞ HAREKET (${bek.length})</div>`
      + bek.slice(0, 10).map(x => {
          const cik = x.yon === 'Çıkış';
          return `<div class="sbek-r"><span class="sbek-t">${esc(x.tarih || '')}</span>`
            + `<b class="${cik ? 'cik' : 'gir'}">${cik ? 'ÇIKIŞ' : 'GİRİŞ'}</b>`
            + `<span class="sbek-k">${esc(x.kod || '')}</span>`
            + `<span class="sbek-m">${cik ? '−' : '+'}${(+x.adetEtki || 0)} boy</span>`
            + `<span class="sbek-i">${esc(x.is || '')}</span>`
            + `<button class="sbek-f${fotoSayi('stok:' + x.id) ? ' var' : ''}" data-act="foto-panel" data-k="stok:${esc(x.id)}" data-b="${esc((x.yon || '') + ' · ' + (x.kod || '') + ' · ' + (x.is || ''))}" title="Fotoğraf">${ICON_CAM}${fotoSayi('stok:' + x.id) ? `<i>${fotoSayi('stok:' + x.id)}</i>` : ''}</button>`
            + `<button class="sbek-x" data-act="stok-bek-sil" data-id="${esc(x.id)}">&times;</button></div>`;
        }).join('')
      + (bek.length > 10 ? `<div class="sbek-r"><span class="sbek-i">${bek.length - 10} hareket daha…</span></div>` : '')
      + '</div>';
  }
  /* FAZ 3b: Excel'e işlenmemiş KALEM işlemleri */
  const bekK = stokKalemBekleyen().filter(k => !S.stk.firma || k.firma === S.stk.firma);
  if (bekK.length){
    h += `<div class="sbek"><div class="sbek-h">KALEM İŞLEMLERİ (${bekK.length})</div>`
      + bekK.slice(0, 10).map(k => {
          const sl = k.tip === 'sil';
          return `<div class="sbek-r"><span class="sbek-t">${esc(k.tarih || '')}</span>`
            + `<b class="${sl ? 'cik' : 'gir'}">${sl ? 'KALEM SİL' : 'YENİ KALEM'}</b>`
            + `<span class="sbek-k">${esc(k.kod || '')}</span>`
            + `<span class="sbek-i">${esc([k.cins, k.renk, k.ebat].filter(Boolean).join(' · '))}`
            + `${(!sl && (+k.adet || 0)) ? ' · açılış ' + (+k.adet || 0) + ' boy' : ''}</span>`
            + `<button class="sbek-x" data-act="stok-kalem-geri" data-id="${esc(k.id)}">&times;</button></div>`;
        }).join('')
      + (bekK.length > 10 ? `<div class="sbek-r"><span class="sbek-i">${bekK.length - 10} işlem daha…</span></div>` : '')
      + '</div>';
  }
  h += `<div class="mstrip">
    <div class="mkut"><span>Kalem</span><b>${L.length}</b></div>
    <div class="mkut"><span>Toplam adet</span><b>${ad.toLocaleString('tr-TR')}</b></div>
    <div class="mkut"><span>Toplam kg</span><b>${kg.toLocaleString('tr-TR',{maximumFractionDigits:1})}</b></div>
  </div><div class="mlist">`;
  gor.forEach(r => {
    h += `<div class="mrow ${r.f === 'tars' ? 'gd' : 'gl'}">
      <div class="mr-1"><span class="myon ${r.f === 'tars' ? 'g' : 'l'}">${r.f === 'tars' ? 'TARS' : 'İZOFLEKS'}</span>
        <span class="mtar">${esc(r.c || '')}${r.d ? ' · ' + esc(r.d) : ''}</span>
        <span class="mrz ${r.bek ? 'bk' : ((+r.a || 0) > 0 ? 'ok' : 'ks')}">${(+r.a || 0)} ad${r.bek ? ` (${r.bek > 0 ? '+' : ''}${r.bek})` : ''}</span></div>
      <div class="mr-2 mkod">${esc(r.k || '')}</div>
      <div class="mr-3"><span class="mno">${esc([r.e, r.r].filter(Boolean).join(' · '))}</span>
        <span class="mtut">${r.b ? esc(String(r.b)) + ' m' : ''}${r.kg ? `<em>${(+r.kg).toLocaleString('tr-TR',{maximumFractionDigits:1})} kg</em>` : ''}</span></div>
      ${r.n ? `<div class="mr-4">${esc(r.n)}</div>` : ''}
    </div>`;
  });
  h += '</div>';
  if (L.length > gor.length)
    h += `<button class="mmore" data-act="stk-more">+${L.length - gor.length} kalem daha göster</button>`;
  if (meta && meta.guncelleme)
    h += `<p class="mnot">Son güncelleme ${muhGun(meta.guncelleme)} · veri bilgisayardaki TERM'den gelir</p>`;
  h += '</div>';
  return h;
}

/* ============ geri hareketi / geri tuşu ============
   Telefonda kenardan geri kaydırma ve Android geri tuşu, uygulamayı kapatmak
   yerine ana ekrana dönsün. Ana ekrandan geri → uygulamadan çıkış (normal davranış). */
let _gecmisDerinlik = 0;
function ekranAc(tab){
  const oncekiHome = S.tab === 'home';
  S.tab = tab;
  if (oncekiHome && tab !== 'home'){
    try { history.pushState({ term: tab }, '', '?v=' + tab); _gecmisDerinlik++; } catch(e){}
  }
  render();
}
function anaEkrana(gecmisten){
  if (S.tab === 'home') return;
  if (!gecmisten && _gecmisDerinlik > 0){
    /* S.tab'ı burada DEĞİŞTİRME: popstate dinleyicisi "zaten home" sanıp
       render()'ı atlıyordu — ekran kartta kalıyordu. */
    _gecmisDerinlik--;
    try {
      history.back();
      /* emniyet: popstate bir sebeple gelmezse ekranı yine de ana ekrana al */
      setTimeout(function(){ if (S.tab !== 'home'){ S.tab = 'home'; S.composer = null; render(); } }, 300);
      return;
    } catch(e){ _gecmisDerinlik++; }
  }
  S.tab = 'home';
  S.composer = null;
  render();
}
window.addEventListener('popstate', () => {
  if (_gecmisDerinlik > 0) _gecmisDerinlik--;
  if (S.tab !== 'home'){ S.tab = 'home'; S.composer = null; render(); }
});

/* ============ render ============ */
function render(){
  const gorevde = S.tab === 'week' || S.tab === 'undated' || S.tab === 'jobs';
  document.getElementById('tab-week').setAttribute('aria-selected', S.tab === 'week');
  document.getElementById('tab-und').setAttribute('aria-selected', S.tab === 'undated');
  document.getElementById('tab-jobs').setAttribute('aria-selected', S.tab === 'jobs');
  const tabsEl = document.querySelector('.topbar .tabs');
  if (tabsEl) tabsEl.hidden = !gorevde;
  const backBtn = document.getElementById('back-btn');
  if (backBtn) backBtn.hidden = S.tab === 'home';
  gaDugme();
  const markaEl = document.querySelector('.topbar .brand');
  if (markaEl) markaEl.classList.toggle('tiklanir', S.tab !== 'home');
  /* Mikrofon HER ekranda görünür — sesli komut artık görev dışında İş Takip, stok/muhasebe
     sorgusu ve ekran geçişi de yapıyor. Önce sadece görev sekmelerinde açıktı. (Mert 23.09.2026) */
  const micBtn = document.getElementById('mic');
  if (micBtn) micBtn.hidden = false;
  const bas = document.getElementById('ekran-ad');
  if (bas){
    bas.textContent = S.tab === 'muh' ? 'Muhasebe'
      : S.tab === 'istakip' ? 'İş Takip'
      : S.tab === 'stok' ? 'Stok'
      : gorevde ? 'Görev Takibi' : '';
    bas.hidden = S.tab === 'home';
  }
  const undN = S.tasks.filter(t => !t.day && !t.pin && !t.done).length;
  const undRozet = document.getElementById('und-n');
  if (undRozet){ undRozet.textContent = undN || ''; undRozet.hidden = !undN; }
  main.innerHTML = S.tab === 'home' ? homeView()
    : S.tab === 'muh' ? muhView()
    : S.tab === 'istakip' ? isTakipView()
    : S.tab === 'stok' ? stokView()
    : S.tab === 'week' ? (S.view === 'month' && window.innerWidth >= 1000 ? monthView() : weekView())
    : S.tab === 'undated' ? undatedView() : jobsView();
  main.innerHTML += fotoOverlay();      /* fotoğraf penceresi her sekmede açılabilir */
  main.innerHTML += konumOverlay();
  main.innerHTML += malOverlay();       /* maliyet panosu */
  main.innerHTML += odemeOverlay();     /* ödeme durumu penceresi */
  const mara = document.getElementById('m-ara');
  if (mara){
    let tm = null;
    mara.oninput = function(){
      const v = this.value;
      clearTimeout(tm);
      tm = setTimeout(() => {
        S.muh.ara = v; S.muh.limit = 60; render();
        const a = document.getElementById('m-ara');
        if (a){ a.focus(); try { a.setSelectionRange(a.value.length, a.value.length); } catch(e){} }
      }, 220);
    };
  }
  const sara = document.getElementById('s-ara');
  if (sara){
    let st = null;
    sara.oninput = function(){
      const v = this.value;
      clearTimeout(st);
      st = setTimeout(() => {
        S.stk.ara = v; S.stk.limit = 60; render();
        const a = document.getElementById('s-ara');
        if (a){ a.focus(); try { a.setSelectionRange(a.value.length, a.value.length); } catch(e){} }
      }, 220);
    };
  }
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
  const durum = !url ? 'Tanımlı değil — TERM\u2019deki IZ_TAKIP_URL adresini yapıştırın.'
    : S.a42.hata ? S.a42.hata
    : n ? n + ' devam eden iş okundu.'
    : 'Bağlandı, devam eden iş yok.';
  return `<hr class="sep">
    <label for="a-a42">TERM iş takip bağlantısı</label>
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
  const destek = (window.SpeechRecognition || window.webkitSpeechRecognition || KAYIT_DESTEK)
    ? '' : '<p class="who">Bu tarayıcı konuşma tanımayı desteklemiyor — Chrome gerekiyor.</p>';
  const ok = getSetting('openaikey');
  const odurum = ok ? 'Bağlı — ses uygulamanın kendisi tarafından sessiz kaydediliyor, gpt-4o-transcribe yazıya çeviriyor.'
    : 'Tanımlı değil — şu an telefonun kendi tanıyıcısı kullanılıyor (başlarken ve duraklamada bip sesi). platform.openai.com\u2019dan API anahtarı alıp buraya yapıştırın.';
  return `<hr class="sep">
    <label for="a-key">Sesli komut · Claude API anahtarı (anlama)</label>
    <input type="password" id="a-key" placeholder="sk-ant-..." value="${esc(k)}" autocomplete="off" spellcheck="false">
    <p class="who">${esc(durum)}</p>${destek}
    <div class="row"><button class="btn" data-act="ai-save">Kaydet ve doğrula</button></div>
    <label for="a-okey">Sesli komut · OpenAI API anahtarı (yazıya çevirme)</label>
    <input type="password" id="a-okey" placeholder="sk-..." value="${ok ? '••••••••' + esc(ok.slice(-4)) : ''}" autocomplete="off" spellcheck="false">
    <p class="who">${esc(odurum)}</p>
    <div class="row"><button class="btn" data-act="openai-save">Kaydet ve doğrula</button></div>`;
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

/* ============ GERİ AL — değişiklik geçmişi ============
   Görev ve iş kartlarındaki her ekleme / değişiklik / silme, ÖNCEKİ hâliyle birlikte
   users/{uid}/gecmis'e yazılır. Böylece:
   · toast kaybolduktan sonra da geri alınabilir,
   · telefonda yapılan hata masaüstünden geri alınabilir (geçmiş bulutta),
   · üzerine yazılan metin kaybolmaz.
   Sıralama (ord) gibi görünmez alanlar kaydedilmez; otomatik devir taşıması da kaydedilmez. */
const GECMIS_ALAN = ['text', 'day', 'pin', 'done', 'jobId', 'devir', 'customer', 'project', 'archived'];
let _gecmisKapali = 0;
function gecmisOzet(c, o){
  if (!o) return '';
  return c === 'tasks' ? kisalt(o.text || '')
       : kisalt([o.customer, o.project].filter(Boolean).join(' · ') || 'iş kartı');
}
function gecmisli(ic){
  const izle = c => (c === 'tasks' || c === 'jobs') && !_gecmisKapali;
  const bul  = (c, id) => (c === 'tasks' ? S.tasks : S.jobs).find(x => x.id === id);
  const yaz  = g => { try { ic.add('gecmis', { ...g, zaman: Date.now() }).catch(() => {}); } catch(e){} };
  return {
    ...ic,
    add(c, o){
      const pr = ic.add(c, o);
      if (izle(c)) pr.then(id => yaz({ tip:'ekle', c, belge:id, ozet:gecmisOzet(c, o) })).catch(() => {});
      return pr;
    },
    update(c, id, p){
      if (izle(c)){
        const v = bul(c, id);
        if (v){
          /* boş / false / null / undefined aynı sayılır — "sabit: yok → false" gibi sahte değişiklik yazılmasın */
          const nrm = x => (x === undefined || x === null || x === false || x === '') ? null : x;
          const alan = Object.keys(p).filter(k => GECMIS_ALAN.includes(k)
            && JSON.stringify(nrm(v[k])) !== JSON.stringify(nrm(p[k])));
          if (alan.length){
            const once = {}, sonra = {};
            alan.forEach(k => { once[k] = v[k] === undefined ? null : v[k]; sonra[k] = p[k] === undefined ? null : p[k]; });
            yaz({ tip:'guncelle', c, belge:id, once, sonra, ozet:gecmisOzet(c, v) });
          }
        }
      }
      return ic.update(c, id, p);
    },
    remove(c, id){
      if (izle(c)){
        const v = bul(c, id);
        if (v){ const { id:_x, ...tam } = v; yaz({ tip:'sil', c, belge:id, once:tam, ozet:gecmisOzet(c, v) }); }
      }
      return ic.remove(c, id);
    }
  };
}
function gecmisAcik(){
  return (S.gecmis || []).filter(g => !g.geriAlindi).sort((a, b) => (b.zaman || 0) - (a.zaman || 0));
}
function gecmisDetay(g){
  if (g.tip === 'ekle') return g.c === 'tasks' ? 'görev eklendi' : 'iş kartı eklendi';
  if (g.tip === 'sil')  return g.c === 'tasks' ? 'görev silindi' : 'iş kartı silindi';
  const o = g.once || {}, s = g.sonra || {}, p = [];
  const gun = d => d ? shortDate(d) : 'tarihsiz';
  Object.keys(o).forEach(k => {
    if (k === 'text') p.push(`metin: “${kisalt(o.text || '')}” → “${kisalt(s.text || '')}”`);
    else if (k === 'day') p.push(`gün: ${gun(o.day)} → ${gun(s.day)}`);
    else if (k === 'done') p.push(s.done ? 'bitti işaretlendi' : 'yeniden açıldı');
    else if (k === 'pin') p.push(s.pin ? 'sabitlendi' : 'sabitten çıkarıldı');
    else if (k === 'devir') p.push(s.devir ? 'bitene kadar taşı açıldı' : 'otomatik taşıma kapandı');
    else if (k === 'jobId'){ const j1 = jobById(o.jobId), j2 = jobById(s.jobId);
      p.push(`iş: ${j1 ? kisalt(jobLabel(j1)) : '—'} → ${j2 ? kisalt(jobLabel(j2)) : '—'}`); }
    else if (k === 'archived') p.push(s.archived ? 'arşivlendi' : 'arşivden çıkarıldı');
    else p.push(`${k}: ${o[k] ?? '—'} → ${s[k] ?? '—'}`);
  });
  return p.join(' · ');
}
function gecmisZaman(ms){
  const f = (Date.now() - (ms || 0)) / 1000;
  if (f < 60) return 'az önce';
  if (f < 3600) return Math.floor(f / 60) + ' dk önce';
  if (f < 86400) return Math.floor(f / 3600) + ' sa önce';
  const d = new Date(ms);
  return d.toLocaleDateString('tr-TR', { day:'numeric', month:'short' }) + ' '
       + d.toLocaleTimeString('tr-TR', { hour:'2-digit', minute:'2-digit' });
}
async function gecmisGeriAl(g){
  if (!g || !S.store) return;
  _gecmisKapali++;
  try {
    const liste = g.c === 'tasks' ? S.tasks : S.jobs;
    const varMi = liste.some(x => x.id === g.belge);
    if (g.tip === 'guncelle'){
      if (!varMi){ note('Bu kayıt artık yok — önce silme işlemini geri al.'); return; }
      await S.store.update(g.c, g.belge, g.once || {});
    } else if (g.tip === 'sil'){
      await S.store.setId(g.c, g.belge, g.once || {});
    } else if (g.tip === 'ekle'){
      if (varMi) await S.store.remove(g.c, g.belge);
    }
    await S.store.update('gecmis', g.id, { geriAlindi: Date.now() });
    note('Geri alındı — ' + (g.ozet || gecmisDetay(g)));
  } catch(e){
    note('Geri alınamadı: ' + (e && e.message ? e.message : 'hata'));
  } finally { _gecmisKapali--; }
}
function gaPanelCiz(){
  const eski = document.getElementById('ga-ov');
  if (!S.gaAcik){ if (eski) eski.remove(); return; }
  const L = gecmisAcik().slice(0, 30);
  const ikon = g => g.tip === 'sil' ? '🗑' : g.tip === 'ekle' ? '＋' : '✎';
  const h = `<div class="itov gaov" id="ga-ov" data-act="ga-kapat"><div class="itovk" data-act="it-ov-ic">
    <div class="itovb gab">Geri al — son değişiklikler</div>
    <div class="itovg">
      ${L.length ? `<button class="itbtn ok ga-son" data-act="ga-geri" data-id="${esc(L[0].id)}">↶ Son işlemi geri al</button>
        <div class="galist">${L.map(g => `<div class="garow">
          <span class="gai ${g.tip}">${ikon(g)}</span>
          <div class="gat"><b>${esc(g.ozet || '')}</b><span>${esc(gecmisDetay(g))}</span><em>${esc(gecmisZaman(g.zaman))}</em></div>
          <button class="itbtn gr" data-act="ga-geri" data-id="${esc(g.id)}">Geri al</button>
        </div>`).join('')}</div>`
      : '<p class="itovm">Henüz geri alınacak bir değişiklik yok.</p>'}
      <div class="itovf"><button class="itbtn gr" data-act="ga-kapat">Kapat</button></div>
    </div></div></div>`;
  if (eski) eski.outerHTML = h; else document.body.insertAdjacentHTML('beforeend', h);
}
function gaDugme(){
  const b = document.getElementById('ga-btn'); if (!b) return;
  const n = gecmisAcik().length;
  b.hidden = !n;
  const r = b.querySelector('.gan'); if (r) r.textContent = n > 99 ? '99+' : String(n);
}
/* masaüstü: Ctrl+Z (yazı alanında değilken) son işlemi geri alır */
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || String(e.key).toLowerCase() !== 'z') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const son = gecmisAcik()[0];
  if (!son) return;
  e.preventDefault();
  gecmisGeriAl(son);
});

/* ============ › düğmesi: dokun = +1 gün · BASILI TUT = "bitene kadar taşı" ============
   Basılı tutulan görev "devir" moduna girer (t.devir = true): her gün başında,
   tamamlandı işaretlenene kadar kendiliğinden bugüne taşınır. Tekrar basılı tutmak modu kapatır. */
let _fwd = null, _fwdSon = 0;
function fwdBitir(uygula){
  const f = _fwd; if (!f) return;
  _fwd = null;
  clearTimeout(f.zam);
  f.b.classList.remove('basili');
  _fwdSon = Date.now();
  if (!uygula) return;
  const t = S.tasks.find(x => x.id === f.id);
  if (!t) return;
  if (f.uzun){
    const ac = !t.devir;
    const p = { devir: ac };
    if (ac && t.day && t.day < todayIso()) p.day = todayIso();   // gecikmişse hemen bugüne al
    S.store.update('tasks', f.id, p);
    note(ac ? 'Bitene kadar her gün taşınacak \u21BB' : 'Otomatik taşıma kapatıldı');
    return;
  }
  if (!t.day) return;
  const yeni = iso(addDays(fromIso(t.day), 1));
  S.store.update('tasks', f.id, { day: yeni });
  if (yeni > iso(addDays(S.weekStart, 6))) note('Gelecek haftaya taşındı — ' + shortDate(yeni));
}
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-act="day-fwd"]');
  if (!b || (e.button !== undefined && e.button !== 0)) return;
  const t = S.tasks.find(x => x.id === b.dataset.id);
  if (!t) return;
  if (_fwd) fwdBitir(false);
  /* Dokunmatikte varsayılanı ENGELLEMİYORUZ: parmak buradan başlayıp kaydırırsa sayfa kaysın,
     işlem iptal olsun. Fareyle metin seçilmesin diye sadece farede engelle. */
  if (e.pointerType === 'mouse') e.preventDefault();
  const f = _fwd = { b, id: t.id, uzun: false, zam: null, x: e.clientX, y: e.clientY };
  f.zam = setTimeout(() => {                    // 0,6 sn KIPIRDAMADAN basılı → mod değişecek
    if (_fwd !== f) return;
    f.uzun = true;
    b.classList.add('basili');
    try { navigator.vibrate && navigator.vibrate(15); } catch(_){}
  }, 600);
});
document.addEventListener('pointermove', (e) => {       // parmak kaydıysa bu bir swipe — iptal
  if (!_fwd) return;
  if (Math.abs(e.clientX - _fwd.x) > 8 || Math.abs(e.clientY - _fwd.y) > 8) fwdBitir(false);
});
document.addEventListener('scroll', () => { if (_fwd) fwdBitir(false); }, { passive:true, capture:true });
document.addEventListener('pointerup', () => { if (_fwd) fwdBitir(true); });
document.addEventListener('pointercancel', () => { if (_fwd) fwdBitir(false); });   // tarayıcı kaydırmayı devraldı → hiçbir şey yapma
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-act="day-fwd"]')) e.preventDefault();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _fwd) fwdBitir(false); });

/* Devir modundaki, bitmemiş ve günü geçmiş görevleri bugüne al.
   Görevler her geldiğinde, uygulama öne geldiğinde ve gece yarısı çalışır.
   Birden fazla cihaz aynı anda çalıştırsa da sonuç aynı (bugün) — çakışma olmaz. */
let _devirCalisiyor = false;
function devirUygula(){
  if (!S.store || _devirCalisiyor) return;
  const bugun = todayIso();
  const ids = S.tasks.filter(t => t.devir && !t.done && !t.pin && t.day && t.day < bugun).map(t => t.id);
  if (!ids.length) return;
  _devirCalisiyor = true;
  _gecmisKapali++;
  try { ids.forEach(id => S.store.update('tasks', id, { day: bugun })); }
  finally { _devirCalisiyor = false; _gecmisKapali--; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) devirUygula(); });
(function geceYarisi(){
  const d = new Date(), yarin = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 5);
  setTimeout(() => { devirUygula(); render(); geceYarisi(); }, yarin - d);
})();

/* Kaydırma koruması: parmak kaydırırken ya da kaydırma biter bitmez gelen "tık"
   İş Takip satırlarını açıp kapatmasın (hızlı kaydırmayı durdurmak için yapılan dokunuş dahil). */
let _dokunBas = null, _dokunKaydi = false, _sonKaydirma = 0;
document.addEventListener('scroll', () => { _sonKaydirma = Date.now(); }, { passive:true, capture:true });
document.addEventListener('touchstart', (e) => {
  const t = e.touches && e.touches[0]; if (!t) return;
  // kaydırma hâlâ sürerken (momentum) başlayan dokunuş = kaydırmayı durdurma, tık sayılmaz
  _dokunKaydi = (Date.now() - _sonKaydirma) < 120;
  _dokunBas = { x: t.clientX, y: t.clientY };
}, { passive:true });
document.addEventListener('touchmove', (e) => {
  const t = e.touches && e.touches[0]; if (!t || !_dokunBas) return;
  if (Math.abs(t.clientY - _dokunBas.y) > 8 || Math.abs(t.clientX - _dokunBas.x) > 8) _dokunKaydi = true;
}, { passive:true });
function kaydirmaTiki(){ return _dokunKaydi || (Date.now() - _sonKaydirma) < 300; }
let _sonDokunus = 0;
document.addEventListener('touchend', () => { _sonDokunus = Date.now(); }, { passive:true, capture:true });
/* dokunmatikte: bu "tık" bir kaydırmanın parçası mı? (fare/klavye tıklarını etkilemez) */
function swipeTiki(){ return (Date.now() - _sonDokunus) < 800 && kaydirmaTiki(); }

/* ============ olaylar ============ */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (swipeTiki()){ e.preventDefault(); return; }   // ekranı kaydırırken hiçbir komut çalışmasın
  const a = b.dataset.act, id = b.dataset.id;

  if (a === 'tab'){ S.gorevTab = b.dataset.v; S.composer = null; ekranAc(b.dataset.v); return; }
  if (a === 'home' || a === 'geri'){ anaEkrana(false); return; }
  if (a === 'ga-ac'){ S.gaAcik = true; gaPanelCiz(); return; }
  if (a === 'ga-kapat'){ S.gaAcik = false; gaPanelCiz(); return; }
  if (a === 'ga-geri'){ const g = (S.gecmis || []).find(x => x.id === id); await gecmisGeriAl(g); return; }
  if (a === 'kart'){
    const k = b.dataset.v;
    if (k === 'gorev'){ S.composer = null; ekranAc(S.gorevTab || 'week'); return; }
    if (k === 'muh'){ ekranAc('muh'); return; }
    if (k === 'istakip'){ loadA42(true); ekranAc('istakip'); return; }
    if (k === 'stok'){ ekranAc('stok'); return; }
    note('Bu bölüm şimdilik bilgisayardaki TERM\'de.');
    return;
  }
  if (a === 'muh-f'){ S.muh[b.dataset.k] = b.dataset.v; S.muh.limit = 60; render(); return; }
  if (a === 'muh-more'){ S.muh.limit += 120; render(); return; }
  if (a === 'stk-f'){ S.stk[b.dataset.k] = b.dataset.v; S.stk.limit = 60; render(); return; }
  if (a === 'stk-more'){ S.stk.limit += 120; render(); return; }
  if (a === 'a42-yenile'){ S.a42.at = 0; loadA42(false).then(render); return; }

  /* ---- İş Takip işlemleri ---- */
  if (a === 'it-sec'){
    if (e.target.closest('.itact')) return;      // buton tıklaması satırı kapatmasın
    if (kaydirmaTiki()) return;                   // kaydırma sonu dokunuşu satırı açıp kapatmasın
    S.itSec = (S.itSec === b.dataset.k) ? '' : b.dataset.k;
    render(); return;
  }
  if (a === 'it-ov-ic') return;                  // pencere içine tıklama kapatmasın
  if (a === 'it-ov-kapat'){ itNotAl(); S.itOv = null; render(); return; }
  if (a === 'it-bitir'){ await itBitir(id); return; }
  if (a === 'it-sil'){ await itSil(id); return; }
  if (a === 'it-gonder'){ await itTeklifDurum(id, 'GONDERILDI', 'Teklif gönderildi olarak işaretlendi'); return; }
  if (a === 'it-red'){ S.itOv = { tip:'red', id, sebep:'', not:'' }; render(); return; }
  if (a === 'it-red-sec'){ itNotAl(); S.itOv.sebep = b.dataset.v; render(); return; }
  if (a === 'it-red-kaydet'){ await itRedKaydet(); return; }
  if (a === 'it-kabul'){ S.itOv = { tip:'kabul', id, para:'TL', tutar:'' }; render(); return; }
  if (a === 'it-kabul-para'){ itNotAl(); S.itOv.para = b.dataset.v; render(); return; }
  if (a === 'it-kabul-kaydet'){ await itKabulKaydet(); return; }
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
    if (Date.now() - _fwdSon < 800) return;   // dokunma/basılı tutma zaten pointerup'ta işlendi
    const t = S.tasks.find(x => x.id === id);
    if (!t || !t.day) return;
    const yeni = iso(addDays(fromIso(t.day), 1));
    S.store.update('tasks', id, { day: yeni });
    if (yeni > iso(addDays(S.weekStart, 6))) note('Gelecek haftaya taşındı — ' + shortDate(yeni));
    return;
  }
  if (a === 'open-job-form'){ S.tab = 'jobs'; S.composer = { scope: 'newjob', day: '' }; S.newJob = { customer: '', project: '' }; render(); return; }
  if (a === 'pick'){ openPicker(b.dataset.type, b); return; }
  if (a === 'task-edit'){ editAc(id); return; }
  if (a === 'edit-kapat'){ editKapat(); return; }
  if (a === 'edit-kaydet'){ editKaydet(); return; }
  if (a === 'edit-is'){ editTopla(); openPicker('job', b); return; }
  if (a === 'edit-tarihsiz'){ editTopla(); S.edit.day = ''; editCiz(); return; }
  if (a === 'edit-sabit'){ editTopla(); S.edit.pin = !S.edit.pin; if (S.edit.pin) S.edit.day = ''; editCiz(); return; }
  if (a === 'edit-bitti'){ editTopla(); S.edit.done = !S.edit.done; editCiz(); return; }
  if (a === 'edit-sil'){
    const e = S.edit; if (!e) return;
    const t = S.tasks.find(x => x.id === e.id);
    if (!t) { editKapat(); return; }
    if (!confirm('“' + kisalt(t.text) + '” silinsin mi?')) return;
    const yedek = { jobId: t.jobId, day: t.day || '', text: t.text || '', done: !!t.done, pin: !!t.pin, ord: t.ord, createdAt: t.createdAt };
    S.store.remove('tasks', e.id);
    editKapat(); render();
    noteGeri('Silindi — ' + kisalt(yedek.text), () => S.store.add('tasks', yedek));
    return;
  }
  if (a === 'pop-close'){ closePicker(); return; }
  if (a === 'pop-all'){ if (S.picker){ S.picker.all = true; renderPicker(); } return; }
  if (a === 'pop-choose'){
    if (S.picker && S.picker.type === 'job'){
      if (b.dataset.genel){ genelChoose(b.dataset.genel, b.dataset.val, +b.dataset.ci || 0); return; }
      if (b.dataset.tkf){ teklifChoose(b.dataset.tkf, b.dataset.val, b.dataset.cust); return; }
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
    S.a42 = { isler: [], teklifler: [], at: 0, hata: '' };
    await loadA42(false);
    openSheet();
    note(v ? (a42Devam().length + ' devam eden iş okundu.') : 'TERM bağlantısı kaldırıldı.');
    return;
  }
  if (a === 'mic'){ sesBaslat(); return; }
  if (a === 'voice-bitir'){ sesBitir(); return; }
  if (a === 'voice-cevap'){ sesCevapla(); return; }
  if (a === 'voice-yaz'){
    const v = (document.getElementById('v-fix')?.value || '').trim();
    if (!v) return;
    sesIptal = true; sesBitti = true;
    try { sesTanir && sesTanir.abort(); } catch(err){}
    sesTanir = null; sesAlt = []; sesKesin = v; sesSon = v; V.metin = v;
    vEl().classList.remove('dinliyor');
    komutCoz(v);
    return;
  }
  if (a === 'stok-sec'){
    const h = stokSecenek; if (!h) return;
    const r = h.aday[+(b.dataset.i ?? -1)];
    if (!r) return;
    stokSecenek = null; stokOnayAc(h, r); return;
  }
  if (a === 'stok-kaydet'){ stokKaydet(); return; }
  if (a === 'kalem-kaydet'){ kalemKaydet(); return; }
  if (a === 'kalem-sil'){ kalemSil(); return; }
  if (a === 'kalem-ac-teklif'){
    const kb = kalemBek; kalemBek = null;
    const o = (kb && kb.o) || {};
    komutKalemAc({ stokKod: o.stokKod, stokFirma: o.stokFirma, stokMiktar: 0 });
    return;
  }
  if (a === 'kalem-sil-sec'){
    const h = stokSecenek; if (!h || !h.aday) return;
    const r = h.aday[+(b.dataset.i ?? -1)]; if (!r) return;
    stokSecenek = null; kalemSilAc(r); return;
  }
  if (a === 'stok-kalem-geri'){
    if (confirm('Bu bekleyen kalem işlemi geri alınsın mı?')) S.store.remove('stokKalem', id);
    return;
  }
  if (a === 'foto-panel'){ fotoAc(b.dataset.k, b.dataset.b || ''); return; }
  if (a === 'konum-panel'){ konumAc(b.dataset.k, b.dataset.b || ''); return; }
  if (a === 'mal-panel'){ malAc(b.dataset.id); return; }
  if (a === 'odeme-ac'){ odemeAc(b.dataset.no); return; }
  if (a === 'odeme-kapat'){ odemeKapat(); return; }
  if (a === 'odeme-onay'){ await odemeElle(S.odemeOv && S.odemeOv.no, 'onay'); return; }
  if (a === 'odeme-red'){ await odemeElle(S.odemeOv && S.odemeOv.no, 'red'); return; }
  if (a === 'odeme-sil'){ await odemeElle(S.odemeOv && S.odemeOv.no, null); return; }
  if (a === 'mal-kapat'){ malKapat(); return; }
  if (a === 'mal-kat'){ if (S.malOv){ S.malOv.kat = (S.malOv.kat === b.dataset.v) ? '' : b.dataset.v; render(); } return; }
  if (a === 'konum-kapat'){ konumKapat(); return; }
  if (a === 'konum-gps'){ konumOvGps(); return; }
  if (a === 'konum-kaydet'){ konumKaydet(); return; }
  if (a === 'konum-sil'){
    if (!S.konumOv) return;
    if (!confirm('Bu işin konumu kaldırılsın mı?')) return;
    const h = S.konumOv.hedef; S.konumOv = null;
    konumSil(h).then(() => { note('Konum kaldırıldı.'); render(); });
    return;
  }
  if (a === 'foto-kapat'){ fotoKapat(); return; }
  if (a === 'foto-etiket'){
    if (S.fotoOv){
      const nt = document.getElementById('foto-not'); if (nt) S.fotoOv.not = nt.value;
      S.fotoOv.etiket = (S.fotoOv.etiket === b.dataset.v) ? '' : b.dataset.v;
      render();
    }
    return;
  }
  if (a === 'foto-cek'){ fotoYukle(true); return; }
  if (a === 'foto-galeri'){ fotoYukle(false); return; }
  if (a === 'foto-ac'){ fotoGoster(id); return; }
  if (a === 'foto-buyuk-kapat'){ if (S.fotoOv){ S.fotoOv.goster = null; S.fotoOv.tam = null; render(); } return; }
  if (a === 'foto-sil'){
    if (!id) return;
    if (!confirm('Bu fotoğraf silinsin mi?')) return;
    if (S.fotoOv){ S.fotoOv.goster = null; S.fotoOv.tam = null; }
    fotoSil(id).then(() => { note('Fotoğraf silindi.'); render(); });
    return;
  }
  if (a === 'stok-bek-sil'){
    if (confirm('Bu bekleyen hareket silinsin mi?')) S.store.remove('stokHareket', id);
    return;
  }
  if (a === 'voice-coklu'){ komutCokluUygula(); return; }
  if (a === 'voice-close'){ voiceKapat(); return; }
  if (a === 'voice-ok'){ if (V.sonuc) komutUygula(V.sonuc, false); return; }
  if (a === 'voice-yeni'){          // "değiştir" yanlış anlaşıldıysa: aynı iş/panele YENİ görev olarak ekle
    const o = V.sonuc; if (!o) return;
    const t = S.tasks.find(x => x.id === o.gorevId);
    if (!t){ komutUygula({ ...o, islem:'ekle' }, false); return; }
    komutUygula({ islem:'ekle', isId:'job:' + t.jobId, metin:o.metin, sabit:!!t.pin,
                  gun: t.pin ? null : (t.day || null), guven:1 }, false);
    return;
  }
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
  if (a === 'openai-save'){
    const v = (document.getElementById('a-okey')?.value || '').trim();
    if (v.startsWith('••••')){ note('Anahtar zaten kayıtlı — değiştirmek için yenisini yapıştırın.'); return; }
    if (!v){ await setSetting('openaikey', ''); openSheet(); note('OpenAI anahtarı kaldırıldı — telefonun tanıyıcısına dönüldü.'); return; }
    if (!/^sk-/.test(v)){ note('OpenAI anahtarı sk- ile başlamalı.'); return; }
    try {
      const r = await fetch('https://api.openai.com/v1/models/gpt-4o-transcribe', { headers: { Authorization: 'Bearer ' + v } });
      if (r.status === 401) throw new Error('anahtar geçersiz');
      await setSetting('openaikey', v);
      openSheet(); note(r.ok ? 'OpenAI bağlandı — sesli komut artık sessiz kayıtla çalışıyor.' : 'Kaydedildi (model kontrolü: HTTP ' + r.status + ')');
    } catch(e){ note('Doğrulanamadı: ' + e.message); }
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
  S.store = gecmisli(store);
  S.jobs = []; S.tasks = []; S.contacts = []; S.settings = []; S.gecmis = [];
  setSync(kind, label);
  S.unsub.push(store.subscribe('jobs', rows => { S.jobs = rows.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); render(); renderPicker(); }));
  S.unsub.push(store.subscribe('tasks', rows => { S.tasks = rows; render(); devirUygula(); }));
  S.unsub.push(store.subscribe('contacts', rows => { S.contacts = rows; renderPicker(); }));
  S.unsub.push(store.subscribe('settings', rows => { S.settings = rows; loadA42(true); }));
  S.unsub.push(store.subscribe('muhasebe', rows => { S.muhasebe = rows; if (S.tab === 'muh') render(); }));
  S.unsub.push(store.subscribe('stok', rows => { S.stok = rows; if (S.tab === 'stok') render(); }));
  S.unsub.push(store.subscribe('stokHareket', rows => { S.stokHareket = rows; if (S.tab === 'stok') render(); }));
  S.unsub.push(store.subscribe('stokKalem', rows => { S.stokKalem = rows; if (S.tab === 'stok') render(); }));
  S.unsub.push(store.subscribe('foto', rows => { S.foto = rows; render(); }));
  S.unsub.push(store.subscribe('konum', rows => { S.konum = rows; render(); }));
  S.unsub.push(store.subscribe('odemeOnay', rows => { S.odemeOnay = rows; if (S.tab === 'muh') render(); }));
  S.unsub.push(store.subscribe('gecmis', rows => { S.gecmis = rows; gaDugme(); gaPanelCiz(); }));
}

/* ============ açılış ============ */
try {
  const v = new URLSearchParams(location.search).get('v');
  if (v === 'jobs' || v === 'week' || v === 'undated'){ S.tab = v; S.gorevTab = v; }
  else if (v === 'muhasebe' || v === 'muh') S.tab = 'muh';
  else if (v === 'istakip') S.tab = 'istakip';
  else if (v === 'stok') S.tab = 'stok';
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
