const state = {
  section: 'screening', // 'screening' or 'recruiters'
  jobs: [],
  selected: 'general', // 'general' or job.id
  view: 'criteria',    // 'criteria' or 'history'
  historyApp: null,    // selected application id in the history detail view
  recruiterJobs: [],
  recruiterSelected: null, // recruiter_job id, or null when nothing is selected
};

const contentEl = document.getElementById('content');
const folderListEl = document.getElementById('folder-list');
const recruiterFolderListEl = document.getElementById('recruiter-folder-list');
const toastEl = document.getElementById('toast');

function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { toastEl.className = 'toast'; }, 2600);
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Error ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function loadJobs() {
  state.jobs = await api('/jobs');
  renderFolderList();
}

function renderFolderList() {
  folderListEl.innerHTML = '';

  const generalBtn = document.createElement('button');
  generalBtn.className = 'folder-tab general' + (state.selected === 'general' ? ' active' : '');
  generalBtn.innerHTML = `<span>General</span>`;
  generalBtn.onclick = () => selectFolder('general');
  folderListEl.appendChild(generalBtn);

  state.jobs.forEach(job => {
    const btn = document.createElement('button');
    btn.className = 'folder-tab' + (state.selected === job.id ? ' active' : '');
    btn.innerHTML = `<span>${escapeHtml(job.name)}</span>`;
    btn.onclick = () => selectFolder(job.id);
    folderListEl.appendChild(btn);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function selectFolder(id) {
  state.selected = id;
  state.view = 'criteria';
  state.historyApp = null;
  document.getElementById('nav-criteria').classList.add('active');
  document.getElementById('nav-history').classList.remove('active');
  document.getElementById('criteria-nav').style.display = '';
  renderFolderList();
  await renderContent();
}

function setView(view) {
  state.view = view;
  document.getElementById('nav-criteria').classList.toggle('active', view === 'criteria');
  document.getElementById('nav-history').classList.toggle('active', view === 'history');
  document.getElementById('criteria-nav').style.display = view === 'criteria' ? '' : 'none';
  renderContent();
}

async function renderContent() {
  if (state.section === 'recruiters') {
    await renderRecruitersView();
    return;
  }
  if (state.view === 'history') {
    if (state.historyApp) {
      await renderHistoryDetail(state.historyApp);
    } else {
      await renderHistoryList();
    }
    return;
  }
  if (state.selected === 'general') {
    await renderGeneralView();
  } else {
    await renderJobView(state.selected);
  }
}

async function renderGeneralView() {
  contentEl.innerHTML = `<div class="folder-label">General folder</div>
    <h1 class="folder-title">General parameters</h1>
    <div class="folder-meta">These apply to the evaluation of every job, in addition to each job's specific ones.</div>
    <div class="section" id="params-section"></div>`;

  const params = await api('/jobs/general/parameters');
  renderParamsSection(document.getElementById('params-section'), params, 'general');
}

async function renderJobView(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;

  contentEl.innerHTML = `
    <div class="folder-label">Job folder</div>
    <h1 class="folder-title">${escapeHtml(job.name)}</h1>
    <div class="folder-meta">
      Ashby ID (job):
      <input type="text" id="ashby-job-id" value="${escapeHtml(job.ashby_job_id || '')}" placeholder="not linked" />
    </div>
    <div class="section" id="params-section"></div>
    <div class="section" id="killer-section"></div>
  `;

  document.getElementById('ashby-job-id').addEventListener('change', async (e) => {
    try {
      await api(`/jobs/${jobId}`, { method: 'PUT', body: JSON.stringify({ ashby_job_id: e.target.value.trim() }) });
      showToast('Ashby ID updated');
      await loadJobs();
    } catch (err) { showToast(err.message, true); }
  });

  const [params, killers] = await Promise.all([
    api(`/jobs/${jobId}/parameters`),
    api(`/jobs/${jobId}/killer-questions`),
  ]);

  renderParamsSection(document.getElementById('params-section'), params, jobId);
  renderKillerSection(document.getElementById('killer-section'), killers, jobId);
}

function renderParamsSection(container, params, scopeId) {
  const total = params.reduce((sum, p) => sum + p.weight, 0);
  const totalClass = total === 0 ? '' : (Math.abs(total - 10) < 0.01 ? 'balanced' : (total > 10 ? 'over' : ''));

  container.innerHTML = `
    <div class="section-heading">
      <h2>Evaluation parameters</h2>
      <span class="weight-total ${totalClass}">sum of weights: ${total.toFixed(1)} / 10</span>
    </div>
    <div class="section-hint">Anyone can add the criterion they evaluate and the weight they give it, out of 10.</div>
    <div class="card">
      <div id="param-rows"></div>
      <form class="add-row-form" id="add-param-form">
        <input type="text" name="name" placeholder="Parameter name (e.g. years of experience)" required />
        <input type="number" name="weight" class="weight-field" min="0" max="10" step="0.5" placeholder="weight" required />
        <input type="text" name="added_by" placeholder="added by" />
        <button type="submit" title="Add">+</button>
      </form>
    </div>
  `;

  const rowsEl = container.querySelector('#param-rows');
  if (params.length === 0) {
    rowsEl.innerHTML = `<div class="empty-state">No parameters in this folder yet.</div>`;
  } else {
    params.forEach(p => rowsEl.appendChild(buildParamRow(p, scopeId)));
  }

  container.querySelector('#add-param-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.name.value.trim();
    const weight = Number(form.weight.value);
    const added_by = form.added_by.value.trim();
    if (!name) return;
    try {
      await api(`/jobs/${scopeId}/parameters`, { method: 'POST', body: JSON.stringify({ name, weight, added_by }) });
      showToast('Parameter added');
      await renderContent();
    } catch (err) { showToast(err.message, true); }
  });
}

function buildParamRow(p, scopeId) {
  const row = document.createElement('div');
  row.className = 'param-row';
  row.innerHTML = `
    <input class="param-name" value="${escapeHtml(p.name)}" />
    <div class="weight-control">
      <div class="weight-bar"><div class="weight-bar-fill" style="width:${(p.weight / 10) * 100}%"></div></div>
      <input class="weight-input" type="number" min="0" max="10" step="0.5" value="${p.weight}" />
    </div>
    <input class="added-by" value="${escapeHtml(p.added_by || '')}" placeholder="added by" />
    <button class="row-delete" title="Delete">×</button>
  `;

  const nameInput = row.querySelector('.param-name');
  const weightInput = row.querySelector('.weight-input');
  const weightFill = row.querySelector('.weight-bar-fill');
  const addedByInput = row.querySelector('.added-by');
  const deleteBtn = row.querySelector('.row-delete');

  async function save(patch) {
    try {
      await api(`/parameters/${p.id}`, { method: 'PUT', body: JSON.stringify(patch) });
    } catch (err) { showToast(err.message, true); }
  }

  nameInput.addEventListener('change', () => save({ name: nameInput.value.trim() }));
  addedByInput.addEventListener('change', () => save({ added_by: addedByInput.value.trim() }));
  weightInput.addEventListener('input', () => {
    const w = Number(weightInput.value);
    weightFill.style.width = `${(w / 10) * 100}%`;
  });
  weightInput.addEventListener('change', async () => {
    await save({ weight: Number(weightInput.value) });
    await renderContent();
  });
  deleteBtn.addEventListener('click', async () => {
    try {
      await api(`/parameters/${p.id}`, { method: 'DELETE' });
      showToast('Parameter deleted');
      await renderContent();
    } catch (err) { showToast(err.message, true); }
  });

  return row;
}

function renderKillerSection(container, killers, jobId) {
  container.innerHTML = `
    <div class="section-heading">
      <h2>Killer questions</h2>
    </div>
    <div class="section-hint">Questions the interview agent will use to quickly rule out an already-qualified candidate.</div>
    <div class="killer-list" id="killer-list"></div>
    <form class="add-killer-form" id="add-killer-form">
      <textarea name="question" placeholder="Write the killer question…" required></textarea>
      <input type="text" name="added_by" placeholder="added by" />
      <button type="submit">Add</button>
    </form>
  `;

  const listEl = container.querySelector('#killer-list');
  if (killers.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No killer questions for this job yet.</div>`;
  } else {
    killers.forEach(k => {
      const card = document.createElement('div');
      card.className = 'killer-card';
      card.innerHTML = `
        <div>
          <div class="killer-text">${escapeHtml(k.question)}</div>
          <div class="killer-meta">added by ${escapeHtml(k.added_by || 'anonymous')}</div>
        </div>
        <button class="row-delete" title="Delete">×</button>
      `;
      card.querySelector('.row-delete').addEventListener('click', async () => {
        try {
          await api(`/killer-questions/${k.id}`, { method: 'DELETE' });
          showToast('Killer question deleted');
          await renderContent();
        } catch (err) { showToast(err.message, true); }
      });
      listEl.appendChild(card);
    });
  }

  container.querySelector('#add-killer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const question = form.question.value.trim();
    const added_by = form.added_by.value.trim();
    if (!question) return;
    try {
      await api(`/jobs/${jobId}/killer-questions`, { method: 'POST', body: JSON.stringify({ question, added_by }) });
      showToast('Killer question added');
      await renderContent();
    } catch (err) { showToast(err.message, true); }
  });
}

document.getElementById('new-job-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('new-job-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    const job = await api('/jobs', { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    await loadJobs();
    await selectFolder(job.id);
    showToast('Folder created');
  } catch (err) { showToast(err.message, true); }
});

// ================= SECTION SWITCHER =================

function setSection(section) {
  state.section = section;
  document.getElementById('section-screening').classList.toggle('active', section === 'screening');
  document.getElementById('section-recruiters').classList.toggle('active', section === 'recruiters');
  document.getElementById('screening-section').style.display = section === 'screening' ? '' : 'none';
  document.getElementById('recruiters-section').style.display = section === 'recruiters' ? '' : 'none';
  renderContent();
}

document.getElementById('section-screening').addEventListener('click', () => setSection('screening'));
document.getElementById('section-recruiters').addEventListener('click', async () => {
  await loadRecruiterJobs();
  setSection('recruiters');
});

// ================= RECRUITERS =================

async function loadRecruiterJobs() {
  state.recruiterJobs = await api('/recruiter-jobs');
  if (state.recruiterSelected && !state.recruiterJobs.some(j => j.id === state.recruiterSelected)) {
    state.recruiterSelected = null;
  }
  renderRecruiterFolderList();
}

function renderRecruiterFolderList() {
  recruiterFolderListEl.innerHTML = '';
  state.recruiterJobs.forEach(job => {
    const btn = document.createElement('button');
    btn.className = 'folder-tab' + (state.recruiterSelected === job.id ? ' active' : '');
    btn.innerHTML = `<span>${escapeHtml(job.name)}</span>`;
    btn.onclick = () => selectRecruiterFolder(job.id);
    recruiterFolderListEl.appendChild(btn);
  });
}

async function selectRecruiterFolder(id) {
  state.recruiterSelected = id;
  renderRecruiterFolderList();
  await renderContent();
}

async function renderRecruitersView() {
  if (!state.recruiterSelected) {
    contentEl.innerHTML = `
      <div class="folder-label">Recruiters</div>
      <h1 class="folder-title">Recruiters</h1>
      <div class="folder-meta">One folder per job title. Recruiters add their contact info and a Google Calendar booking link that an automation reads to schedule candidates.</div>
      <div class="empty-state">${state.recruiterJobs.length ? 'Select a job folder on the left, or create a new one.' : 'No job folders yet. Create one with “+ New folder”.'}</div>`;
    return;
  }

  const job = state.recruiterJobs.find(j => j.id === state.recruiterSelected);
  if (!job) { state.recruiterSelected = null; return renderRecruitersView(); }

  contentEl.innerHTML = `
    <div class="folder-label">Recruiters folder</div>
    <h1 class="folder-title">${escapeHtml(job.name)}</h1>
    <div class="folder-meta">Contacts an automation can fetch by job title via <span class="mono">GET /api/recruiters?job=${escapeHtml(encodeURIComponent(job.name))}</span>. The first recruiter added is the primary one returned.</div>
    <div class="section" id="recruiters-section-body"></div>`;

  const recruiters = await api(`/recruiter-jobs/${job.id}/recruiters`);
  renderRecruiterList(document.getElementById('recruiters-section-body'), recruiters, job.id);
}

function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()); }
function isUrl(s) {
  try { const u = new URL(s.trim()); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

function renderRecruiterList(container, recruiters, jobId) {
  container.innerHTML = `
    <div class="section-heading">
      <h2>Recruiters</h2>
      <span class="weight-total">${recruiters.length} ${recruiters.length === 1 ? 'recruiter' : 'recruiters'}</span>
    </div>
    <div class="section-hint">Add your name, email, and a Google Calendar booking link you set up yourself. Notes are optional. The first entry is the primary contact returned to the automation.</div>
    <div class="card">
      <div class="recruiter-row" style="border-bottom:1px solid var(--line);color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">
        <div>Name</div><div>Email</div><div>Calendar link</div><div>Notes</div><div></div>
      </div>
      <div id="recruiter-rows"></div>
      <form class="add-recruiter-form" id="add-recruiter-form">
        <input type="text" name="name" placeholder="Name" required />
        <input type="email" name="email" placeholder="you@company.com" required />
        <input type="url" name="calendar_link" placeholder="https://calendar.google.com/…" required />
        <input type="text" name="notes" placeholder="Notes (optional)" />
        <button type="submit" title="Add recruiter">+</button>
      </form>
    </div>`;

  const rowsEl = container.querySelector('#recruiter-rows');
  if (recruiters.length === 0) {
    rowsEl.innerHTML = `<div class="empty-state">No recruiters in this folder yet.</div>`;
  } else {
    recruiters.forEach(r => rowsEl.appendChild(buildRecruiterRow(r)));
  }

  container.querySelector('#add-recruiter-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.name.value.trim();
    const email = form.email.value.trim();
    const calendar_link = form.calendar_link.value.trim();
    const notes = form.notes.value.trim();
    if (!name) return;
    if (!isEmail(email)) return showToast('Please enter a valid email', true);
    if (!isUrl(calendar_link)) return showToast('Calendar link must be a valid URL', true);
    try {
      await api(`/recruiter-jobs/${jobId}/recruiters`, {
        method: 'POST',
        body: JSON.stringify({ name, email, calendar_link, notes }),
      });
      showToast('Recruiter added');
      await renderContent();
    } catch (err) { showToast(err.message, true); }
  });
}

function buildRecruiterRow(r) {
  const row = document.createElement('div');
  row.className = 'recruiter-row';
  row.innerHTML = `
    <input class="r-name" value="${escapeHtml(r.name)}" />
    <input class="r-email mono-field" type="email" value="${escapeHtml(r.email)}" />
    <input class="r-cal mono-field" type="url" value="${escapeHtml(r.calendar_link)}" />
    <input class="r-notes" value="${escapeHtml(r.notes || '')}" placeholder="—" />
    <button class="row-delete" title="Delete">×</button>
  `;

  const nameInput = row.querySelector('.r-name');
  const emailInput = row.querySelector('.r-email');
  const calInput = row.querySelector('.r-cal');
  const notesInput = row.querySelector('.r-notes');
  const deleteBtn = row.querySelector('.row-delete');

  async function save(patch) {
    try {
      await api(`/recruiters/${r.id}`, { method: 'PUT', body: JSON.stringify(patch) });
      showToast('Recruiter updated');
    } catch (err) { showToast(err.message, true); }
  }

  nameInput.addEventListener('change', () => {
    if (!nameInput.value.trim()) { nameInput.value = r.name; return showToast('Name cannot be empty', true); }
    save({ name: nameInput.value.trim() });
  });
  emailInput.addEventListener('change', () => {
    if (!isEmail(emailInput.value)) { emailInput.value = r.email; return showToast('Please enter a valid email', true); }
    save({ email: emailInput.value.trim() });
  });
  calInput.addEventListener('change', () => {
    if (!isUrl(calInput.value)) { calInput.value = r.calendar_link; return showToast('Calendar link must be a valid URL', true); }
    save({ calendar_link: calInput.value.trim() });
  });
  notesInput.addEventListener('change', () => save({ notes: notesInput.value.trim() }));
  deleteBtn.addEventListener('click', async () => {
    try {
      await api(`/recruiters/${r.id}`, { method: 'DELETE' });
      showToast('Recruiter deleted');
      await renderContent();
    } catch (err) { showToast(err.message, true); }
  });

  return row;
}

document.getElementById('new-recruiter-job-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('new-recruiter-job-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    const job = await api('/recruiter-jobs', { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    await loadRecruiterJobs();
    await selectRecruiterFolder(job.id);
    showToast('Folder created');
  } catch (err) { showToast(err.message, true); }
});

// ================= HISTORY VIEW =================

function fmtDate(iso) {
  if (!iso) return '—';
  // SQLite datetime('now') returns UTC "YYYY-MM-DD HH:MM:SS".
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return iso;
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function scoreClass(score) {
  if (score == null) return '';
  return score >= 8 ? 'pass' : 'fail';
}

async function renderHistoryList() {
  contentEl.innerHTML = `
    <div class="folder-label">Evaluation history</div>
    <h1 class="folder-title">History</h1>
    <div class="folder-meta">Every application that has been evaluated across Prescreen and Agent Interview.</div>
    <div class="section" id="history-section"><div class="empty-state">Loading…</div></div>`;

  const section = document.getElementById('history-section');
  let rows;
  try {
    rows = await api('/history');
  } catch (err) {
    section.innerHTML = `<div class="empty-state">Could not load history: ${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!rows.length) {
    section.innerHTML = `<div class="empty-state">No evaluations recorded yet.</div>`;
    return;
  }

  const head = `
    <div class="history-row history-head">
      <div>Application</div><div>Job</div><div>Prescreen</div><div>Interview</div><div>Last activity</div>
    </div>`;
  const body = rows.map((r) => {
    const pre = r.prescreen ? `<span class="pill ${scoreClass(r.prescreen.score)}">${r.prescreen.score ?? '—'}/10</span>` : '<span class="pill muted">—</span>';
    const iv = r.interview
      ? `<span class="pill ${r.interview.passed ? 'pass' : 'fail'}">${r.interview.score ?? '—'}/10 · ${r.interview.passed ? 'PASS' : 'FAIL'}</span>`
      : '<span class="pill muted">—</span>';
    return `
      <button class="history-row history-item" data-app="${escapeHtml(r.application_id)}">
        <div class="mono">${escapeHtml(r.application_id)}</div>
        <div>${escapeHtml(r.job_name || '—')}</div>
        <div>${pre}</div>
        <div>${iv}</div>
        <div class="mono muted">${fmtDate(r.last_activity)}</div>
      </button>`;
  }).join('');

  section.innerHTML = `<div class="card history-table">${head}${body}</div>`;
  section.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.historyApp = el.dataset.app;
      renderContent();
    });
  });
}

