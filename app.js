/* İzofleks İş Takibi — PWA
   Veri katmanı iki modda çalışır:
   · bulut  → Firebase Firestore (telefon + bilgisayar gerçek zamanlı senkron)
   · yerel  → localStorage (sadece o cihaz)
   A42 entegrasyonu için dışa açılan arayüz: window.IzoTodo (dosyanın sonunda)
*/
"use strict";

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
const COLLECTIONS = ['jobs', 'tasks', 'contacts'];

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
    update(c, id, p){ return updateDoc(doc(db, 'users', uid, c, id), p); },
    remove(c, id){ return deleteDoc(doc(db, 'users', uid, c, id)); }
  };
}

/* ============ durum ============ */
const S = {
  tab: 'week',
  weekStart: mondayOf(new Date()),
  jobs: [], tasks: [], contacts: [],
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
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

/* ============ türetilmiş ============ */
const activeJobs = () => S.jobs.filter(j => !j.archived);
const jobById = id => S.jobs.find(j => j.id === id) || null;
const jobColor = j => j ? SWATCH[(j.ci || 0) % SWATCH.length] : 'var(--line-2)';
const jobLabel = j => j ? ((j.customer ? j.customer + ' · ' : '') + (j.project || '')) : 'GENEL';
const byDone = (a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || (a.createdAt || 0) - (b.createdAt || 0);

const tasksOfDay = d => S.tasks.filter(t => t.day === d && (S.showDone || !t.done)).sort(byDone);
const undatedTasks = () => S.tasks.filter(t => !t.day && (S.showDone || !t.done)).sort(byDone);
const lateTasks = () => { const t0 = todayIso(); return S.tasks.filter(t => !t.done && t.day && t.day < t0).sort((a,b) => a.day < b.day ? -1 : 1); };
/* --- rehber: müşteri/mimar ve proje adları --- */
const norm = s => String(s || '').trim().toLocaleLowerCase('tr');

function customerList(){
  const map = new Map();   // normalize -> { name, contactId }
  S.contacts.forEach(c => { if (c.name && !map.has(norm(c.name))) map.set(norm(c.name), { name: c.name, contactId: c.id }); });
  S.jobs.forEach(j => { if (j.customer && !map.has(norm(j.customer))) map.set(norm(j.customer), { name: j.customer, contactId: null }); });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

function projectList(customer){
  const cn = norm(customer);
  const mine = new Map(), other = new Map();
  S.jobs.forEach(j => {
    if (!j.project) return;
    const bucket = (cn && norm(j.customer) === cn) ? mine : other;
    if (!bucket.has(norm(j.project))) bucket.set(norm(j.project), { name: j.project, customer: j.customer || '' });
  });
  const srt = m => [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  return { mine: srt(mine), other: srt(other) };
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

/* ============ parçalar ============ */
function taskHtml(t, o = {}){
  const j = jobById(t.jobId);
  const late = !t.done && t.day && t.day < todayIso();
  const meta = o.showDay ? `<span class="dbadge">${t.day ? esc(shortDate(t.day)) : 'tarihsiz'}</span>` : '';
  return `<div class="task${t.done ? ' done' : ''}${late ? ' late' : ''}">
    <span class="stripe" style="background:${jobColor(j)}"></span>
    <button class="box" data-act="toggle" data-id="${t.id}" aria-label="Tamamlandı işaretle" aria-pressed="${t.done ? 'true' : 'false'}">
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 6.2L4.4 9 10.5 2.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <span class="body">${o.hideJob ? '' : `<span class="jl">${esc(jobLabel(j))}</span>`}<span class="tt">${esc(t.text)}${meta}</span></span>
    <button class="kill" data-act="del-task" data-id="${t.id}" aria-label="Görevi sil" title="Sil">×</button>
  </div>`;
}

function composerHtml(scope){
  const jobs = activeJobs();
  const opts = jobs.map(j => `<option value="${j.id}"${S.draft.job === j.id ? ' selected' : ''}>${esc(jobLabel(j))}</option>`).join('');
  const jobSel = scope.startsWith('job:') ? '' :
    `<select id="c-job" aria-label="İş seç">${jobs.length ? '' : '<option value="">— önce iş ekleyin —</option>'}${opts}</select>`;
  const daySel = scope === 'week' ? '' : `<input type="date" id="c-day" value="${esc(S.draft.day || '')}" aria-label="Gün">`;
  return `<div class="composer">${jobSel}${daySel}
    <input type="text" id="c-text" placeholder="Ne yapılacak?" autocomplete="off" aria-label="Görev">
    <div class="row"><button class="btn primary" data-act="save-task">Ekle</button>
    <button class="btn ghost" data-act="cancel-composer">İptal</button></div></div>`;
}

function weekView(){
  const start = S.weekStart, end = addDays(start, 6), t0 = todayIso();
  const late = lateTasks();
  let h = `<div class="weekbar">
    <div><h2>${esc(rangeLabel(start, end))}</h2><div class="kw">${weekNo(start)}. HAFTA</div></div>
    <div class="navbtns">
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

  h += '<div class="weekgrid">';
  for (let i = 0; i < 7; i++){
    const d = addDays(start, i), di = iso(d), list = tasksOfDay(di);
    const open = S.tasks.filter(t => t.day === di && !t.done).length;
    const composing = S.composer && S.composer.scope === 'week' && S.composer.day === di;
    h += `<section class="day${i > 4 ? ' weekend' : ''}${di === t0 ? ' today' : ''}">
      <div class="day-h"><span class="dn">${DAY_FULL[i]}</span><span class="dd">${pad(d.getDate())}.${pad(d.getMonth() + 1)}</span>${open ? `<span class="cnt">${open}</span>` : ''}</div>
      <div class="day-b">${list.map(t => taskHtml(t)).join('')}${composing ? composerHtml('week') : ''}</div>
      <div class="day-f">${composing ? '' : `<button class="addlink" data-act="open-composer" data-scope="week" data-day="${di}">+ görev</button>`}</div>
    </section>`;
  }
  h += '</div>';

  const und = undatedTasks();
  const composingU = S.composer && S.composer.scope === 'week' && S.composer.day === '';
  h += `<div class="band"><div class="band-h"><h3>Tarihsiz</h3><span class="rule"></span>
    <button class="btn ghost" data-act="open-composer" data-scope="week" data-day="">+ ekle</button></div>
    <div class="chips">${und.length ? und.map(t => taskHtml(t)).join('') : '<div class="empty-note">Tarihe bağlı olmayan görev yok.</div>'}
    ${composingU ? `<div style="min-width:240px;flex:1 1 240px">${composerHtml('week')}</div>` : ''}</div></div>`;
  return h;
}

function jobsView(){
  const list = S.jobs.filter(j => S.showArchived || !j.archived);
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

  if (!list.length && !newJob) return h + blankHtml();

  h += '<div class="joblist">';
  list.forEach(j => {
    const ts = tasksOfJob(j.id);
    const open = S.tasks.filter(t => t.jobId === j.id && !t.done).length;
    const done = S.tasks.filter(t => t.jobId === j.id && t.done).length;
    const composing = S.composer && S.composer.scope === 'job:' + j.id;
    h += `<article class="job${j.archived ? ' archived' : ''}">
      <div class="job-h"><span class="swatch" style="background:${jobColor(j)}"></span>
        <span class="nm"><span class="cust">${esc(j.customer || '—')}</span><div class="proj">${esc(j.project || 'İsimsiz proje')}</div></span>
        <span class="acts">
          <button class="btn ghost" data-act="arch-job" data-id="${j.id}" title="${j.archived ? 'Arşivden çıkar' : 'Arşivle'}">${j.archived ? '↺' : '⌁'}</button>
          <button class="btn ghost" data-act="del-job" data-id="${j.id}" title="Sil">×</button></span></div>
      <div class="job-stat"><span><b>${open}</b> açık</span><span><b>${done}</b> biten</span></div>
      <div class="job-b">${ts.length ? ts.map(t => taskHtml(t, { hideJob: true, showDay: true })).join('') : '<div class="empty-note">Görev yok.</div>'}
        ${composing ? composerHtml('job:' + j.id) : `<button class="addlink" data-act="open-composer" data-scope="job:${j.id}" data-day="">+ görev</button>`}
      </div></article>`;
  });
  h += '</div>' + dataPanelHtml();
  return h;
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

/* ============ rehber penceresi ============ */
function openPicker(type, btn){
  const r = btn.getBoundingClientRect();
  S.picker = { type, q: '', rect: { top: r.bottom, right: r.right, left: r.left } };
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
  let body = '', title, addable = '';

  if (type === 'customer'){
    const rows = customerList().filter(c => hit(c.name));
    title = 'Müşteri / Mimar';
    body = rows.length
      ? rows.map(c => `<div class="pop-row"><button class="pop-pick" data-act="pop-choose" data-val="${esc(c.name)}">${esc(c.name)}</button>${
          c.contactId ? `<button class="pop-del" data-act="pop-del" data-id="${c.contactId}" title="Rehberden sil" aria-label="Rehberden sil">×</button>` : ''
        }</div>`).join('')
      : '<div class="pop-empty">Kayıt yok.</div>';
    const exact = customerList().some(c => norm(c.name) === norm(q));
    if (q.trim() && !exact) addable = `<button class="pop-add" data-act="pop-add">+ “${esc(q.trim())}” rehbere ekle</button>`;
  } else {
    const cust = (document.getElementById('j-cust')?.value || S.newJob.customer || '').trim();
    const { mine, other } = projectList(cust);
    const m = mine.filter(p => hit(p.name)), o = other.filter(p => hit(p.name));
    title = 'Proje';
    const row = p => `<div class="pop-row"><button class="pop-pick" data-act="pop-choose" data-val="${esc(p.name)}">${esc(p.name)}${
      p.customer && !cust ? `<span class="pop-sub">${esc(p.customer)}</span>` : ''}</button></div>`;
    if (m.length) body += `<div class="pop-grp">${esc(cust)} projeleri</div>` + m.map(row).join('');
    if (o.length) body += `<div class="pop-grp">${m.length ? 'Diğer projeler' : 'Tüm projeler'}</div>` + o.map(row).join('');
    if (!body) body = '<div class="pop-empty">Kayıtlı proje yok.</div>';
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

function pickerChoose(val){
  const type = S.picker.type;
  const id = type === 'customer' ? 'j-cust' : 'j-proj';
  const el = document.getElementById(id);
  if (el) el.value = val;
  if (type === 'customer') S.newJob.customer = val; else S.newJob.project = val;
  closePicker();
  // müşteri seçildiyse sıradaki alan proje
  document.getElementById(type === 'customer' ? 'j-proj' : 'j-proj')?.focus();
}

/* ============ render ============ */
function render(){
  document.getElementById('tab-week').setAttribute('aria-selected', S.tab === 'week');
  document.getElementById('tab-jobs').setAttribute('aria-selected', S.tab === 'jobs');
  main.innerHTML = S.tab === 'week' ? weekView() : jobsView();
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
  if (!S.draft.job){ const a = activeJobs(); S.draft.job = a.length ? a[0].id : ''; }
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
    const je = document.getElementById('c-job');
    jobId = je ? je.value : '';
    day = S.composer.day;
    if (!jobId){ note('Önce bir iş ekleyin.'); return; }
  }
  S.draft.job = jobId;
  S.store.add('tasks', { jobId, day: day || '', text, done: false, createdAt: Date.now() });
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
      <p class="lead">Telefon ve bilgisayar arasında senkron için <code>firebase-config.js</code> dosyasına Firebase ayarlarını yapıştırın (kurulum adımları README dosyasında).</p>
      <div class="row"><button class="btn" data-act="close-sheet">Tamam</button></div>`;
  } else if (S.user){
    sheetBody.innerHTML = `<p class="lead">Bulut senkronu açık. Aynı hesapla girdiğiniz her cihazda aynı liste görünür.</p>
      <p class="who">${esc(S.user.email || S.user.uid)}</p>
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
  if (a === 'today'){ S.weekStart = mondayOf(new Date()); S.composer = null; render(); return; }
  if (a === 'toggle-done'){ S.showDone = !S.showDone; render(); return; }
  if (a === 'toggle-arch'){ S.showArchived = !S.showArchived; render(); return; }
  if (a === 'open-composer'){ openComposer(b.dataset.scope, b.dataset.day); return; }
  if (a === 'cancel-composer'){ S.composer = null; S.draft.text = ''; render(); return; }
  if (a === 'save-task'){ saveTask(); return; }
  if (a === 'open-job-form'){ S.tab = 'jobs'; S.composer = { scope: 'newjob', day: '' }; S.newJob = { customer: '', project: '' }; render(); return; }
  if (a === 'pick'){ openPicker(b.dataset.type, b); return; }
  if (a === 'pop-close'){ closePicker(); return; }
  if (a === 'pop-choose'){ pickerChoose(b.dataset.val); return; }
  if (a === 'pop-del'){
    const c = S.contacts.find(x => x.id === id);
    if (c && confirm(`“${c.name}” rehberden silinsin mi? (İşler etkilenmez)`)) S.store.remove('contacts', id);
    return;
  }
  if (a === 'pop-add'){
    const v = (document.getElementById('pop-q')?.value || '').trim();
    if (!v) return;
    ensureContact(v);
    pickerChoose(v);
    return;
  }
  if (a === 'save-job'){ saveJob(); return; }
  if (a === 'seed'){ seed(); return; }
  if (a === 'install'){ doInstall(); return; }
  if (a === 'account'){ openSheet(); return; }
  if (a === 'close-sheet'){ closeSheet(); return; }

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
  if (e.target.id === 'j-cust') S.newJob.customer = e.target.value;
  if (e.target.id === 'j-proj') S.newJob.project = e.target.value;
  if (e.target.id === 'pop-q' && S.picker){ S.picker.q = e.target.value; renderPicker(); }
});

document.addEventListener('mousedown', e => {
  if (!S.picker) return;
  if (e.target.closest('#pop') || e.target.closest('[data-act="pick"]')) return;
  closePicker();
});
document.addEventListener('change', e => {
  if (e.target.id === 'c-job') S.draft.job = e.target.value;
  if (e.target.id === 'c-day') S.draft.day = e.target.value;
});
document.addEventListener('keydown', e => {
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
    if (first) pickerChoose(first.dataset.val);
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
  S.jobs = []; S.tasks = []; S.contacts = [];
  setSync(kind, label);
  S.unsub.push(store.subscribe('jobs', rows => { S.jobs = rows.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); render(); renderPicker(); }));
  S.unsub.push(store.subscribe('tasks', rows => { S.tasks = rows; render(); }));
  S.unsub.push(store.subscribe('contacts', rows => { S.contacts = rows; renderPicker(); }));
}

/* ============ açılış ============ */
try {
  const v = new URLSearchParams(location.search).get('v');
  if (v === 'jobs' || v === 'week') S.tab = v;
} catch(e){}
render();
bind(localStore(), 'yerel', 'off');

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

/* ============ service worker ============ */
if ('serviceWorker' in navigator){
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW:', e)));
}

/* ============ A42 arayüzü ============ */
window.IzoTodo = {
  state: S,
  render,
  exportData: () => ({ v: 1, jobs: S.jobs, tasks: S.tasks }),
  addJob: (customer, project) => S.store.add('jobs', { customer: customer || '', project: project || '', archived: false, ci: S.jobs.length % SWATCH.length, createdAt: Date.now() }),
  addTask: (jobId, text, day) => S.store.add('tasks', { jobId, text: text || '', day: day || '', done: false, createdAt: Date.now() })
};