// Horizontal score bar (0–10) with the 8/10 pass threshold marked.
function scoreGauge(score, label) {
  const s = score == null ? 0 : Math.max(0, Math.min(10, score));
  const pct = (s / 10) * 100;
  const cls = score == null ? 'muted' : (score >= 8 ? 'pass' : 'fail');
  return `
    <div class="chart-block">
      <div class="chart-title">${escapeHtml(label)}</div>
      <div class="gauge">
        <div class="gauge-fill ${cls}" style="width:${pct}%"></div>
        <div class="gauge-threshold" style="left:80%" title="Pass threshold: 8/10"></div>
      </div>
      <div class="gauge-scale"><span>0</span><span class="gauge-mark">8 · pass</span><span>10</span></div>
      <div class="chart-value ${cls}">${score == null ? 'No score' : score + ' / 10'}</div>
    </div>`;
}

// SVG donut showing questions answered vs. not reached.
function coverageDonut(asked, total) {
  const a = asked || 0;
  const t = total || 0;
  const frac = t > 0 ? a / t : 0;
  const r = 42;
  const c = 2 * Math.PI * r;
  const dash = c * frac;
  return `
    <div class="chart-block">
      <div class="chart-title">Coverage</div>
      <svg class="donut" viewBox="0 0 110 110" width="120" height="120">
        <circle cx="55" cy="55" r="${r}" class="donut-track" fill="none" stroke-width="12" />
        <circle cx="55" cy="55" r="${r}" class="donut-value" fill="none" stroke-width="12"
          stroke-dasharray="${dash} ${c - dash}" stroke-dashoffset="${c / 4}" stroke-linecap="round"
          transform="rotate(-90 55 55)" />
        <text x="55" y="52" class="donut-num" text-anchor="middle">${a}/${t}</text>
        <text x="55" y="68" class="donut-sub" text-anchor="middle">asked</text>
      </svg>
      <div class="chart-value muted">${t > 0 ? Math.round(frac * 100) + '% of questions reached' : 'No questions'}</div>
    </div>`;
}

function answerChip(answer) {
  if (answer === true) return '<span class="ans ans-yes">TRUE</span>';
  if (answer === false) return '<span class="ans ans-no">FALSE</span>';
  return '<span class="ans ans-na">not asked</span>';
}

async function renderHistoryDetail(applicationId) {
  contentEl.innerHTML = `<div class="empty-state">Loading…</div>`;
  let d;
  try {
    d = await api(`/applications/${encodeURIComponent(applicationId)}/history`);
  } catch (err) {
    contentEl.innerHTML = `<div class="empty-state">Could not load application: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const pre = d.prescreen;
  const iv = d.interview;

  const timeline = [];
  if (d.stage_entered_at) {
    timeline.push({ date: d.stage_entered_at, title: 'Entered Agent Interview stage', body: '' });
  }
  if (pre) {
    timeline.push({
      date: pre.date,
      title: `Prescreen — ${pre.score ?? '—'}/10`,
      body: pre.rationale ? escapeHtml(pre.rationale) : (pre.status ? `Status: ${escapeHtml(pre.status)}` : ''),
    });
  }
  if (iv) {
    timeline.push({
      date: iv.date,
      title: `Agent Interview — ${iv.score ?? '—'}/10 · ${iv.passed ? 'PASSED' : 'FAILED'}`,
      body: `Coverage: ${iv.coverage.asked} of ${iv.coverage.total} questions${iv.call_connected ? '' : ' · call did not connect'}`,
    });
  }
  timeline.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const timelineHtml = timeline.length
    ? timeline.map((t) => `
        <div class="tl-item">
          <div class="tl-dot"></div>
          <div class="tl-body">
            <div class="tl-title">${t.title}</div>
            ${t.body ? `<div class="tl-text">${t.body}</div>` : ''}
            <div class="tl-date mono muted">${fmtDate(t.date)}</div>
          </div>
        </div>`).join('')
    : '<div class="empty-state">No timeline events.</div>';

  const questionsHtml = d.questions.length
    ? `<div class="card">
        ${d.questions.map((q) => `
          <div class="q-row">
            <div class="q-text">${escapeHtml(q.text)}${q.weight != null && q.weight !== 1 ? ` <span class="q-weight mono">×${q.weight}</span>` : ''}</div>
            <div>${answerChip(q.answer)}</div>
          </div>`).join('')}
      </div>`
    : '<div class="empty-state">No killer questions on record for this job.</div>';

  const chartsHtml = iv
    ? `<div class="charts">${scoreGauge(iv.score, 'Interview score')}${coverageDonut(iv.coverage.asked, iv.coverage.total)}</div>`
    : (pre ? `<div class="charts">${scoreGauge(pre.score, 'Prescreen score')}</div>` : '');

  const notesBits = [];
  if (iv) {
    notesBits.push(`<div><span class="meta-k">Call connected</span><span class="meta-v">${iv.call_connected ? 'Yes' : 'No'}</span></div>`);
    notesBits.push(`<div><span class="meta-k">Callback requested</span><span class="meta-v">${iv.callback_requested ? 'Yes' : 'No'}</span></div>`);
    if (iv.call_notes) notesBits.push(`<div class="full"><span class="meta-k">Call notes</span><span class="meta-v">${escapeHtml(iv.call_notes)}</span></div>`);
  }
  notesBits.push(`<div><span class="meta-k">Zero-engagement attempts</span><span class="meta-v">${d.attempts}</span></div>`);

  contentEl.innerHTML = `
    <button class="back-link" id="history-back">← Back to history</button>
    <div class="folder-label">Application history</div>
    <h1 class="folder-title mono">${escapeHtml(applicationId)}</h1>
    <div class="folder-meta">
      ${d.job ? `Job: ${escapeHtml(d.job.name)}` : 'Job: —'}
      ${d.candidate_id ? ` · Candidate: <span class="mono">${escapeHtml(d.candidate_id)}</span>` : ''}
    </div>

    ${chartsHtml ? `<div class="section">${chartsHtml}</div>` : ''}

    <div class="section">
      <div class="section-heading"><h2>Timeline</h2></div>
      <div class="timeline">${timelineHtml}</div>
    </div>

    <div class="section">
      <div class="section-heading"><h2>Killer questions & answers</h2></div>
      <div class="section-hint">True / false answers captured during the Agent Interview call.</div>
      ${questionsHtml}
    </div>

    <div class="section">
      <div class="section-heading"><h2>Call details</h2></div>
      <div class="card meta-grid">${notesBits.join('')}</div>
    </div>
  `;

  document.getElementById('history-back').addEventListener('click', () => {
    state.historyApp = null;
    renderContent();
  });
}

document.getElementById('nav-criteria').addEventListener('click', () => setView('criteria'));
document.getElementById('nav-history').addEventListener('click', () => {
  state.historyApp = null;
  setView('history');
});

(async function init() {
  await loadJobs();
  await renderContent();
})();
